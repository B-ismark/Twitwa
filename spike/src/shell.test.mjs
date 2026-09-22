// Tests for src/shell.js — the editor state machine that replaces `showingResult`.
//
//   for b in snapshot_shallow cancel_keeps done_restores reset_to_session \
//            style_takeover canvas_flag no_snap pad_unclamped bg_unvalidated \
//            radius_unclamped reopen_allowed canreset_blind stops_typed \
//            snap_constant; do
//     BREAK=$b node src/shell.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// `canvas_flag` is the regression this whole module exists to prevent: a
// canvas that shows the card while a takeover tool is open. That is what the
// shipped app did with `showingResult`, and the symptom was not a wrong canvas
// — it was a box drawn over one image and applied to another, because the same
// on-screen rectangle points at different content in the two.
//
// `stops_typed` is the second source of truth. The padding chips and the
// padding used by `cardSize` have to be one table, and a hand-typed copy of
// three numbers is exactly the kind of drift nothing notices until a stop is
// changed and only the label moves.
//
// `snap_constant` is the shipped defect this file did not catch: a snap band
// picked as a fraction of the GAP BETWEEN STOPS rather than derived from the
// card. Every assertion here used to be written in units of that constant, so
// the constant could have been anything at all and they stayed green. It took
// a device measurement to find. The band is now expressed in track travel and
// in whole pixels of padding -- units a thumb can feel.
import * as real from './shell.js';
import { PADDING, padPixels } from './sizing.js';
import { MAX_RADIUS } from './compose.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'snapshot_shallow') {
  // Snapshot the owned fields by reference. Correct for as long as every edit
  // replaces the value, and silently wrong the first time one is edited in
  // place — which is what a gesture writing back a dragged rect looks like.
  F.openTool = (state, tool) => {
    const s = real.openTool(state, tool);
    if (!s.session) return s;
    const shallow = {};
    for (const field of real.TOOL[tool].owns) shallow[field] = state[field];
    return { ...s, session: shallow };
  };
} else if (BREAK === 'cancel_keeps') {
  // Cancel closes the tool without putting anything back, so it is Done with a
  // different label. The most expensive kind of wrong: destructive, and only
  // ever noticed by someone who meant to undo.
  F.cancelTool = (state) => real.doneTool(state);
} else if (BREAK === 'done_restores') {
  // The inverse swap, which is worth its own mutant because a test that only
  // checks Cancel would pass with the two behaviours exchanged.
  F.doneTool = (state) => real.cancelTool(state);
} else if (BREAK === 'reset_to_session') {
  // Reset restores the open-time snapshot, collapsing it into Cancel-without-
  // closing. Plausible, and it makes Reset useless in the case it is for:
  // reopening Crop after applying one and wanting the whole picture back.
  F.resetTool = (state) => {
    if (!state.tool) return state;
    return { ...state, ...(state.session || {}) };
  };
} else if (BREAK === 'style_takeover') {
  // Style declared a takeover, so the canvas drops to the raw screenshot while
  // the padding is dragged. Every Style control then adjusts something the
  // user cannot see.
  F.TOOL = { ...real.TOOL, style: { takeover: true, owns: [] } };
  F.canvasShows = (state) => (state.tool && F.TOOL[state.tool].takeover ? 'screenshot' : 'card');
  F.barMode = (state) => {
    if (!state.tool) return 'main';
    return F.TOOL[state.tool].takeover ? 'takeover' : 'strip';
  };
} else if (BREAK === 'canvas_flag') {
  // The shipped bug, in one line: the canvas always draws the card.
  F.canvasShows = () => 'card';
} else if (BREAK === 'no_snap') {
  // No snapping, so a drag that lands a hundredth of a percent off Standard
  // reports a custom padding and leaves the chip dark.
  F.setPadding = (frac) => {
    const v = Math.min(real.PAD_MAX, Math.max(real.PAD_MIN, frac));
    const hit = real.padStops().find((s) => s.value === v);
    return { padding: v, stop: hit ? hit.key : null };
  };
} else if (BREAK === 'pad_unclamped') {
  F.setPadding = (frac) => {
    const hit = real.padStops().find((s) => Math.abs(frac - s.value) <= 0.004);
    return hit ? { padding: hit.value, stop: hit.key } : { padding: frac, stop: null };
  };
} else if (BREAK === 'snap_constant') {
  // The band as it shipped: a hand-picked 0.004, a third of the gap between
  // adjacent stops and eight whole pixels of padding on a 1080-wide crop.
  // Nothing about it is wrong except that the thumb stops dead inside it.
  F.setPadding = (frac) => {
    let v = Math.min(real.PAD_MAX, Math.max(real.PAD_MIN, frac));
    for (const s of real.padStops()) {
      if (Math.abs(v - s.value) <= 0.004) { v = s.value; break; }
    }
    const hit = real.padStops().find((s) => s.value === v);
    return { padding: v, stop: hit ? hit.key : null };
  };
} else if (BREAK === 'radius_unclamped') {
  F.setRadius = (frac) => frac;
} else if (BREAK === 'reopen_allowed') {
  // Opening Crop over an open Crop silently takes a fresh snapshot, so the
  // session already running can never be cancelled back to where it began.
  F.openTool = (state, tool) => ({
    ...state,
    tool,
    session: real.TOOL[tool].takeover
      ? Object.fromEntries(real.TOOL[tool].owns.map((f) => [f, JSON.parse(JSON.stringify(state[f]))]))
      : null,
  });
} else if (BREAK === 'bg_unvalidated') {
  // Take whatever the strip hands over. Wrong at both ends and loud at
  // neither: no chip selected, and a renderer with no branch for the name.
  F.setBackground = (name) => name;
} else if (BREAK === 'canreset_blind') {
  F.canReset = (state) => Boolean(state.tool);
} else if (BREAK === 'stops_typed') {
  // The chips as their own list of numbers, which is what a view does when the
  // table is not reachable from it.
  F.padStops = () => [
    { key: 'snug', value: 0.03 },
    { key: 'standard', value: 0.05 },
    { key: 'roomy', value: 0.1 },
  ];
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

const PROPOSED = { x: 0, y: 120, w: 1080, h: 1800 };
const fresh = () => F.editorState(PROPOSED);

console.log('the tool table says one thing, not two');
{
  const bad = F.TOOLS.filter((t) => F.TOOL[t].takeover !== (F.TOOL[t].owns.length > 0));
  check(
    'a tool takes the bar over exactly when it owns something to cancel',
    bad.length === 0,
    bad.join(', '),
  );
  check('and there are two tools', F.TOOLS.length === 2, F.TOOLS.join(','));
  check('Style owns nothing, which is what "needs no apply" means', F.TOOL.style.owns.length === 0);
  check('Crop owns the crop', F.TOOL.crop.owns.join() === 'crop');
}

console.log('\nthe editor opens on a finished card');
{
  const s = fresh();
  check('there is a crop before anything is touched', s.crop.w === PROPOSED.w && s.crop.h === PROPOSED.h);
  check('no tool is open', s.tool === null);
  check('and the canvas is showing the card', F.canvasShows(s) === 'card', F.canvasShows(s));
  check('the main bar is up', F.barMode(s) === 'main', F.barMode(s));
  check('the crop is not the same object as the proposal', s.crop !== s.proposed);
  check('the padding starts at Standard', s.padding === PADDING.standard, String(s.padding));
  check('the background starts on Match', s.background === F.BACKGROUNDS[0], s.background);
  check('and Match is a background the strip offers', F.BACKGROUNDS.includes(s.background));
  check('there are three of them', F.BACKGROUNDS.length === 3, F.BACKGROUNDS.join(','));
}

console.log('\nthe background is checked against that list, not trusted');
{
  for (const name of F.BACKGROUNDS) {
    check(`${name} is accepted and comes back unchanged`, F.setBackground(name) === name);
  }
  let threw = false;
  try { F.setBackground('paperr'); } catch (e) { threw = true; }
  check('a name the renderer has no branch for throws', threw);
  let threwUndef = false;
  try { F.setBackground(undefined); } catch (e) { threwUndef = true; }
  check('and so does nothing at all', threwUndef);
}

console.log('\na takeover tool shows the raw screenshot, because that is what is being edited');
{
  const c = F.openTool(fresh(), 'crop');
  check('Crop shows the screenshot', F.canvasShows(c) === 'screenshot', F.canvasShows(c));
  check('and takes the bar over', F.barMode(c) === 'takeover', F.barMode(c));
  const y = F.openTool(fresh(), 'style');
  // The one that matters: Style is adjusting the padding and the corners, and
  // both are invisible on a raw screenshot.
  check('Style keeps the card on the canvas', F.canvasShows(y) === 'card', F.canvasShows(y));
  check('and opens a strip rather than a takeover', F.barMode(y) === 'strip', F.barMode(y));
  check('Style takes no snapshot', y.session === null);
  check('Crop does', c.session !== null && 'crop' in c.session);
}

console.log('\nCancel puts back, Done keeps');
{
  const open = F.openTool(fresh(), 'crop');
  const edited = { ...open, crop: { x: 10, y: 200, w: 500, h: 500 } };

  const cancelled = F.cancelTool(edited);
  check('Cancel restores the crop the tool opened with', cancelled.crop.w === PROPOSED.w, String(cancelled.crop.w));
  check('and closes the tool', cancelled.tool === null);
  check('and drops the session', cancelled.session === null);

  const done = F.doneTool(edited);
  check('Done keeps the edit', done.crop.w === 500, String(done.crop.w));
  check('and closes the tool', done.tool === null);
  check('and drops the session', done.session === null);
}

console.log('\nCancel survives an edit made in place');
{
  // Not a hypothetical: a crop handed to a gesture and written back is the
  // normal way this state gets edited, and a snapshot that shares the object
  // restores a rect that already moved. The identity check below says so
  // directly; this one demonstrates the consequence.
  const open = F.openTool(fresh(), 'crop');
  const live = { ...open, crop: { x: 1, y: 2, w: 300, h: 400 } };
  const reopened = F.doneTool(live);
  const second = F.openTool(reopened, 'crop');
  second.crop.w = 999; // the drag
  const back = F.cancelTool(second);
  check('Cancel puts back the crop as it was, not as it was dragged to',
    back.crop.w === 300, String(back.crop.w));
  check('the session does not share the live rect',
    second.session.crop !== second.crop);
}

console.log('\nReset goes to the base, which is not where Cancel goes');
{
  // Crop once, apply it, reopen. Cancel now means "back to the crop I applied";
  // Reset means "back to the whole proposed picture". Collapsing the two is
  // what `reset_to_session` does, and it is why both are in the triad.
  const applied = F.doneTool({ ...F.openTool(fresh(), 'crop'), crop: { x: 10, y: 10, w: 600, h: 600 } });
  const again = F.openTool(applied, 'crop');
  const nudged = { ...again, crop: { x: 12, y: 12, w: 590, h: 590 } };

  const reset = F.resetTool(nudged);
  check('Reset goes back to the proposed crop', reset.crop.w === PROPOSED.w, String(reset.crop.w));
  check('and stays in the tool', reset.tool === 'crop', String(reset.tool));

  const cancelled = F.cancelTool(nudged);
  check('Cancel goes back to the applied crop instead', cancelled.crop.w === 600, String(cancelled.crop.w));

  check('Reset is live while the crop differs from the proposal', F.canReset(nudged) === true);
  check('and dead once it matches it', F.canReset(F.resetTool(nudged)) === false);

  check('Reset is dead in a Crop opened on the proposal', F.canReset(F.openTool(fresh(), 'crop')) === false);
  check('Reset is never live with no tool open', F.canReset(fresh()) === false);
}

console.log('\none takeover at a time, and no silent switch');
{
  const open = F.openTool(fresh(), 'crop');
  let threw = false;
  try { F.openTool(open, 'crop'); } catch (e) { threw = true; }
  check('opening Crop over an open Crop is refused, not absorbed', threw);
  let threwStyle = false;
  try { F.openTool(open, 'style'); } catch (e) { threwStyle = true; }
  check('and so is opening Style over it', threwStyle);

  // Style is not a takeover, so leaving it is ordinary.
  const styling = F.openTool(fresh(), 'style');
  const toCrop = F.openTool(styling, 'crop');
  check('Crop opens straight from the Style strip', toCrop.tool === 'crop', String(toCrop.tool));
  check('and gets its own session', toCrop.session !== null && 'crop' in toCrop.session);

  let threwUnknown = false;
  try { F.openTool(fresh(), 'redact'); } catch (e) { threwUnknown = true; }
  check('an unknown tool throws rather than opening an empty bar', threwUnknown);

  check('Cancel with nothing open is a no-op', F.cancelTool(fresh()).tool === null);
  check('Reset with nothing open is a no-op', F.resetTool(fresh()).crop.w === PROPOSED.w);
}

console.log('\nthe padding chips and the padding cardSize uses are one table');
{
  const stops = F.padStops();
  check('there are as many chips as stops', stops.length === Object.keys(PADDING).length, String(stops.length));
  const mismatched = stops.filter((s) => PADDING[s.key] !== s.value);
  check('and every chip carries the value PADDING gives it', mismatched.length === 0,
    mismatched.map((s) => `${s.key}=${s.value} vs ${PADDING[s.key]}`).join(', '));
  check('smallest first', stops[0].value < stops[stops.length - 1].value);
  check('the drag runs from the smallest stop', F.PAD_MIN === Math.min(...Object.values(PADDING)));
  check('to the largest', F.PAD_MAX === Math.max(...Object.values(PADDING)));
}

console.log('\nthe padding drag snaps, clamps, and says which chip lights');
{
  // A real screenshot width, because the snap band is derived from it. 1080 is
  // the fixture the device runs use.
  const W = 1080;
  // One whole pixel of padding, as a fraction. Everything below is stated in
  // these rather than in a snap constant, and that is the point: a pixel is a
  // unit the card and the thumb both have, and a snap constant is a unit
  // neither has. `SNAP` used to be the unit here, which is exactly why a band
  // eight of these wide passed every assertion in this block.
  const PX = 1 / W;

  const near = F.setPadding(PADDING.standard + PX * 0.4, W);
  check('a drag landing under half a pixel off Standard lands exactly on it',
    near.padding === PADDING.standard, String(near.padding));
  check('and lights the chip', near.stop === 'standard', String(near.stop));

  const between = F.setPadding(0.045, W);
  check('a drag between two stops keeps its own value', between.padding === 0.045, String(between.padding));
  check('and lights no chip', between.stop === null, String(between.stop));

  const far = F.setPadding(PADDING.standard + PX * 1.6, W);
  check('a drag a pixel and a half clear of a stop is not pulled onto it',
    far.padding !== PADDING.standard, String(far.padding));

  check('below the range clamps up', F.setPadding(-1, W).padding === F.PAD_MIN, String(F.setPadding(-1, W).padding));
  check('above it clamps down', F.setPadding(9, W).padding === F.PAD_MAX, String(F.setPadding(9, W).padding));
  check('a clamped value still lights its chip', F.setPadding(9, W).stop === 'roomy', String(F.setPadding(9, W).stop));

  // THE ASSERTION THIS FILE WAS MISSING, and the only one here that would have
  // caught what the owner felt. Walk the whole track and measure, in track
  // travel, how far the thumb sits still. A snapped stop is a place the thumb
  // does not move; the rule is that it may not be a place the thumb sits still
  // for LONGER than anywhere else -- and since the card's padding is a whole
  // number of source pixels, everywhere else is one pixel's worth of track.
  const SAMPLES = 20000;
  const span = F.PAD_MAX - F.PAD_MIN;
  const at = (i) => F.setPadding(F.PAD_MIN + (span * i) / SAMPLES, W).padding;
  const runs = [];
  let runStart = 0;
  let prev = at(0);
  for (let i = 1; i <= SAMPLES; i++) {
    const v = at(i);
    if (v !== prev) {
      runs.push({ value: prev, from: runStart, to: i - 1 });
      runStart = i;
      prev = v;
    }
  }
  runs.push({ value: prev, from: runStart, to: SAMPLES });
  // As a percentage of the track, so the number can be held against a thumb
  // rather than being one only this file understands.
  const pct = (r) => ((r.to - r.from + 1) / (SAMPLES + 1)) * 100;
  const stopValues = new Set(F.padStops().map((st) => st.value));
  const atStops = runs.filter((r) => stopValues.has(r.value));
  const onePixel = (PX / span) * 100;

  check('the walk found a still point at every stop', atStops.length === F.padStops().length,
    `${atStops.length} of ${F.padStops().length}`);
  const worst = atStops.reduce((a, b) => (pct(b) > pct(a) ? b : a), { from: 0, to: -1, value: null });
  check('and no stop holds the thumb longer than one pixel of padding does',
    pct(worst) <= onePixel * 1.5,
    `worst stop ${worst.value} holds ${pct(worst).toFixed(2)}% of the track; one pixel of padding is ${onePixel.toFixed(2)}%`);

  // And the band is not merely small, it is the RIGHT set: exactly the values
  // that draw the same card. Any smaller and there is a sliver where the chip
  // is dark beside a card identical to the preset, which is the fault the snap
  // exists to prevent.
  let wrong = 0;
  let firstWrong = null;
  for (let i = 0; i <= SAMPLES; i++) {
    const frac = F.PAD_MIN + (span * i) / SAMPLES;
    const snapped = F.setPadding(frac, W).padding;
    for (const st of F.padStops()) {
      if (padPixels(W, frac) === padPixels(W, st.value) && snapped !== st.value) {
        wrong++;
        if (firstWrong === null) firstWrong = frac;
      }
    }
  }
  check('every value that draws the same card as a stop snaps onto that stop',
    wrong === 0, `${wrong} values, first ${firstWrong}`);

  let threw = false;
  try { F.setPadding(NaN, W); } catch (e) { threw = true; }
  check('a non-number throws rather than producing a NaN card', threw);

  let threwW = false;
  try { F.setPadding(PADDING.standard); } catch (e) { threwW = true; }
  check('and a missing crop width throws rather than picking a band for itself', threwW);
}

console.log('\nthe corner slider cannot leave the card behind');
{
  check('the top of the slider is what compose will accept', F.setRadius(1) === MAX_RADIUS, String(F.setRadius(1)));
  check('the bottom is square', F.setRadius(-1) === 0, String(F.setRadius(-1)));
  check('and a value inside the range is its own', F.setRadius(0.02) === 0.02);
  let threw = false;
  try { F.setRadius(undefined); } catch (e) { threw = true; }
  check('a non-number throws', threw);
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
