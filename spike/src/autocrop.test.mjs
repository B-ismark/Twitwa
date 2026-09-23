// Tests for src/autocrop.js — the crop the editor opens on.
//
//   for b in $(grep -o "BREAK === '[a-z_0-9]*'" src/autocrop.test.mjs \
//               | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/autocrop.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. DERIVED, not typed: the list that used to sit here
// named twelve mutants and went stale the moment four were added for
// proposeFromImage. Three hand-written BREAK lists in this repo had already
// fallen behind the suites they described.
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
// For the proposeFromImage mutants at the bottom of the BREAK chain, which
// reimplement the body rather than wrapping it.
import { rowInkProfile, colInkProfile, detectStatusBar, judgeStatusBar } from './pixels.js';

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
} else if (BREAK === 'shape_ignored') {
  // The 1.0.2 bug: any detected edge taken as the status bar, so a screenshot
  // with none loses the author's avatar-and-name row.
  F.proposeCrop = (args) => real.proposeCrop({
    ...args,
    statusBar: args.statusBar && { ...args.statusBar, likely: args.statusBar.detected },
  });
} else if (BREAK === 'likely_truthy') {
  // A missing verdict read as a pass. Correct for every judged result and
  // wrong for the one caller that forgot to judge.
  F.proposeCrop = (args) => real.proposeCrop({
    ...args,
    statusBar: args.statusBar && { ...args.statusBar, likely: args.statusBar.likely ?? true },
  });
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
} else if (BREAK === 'cols_null_as_flat') {
  // No column profile treated as a flat one, which gives up on BOTH axes.
  // "Not measured" and "measured, and there was nothing" are different facts
  // and only one of them says anything about the vertical trim.
  F.proposeCrop = (args) => {
    if (args.cols) return real.proposeCrop(args);
    return real.proposeCrop({ ...args, cols: new Float32Array(args.width) });
  };
} else if (BREAK === 'budget_dead') {
  // The ceiling never applies, so a 64MP import reads 256MiB to find its
  // gutters.
  F.canProfileColumns = () => true;
} else if (BREAK === 'no_reason') {
  F.proposeCrop = (args) => ({ ...real.proposeCrop(args), reasons: [] });
} else if (BREAK === 'trim_not_subtracted') {
  // The origin moved and the size left alone, so the crop hangs off the
  // bottom-right of the image by exactly the amount that was trimmed.
  F.proposeCrop = (args) => {
    const r = real.proposeCrop(args);
    return { ...r, crop: { ...r.crop, w: args.width - r.trimmed.left, h: args.height - r.trimmed.top } };
  };
} else if (BREAK === 'reader_unchecked') {
  // No `typeof read === 'function'` guard. Forgetting the reader still
  // throws, but as `read is not a function` from the middle of the body —
  // which is the shape of the App.js crash this whole block exists for: an
  // error that names a mechanism and not the argument or the fix.
  F.proposeFromImage = (img, read, opts) => body(img, read, opts);
} else if (BREAK === 'read_null_ok') {
  // A failed read proposes the whole image instead of throwing: a confident
  // answer about an image nobody managed to look at.
  F.proposeFromImage = (img, read, opts) =>
    body(img, read, opts, {
      onNull: (width, height) => ({
        crop: { x: 0, y: 0, w: width, h: height },
        trimmed: { top: 0, bottom: 0, left: 0, right: 0, columnsProfiled: false },
        reasons: ['could not read the image; the whole screenshot is the crop'],
      }),
    });
} else if (BREAK === 'read_thrice') {
  // One read per profile instead of one for the image. Correct output, three
  // times the bandwidth — and on a 1440x3120 screenshot that is 54MiB of
  // avoidable copying on the JS thread at import.
  F.proposeFromImage = (img, read, opts) => body(img, read, opts, { readsPerProfile: true });
} else if (BREAK === 'unjudged') {
  // proposeFromImage handing the proposal a bare detectStatusBar answer with
  // the verdict faked as a pass: the path the editor actually took in 1.0.2.
  F.proposeFromImage = (img, read, opts) => body(img, read, opts, { unjudged: true });
} else if (BREAK === 'budget_whole') {
  // Over the column budget gives up on BOTH axes rather than on the one it
  // could not measure. The vertical trim was fine and is thrown away.
  F.proposeFromImage = (img, read, opts) => body(img, read, opts, { budgetIsWhole: true });
}

/**
 * proposeFromImage's body, for the four mutants above only.
 *
 * Reimplemented rather than wrapped because these mutations are INSIDE the
 * function — a wrapper around the real one cannot remove its guard, and a
 * mutant that cannot reach what it mutates reports a green about the wrong
 * code. That is not hypothetical either: the first `colour_half_checked` in
 * read.test.mjs delegated to the real reader and survived for exactly that
 * reason.
 */
function body(img, read, { step = real.PROFILE_STEP, band = real.STATUS_BAND, budget = real.MAX_PROFILE_PX } = {}, how = {}) {
  const width = img.width();
  const height = img.height();
  const whole = { x: 0, y: 0, w: width, h: height };
  const full = read(img, whole);
  if (!full) {
    if (how.onNull) return how.onNull(width, height);
    throw new Error(`autocrop: could not read the image (${width}x${height})`);
  }
  const src = () => (how.readsPerProfile ? read(img, whole) : full);
  const a = src();
  const rows = rowInkProfile(a.buf, a.rowBytes, width, height, height, step);
  const within = real.canProfileColumns(width, height, budget);
  if (how.budgetIsWhole && !within) {
    return {
      crop: whole,
      trimmed: { top: 0, bottom: 0, left: 0, right: 0, columnsProfiled: false },
      reasons: ['the image was too large to profile its columns; nothing was trimmed sideways'],
    };
  }
  const b = src();
  const cols = within ? colInkProfile(b.buf, b.rowBytes, width, height, width, step) : null;
  const c = src();
  const h = Math.min(band, height);
  const bandRows = rowInkProfile(c.buf, c.rowBytes, width, h, h, 2);
  const sb = detectStatusBar(bandRows);
  const statusBar = how.unjudged
    ? { ...sb, likely: sb.detected }
    : judgeStatusBar(sb, c.buf, c.rowBytes, width, height);
  return real.proposeCrop({ width, height, rows, cols, statusBar });
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
  const args = { ...base(), rows, statusBar: { detected: true, cut: 96, likely: true } };

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
  const already = F.proposeCrop({ ...base(), rows: profile(H, 210, BOTTOM), statusBar: { detected: true, cut: 96, likely: true } });
  check('a larger flat lead is not pulled back up to the cut',
    already.trimmed.top === 210, String(already.trimmed.top));

  const undetected = F.proposeCrop({ ...args, statusBar: { detected: false, cut: 0, reason: 'no ink' } });
  check('an undetected status bar changes nothing', undetected.trimmed.top === 6,
    String(undetected.trimmed.top));

  // THE BYLINE. On a screenshot with no status bar the first ink-then-flat
  // edge is the author's avatar-and-name row, and the detector reports it as
  // confidently as a clock. 1.0.2 took that as the floor and opened the
  // editor with the author cut off; the owner found it on a tweet.
  const header = F.proposeCrop({ ...args, statusBar: { detected: true, cut: 96, likely: false } });
  check('an edge that failed the shape test does not move the top',
    header.trimmed.top === 6, String(header.trimmed.top));
  check('so the crop starts above the byline', header.crop.y === 6, String(header.crop.y));
  check('and the height keeps it', header.crop.h === H - 6 - BOTTOM, String(header.crop.h));
  check('and it says the edge was not a status bar',
    header.reasons.some((s) => s.includes('does not look like a status bar')),
    JSON.stringify(header.reasons));

  // A bare detectStatusBar answer has no `likely` at all. That is a caller
  // that skipped the shape test, which is exactly how the bug was written, so
  // it must get no trim rather than the old one.
  const unjudged = F.proposeCrop({ ...args, statusBar: { detected: true, cut: 96 } });
  check('a result that never went through the shape test trims nothing',
    unjudged.trimmed.top === 6, String(unjudged.trimmed.top));
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

console.log('\nan unprofiled axis is not a flat one');
{
  // The whole-image read the column profile needs is bounded, and past the
  // bound the proposal has to be worse rather than absent. "Not measured" and
  // "measured, and flat" are different facts: the first says nothing about
  // the vertical trim, the second gives up on both axes.
  const r = F.proposeCrop({ ...base(), cols: null });
  check('the vertical trim still happens', r.trimmed.top === TOP && r.trimmed.bottom === BOTTOM,
    `${r.trimmed.top}/${r.trimmed.bottom}`);
  check('the height is trimmed with it', r.crop.h === H - TOP - BOTTOM, String(r.crop.h));
  check('nothing is trimmed sideways', r.trimmed.left === 0 && r.trimmed.right === 0,
    `${r.trimmed.left}/${r.trimmed.right}`);
  check('the full width is kept', r.crop.w === W && r.crop.x === 0, `${r.crop.x}+${r.crop.w}`);
  check('and it says the columns were not profiled', r.trimmed.columnsProfiled === false);
  check('with a reason a person could act on',
    r.reasons.some((s) => s.includes('too large to profile')), JSON.stringify(r.reasons));
  check('where a measured run says so too', F.proposeCrop(base()).trimmed.columnsProfiled === true);

  // A flat column profile is the OTHER outcome, and it does give up on both.
  const flatCols = F.proposeCrop({ ...base(), cols: new Float32Array(W) });
  check('a measured but flat column profile proposes the whole image',
    flatCols.crop.w === W && flatCols.crop.h === H, `${flatCols.crop.w}x${flatCols.crop.h}`);
}

console.log('\nthe whole-image read is bounded before it happens');
{
  check('an ordinary phone screenshot is profiled', F.canProfileColumns(1440, 3120) === true);
  check('a very tall thread capture still is', F.canProfileColumns(1440, 20000) === true);
  check('something past the ceiling is not',
    F.canProfileColumns(8000, 8000) === false, String(8000 * 8000));
  check('exactly at the ceiling is in', F.canProfileColumns(real.MAX_PROFILE_PX, 1) === true);
  check('one pixel past it is out', F.canProfileColumns(real.MAX_PROFILE_PX + 1, 1) === false);
  check('and the budget is an argument, not only a constant',
    F.canProfileColumns(100, 100, 9999) === false);
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

console.log('\nproposeFromImage: the whole path, from pixels to a crop');
{
  // WHY THIS BLOCK EXISTS. This arithmetic lived in App.js as `proposeFor`,
  // and on 2026-09-18 it called `readSubRect` with two of its three
  // arguments. Every import threw, the editor never opened once, and no gate
  // could have seen it, because no suite loads a React component. The
  // function moved here and takes its reader as an ARGUMENT so that the whole
  // path — read, two profiles, the status band, the proposal — runs in node.
  //
  // Asymmetric and non-square like every other fixture in this file: four
  // different margins, so top/bottom, left/right and the whole-axis swap are
  // each visible.
  const W = 400;
  const H = 900;
  const TOP = 7;
  const BOTTOM = 31;
  const LEFT = 13;
  const RIGHT = 53;

  // A flat white page with one solid black block on it. The block's edges are
  // the four margins above, so the correct proposal is known by construction
  // rather than by running the code and writing down what it said.
  function page(w = W, h = H) {
    const buf = new Uint8Array(w * h * 4).fill(255);
    for (let y = TOP; y < h - BOTTOM; y++) {
      for (let x = LEFT; x < w - RIGHT; x++) {
        const i = (y * w + x) * 4;
        buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255;
      }
    }
    return buf;
  }

  // Records what was asked for. The defect this block exists for was in the
  // CALL, so what the caller asked the reader is the thing to assert.
  function fake(w = W, h = H, opts = {}) {
    const calls = [];
    const buf = opts.buf === undefined ? page(w, h) : opts.buf;
    return {
      calls,
      width: () => w,
      height: () => h,
      read(img, box) {
        calls.push(box);
        if (opts.readFails) return null;
        return { buf, rowBytes: w * 4, width: w, height: h };
      },
    };
  }

  const f = fake();
  const got = F.proposeFromImage(f, f.read);

  check('the crop is the block, not the page',
    got.crop.x === LEFT && got.crop.y === TOP &&
    got.crop.w === W - LEFT - RIGHT && got.crop.h === H - TOP - BOTTOM,
    JSON.stringify(got.crop));
  check('all four margins are reported, and none is another one',
    got.trimmed.top === TOP && got.trimmed.bottom === BOTTOM &&
    got.trimmed.left === LEFT && got.trimmed.right === RIGHT,
    JSON.stringify(got.trimmed));
  check('the columns were profiled', got.trimmed.columnsProfiled === true);
  check('and it says what it did', got.reasons.length > 0, JSON.stringify(got.reasons));

  // The read is the expensive thing and the thing that broke. One call, for
  // the whole image — not one per profile, and not a band.
  check('the image was read exactly once', f.calls.length === 1, `${f.calls.length} reads`);
  check('and the read covered the whole image',
    f.calls[0].x === 0 && f.calls[0].y === 0 &&
    f.calls[0].w === W && f.calls[0].h === H,
    JSON.stringify(f.calls[0]));

  // The margins are all under 400, so a band shorter than the image must not
  // change the answer — this is what proves the band is a status-bar search
  // and not a second, quietly capped, row profile.
  const narrow = fake();
  const nb = F.proposeFromImage(narrow, narrow.read, { band: 100 });
  check('a smaller status band does not move the crop',
    JSON.stringify(nb.crop) === JSON.stringify(got.crop),
    `${JSON.stringify(nb.crop)} vs ${JSON.stringify(got.crop)}`);

  // Over the column budget: the vertical trim survives, the horizontal one is
  // abandoned, and the reason says so. Driven by the `budget` argument
  // because proving it with a real 30MP image means 120MiB in a unit suite.
  const big = fake();
  const over = F.proposeFromImage(big, big.read, { budget: 10 });
  check('over the column budget, the columns are not profiled',
    over.trimmed.columnsProfiled === false);
  check('and nothing is trimmed sideways',
    over.trimmed.left === 0 && over.trimmed.right === 0 &&
    over.crop.x === 0 && over.crop.w === W,
    JSON.stringify(over.crop));
  check('but the vertical trim is kept — the budget is per axis, not per proposal',
    over.crop.y === TOP && over.crop.h === H - TOP - BOTTOM, JSON.stringify(over.crop));
  check('and the reason names the budget, not a blank screenshot',
    over.reasons.some((r) => r.includes('too large to profile its columns')),
    JSON.stringify(over.reasons));

  // The two ways the caller can be wrong. Both throw, because a proposal
  // invented on top of a failed read is a confident answer about an image
  // nobody looked at.
  const missing = (() => {
    try { F.proposeFromImage(fake(), undefined); return null; } catch (e) { return e.message; }
  })();
  check('forgetting the reader throws', missing !== null, 'it did not throw');
  check('and the message names readRect, which is the thing to pass',
    !!missing && missing.includes('readRect'), String(missing));

  const failed = fake(W, H, { readFails: true });
  const nulled = (() => {
    try { F.proposeFromImage(failed, failed.read); return null; } catch (e) { return e.message; }
  })();
  check('a failed read throws rather than proposing the whole image',
    nulled !== null, 'a null read was treated as an answer');
  check('and the message carries the size, so the log says which image',
    !!nulled && nulled.includes(`${W}x${H}`), String(nulled));

  // End to end through the shape test, on two pages that differ only in what
  // sits above the gap. Both have a flat lead of TOP rows, then an inked band,
  // then a GAP-row flat gap, then the post down to BOTTOM. The detector finds
  // the same kind of edge on both; only the shape test tells them apart.
  const GAP = 12;
  function topped(bandEnd, paint) {
    const buf = new Uint8Array(W * H * 4).fill(255);
    const ink = (x, y) => {
      const i = (y * W + x) * 4;
      buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0;
    };
    for (let y = TOP; y < bandEnd; y++) for (let x = 0; x < W; x++) if (paint(x, y)) ink(x, y);
    for (let y = bandEnd + GAP; y < H - BOTTOM; y++) for (let x = LEFT; x < W - RIGHT; x++) ink(x, y);
    return buf;
  }

  // A byline: an avatar at the left and a name running into the middle, in a
  // band far taller than a status bar. The real one this stands for is
  // fixtures/screenshots/x-quote-dark.png, rows 13 to 133.
  const BYLINE_END = 110;
  const byline = topped(BYLINE_END, (x, y) =>
    (x >= 16 && x < 80) || (x >= 96 && x < 260 && y >= 30 && y < 70));
  const by = fake(W, H, { buf: byline });
  const byGot = F.proposeFromImage(by, by.read);
  check('a page with a byline and no status bar keeps the byline',
    byGot.crop.y === TOP, `crop.y ${byGot.crop.y}, byline starts at ${TOP}`);
  check('and says the edge it found was not a status bar',
    byGot.reasons.some((s) => s.includes('does not look like a status bar')),
    JSON.stringify(byGot.reasons));

  // A status bar: a clock at the left, icons at the right, empty middle, and
  // thin. The same code must still cut this one, or the fix is just "never
  // trim", which the band trim would also survive.
  const BAR_END = 30;
  const bar = topped(BAR_END, (x) => (x >= 16 && x < 60) || (x >= W - 70 && x < W - 20));
  const sb = fake(W, H, { buf: bar });
  const sbGot = F.proposeFromImage(sb, sb.read);
  check('a page with a real status bar still has it cut',
    sbGot.crop.y >= BAR_END && sbGot.crop.y <= BAR_END + GAP,
    `crop.y ${sbGot.crop.y}, bar ends at ${BAR_END}, post at ${BAR_END + GAP}`);
  check('and says it was the status bar',
    sbGot.reasons.some((s) => s.includes('the status bar is inked')),
    JSON.stringify(sbGot.reasons));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
