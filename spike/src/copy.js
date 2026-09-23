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
//
// Placeholders are `{name}` and are filled by `fill` below, so every value here
// stays a plain string that the gate can read. A template function would put
// half of each sentence in the view again.

export const COPY = {
  // --- the empty state ----------------------------------------------------
  emptyTitle: 'Share in a screenshot, or pick one to get started.',

  // --- actions ------------------------------------------------------------
  choose: 'Choose screenshot',
  share: 'Share',
  // The two other ways out, in the More menu. "Save to Photos" confirms as
  // "Saved to Photos", per the rule at the top: the verb survives the flow.
  save: 'Save to Photos',
  // The same action on the main bar, beside Share. "Save to Photos" wrapped
  // to two lines there on a 1440-wide Pixel (2026-09-23); the toast still
  // says "Saved to Photos", so the verb survives the flow.
  saveShort: 'Save',
  copyImage: 'Copy image',
  startOver: 'Start over',
  close: 'Close',
  // The overflow behind the three dots. Named for what it holds rather than
  // for its shape, because "More" is what a person reads and "overflow" is
  // what a layout engine calls it.
  more: 'More',

  // --- the two tools ------------------------------------------------------
  // There is no "Make card". The card is on the canvas from the moment a
  // screenshot arrives, so a button that makes one has nothing to do; see
  // BUILD-PLAN.md Phase 4.5. The string was removed rather than hidden,
  // because a dead string is the next reader's evidence that a step exists.
  crop: 'Crop',
  style: 'Style',

  // The triad a takeover tool returns through. Cancel undoes this session,
  // Reset goes back to the proposed crop, Done keeps.
  cancel: 'Cancel',
  reset: 'Reset',
  done: 'Done',

  // --- the Style strip ----------------------------------------------------
  padding: 'Padding',
  corners: 'Corners',
  background: 'Background',
  // The three padding stops. Named, not measured: "6%" is a number about the
  // card's construction and tells nobody how the card will look.
  snug: 'Snug',
  standard: 'Standard',
  roomy: 'Roomy',
  // The three frames. Match is first because it is the product.
  matchFrame: 'Match',
  paperFrame: 'Paper',
  inkFrame: 'Ink',

  // --- what is happening --------------------------------------------------
  working: 'Making your card',
  // There is no 'Card ready' any more. It was the caption of the state that
  // followed the Make card button, and with the card live from the moment a
  // screenshot arrives there is no moment at which it becomes ready. The
  // caption carries the card's size instead, which is a fact rather than an
  // announcement.
  // Shown while a takeover tool is open. It says what the thumb is for, which
  // is otherwise guessable only by trying it.
  cropHint: 'Drag the edges to choose what the card shows.',
  cardSize: '{width} by {height}',

  // --- when something goes wrong ------------------------------------------
  // Each one says what happened and what to do next. None of them mention a
  // stack trace, a path, or a code.
  pickFailed: 'That screenshot could not be opened. Pick another one.',
  renderFailed: 'The card could not be made. Try again.',
  shareFailed: 'This phone has no way to share the card.',
  saveFailed: 'The card could not be saved to Photos. Try Share instead.',
  copyFailed: 'The card could not be copied. Try Share instead.',
  // Receiving a share. Only the two a person can act on differently get their
  // own sentence; see src/sharein.js.
  sharedFailed: 'The shared picture could not be opened. Choose it here instead.',
  sharedNotImage: 'Twitwa can only make a card from a picture.',
  sharedTooBig: 'That picture is too large to open.',
  sharedFirstOnly: 'Opened the first of {count} pictures. Twitwa makes one card at a time.',
  saved: 'Saved to Photos',
  copied: 'Copied',
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
  // While Twitwa downloads the update itself. See src/update.js.
  updateDownloading: 'Downloading {percent}%',
  updateStarting: 'Downloading',
  updateFailed: 'The update did not download. Try again later.',
  updateMismatch: 'The download did not match the release, so it was not installed.',
  updateNoInstaller: 'This phone could not open the installer.',

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
