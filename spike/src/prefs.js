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
import { BACKGROUNDS, PAD_MAX, PAD_MIN } from './shell.js';
import { DEFAULT_FORMAT, isFormat } from './format.js';
import { PADDING } from './sizing.js';

const VERSION = 1;

/** What a person with no prefs gets. Equal to a fresh editor's style. */
export const DEFAULT_PREFS = Object.freeze({
  padding: PADDING.standard,
  background: BACKGROUNDS[0],
  format: DEFAULT_FORMAT,
});

const validPadding = (v) => typeof v === 'number' && Number.isFinite(v) && v >= PAD_MIN && v <= PAD_MAX;
const validBackground = (v) => typeof v === 'string' && BACKGROUNDS.includes(v);

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
    try { j = JSON.parse(raw); } catch { return { ...DEFAULT_PREFS }; }
  }
  if (!j || typeof j !== 'object' || j.v !== VERSION) return { ...DEFAULT_PREFS };
  return {
    padding: validPadding(j.padding) ? j.padding : DEFAULT_PREFS.padding,
    background: validBackground(j.background) ? j.background : DEFAULT_PREFS.background,
    format: isFormat(j.format) ? j.format : DEFAULT_PREFS.format,
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
  return { padding: p.padding, background: p.background };
}
