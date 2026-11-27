// Custom background colours: the saved list and the three-slider mixer.
//
// Pure: no react-native, and it imports only pixels.js (colour constants and
// luma), so plan.js, shell.js, session.js and prefs.js can all import it
// without a cycle. `isBackground` (a name OR a custom hex) lives in shell.js
// beside BACKGROUNDS for exactly that reason: it needs the list of names, and
// shell.js imports plan.js, which imports this file.
//
// A custom background IS its colour: an uppercase six-digit hex, the same form
// as TONES. Nothing else is stored, so a card, a session file and the prefs
// all carry one string and planOutput needs no lookup.
import { luma, PAPER, INK } from './pixels.js';

/**
 * Saved colours. Why four: at 360dp the Style sheet's inner width is 312dp,
 * and the row is an Add disc plus the saved discs, each a 48dp target with an
 * 8dp gap, so five fit. Four saved, and Add.
 */
export const CUSTOM_MAX = 4;

/** An uppercase six-digit hex, which is what a saved colour is. */
export function isCustom(v) {
  return typeof v === 'string' && /^#[0-9A-F]{6}$/.test(v);
}

/**
 * The list after saving `hex`: most recent first, no repeats, at most
 * CUSTOM_MAX (the oldest falls off silently). An invalid hex changes nothing.
 */
export function addCustom(list, hex) {
  const base = Array.isArray(list) ? list : [];
  if (!isCustom(hex)) return base.slice();
  return [hex, ...base.filter((h) => h !== hex)].slice(0, CUSTOM_MAX);
}

export function removeCustom(list, hex) {
  return (Array.isArray(list) ? list : []).filter((h) => h !== hex);
}

/** A list from whatever was on disk: valid hexes only, no repeats, first CUSTOM_MAX. */
export function parseCustomList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const h of v) {
    if (isCustom(h) && !out.includes(h)) out.push(h);
    if (out.length === CUSTOM_MAX) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The mixer: hue, strength, shade, each 0..1.
//
//   hue       0..1 round the wheel (x 360 degrees).
//   strength  0 muted .. 1 vivid. HSL saturation from S_MIN to S_MAX: never a
//             pure grey (the ends of the track would be two identical
//             colours' worth of nothing) and never the full-saturation neon
//             that fights a screenshot.
//   shade     0 LIGHT .. 1 DARK, the order the tracks read in left to right:
//             the card's tone gets heavier as the thumb moves right. HSL
//             lightness from L_MAX down to L_MIN.
// ---------------------------------------------------------------------------
const S_MIN = 0.08;
const S_MAX = 0.85;
const L_MAX = 0.95;
const L_MIN = 0.05;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0; let g = 0; let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m].map((v) => Math.round(clamp01(v) * 255));
}

const hexOf = (rgb) => `#${rgb.map(hex2).join('')}`;
const lumaOf = (hex) => luma([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
const LUMA_LO = lumaOf(INK);
const LUMA_HI = lumaOf(PAPER);
const inRange = (hex) => { const l = lumaOf(hex); return l >= LUMA_LO && l <= LUMA_HI; };

/**
 * The colour for a mix, as an uppercase six-digit hex.
 *
 * HARD RULE: its luma lies between Ink's and Paper's, inclusive, so a mixed
 * colour can never raise planOutput's near-white or near-black warning.
 * Enforced structurally, on the ROUNDED hex that is actually stored: if the
 * lightness the shade asked for lands outside, the lightness is bisected
 * towards 0.5 (always inside, for every hue at every strength) and the
 * outermost lightness that is inside is used. The hex returned is therefore
 * always one that was itself checked.
 */
export function mixColour({ hue, strength, shade }) {
  const h = clamp01(hue) * 360;
  const s = S_MIN + (S_MAX - S_MIN) * clamp01(strength);
  const want = L_MAX - (L_MAX - L_MIN) * clamp01(shade);
  const at = (l) => hexOf(hslToRgb(h, s, l));
  const first = at(want);
  if (inRange(first)) return first;
  return bisect(at, want, 0.5);
}

// Bisect between an outside lightness and an inside one, keeping the inside end.
function bisect(at, outside, inside) {
  let lo = outside;
  let hi = inside;
  let best = at(inside);
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const c = at(mid);
    if (inRange(c)) { hi = mid; best = c; } else lo = mid;
  }
  return best;
}

/**
 * The mix that is closest to `hex`, so the mixer opens on the colour the card
 * shows now. Approximate: strength and shade are clamped to the ranges above,
 * and a grey (no hue at all) opens at hue 0. Never throws.
 */
export function mixFromHex(hex) {
  const v = typeof hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : PAPER;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = (((g - b) / d) % 6 + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return {
    hue: clamp01(h),
    strength: clamp01((s - S_MIN) / (S_MAX - S_MIN)),
    shade: clamp01((L_MAX - l) / (L_MAX - L_MIN)),
  };
}

/**
 * `n` colours along one track, the other two values held at `mix`'s, for
 * drawing the track as a row of segments. `which` is hue, strength or shade.
 */
export function trackStops(which, mix, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(mixColour({ ...mix, [which]: n > 1 ? i / (n - 1) : 0 }));
  }
  return out;
}

/** What one TalkBack increment or decrement moves a track by. */
const STEP = 0.05;

/** `v` stepped one notch in `dir` (+1 or -1), kept to 0..1 and free of float drift. */
export function nudge(v, dir) {
  return clamp01(Math.round((clamp01(v) + (dir < 0 ? -STEP : STEP)) * 1000) / 1000);
}
