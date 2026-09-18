// Every word the app says to a person, in one place.
//
// Not a localisation layer and not an abstraction for its own sake. It is here
// so the copy can be CHECKED: `tools/check-copy.mjs` walks these values and
// fails on the house rules below. Strings scattered through a view can only be
// checked by a regex over source code, which is a signal the data is in the
// wrong place.
//
// THE RULES, from the spec's copy voice section:
//
//   - Name actions by what they do. "Save to Photos", not "Export". Keep the
//     verb the same through the flow, so a "Save" button gives a "Saved"
//     confirmation.
//   - No filler enthusiasm. The interface confirms outcomes plainly.
//   - None of the usual AI-writing tells: no em dashes, no tracked-out capitals,
//     no middle-dot-joined meta strings, no arrow glued to the end of a button.
//   - An empty state is an invitation, not a description of emptiness.
//   - The mask tool is named for its effect. "Cover", never "Inpaint".
//
// Placeholders are `{name}` and are filled by `fill` below, so every value here
// stays a plain string that the gate can read. A template function would put
// half of each sentence in the view again.

export const COPY = {
  // --- the empty state ----------------------------------------------------
  emptyTitle: 'Share in a screenshot, or pick one to get started.',

  // --- actions ------------------------------------------------------------
  choose: 'Choose screenshot',
  cover: 'Cover',
  makeCard: 'Make card',
  share: 'Share',
  startOver: 'Start over',
  close: 'Close',

  // --- what is happening --------------------------------------------------
  working: 'Making your card',
  ready: 'Card ready',
  // Shown under the crop box on the source image. It says what the box is for,
  // which is otherwise guessable only by trying it.
  coverHint: 'Drag the box over anything you want hidden, then make the card.',
  cardSize: '{width} by {height}',

  // --- when something goes wrong ------------------------------------------
  // Each one says what happened and what to do next. None of them mention a
  // stack trace, a path, or a code.
  pickFailed: 'That screenshot could not be opened. Pick another one.',
  renderFailed: 'The card could not be made. Try again.',
  shareFailed: 'This phone has no way to share the card.',
  // The picker's launcher does not survive the activity being recreated, and a
  // release build cannot reload itself to fix it. See src/recover.js.
  pickerStale: 'Close Twitwa and open it again to use the picker.',

  // --- the update banner --------------------------------------------------
  // The old version of this said "Twitwa 1.0.1 is out (you have build 1)".
  // A build number is not a thing anyone holding the app knows about
  // themselves, and the sentence spent its most readable half on it.
  updateTitle: 'Twitwa {version} is available',
  updateGet: 'Get it',
  updateLater: 'Later',

  // --- the developer panel ------------------------------------------------
  // Kept, because every measured number in this repository came out of these
  // buttons, and a measurement you cannot repeat is a measurement you have to
  // take on trust. Hidden, because it is not part of the app.
  devTitle: 'Developer tools',
  devHint: 'Phase 0 and Phase 1 measurements. Not part of the app.',
};

/**
 * Replace `{name}` with `values.name`.
 *
 * An unknown placeholder throws rather than rendering as literal braces on
 * screen. A missing value is a programming error, and the alternative is
 * shipping a button that says "Twitwa {version} is available".
 */
export function fill(template, values = {}) {
  return String(template).replace(/\{([a-zA-Z]+)\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`copy placeholder {${key}} has no value`);
    }
    return String(values[key]);
  });
}
