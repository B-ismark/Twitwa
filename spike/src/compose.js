// Phase 4.5: one description of a card, projected to whatever width is asked
// for. No Skia, no React — the arithmetic is separated from the drawing for
// the same reason src/crop.js separates it from the gesture.
//
// WHY THIS EXISTS. Deleting the "Make card" step means the card is composed
// twice: once at screen resolution, sixty times a second, and once at up to
// 1080 wide when Share is pressed. Two compositions of one card is the
// two-sources-of-truth defect in its purest form. They would agree on the day
// they were written and drift on the first change to either, and the symptom
// is the worst kind: the card the user approved is not the card that was sent,
// nobody sees it happen, and the evidence leaves the device.
//
// So there is exactly one composition. `composition()` says what the card IS,
// as ratios that do not know about pixels, and `project()` turns that into
// pixels at a given width. The preview calls project with the stage width. The
// export calls it with the export width. Neither computes a layout.
//
// WHY `cardSize` IS STILL THE AUTHORITY. It carries the encode ceilings, the
// never-upscale rule, MIN_PAD and the thin-crop repair, and all of that is
// about the OUTPUT, not about the preview. So `composition()` asks it for the
// real card once and then re-expresses its answer as ratios. The alternative —
// deriving ratios from the raw inputs — would give a preview that disagrees
// with the export precisely in the cases cardSize exists to handle, which are
// the cases nobody tests by eye.

import { cardSize } from './sizing.js';

/**
 * The largest corner radius, as a fraction of the image's own width inside the
 * card.
 *
 * A fraction of the IMAGE rather than of the card, because the radius is drawn
 * on the image's corners and has to look the same whatever padding is around
 * it. Tie it to the card and widening the padding fattens the corners, which
 * is a thing nobody asks for and everybody notices.
 *
 * 4% is where a screenshot stops reading as a screenshot. Past that it is a
 * sticker.
 */
export const MAX_RADIUS = 0.04;

/** Enough to read as a card, little enough to not read as a decision. */
export const DEFAULT_RADIUS = 0.015;

/**
 * Below this width a projection is refused rather than rounded.
 *
 * Not a style rule: `pad` and `dest` are rounded independently of `width`, and
 * at a small enough width the padding closes over the image the same way it
 * did in `cardSize` before its thin-crop repair. `cardSize` grows the card to
 * fix that, which a preview cannot do — a preview has the stage it has. So the
 * preview refuses instead, and the caller has a real error rather than a card
 * with no image in it. 32 is far below any stage; a zero-sized stage on the
 * first layout pass is the case this actually catches.
 */
export const MIN_PROJECT = 32;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * What the card is, independent of how big it is drawn.
 *
 * @param crop    {w, h} in source pixels
 * @param stop    'snug' | 'standard' | 'roomy', or a number as a fraction of
 *                crop width. Passed straight through to `cardSize`, which is
 *                why the continuous value the Style strip needs already works.
 * @param radius  fraction of the image's width, 0..MAX_RADIUS. Clamped, not
 *                rejected: it arrives from a slider, and a slider that can
 *                throw is a crash waiting for a fast thumb.
 *
 * @returns {{width, height, aspect, padFrac, radius, pad, dest, warnings, clamped, repaired}}
 *
 * `aspect` and `padFrac` are the ratios `project` multiplies. `width`/`height`/
 * `pad`/`dest` are the EXPORT pixels, kept on the same object because every
 * caller that wants the ratios also wants to know how big the real card is —
 * and because `project(comp, comp.width)` reproducing them exactly is the
 * invariant this whole module exists to hold.
 */
export function composition(crop, stop = 'standard', radius = DEFAULT_RADIUS) {
  const card = cardSize(crop, stop);
  const r = Number.isFinite(radius) ? clamp(radius, 0, MAX_RADIUS) : 0;

  return {
    width: card.width,
    height: card.height,
    // Ratios OF THE CARD, which is what makes them projectable. Deriving
    // padFrac from the crop instead is the frame error this module is most
    // likely to be given: both denominators are plausible, both are numbers,
    // and the two agree closely enough at standard padding to pass a glance.
    aspect: card.height / card.width,
    padFrac: card.pad / card.width,
    // Kept as the input fraction of the IMAGE width, not as pixels. A radius
    // in pixels is meaningless at a second scale, and carrying it as pixels is
    // invisible at export scale — where it is correct — and wrong only on the
    // preview, which is the half nobody has a reference for.
    radius: r,
    pad: card.pad,
    dest: card.dest,
    warnings: card.warnings,
    clamped: card.clamped,
    repaired: card.repaired,
  };
}

/**
 * The same card, in pixels, at `width`.
 *
 * @returns {{width, height, pad, dest: {x, y, w, h}, radius}}
 *
 * `dest` is derived by SUBTRACTION, for the reason `cardSize` gives at length:
 * scaling the image and the padding independently lets rounding land a
 * different margin on each side, which is a one-pixel bright line down the
 * edge of a card whose whole purpose is the frame.
 */
export function project(comp, width) {
  if (!(width >= MIN_PROJECT)) {
    throw new Error(`compose: refusing to project to ${width}px, below MIN_PROJECT=${MIN_PROJECT}`);
  }
  const w = Math.round(width);
  const height = Math.round(w * comp.aspect);
  const pad = Math.round(w * comp.padFrac);
  const dest = { x: pad, y: pad, w: w - pad * 2, h: height - pad * 2 };
  if (dest.w < 1 || dest.h < 1) {
    throw new Error(
      `compose: padding closed over the image at ${w}px (dest ${dest.w}x${dest.h}). ` +
        'The stage is too small for this composition.',
    );
  }
  return { width: w, height, pad, dest, radius: Math.round(dest.w * comp.radius) };
}

/**
 * Is `shot` the same composition as `comp`, allowing only what rounding can
 * account for?
 *
 * This is the gate. The claim being checked is not "the numbers are close" —
 * that is unfalsifiable and would pass on a 5% drift. It is that every pixel
 * value in the projection is the exact rounding of the ratio, so the only
 * possible disagreement is the half-pixel that rounding itself introduces.
 * A composition computed a second way cannot land inside that.
 *
 * @returns {{ok: boolean, worst: number, detail: string}} `worst` is the
 * largest deviation in pixels, reported whether or not it passed, because a
 * gate that prints only its verdict is a gate whose margin nobody watches.
 */
export function sameComposition(comp, shot, tol = 0.5) {
  const want = {
    height: shot.width * comp.aspect,
    pad: shot.width * comp.padFrac,
    radius: shot.dest.w * comp.radius,
  };
  const off = {
    height: Math.abs(shot.height - want.height),
    pad: Math.abs(shot.pad - want.pad),
    radius: Math.abs(shot.radius - want.radius),
  };
  // The margins have to be equal to each other as well as right in size.
  // Subtraction makes that true by construction, so this asserts the
  // construction rather than the arithmetic: it is the check that fails if
  // anyone ever computes `dest` by scaling.
  const symmetric =
    shot.dest.x === shot.pad &&
    shot.dest.y === shot.pad &&
    shot.dest.w === shot.width - shot.pad * 2 &&
    shot.dest.h === shot.height - shot.pad * 2;

  const worst = Math.max(off.height, off.pad, off.radius);
  const ok = worst <= tol && symmetric;
  const detail =
    `at ${shot.width}px: height off ${off.height.toFixed(3)}, ` +
    `pad off ${off.pad.toFixed(3)}, radius off ${off.radius.toFixed(3)}` +
    (symmetric ? '' : ', AND dest is not symmetric about the padding');
  return { ok, worst, detail };
}
