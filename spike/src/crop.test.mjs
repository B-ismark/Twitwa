// Tests for src/crop.js — Phase 2's gesture arithmetic.
//
//   for b in fit_cover delta_offset no_scale min_ignored move_shrinks \
//            resize_translates clamp_fields edge_steals_corner no_round; do
//     BREAK=$b node src/crop.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// `clamp_fields` is the one that matters, because it is the same defect
// `clampCrop` in plan.js already carries a header about: clamping x while
// leaving w alone moves the far edge too, so the rect grows by exactly the
// amount that hung off. There it was found by a reviewer after a test failed
// to distinguish it; here it is a mutation from the start.
//
// `min_ignored` and `move_shrinks` are both killed by the property sweep at the
// end as well as by a named case. That is deliberate: the sweep says the
// invariant holds across 441 constructed gestures, and the named case says
// which one broke and by how much. Neither alone is enough — a sweep that fails
// tells you nothing about where.
import * as real from './crop.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };
const cl = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

if (BREAK === 'fit_cover') {
  // Cover instead of contain: the screenshot is cropped before the user has
  // cropped anything.
  F.fitView = ({ imageW, imageH, viewW, viewH }) => {
    const scale = Math.max(viewW / imageW, viewH / imageH);
    return { scale, offsetX: (viewW - imageW * scale) / 2, offsetY: (viewH - imageH * scale) / 2 };
  };
} else if (BREAK === 'delta_offset') {
  // Treat a movement like a position and subtract the letterbox offset again.
  F.toImageDelta = (v, d) => ({ dx: (d.dx - v.offsetX) / v.scale, dy: (d.dy - v.offsetY) / v.scale });
} else if (BREAK === 'no_scale') {
  // Forget the projection entirely: screen points used as image pixels.
  F.toImageDelta = (v, d) => ({ dx: d.dx, dy: d.dy });
} else if (BREAK === 'min_ignored') {
  F.dragCrop = (a) => real.dragCrop({ ...a, min: 0 });
} else if (BREAK === 'move_shrinks') {
  // A move that clamps size as well as position, so the crop is eaten by the
  // edge of the image instead of stopping against it.
  F.dragCrop = (a) => {
    if (a.handle !== 'move') return real.dragCrop(a);
    const s = real.normalizeCrop(a.bounds, a.start, a.min);
    const bR = a.bounds.x + a.bounds.w;
    const bB = a.bounds.y + a.bounds.h;
    const x = cl(s.x + Math.round(a.dx || 0), a.bounds.x, bR);
    const y = cl(s.y + Math.round(a.dy || 0), a.bounds.y, bB);
    return { x, y, w: Math.min(s.w, bR - x), h: Math.min(s.h, bB - y) };
  };
} else if (BREAK === 'resize_translates') {
  // Dragging the top edge moves the bottom one with it: a resize that is
  // secretly a move.
  F.dragCrop = (a) => {
    if (a.handle !== 'n') return real.dragCrop(a);
    const s = real.normalizeCrop(a.bounds, a.start, a.min);
    const bB = a.bounds.y + a.bounds.h;
    return { x: s.x, y: cl(s.y + Math.round(a.dy || 0), a.bounds.y, bB - s.h), w: s.w, h: s.h };
  };
} else if (BREAK === 'clamp_fields') {
  // Clamp x, keep w. plan.js's clampCrop header, one file over.
  F.dragCrop = (a) => {
    if (a.handle !== 'w') return real.dragCrop(a);
    const s = real.normalizeCrop(a.bounds, a.start, a.min);
    return {
      x: cl(s.x + Math.round(a.dx || 0), a.bounds.x, a.bounds.x + a.bounds.w - s.w),
      y: s.y,
      w: s.w,
      h: s.h,
    };
  };
} else if (BREAK === 'edge_steals_corner') {
  // Edge spans run the full side and are tested first, so the edge swallows
  // both corners and no corner can ever be grabbed.
  F.pickHandle = (point, crop, view, { touch = real.TOUCH } = {}) => {
    const v = real.toViewportRect(view, crop);
    const half = touch / 2;
    const near = (a, b) => Math.abs(a - b) <= half;
    const l = v.x;
    const r = v.x + v.w;
    const t = v.y;
    const b = v.y + v.h;
    const inX = point.x >= l && point.x <= r;
    const inY = point.y >= t && point.y <= b;
    if (inX && near(point.y, t)) return 'n';
    if (inX && near(point.y, b)) return 's';
    if (inY && near(point.x, l)) return 'w';
    if (inY && near(point.x, r)) return 'e';
    if (inX && inY) return 'move';
    return null;
  };
} else if (BREAK === 'no_round') {
  // Fractional deltas reach the rect, so the crop sits on half pixels.
  F.dragCrop = (a) => {
    if (a.handle !== 'move') return real.dragCrop(a);
    const s = real.normalizeCrop(a.bounds, a.start, a.min);
    return {
      x: cl(s.x + (a.dx || 0), a.bounds.x, a.bounds.x + a.bounds.w - s.w),
      y: cl(s.y + (a.dy || 0), a.bounds.y, a.bounds.y + a.bounds.h - s.h),
      w: s.w,
      h: s.h,
    };
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
const j = JSON.stringify;
const isRect = (r, x, y, w, h) => r.x === x && r.y === y && r.w === w && r.h === h;

const B = { x: 0, y: 0, w: 1440, h: 3120 };   // the Pixel 6 Pro's real capture size
const S = { x: 200, y: 400, w: 600, h: 900 }; // l=200 t=400 r=800 b=1300
const drag = (handle, dx, dy, start = S, bounds = B) =>
  F.dragCrop({ start, handle, dx, dy, bounds });

console.log('fitView contains the image rather than covering it');
{
  // Deliberately both orientations. A cover/contain mix-up is invisible
  // whenever the image and the viewport have the same aspect, and this module
  // exists to serve 1440x3120 screenshots in landscape-ish viewports.
  const tall = F.fitView({ imageW: 1440, imageH: 3120, viewW: 1080, viewH: 1920 });
  check('a tall image in a squatter viewport is limited by its height',
    tall.scale === 1920 / 3120, String(tall.scale));
  check('so it touches top and bottom', tall.offsetY === 0, String(tall.offsetY));
  check('and is letterboxed left and right', tall.offsetX > 0, String(tall.offsetX));

  const wide = F.fitView({ imageW: 3120, imageH: 1440, viewW: 1080, viewH: 1920 });
  check('a wide image in a taller viewport is limited by its width',
    wide.scale === 1080 / 3120, String(wide.scale));
  check('so it touches left and right', wide.offsetX === 0, String(wide.offsetX));
  check('and is letterboxed top and bottom', wide.offsetY > 0, String(wide.offsetY));

  let threw = null;
  try { F.fitView({ imageW: 0, imageH: 100, viewW: 10, viewH: 10 }); } catch (e) { threw = e; }
  check('a zero-sized image throws rather than dividing by zero', threw !== null, String(threw));
}

console.log('a point converts differently from a movement');
{
  const V1 = F.fitView({ imageW: 1000, imageH: 1000, viewW: 800, viewH: 400 }); // offsetX 200
  const V2 = F.fitView({ imageW: 1000, imageH: 1000, viewW: 400, viewH: 800 }); // offsetY 200
  check('the horizontal fixture really is offset', V1.offsetX === 200 && V1.scale === 0.4, j(V1));
  check('the vertical fixture really is offset', V2.offsetY === 200 && V2.scale === 0.4, j(V2));

  const p = F.toImagePoint(V1, { x: 240, y: 40 });
  check('a point has the offset taken off it', p.x === 100 && p.y === 100, j(p));

  const d1 = F.toImageDelta(V1, { dx: 40, dy: 40 });
  check('a movement does not, horizontally', d1.dx === 100 && d1.dy === 100, j(d1));
  const d2 = F.toImageDelta(V2, { dx: 40, dy: 40 });
  check('a movement does not, vertically', d2.dx === 100 && d2.dy === 100, j(d2));

  // The discriminating case: a zero movement is zero wherever the image sits,
  // while the point at the origin of the viewport is well outside the image.
  const zero = F.toImageDelta(V1, { dx: 0, dy: 0 });
  check('a movement of nothing is a movement of nothing', zero.dx === 0 && zero.dy === 0, j(zero));
  const origin = F.toImagePoint(V1, { x: 0, y: 0 });
  check('while the viewport origin is off the left of the image', origin.x === -500, j(origin));

  const vr = F.toViewportRect(V1, { x: 100, y: 100, w: 200, h: 200 });
  check('a rect projects into the viewport', isRect(vr, 240, 40, 80, 80), j(vr));
  const back = F.toImagePoint(V1, { x: vr.x, y: vr.y });
  check('and its origin projects back', back.x === 100 && back.y === 100, j(back));
}

console.log('normalizeCrop settles size, then position, at whole pixels');
{
  const r = F.normalizeCrop(B, { x: 10.4, y: 20.6, w: 600.5, h: 900.4 });
  check('fractions are rounded away', isRect(r, 10, 21, 601, 900), j(r));
  const big = F.normalizeCrop(B, { x: -50, y: -50, w: 9999, h: 9999 });
  check('an oversized rect becomes the whole image', isRect(big, 0, 0, 1440, 3120), j(big));
  const small = F.normalizeCrop(B, { x: 0, y: 0, w: 10, h: 10 });
  check('an undersized rect grows to the minimum',
    isRect(small, 0, 0, real.MIN_CROP, real.MIN_CROP), j(small));
  const out = F.normalizeCrop(B, { x: 1400, y: 0, w: 200, h: 200 });
  check('a rect hanging off the right is pushed in, not shrunk',
    isRect(out, 1240, 0, 200, 200), j(out));
  // An image smaller than the minimum cannot host a minimum-sized crop, and the
  // clamp range inverts if that is not handled.
  const tiny = F.normalizeCrop({ x: 0, y: 0, w: 80, h: 80 }, { x: 0, y: 0, w: 10, h: 10 });
  check('an image smaller than the minimum gets all of itself',
    isRect(tiny, 0, 0, 80, 80), j(tiny));
}

console.log('a move translates and never resizes');
{
  check('it follows the finger', isRect(drag('move', 50, -100), 250, 300, 600, 900),
    j(drag('move', 50, -100)));
  const left = drag('move', -1000, 0);
  check('it stops at the left edge', left.x === 0, j(left));
  check('and keeps its width there', left.w === 600 && left.h === 900, j(left));
  const right = drag('move', 5000, 0);
  check('it stops at the right edge', right.x === 1440 - 600, j(right));
  check('and keeps its width there', right.w === 600, j(right));
  const down = drag('move', 0, 5000);
  check('it stops at the bottom edge', down.y === 3120 - 900, j(down));
  check('and keeps its height there', down.h === 900, j(down));
  const frac = drag('move', 0.6, 0.4);
  check('a fractional drag lands on a whole pixel', isRect(frac, 201, 400, 600, 900), j(frac));
}

console.log('each handle moves its own edge, in the right direction');
{
  // Every one of these is a sign test, and a sign error is invisible unless
  // both ends are checked: dragging DOWN shrinks from the top and grows from
  // the bottom.
  check('n down shrinks from the top', isRect(drag('n', 0, 100), 200, 500, 600, 800), j(drag('n', 0, 100)));
  check('s down grows at the bottom', isRect(drag('s', 0, 100), 200, 400, 600, 1000), j(drag('s', 0, 100)));
  check('w right shrinks from the left', isRect(drag('w', 100, 0), 300, 400, 500, 900), j(drag('w', 100, 0)));
  check('e right grows at the right', isRect(drag('e', 100, 0), 200, 400, 700, 900), j(drag('e', 100, 0)));
  check('n up grows at the top', isRect(drag('n', 0, -100), 200, 300, 600, 1000), j(drag('n', 0, -100)));
  check('s up shrinks from the bottom', isRect(drag('s', 0, -100), 200, 400, 600, 800), j(drag('s', 0, -100)));
  check('w left grows at the left', isRect(drag('w', -100, 0), 100, 400, 700, 900), j(drag('w', -100, 0)));
  check('e left shrinks from the right', isRect(drag('e', -100, 0), 200, 400, 500, 900), j(drag('e', -100, 0)));

  check('nw moves both near edges', isRect(drag('nw', 100, 100), 300, 500, 500, 800), j(drag('nw', 100, 100)));
  check('ne moves the right and the top', isRect(drag('ne', 100, 100), 200, 500, 700, 800), j(drag('ne', 100, 100)));
  check('sw moves the left and the bottom', isRect(drag('sw', 100, 100), 300, 400, 500, 1000), j(drag('sw', 100, 100)));
  check('se moves both far edges', isRect(drag('se', 100, 100), 200, 400, 700, 1000), j(drag('se', 100, 100)));

  // A single-axis handle must not touch the other axis at all.
  check('n leaves x and w alone', drag('n', 999, 100).x === 200 && drag('n', 999, 100).w === 600,
    j(drag('n', 999, 100)));
  check('e leaves y and h alone', drag('e', 100, 999).y === 400 && drag('e', 100, 999).h === 900,
    j(drag('e', 100, 999)));
}

console.log('a resize stops at the minimum without dragging the opposite edge');
{
  const n = drag('n', 0, 5000);
  check('the top cannot pass the minimum', n.h === real.MIN_CROP, j(n));
  check('and the bottom has not moved', n.y + n.h === 1300, j(n));
  const s = drag('s', 0, -5000);
  check('the bottom cannot pass the minimum', s.h === real.MIN_CROP, j(s));
  check('and the top has not moved', s.y === 400, j(s));
  const w = drag('w', 5000, 0);
  check('the left cannot pass the minimum', w.w === real.MIN_CROP, j(w));
  check('and the right has not moved', w.x + w.w === 800, j(w));
  const e = drag('e', -5000, 0);
  check('the right cannot pass the minimum', e.w === real.MIN_CROP, j(e));
  check('and the left has not moved', e.x === 200, j(e));
}

console.log('a resize stops at the image, and grows the rect when it does');
{
  const w = drag('w', -5000, 0);
  check('the left edge stops at 0', w.x === 0, j(w));
  check('and the rect GREW to meet it — the far edge did not follow',
    w.w === 800 && w.x + w.w === 800, j(w));
  const e = drag('e', 5000, 0);
  check('the right edge stops at the image width', e.x + e.w === 1440, j(e));
  check('and the left is where it was', e.x === 200, j(e));
  const n = drag('n', 0, -5000);
  check('the top edge stops at 0', n.y === 0 && n.h === 1300, j(n));
  const s = drag('s', 0, 5000);
  check('the bottom edge stops at the image height', s.y + s.h === 3120, j(s));
}

console.log('dragCrop refuses a handle it does not know');
{
  let threw = null;
  try { F.dragCrop({ start: S, handle: 'nn', dx: 0, dy: 0, bounds: B }); } catch (e) { threw = e; }
  check('an unknown handle throws', threw !== null, String(threw));
  check('and names it', /nn/.test(threw ? threw.message : ''), threw && threw.message);
}

console.log('pickHandle: corners beat edges, and outside is null');
{
  const V = F.fitView({ imageW: 400, imageH: 400, viewW: 400, viewH: 400 });
  const C = { x: 100, y: 100, w: 200, h: 200 };
  const at = (x, y) => F.pickHandle({ x, y }, C, V);
  check('the fixture projects one to one', V.scale === 1 && V.offsetX === 0, j(V));

  check('top left is nw', at(100, 100) === 'nw', at(100, 100));
  check('top right is ne', at(300, 100) === 'ne', at(300, 100));
  check('bottom left is sw', at(100, 300) === 'sw', at(100, 300));
  check('bottom right is se', at(300, 300) === 'se', at(300, 300));
  check('the middle of the top edge is n', at(200, 100) === 'n', at(200, 100));
  check('the middle of the bottom edge is s', at(200, 300) === 's', at(200, 300));
  check('the middle of the left edge is w', at(100, 200) === 'w', at(100, 200));
  check('the middle of the right edge is e', at(300, 200) === 'e', at(300, 200));
  check('the body is a move', at(200, 200) === 'move', at(200, 200));
  check('well outside is nothing', at(50, 50) === null, at(50, 50));

  // The discriminating case for the whole design: a touch 10 points along the
  // top edge from the corner is inside BOTH targets. It must resize two axes.
  check('a touch just inside the corner still grabs the corner',
    at(110, 100) === 'nw', at(110, 100));
  check('the same distance from the other corner, likewise',
    at(290, 300) === 'se', at(290, 300));

  // The handle reaches outside the rect, on purpose: the edge is easier to grab
  // from the outside, where there is nothing else to hit.
  check('an edge can be grabbed from just outside it', at(320, 200) === 'e', at(320, 200));
  check('but not from beyond the touch target', at(330, 200) === null, at(330, 200));
}

console.log('every gesture, from every handle, lands somewhere legal');
{
  // A constructed population, so it is counted rather than trusted: nine
  // handles by seven horizontal deltas by seven vertical ones. The deltas
  // straddle each boundary this module has — a pixel, a hundred, and further
  // than the image is wide in both directions.
  const deltas = [-5000, -100, -1, 0, 1, 100, 5000];
  let cases = 0;
  let outside = 0;
  let tooSmall = 0;
  let fractional = 0;
  for (const handle of real.HANDLES) {
    for (const dx of deltas) {
      for (const dy of deltas) {
        cases++;
        const r = F.dragCrop({ start: S, handle, dx, dy, bounds: B });
        if (r.x < B.x || r.y < B.y || r.x + r.w > B.x + B.w || r.y + r.h > B.y + B.h) outside++;
        if (r.w < real.MIN_CROP || r.h < real.MIN_CROP) tooSmall++;
        if (!Number.isInteger(r.x) || !Number.isInteger(r.y)
          || !Number.isInteger(r.w) || !Number.isInteger(r.h)) fractional++;
      }
    }
  }
  check('the sweep ran the population it claims', cases === 9 * 7 * 7, String(cases));
  check(`none of the ${cases} left the image`, outside === 0, String(outside));
  check(`none of the ${cases} went under the minimum`, tooSmall === 0, String(tooSmall));
  check(`none of the ${cases} landed on a fractional pixel`, fractional === 0, String(fractional));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
