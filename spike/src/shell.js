// Phase 4.5: the editor's state machine, with no React in it.
//
// WHY THIS IS NOT IN App.js. The thing being deleted is `showingResult` — a
// boolean that decided which of two previews was on the canvas and therefore
// what a rectangle drawn on it meant. It was one `useState` among fourteen, and
// the bug it caused (a box drawn over one image, applied to another) was
// invisible in every code review because the rule lived in a comment beside the
// flag rather than in anything that could be run.
//
// So the rules are a module. A tool session, what it owns, what Cancel and
// Reset each put back, and which image the canvas is showing are all pure
// functions of a plain object, and `shell.test.mjs` breaks each of them on
// purpose. The view reads the answers and draws them.
//
// THE TWO TOOLS, and the one property that separates them. Crop takes the bar
// over and returns with Done, because it is direct manipulation of the picture
// and the user needs the raw screenshot under their thumb, not a padded card.
// Style does not, because every Style control is already its own preview: the
// card is live, so moving the padding IS the apply step. That is
// the whole reason `takeover` and `owns` are one table below rather than two
// lists in two `if`s.

import { PADDING, padPixels } from './sizing.js';
import { DEFAULT_RADIUS, MAX_RADIUS } from './compose.js';

/**
 * The tool table. `owns` is the set of state fields a tool session can change,
 * and it is what a snapshot copies and what Cancel puts back.
 *
 * Deriving the snapshot from `owns` rather than naming fields at each call site
 * is the fix for the defect this module was written after: a Cancel that
 * restores three of the four things a tool changed is a Cancel that silently
 * keeps an edit, and it reads as correct at every line.
 *
 * Style owns nothing, which is not an oversight — it is the statement that
 * Style needs no apply, written where it can be checked. `shell.test.mjs`
 * asserts `takeover === (owns.length > 0)` for every tool, so the two halves of
 * that claim cannot drift apart.
 */
export const TOOL = {
  crop: { takeover: true, owns: ['crop'] },
  style: { takeover: false, owns: [] },
};

export const TOOLS = Object.keys(TOOL);

/**
 * The background choices in the Style strip, in the order they are shown.
 *
 * Match is first and is the default because it is the product: the card's
 * frame is sampled from the screenshot's own edges, and Paper and Ink are what
 * you reach for when that sample disagrees with itself. Ordering them the
 * other way round would present the fallback as the normal case.
 */
export const BACKGROUNDS = ['match', 'paper', 'ink'];

/**
 * The stops a dragged padding snaps onto, and WHY THE BAND IS NOT A CONSTANT.
 *
 * The chips light when the padding IS a stop, and a drag that lands on 0.0601
 * would otherwise leave Standard dark while drawing a card nobody could tell
 * from Standard. So a drag near a stop has to be pulled onto it.
 *
 * This used to be `SNAP = 0.004`, a hand-picked third of the gap between
 * adjacent stops. On the 0.03–0.10 range that band is 11% of the whole
 * track, and on 2026-09-18 it was measured on the device: tapping the slider
 * at x = 590, 640 and 690 left the thumb at exactly the same place, so a
 * hundred pixels of finger travel moved nothing and the next fifty jumped it
 * 111px. That is the "the transition between the three stops is a bit janky"
 * the owner reported, and it was a dead zone rather than a dropped frame.
 *
 * The band is now DERIVED: a dragged value snaps onto a stop when it rounds to
 * the same padding in source pixels, which is to say when it draws the same
 * card. `padPixels` in src/sizing.js is that rounding and is shared with
 * `cardSize`, so the two cannot disagree. The consequence is the property that
 * matters to a thumb: the pause at a stop is exactly as long as the pause
 * between any two adjacent whole pixels of padding — about 17px of track on
 * a 1080-wide crop, under the touch slop — rather than eight times longer.
 *
 * This is why `setPadding` needs the crop width. Passing it is not optional:
 * a default would silently restore a hand-picked band.
 */

const STOPS = Object.entries(PADDING)
  .map(([key, value]) => ({ key, value }))
  .sort((a, b) => a.value - b.value);

/** The padding drag runs between the outermost named stops, not beyond them. */
export const PAD_MIN = STOPS[0].value;
export const PAD_MAX = STOPS[STOPS.length - 1].value;

/** The named stops, smallest first. Derived from `PADDING`, never retyped. */
export function padStops() {
  return STOPS.map((s) => ({ ...s }));
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Plain data only — crop rects, numbers and strings. JSON rather than
// structuredClone because this runs in Hermes, and rather than a plain
// assignment because `crop` is an object: a shallow snapshot shares it with the
// live state, so Cancel would restore a rect that had already been dragged.
// That is the exact shape of bug this module exists to prevent, and
// `BREAK=snapshot_shallow` is it.
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * What a new card's Style starts at, and what Style's Reset goes back to. One
 * table for both, so Reset cannot return a card to anything but the one the
 * editor opened on.
 */
const STYLE_DEFAULTS = {
  padding: PADDING.standard,
  radius: DEFAULT_RADIUS,
  background: BACKGROUNDS[0],
};

/**
 * The editor's state for one screenshot.
 *
 * @param proposed  the auto-proposed crop in source pixels, which is both the
 *                  starting crop and what Reset goes back to. The editor opens
 *                  on a finished card, so there is no "no crop yet" state.
 */
export function editorState(proposed) {
  return {
    tool: null,
    proposed: copy(proposed),
    crop: copy(proposed),
    ...STYLE_DEFAULTS,
    // The open tool's owned fields as they were when it opened. Null whenever
    // no takeover tool is open, which is what makes "Cancel with nothing to
    // cancel" unrepresentable rather than merely unhandled.
    session: null,
  };
}

/**
 * What Reset puts back, per tool. The base value, not the open-time value.
 *
 * Style's Reset is the defaults a new card opens with. It used to be `{}`, a
 * Reset with nothing to do, and the Style strip had no Reset at all: the only
 * undo for a padding, a corner and a frame was to put each back by hand.
 */
const RESET_TO = {
  crop: (state) => ({ crop: copy(state.proposed) }),
  style: () => ({ ...STYLE_DEFAULTS }),
};

function snapshot(state, tool) {
  const out = {};
  for (const field of TOOL[tool].owns) out[field] = copy(state[field]);
  return out;
}

/**
 * Open a tool.
 *
 * Opening any tool while a takeover tool is open throws rather than closing it
 * implicitly, and that includes opening Crop over itself: a second open would
 * take a fresh snapshot, and the session already running could never be
 * cancelled back to where it began. It is unreachable through the UI — a
 * takeover replaces the bar the other tools live on — so reaching it means the
 * bar and this module disagree about what is on screen, and guessing which the
 * user meant is how an edit gets silently dropped. Style is not a takeover, so switching away
 * from it is ordinary and discards nothing.
 */
export function openTool(state, tool) {
  if (!TOOL[tool]) throw new Error(`shell: no such tool: ${String(tool)}`);
  if (state.tool && TOOL[state.tool].takeover) {
    throw new Error(`shell: ${state.tool} is open; finish it before opening ${tool}`);
  }
  if (state.tool === tool) return state;
  return {
    ...state,
    tool,
    session: TOOL[tool].takeover ? snapshot(state, tool) : null,
  };
}

/** Close the open tool, keeping its edits. The Done half of the triad. */
export function doneTool(state) {
  if (!state.tool) return state;
  return { ...state, tool: null, session: null };
}

/**
 * Close the open tool, putting back what it changed. The Cancel half.
 *
 * On Style this is Done, because Style has no session to undo. That is a
 * consequence of the table rather than a special case written here.
 */
export function cancelTool(state) {
  if (!state.tool) return state;
  return { ...state, ...(state.session || {}), tool: null, session: null };
}

/**
 * Put the open tool's values back to their base — the proposed crop — and stay
 * in the tool.
 *
 * Distinct from Cancel on purpose, and the distinction is the reason both are
 * in the triad: Cancel undoes this session, Reset undoes every session. A crop
 * nudged, applied, and reopened is returned to the whole proposed rect by Reset
 * and to the nudged rect by Cancel.
 */
export function resetTool(state) {
  if (!state.tool) return state;
  return { ...state, ...RESET_TO[state.tool](state) };
}

/** Is there anything for Reset to do? Drives whether the control is live. */
export function canReset(state) {
  if (!state.tool) return false;
  const base = RESET_TO[state.tool](state);
  for (const [field, value] of Object.entries(base)) {
    if (!sameValue(state[field], value)) return true;
  }
  return false;
}

/**
 * Which image the canvas is drawing: the composed card, or the raw screenshot.
 *
 * This replaces `showingResult`, and it is a function rather than a flag for
 * one reason: a flag has to be set correctly at every transition, and there
 * were six. Derived from the open tool, it cannot be stale.
 */
export function canvasShows(state) {
  return state.tool && TOOL[state.tool].takeover ? 'screenshot' : 'card';
}

/** 'main' | 'takeover' | 'strip' — which bottom bar is on screen. */
export function barMode(state) {
  if (!state.tool) return 'main';
  return TOOL[state.tool].takeover ? 'takeover' : 'strip';
}

/**
 * The fields that ARE the card. Everything else in the state -- which tool is
 * open, its session, the proposal Reset returns to -- is about the editor, and
 * leaving can only lose work that lives in these four.
 */
const CARD_FIELDS = ['crop', 'padding', 'radius', 'background'];

/** The card alone, as a copy, for remembering what was last kept. */
export function cardOf(state) {
  const out = {};
  for (const field of CARD_FIELDS) out[field] = copy(state[field]);
  return out;
}

// Field by field rather than JSON.stringify: a string compare calls the same
// four numbers in another key order a change. Every crop producer builds
// {x, y, w, h} in that order today, so this is insurance, not a fix; it is
// here so that canReset, unsaved and toolChanged answer by one rule.
function sameValue(a, b) {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
  }
  return a === b;
}

/**
 * Would leaving now lose work?
 *
 * @param kept  `cardOf` the card as it was last kept: at import, which is a
 *              card the person has not touched and can get back by opening
 *              the same screenshot, and after every Share, Save and Copy.
 *              Share counts although Android cannot say whether the sheet
 *              sent anything: asking "discard?" after every successful send
 *              teaches the person to tap Discard without reading it.
 */
export function unsaved(state, kept) {
  if (!state) return false;
  if (!kept) return true;
  return CARD_FIELDS.some((f) => !sameValue(state[f], kept[f]));
}

/** Has the open takeover tool changed anything since it opened? */
export function toolChanged(state) {
  if (!state || !state.session) return false;
  return Object.keys(state.session).some((f) => !sameValue(state[f], state.session[f]));
}

/**
 * What Android's Back does, one layer at a time, first match wins.
 *
 *   'close-dev' | 'close-menu'    whatever is floating over the editor
 *   'wait'                         a card is being made; leaving now would land
 *                                  its "Saved to Photos" on the empty screen
 *   'ask-tool'                     Crop is open and was moved: confirm, then Cancel
 *   'cancel-tool'                  Crop is open and unchanged: Cancel
 *   'close-tool'                   Style's strip is open; it keeps as it goes
 *   'ask'                          the card changed since it was kept: confirm, then leave
 *   'leave'                        back to the empty screen, nothing lost
 *   'exit'                         the empty screen: let Android close the app
 *
 * Back from the editor lands on the empty screen rather than closing the app,
 * because the editor is the one place a second Back can still be undone from.
 */
export function backAction(state, { menu = false, dev = false, busy = false, kept = null } = {}) {
  if (dev) return 'close-dev';
  if (menu) return 'close-menu';
  if (!state) return 'exit';
  if (busy) return 'wait';
  if (state.tool) {
    if (!TOOL[state.tool].takeover) return 'close-tool';
    return toolChanged(state) ? 'ask-tool' : 'cancel-tool';
  }
  return unsaved(state, kept) ? 'ask' : 'leave';
}

/**
 * Set the padding from a drag, snapping onto a named stop when it lands near
 * one and clamping to the range the stops describe.
 *
 * @returns {{padding: number, stop: string|null}} `stop` is the key when the
 * value IS a stop, so the chip row lights from the same call that moved the
 * slider rather than from a second comparison somewhere else.
 */
export function setPadding(frac, cropW) {
  if (!Number.isFinite(frac)) throw new Error(`shell: padding is not a number: ${String(frac)}`);
  if (!(cropW > 0)) throw new Error(`shell: setPadding needs the crop width, got ${String(cropW)}`);
  let v = clamp(frac, PAD_MIN, PAD_MAX);
  // The NEAREST stop that draws the same card, not the first one found. On a
  // crop narrow enough for MIN_PAD to swallow two stops they are genuinely one
  // card, and "whichever is earlier in the table" would then be an arbitrary
  // answer to a question that has a right one.
  const px = padPixels(cropW, v);
  const same = STOPS.filter((s) => padPixels(cropW, s.value) === px);
  if (same.length) {
    v = same.reduce((a, b) => (Math.abs(b.value - v) < Math.abs(a.value - v) ? b : a)).value;
  }
  const hit = STOPS.find((s) => s.value === v);
  return { padding: v, stop: hit ? hit.key : null };
}

/**
 * Set the corner radius from a slider, clamped to what `compose.js` will
 * accept.
 *
 * Clamped here as well as there, and that is not redundant: `composition()`
 * clamps so a fast thumb cannot produce a card with a 40% radius, and this
 * clamps so the slider's own thumb does not sit somewhere the card is not.
 * Without this the control and the card disagree above MAX_RADIUS, which reads
 * as the slider being broken at the top of its travel.
 */
export function setRadius(frac) {
  if (!Number.isFinite(frac)) throw new Error(`shell: radius is not a number: ${String(frac)}`);
  return clamp(frac, 0, MAX_RADIUS);
}

/**
 * Set the background, refusing a name the renderer does not know.
 *
 * Checked rather than trusted because the failure is silent at both ends: an
 * unknown name leaves no chip selected and reaches `renderCard`, which has no
 * branch for it and falls through to whatever its default is. The card then
 * has a background nobody chose and the strip shows nothing selected, which
 * reads as the control being broken rather than as the value being wrong.
 */
export function setBackground(name) {
  if (!BACKGROUNDS.includes(name)) {
    throw new Error(`shell: no such background: ${String(name)}. Known: ${BACKGROUNDS.join(', ')}`);
  }
  return name;
}
