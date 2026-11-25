// P2: the numbers that keep the stage still, with no React in them.
//
// THE RULE THIS MODULE SERVES: the stage (the card preview) never changes size
// because some chrome appeared or disappeared. It used to. The update banner,
// the More menu, the Style strip, a caption that wrapped to a second line and
// the Close row each took height from a `flex: 1` stage, so opening any of them
// resized the canvas, re-fitted the card and moved it under the person's thumb.
//
// So everything that can come and go is either an OVERLAY (absolute, over the
// stage, taking no height) or a FIXED SLOT (always there, always the same
// height). What is left in the flow is a handful of constants and a handful of
// sums, and they are here, not in App.js, so that a desktop can break them on
// purpose: `layout.test.mjs`.
import { SPACE, TOUCH } from './theme.js';
import { PAD_MAX, PAD_MIN, setPadding } from './shell.js';

/**
 * The caption's line height and how many lines its slot holds.
 *
 * Two lines because a problem is a sentence, and one line clipped the half
 * that said what to do about it.
 * The line height is stated rather than left to the font, because the slot's
 * height is a sum over it and a default that differs by a point between
 * devices would make the slot a point taller or shorter than its text.
 */
export const CAPTION_LINES = 2;
export const CAPTION_LINE = 18;

/**
 * The caption slot's height: room for its two lines at the person's font size,
 * and never under a touch target, because the "1 waiting" chip lives in the
 * same row and must stay tappable.
 *
 * `fontScale` is in the sum because Android scales a line height with the text.
 * A slot sized for scale 1 clips the second line of a person who has made the
 * system text larger, which is the person most likely to need the sentence.
 */
export function captionHeight(fontScale = 1) {
  const scale = fontScale >= 1 ? fontScale : 1;
  return Math.max(TOUCH, Math.ceil(CAPTION_LINES * CAPTION_LINE * scale) + SPACE.sm);
}

/**
 * How far the crop's handles must stay from the screen's left and right edges.
 *
 * Android's back gesture starts at either edge, about 20dp in on most phones
 * and up to 40 with the sensitivity turned up. A handle dragged to the image
 * edge of a full-width screenshot sat 12dp from the screen's edge (the stage's
 * own margin), inside that zone, so the system took the drag as Back.
 */
export const CROP_EDGE_INSET = 24;

/** The stage's own horizontal margin, which is part of that distance. */
export const STAGE_MARGIN = SPACE.md;

/**
 * How much narrower than the stage the crop's working area is, per side.
 *
 * The stage cannot shrink while cropping (that is the whole rule), so the
 * raw-screenshot layer is inset INSIDE it instead: the picture is fitted into
 * the narrower area, and nothing in the gutter is a touch the crop sees. It is
 * what is missing from the margin, not the whole inset, or the gutter would
 * be 24 on top of 12.
 */
export function cropGutter() {
  return Math.max(0, CROP_EDGE_INSET - STAGE_MARGIN);
}

/**
 * Where the first overlay at the stage's top starts, below the Close control
 * when there is one. The update banner floats there: at 0 it would sit on top
 * of Close and leave no way out of a card while an update was on offer.
 */
export function overlayTop(hasClose) {
  return hasClose ? SPACE.sm + TOUCH + SPACE.sm : SPACE.sm;
}

/**
 * Edge-to-edge padding, from the system's insets rather than a constant.
 *
 * The app draws under the status and navigation bars, so the top padding is the
 * status bar's height (it was a hardcoded 44, right on one phone and wrong
 * under any cutout), and the bottom one is the navigation bar's. The floor on
 * the bottom is for 3-button navigation, which some builds report as an inset
 * of 0 while still drawing the bar over the content.
 */
export function topPad(insetTop) {
  return Math.max(0, insetTop) + SPACE.sm;
}
export function bottomPad(insetBottom) {
  return Math.max(SPACE.sm, insetBottom) + SPACE.md;
}

/**
 * The status bar's icon colour for a scheme, in expo-status-bar's vocabulary,
 * where 'dark' means DARK ICONS. A light app gets dark icons, so the clock is
 * readable on Paper; a dark app gets light ones. The inverted reading is the
 * mistake this function exists to keep out of the view.
 */
export function statusBarStyle(scheme) {
  return scheme === 'light' ? 'dark' : 'light';
}

/** Ten steps from Snug to Roomy for TalkBack's increment and decrement. */
export const PAD_STEPS = 10;

/**
 * One TalkBack step of the padding slider, in `dir` = 1 or -1.
 *
 * Not "the next stop": there are three of them, and an adjustable control that
 * moves a third of its range per swipe cannot be set to anything between. A
 * tenth of the range can. But a tenth is not always a different card: on a
 * narrow crop `setPadding` snaps a small move back onto the stop it started on
 * (it draws the same pixels), and a step that lands where it began reads as
 * the control being stuck. So the step grows until the card changes, and stays
 * put only at the end of the range.
 */
export function stepPadding(current, dir, cropW) {
  if (dir !== 1 && dir !== -1) throw new Error(`layout: dir must be 1 or -1, got ${String(dir)}`);
  const size = (PAD_MAX - PAD_MIN) / PAD_STEPS;
  for (let k = 1; k <= PAD_STEPS; k += 1) {
    const next = setPadding(current + dir * size * k, cropW).padding;
    if ((next - current) * dir > 0) return next;
  }
  return current;
}

/**
 * How the finished card moves while the Style sheet is open, so the sheet
 * never sits over the card it is editing.
 *
 * The stage keeps its size (the rule above); the CARD glides up and, if it has
 * to, shrinks, into the room between the stage's top and the sheet's top. It is
 * a transform on the card's layer, not a re-fit, so nothing re-renders and it
 * can animate. Padding and background are what the sheet changes, and both are
 * read at the card's edges, which is exactly what a sheet over its lower half
 * hid.
 *
 * RN scales about the layer's centre, which is the stage's centre, so the
 * translation is worked out after the scale. A card that already clears the
 * sheet does not move at all.
 *
 *   { scale, ty }   for transform: [{ translateY: ty }, { scale }]
 */
export function liftForSheet({ stageH, cardTop, cardH, sheetH, gap = SPACE.md }) {
  const still = { scale: 1, ty: 0 };
  if (!(sheetH > 0) || !(stageH > 0) || !(cardH > 0)) return still;
  const roomTop = gap;
  const roomBottom = stageH - sheetH - gap;
  if (cardTop >= roomTop && cardTop + cardH <= roomBottom) return still;
  const room = roomBottom - roomTop;
  // A sheet taller than the stage leaves no room; keep the card legible and
  // let the sheet cover what it must rather than draw a speck.
  const scale = Math.max(LIFT_MIN_SCALE, Math.min(1, room / cardH));
  const cy = stageH / 2;
  const centre = cardTop + cardH / 2;
  const target = roomTop + Math.max(room, 0) / 2;
  return { scale, ty: target - (cy + (centre - cy) * scale) };
}
export const LIFT_MIN_SCALE = 0.35;
