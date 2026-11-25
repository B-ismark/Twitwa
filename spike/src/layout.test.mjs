// Tests for src/layout.js: the numbers that keep the stage still.
//
//   for b in $(grep -o "BREAK === '[a-z_0-9]*'" src/layout.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/layout.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// None of these can be seen without a device: a caption slot one point short
// clips a line, a gutter of zero lets the back gesture eat a crop handle, and
// both look fine in a code review. So each rule has a mutant that breaks it.
import * as real from './layout.js';
import { PAD_MAX, PAD_MIN } from './shell.js';
import { PADDING, padPixels } from './sizing.js';
import { SPACE, TOUCH } from './theme.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'caption_ignores_scale') {
  F.captionHeight = () => real.captionHeight(1);
} else if (BREAK === 'caption_one_line') {
  F.captionHeight = (s) => Math.max(TOUCH, Math.ceil(real.CAPTION_LINE * (s || 1)) + SPACE.sm);
} else if (BREAK === 'caption_under_touch') {
  F.captionHeight = (s) => Math.ceil(real.CAPTION_LINES * real.CAPTION_LINE * (s || 1)) + SPACE.sm - 20;
} else if (BREAK === 'caption_shrinks') {
  F.captionHeight = (s) => Math.max(TOUCH, Math.ceil(real.CAPTION_LINES * real.CAPTION_LINE * s) + SPACE.sm);
} else if (BREAK === 'gutter_none') {
  F.cropGutter = () => 0;
} else if (BREAK === 'gutter_whole') {
  F.cropGutter = () => real.CROP_EDGE_INSET;
} else if (BREAK === 'banner_on_close') {
  F.overlayTop = () => SPACE.sm;
} else if (BREAK === 'top_pad_typed') {
  F.topPad = () => 44;
} else if (BREAK === 'bottom_pad_no_floor') {
  F.bottomPad = (i) => i + SPACE.md;
} else if (BREAK === 'bottom_pad_ignores_inset') {
  F.bottomPad = () => SPACE.sm + SPACE.md;
} else if (BREAK === 'lift_never') {
  F.liftForSheet = () => ({ scale: 1, ty: 0 });
} else if (BREAK === 'lift_always') {
  F.liftForSheet = (a) => { const r = real.liftForSheet(a); return r.ty === 0 && r.scale === 1 ? { scale: 0.9, ty: -10 } : r; };
} else if (BREAK === 'lift_no_scale') {
  F.liftForSheet = (a) => ({ ...real.liftForSheet(a), scale: 1 });
} else if (BREAK === 'lift_ty_before_scale') {
  F.liftForSheet = (a) => { const r = real.liftForSheet(a); const t = a.gap ?? SPACE.md; const room = a.stageH - a.sheetH - 2 * t; return r.scale === 1 && r.ty === 0 ? r : { scale: r.scale, ty: t + room / 2 - (a.cardTop + a.cardH / 2) }; };
} else if (BREAK === 'lift_no_floor') {
  F.liftForSheet = (a) => { const r = real.liftForSheet(a); return r.scale === real.LIFT_MIN_SCALE ? { ...r, scale: 0.01 } : r; };
} else if (BREAK === 'status_inverted') {
  F.statusBarStyle = (s) => (s === 'light' ? 'light' : 'dark');
} else if (BREAK === 'status_null_light') {
  F.statusBarStyle = (s) => (s === 'dark' ? 'light' : 'dark');
} else if (BREAK === 'step_stuck') {
  F.stepPadding = (c, d, w) => {
    const size = (PAD_MAX - PAD_MIN) / real.PAD_STEPS;
    return Math.min(PAD_MAX, Math.max(PAD_MIN, c + d * size));
  };
} else if (BREAK === 'step_wrong_way') {
  F.stepPadding = (c, d, w) => real.stepPadding(c, -d, w);
} else if (BREAK === 'step_unclamped') {
  F.stepPadding = (c, d) => c + d * ((PAD_MAX - PAD_MIN) / real.PAD_STEPS);
} else if (BREAK === 'step_next_stop') {
  F.stepPadding = (c, d) => {
    const vals = Object.values(PADDING).sort((a, b) => a - b);
    const n = d > 0 ? vals.find((v) => v > c) : [...vals].reverse().find((v) => v < c);
    return n === undefined ? c : n;
  };
} else if (BREAK === 'step_bad_dir_ok') {
  const r = real.stepPadding;
  F.stepPadding = (c, d, w) => r(c, d > 0 ? 1 : -1, w);
}

let ran = 0;
let fails = 0;
function check(name, cond) {
  ran += 1;
  if (!cond) { fails += 1; console.log(`  FAIL  ${name}`); }
}

console.log('captionHeight: a fixed slot for two lines');
{
  check('scale 1 is a touch target', F.captionHeight(1) === TOUCH);
  check('holds both lines at scale 1', F.captionHeight(1) >= real.CAPTION_LINES * real.CAPTION_LINE);
  check('grows with the font scale', F.captionHeight(2) >= 2 * real.CAPTION_LINES * real.CAPTION_LINE);
  check('exact at 2x', F.captionHeight(2) === 2 * real.CAPTION_LINES * real.CAPTION_LINE + SPACE.sm);
  check('never under a touch target', [0.85, 1, 1.15, 1.3].every((s) => F.captionHeight(s) >= TOUCH));
  check('a font scale under 1 does not shrink it', F.captionHeight(0.85) === F.captionHeight(1));
  check('default is scale 1', F.captionHeight() === F.captionHeight(1));
}

console.log('cropGutter: handles stay 24dp from the screen edge');
{
  check('gutter plus margin is the inset', F.cropGutter() + real.STAGE_MARGIN === real.CROP_EDGE_INSET);
  check('the inset clears the back gesture', real.CROP_EDGE_INSET >= 24);
  check('the gutter is not zero', F.cropGutter() > 0);
}

console.log('overlayTop: the banner clears Close');
{
  check('below Close with Close', F.overlayTop(true) >= SPACE.sm + TOUCH);
  check('exactly one gap below Close', F.overlayTop(true) === SPACE.sm + TOUCH + SPACE.sm);
  check('near the top without', F.overlayTop(false) === SPACE.sm);
}

console.log('insets: from the system, not typed');
{
  check('top is the inset plus a gap', F.topPad(24) === 24 + SPACE.sm);
  check('top follows a taller cutout', F.topPad(48) - F.topPad(24) === 24);
  check('top with no inset', F.topPad(0) === SPACE.sm);
  check('bottom follows the inset', F.bottomPad(48) - F.bottomPad(30) === 18);
  check('bottom has a floor', F.bottomPad(0) === SPACE.sm + SPACE.md);
  check('bottom never negative', F.bottomPad(-5) === F.bottomPad(0));
}

console.log('statusBarStyle: icons that can be read');
{
  check('light app, dark icons', F.statusBarStyle('light') === 'dark');
  check('dark app, light icons', F.statusBarStyle('dark') === 'light');
  check('unknown scheme is dark, as the palette is', F.statusBarStyle(null) === 'light');
}

console.log('stepPadding: TalkBack moves a tenth of the range');
{
  const W = 1080;
  const up = F.stepPadding(PAD_MIN, 1, W);
  check('up from the minimum moves up', up > PAD_MIN);
  check('up from the minimum is not a whole stop', up < PADDING.standard);
  check('down from the maximum moves down', F.stepPadding(PAD_MAX, -1, W) < PAD_MAX);
  check('up at the maximum stays', F.stepPadding(PAD_MAX, 1, W) === PAD_MAX);
  check('down at the minimum stays', F.stepPadding(PAD_MIN, -1, W) === PAD_MIN);
  let v = PAD_MIN; let n = 0;
  while (n < 40) { const nx = F.stepPadding(v, 1, W); if (nx === v) break; v = nx; n += 1; }
  check('reaches the maximum', v === PAD_MAX);
  check('in no more than ten steps', n <= real.PAD_STEPS);
  check('and at least five, so it is fine', n >= 5);
  let d = PAD_MAX; let m = 0;
  while (m < 40) { const nx = F.stepPadding(d, -1, W); if (nx === d) break; d = nx; m += 1; }
  check('reaches the minimum going down', d === PAD_MIN);
  // A narrow crop, where a small move is the same pixels as the stop it is on.
  const NARROW = 120;
  const sameCard = padPixels(NARROW, PADDING.standard) === padPixels(NARROW, PADDING.standard + 0.003);
  check('fixture: a narrow crop swallows a small move', sameCard);
  let all = true;
  for (const c of [PADDING.snug, PADDING.standard, PADDING.roomy]) {
    const u = F.stepPadding(c, 1, NARROW);
    all = all && (c === PAD_MAX ? u === c : u > c);
    const dn = F.stepPadding(c, -1, NARROW);
    all = all && (c === PAD_MIN ? dn === c : dn < c);
  }
  check('on a narrow crop a step still moves, never stuck', all);
  check('a step stays inside the range', [0.03, 0.045, 0.06, 0.1].every((c) => {
    const u = F.stepPadding(c, 1, W); const dn = F.stepPadding(c, -1, W);
    return u <= PAD_MAX && u >= PAD_MIN && dn <= PAD_MAX && dn >= PAD_MIN;
  }));
  let threw = false;
  try { F.stepPadding(0.06, 0, W); } catch (e) { threw = true; }
  check('a direction that is not 1 or -1 is refused', threw);
  let threw2 = false;
  try { F.stepPadding(0.06, 2, W); } catch (e) { threw2 = true; }
  check('and so is 2', threw2);
}

{
  // The card's box after transform: [{translateY: ty}, {scale}] about the stage's centre.
  const after = (stageH, cardTop, cardH, r) => {
    const cy = stageH / 2;
    const top = cy + (cardTop - cy) * r.scale + r.ty;
    return { top, bottom: top + cardH * r.scale };
  };
  const g = SPACE.md;
  // A tall card on a 600dp stage under a 250dp sheet.
  const a = { stageH: 600, cardTop: 20, cardH: 560, sheetH: 250 };
  const r = F.liftForSheet(a);
  const box = after(600, 20, 560, r);
  check('lift: the card ends above the sheet', box.bottom <= 600 - 250 - g + 1e-6);
  check('lift: and below the stage top', box.top >= g - 1e-6);
  check('lift: it fills the room, not a corner of it', Math.abs((box.top + box.bottom) / 2 - (g + (600 - 250 - 2 * g) / 2)) < 1e-6);
  check('lift: it shrinks to fit', r.scale < 1 && Math.abs(r.scale - (600 - 250 - 2 * g) / 560) < 1e-9);
  // A short, wide card that already clears the sheet does not move.
  const still = F.liftForSheet({ stageH: 600, cardTop: 40, cardH: 200, sheetH: 250 });
  check('lift: a card already clear of the sheet stays put', still.scale === 1 && still.ty === 0);
  // A card that only overlaps a little moves up without shrinking.
  const nudge = F.liftForSheet({ stageH: 600, cardTop: 150, cardH: 300, sheetH: 250 });
  const nb = after(600, 150, 300, nudge);
  check('lift: a card that fits the room keeps its size', nudge.scale === 1 && nb.bottom <= 600 - 250 - g + 1e-6);
  check('lift: no sheet, no lift', ['0', 'NaN'].every((k) => { const q = F.liftForSheet({ ...a, sheetH: Number(k) }); return q.scale === 1 && q.ty === 0; }));
  // Off-centre card: the scale is about the STAGE's centre, so the order matters.
  const off = F.liftForSheet({ stageH: 600, cardTop: 0, cardH: 500, sheetH: 250 });
  const ob = after(600, 0, 500, off);
  check('lift: an off-centre card still lands centred in the room', Math.abs((ob.top + ob.bottom) / 2 - (g + (600 - 250 - 2 * g) / 2)) < 1e-6);
  const huge = F.liftForSheet({ stageH: 300, cardTop: 0, cardH: 300, sheetH: 290 });
  check('lift: a sheet taller than the stage leaves a legible card, not a speck', huge.scale === real.LIFT_MIN_SCALE);
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
