// P4: the decisions behind the performance work, with no Skia and no React.
//
// Three small questions, each of which used to be an `if` inside a component
// or the renderer, where a test cannot reach it and a wrong answer is silent:
//
//   1. Which inputs does the export use — the picture and background the
//      editor already holds, or a fresh decode and a fresh sample?
//   2. Does an event go into the dev panel's state, or only to logcat?
//   3. Is a capture big enough to be drawn on screen from a smaller copy?
//
// None of them may change what the PNG contains. That is the line every
// answer here is held to: a faster export that is not the same export is a
// regression with a good excuse.

/** The longest side of the on-screen copy of a tall capture. */
export const PREVIEW_MAX = 2048;

/**
 * How long a side has to be before a copy is made at all. Twice the target, so
 * an ordinary phone screenshot (2400, 3200 tall) is drawn as itself: it is a
 * texture every GPU takes, and shrinking it would only add work at import and
 * soften the preview. 4096 is the texture size every OpenGL ES 3 device must
 * support; past it is where scroll captures live and the copy pays for itself.
 */
export const PREVIEW_TRIGGER = 4096;

const sameRect = (a, b) =>
  Boolean(a && b) && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * Remember WHICH crop a background sample was taken from, on the sample.
 *
 * The export plans its own crop (clamped to the picture), and a sample is
 * only the answer for the rect it read. Carrying the rect with the sample is
 * what lets the export tell "the sample the preview used" from "a sample of a
 * crop the user has since moved", without a second piece of state that has to
 * be kept in step in four places. planOutput ignores the extra field.
 */
export function stampSample(sample, crop) {
  if (!sample || !crop) return sample || null;
  return { ...sample, at: { x: crop.x, y: crop.y, w: crop.w, h: crop.h } };
}

/**
 * Whether a sample held by the editor may stand in for sampling `rect` again.
 *
 * Only when it was taken from exactly that rect. A sample of any other rect
 * would paint the export in the colour of a crop the user did not export,
 * which is the preview-disagrees-with-export defect this app is built around.
 */
export function canReuseSample(sample, rect) {
  return Boolean(sample) && sameRect(sample.at, rect);
}

/**
 * Where the export gets its picture from: 'image' (already decoded, as
 * App.js holds it), 'uri' or 'bytes' (decode now), or null when it has none.
 * A held image wins because decoding the same file twice is the cost this
 * removes; the order of the rest is the order renderCard always used.
 */
export function pickSource({ image, uri, bytes }) {
  if (image) return 'image';
  if (uri) return 'uri';
  if (bytes) return 'bytes';
  return null;
}

/**
 * Does an emitted event go into React state for the dev panel?
 *
 * Always to logcat (that is the field log), but state only when somebody can
 * see it: every setLog re-renders the whole editor, so a release build that
 * fed a hidden panel paid a full render per event for nothing. When the panel
 * is opened in release it starts empty, which is acceptable: what happened
 * before is in logcat.
 */
export function keepsLog({ dev, panelOpen }) {
  return Boolean(dev) || Boolean(panelOpen);
}

/**
 * The size of the on-screen copy of a picture, or none.
 *
 * Down only when the longest side exceeds `trigger`, and then to exactly `max` on
 * that side with the other scaled to match (never below 1). A picture at or
 * under the ceiling is drawn as itself: copying it would spend memory to look
 * identical. Geometry never comes from this size — crops stay in the full
 * picture's pixels and the preview is drawn into the same rect.
 *
 * @returns {{down: boolean, width: number, height: number}}
 */
export function previewSize({ width, height }, max = PREVIEW_MAX, trigger = Math.max(max, PREVIEW_TRIGGER)) {
  const long = Math.max(width, height);
  if (!(long > trigger)) return { down: false, width, height };
  const k = max / long;
  return {
    down: true,
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

/**
 * Which picture the CARD layer draws: the small copy or the full one.
 *
 * The card shows only the crop, magnified to the card's size. A copy made to
 * fit a whole 20000px capture on screen is about a hundred pixels wide, so a
 * one-screen crop of it would be blown up from that sliver and look smeared.
 * The copy is used only when it still has at least as many pixels across the
 * crop as the screen shows there; otherwise the full picture, which is what
 * this layer always drew. The raw layer always shows the whole picture, so
 * the copy is always enough there and it needs no such rule.
 *
 * @returns {'preview'|'full'}
 */
export function cardSource({ cropW, srcW, previewW, destW, pixelRatio = 1 }) {
  if (!(previewW < srcW)) return 'full';
  const across = cropW * (previewW / srcW);
  return across >= destW * pixelRatio ? 'preview' : 'full';
}
