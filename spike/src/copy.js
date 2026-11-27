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
  // The app's name, set large over the panel. A word the screen says, so it is here.
  wordmark: 'Twitwa',
  // In the welcome panel: points at the one Choose button, and names the other
  // way in (sharing), which nothing else on the screen shows.
  emptyShareHint: 'Choose one below, or share a screenshot to Twitwa from any app.',

  // --- actions ------------------------------------------------------------
  choose: 'Choose screenshot',
  share: 'Share',
  // Save, on the main bar beside Share. It was "Save to Photos" in the More
  // menu; that label wrapped to two lines on the bar on a 1440-wide Pixel
  // (2026-09-23), and More no longer holds it. The toast still says "Saved to
  // Photos", so the verb survives the flow.
  saveShort: 'Save',
  copyImage: 'Copy image',
  // A switch row in More. Share and Save follow it; Copy is always PNG.
  saveAsJpeg: 'Save as JPEG',
  switchOn: 'On',
  switchOff: 'Off',
  // Opens the picker from the editor. Replaced "Start over", whose only other
  // job, getting back to the empty screen, Back now does.
  newShot: 'New screenshot',
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

  // --- leaving with work on screen -----------------------------------------
  // Asked by Back and by New screenshot, and only when the card changed since it
  // was opened or last shared, saved or copied; see backAction in src/shell.js.
  // The destructive button says what it destroys, and the safe one is the
  // way back to what the person was doing.
  discardCardTitle: 'Discard this card?',
  discardCardBody: 'Your crop and style changes will be lost.',
  discardCropTitle: 'Discard this crop?',
  discardCropBody: 'The crop goes back to how it was when you opened it.',
  discard: 'Discard',
  keepEditing: 'Keep editing',
  // A share arriving over a card with unsaved changes.
  replaceCardTitle: 'Replace this card?',
  replaceCardBody: 'The screenshot you shared takes its place, and the changes to this one will be lost.',
  replace: 'Replace',
  // Pictures from a share that are queued behind the one on screen (several
  // at once, or one kept over unsaved work). The chip opens the next by the
  // same ask as a fresh share. Chosen by waitingLabel in src/queue.js.
  waitingOne: '1 screenshot waiting',
  waitingMany: '{count} screenshots waiting',
  // A multi-picture share where some could not be copied. The English reads
  // the same at 1 and at 3, so there is one sentence; skippedNotice in
  // src/queue.js leaves it out at zero.
  skipped: "Skipped {count} that couldn't be opened",

  // --- opening a picture --------------------------------------------------
  // While a share is copied or a pick is decoded, and while a launch looks for
  // either. It says what is happening, not that the app is busy.
  importing: 'Opening your screenshot',
  // After a launch that found no share and brought back the last card.
  restored: 'Picked up where you left off.',

  // --- the Style strip ----------------------------------------------------
  padding: 'Padding',
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
  // The six tones on the row under them. Swatch labels are the bare name, like
  // the three above; the swatch's selected state says the rest.
  skyFrame: 'Sky',
  mintFrame: 'Mint',
  sandFrame: 'Sand',
  plumFrame: 'Plum',
  slateFrame: 'Slate',
  midnightFrame: 'Midnight',
  // The custom row under the tones. Its discs carry no caption (a hex under a
  // 48dp disc would outgrow it at the largest font), so these are what
  // TalkBack says. {hex} is filled by `fill` as the six digits, #RRGGBB.
  addColour: 'Add a colour',
  customColour: 'Your colour, {hex}',
  removeColourTitle: 'Remove this colour?',
  removeColour: 'Remove',
  removeColourAction: 'Remove this colour',
  // The mixer that replaces the Background block while a colour is made.
  newColour: 'New colour',
  add: 'Add',
  hue: 'Hue',
  strength: 'Strength',
  shade: 'Shade',

  // --- what is happening --------------------------------------------------
  working: 'Making your card',
  // There is no 'Card ready' any more. It was the caption of the state that
  // followed the Make card button, and with the card live from the moment a
  // screenshot arrives there is no moment at which it becomes ready. Nor is
  // there a card size: "1080 by 2173" was removed on 2026-09-23, and at rest
  // the caption says nothing.
  // Shown while a takeover tool is open. It says what the thumb is for, which
  // is otherwise guessable only by trying it.
  cropHint: 'Drag the edges to choose what the card shows.',

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
  saved: 'Saved to Photos',
  // The button on that notice: opens the card in the gallery.
  viewSaved: 'View',
  viewFailed: 'The card could not be opened. Find it in your gallery.',
  // Save tapped again on a card that has not changed since it was saved.
  alreadySavedTitle: 'Already in Photos',
  alreadySavedBody: 'This card is saved and nothing has changed since. Save another copy?',
  alreadySavedOk: 'OK',
  saveAgain: 'Save again',
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
  devParity: 'Encoder parity',
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
