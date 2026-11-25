// Tests for src/perf.js.
//
//   for b in reuse_any_sample reuse_never image_not_first keeps_dev_only \
//            keeps_panel_only keeps_never down_at_equal no_down_ever \
//            long_edge_off aspect_lost min_one preview_ignores_max \
//            trigger_is_max card_always_preview card_never_preview \
//            card_no_ratio; do
//     BREAK=$b node src/perf.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
import * as real from './perf.js';
import { planOutput, planCard } from './plan.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'reuse_any_sample') F.canReuseSample = (s) => Boolean(s);
else if (BREAK === 'reuse_never') F.canReuseSample = () => false;
else if (BREAK === 'image_not_first') F.pickSource = ({ uri, bytes, image }) => (uri ? 'uri' : bytes ? 'bytes' : image ? 'image' : null);
else if (BREAK === 'keeps_dev_only') F.keepsLog = ({ dev }) => Boolean(dev);
else if (BREAK === 'keeps_panel_only') F.keepsLog = ({ panelOpen }) => Boolean(panelOpen);
else if (BREAK === 'keeps_never') F.keepsLog = () => false;
else if (BREAK === 'down_at_equal') {
  F.previewSize = (s, max = real.PREVIEW_MAX) =>
    Math.max(s.width, s.height) >= real.PREVIEW_TRIGGER ? real.previewSize(s, max, 0) : { down: false, ...s };
} else if (BREAK === 'no_down_ever') F.previewSize = (s) => ({ down: false, width: s.width, height: s.height });
else if (BREAK === 'long_edge_off') {
  // Scales the width to the ceiling whatever the orientation is.
  F.previewSize = (s, max = real.PREVIEW_MAX) =>
    Math.max(s.width, s.height) > max
      ? { down: true, width: max, height: Math.round(s.height * (max / s.width)) }
      : { down: false, ...s };
} else if (BREAK === 'aspect_lost') {
  F.previewSize = (s, max = real.PREVIEW_MAX) =>
    Math.max(s.width, s.height) > max ? { down: true, width: max, height: max } : { down: false, ...s };
} else if (BREAK === 'min_one') {
  F.previewSize = (s, max = real.PREVIEW_MAX) => {
    const r = real.previewSize(s, max);
    return r.down ? { ...r, width: Math.round(s.width * (max / Math.max(s.width, s.height))) } : r;
  };
} else if (BREAK === 'preview_ignores_max') {
  F.previewSize = (s) => real.previewSize(s);
} else if (BREAK === 'trigger_is_max') {
  F.previewSize = (s, max = real.PREVIEW_MAX) => real.previewSize(s, max, max);
} else if (BREAK === 'card_always_preview') F.cardSource = () => 'preview';
else if (BREAK === 'card_never_preview') F.cardSource = () => 'full';
else if (BREAK === 'card_no_ratio') F.cardSource = (o) => real.cardSource({ ...o, pixelRatio: 1 });

let ran = 0;
let fails = 0;
function check(name, ok) {
  ran += 1;
  if (!ok) { fails += 1; console.log(`FAIL  ${name}`); } else console.log(`ok    ${name}`);
}

// --- which sample the export may reuse ---------------------------------------
const crop = { x: 0, y: 40, w: 1080, h: 1800 };
const sample = F.stampSample({ source: 'sampled', hex: '#102030', luma: 30 }, crop);
check('a stamped sample keeps its fields', sample.hex === '#102030' && sample.source === 'sampled');
check('and remembers the crop it was read from', JSON.stringify(sample.at) === JSON.stringify(crop));
check('stamping nothing is nothing', F.stampSample(null, crop) === null);
check('the same rect may reuse it', F.canReuseSample(sample, { ...crop }) === true);
check('a moved crop may not', F.canReuseSample(sample, { ...crop, y: 41 }) === false);
check('a resized crop may not', F.canReuseSample(sample, { ...crop, h: 1799 }) === false);
check('an unstamped sample may not', F.canReuseSample({ source: 'sampled', hex: '#000000' }, crop) === false);
check('no sample at all may not', F.canReuseSample(null, crop) === false);

// --- which picture ------------------------------------------------------------
check('a held image beats a uri', F.pickSource({ image: {}, uri: 'file:///a.png' }) === 'image');
check('a held image beats bytes', F.pickSource({ image: {}, bytes: new Uint8Array(1) }) === 'image');
check('a uri alone decodes the uri', F.pickSource({ uri: 'file:///a.png' }) === 'uri');
check('bytes alone decode the bytes', F.pickSource({ bytes: new Uint8Array(1) }) === 'bytes');
check('nothing is nothing', F.pickSource({}) === null);

// --- the preview and the export share one fill -----------------------------------
// The preview (App's fillColour) calls planOutput with the editor's crop and the
// sample. The export goes through planCard, which hands the sampler the crop it
// planned. This drives both over the same state and demands one answer, and that
// the export did not read pixels it already had.
const image = { width: 1080, height: 2400 };
function exportFill(state, sampled) {
  let reads = 0;
  const p = planCard({
    image,
    crop: state.crop,
    padding: state.padding,
    frame: state.frame,
    trim: 'never',
    sampleBackground: (rect) => {
      if (F.canReuseSample(sampled, rect)) return sampled;
      reads += 1;
      return { source: 'sampled', hex: '#ff00ff', luma: 100 }; // what a fresh read would say
    },
  });
  return { fill: p.fill, fillSource: p.fillSource, reads, crop: p.crop };
}
const previewFill = (state, sampled) =>
  planOutput({ crop: state.crop, padding: state.padding, background: sampled, frame: state.frame }).fill;

for (const frame of ['match', 'paper', 'ink']) {
  for (const padding of ['snug', 'standard', 'roomy']) {
    const state = { crop, padding, frame };
    const out = exportFill(state, sample);
    check(`${frame}/${padding}: export and preview fill agree`, out.fill === previewFill(state, sample));
    check(`${frame}/${padding}: the export read no pixels`, out.reads === 0);
  }
}
{
  const state = { crop, padding: 'standard', frame: 'match' };
  check('Match uses the sampled colour, not a fresh one', exportFill(state, sample).fill === '#102030');
}
{
  // The sample is for a crop the user has since left (a tool open, a drag
  // unsettled): the export must look again rather than paint the old colour.
  const moved = { crop: { ...crop, y: 100 }, padding: 'standard', frame: 'match' };
  const out = exportFill(moved, sample);
  check('a sample of another crop is not reused', out.reads === 1 && out.fill === '#ff00ff');
}
{
  // planCard clamps a crop that overhangs the picture; the rect the sampler
  // gets is the clamped one, so an unclamped stamp must not match.
  const over = { x: 0, y: 2000, w: 1080, h: 900 };
  const stamped = F.stampSample({ source: 'sampled', hex: '#102030', luma: 30 }, over);
  const out = exportFill({ crop: over, padding: 'standard', frame: 'match' }, stamped);
  check('a crop the planner clamps resamples', out.reads === 1 && out.crop.h === 400);
}

// --- the dev log ---------------------------------------------------------------------
check('a debug build keeps the log', F.keepsLog({ dev: true, panelOpen: false }) === true);
check('a release build with the panel open keeps it', F.keepsLog({ dev: false, panelOpen: true }) === true);
check('a release build with the panel shut does not', F.keepsLog({ dev: false, panelOpen: false }) === false);
check('missing flags do not', F.keepsLog({}) === false);

// --- the preview size ------------------------------------------------------------------
const tall = F.previewSize({ width: 1080, height: 20000 });
check('a tall capture is scaled to 2048 on its long side', tall.down && tall.height === 2048);
check('and the short side follows the aspect', tall.width === Math.round(1080 * 2048 / 20000));
const wide = F.previewSize({ width: 9000, height: 1200 });
check('a wide capture is scaled on its long side too', wide.down && wide.width === 2048 && wide.height === Math.round(1200 * 2048 / 9000));
check('the long side exactly at the trigger is left alone', F.previewSize({ width: 1080, height: 4096 }).down === false);
check('one pixel over is scaled', F.previewSize({ width: 1080, height: 4097 }).down === true);
check('ordinary phone screenshots are drawn as themselves', ['2000', '2400', '3200'].every((h) => F.previewSize({ width: 1440, height: +h }).down === false));
check('a left-alone size is returned unchanged', JSON.stringify(F.previewSize({ width: 1080, height: 2400 })) === JSON.stringify({ down: false, width: 1080, height: 2400 }));
check('a sliver never rounds to zero', F.previewSize({ width: 1, height: 100000 }).width === 1);
check('the ceiling and trigger are parameters', F.previewSize({ width: 1000, height: 3000 }, 1500, 2000).height === 1500);
check('the default ceiling is 2048', real.PREVIEW_MAX === 2048);
check('the default trigger is 4096', real.PREVIEW_TRIGGER === 4096);

// --- which picture the card layer draws ------------------------------------------------
// A 1080x20000 capture whose copy is 111 wide.
const big = { srcW: 1080, previewW: 111 };
check('the whole capture as a small card uses the copy', F.cardSource({ ...big, cropW: 1080, destW: 40, pixelRatio: 2.625 }) === 'preview');
check('one screen of it on a full-width card uses the full picture', F.cardSource({ ...big, cropW: 1080, destW: 360, pixelRatio: 2.625 }) === 'full');
check('a narrow crop uses the full picture', F.cardSource({ ...big, cropW: 300, destW: 60, pixelRatio: 1 }) === 'full');
check('screen density counts: enough at 1x is not enough at 3x', F.cardSource({ ...big, cropW: 1080, destW: 100, pixelRatio: 1 }) === 'preview' && F.cardSource({ ...big, cropW: 1080, destW: 100, pixelRatio: 3 }) === 'full');
check('no copy (the copy IS the picture) means the full picture', F.cardSource({ srcW: 1080, previewW: 1080, cropW: 1080, destW: 10 }) === 'full');

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
