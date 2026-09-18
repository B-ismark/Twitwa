// Phase 2's gesture arithmetic: where the crop rect goes when a finger moves.
// No react-native-gesture-handler, no reanimated, no Skia — the geometry is
// separated from the gesture so it can be tested on a desktop, because the one
// thing that cannot be tested on a desktop is whether it feels right, and that
// is not the part that has the bugs.
//
// EVERY RECT IN THIS FILE IS IN IMAGE PIXELS. That is the standing constraint
// from the density work, and it is not a style preference: a rect drawn in a
// viewport is only meaningful alongside the viewport it was drawn in, and the
// viewport changes with the screen, the display-zoom setting and the device.
// A crop stored in viewport units renders a different card on the next phone.
// So the conversion happens at the gesture boundary — `toImageDelta` on the
// way in — and nothing downstream of that ever sees a screen unit.
//
// The projection is CONTAIN, not cover: the whole screenshot must be visible
// while it is being cropped. `fitView` is the only place that decides it.
//
// WHY DELTAS ARE MEASURED FROM THE GESTURE START, not from the previous frame.
// `dragCrop` takes the TOTAL movement since the finger went down and applies it
// to the rect as it was at that moment. Applying per-frame deltas to the
// current rect looks equivalent and is not: every frame rounds to whole pixels,
// and sixty roundings a second accumulate into visible drift, while a frame
// that arrives out of order or is dropped under load moves the rect by the
// wrong amount permanently. Total-from-start is idempotent — replaying the same
// gesture gives the same rect — and a dropped frame costs nothing.

/** The nine things a finger can grab. Eight edges and corners, plus the body. */
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'move'];

/**
 * The smallest crop, in IMAGE pixels, on either axis.
 *
 * In image pixels rather than screen pixels because it is a statement about the
 * card that comes out, not about the finger that drew it: sizing.js never
 * upscales, so a 120px crop is a 120px-wide card however large it looked while
 * being dragged. A screen-space minimum would mean the same gesture produced a
 * different floor on a different density, which is the bug this whole module is
 * arranged to avoid.
 */
export const MIN_CROP = 120;

/** Handle hit target, in screen points. 44 is the platform floor for a touch. */
export const TOUCH = 44;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The contain-fit projection from image pixels to the viewport.
 *
 * @returns {{scale: number, offsetX: number, offsetY: number}}
 */
export function fitView({ imageW, imageH, viewW, viewH }) {
  if (!(imageW > 0 && imageH > 0 && viewW > 0 && viewH > 0)) {
    throw new Error(`bad fit: ${imageW}x${imageH} into ${viewW}x${viewH}`);
  }
  // min, not max. max is cover, which crops the screenshot before the user has
  // cropped anything and hides the very edges they are most likely to trim.
  const scale = Math.min(viewW / imageW, viewH / imageH);
  return {
    scale,
    offsetX: (viewW - imageW * scale) / 2,
    offsetY: (viewH - imageH * scale) / 2,
  };
}

/** A touch position in the viewport, as a position in the image. */
export function toImagePoint(view, point) {
  return { x: (point.x - view.offsetX) / view.scale, y: (point.y - view.offsetY) / view.scale };
}

/**
 * A movement in the viewport, as a movement in the image.
 *
 * The offset is deliberately NOT subtracted here, and that is the whole reason
 * this is a separate function from `toImagePoint`. A delta is a difference
 * between two points, so the offset has already cancelled; subtracting it again
 * displaces every drag by the letterbox margin divided by the scale. On a
 * 1440x3120 capture in a short viewport that is hundreds of pixels, and it
 * presents as "the crop jumps when I touch it" rather than as an arithmetic
 * error.
 */
export function toImageDelta(view, delta) {
  return { dx: delta.dx / view.scale, dy: delta.dy / view.scale };
}

/** An image-space rect, as a viewport rect. For drawing and for hit testing. */
export function toViewportRect(view, rect) {
  return {
    x: view.offsetX + rect.x * view.scale,
    y: view.offsetY + rect.y * view.scale,
    w: rect.w * view.scale,
    h: rect.h * view.scale,
  };
}

// The floor actually enforceable inside these bounds. An image narrower than
// MIN_CROP cannot host a MIN_CROP-wide rect, and clamping to an unreachable
// minimum produces a range whose low end is above its high end — which, with a
// naive clamp, silently returns the low end and puts the rect outside the
// image.
function minFor(bounds, min) {
  return { w: Math.min(min, bounds.w), h: Math.min(min, bounds.h) };
}

/**
 * Put a rect inside the bounds, at whole pixels, no smaller than the minimum.
 *
 * Size is settled before position, because the reverse order cannot work: a
 * rect pushed inside the bounds and then grown to the minimum can grow straight
 * back out again.
 *
 * Growing anchors the left/top edge. That only ever applies to a degenerate
 * input — a real gesture never produces one, since `dragCrop` enforces the
 * minimum on every frame — so it is not worth centring and pretending the
 * choice is meaningful.
 */
export function normalizeCrop(bounds, box, min = MIN_CROP) {
  const m = minFor(bounds, min);
  const w = clamp(Math.round(box.w), m.w, bounds.w);
  const h = clamp(Math.round(box.h), m.h, bounds.h);
  return {
    x: clamp(Math.round(box.x), bounds.x, bounds.x + bounds.w - w),
    y: clamp(Math.round(box.y), bounds.y, bounds.y + bounds.h - h),
    w,
    h,
  };
}

/**
 * Where the crop lands, given a handle and how far the finger has travelled.
 *
 * @param start  the crop as it was when the finger went DOWN, image px
 * @param handle one of HANDLES
 * @param dx,dy  total travel since the finger went down, IMAGE px
 * @param bounds the image, `{x:0, y:0, w, h}`
 *
 * It clamps and never throws for a gesture that goes too far, because the plan
 * says clamp the gesture rather than error: a finger dragged off the edge of
 * the screen is not a fault condition. (An unknown handle IS a caller bug and
 * does throw.)
 *
 * THE TWO CLAMPS ARE DIFFERENT, and conflating them is the classic defect here:
 *
 *   - A MOVE clamps position only. Clamping its width as well makes the crop
 *     shrink as it is shoved against the edge of the image, so a user dragging
 *     a card to the left loses columns off its right and never sees why.
 *   - A RESIZE clamps the edge being dragged, against the OPPOSITE edge, which
 *     does not move. Writing it as `w = max(min, w - dx)` after `x += dx` moves
 *     both edges, so the rect walks across the image once the minimum is
 *     reached instead of stopping.
 *
 * Hence edges, not x/y/w/h. At most one vertical and one horizontal edge moves
 * for any handle, so each clamp can safely read its opposite.
 */
export function dragCrop({ start, handle, dx = 0, dy = 0, bounds, min = MIN_CROP }) {
  if (!HANDLES.includes(handle)) throw new Error(`unknown handle: ${handle}`);
  const s = normalizeCrop(bounds, start, min);
  const m = minFor(bounds, min);
  // Rounded once, here, rather than at the end. Integer deltas on an integer
  // rect keep every edge integral, so no later rounding can shave a pixel off
  // the minimum or off the bounds.
  const ddx = Math.round(dx);
  const ddy = Math.round(dy);
  const bx = bounds.x;
  const by = bounds.y;
  const bR = bounds.x + bounds.w;
  const bB = bounds.y + bounds.h;

  if (handle === 'move') {
    return {
      x: clamp(s.x + ddx, bx, bR - s.w),
      y: clamp(s.y + ddy, by, bB - s.h),
      w: s.w,
      h: s.h,
    };
  }

  let l = s.x;
  let t = s.y;
  let r = s.x + s.w;
  let b = s.y + s.h;
  // Substring tests are exact here: 'move' has already returned, and no other
  // handle name contains a compass letter it does not mean.
  if (handle.includes('w')) l = clamp(l + ddx, bx, r - m.w);
  if (handle.includes('e')) r = clamp(r + ddx, l + m.w, bR);
  if (handle.includes('n')) t = clamp(t + ddy, by, b - m.h);
  if (handle.includes('s')) b = clamp(b + ddy, t + m.h, bB);
  return { x: l, y: t, w: r - l, h: b - t };
}

/**
 * Which handle a touch grabs, or null for a touch outside the crop.
 *
 * In VIEWPORT space, because a touch target is a statement about fingers: 44
 * points is 44 points whatever the image behind it is, and expressing it in
 * image pixels would make the handles harder to hit on a larger screenshot.
 * This is the one place in the module that is deliberately not image space.
 *
 * A corner beats an edge, and what makes that true is the corner-sized gap cut
 * out of each edge span below — NOT the order the two are tested in. Written
 * the obvious way, with each edge span running the full side, the edge nearest
 * the top of the function silently swallows both corners on that side, and the
 * user cannot resize two axes at once anywhere. `BREAK=edge_steals_corner`
 * is that version.
 */
export function pickHandle(point, crop, view, { touch = TOUCH } = {}) {
  const v = toViewportRect(view, crop);
  const half = touch / 2;
  const near = (a, bv) => Math.abs(a - bv) <= half;
  const left = v.x;
  const right = v.x + v.w;
  const top = v.y;
  const bottom = v.y + v.h;

  for (const [vName, vy] of [['n', top], ['s', bottom]]) {
    for (const [hName, hx] of [['w', left], ['e', right]]) {
      if (near(point.x, hx) && near(point.y, vy)) return vName + hName;
    }
  }
  // The corner zones are excluded from the edge spans, so a crop smaller than
  // one touch target in a dimension is all corner. That is the right answer:
  // there is no room for an edge grab, and offering one would mean two handles
  // sharing every pixel.
  const inX = point.x >= left + half && point.x <= right - half;
  const inY = point.y >= top + half && point.y <= bottom - half;
  if (inX && near(point.y, top)) return 'n';
  if (inX && near(point.y, bottom)) return 's';
  if (inY && near(point.x, left)) return 'w';
  if (inY && near(point.x, right)) return 'e';
  if (point.x >= left && point.x <= right && point.y >= top && point.y <= bottom) return 'move';
  return null;
}
