// Tests for src/compose.js — Phase 4.5's one-composition-two-scales rule.
//
//   for b in pad_from_crop dest_scaled radius_pixels radius_unclamped \
//            aspect_from_crop no_round tol_blind symmetry_blind \
//            min_project_dead comp_own_arithmetic radius_inline; do
//     BREAK=$b node src/compose.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// `tol_blind` and `symmetry_blind` break the GATE rather than the arithmetic,
// because `sameComposition` is the thing the phase's verification leans on and
// a comparison that cannot fail is worth less than no comparison at all. They
// are killed by feeding the gate a projection that is deliberately wrong and
// asserting it says so — which is the only way to learn that it would.
//
// `radius_pixels` is the one to read if you read one. Carrying the radius as
// pixels instead of as a fraction is correct at export scale and wrong only on
// the preview, so it produces a card that looks right in every screenshot of
// the app and wrong on the phone. The sweep at the end is what catches it.
import * as real from './compose.js';
import { cardSize } from './sizing.js';
import { planOutput } from './plan.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'pad_from_crop') {
  // The frame error: padding as a fraction of the IMAGE rather than of the
  // card. Both denominators are plausible and the two agree within a pixel or
  // two at standard padding, which is exactly why it survives a glance.
  F.composition = (crop, stop, radius) => {
    const c = real.composition(crop, stop, radius);
    return { ...c, padFrac: c.pad / c.dest.w };
  };
} else if (BREAK === 'dest_scaled') {
  // Scale the image independently instead of subtracting, which is the
  // one-pixel bright line sizing.js carries a paragraph about.
  //
  // Measured on 2026-09-18: this disagrees with subtraction at 644 of the
  // 1033 widths from 48 to 1080 — and NOT at 1080. The export is correct and
  // only the preview is wrong, which is the shape of every bug this module
  // exists to make impossible.
  //
  // The first version of this mutant multiplied the padding by 1.002 and
  // exited 0, because 0.2% of a 58px pad rounds away to nothing. A mutation
  // that changes no observable value is not a mutation; it was measured
  // rather than assumed the second time.
  F.project = (comp, width) => {
    const p = real.project(comp, width);
    const s = p.width / comp.width;
    return {
      ...p,
      dest: { ...p.dest, w: Math.round(comp.dest.w * s), h: Math.round(comp.dest.h * s) },
    };
  };
} else if (BREAK === 'radius_inline') {
  // `project` doing the multiplication itself instead of calling radiusPx.
  // Identical today and one rounding change away from not being — and the
  // other caller is composeCard in src/pipeline.js, which no desktop test can
  // reach. So the assertion is that project and radiusPx are the same call,
  // which is the only part of that claim a desktop can hold.
  F.project = (comp, width) => {
    const p = real.project(comp, width);
    return { ...p, radius: Math.floor(p.dest.w * comp.radius) };
  };
} else if (BREAK === 'comp_own_arithmetic') {
  // The design mistake compose.js's header argues against, written out: derive
  // the card from the raw inputs instead of asking `cardSize`. It agrees on an
  // ordinary crop and disagrees on exactly the ones cardSize exists for — the
  // encode clamp, the never-upscale rule, the thin-crop repair — which is to
  // say, on the cases nobody checks by eye.
  F.composition = (crop, stop = 'standard', radius = real.DEFAULT_RADIUS) => {
    const pct = typeof stop === 'number' ? stop : { snug: 0.03, standard: 0.06, roomy: 0.1 }[stop];
    const padSrc = Math.round(crop.w * pct);
    const scale = Math.min(1, 1080 / (crop.w + padSrc * 2));
    const width = Math.round((crop.w + padSrc * 2) * scale);
    const height = Math.round((crop.h + padSrc * 2) * scale);
    const pad = Math.round(padSrc * scale);
    return {
      width, height,
      aspect: height / width,
      padFrac: pad / width,
      radius: Math.min(real.MAX_RADIUS, Math.max(0, radius)),
      pad,
      dest: { x: pad, y: pad, w: width - pad * 2, h: height - pad * 2 },
      warnings: [], clamped: false, repaired: null,
    };
  };
} else if (BREAK === 'radius_pixels') {
  // Freeze the radius at its export size and carry those pixels to every
  // scale. Invisible where it is right, wrong where nobody has a reference.
  F.project = (comp, width) => {
    const p = real.project(comp, width);
    return { ...p, radius: Math.round(comp.dest.w * comp.radius) };
  };
} else if (BREAK === 'radius_unclamped') {
  // Let a slider hand in whatever it likes.
  F.composition = (crop, stop, radius) => ({
    ...real.composition(crop, stop, 0),
    radius: Number.isFinite(radius) ? radius : 0,
  });
} else if (BREAK === 'aspect_from_crop') {
  // The card's aspect taken from the crop, so the padding is not in it.
  F.composition = (crop, stop, radius) => {
    const c = real.composition(crop, stop, radius);
    return { ...c, aspect: crop.h / crop.w };
  };
} else if (BREAK === 'no_round') {
  // Fractional pixels, which Skia accepts and then anti-aliases into a soft
  // edge on a card whose whole subject is crisp text.
  F.project = (comp, width) => {
    const height = width * comp.aspect;
    const pad = width * comp.padFrac;
    const dest = { x: pad, y: pad, w: width - pad * 2, h: height - pad * 2 };
    return { width, height, pad, dest, radius: dest.w * comp.radius };
  };
} else if (BREAK === 'tol_blind') {
  // The gate always agrees.
  F.sameComposition = () => ({ ok: true, worst: 0, detail: 'fine' });
} else if (BREAK === 'symmetry_blind') {
  // The gate checks the sizes and stops looking at where they landed, so
  // `dest_scaled` would walk straight past it.
  F.sameComposition = (comp, shot, tol = 0.5) => {
    const worst = Math.max(
      Math.abs(shot.height - shot.width * comp.aspect),
      Math.abs(shot.pad - shot.width * comp.padFrac),
      Math.abs(shot.radius - shot.dest.w * comp.radius),
    );
    return { ok: worst <= tol, worst, detail: 'sizes only' };
  };
} else if (BREAK === 'min_project_dead') {
  // Accept any width, including the zero-sized stage of the first layout pass.
  F.project = (comp, width) => {
    const w = Math.round(width);
    const height = Math.round(w * comp.aspect);
    const pad = Math.round(w * comp.padFrac);
    const dest = { x: pad, y: pad, w: w - pad * 2, h: height - pad * 2 };
    return { width: w, height, pad, dest, radius: Math.round(dest.w * comp.radius) };
  };
} else if (BREAK) {
  console.log(`unknown BREAK: ${BREAK}`);
  process.exit(2);
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}
const threw = (fn) => { try { fn(); return false; } catch { return true; } };

// A real Pixel 6 Pro capture, and a crop that is not square — a composition
// bug that swaps an axis is invisible on a square and this module is for
// screenshots of threads.
const CROP = { w: 1200, h: 2000 };
const WIDE = { w: 2000, h: 900 };

console.log('composition re-expresses the real card, it does not invent one');
{
  const c = F.composition(CROP, 'standard');
  const card = cardSize(CROP, 'standard');
  check('width comes from cardSize', c.width === card.width, `${c.width} vs ${card.width}`);
  check('height comes from cardSize', c.height === card.height, `${c.height} vs ${card.height}`);
  check('pad comes from cardSize', c.pad === card.pad, `${c.pad} vs ${card.pad}`);
  check('aspect is the CARD aspect, not the crop aspect',
    Math.abs(c.aspect - card.height / card.width) < 1e-12, String(c.aspect));
  check('and the two differ, so that check means something',
    Math.abs(c.aspect - CROP.h / CROP.w) > 0.01,
    `card ${c.aspect.toFixed(4)} vs crop ${(CROP.h / CROP.w).toFixed(4)}`);
  check('padFrac is a fraction of the CARD width',
    Math.abs(c.padFrac - card.pad / card.width) < 1e-12, String(c.padFrac));
  check('and that differs from a fraction of the image width',
    Math.abs(c.padFrac - card.pad / card.dest.w) > 1e-4,
    `card ${c.padFrac.toFixed(6)} vs image ${(card.pad / card.dest.w).toFixed(6)}`);
  check('warnings are carried through rather than swallowed',
    Array.isArray(c.warnings), String(c.warnings));
}

console.log('the continuous padding the Style strip needs already works');
{
  const a = F.composition(CROP, 'snug').padFrac;
  const b = F.composition(CROP, 0.045).padFrac;
  const d = F.composition(CROP, 'roomy').padFrac;
  check('a number between two stops lands between them', a < b && b < d,
    `${a.toFixed(5)} < ${b.toFixed(5)} < ${d.toFixed(5)}`);
  // Monotone across four settings rather than an on/off pair: padding is read
  // by the height, the pad and the destination, and a ramp says it is the
  // padding term moving rather than the whole object.
  const ramp = [0.02, 0.04, 0.08, 0.12].map((p) => F.composition(CROP, p).padFrac);
  check('and padFrac rises monotonically across a four-step ramp',
    ramp.every((v, i) => i === 0 || v > ramp[i - 1]), ramp.map((v) => v.toFixed(5)).join(' '));
}

console.log('the radius is clamped, because it arrives from a slider');
{
  check('over the maximum clamps down',
    F.composition(CROP, 'standard', 99).radius === real.MAX_RADIUS,
    String(F.composition(CROP, 'standard', 99).radius));
  check('negative clamps to zero',
    F.composition(CROP, 'standard', -1).radius === 0,
    String(F.composition(CROP, 'standard', -1).radius));
  check('NaN is treated as no radius, not carried into the pixels',
    F.composition(CROP, 'standard', NaN).radius === 0,
    String(F.composition(CROP, 'standard', NaN).radius));
  check('a value inside the range survives untouched',
    F.composition(CROP, 'standard', 0.02).radius === 0.02,
    String(F.composition(CROP, 'standard', 0.02).radius));

  // The default is a shipped value, so it is checked rather than assumed. It
  // is also the thing a Style slider initialises from, and a default outside
  // its own range would be clamped on the first frame and jump under the
  // thumb.
  check('omitting the radius uses DEFAULT_RADIUS',
    F.composition(CROP, 'standard').radius === real.DEFAULT_RADIUS,
    `${F.composition(CROP, 'standard').radius} vs ${real.DEFAULT_RADIUS}`);
  check('and DEFAULT_RADIUS is inside the range the slider offers',
    real.DEFAULT_RADIUS > 0 && real.DEFAULT_RADIUS < real.MAX_RADIUS,
    `${real.DEFAULT_RADIUS} against 0..${real.MAX_RADIUS}`);
}

console.log('projecting to the export width reproduces the export exactly');
{
  // This is the invariant the module exists for. Not "close to" — equal.
  for (const [name, crop, stop] of [
    ['tall standard', CROP, 'standard'],
    ['wide snug', WIDE, 'snug'],
    ['roomy', CROP, 'roomy'],
    ['continuous', CROP, 0.037],
    ['smaller than the target', { w: 300, h: 400 }, 'standard'],
  ]) {
    const c = F.composition(crop, stop, 0.02);
    const p = F.project(c, c.width);
    const card = cardSize(crop, stop);
    check(`${name}: width`, p.width === card.width, `${p.width} vs ${card.width}`);
    check(`${name}: height`, p.height === card.height, `${p.height} vs ${card.height}`);
    check(`${name}: pad`, p.pad === card.pad, `${p.pad} vs ${card.pad}`);
    check(`${name}: dest`,
      p.dest.x === card.dest.x && p.dest.y === card.dest.y &&
      p.dest.w === card.dest.w && p.dest.h === card.dest.h,
      `${JSON.stringify(p.dest)} vs ${JSON.stringify(card.dest)}`);
  }
}

console.log('margins are equal by construction at every scale');
{
  for (const w of [1080, 720, 411, 360, 120, 48]) {
    const c = F.composition(CROP, 'standard', 0.02);
    const p = F.project(c, w);
    check(`${w}px: left margin equals right margin`,
      p.dest.x === p.width - (p.dest.x + p.dest.w),
      `${p.dest.x} vs ${p.width - (p.dest.x + p.dest.w)}`);
    check(`${w}px: top margin equals bottom margin`,
      p.dest.y === p.height - (p.dest.y + p.dest.h),
      `${p.dest.y} vs ${p.height - (p.dest.y + p.dest.h)}`);
  }
}

console.log('every projected value is a whole number of pixels');
{
  const c = F.composition(CROP, 'standard', 0.025);
  const p = F.project(c, 413);   // deliberately not a round number
  for (const [k, v] of [
    ['width', p.width], ['height', p.height], ['pad', p.pad], ['radius', p.radius],
    ['dest.x', p.dest.x], ['dest.y', p.dest.y], ['dest.w', p.dest.w], ['dest.h', p.dest.h],
  ]) {
    check(`${k} is an integer`, Number.isInteger(v), String(v));
  }
}

console.log('project refuses a stage it cannot compose into');
{
  const c = F.composition(CROP, 'standard');
  check('a zero-width stage throws rather than returning a card with no image',
    threw(() => F.project(c, 0)));
  check('so does the first layout pass at width undefined',
    threw(() => F.project(c, undefined)));
  check('and anything below MIN_PROJECT', threw(() => F.project(c, real.MIN_PROJECT - 1)));
  check('MIN_PROJECT itself is allowed', !threw(() => F.project(c, real.MIN_PROJECT)));
}

console.log('the gate says no when it should');
{
  const c = F.composition(CROP, 'standard', 0.02);
  const good = F.project(c, 360);
  check('a real projection passes', F.sameComposition(c, good).ok, F.sameComposition(c, good).detail);

  // One pixel of height is the smallest lie the gate has to catch, because it
  // is what a second implementation off by one rounding produces.
  check('one pixel taller fails', !F.sameComposition(c, { ...good, height: good.height + 1 }).ok);
  check('one pixel of extra padding fails', !F.sameComposition(c, { ...good, pad: good.pad + 1 }).ok);
  check('a radius off by one fails', !F.sameComposition(c, { ...good, radius: good.radius + 1 }).ok);
  check('an asymmetric dest fails even when every size is right',
    !F.sameComposition(c, { ...good, dest: { ...good.dest, x: good.dest.x + 1 } }).ok);
  check('the gate reports its margin, not just its verdict',
    typeof F.sameComposition(c, good).worst === 'number' &&
    F.sameComposition(c, good).detail.includes('height off'),
    F.sameComposition(c, good).detail);
}

console.log('a preview at any stage width is the same card as the export');
{
  // The sweep. 6 crops x 4 paddings x 3 radii x 9 stage widths = 648
  // projections, each checked against the ratios it came from. One case says
  // what broke; a sweep says the invariant holds, and neither alone is enough.
  const crops = [
    { w: 1200, h: 2000 }, { w: 2000, h: 900 }, { w: 1440, h: 3120 },
    { w: 1080, h: 1080 }, { w: 300, h: 400 }, { w: 1440, h: 6000 },
  ];
  const stops = ['snug', 'standard', 'roomy', 0.045];
  const radii = [0, 0.015, 0.04];
  const widths = [1080, 900, 720, 540, 411, 393, 360, 240, 96];

  let worst = 0;
  let worstAt = '';
  let bad = 0;
  let n = 0;
  for (const crop of crops) {
    for (const stop of stops) {
      for (const radius of radii) {
        const c = F.composition(crop, stop, radius);
        for (const w of widths) {
          n++;
          const r = F.sameComposition(c, F.project(c, w));
          if (!r.ok) { bad++; if (bad <= 3) console.log(`    ${crop.w}x${crop.h} ${stop} r${radius}: ${r.detail}`); }
          if (r.worst > worst) { worst = r.worst; worstAt = `${crop.w}x${crop.h} ${stop} r${radius} @${w}px`; }
        }
      }
    }
  }
  // Printed on the passing path too. A measurement only emitted on failure is
  // a measurement nobody reads, and the margin is the interesting part.
  console.log(`    ${n} projections, worst deviation ${worst.toFixed(3)}px at ${worstAt}`);
  check(`all ${n} projections are the same composition`, bad === 0, `${bad} failed`);
  check('and the sweep actually ran', n === 648, String(n));
  check('the worst deviation is inside one rounding', worst <= 0.5, worst.toFixed(4));
}

console.log('\nradiusPx is the one place a radius becomes pixels');
{
  // src/pipeline.js `composeCard` calls this too, and that call is the half a
  // desktop test cannot reach. What it CAN hold is that `project` does not
  // have its own copy of the multiplication — so that when the renderer and
  // the preview disagree, it is not because there were two of them.
  check('a fraction of the image width, rounded', F.radiusPx(1000, 0.015) === 15, String(F.radiusPx(1000, 0.015)));
  check('rounded, not floored', F.radiusPx(1000, 0.0159) === 16, String(F.radiusPx(1000, 0.0159)));
  check('clamped at the top', F.radiusPx(1000, 1) === Math.round(1000 * real.MAX_RADIUS), String(F.radiusPx(1000, 1)));
  check('and at the bottom', F.radiusPx(1000, -5) === 0, String(F.radiusPx(1000, -5)));
  check('a non-number is square, not NaN', F.radiusPx(1000, undefined) === 0, String(F.radiusPx(1000, undefined)));

  let bad = 0;
  for (const w of [1080, 720, 393, 240]) {
    for (const r of [0, 0.004, 0.015, 0.04]) {
      const comp = F.composition({ w: 1200, h: 2000 }, 'standard', r);
      const shot = F.project(comp, w);
      if (shot.radius !== F.radiusPx(shot.dest.w, comp.radius)) bad++;
    }
  }
  check('every projection takes its radius from radiusPx', bad === 0, `${bad} off`);
}

console.log('\nthe card on screen and the card in the PNG are one composition');
{
  // Phase 4.5's stated verification, and the reason this module exists. The
  // preview reads `composition()`; the export reads `planOutput()` through
  // renderCard. Those are two call sites, and the claim is that they are one
  // answer — so it is asserted between the modules rather than inside either.
  //
  // The crops are chosen to reach `cardSize`'s special paths, because an
  // ordinary crop cannot tell the two apart: derive-it-yourself and ask-cardSize
  // agree on a 1080x1920 screenshot and part company at the encode clamp, the
  // never-upscale rule and the thin-crop repair. `BREAK=comp_own_arithmetic`
  // is that mistake written out.
  const crops = [
    { w: 1440, h: 3120, why: 'an ordinary phone screenshot' },
    { w: 1440, h: 60000, why: 'tall enough to hit the encode clamp' },
    { w: 300, h: 400, why: 'smaller than the target, so never upscaled' },
    { w: 1440, h: 1, why: 'thin enough to fire the crop repair' },
    { w: 2000, h: 900, why: 'landscape' },
  ];
  const stops = ['snug', 'standard', 'roomy', 0.045];
  let bad = 0;
  let n = 0;
  for (const crop of crops) {
    for (const stop of stops) {
      n++;
      const comp = F.composition({ w: crop.w, h: crop.h }, stop);
      const plan = planOutput({ crop: { x: 0, y: 0, w: crop.w, h: crop.h }, padding: stop });
      const same =
        comp.width === plan.width &&
        comp.height === plan.height &&
        comp.pad === plan.pad &&
        comp.dest.x === plan.dest.x && comp.dest.y === plan.dest.y &&
        comp.dest.w === plan.dest.w && comp.dest.h === plan.dest.h;
      if (!same) {
        bad++;
        if (bad <= 4) {
          console.log(`    ${crop.w}x${crop.h} ${stop} (${crop.why}):`);
          console.log(`      preview ${comp.width}x${comp.height} pad ${comp.pad} dest ${JSON.stringify(comp.dest)}`);
          console.log(`      export  ${plan.width}x${plan.height} pad ${plan.pad} dest ${JSON.stringify(plan.dest)}`);
        }
      }
    }
  }
  check(`all ${n} crop/padding pairs give the preview and the export one geometry`, bad === 0, `${bad} disagreed`);
  check('and the comparison actually ran', n === 20, String(n));

  // The other half of the claim: projecting the composition to the export's
  // own width reproduces the export exactly, so "same ratios" and "same
  // pixels" are not two different statements.
  let projBad = 0;
  for (const crop of crops) {
    const comp = F.composition({ w: crop.w, h: crop.h }, 'standard');
    const plan = planOutput({ crop: { x: 0, y: 0, w: crop.w, h: crop.h }, padding: 'standard' });
    const shot = F.project(comp, plan.width);
    if (shot.width !== plan.width || shot.height !== plan.height || shot.pad !== plan.pad ||
        shot.dest.w !== plan.dest.w || shot.dest.h !== plan.dest.h) {
      projBad++;
      console.log(`    ${crop.w}x${crop.h}: projected ${shot.width}x${shot.height} pad ${shot.pad}, export ${plan.width}x${plan.height} pad ${plan.pad}`);
    }
  }
  check('projecting to the export width reproduces the export', projBad === 0, `${projBad} off`);

  // And the case that makes the sweep mean something: the clamp and the repair
  // really did fire, so the interesting rows were not all ordinary ones.
  const clampedComp = F.composition({ w: 1440, h: 60000 }, 'standard');
  check('the encode clamp fired on the tall crop', clampedComp.clamped === true);
  // 'standard' specifically: at roomy the padding scales down far enough that
  // neither axis closes, so the repair does not fire and the check would be
  // asserting nothing. Which stop reaches which repair is not obvious, and
  // that is the reason to pin it rather than to pick one and hope.
  const repairedComp = F.composition({ w: 1440, h: 1 }, 'standard');
  check('the thin-crop repair fired on the thin one', repairedComp.repaired !== null,
    String(repairedComp.repaired));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
