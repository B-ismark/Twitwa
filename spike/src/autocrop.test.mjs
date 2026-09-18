// Tests for src/autocrop.js — the crop the editor opens on.
//
//   for b in band_symmetric band_all_flat axes_swapped statusbar_overrides \
//            statusbar_ignored floor_whole floor_dead profile_short_ok \
//            no_reason trim_not_subtracted; do
//     BREAK=$b node src/autocrop.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// EVERY FIXTURE HERE IS ASYMMETRIC, and that is the point rather than a
// flourish. A trim has four independent numbers and three ways to confuse
// them — top with bottom, left with right, and the whole vertical axis with
// the whole horizontal one — and all three are exactly right on a screenshot
// with equal margins. So no two margins in this file are the same number and
// no fixture is square. `band_symmetric` and `axes_swapped` are the mutants
// that would survive any other choice.
import * as real from './autocrop.js';
import { MIN_CROP } from './crop.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'band_symmetric') {
  // The trailing band measured as the leading one. Correct on any profile
  // with equal margins, and silently wrong on every real screenshot.
  F.flatBand = (profile, flat) => {
    const b = real.flatBand(profile, flat);
    return b.inked ? { ...b, trail: b.lead } : b;
  };
  F.proposeCrop = (args) => {
    const r = real.proposeCrop(args);
    const b = real.flatBand(args.rows, args.flat);
    if (!b.inked) return r;
    const bottom = b.lead;
    const h = args.height - r.trimmed.top - bottom;
    return { ...r, trimmed: { ...r.trimmed, bottom }, crop: { ...r.crop, h } };
  };
} else if (BREAK === 'band_all_flat') {
  // A blank profile reports the whole length as its leading band. Arithmetic
  // that looks right at every step and produces a card with no picture in it.
  F.flatBand = (profile, flat = real.FLAT) => {
    const b = real.flatBand(profile, flat);
    return b.inked ? b : { lead: profile.length, trail: 0, inked: true };
  };
  F.proposeCrop = (args) => {
    const rb = F.flatBand(args.rows, args.flat);
    const cb = F.flatBand(args.cols, args.flat);
    if (real.flatBand(args.rows, args.flat).inked && real.flatBand(args.cols, args.flat).inked) {
      return real.proposeCrop(args);
    }
    return {
      crop: { x: cb.lead, y: rb.lead, w: args.width - cb.lead, h: args.height - rb.lead },
      trimmed: { top: rb.lead, bottom: 0, left: cb.lead, right: 0 },
      reasons: ['trimmed'],
    };
  };
} else if (BREAK === 'axes_swapped') {
  // The row profile driving the left and right edges. Exactly right on a
  // square screenshot with equal margins, which is what a synthetic fixture
  // looks like unless someone decides otherwise.
  F.proposeCrop = (args) => real.proposeCrop({ ...args, rows: args.cols, cols: args.rows, width: args.height, height: args.width });
} else if (BREAK === 'statusbar_overrides') {
  // The cut applied as an answer rather than as a floor, so a screenshot
  // someone already cropped below their status bar has its top pushed back UP
  // into the empty space above the post.
  F.proposeCrop = (args) => {
    if (!args.statusBar || !args.statusBar.detected) return real.proposeCrop(args);
    const r = real.proposeCrop({ ...args, statusBar: null });
    const top = args.statusBar.cut;
    return { ...r, trimmed: { ...r.trimmed, top }, crop: { ...r.crop, y: top, h: args.height - top - r.trimmed.bottom } };
  };
} else if (BREAK === 'statusbar_ignored') {
  // The flat-band trim alone, which walks straight past a status bar because
  // a clock is ink.
  F.proposeCrop = (args) => real.proposeCrop({ ...args, statusBar: null });
} else if (BREAK === 'floor_whole') {
  // A trim below the floor on one axis backs out both, throwing away the trim
  // that was fine.
  F.proposeCrop = (args) => {
    const r = real.proposeCrop(args);
    if (r.reasons.some((s) => s.includes('floor'))) {
      return {
        crop: { x: 0, y: 0, w: args.width, h: args.height },
        trimmed: { top: 0, bottom: 0, left: 0, right: 0 },
        reasons: r.reasons,
      };
    }
    return r;
  };
} else if (BREAK === 'floor_dead') {
  F.proposeCrop = (args) => real.proposeCrop({ ...args, min: 0 });
} else if (BREAK === 'profile_short_ok') {
  // Accept a capped profile as if it covered the image. `rowInkProfile` takes
  // a row cap, so this is one forgotten argument away at every call site, and
  // it reports the flat run at the CAP as the flat run at the bottom.
  F.proposeCrop = (args) => {
    const rows = new Float32Array(args.height);
    rows.set(args.rows.subarray(0, Math.min(args.rows.length, args.height)));
    const cols = new Float32Array(args.width);
    cols.set(args.cols.subarray(0, Math.min(args.cols.length, args.width)));
    return real.proposeCrop({ ...args, rows, cols });
  };
} else if (BREAK === 'no_reason') {
  F.proposeCrop = (args) => ({ ...real.proposeCrop(args), reasons: [] });
} else if (BREAK === 'trim_not_subtracted') {
  // The origin moved and the size left alone, so the crop hangs off the
  // bottom-right of the image by exactly the amount that was trimmed.
  F.proposeCrop = (args) => {
    const r = real.proposeCrop(args);
    return { ...r, crop: { ...r.crop, w: args.width - r.trimmed.left, h: args.height - r.trimmed.top } };
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

/** A profile with `lead` flat, then ink, then `trail` flat. */
function profile(n, lead, trail, ink = 0.4) {
  const p = new Float32Array(n);
  for (let i = lead; i < n - trail; i++) p[i] = ink;
  return p;
}

// Four different margins on a non-square image. Nothing here shares a number
// with anything else here, on purpose.
const W = 400;
const H = 900;
const TOP = 7;
const BOTTOM = 31;
const LEFT = 13;
const RIGHT = 53;
const base = () => ({
  width: W,
  height: H,
  rows: profile(H, TOP, BOTTOM),
  cols: profile(W, LEFT, RIGHT),
});

console.log('flatBand finds each end independently');
{
  const b = F.flatBand(profile(100, 4, 19));
  check('the leading run', b.lead === 4, String(b.lead));
  check('the trailing run, which is a different number', b.trail === 19, String(b.trail));
  check('and it says there was ink', b.inked === true);

  const flat = F.flatBand(new Float32Array(50));
  check('an entirely flat profile trims nothing', flat.lead === 0 && flat.trail === 0,
    `${flat.lead}/${flat.trail}`);
  check('and says so rather than reporting a zero band', flat.inked === false);

  const solid = F.flatBand(profile(30, 0, 0));
  check('a profile inked end to end trims nothing', solid.lead === 0 && solid.trail === 0);
  check('and does say there was ink', solid.inked === true);

  const one = F.flatBand(profile(20, 19, 0));
  check('a single inked row at the end is found', one.lead === 19 && one.trail === 0,
    `${one.lead}/${one.trail}`);

  // The threshold is a threshold, not a comparison with zero: a status bar's
  // glyph row scores low but non-zero, and reading `> 0` as ink would find
  // the top of every screenshot inked.
  const faint = new Float32Array(20);
  faint.fill(0.004);
  faint[10] = 0.9;
  const f = F.flatBand(faint);
  check('coverage under the threshold is flat, not ink', f.lead === 10, String(f.lead));
  check('and over it is ink', F.flatBand(faint, 0.001).lead === 0, String(F.flatBand(faint, 0.001).lead));
}

console.log('\nfour edges, four different answers');
{
  const r = F.proposeCrop(base());
  check('the top comes from the row profile', r.trimmed.top === TOP, String(r.trimmed.top));
  check('the bottom too, and is not the top', r.trimmed.bottom === BOTTOM, String(r.trimmed.bottom));
  check('the left comes from the column profile', r.trimmed.left === LEFT, String(r.trimmed.left));
  check('the right too, and is not the left', r.trimmed.right === RIGHT, String(r.trimmed.right));

  check('the crop starts at the first inked pixel', r.crop.x === LEFT && r.crop.y === TOP,
    `${r.crop.x},${r.crop.y}`);
  check('its width is the image less both horizontal trims', r.crop.w === W - LEFT - RIGHT, String(r.crop.w));
  check('its height is the image less both vertical trims', r.crop.h === H - TOP - BOTTOM, String(r.crop.h));
  check('and the whole thing is inside the image',
    r.crop.x + r.crop.w <= W && r.crop.y + r.crop.h <= H,
    `${r.crop.x + r.crop.w}/${W} ${r.crop.y + r.crop.h}/${H}`);
  check('it says what it did', r.reasons.length > 0, JSON.stringify(r.reasons));
}

console.log('\nthe status bar is ink, so the band trim walks past it');
{
  // A real screenshot: a few flat rows of padding, then the clock and the
  // battery, then the post. The flat band finds the padding and stops.
  const rows = profile(H, 6, BOTTOM);
  const args = { ...base(), rows, statusBar: { detected: true, cut: 96 } };

  const without = F.proposeCrop({ ...args, statusBar: null });
  check('without the cut the top stops at the padding above the clock',
    without.trimmed.top === 6, String(without.trimmed.top));

  const r = F.proposeCrop(args);
  check('with it the top is the status-bar cut', r.trimmed.top === 96, String(r.trimmed.top));
  check('the crop starts there', r.crop.y === 96, String(r.crop.y));
  check('and the height follows it', r.crop.h === H - 96 - BOTTOM, String(r.crop.h));
  check('and it says why', r.reasons.some((s) => s.includes('status bar')), JSON.stringify(r.reasons));

  // Only ever a floor. Someone who already cropped below their status bar has
  // a flat lead LARGER than the cut, and taking the cut puts the top of the
  // card back up into empty space.
  const already = F.proposeCrop({ ...base(), rows: profile(H, 210, BOTTOM), statusBar: { detected: true, cut: 96 } });
  check('a larger flat lead is not pulled back up to the cut',
    already.trimmed.top === 210, String(already.trimmed.top));

  const undetected = F.proposeCrop({ ...args, statusBar: { detected: false, cut: 0, reason: 'no ink' } });
  check('an undetected status bar changes nothing', undetected.trimmed.top === 6,
    String(undetected.trimmed.top));
}

console.log('\nnothing to trim is an outcome, not a zero');
{
  const blank = F.proposeCrop({ width: W, height: H, rows: new Float32Array(H), cols: new Float32Array(W) });
  check('a flat screenshot proposes the whole image', blank.crop.w === W && blank.crop.h === H,
    `${blank.crop.w}x${blank.crop.h}`);
  check('not a zero-sized one', blank.crop.w > 0 && blank.crop.h > 0);
  check('and says no ink was found', blank.reasons.some((s) => s.includes('no ink')),
    JSON.stringify(blank.reasons));

  // One axis flat is enough: a vertical gradient leaves every row flat while
  // the columns vary, and a crop taken from one axis alone is a guess.
  const oneAxis = F.proposeCrop({ width: W, height: H, rows: new Float32Array(H), cols: profile(W, LEFT, RIGHT) });
  check('one flat axis also proposes the whole image', oneAxis.crop.w === W && oneAxis.crop.h === H,
    `${oneAxis.crop.w}x${oneAxis.crop.h}`);

  const edgeToEdge = F.proposeCrop({ width: W, height: H, rows: profile(H, 0, 0), cols: profile(W, 0, 0) });
  check('a screenshot with no flat edges keeps every pixel',
    edgeToEdge.crop.w === W && edgeToEdge.crop.h === H);
  check('and still says something', edgeToEdge.reasons.length > 0, JSON.stringify(edgeToEdge.reasons));
}

console.log('\nthe floor is per axis, because one bad axis is not two');
{
  // A wide flat gutter with a full-height post: the horizontal trim is good
  // and the vertical one would leave a sliver.
  const thin = Math.floor((H - MIN_CROP / 2) / 2);
  const r = F.proposeCrop({ width: W, height: H, rows: profile(H, thin, thin), cols: profile(W, LEFT, RIGHT) });
  check('the vertical trim is dropped', r.trimmed.top === 0 && r.trimmed.bottom === 0,
    `${r.trimmed.top}/${r.trimmed.bottom}`);
  check('the height is the whole image again', r.crop.h === H, String(r.crop.h));
  check('but the horizontal trim survives', r.trimmed.left === LEFT && r.trimmed.right === RIGHT,
    `${r.trimmed.left}/${r.trimmed.right}`);
  check('so the width is still trimmed', r.crop.w === W - LEFT - RIGHT, String(r.crop.w));
  check('and it says which axis it gave up on', r.reasons.some((s) => s.includes('vertical trim')),
    JSON.stringify(r.reasons));

  const narrow = Math.floor((W - MIN_CROP / 2) / 2);
  const q = F.proposeCrop({ width: W, height: H, rows: profile(H, TOP, BOTTOM), cols: profile(W, narrow, narrow) });
  check('the same the other way round: the horizontal trim is dropped',
    q.trimmed.left === 0 && q.trimmed.right === 0, `${q.trimmed.left}/${q.trimmed.right}`);
  check('and the vertical one survives', q.trimmed.top === TOP && q.trimmed.bottom === BOTTOM,
    `${q.trimmed.top}/${q.trimmed.bottom}`);

  check('a crop exactly at the floor is kept', (() => {
    const lead = Math.floor((H - MIN_CROP) / 2);
    const k = F.proposeCrop({ width: W, height: H, rows: profile(H, lead, H - MIN_CROP - lead), cols: profile(W, LEFT, RIGHT) });
    return k.crop.h === MIN_CROP;
  })());
  check('and one a pixel under it is not', (() => {
    const lead = Math.floor((H - MIN_CROP + 1) / 2);
    const k = F.proposeCrop({ width: W, height: H, rows: profile(H, lead, H - MIN_CROP + 1 - lead), cols: profile(W, LEFT, RIGHT) });
    return k.crop.h === H;
  })());
}

console.log('\na profile that does not cover its axis is refused');
{
  // `rowInkProfile` takes a row cap. A capped profile reports the flat run at
  // the cap as the flat run at the bottom of the image, and the proposal then
  // trims out of the middle of the post and looks deliberate.
  let threwRows = false;
  try { F.proposeCrop({ ...base(), rows: profile(400, TOP, BOTTOM) }); } catch (e) { threwRows = true; }
  check('a short row profile throws', threwRows);

  let threwCols = false;
  try { F.proposeCrop({ ...base(), cols: profile(80, LEFT, RIGHT) }); } catch (e) { threwCols = true; }
  check('a short column profile throws', threwCols);

  let threwSize = false;
  try { F.proposeCrop({ width: 0, height: H, rows: new Float32Array(H), cols: new Float32Array(0) }); } catch (e) { threwSize = true; }
  check('a zero-sized image throws', threwSize);
}

console.log('\nthe asymmetric sweep: no two margins the same, no square images');
{
  // The mutants that swap an axis or mirror a band are each exactly right on
  // some shape. A sweep over shapes that share no dimension is what removes
  // the shape from the answer.
  const shapes = [
    { w: 1440, h: 3120, t: 96, b: 240, l: 0, r: 0 },
    { w: 1080, h: 2340, t: 0, b: 130, l: 24, r: 60 },
    { w: 828, h: 1792, t: 44, b: 0, l: 7, r: 0 },
    { w: 720, h: 1280, t: 31, b: 13, l: 53, r: 7 },
    { w: 2000, h: 900, t: 5, b: 200, l: 300, r: 11 },
  ];
  let bad = 0;
  for (const s of shapes) {
    const r = F.proposeCrop({
      width: s.w, height: s.h,
      rows: profile(s.h, s.t, s.b),
      cols: profile(s.w, s.l, s.r),
    });
    const want = { x: s.l, y: s.t, w: s.w - s.l - s.r, h: s.h - s.t - s.b };
    const got = r.crop;
    const same = got.x === want.x && got.y === want.y && got.w === want.w && got.h === want.h;
    if (!same) { bad++; console.log(`    ${s.w}x${s.h}: wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
  }
  check(`all ${shapes.length} shapes propose the rect their margins describe`, bad === 0, `${bad} wrong`);
  check('and the sweep ran', shapes.length === 5);
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
