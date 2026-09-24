// Tests for src/compose.js — Phase 4.5's one-composition-two-scales rule.
//
//   for b in pad_from_crop dest_scaled aspect_from_crop no_round \
//            tol_blind symmetry_blind min_project_dead comp_own_arithmetic; do
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
import * as real from './compose.js';
import { cardSize } from './sizing.js';
import { planOutput } from './plan.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'pad_from_crop') {
  // The frame error: padding as a fraction of the IMAGE rather than of the
  // card. Both denominators are plausible and the two agree within a pixel or
  // two at standard padding, which is exactly why it survives a glance.
  F.composition = (crop, stop) => {
    const c = real.composition(crop, stop);
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
} else if (BREAK === 'comp_own_arithmetic') {
  // The design mistake compose.js's header argues against, written out: derive
  // the card from the raw inputs instead of asking `cardSize`. It agrees on an
  // ordinary crop and disagrees on exactly the ones cardSize exists for — the
  // encode clamp, MIN_PAD, the thin-crop repair — which is to say, on the
  // cases nobody checks by eye. It copies the crop 1:1 as cardSize does, so
  // the only thing it gets wrong is those paths.
  F.composition = (crop, stop = 'standard') => {
    const pct = typeof stop === 'number' ? stop : { snug: 0.03, standard: 0.06, roomy: 0.1 }[stop];
    const padSrc = Math.round(crop.w * pct);
    const scale = 1;
    const width = Math.round((crop.w + padSrc * 2) * scale);
    const height = Math.round((crop.h + padSrc * 2) * scale);
    const pad = Math.round(padSrc * scale);
    return {
      width, height,
      aspect: height / width,
      padFrac: pad / width,
      pad,
      dest: { x: pad, y: pad, w: width - pad * 2, h: height - pad * 2 },
      warnings: [], clamped: false, repaired: null,
    };
  };
} else if (BREAK === 'aspect_from_crop') {
  // The card's aspect taken from the crop, so the padding is not in it.
  F.composition = (crop, stop) => {
    const c = real.composition(crop, stop);
    return { ...c, aspect: crop.h / crop.w };
  };
} else if (BREAK === 'no_round') {
  // Fractional pixels, which Skia accepts and then anti-aliases into a soft
  // edge on a card whose whole subject is crisp text.
  F.project = (comp, width) => {
    const height = width * comp.aspect;
    const pad = width * comp.padFrac;
    const dest = { x: pad, y: pad, w: width - pad * 2, h: height - pad * 2 };
    return { width, height, pad, dest };
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
    return { width: w, height, pad, dest };
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

console.log('projecting to the export width reproduces the export exactly');
{
  // This is the invariant the module exists for. Not "close to" — equal.
  for (const [name, crop, stop] of [
    ['tall standard', CROP, 'standard'],
    ['wide snug', WIDE, 'snug'],
    ['roomy', CROP, 'roomy'],
    ['continuous', CROP, 0.037],
    ['a small crop', { w: 300, h: 400 }, 'standard'],
  ]) {
    const c = F.composition(crop, stop);
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
    const c = F.composition(CROP, 'standard');
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
  const c = F.composition(CROP, 'standard');
  const p = F.project(c, 413);   // deliberately not a round number
  for (const [k, v] of [
    ['width', p.width], ['height', p.height], ['pad', p.pad],
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
  const c = F.composition(CROP, 'standard');
  const good = F.project(c, 360);
  check('a real projection passes', F.sameComposition(c, good).ok, F.sameComposition(c, good).detail);

  // One pixel of height is the smallest lie the gate has to catch, because it
  // is what a second implementation off by one rounding produces.
  check('one pixel taller fails', !F.sameComposition(c, { ...good, height: good.height + 1 }).ok);
  check('one pixel of extra padding fails', !F.sameComposition(c, { ...good, pad: good.pad + 1 }).ok);
  check('an asymmetric dest fails even when every size is right',
    !F.sameComposition(c, { ...good, dest: { ...good.dest, x: good.dest.x + 1 } }).ok);
  check('the gate reports its margin, not just its verdict',
    typeof F.sameComposition(c, good).worst === 'number' &&
    F.sameComposition(c, good).detail.includes('height off'),
    F.sameComposition(c, good).detail);
}

console.log('a preview at any stage width is the same card as the export');
{
  // The sweep. 6 crops x 4 paddings x 9 stage widths = 216
  // projections, each checked against the ratios it came from. One case says
  // what broke; a sweep says the invariant holds, and neither alone is enough.
  const crops = [
    { w: 1200, h: 2000 }, { w: 2000, h: 900 }, { w: 1440, h: 3120 },
    { w: 1080, h: 1080 }, { w: 300, h: 400 }, { w: 1440, h: 6000 },
  ];
  const stops = ['snug', 'standard', 'roomy', 0.045];
  const widths = [1080, 900, 720, 540, 411, 393, 360, 240, 96];

  let worst = 0;
  let worstAt = '';
  let bad = 0;
  let n = 0;
  for (const crop of crops) {
    for (const stop of stops) {
      const c = F.composition(crop, stop);
      for (const w of widths) {
        n++;
        const r = F.sameComposition(c, F.project(c, w));
        if (!r.ok) { bad++; if (bad <= 3) console.log(`    ${crop.w}x${crop.h} ${stop}: ${r.detail}`); }
        if (r.worst > worst) { worst = r.worst; worstAt = `${crop.w}x${crop.h} ${stop} @${w}px`; }
      }
    }
  }
  // Printed on the passing path too. A measurement only emitted on failure is
  // a measurement nobody reads, and the margin is the interesting part.
  console.log(`    ${n} projections, worst deviation ${worst.toFixed(3)}px at ${worstAt}`);
  check(`all ${n} projections are the same composition`, bad === 0, `${bad} failed`);
  check('and the sweep actually ran', n === 216, String(n));
  check('the worst deviation is inside one rounding', worst <= 0.5, worst.toFixed(4));
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
  // agree on a 1080x1920 screenshot and part company at the encode clamp,
  // MIN_PAD and the thin-crop repair. `BREAK=comp_own_arithmetic`
  // is that mistake written out.
  const crops = [
    { w: 1440, h: 3120, why: 'an ordinary phone screenshot' },
    { w: 1440, h: 60000, why: 'tall enough to hit the encode clamp' },
    { w: 140, h: 90, why: 'small enough that MIN_PAD sets the frame' },
    { w: 60000, h: 1, why: 'thin, and wide enough to be clamped, so the crop repair fires' },
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
  const repairedComp = F.composition({ w: 60000, h: 1 }, 'standard');
  check('the thin-crop repair fired on the thin one', repairedComp.repaired !== null,
    String(repairedComp.repaired));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
