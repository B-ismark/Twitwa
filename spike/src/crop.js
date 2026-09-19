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
//
// WHY EVERY FUNCTION HERE OPENS WITH `'worklet';`.
// The owner used the build on 2026-09-18 and said the drag was not as smooth as
// expected. It was not: the gesture ran with `.runOnJS(true)` and committed the
// rect through `setState` on every frame, so each finger movement crossed to the
// JS thread, re-rendered the whole app and recomposed a Skia canvas that was at
// opacity 0 at the time. This module is where that is paid for, because the
// arithmetic the drag needs lives here, and a UI-thread caller can only call a
// UI-thread function.
//
// The directive costs this file NOTHING. It is a string-literal statement, so
// node ignores it and every check below still runs unchanged on the desktop;
// Reanimated's babel plugin reads it and makes the function callable from the
// UI thread. That is the entire reason the geometry was separated from the
// gesture in the first place — it just took a device to show why it mattered.
//
// The consequence to remember: a worklet may only call other worklets. `clamp`
// and `minFor` are private and still carry the directive, because `dragCrop`
// calls them and a missing one fails at run time on the phone with a message
// about a function not being a worklet, which no desktop check can see. The
// guard for that is in crop.test.mjs — `BREAK=not_worklet`.
//
// AND NO DEFAULT PARAMETER MAY NAME A MODULE CONSTANT. `min = MIN_CROP` and
// `{ touch = TOUCH }` read perfectly and both were here; on the phone the
// first finger-down threw `Property 'TOUCH' doesn't exist` from inside
// `pickHandle`. The babel plugin builds a worklet's closure from the free
// identifiers it finds in the BODY, and a default sits in the parameter list,
// so the constant is never copied across the thread boundary. Node fills the
// same default from module scope without complaint, so every desktop check
// stayed green — and so did a `dumpsys gfxinfo` run over eight drags, which
// reported 0.52% jank for a gesture that was throwing on every touch. That is
// the constructed-measurement failure in its purest form: the instrument was
// fine, the population was empty. Defaults are resolved in the body instead,
// and `BREAK=default_captures` is the guard.

import { TOUCH } from './theme.js';

/** The nine things a finger can grab. Eight edges and corners, plus the body. */
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'move'];

/**
 * Where each handle sits on the rect, as a fraction of it.
 *
 * A TABLE RATHER THAN STRING TESTS, and the reason is one character. The
 * obvious implementation is `handle.includes('e')` for the east edge -- and
 * `'move'.includes('e')` is TRUE. Anything written that way puts the body
 * handle on the right edge unless an early return happens to catch it first,
 * which is a correctness bug hiding behind the order of two lines. The table
 * cannot express that mistake. `handles_by_substring` is it.
 */
const HANDLE_AT = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0],
  w: [0, 0.5], e: [1, 0.5],
  sw: [0, 1], s: [0.5, 1], se: [1, 1],
};

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

/**
 * Handle hit target, in screen points, re-exported from the theme so this
 * module's public surface is unchanged and there is still exactly one number.
 * See src/theme.js for why it is 48 and why it does not live here.
 */
export { TOUCH };

const clamp = (v, lo, hi) => {
  'worklet';
  return v < lo ? lo : v > hi ? hi : v;
};

/**
 * The contain-fit projection from image pixels to the viewport.
 *
 * @returns {{scale: number, offsetX: number, offsetY: number}}
 */
export function fitView({ imageW, imageH, viewW, viewH }) {
  'worklet';
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
  'worklet';
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
  'worklet';
  return { dx: delta.dx / view.scale, dy: delta.dy / view.scale };
}

/** An image-space rect, as a viewport rect. For drawing and for hit testing. */
export function toViewportRect(view, rect) {
  'worklet';
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
  'worklet';
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
export function normalizeCrop(bounds, box, min) {
  'worklet';
  const m = minFor(bounds, min === undefined ? MIN_CROP : min);
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
export function dragCrop({ start, handle, dx = 0, dy = 0, bounds, min }) {
  'worklet';
  if (!HANDLES.includes(handle)) throw new Error(`unknown handle: ${handle}`);
  const floor = min === undefined ? MIN_CROP : min;
  const s = normalizeCrop(bounds, start, floor);
  const m = minFor(bounds, floor);
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
/**
 * The point a resize handle is actually holding, in IMAGE pixels.
 *
 * This is what the loupe magnifies: the finger covers the pixel being aligned,
 * so something has to say which pixel that was. `null` for `move`, because a
 * translation has no point to align -- the whole rect is the thing being
 * moved, and a magnifier over its middle would show the picture at 1:1 with
 * nothing to line it up against.
 *
 * In image pixels like everything else in this module. The loupe converts on
 * the way out, once, with the same `view` the gesture used.
 */
export function handlePoint(handle, crop) {
  'worklet';
  if (!HANDLES.includes(handle)) throw new Error(`unknown handle: ${handle}`);
  const at = HANDLE_AT[handle];
  if (!at) return null;
  return { x: crop.x + crop.w * at[0], y: crop.y + crop.h * at[1] };
}

/**
 * How much the loupe has to magnify to make one image pixel legible.
 *
 * DERIVED, not a picked factor, and that is the whole point of the control.
 * `fitView` contains a screenshot in the stage, so on a 1080-wide capture in a
 * roughly 400pt stage one screen point is about six image pixels -- which is
 * why trimming a status bar by eye is not something a person can do, and why
 * the survey found a loupe in every app that expects precision. A fixed 2x or
 * 3x would be right for one screenshot width and wrong for the next.
 *
 * So the loupe asks for a number of POINTS PER IMAGE PIXEL and works back:
 * `want / view.scale`. At `want = 2` a single image pixel is two points
 * across, which is a thing a thumb can be aligned against.
 *
 * Clamped at 1 because magnification below 1 is a reduction, and a "loupe"
 * that shrinks the picture is worse than none: it looks like it is working.
 */
export function loupeScale(view, want = 2) {
  'worklet';
  if (!(view && view.scale > 0)) throw new Error('loupeScale: view has no scale');
  const k = want / view.scale;
  return k < 1 ? 1 : k;
}

export function pickHandle(point, crop, view, { touch } = {}) {
  'worklet';
  const v = toViewportRect(view, crop);
  const half = (touch === undefined ? TOUCH : touch) / 2;
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

/**
 * The four edges an auto-proposed crop can have taken something away from.
 *
 * The same compass vocabulary `HANDLES` uses, and for the reason two
 * vocabularies for one idea is a defect: `edgeBand('n', ...)` and the `n`
 * handle are the same edge of the same rect, and a second naming would be a
 * second thing to keep in step.
 */
export const EDGES = ['n', 'e', 's', 'w'];

/**
 * The strip between one edge of the crop and the same edge of the image.
 *
 * WHAT THIS IS FOR. Phase 2 promises the status bar "shown as an excluded
 * band that can be dragged back in". This is that, generalised, and the
 * survey in BUILD-PLAN is why: every surveyed app auto-proposes, and the
 * status bar is only the visible case of it. So the rule is not "remember
 * what the status-bar detector cut" -- it is "this is what the crop is
 * currently leaving out on each side, and you can take it back".
 *
 * That choice removes a second source of truth rather than adding one. The
 * alternative was to hold the proposal alongside the live crop for the life
 * of the editor and diff them, which means two rects that can disagree, a
 * band that survives the user dragging over it, and a question with no good
 * answer about what Reset does to it. Computed from the live crop there is
 * one rect, and an edge already at the image's edge simply has no band.
 *
 * SPANNED TO THE CROP, NOT TO THE IMAGE. The north band is `crop.w` wide and
 * sits directly above the frame, not the full image width. Full width is the
 * scrim's job, and a band that ran the whole way would make restoring the top
 * edge also widen the crop -- `BREAK=band_full_width` is that version, and it
 * is the mistake that looks correct in a screenshot where the crop happens to
 * be full width already.
 *
 * @returns a rect in IMAGE pixels, or null when that edge takes nothing away.
 */
export function edgeBand(edge, bounds, crop) {
  'worklet';
  if (!EDGES.includes(edge)) throw new Error(`unknown edge: ${edge}`);
  if (edge === 'n') {
    const h = crop.y - bounds.y;
    return h > 0 ? { x: crop.x, y: bounds.y, w: crop.w, h } : null;
  }
  if (edge === 's') {
    const y = crop.y + crop.h;
    const h = bounds.y + bounds.h - y;
    return h > 0 ? { x: crop.x, y, w: crop.w, h } : null;
  }
  if (edge === 'w') {
    const w = crop.x - bounds.x;
    return w > 0 ? { x: bounds.x, y: crop.y, w, h: crop.h } : null;
  }
  const x = crop.x + crop.w;
  const w = bounds.x + bounds.w - x;
  return w > 0 ? { x, y: crop.y, w, h: crop.h } : null;
}

/**
 * Give one edge back: the crop, grown to the image on that side.
 *
 * Only that side. Growing `h` without moving `y` is the north case's whole
 * risk -- it grows the crop downwards, over the picture, and the band it was
 * meant to reclaim stays exactly where it was. That reads on screen as "the
 * button did nothing and also broke the crop", which is why `BREAK=grow_wrong_way`
 * exists rather than being trusted to the property sweep.
 */
export function expandToEdge(crop, edge, bounds) {
  'worklet';
  const band = edgeBand(edge, bounds, crop);
  if (!band) return crop;
  if (edge === 'n') return { x: crop.x, y: bounds.y, w: crop.w, h: crop.h + band.h };
  if (edge === 's') return { x: crop.x, y: crop.y, w: crop.w, h: crop.h + band.h };
  if (edge === 'w') return { x: bounds.x, y: crop.y, w: crop.w + band.w, h: crop.h };
  return { x: crop.x, y: crop.y, w: crop.w + band.w, h: crop.h };
}

/**
 * Which band a point in IMAGE pixels landed in, or null.
 *
 * The four bands cannot overlap -- north and south span the crop's width,
 * west and east span its height -- so there is no precedence to get wrong and
 * the image's corners belong to no band. That is the right answer: a corner
 * strip would have to grow two axes at once, and the user has a corner handle
 * for that.
 *
 * Callers test this AFTER `pickHandle`, so the 48pt grab zone around the
 * frame wins. A band is what is left when the finger is clearly outside.
 */
export function pickBand(point, bounds, crop) {
  'worklet';
  for (let i = 0; i < EDGES.length; i++) {
    const b = edgeBand(EDGES[i], bounds, crop);
    if (b && point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h) {
      return EDGES[i];
    }
  }
  return null;
}
