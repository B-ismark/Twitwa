// The editor's card, as a small file that survives the process being killed.
// Pure: no react-native, no expo-file-system, so it loads in node and has a
// test. The I/O around it lives in App.js.
//
// WHY. Android kills a backgrounded app whenever it likes, and the person who
// comes back finds the empty screen and a share replay that
// plugins/withShareInRestore.js deliberately ignores. What they were editing
// is four values and a picture's path, so those are written down on every
// commit and read back at launch when no new share is waiting.
//
// WHAT IS NOT IN IT: which tool is open, the proposal Reset returns to, and
// whether the card was kept. The proposal is recomputed from the picture, and
// a restored card is treated as unsaved (see openImage in App.js).
import { BACKGROUNDS, PAD_MAX, PAD_MIN, cardOf } from './shell.js';

const VERSION = 1;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * The card as it stands, for `uri`, as a plain JSON-able object.
 *
 * While a takeover tool is open the card is what the tool's snapshot holds,
 * not the live value: Crop's drag is not committed until Done, and Cancel puts
 * the snapshot back. Writing the live crop would restore an edit its author
 * was still free to throw away.
 */
export function serialiseSession(state, uri) {
  if (!state || typeof uri !== 'string' || uri === '') return null;
  const card = cardOf({ ...state, ...(state.session || {}) });
  return { v: VERSION, uri, crop: card.crop, padding: card.padding, background: card.background };
}

/**
 * A session read back from disk, or null if it cannot be trusted.
 *
 * @param raw  the file's text, or the value it parsed to
 *
 * Padding is any value in the drag's range, not only the three named stops:
 * the slider produces values between them (shell.js `setPadding`), and a card
 * on one of those is a card worth restoring. Anything outside the range is
 * refused rather than clamped, because a clamped number is a card nobody made.
 */
export function readSession(raw) {
  let j = raw;
  if (typeof raw === 'string') {
    try { j = JSON.parse(raw); } catch { return null; }
  }
  if (!j || typeof j !== 'object' || j.v !== VERSION) return null;
  // file:// only. A content:// grant can be revoked between runs, and the
  // renderer reads this path again at export time.
  if (typeof j.uri !== 'string' || !j.uri.startsWith('file://')) return null;
  const c = j.crop;
  if (!c || typeof c !== 'object') return null;
  if (![c.x, c.y, c.w, c.h].every(finite)) return null;
  if (c.x < 0 || c.y < 0 || !(c.w > 0) || !(c.h > 0)) return null;
  if (!finite(j.padding) || j.padding < PAD_MIN || j.padding > PAD_MAX) return null;
  if (!BACKGROUNDS.includes(j.background)) return null;
  return {
    v: VERSION,
    uri: j.uri,
    crop: { x: c.x, y: c.y, w: c.w, h: c.h },
    padding: j.padding,
    background: j.background,
  };
}

/**
 * Does the saved crop lie inside a picture of `width` x `height`? The file can
 * outlive the picture it described (the cache entry replaced by another
 * screenshot of a different size), and a crop past the edge reaches the
 * renderer as a read outside the image.
 */
export function cropFits(crop, width, height) {
  if (!crop || !(width > 0) || !(height > 0)) return false;
  return crop.x >= 0 && crop.y >= 0 && crop.x + crop.w <= width && crop.y + crop.h <= height;
}
