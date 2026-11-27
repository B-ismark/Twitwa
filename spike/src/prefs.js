// The style a person last chose, remembered across screenshots.
//
// Pure: no react-native, no expo-file-system, so it loads in node and has a
// test. The file I/O is in App.js.
//
// WHY NOT THE SESSION FILE. The session (src/session.js) is one unfinished
// card and is deleted once the card has gone somewhere. These three values
// are a habit, not a card: they must outlive every export, so they live in
// their own file in the document directory (the cache may be cleared by
// Android at any time, and losing a habit costs more than losing a hint).
//
// A restored session keeps its OWN padding and background; prefs only choose
// where a NEW image starts.
import { BACKGROUNDS, PAD_MAX, PAD_MIN, isBackground } from './shell.js';
import { addCustom, parseCustomList, removeCustom } from './custom.js';
import { DEFAULT_FORMAT, isFormat } from './format.js';
import { PADDING } from './sizing.js';

const VERSION = 1;

/** What a person with no prefs gets. Equal to a fresh editor's style. */
export const DEFAULT_PREFS = Object.freeze({
  padding: PADDING.standard,
  background: BACKGROUNDS[0],
  format: DEFAULT_FORMAT,
  // The saved custom colours, most recent first (src/custom.js). Absent in a
  // v1 file written before they existed, which reads as none.
  custom: Object.freeze([]),
});

const validPadding = (v) => typeof v === 'number' && Number.isFinite(v) && v >= PAD_MIN && v <= PAD_MAX;
const validBackground = (v) => typeof v === 'string' && isBackground(v);

/**
 * Prefs from whatever is on disk, never throwing. Each field falls back to its
 * default on its own, so one bad value does not cost the other two; a file that
 * is not an object of this version is all defaults.
 *
 * Padding is refused, not clamped, when out of range: a clamped number is a
 * style nobody chose (the same rule as readSession).
 */
export function parsePrefs(raw) {
  let j = raw;
  if (typeof raw === 'string') {
    try { j = JSON.parse(raw); } catch { return { ...DEFAULT_PREFS, custom: [] }; }
  }
  if (!j || typeof j !== 'object' || j.v !== VERSION) return { ...DEFAULT_PREFS, custom: [] };
  return {
    padding: validPadding(j.padding) ? j.padding : DEFAULT_PREFS.padding,
    background: validBackground(j.background) ? j.background : DEFAULT_PREFS.background,
    format: isFormat(j.format) ? j.format : DEFAULT_PREFS.format,
    custom: parseCustomList(j.custom),
  };
}

/**
 * The object to write. Goes through parsePrefs so a value that could not be
 * read back is never written: the file on disk is always one parsePrefs
 * accepts whole.
 */
export function serialisePrefs(prefs) {
  return { v: VERSION, ...parsePrefs({ v: VERSION, ...(prefs || {}) }) };
}

/** The padding and background a NEW image opens on. Format is not style. */
export function startingStyle(prefs) {
  const p = parsePrefs({ v: VERSION, ...(prefs || {}) });
  // A custom colour that is no longer in the row has been removed, and a
  // removed colour must not keep coming back on every new card. (Removing it
  // already resets the habit, see forgetCustom; this is the file read back
  // after any other route to the same state.)
  const gone = !BACKGROUNDS.includes(p.background) && !p.custom.includes(p.background);
  return { padding: p.padding, background: gone ? DEFAULT_PREFS.background : p.background };
}

/**
 * The prefs patch for saving `hex` from the mixer: it becomes the habit and
 * goes to the front of the row.
 */
export function rememberCustom(prefs, hex) {
  return { background: hex, custom: addCustom((prefs || {}).custom, hex) };
}

/**
 * The prefs patch for removing `hex` from the row. If it was the remembered
 * background the habit goes back to the default. The card on screen is not
 * prefs' business and keeps its colour.
 */
export function forgetCustom(prefs, hex) {
  const p = prefs || {};
  const patch = { custom: removeCustom(p.custom, hex) };
  if (p.background === hex) patch.background = DEFAULT_PREFS.background;
  return patch;
}
