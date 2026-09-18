// Tests for src/sizing.js.
//
//   for b in longedge no_upscale_guard no_ceiling asym maxpx_binds pad_divorced \
//            no_dest_repair repair_always repair_asym; do
//     BREAK=$b node src/sizing.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. `longedge` is the important one: it reintroduces the
// 1600px long-edge cap that this module exists to have removed, so the
// long-thread assertion is shown to be guarding a real decision.
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
  // Drop the min(1, ...) so small sources are blown up to the target width.
  F.cardSize = (crop, stop) => {
    const r = real.cardSize(crop, stop);
    const k = real.TARGET_W / r.width;
    return { ...r, width: real.TARGET_W, height: Math.round(r.height * k), scale: k };
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

console.log('a normal 1080-wide crop');
{
  const r = F.cardSize({ w: 1080, h: 1200 }, 'standard');
  check('width lands at the target', r.width === 1080, r.width);
  check('does not exceed the target', r.width <= real.TARGET_W, r.width);
  check('scale is below 1 (padding pushed it over)', r.scale < 1, r.scale);
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
  check('width is still the target', r.width === 1080, r.width);
  check('height is NOT capped near 1600', r.height > 5000, r.height);
  check('scale did not collapse', r.scale > 0.8, r.scale);
  // Against the constant, not the literal '4000px' this used to match. A
  // hardcoded height in an assertion about a threshold keeps passing when the
  // threshold moves, which is the assertion agreeing with itself.
  check('warns that chat apps will downscale',
    r.warnings.some((w) => w.includes(`${F.WARN_H}px`)), JSON.stringify(r.warnings));
  check('and the warning names the threshold actually used',
    r.height > F.WARN_H, `${r.height} vs ${F.WARN_H}`);
  check('not clamped — 5.9MP is inside the ceiling', r.clamped === false, JSON.stringify(r));
  // The concrete regression: 36px source text must not become 9px.
  check('source text keeps most of its size', 36 * r.scale > 28, (36 * r.scale).toFixed(1));
}

console.log('never upscale');
{
  const r = F.cardSize({ w: 720, h: 900 }, 'standard');
  check('scale is exactly 1', r.scale === 1, r.scale);
  check('width stays below the target', r.width < real.TARGET_W, r.width);
  check('width is the padded source width', r.width === 720 + r.pad * 2, `${r.width} vs ${720 + r.pad * 2}`);
  check('says it did not upscale',
    r.warnings.some((w) => w.includes('not upscaled')), JSON.stringify(r.warnings));
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
  const srcAspect = (1080 + 128) / (20000 + 128);
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
  const DIVERGENT = [
    { w: 904, h: 904, stop: 'roomy' },   // naive 901 vs 900
    { w: 905, h: 905, stop: 'roomy' },   // naive 899 vs 900
    { w: 901, h: 1532, stop: 'roomy' },  // diverges on height only
    { w: 904, h: 542, stop: 'roomy' },
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

console.log('MAX_PX is slack, and the test says so rather than the comment');
{
  // The reachable maximum: cardSize never exceeds TARGET_W in width and clamps
  // height to MAX_H, so this product bounds every possible output.
  const reachable = F.TARGET_W * F.MAX_H;
  check('the largest possible output is under MAX_PX', reachable <= F.MAX_PX,
    (reachable / 1e6).toFixed(2) + 'MP vs ' + (F.MAX_PX / 1e6).toFixed(2) + 'MP');
  // Which makes the pixel disjunct in the clamp unreachable. Documented as a
  // property instead of a comment, so growing TARGET_W or MAX_H past it fails
  // here rather than quietly arming a limit nobody has revisited.
  check('so the pixel ceiling cannot be the binding constraint',
    F.MAX_PX / reachable >= 1, (F.MAX_PX / reachable).toFixed(2) + 'x headroom');

  // MEASURED_SURFACE_MAX was exported and referenced by nothing at all — a
  // measured number with `export const` in front of it, which is a comment
  // wearing a constant's clothes. Its own note said it is "the number to check
  // first if TARGET_W or MAX_H ever grow", so that check is here now. Raising
  // MAX_H past it fails this instead of producing an output size the device
  // answers with a null surface. It is one driver's value, not a portable
  // constant, which is why it bounds rather than being enforced per-call.
  check('output height stays under the measured Skia surface ceiling',
    F.MAX_H < F.MEASURED_SURFACE_MAX,
    `MAX_H ${F.MAX_H} vs measured ${F.MEASURED_SURFACE_MAX}`);
  check('and so does output width', F.TARGET_W < F.MEASURED_SURFACE_MAX,
    `TARGET_W ${F.TARGET_W} vs measured ${F.MEASURED_SURFACE_MAX}`);
  check('with the headroom the device measurement claimed',
    F.MEASURED_SURFACE_MAX / F.MAX_H >= 2,
    (F.MEASURED_SURFACE_MAX / F.MAX_H).toFixed(2) + 'x');

  // And the height ceiling, which DOES fire, still does.
  const tall = F.cardSize({ w: 1080, h: 60000 }, 'standard');
  check('a very tall crop is clamped', tall.clamped === true);
  check('to at most MAX_H', tall.height <= F.MAX_H, tall.height);
  check('and says so', tall.warnings.some((w) => /ceiling/.test(w)), JSON.stringify(tall.warnings));
}

console.log('a crop too thin to survive the padding still yields a drawable card');
{
  // The exact case from the review. Independent rounding of height and pad left
  // dest.h === 0 and no warning at all.
  const r = F.cardSize({ x: 0, y: 0, w: 1440, h: 1 }, 'standard');
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
  check('the width cap is still not exceeded', r.width <= real.TARGET_W, r.width);
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
  for (const stop of Object.keys(real.PADDING)) {
    for (let w = 100; w <= 3000; w += 10) {
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
  check('the sweep actually ran', swept === 3 * 291 * 40, swept);
  check('nothing degenerate survives it', degenerate === 0, badExamples.join(', '));
  // Without this the line above would also pass if the repair had been applied
  // to every crop, which would silently change real output.
  check('and the repair fired on a small minority, not everything',
    repaired > 0 && repaired < swept / 20, `${repaired} of ${swept}`);
}

console.log('the repair does not touch a crop that never needed it');
{
  // Pinned numbers from the capture the device run used, so the repair cannot
  // quietly alter the card whose sha256 the density gate rests on.
  const r = F.cardSize({ x: 0, y: 0, w: 1440, h: 3031 }, 'standard');
  check('width unchanged', r.width === 1080, r.width);
  check('height unchanged', r.height === 2146, r.height);
  check('padding unchanged', r.pad === 58, r.pad);
  check('destination unchanged', r.dest.w === 964 && r.dest.h === 2030, JSON.stringify(r.dest));
  check('and it is not marked repaired', r.repaired === null, r.repaired);

  // The asymmetric direction: thin in WIDTH rather than height. This one was
  // already fine, and has to stay fine — a repair that fired here would be
  // shrinking padding for no reason.
  const v = F.cardSize({ x: 0, y: 0, w: 1, h: 1440 }, 'standard');
  check('a crop thin in the other axis needs no repair', v.repaired === null, v.repaired);
  check('and still has a drawable destination', v.dest.w >= 1 && v.dest.h >= 1,
    JSON.stringify(v.dest));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
