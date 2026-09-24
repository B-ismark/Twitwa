// Tests for src/sizing.js.
//
//   for b in longedge no_upscale_guard no_ceiling asym maxpx_binds pad_divorced \
//            no_dest_repair repair_always repair_asym shrink_to_1080 \
//            no_width_ceiling sampling_always_exact sampling_always_smooth \
//            sampling_one_axis sampling_other_axis clamp_rounds no_width_repair \
//            clamp_at_ceiling \
//            pipeline_ignores_sampling pipeline_rect_options pipeline_gpu_shader; do
//     BREAK=$b node src/sizing.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. `longedge` and `shrink_to_1080` are the important
// ones: each reintroduces a rule this module exists to have removed — the
// 1600px long-edge cap, and the 1080 target width that made every card from a
// 1440-wide phone a 0.67 nearest-neighbour resample — so the assertions against
// them are shown to be guarding real decisions.
import * as real from './sizing.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'pad_divorced') {
  // cardSize rounds the padding its own way again -- one `floor` instead of
  // one `round`. At most one pixel out, invisible on a card, and it silently
  // breaks the padding slider's snap, which is defined as "the values that
  // draw the same card".
  F.padPixels = (cropW, pct) => Math.max(real.MIN_PAD, Math.floor(cropW * pct));
} else if (BREAK === 'longedge') {
  // The removed rule, restored.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    const long = Math.max(r.width, r.height);
    if (long > 1600) {
      const k = 1600 / long;
      return { ...r, width: Math.round(r.width * k), height: Math.round(r.height * k) };
    }
    return r;
  };
} else if (BREAK === 'no_upscale_guard') {
  // Small sources blown up to a phone's width, which makes them soft.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    if (r.width >= 1440) return r;
    const k = 1440 / r.width;
    return { ...r, width: 1440, height: Math.round(r.height * k), scale: k };
  };
} else if (BREAK === 'sampling_one_axis') {
  // Only the width compared: a card clamped by a single row reads as 1:1 and
  // is drawn nearest-neighbour. Survived the first review's mutation pass.
  F.samplingFor = (crop, dest) => (dest.w === crop.w ? 'exact' : 'smooth');
} else if (BREAK === 'sampling_other_axis') {
  F.samplingFor = (crop, dest) => (dest.h === crop.h ? 'exact' : 'smooth');
} else if (BREAK === 'clamp_rounds') {
  // The clamp rounding instead of flooring, which is how 1493x7700 at Roomy
  // came out 14,003,297px against a 14e6 ceiling.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    if (!r.clamped) return r;
    const pct = typeof stop === 'number' ? stop : real.PADDING[stop];
    const padSrc = real.padPixels(crop.w, pct);
    const pw = crop.w + padSrc * 2;
    const ph = crop.h + padSrc * 2;
    const k = Math.min(real.MAX_W / pw, real.MAX_H / ph, Math.sqrt(real.MAX_PX / (pw * ph)));
    return { ...r, width: Math.round(pw * k), height: Math.round(ph * k) };
  };
} else if (BREAK === 'no_width_repair') {
  // The width half of the thin-crop repair removed: a hair-thin crop on a very
  // tall capture plans a card whose padding closes over the image.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    if (r.repaired !== 'width' && r.repaired !== 'both') return r;
    const pad = Math.round(real.padPixels(crop.w, typeof stop === 'number' ? stop : real.PADDING[stop]) * r.scale);
    return { ...r, pad, repaired: null, dest: { x: pad, y: pad, w: r.width - pad * 2, h: r.dest.h } };
  };
} else if (BREAK === 'clamp_at_ceiling') {
  // `>=` for `>`: a card exactly at a ceiling is marked clamped and resampled.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    if (r.clamped || (r.width < real.MAX_W && r.height < real.MAX_H)) return r;
    return { ...r, clamped: true, width: r.width - 1, dest: { ...r.dest, w: r.dest.w - 1 } };
  };
} else if (BREAK === 'shrink_to_1080') {
  // The rule removed on 2026-09-24, restored: the padded crop scaled to fit 1080.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    if (r.width <= 1080) return r;
    const k = 1080 / r.width;
    const width = 1080;
    const height = Math.round(r.height * k);
    const pad = Math.round(r.pad * k);
    return { ...r, width, height, pad, scale: +(r.scale * k).toFixed(6),
      dest: { x: pad, y: pad, w: width - pad * 2, h: height - pad * 2 } };
  };
} else if (BREAK === 'sampling_always_exact') {
  // The plain draw everywhere: a clamped card is nearest-neighbour resampled,
  // which is the original blur, kept for exactly the cards that still shrink.
  F.samplingFor = () => 'exact';
} else if (BREAK === 'sampling_always_smooth') {
  // Filtering even at 1:1, which risks turning the copy into an interpolation.
  F.samplingFor = () => 'smooth';
} else if (BREAK === 'no_width_ceiling') {
  // MAX_W ignored: a panorama composes wider than the surface can be.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    const pad = real.padPixels(crop.w, typeof stop === 'number' ? stop : real.PADDING[stop]);
    const width = crop.w + pad * 2;
    const height = crop.h + pad * 2;
    if (width <= real.MAX_W || height > real.MAX_H || width * height > real.MAX_PX) return r;
    return { ...r, width, height, pad, scale: 1, clamped: false,
      dest: { x: pad, y: pad, w: crop.w, h: crop.h } };
  };
} else if (BREAK === 'warn_hardcoded') {
  // The coupling this file used to have: the threshold moves, the message keeps
  // naming the old number. The assertion used to match the literal '4000px' and
  // so kept passing while the warning described a height nothing compared
  // against.
  F.WARN_H = 3000;
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    return {
      ...r,
      warnings: r.warnings.map((w) =>
        w.startsWith('taller than') ? 'taller than 4000px: chat apps will downscale the preview' : w),
    };
  };
} else if (BREAK === 'surface_ceiling_slack') {
  // MAX_H raised past the measured Skia surface ceiling. Nothing in cardSize
  // notices — the output is simply a size the device returns null for — so the
  // relationship has to be asserted or it is only a comment.
  F.MAX_H = 20000;
} else if (BREAK === 'no_ceiling') {
  F.cardSize = (crop, stop) => ({ ...real.cardSize(crop, stop), clamped: false });
} else if (BREAK === 'maxpx_binds') {
  // MAX_PX lowered under the reachable maximum, which is what "this limit is
  // over-restrictive" assumed was already true. It was not: the output could
  // never reach 10MP, so the limit had no effect either way.
  F.MAX_PX = 8e6;
} else if (BREAK === 'no_dest_repair') {
  // The defect: accept a destination with no rows to draw into.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    if (!r.repaired) return r;
    const height = Math.round((crop.h + r.pad * 2 / r.scale) * r.scale);
    return { ...r, height, repaired: null, warnings: r.warnings.slice(0, -1),
      dest: { x: r.pad, y: r.pad, w: r.width - r.pad * 2, h: height - r.pad * 2 } };
  };
} else if (BREAK === 'repair_always') {
  // Fire the repair on every crop, not only the degenerate ones. This must be
  // caught by the pinned real-capture numbers, or the repair is free to change
  // output it was never meant to touch.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    return { ...r, height: r.height + 1, repaired: 'height',
      dest: { ...r.dest, h: r.height + 1 - r.pad * 2 } };
  };
} else if (BREAK === 'repair_asym') {
  // Grow one side only, which fixes the zero height and breaks the symmetry
  // that is the whole reason `dest` is derived by subtraction.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    if (!r.repaired) return r;
    return { ...r, dest: { ...r.dest, y: r.pad - 1, h: r.dest.h + 1 } };
  };
} else if (BREAK === 'asym') {
  // Derive dest by scaling the crop independently, which is what the real
  // implementation refuses to do. Rounding then leaves unequal margins.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    const w = Math.round(crop.w * r.scale);
    const h = Math.round(crop.h * r.scale);
    return { ...r, dest: { x: r.pad, y: r.pad, w, h } };
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

console.log('a phone screenshot is copied 1:1, never shrunk');
{
  // The owner's report, 2026-09-24: cards came out blurry. A 1440-wide Pixel
  // capture was scaled to 1080 with its padding, a 0.67 resample. These are
  // the assertions `shrink_to_1080` breaks.
  for (const [w, h, stop] of [[1440, 3120, 'standard'], [1440, 1947, 'roomy'], [1080, 2400, 'snug']]) {
    const r = F.cardSize({ w, h }, stop);
    check(`${w}x${h} ${stop}: scale is exactly 1`, r.scale === 1, r.scale);
    check(`${w}x${h} ${stop}: the image lands at its own size`,
      r.dest.w === w && r.dest.h === h, JSON.stringify(r.dest));
    check(`${w}x${h} ${stop}: the card is the crop plus its frame`,
      r.width === w + r.pad * 2 && r.height === h + r.pad * 2, `${r.width}x${r.height} pad ${r.pad}`);
  }
}
{
  const r = F.cardSize({ w: 1080, h: 1200 }, 'standard');
  check('a 1080 crop makes a card wider than 1080', r.width === 1080 + 2 * 65, r.width);
}
{
  // A card exactly AT a ceiling is still 1:1; one pixel over is clamped. Both
  // edges, both axes, because `>=` for `>` survived the first mutation pass.
  const atH = F.cardSize({ w: 1440, h: 7828 }, 'standard');   // 1612x8000
  check('exactly MAX_H tall is not clamped', atH.height === real.MAX_H && !atH.clamped && atH.scale === 1,
    `${atH.width}x${atH.height} clamped ${atH.clamped}`);
  const atW = F.cardSize({ w: 7142, h: 100 }, 'standard');    // 8000x958
  check('exactly MAX_W wide is not clamped', atW.width === real.MAX_W && !atW.clamped && atW.scale === 1,
    `${atW.width}x${atW.height} clamped ${atW.clamped}`);
  const overH = F.cardSize({ w: 1440, h: 7829 }, 'standard');
  check('one row over MAX_H is clamped', overH.clamped && overH.height <= real.MAX_H, JSON.stringify(overH));
  // And a clamp to MAX_H uses all of it. 1440x8139 pads to 8311 tall, the
  // first padded height where 8311 * (8000 / 8311) is 7999.999... in floats,
  // so a bare floor gives up a row the budget allows. This is the epsilon's
  // whole job; without this case a mutant deleting it survived.
  const fitH = F.cardSize({ w: 1440, h: 8139 }, 'standard');
  check('a height clamp lands on MAX_H exactly, not a row short',
    fitH.clamped && fitH.height === real.MAX_H, `${fitH.width}x${fitH.height}`);
}
{
  const r = F.cardSize({ w: 1080, h: 1200 }, 'standard');
  check('left and right margins are equal',
    r.width - r.dest.x - r.dest.w === r.dest.x,
    `left ${r.dest.x}, right ${r.width - r.dest.x - r.dest.w}`);
  check('top and bottom margins are equal',
    r.height - r.dest.y - r.dest.h === r.dest.y,
    `top ${r.dest.y}, bottom ${r.height - r.dest.y - r.dest.h}`);
  check('not clamped', r.clamped === false);
}

console.log('the long thread that motivated removing the long-edge cap');
{
  // 1080x6000 at standard padding. The old rule gave 316x1600.
  const r = F.cardSize({ w: 1080, h: 6000 }, 'standard');
  check('width is the crop plus its frame', r.width === 1080 + r.pad * 2, r.width);
  check('height is NOT capped near 1600', r.height > 5000, r.height);
  check('scale did not collapse', r.scale === 1, r.scale);
  // Against the constant, not the literal '4000px' this used to match. A
  // hardcoded height in an assertion about a threshold keeps passing when the
  // threshold moves, which is the assertion agreeing with itself.
  check('warns that chat apps will downscale',
    r.warnings.some((w) => w.includes(`${F.WARN_H}px`)), JSON.stringify(r.warnings));
  check('and the warning names the threshold actually used',
    r.height > F.WARN_H, `${r.height} vs ${F.WARN_H}`);
  check('not clamped — 7.4MP is inside the ceiling', r.clamped === false, JSON.stringify(r));
  // The concrete regression: 36px source text must not become 9px.
  check('source text keeps most of its size', 36 * r.scale > 28, (36 * r.scale).toFixed(1));
}

console.log('never upscale');
{
  const r = F.cardSize({ w: 720, h: 900 }, 'standard');
  check('scale is exactly 1', r.scale === 1, r.scale);
  check('width is the padded source width', r.width === 720 + r.pad * 2, `${r.width} vs ${720 + r.pad * 2}`);
  check('and nothing warns about it, because it is the normal case', r.warnings.length === 0,
    JSON.stringify(r.warnings));
}
{
  const tiny = F.cardSize({ w: 140, h: 90 }, 'snug');
  check('tiny crop gets the minimum padding, not 3%', tiny.pad === real.MIN_PAD, tiny.pad);
  check('tiny crop is not upscaled', tiny.scale === 1, tiny.scale);
}

// `padPixels` is the shared rounding. src/shell.js reads it to decide when a
// dragged padding is the same card as a named stop, so a `cardSize` that
// stopped calling it would move the card out from under the slider's snap with
// nothing failing. `pad_divorced` is that.
console.log('padPixels is the rounding cardSize actually uses');
{
  check('it is the max of the floor and the rounded fraction',
    F.padPixels(1080, 0.06) === 65 && F.padPixels(140, 0.03) === real.MIN_PAD,
    `${F.padPixels(1080, 0.06)} ${F.padPixels(140, 0.03)}`);

  // Walked, not spot-checked: the two must agree at every width and stop, and
  // the failure this guards is a rounding that agrees on the day it is written.
  let disagree = 0;
  let first = null;
  for (const w of [140, 720, 1080, 1170, 1440, 2048]) {
    for (let pct = 0.01; pct <= 0.2000001; pct += 0.001) {
      const r = F.cardSize({ w, h: 900 }, pct);
      // cardSize reports `pad` in OUTPUT pixels; undo its scale to get back to
      // the source-pixel padding padPixels returns.
      const want = F.padPixels(w, pct);
      const got = Math.round(r.pad / r.scale);
      if (Math.abs(want - got) > 1) {
        disagree++;
        if (!first) first = `w=${w} pct=${pct.toFixed(3)} want ${want} got ${got}`;
      }
    }
  }
  check('and cardSize lays the card out with exactly that padding',
    disagree === 0, `${disagree} disagreements, first ${first}`);
}

console.log('the encode ceiling');
{
  // 1080x20000 is the long-capture case: ~82MiB as one RGBA buffer at source.
  const r = F.cardSize({ w: 1080, h: 20000 }, 'standard');
  check('clamped', r.clamped === true, JSON.stringify(r));
  check('height is at or under the ceiling', r.height <= real.MAX_H, r.height);
  check('pixel count is at or under the ceiling', r.width * r.height <= real.MAX_PX + 1,
    r.width * r.height);
  check('width shrank too, so aspect is kept', r.width < 1080, r.width);
  // Pinned, because a clamped card is the only one whose pad is rounded at
  // all, and `ceil` for `round` survived the first mutation pass unpinned.
  check('pinned: 480x8000, pad 26', r.width === 480 && r.height === 8000 && r.pad === 26,
    `${r.width}x${r.height} pad ${r.pad}`);
  const padSrc = F.padPixels(1080, real.PADDING.standard);
  const srcAspect = (1080 + padSrc * 2) / (20000 + padSrc * 2);
  check('aspect preserved within a pixel of rounding',
    Math.abs(r.width / r.height - srcAspect) < 0.002, `${(r.width / r.height).toFixed(5)} vs ${srcAspect.toFixed(5)}`);
  check('says it was clamped',
    r.warnings.some((w) => w.includes('ceiling')), JSON.stringify(r.warnings));
  check('still symmetric after a heavy clamp',
    r.width - r.dest.x - r.dest.w === r.dest.x &&
    r.height - r.dest.y - r.dest.h === r.dest.y,
    `${r.dest.x}/${r.width - r.dest.x - r.dest.w}  ${r.dest.y}/${r.height - r.dest.y - r.dest.h}`);
}

console.log('symmetry at the inputs where naive scaling actually diverges');
{
  // Found by sweeping crop widths: at these sizes round(crop.w * scale) differs
  // from width - 2*pad by one pixel, which is a bright line down one edge of the
  // frame. Symmetry assertions on "nice" inputs pass either way and prove
  // nothing — BREAK=asym exits 0 without these cases.
  //
  // Since cards stopped being scaled to 1080 (2026-09-24) only a CLAMPED card
  // is resampled at all, so these are panoramas past MAX_W. The old list
  // (904x904 roomy and its neighbours) went 1:1 and stopped discriminating,
  // which the check below the loop is there to notice.
  const DIVERGENT = [
    // Re-derived when the clamp went from round to floor (review, 2026-09-24):
    // two of the first four stopped diverging, and the check below said so.
    { w: 7001, h: 924, stop: 'roomy' },  // both: naive 5928x782 vs 5927x781
    { w: 7002, h: 927, stop: 'roomy' },  // height only: naive 784 vs 785
    { w: 7003, h: 930, stop: 'roomy' },  // width only: naive 5922 vs 5921
    { w: 7004, h: 933, stop: 'roomy' },
  ];
  let asymmetric = 0;
  const detail = [];
  for (const c of DIVERGENT) {
    const r = F.cardSize({ w: c.w, h: c.h }, c.stop);
    const right = r.width - r.dest.x - r.dest.w;
    const bottom = r.height - r.dest.y - r.dest.h;
    if (right !== r.dest.x || bottom !== r.dest.y) {
      asymmetric++;
      detail.push(`${c.w}x${c.h}: L${r.dest.x}/R${right} T${r.dest.y}/B${bottom}`);
    }
  }
  check('all four stay symmetric', asymmetric === 0, detail.join('  '));

  // And confirm these inputs really are the divergent ones, so the case list
  // cannot silently rot into a set of inputs that no longer discriminates.
  let diverged = 0;
  for (const c of DIVERGENT) {
    const r = real.cardSize({ w: c.w, h: c.h }, c.stop);
    if (Math.round(c.w * r.scale) !== r.dest.w || Math.round(c.h * r.scale) !== r.dest.h) diverged++;
  }
  check('the case list still discriminates against naive scaling', diverged === DIVERGENT.length,
    `${diverged}/${DIVERGENT.length}`);
}

console.log('padding stops are ordered and proportional');
{
  const crop = { w: 1000, h: 1000 };
  const s = F.cardSize(crop, 'snug');
  const m = F.cardSize(crop, 'standard');
  const l = F.cardSize(crop, 'roomy');
  check('snug < standard < roomy', s.pad < m.pad && m.pad < l.pad, `${s.pad} ${m.pad} ${l.pad}`);
  check('every stop stays symmetric',
    [s, m, l].every((r) => r.width - r.dest.x - r.dest.w === r.dest.x &&
                           r.height - r.dest.y - r.dest.h === r.dest.y),
    [s, m, l].map((r) => `${r.dest.x}/${r.width - r.dest.x - r.dest.w}`).join(' '));
  check('every stop leaves a positive image area',
    [s, m, l].every((r) => r.dest.w > 0 && r.dest.h > 0),
    [s, m, l].map((r) => `${r.dest.w}x${r.dest.h}`).join(' '));
  // Proportional to crop width, so a small crop is not swamped by its frame.
  const wide = F.cardSize({ w: 2000, h: 1000 }, 'standard');
  const narrow = F.cardSize({ w: 500, h: 1000 }, 'standard');
  check('padding scales with crop width in source terms',
    wide.pad / wide.scale > narrow.pad / narrow.scale,
    `${(wide.pad / wide.scale).toFixed(1)} vs ${(narrow.pad / narrow.scale).toFixed(1)}`);
}

console.log('rejects nonsense rather than returning it');
{
  let threw = 0;
  for (const bad of [{ w: 0, h: 10 }, { w: 10, h: 0 }, { w: -5, h: 10 }]) {
    try { F.cardSize(bad, 'standard'); } catch { threw++; }
  }
  check('zero and negative crops throw', threw === 3, threw);
  let stopThrew = false;
  try { F.cardSize({ w: 100, h: 100 }, 'huge'); } catch { stopThrew = true; }
  check('an unknown padding stop throws', stopThrew);
  const numeric = F.cardSize({ w: 1000, h: 1000 }, 0.05);
  check('a numeric stop is accepted', numeric.pad > 0, numeric.pad);
}

console.log('MAX_PX leaves every phone screenshot 1:1, and the test says so rather than the comment');
{
  // The promise: a full-width phone crop at the roomiest stop, as tall as
  // MAX_H allows, is not shrunk by the pixel ceiling. Lowering MAX_PX under
  // this re-arms shrinking on real screenshots, which is the blur the owner
  // reported; `maxpx_binds` is that.
  // 1440 is the Pixel 6 Pro's capture width, read off the device, and the width
  // of the other QHD+ phones. A literal on purpose: an exported constant for it
  // let a mutant set it to 1080 and pass this check.
  const PIXEL_W = 1440;
  const roomiest = Math.max(...Object.values(real.PADDING));
  const widest = PIXEL_W + F.padPixels(PIXEL_W, roomiest) * 2;
  const reachable = widest * F.MAX_H;
  check('a full-width capture at MAX_H, roomy, is under MAX_PX', reachable <= F.MAX_PX,
    (reachable / 1e6).toFixed(2) + 'MP vs ' + (F.MAX_PX / 1e6).toFixed(2) + 'MP');
  // And the behaviour, not just the constants.
  const tallest = F.cardSize({ w: PIXEL_W, h: F.MAX_H - F.padPixels(PIXEL_W, roomiest) * 2 }, 'roomy');
  check('and cardSize agrees: that card is not clamped', tallest.clamped === false && tallest.scale === 1,
    `${tallest.width}x${tallest.height} scale ${tallest.scale}`);

  // MEASURED_SURFACE_MAX was exported and referenced by nothing at all — a
  // measured number with `export const` in front of it, which is a comment
  // wearing a constant's clothes. Its own note said it is "the number to check
  // first if TARGET_W or MAX_H ever grow", so that check is here now (TARGET_W
  // is gone since 2026-09-24; MAX_W is what bounds the width). Raising
  // MAX_H past it fails this instead of producing an output size the device
  // answers with a null surface. It is one driver's value, not a portable
  // constant, which is why it bounds rather than being enforced per-call.
  check('output height stays under the measured Skia surface ceiling',
    F.MAX_H < F.MEASURED_SURFACE_MAX,
    `MAX_H ${F.MAX_H} vs measured ${F.MEASURED_SURFACE_MAX}`);
  check('and so does output width', F.MAX_W < F.MEASURED_SURFACE_MAX,
    `MAX_W ${F.MAX_W} vs measured ${F.MEASURED_SURFACE_MAX}`);
  check('with the headroom the device measurement claimed',
    F.MEASURED_SURFACE_MAX / F.MAX_H >= 2,
    (F.MEASURED_SURFACE_MAX / F.MAX_H).toFixed(2) + 'x');

  // And the height ceiling, which DOES fire, still does.
  const tall = F.cardSize({ w: 1080, h: 60000 }, 'standard');
  check('a very tall crop is clamped', tall.clamped === true);
  check('to at most MAX_H', tall.height <= F.MAX_H, tall.height);
  check('and says so', tall.warnings.some((w) => /ceiling/.test(w)), JSON.stringify(tall.warnings));

  // The width ceiling, new with the 1:1 rule. 9000x300 pads to 10080x1380,
  // 13.9MP: over MAX_W and UNDER MAX_PX, so only the width ceiling can catch
  // it. 20000x1000 was the first choice and taught nothing — MAX_PX clamps it
  // anyway, and `no_width_ceiling` survived it.
  const wide = F.cardSize({ w: 9000, h: 300 }, 'standard');
  check('a panorama is clamped', wide.clamped === true, JSON.stringify(wide));
  check('to at most MAX_W', wide.width <= F.MAX_W, wide.width);

  // No clamped card may land over a ceiling after its rounding. Swept rather
  // than spot-checked, and the known offender pinned so the sweep cannot rot
  // into inputs that never overshoot.
  const known = F.cardSize({ w: 1493, h: 7700 }, 'roomy');
  check('1493x7700 roomy is under MAX_PX (it rounded to 14,003,297 once)',
    known.width * known.height <= F.MAX_PX, `${known.width}x${known.height} = ${known.width * known.height}`);
  let over = 0;
  let clampedSeen = 0;
  let n = 0;
  for (const stop of ['snug', 'standard', 'roomy', 0.037, 0.0513]) {
    for (let w = 1000; w <= 9000; w += 37) {
      for (let h = 5000; h <= 40000; h += 313) {
        n++;
        const c = F.cardSize({ w, h }, stop);
        if (c.clamped) clampedSeen++;
        if (c.width * c.height > F.MAX_PX || c.width > F.MAX_W || c.height > F.MAX_H) over++;
      }
    }
  }
  check(`none of ${n} clamped-range cards lands over a ceiling`, over === 0, `${over} over`);
  check('and the sweep really was in the clamped range', clampedSeen > n / 2, `${clampedSeen} of ${n}`);
}

console.log('a crop too thin to survive the padding still yields a drawable card');
{
  // The case from the review was 1440x1: independent rounding of height and
  // pad left dest.h === 0 and no warning at all. At 1:1 that crop is safe, so
  // the input is now one the WIDTH ceiling scales, which is the only way left
  // for the padding to round past the image.
  const r = F.cardSize({ x: 0, y: 0, w: 60000, h: 1 }, 'standard');
  check('the destination has a row to draw into', r.dest.h >= 1, JSON.stringify(r.dest));
  check('and a column', r.dest.w >= 1, JSON.stringify(r.dest));
  check('the caller is told', r.warnings.some((w) => /thinner than the padding/.test(w)),
    JSON.stringify(r.warnings));
  check('the repair names the axis it grew', r.repaired === 'height', r.repaired);
  check('the margins are still equal top and bottom',
    r.dest.y === r.pad && r.height - (r.dest.y + r.dest.h) === r.pad,
    `y ${r.dest.y}, pad ${r.pad}, bottom ${r.height - (r.dest.y + r.dest.h)}`);
  check('and left and right',
    r.dest.x === r.pad && r.width - (r.dest.x + r.dest.w) === r.pad,
    `x ${r.dest.x}, pad ${r.pad}, right ${r.width - (r.dest.x + r.dest.w)}`);
  check('the width cap is still not exceeded', r.width <= real.MAX_W, r.width);
}

console.log('no crop anywhere in the thin band produces a degenerate destination');
{
  // The sweep is the assertion. One case fixed by hand says nothing about the
  // family it came from: the original defect covered 604 crops, at four
  // different heights, and a single probe at h=1 would have missed three of them.
  let degenerate = 0;
  let repaired = 0;
  let swept = 0;
  const badExamples = [];
  // Phone widths, which are 1:1 and must never need the repair, and then
  // widths past MAX_W, where the clamp scales and the repair has work to do.
  const widths = [];
  for (let w = 100; w <= 3000; w += 10) widths.push(w);
  for (let w = 8000; w <= 60000; w += 2000) widths.push(w);
  for (const stop of Object.keys(real.PADDING)) {
    for (const w of widths) {
      for (let h = 1; h <= 40; h++) {
        swept++;
        const r = F.cardSize({ x: 0, y: 0, w, h }, stop);
        if (r.repaired) repaired++;
        if (!(r.dest.w > 0) || !(r.dest.h > 0)) {
          degenerate++;
          if (badExamples.length < 3) badExamples.push(`${stop} ${w}x${h}`);
        }
        if (r.dest.x !== r.pad || r.dest.y !== r.pad) degenerate++;
      }
    }
  }
  check('the sweep actually ran', swept === 3 * (291 + 27) * 40, swept);
  check('nothing degenerate survives it', degenerate === 0, badExamples.join(', '));
  // Without this the line above would also pass if the repair had been applied
  // to every crop, which would silently change real output.
  check('and the repair fired on a small minority, not everything',
    repaired > 0 && repaired < swept / 20, `${repaired} of ${swept}`);
}

console.log('the repair does not touch a crop that never needed it');
{
  // Pinned numbers from the capture the device run used, so the repair cannot
  // quietly alter a real card. Re-pinned on 2026-09-24 when the 1080 target
  // went: this was 1080x2146 pad 58 dest 964x2030, a 0.67 resample, and every
  // sha256 taken of a card before that date is of the old geometry.
  const r = F.cardSize({ x: 0, y: 0, w: 1440, h: 3031 }, 'standard');
  check('width unchanged', r.width === 1612, r.width);
  check('height unchanged', r.height === 3203, r.height);
  check('padding unchanged', r.pad === 86, r.pad);
  check('destination unchanged', r.dest.w === 1440 && r.dest.h === 3031, JSON.stringify(r.dest));
  check('and it is not marked repaired', r.repaired === null, r.repaired);

  // The asymmetric direction: thin in WIDTH rather than height. This one was
  // already fine, and has to stay fine — a repair that fired here would be
  // shrinking padding for no reason.
  const v = F.cardSize({ x: 0, y: 0, w: 1, h: 1440 }, 'standard');
  check('a crop thin in the other axis needs no repair', v.repaired === null, v.repaired);
  check('and still has a drawable destination', v.dest.w >= 1 && v.dest.h >= 1,
    JSON.stringify(v.dest));
}

console.log('the crop is copied when it fits and filtered only when a ceiling shrank it');
{
  // Through cardSize, so the check is about the geometry the pipeline really
  // hands to samplingFor, not about two hand-made rects.
  const phone = F.cardSize({ w: 1404, h: 3002 }, 'standard');
  check('a phone crop is drawn exact', F.samplingFor({ w: 1404, h: 3002 }, phone.dest) === 'exact',
    JSON.stringify(phone.dest));
  const roomyTall = F.cardSize({ w: 1392, h: 7712 }, 'roomy');
  check('so is the tallest one that fits', F.samplingFor({ w: 1392, h: 7712 }, roomyTall.dest) === 'exact',
    JSON.stringify(roomyTall.dest));
  const clamped = F.cardSize({ w: 1392, h: 12000 }, 'standard');
  check('a clamped crop is drawn smooth', clamped.clamped && F.samplingFor({ w: 1392, h: 12000 }, clamped.dest) === 'smooth',
    JSON.stringify(clamped.dest));
  const wide = F.cardSize({ w: 9000, h: 300 }, 'standard');
  check('and so is a panorama the width ceiling shrank', F.samplingFor({ w: 9000, h: 300 }, wide.dest) === 'smooth',
    JSON.stringify(wide.dest));
}

console.log('a crop thin in WIDTH on a tall capture keeps a column and a non-negative frame');
{
  // The width half of the repair had no test that could fail: every thin case
  // above is thin in height. These are thin in width and tall enough to clamp,
  // which is the only way the width axis can close now.
  const cases = [{ w: 1, h: 20000 }, { w: 2, h: 60000 }, { w: 3, h: 200000 }, { w: 1, h: 1e6 }];
  let bad = 0;
  const detail = [];
  for (const c of cases) {
    for (const stop of Object.keys(real.PADDING)) {
      const r = F.cardSize(c, stop);
      const ok = r.pad >= 0 && r.dest.x >= 0 && r.dest.w >= 1 && r.dest.h >= 1 && r.width >= 1 &&
        r.width === r.dest.w + r.pad * 2;
      if (!ok) { bad++; if (detail.length < 3) detail.push(`${c.w}x${c.h} ${stop}: ${JSON.stringify(r.dest)} pad ${r.pad} w ${r.width}`); }
    }
  }
  check('every one has a column to draw into and equal, non-negative margins', bad === 0, detail.join('; '));
  const r = F.cardSize({ w: 1, h: 20000 }, 'standard');
  check('and the width repair is what fired on 1x20000', r.repaired === 'width', String(r.repaired));
}

console.log('a card clamped on one axis only is still filtered');
{
  // A clamped card nearly always shrinks on both axes, so a one-axis
  // comparison passes on every ordinary case. These are the two that move on
  // one axis alone, found by search: 2x8297 keeps its width (MIN_PAD's frame
  // gives up the pixel instead) and 7152x50 keeps its height. Each kills one
  // of the one-axis mutants, and each is checked to still be that shape so the
  // pair cannot rot into two ordinary cases.
  const tall = { w: 2, h: 8297 };
  const rt = F.cardSize(tall, 'standard');
  check('2x8297: clamped, width kept, height scaled',
    rt.clamped && rt.dest.w === tall.w && rt.dest.h !== tall.h, JSON.stringify(rt.dest));
  check('2x8297 is drawn smooth', F.samplingFor(tall, rt.dest) === 'smooth', JSON.stringify(rt.dest));
  const wide = { w: 7152, h: 50 };
  const rw = F.cardSize(wide, 'standard');
  check('7152x50: clamped, height kept, width scaled',
    rw.clamped && rw.dest.h === wide.h && rw.dest.w !== wide.w, JSON.stringify(rw.dest));
  check('7152x50 is drawn smooth', F.samplingFor(wide, rw.dest) === 'smooth', JSON.stringify(rw.dest));
}

console.log('pipeline.js draws the way samplingFor says');
{
  // The draw itself needs Skia, which no desktop test can load, so this reads
  // the SOURCE — the legitimate exception to importing the data, for the same
  // reason crop.test.mjs reads crop.js for its worklet directives. It asserts
  // the two things a desktop can hold: the branch is on samplingFor with the
  // real plan geometry, and the smooth path is the shader, not
  // drawImageRectOptions, whose strict constraint drops the mipmaps.
  const { readFileSync } = await import('node:fs');
  let src = readFileSync(new URL('./pipeline.js', import.meta.url), 'utf8');
  if (BREAK === 'pipeline_ignores_sampling') {
    src = src.replace("if (sampling === 'exact')", 'if (true)');
  } else if (BREAK === 'pipeline_rect_options') {
    src = src.replace('canvas.drawRect(dst, smooth);',
      'canvas.drawImageRectOptions(img, src, dst, FilterMode.Linear, MipmapMode.Linear, paint);');
  } else if (BREAK === 'pipeline_gpu_shader') {
    src = src.replace("const raster = sampling === 'smooth' && !colorSpace;", 'const raster = false;');
  }
  check('composeCard branches on samplingFor(plan.crop, plan.dest)',
    src.includes("const sampling = samplingFor(plan.crop, plan.dest);") && src.includes("if (sampling === 'exact')"));
  check('the smooth path samples through a mipmapped image shader',
    /makeShaderOptions\([^)]*FilterMode\.Linear,\s*MipmapMode\.Linear/.test(src) && src.includes('canvas.drawRect(dst, smooth);'));
  // A GPU image shader over a source past the texture limit draws nothing
  // (measured: 1440x20000 on the Pixel gave a card of pure frame).
  check('a smooth sRGB card is composed on a raster surface, which has no texture limit',
    src.includes("const raster = sampling === 'smooth' && !colorSpace;") &&
    src.includes('? Skia.Surface.Make(plan.width, plan.height)') &&
    src.includes("const sampling = samplingFor(plan.crop, plan.dest);") &&
    src.includes("if (sampling === 'exact') {"));
  check('and nothing calls drawImageRectOptions, which silently drops mipmaps',
    !/\.drawImageRectOptions\(/.test(src.replace(/^\s*\/\/.*$/gm, '')));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
