// Tests for src/plan.js — the Phase 1 decision layer.
//
//   for b in no_shape_gate never_ignored trim_outside sample_order fallback_flip \
//            no_edge_warn always_no_warn literal_bounds no_mask_clamp \
//            mask_keep_outside mask_scale_from_plan no_swap clamp_fields \
//            mask_px_nearest mask_px_inward mask_px_unclamped mask_px_no_null; do
//     BREAK=$b node src/plan.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. `no_shape_gate` is the one that matters: it drops the
// status-bar shape gate, which on two of the four real captures cuts the
// author's byline with full confidence. `sample_order` is the second: it samples
// the card background from the pre-trim rect, so the frame is drawn from chrome
// pixels that are no longer in the card.
import * as real from './plan.js';
import { PAPER, INK } from './pixels.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'no_shape_gate') {
  // Auto-trim on any detected boundary, shape test ignored.
  F.planCrop = (a) => {
    const r = real.planCrop({ ...a, trim: a.trim === 'auto' ? 'always' : a.trim });
    return { ...r, warnings: [] };
  };
} else if (BREAK === 'never_ignored') {
  F.planCrop = (a) => real.planCrop({ ...a, trim: a.trim === 'never' ? 'auto' : a.trim });
} else if (BREAK === 'trim_outside') {
  // Trim regardless of where the crop starts, so a crop already below the
  // boundary is moved up to it and grows.
  F.planCrop = (a) => {
    const r = real.planCrop(a);
    const cut = a.statusBar && a.statusBar.detected ? a.statusBar.cut : 0;
    if (r.trimmed || !cut) return r;
    return {
      ...r,
      crop: { x: r.requested.x, y: cut, w: r.requested.w, h: r.requested.y + r.requested.h - cut },
      trimmed: true,
      trimmedRows: cut - r.requested.y,
    };
  };
} else if (BREAK === 'sample_order') {
  // Sample the background before trimming — the ordering bug planCard exists
  // to make unrepresentable.
  F.planCard = (a) => {
    const c = real.planCrop(a);
    const background = a.sampleBackground ? a.sampleBackground(c.requested) : null;
    const out = real.planOutput({ crop: c.crop, padding: a.padding, background });
    return {
      ...out, crop: c.crop, requested: c.requested, trimmed: c.trimmed,
      trimmedRows: c.trimmedRows, background, warnings: [...c.warnings, ...out.warnings],
    };
  };
} else if (BREAK === 'frame_ignored') {
  // The Style strip's Background choice sampled over. The control moves, the
  // swatch lights, and the card does not change — which reads as the renderer
  // being broken rather than as the argument being dropped.
  F.planOutput = (a) => real.planOutput({ ...a, frame: 'match' });
  F.planCard = (a) => real.planCard({ ...a, frame: 'match' });
} else if (BREAK === 'frame_unvalidated') {
  // An unknown frame falls through to Match instead of throwing, so a typo in
  // one call site is a card with a colour nobody chose.
  F.planOutput = (a) => real.planOutput({ ...a, frame: ['match', 'paper', 'ink'].includes(a.frame) ? a.frame : 'match' });
} else if (BREAK === 'frame_warns') {
  // Keep the sample's disagreement warning on a card the user asked to be
  // Paper. Noise about a decision this call did not make, and the kind that
  // trains someone to stop reading warnings.
  F.planOutput = (a) => {
    const r = real.planOutput(a);
    if (r.fillSource !== 'chosen') return r;
    return { ...r, warnings: [...r.warnings, 'background sampled from the crop edges disagreed (chosen); using the neutral frame'] };
  };
} else if (BREAK === 'fallback_flip') {
  F.planOutput = (a) => {
    const r = real.planOutput(a);
    if (r.fillSource !== 'fallback') return r;
    return { ...r, fill: r.fill === INK ? PAPER : INK };
  };
} else if (BREAK === 'no_edge_warn') {
  F.planOutput = (a) => {
    const r = real.planOutput(a);
    return { ...r, warnings: r.warnings.filter((w) => !w.includes('visible edge')) };
  };
} else if (BREAK === 'always_no_warn') {
  F.planCrop = (a) => ({ ...real.planCrop(a), warnings: [] });
} else if (BREAK === 'no_mask_clamp') {
  // Masks passed through untouched, so a box overlapping the crop edge keeps its
  // original rect and lands on the frame.
  F.clampMasks = (masks, crop) => ({ masks: (masks || []).map((m) => ({ ...m })), dropped: [] });
} else if (BREAK === 'mask_keep_outside') {
  // Clamp, but keep boxes with no overlap instead of dropping them.
  F.clampMasks = (masks, crop) => {
    const r = real.clampMasks(masks, crop);
    return { masks: [...r.masks, ...r.dropped], dropped: [] };
  };
} else if (BREAK === 'mask_scale_from_plan') {
  // Map with plan.scale instead of dest/crop — the pre-rounding scale, which
  // drifts from where the image was actually drawn.
  F.maskToDest = (mask, plan) => ({
    x: plan.dest.x + (mask.x - plan.crop.x) * plan.scale,
    y: plan.dest.y + (mask.y - plan.crop.y) * plan.scale,
    w: mask.w * plan.scale,
    h: mask.h * plan.scale,
  });
} else if (BREAK === 'mask_px_nearest') {
  // Round to nearest instead of outward. Nearest loses up to half a pixel on
  // each edge, which is the leak this rule exists to stop.
  F.maskToDestPixels = (mask, plan) => {
    const f = real.maskToDest(mask, plan);
    const x0 = Math.max(plan.dest.x, Math.round(f.x));
    const y0 = Math.max(plan.dest.y, Math.round(f.y));
    const x1 = Math.min(plan.dest.x + plan.dest.w, Math.round(f.x + f.w));
    const y1 = Math.min(plan.dest.y + plan.dest.h, Math.round(f.y + f.h));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
} else if (BREAK === 'mask_px_inward') {
  // Round inward — the worst version, and the one a "shrink to fit" instinct
  // produces.
  F.maskToDestPixels = (mask, plan) => {
    const f = real.maskToDest(mask, plan);
    const x0 = Math.max(plan.dest.x, Math.ceil(f.x));
    const y0 = Math.max(plan.dest.y, Math.ceil(f.y));
    const x1 = Math.min(plan.dest.x + plan.dest.w, Math.floor(f.x + f.w));
    const y1 = Math.min(plan.dest.y + plan.dest.h, Math.floor(f.y + f.h));
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
} else if (BREAK === 'mask_px_unclamped') {
  // Grow outward but forget to intersect with dest, so a box on the crop edge
  // puts fill on the frame — the most visible defect in a framed picture.
  F.maskToDestPixels = (mask, plan) => {
    const f = real.maskToDest(mask, plan);
    const x0 = Math.floor(f.x);
    const y0 = Math.floor(f.y);
    const x1 = Math.ceil(f.x + f.w);
    const y1 = Math.ceil(f.y + f.h);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
} else if (BREAK === 'mask_px_no_null') {
  // Return a 1px rect instead of null for a box that owns no whole pixel, so a
  // sub-pixel box silently becomes a visible mark.
  F.maskToDestPixels = (mask, plan) => {
    const r = real.maskToDestPixels(mask, plan);
    if (r) return r;
    const f = real.maskToDest(mask, plan);
    return { x: Math.floor(f.x), y: Math.floor(f.y), w: 1, h: 1 };
  };
} else if (BREAK === 'clamp_fields') {
  // The original clampCrop: each field clamped on its own, so a rect hanging off
  // the left or top edge comes back wider than it was asked for. The crop the
  // planner then uses is grown, and nothing says so.
  const broken = (imageW, imageH, box) => {
    const x = Math.max(0, Math.min(imageW - 1, Math.round(box.x)));
    const y = Math.max(0, Math.min(imageH - 1, Math.round(box.y)));
    return {
      x,
      y,
      w: Math.max(1, Math.min(imageW - x, Math.round(box.w))),
      h: Math.max(1, Math.min(imageH - y, Math.round(box.h))),
    };
  };
  F.clampCrop = broken;
  F.planCrop = (a) => {
    const r = real.planCrop({
      ...a,
      crop: a.crop ? broken(a.image.width, a.image.height, a.crop) : a.crop,
    });
    return { ...r, warnings: r.warnings.filter((w) => !/extended past the image/.test(w)) };
  };
} else if (BREAK === 'no_swap') {
  // Forget that orientations 5-8 exchange width and height.
  F.orientedSize = (w, h) => ({ width: w, height: h, swapped: false });
} else if (BREAK === 'literal_bounds') {
  // The edge-contrast bounds as hand-picked literals (245 and 12) instead of
  // Paper's and Ink's own luma. Emulated by dropping exactly the warnings the
  // literal version would not have raised.
  F.planOutput = (a) => {
    const r = real.planOutput(a);
    return {
      ...r,
      warnings: r.warnings.filter((w) => {
        if (/near-white/.test(w)) return r.fillLuma > 245;
        if (/near-black/.test(w)) return r.fillLuma < 12;
        return true;
      }),
    };
  };
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

const IMG = { width: 1440, height: 3120 };                  // the Pixel 6 Pro's real capture size
const SB = { detected: true, cut: 89, likely: true };       // captures 3 and 4
const HEADER = { detected: true, cut: 133, likely: false }; // capture 1: the byline

console.log('a confirmed status bar is trimmed');
{
  const r = F.planCrop({ image: IMG, statusBar: SB });
  check('trimmed', r.trimmed === true);
  check('crop starts at the cut row', r.crop.y === 89, r.crop.y);
  check('height shrinks by exactly the trimmed rows', r.crop.h === 3120 - 89, r.crop.h);
  check('width untouched', r.crop.w === 1440, r.crop.w);
  check('trimmedRows reported', r.trimmedRows === 89, r.trimmedRows);
  check('no warning for the confirmed case', r.warnings.length === 0, JSON.stringify(r.warnings));
}

console.log('a byline that failed the shape test is NOT trimmed on auto');
{
  const r = F.planCrop({ image: IMG, statusBar: HEADER });
  check('not trimmed', r.trimmed === false);
  check('crop is the full image', r.crop.y === 0 && r.crop.h === 3120, `${r.crop.y}/${r.crop.h}`);
  check('says why', /does not look like a status bar/.test(r.reason || ''), r.reason);
}

console.log('trim always overrides the gate, but says so');
{
  const r = F.planCrop({ image: IMG, statusBar: HEADER, trim: 'always' });
  check('trimmed', r.trimmed === true);
  check('warns that it may be a header',
    r.warnings.some((w) => /shape test/.test(w)), JSON.stringify(r.warnings));
}

console.log('trim never never trims, whatever the detector says');
{
  const r = F.planCrop({ image: IMG, statusBar: SB, trim: 'never' });
  check('not trimmed on a confirmed status bar', r.trimmed === false);
  check('says why', /disabled/.test(r.reason || ''), r.reason);
}

console.log('a crop that does not contain the boundary is left alone');
{
  const below = F.planCrop({ image: IMG, crop: { x: 0, y: 400, w: 1440, h: 1000 }, statusBar: SB });
  check('crop below the cut keeps its own y', below.crop.y === 400, below.crop.y);
  check('and its own height', below.crop.h === 1000, below.crop.h);
  check('not trimmed', below.trimmed === false);
  const above = F.planCrop({ image: IMG, crop: { x: 0, y: 0, w: 1440, h: 40 }, statusBar: SB });
  check('a crop ending above the cut is not trimmed', above.trimmed === false, above.reason);
  check('and keeps its height', above.crop.h === 40, above.crop.h);
}

console.log('crops are clamped to the image, so a drag past the edge cannot ask for nothing');
{
  const r = F.planCrop({ image: IMG, crop: { x: -50, y: -50, w: 9999, h: 9999 } });
  check('x clamped', r.crop.x === 0, r.crop.x);
  check('y clamped', r.crop.y === 0, r.crop.y);
  check('w clamped to the image', r.crop.w === 1440, r.crop.w);
  check('h clamped to the image', r.crop.h === 3120, r.crop.h);
  let threw = false;
  try { F.planCrop({ image: { width: 0, height: 10 } }); } catch { threw = true; }
  check('a zero-size image throws', threw);
  let modeThrew = false;
  try { F.planCrop({ image: IMG, trim: 'maybe' }); } catch { modeThrew = true; }
  check('an unknown trim mode throws', modeThrew);
}

console.log('the sampled background becomes the frame');
{
  const r = F.planOutput({ crop: { w: 1440, h: 3031 }, background: { source: 'sampled', hex: '#000000' } });
  check('fill is the sampled colour', r.fill === '#000000', r.fill);
  check('source recorded as sampled', r.fillSource === 'sampled', r.fillSource);
  check('no disagreement warning',
    !r.warnings.some((w) => /disagreed/.test(w)), JSON.stringify(r.warnings));
}

console.log('the Style strip can override the sample, and says it did');
{
  // Deliberately with a sample present and disagreeing with the choice, which
  // is the only arrangement that can tell "chosen" from "the sample happened
  // to be this colour".
  const sampled = { source: 'sampled', hex: '#3A7BD5' };
  const crop = { w: 1440, h: 3031 };

  const match = F.planOutput({ crop, background: sampled, frame: 'match' });
  check('Match takes the sampled colour', match.fill === '#3A7BD5', match.fill);
  check('and is the default when no frame is passed',
    F.planOutput({ crop, background: sampled }).fill === match.fill);

  const paper = F.planOutput({ crop, background: sampled, frame: 'paper' });
  check('Paper overrides a sample that disagrees', paper.fill === PAPER, paper.fill);
  check('and records that it was chosen, not sampled', paper.fillSource === 'chosen', paper.fillSource);

  const ink = F.planOutput({ crop, background: sampled, frame: 'ink' });
  check('Ink does too', ink.fill === INK, ink.fill);
  check('and the two are different colours', paper.fill !== ink.fill);

  // The warning is about a decision this call did not make.
  const noSample = F.planOutput({ crop, background: null, frame: 'paper' });
  check('choosing Paper with no sample at all does not warn about the sample',
    !noSample.warnings.some((w) => /disagreed/.test(w)), JSON.stringify(noSample.warnings));
  check('where leaving it on Match does',
    F.planOutput({ crop, background: null, frame: 'match' }).warnings.some((w) => /disagreed/.test(w)));

  // Paper and Ink are the anchors the near-white and near-black warnings are
  // measured against, so neither can warn about itself. Worth pinning: it is
  // true by construction and the construction is one edit from being lost.
  check('Paper does not warn that it has no visible edge',
    !paper.warnings.some((w) => /visible edge/.test(w)), JSON.stringify(paper.warnings));
  check('nor does Ink', !ink.warnings.some((w) => /visible edge/.test(w)), JSON.stringify(ink.warnings));

  let threw = false;
  try { F.planOutput({ crop, frame: 'papyrus' }); } catch (e) { threw = true; }
  check('an unknown frame throws rather than quietly becoming Match', threw);

  // Through planCard, because that is the call renderCard makes, and a
  // parameter threaded into the wrong one of the two is the normal way this
  // breaks.
  const viaCard = F.planCard({
    image: { width: 1440, height: 3120 },
    crop: { x: 0, y: 0, w: 1440, h: 3031 },
    trim: 'never',
    frame: 'ink',
    sampleBackground: () => sampled,
  });
  check('planCard passes the frame through', viaCard.fill === INK, viaCard.fill);
  check('and still samples, so the Match swatch has a colour to show',
    viaCard.background && viaCard.background.hex === '#3A7BD5',
    JSON.stringify(viaCard.background));
}

console.log('the fallback picks by luma, and both ends are tested');
{
  const dark = F.planOutput({ crop: { w: 900, h: 900 }, background: { source: 'fallback', reason: 'edges disagree', luma: 1 } });
  check('a dark crop falls back to Ink', dark.fill === INK, dark.fill);
  const light = F.planOutput({ crop: { w: 900, h: 900 }, background: { source: 'fallback', reason: 'edges disagree', luma: 254 } });
  check('a light crop falls back to Paper', light.fill === PAPER, light.fill);
  check('both are marked as fallbacks',
    dark.fillSource === 'fallback' && light.fillSource === 'fallback');
  check('the reason is carried through',
    light.warnings.some((w) => /edges disagree/.test(w)), JSON.stringify(light.warnings));
  const none = F.planOutput({ crop: { w: 900, h: 900 }, background: null });
  check('no sample at all is still a fallback, not a crash', none.fillSource === 'fallback', none.fillSource);
  // The threshold itself. results/phase1-card-background.md records that no
  // measured crop came anywhere near 128, so it is asserted here instead.
  const justDark = F.planOutput({ crop: { w: 900, h: 900 }, background: { source: 'fallback', luma: 127.9 } });
  const justLight = F.planOutput({ crop: { w: 900, h: 900 }, background: { source: 'fallback', luma: 128 } });
  check('127.9 is dark', justDark.fill === INK, justDark.fill);
  check('128 is light', justLight.fill === PAPER, justLight.fill);
}

console.log('an edgeless frame is flagged rather than silently shipped');
{
  const black = F.planOutput({ crop: { w: 1440, h: 3031 }, background: { source: 'sampled', hex: '#000000' } });
  check('near-black frame warns', black.warnings.some((w) => /near-black/.test(w)), JSON.stringify(black.warnings));
  const white = F.planOutput({ crop: { w: 1440, h: 3031 }, background: { source: 'sampled', hex: '#FFFFFF' } });
  check('near-white frame warns', white.warnings.some((w) => /near-white/.test(w)), JSON.stringify(white.warnings));
  const mid = F.planOutput({ crop: { w: 1440, h: 3031 }, background: { source: 'sampled', hex: '#7F7F7F' } });
  check('a mid grey does not warn', !mid.warnings.some((w) => /visible edge/.test(w)), JSON.stringify(mid.warnings));
  // Every dark capture measured so far samples to pure #000000, so this warning
  // fires on the common case, not an exotic one.
  check('the frame luma is reported', black.fillLuma === 0 && white.fillLuma === 255,
    `${black.fillLuma}/${white.fillLuma}`);
  // The bounds ARE Paper and Ink, so the neutral frames cannot flag themselves.
  // With the earlier hand-picked 245 this held by 0.97 of a luma unit, by luck.
  const paper = F.planOutput({ crop: { w: 900, h: 900 }, background: { source: 'fallback', luma: 254 } });
  const ink = F.planOutput({ crop: { w: 900, h: 900 }, background: { source: 'fallback', luma: 1 } });
  check('Paper does not warn about itself',
    !paper.warnings.some((w) => /visible edge/.test(w)), JSON.stringify(paper.warnings));
  check('Ink does not warn about itself',
    !ink.warnings.some((w) => /visible edge/.test(w)), JSON.stringify(ink.warnings));

  // Those two checks alone are decoration, and were: with the bounds written as
  // literal 245 and 12 they still pass, because Paper at 244.03 is under 245
  // either way. The fallback path can never tell the two versions apart, since
  // its fill is always exactly Paper or Ink. Only a SAMPLED colour landing in the
  // gap between the constant and the literal discriminates:
  //
  //   light gap (244.03, 245]   #F6F5F0 -> 244.729
  //   dark  gap [12, 23.67)     #141618 ->  21.630
  //
  // The real bounds warn on both; the literals warn on neither.
  const gapLight = F.planOutput({ crop: { w: 1440, h: 3031 }, background: { source: 'sampled', hex: '#F6F5F0' } });
  const gapDark = F.planOutput({ crop: { w: 1440, h: 3031 }, background: { source: 'sampled', hex: '#141618' } });
  check('a sampled colour lighter than Paper warns',
    gapLight.warnings.some((w) => /near-white/.test(w)), `${gapLight.fillLuma}: ${JSON.stringify(gapLight.warnings)}`);
  check('a sampled colour darker than Ink warns',
    gapDark.warnings.some((w) => /near-black/.test(w)), `${gapDark.fillLuma}: ${JSON.stringify(gapDark.warnings)}`);
}

console.log('planCard samples from the trimmed crop, not the requested one');
{
  const seen = [];
  const r = F.planCard({
    image: IMG,
    statusBar: SB,
    sampleBackground: (rect) => { seen.push({ ...rect }); return { source: 'sampled', hex: '#000000' }; },
  });
  check('the sampler was called once', seen.length === 1, seen.length);
  check('it received the TRIMMED y', seen[0] && seen[0].y === 89, seen[0] && seen[0].y);
  check('it received the TRIMMED height', seen[0] && seen[0].h === 3031, seen[0] && seen[0].h);
  check('the returned crop matches what was sampled',
    r.crop.y === seen[0].y && r.crop.h === seen[0].h, `${r.crop.y}/${r.crop.h}`);
  check('the background is carried out for inspection', r.background.hex === '#000000');
  check('trim bookkeeping survives the composition', r.trimmed === true && r.trimmedRows === 89);
  const noSampler = F.planCard({ image: IMG, statusBar: SB });
  check('no sampler means the fallback, not a crash', noSampler.fillSource === 'fallback', noSampler.fillSource);
}

console.log('warnings from both steps reach the caller');
{
  const r = F.planCard({
    image: IMG,
    statusBar: HEADER,
    trim: 'always',
    sampleBackground: () => ({ source: 'sampled', hex: '#000000' }),
  });
  check('the crop-step warning is present',
    r.warnings.some((w) => /shape test/.test(w)), JSON.stringify(r.warnings));
  check('the output-step warning is present too',
    r.warnings.some((w) => /near-black/.test(w)), JSON.stringify(r.warnings));
}

console.log('Cover boxes are clamped to the crop, not to the image');
{
  const crop = { x: 0, y: 89, w: 1440, h: 3031 };
  const r = F.clampMasks([
    { x: 100, y: 200, w: 300, h: 50 },      // wholly inside
    { x: -50, y: 50, w: 300, h: 100 },      // overlaps the top-left corner
    { x: 1400, y: 200, w: 300, h: 50 },     // overruns the right edge
    { x: 0, y: 0, w: 100, h: 50 },          // entirely above the trimmed crop
  ], crop);
  check('three boxes kept', r.masks.length === 3, r.masks.length);
  check('one box dropped', r.dropped.length === 1, r.dropped.length);
  check('an inside box is untouched',
    r.masks[0].x === 100 && r.masks[0].w === 300 && r.masks[0].clipped === false,
    JSON.stringify(r.masks[0]));
  check('a corner overlap is pulled to the crop origin',
    r.masks[1].x === 0 && r.masks[1].y === 89, r.masks[1].x + ',' + r.masks[1].y);
  check('and loses exactly the overhang',
    r.masks[1].w === 250 && r.masks[1].h === 61, r.masks[1].w + 'x' + r.masks[1].h);
  check('a right overrun is trimmed to the crop edge',
    r.masks[2].x + r.masks[2].w === 1440, r.masks[2].x + r.masks[2].w);
  check('clipped boxes say so', r.masks[1].clipped === true && r.masks[2].clipped === true);
  const inside = r.masks.every((m) =>
    m.x >= crop.x && m.y >= crop.y &&
    m.x + m.w <= crop.x + crop.w && m.y + m.h <= crop.y + crop.h);
  check('no kept box escapes the crop', inside, JSON.stringify(r.masks));
  check('an empty mask list is fine', F.clampMasks([], crop).masks.length === 0);
  check('an absent mask list is fine', F.clampMasks(undefined, crop).masks.length === 0);
}

console.log('a mask maps by the scale the image was actually drawn with');
{
  // Chosen so dest/crop and plan.scale DIVERGE: dest.w is an integer derived by
  // subtraction, so the true scale is dest.w/crop.w while plan.scale is the
  // value before rounding.
  const crop = { x: 0, y: 0, w: 904, h: 904 };
  const p = { ...F.planOutput({ crop, padding: 'roomy' }), crop };
  const far = { x: 900, y: 900, w: 4, h: 4 };
  const m = F.maskToDest(far, p);
  const trueSx = p.dest.w / crop.w;
  check('scale is taken from dest/crop',
    Math.abs(m.w - far.w * trueSx) < 1e-9, m.w + ' vs ' + far.w * trueSx);
  check('dest/crop and plan.scale actually differ for this input',
    Math.abs(trueSx - p.scale) > 1e-6, trueSx + ' vs ' + p.scale);
  const corner = F.maskToDest({ x: crop.w, y: crop.h, w: 0, h: 0 }, p);
  check('the crop corner maps to the dest corner',
    Math.abs(corner.x - (p.dest.x + p.dest.w)) < 1e-9,
    corner.x + ' vs ' + (p.dest.x + p.dest.w));
}

console.log('a Cover box owns whole output pixels, rounded outward');
{
  // Same divergent scale as above, so the mapping is genuinely fractional. If
  // it were not, every rounding rule would agree and none of this would bite.
  const crop = { x: 0, y: 0, w: 904, h: 904 };
  const p = { ...F.planOutput({ crop, padding: 'roomy' }), crop };
  const box = { x: 101, y: 203, w: 57, h: 31 };
  const f = F.maskToDest(box, p);
  const r = F.maskToDestPixels(box, p);

  check('the continuous mapping really is fractional for this input',
    f.x % 1 !== 0 || f.y % 1 !== 0 || (f.x + f.w) % 1 !== 0 || (f.y + f.h) % 1 !== 0,
    JSON.stringify(f));
  check('every field is an integer',
    Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h),
    JSON.stringify(r));
  // The whole point: the integer rect must COVER the fractional one. Any pixel
  // the fractional rect touches, even partly, must be inside the integer rect,
  // because a partly-touched pixel is a partly-covered pixel.
  check('it covers the continuous rect on every edge',
    r.x <= f.x && r.y <= f.y && r.x + r.w >= f.x + f.w && r.y + r.h >= f.y + f.h,
    JSON.stringify(r) + ' must cover ' + JSON.stringify(f));
  check('it grows by less than a pixel on each edge',
    f.x - r.x < 1 && f.y - r.y < 1 && (r.x + r.w) - (f.x + f.w) < 1 && (r.y + r.h) - (f.y + f.h) < 1,
    JSON.stringify(r) + ' vs ' + JSON.stringify(f));

  // A box on the crop's edge maps to dest's edge, and growing outward there
  // must not push fill onto the frame.
  const edge = { x: 0, y: 0, w: 4, h: 4 };
  const re = F.maskToDestPixels(edge, p);
  check('growing outward never escapes dest',
    re.x >= p.dest.x && re.y >= p.dest.y &&
    re.x + re.w <= p.dest.x + p.dest.w && re.y + re.h <= p.dest.y + p.dest.h,
    JSON.stringify(re) + ' vs dest ' + JSON.stringify(p.dest));
  const far = { x: crop.w - 4, y: crop.h - 4, w: 4, h: 4 };
  const rf = F.maskToDestPixels(far, p);
  check('the far corner also stays inside dest',
    rf.x + rf.w <= p.dest.x + p.dest.w && rf.y + rf.h <= p.dest.y + p.dest.h,
    JSON.stringify(rf) + ' vs dest ' + JSON.stringify(p.dest));

  // Asymmetric: a non-square crop scales x and y differently, so a rule that
  // reused one scale for both would pass every square test above.
  const tall = { x: 0, y: 0, w: 600, h: 1800 };
  const pt = { ...F.planOutput({ crop: tall, padding: 'standard' }), crop: tall };
  const tb = { x: 51, y: 151, w: 33, h: 77 };
  const ft = F.maskToDest(tb, pt);
  const rt = F.maskToDestPixels(tb, pt);
  check('a non-square crop still covers on every edge',
    rt.x <= ft.x && rt.y <= ft.y && rt.x + rt.w >= ft.x + ft.w && rt.y + rt.h >= ft.y + ft.h,
    JSON.stringify(rt) + ' must cover ' + JSON.stringify(ft));

  // A degenerate box owns nothing, and the guard must come BEFORE rounding:
  // outward-rounding a zero-width box at a fractional x would otherwise invent a
  // 1px mark from no area. clampMasks cannot drop it — a zero-size rect inside
  // the crop overlaps the crop and is a legal source rect.
  for (const d of [{ x: 400, y: 400, w: 0, h: 0 },
                   { x: 400, y: 400, w: 0, h: 20 },
                   { x: 400, y: 400, w: 20, h: 0 },
                   { x: 400, y: 400, w: -5, h: 20 }]) {
    check('a degenerate box ' + JSON.stringify(d) + ' owns nothing',
      F.maskToDestPixels(d, p) === null, JSON.stringify(F.maskToDestPixels(d, p)));
  }
  check('but one source pixel is enough to own an output pixel',
    F.maskToDestPixels({ x: 400, y: 400, w: 1, h: 1 }, p) !== null);
}

console.log('EXIF orientation swaps width and height for 5 through 8');
{
  for (const o of [1, 2, 3, 4]) {
    const r = F.orientedSize(1080, 2400, o);
    check('orientation ' + o + ' does not swap',
      r.width === 1080 && r.height === 2400 && !r.swapped, r.width + 'x' + r.height);
  }
  for (const o of [5, 6, 7, 8]) {
    const r = F.orientedSize(1080, 2400, o);
    check('orientation ' + o + ' swaps',
      r.width === 2400 && r.height === 1080 && r.swapped, r.width + 'x' + r.height);
  }
  check('orientation 1 needs no work', F.needsOrientation(1) === false);
  check('orientation 6 needs work', F.needsOrientation(6) === true);
  check('nonsense needs no work',
    !F.needsOrientation(0) && !F.needsOrientation(9) && !F.needsOrientation(undefined));
}

console.log('a crop is INTERSECTED with the image, not clamped field by field');
{
  // Partial overlap is the ONLY input that can tell the two rules apart. The
  // case this file already had - {-50,-50,9999,9999} - overshoots every edge at
  // once, where clamping each field and intersecting give the same answer, so
  // the assertion could not see the bug it was meant to catch.
  const p = F.clampCrop(1440, 3120, { x: -10, y: -20, w: 30, h: 40 });
  check('a left/top overhang shrinks the rect', p.w === 20 && p.h === 20, `${p.w}x${p.h}`);
  check('and the origin moves to the edge', p.x === 0 && p.y === 0, `${p.x},${p.y}`);
  // Asserted explicitly so the overshoot case below cannot be mistaken for
  // coverage of this one: the two rules AGREE there and DISAGREE here.
  check('the two rules really do differ on this input', p.w !== 30, p.w);

  const q = F.clampCrop(1440, 3120, { x: 1430, y: 3110, w: 100, h: 100 });
  check('a right/bottom overhang shrinks too', q.w === 10 && q.h === 10, `${q.w}x${q.h}`);

  const all = F.clampCrop(1440, 3120, { x: -50, y: -50, w: 9999, h: 9999 });
  check('overshooting every edge gives the whole image',
    all.x === 0 && all.y === 0 && all.w === 1440 && all.h === 3120, JSON.stringify(all));

  const inside = F.clampCrop(1440, 3120, { x: 10, y: 20, w: 30, h: 40 });
  check('a rect fully inside is untouched',
    inside.x === 10 && inside.y === 20 && inside.w === 30 && inside.h === 40, JSON.stringify(inside));

  let threw = null;
  try { F.clampCrop(1440, 3120, { x: 2000, y: 0, w: 100, h: 100 }); } catch (e) { threw = e; }
  check('a crop entirely outside the image throws', threw !== null, String(threw));
  check('and says so', /does not intersect/.test(threw ? threw.message : ''), threw && threw.message);
}

console.log('planCrop says when the crop had to be cut to the image');
{
  const r = F.planCrop({ image: IMG, crop: { x: -10, y: -20, w: 30, h: 40 } });
  check('the crop is the intersection', r.crop.w === 20 && r.crop.h === 20, `${r.crop.w}x${r.crop.h}`);
  check('and it warns', r.warnings.some((w) => /extended past the image/.test(w)), JSON.stringify(r.warnings));
  const fits = F.planCrop({ image: IMG, crop: { x: 100, y: 200, w: 300, h: 400 } });
  check('a crop that fits is not warned about',
    !fits.warnings.some((w) => /extended past the image/.test(w)), JSON.stringify(fits.warnings));
  check('and is unchanged', fits.crop.w === 300 && fits.crop.h === 400, JSON.stringify(fits.crop));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
