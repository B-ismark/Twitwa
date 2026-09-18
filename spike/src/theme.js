// The token table, and the only place a colour is written down.
//
// It is plain data with no react-native import, so `contrast.py` can read the
// shipped values straight out of this file and check them, and so a desktop
// test can load it. The spec's Phase 4 note is the reason: run the contrast
// gate against whatever ends up in the theme, not against what a document
// says the theme contains. Those two drifted apart once already, and the
// document was the one everybody read.
//
// WHY EVERY TOKEN HAS TWO VALUES. An earlier single-value table failed WCAG on
// dark on exactly the two most-used colours, which is the worst place for it to
// fail: Graphite is every piece of secondary text and every idle icon, and
// Signal is the primary action. Measured, not guessed:
//
//   Graphite #4B5157 on Ink            2.21:1   fails AA and the 3:1 UI floor
//   Graphite #4B5157 on Surface-dark   1.99:1   fails everything
//   Signal   #3B5BA8 on Ink            2.75:1   fails AA and 3:1
//   Signal   #3B5BA8 on Surface-dark   2.47:1   fails everything
//
// The dark values below clear 4.5:1 on both dark grounds. `contrast.py` asserts
// that and exits 1 if it stops being true.
//
// ONE CONTRAST REQUIREMENT IS NOT IN HERE AND CANNOT BE. The crop handles sit
// on the user's own screenshot, so no pair of tokens describes them: a blue
// handle on a blue photo is invisible. They are drawn as a white core with a
// dark outline, which reads on any pixels underneath, and that is checked on a
// device rather than by a ratio.

/**
 * Paper/Ink, Surface, Hairline, Graphite and Signal, per the spec's table.
 * Keyed by role rather than by name so a component never picks the light value
 * while running dark.
 */
const PALETTE = {
  light: {
    background: '#F6F4EF', // Paper
    surface: '#FFFFFF',
    hairline: 'rgba(0,0,0,0.08)',
    text: '#15181D', // Ink
    graphite: '#4B5157',
    signal: '#3B5BA8',
    // The label on a Signal-filled button. It is a token because it cannot
    // be a constant: Signal-dark is a PALE blue, so white on it measures
    // 2.78:1 and is unreadable. contrast.py caught that on its first run
    // against this file, with the button already written to draw white.
    onSignal: '#FFFFFF',
    // The ground behind the image while it is being cropped. Deliberately not
    // the app background: a screenshot needs a neutral surround, and Paper
    // tints the edges of a light screenshot enough to misjudge the crop.
    stage: '#0E1013',
    // Text ON the stage. The stage is dark in BOTH themes, so these two are
    // the same in both: a component running light that reached for `graphite`
    // here measured 2.37:1 and was unreadable, which is exactly what happened
    // to the empty-state message and to the developer log. Having them as
    // tokens is what lets contrast.py check the pair at all.
    onStage: '#F6F4EF',
    onStageMuted: '#949BA2',
  },
  dark: {
    background: '#15181D', // Ink
    surface: '#1E2228',
    hairline: 'rgba(255,255,255,0.10)',
    text: '#F6F4EF', // Paper
    graphite: '#949BA2',
    signal: '#7C9AE0',
    onSignal: '#15181D',
    stage: '#0E1013',
    onStage: '#F6F4EF',
    onStageMuted: '#949BA2',
  },
};

/** One scale, so spacing is chosen from a list rather than typed per view. */
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

/** Corner radii. `pill` is deliberately larger than any island is tall. */
export const RADIUS = { sm: 8, md: 12, lg: 20, pill: 999 };

/**
 * Type scale. The platform font throughout, per the spec: the card carries no
 * app-drawn text, only the user's own pixels, so there is nothing to bundle and
 * nothing that has to match across platforms.
 */
export const TYPE = {
  title: { fontSize: 20, fontWeight: '600' },
  body: { fontSize: 15, fontWeight: '400' },
  label: { fontSize: 15, fontWeight: '600' },
  caption: { fontSize: 13, fontWeight: '400' },
  mono: { fontSize: 10, fontFamily: 'monospace' },
};

/** Minimum touch target, in points. Below this a control is decoration. */
export const TOUCH = 44;

/**
 * The palette for a scheme name, defaulting to dark.
 *
 * `useColorScheme()` returns null before the first native read and on a device
 * with no preference, so the default is not decoration: without it every colour
 * is `undefined` for one frame and the whole screen renders transparent.
 */
export function paletteFor(scheme) {
  return scheme === 'light' ? PALETTE.light : PALETTE.dark;
}
