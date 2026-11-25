// What to do with the answer the native share-in module gives. Pure: no
// react-native, no Expo, so it loads in node and has a test. The native half
// is modules/twitwa-share-in, and the I/O around both lives in App.js.
//
// The native module answers one of three ways:
//
//   { status: 'none' }                                 nothing was shared
//   { status: 'ok', uri, mime, bytes, count }          a copy in our cache
//   { status: 'rejected', reason, count }              a share we cannot use
//
// and App.js can also hand this `null`, when the module is not linked into the
// build at all. That case is the one worth being careful about: it looks
// exactly like "nothing was shared", and it is the case where the share sheet
// offers Twitwa and choosing it silently does nothing. It gets its own reason
// so the log says which of the two it was.
import { COPY, fill } from './copy.js';

/**
 * The one shape App.js acts on:
 *
 *   { action: 'open', uri, notice }   notice is a sentence, or null
 *   { action: 'problem', message, reason }
 *   { action: 'ignore', reason }
 */
export function shareOutcome(answer, available = true) {
  if (!available) return { action: 'ignore', reason: 'module-missing' };
  if (answer == null || typeof answer !== 'object') return { action: 'ignore', reason: 'no-answer' };

  if (answer.status === 'none') return { action: 'ignore', reason: 'none' };

  if (answer.status === 'ok') {
    // A file:// URI in our own cache, and nothing else. The native side
    // refuses anything else before copying; checking again here is what
    // stops a change on that side from quietly widening what the renderer
    // will read.
    if (typeof answer.uri !== 'string' || !answer.uri.startsWith('file://')) {
      return { action: 'problem', message: COPY.sharedFailed, reason: 'bad-answer' };
    }
    const count = Number.isInteger(answer.count) ? answer.count : 1;
    return {
      action: 'open',
      uri: answer.uri,
      // Twitwa makes one card. A share of several pictures opens the first
      // and says so, rather than dropping the rest without a word.
      notice: count > 1 ? fill(COPY.sharedFirstOnly, { count }) : null,
    };
  }

  if (answer.status === 'rejected') {
    return { action: 'problem', message: rejectedMessage(answer.reason), reason: String(answer.reason) };
  }

  return { action: 'problem', message: COPY.sharedFailed, reason: `unknown status ${String(answer.status)}` };
}

// Only the reasons a person can act on differently get their own words. Every
// other reason -- unreadable, no-stream, scheme, empty, no-context -- means
// "that did not work, try another way", and one sentence says that.
function rejectedMessage(reason) {
  if (reason === 'not-image') return COPY.sharedNotImage;
  if (reason === 'too-big') return COPY.sharedTooBig;
  return COPY.sharedFailed;
}

/**
 * What an arriving picture does to the editor and to the one waiting behind it.
 *
 * @param uri      the copy in our cache (a share's, or the waiting one on a
 *                 second try from the chip)
 * @param dirty    does the card on screen hold changes nobody kept?
 * @param waiting  the picture already shelved, or null
 *
 *   { act: 'open',  waiting, drop }               nothing to lose: open it
 *   { act: 'ask', keep: {waiting, drop},
 *                 replace: {waiting, drop} }      ask; each answer says what
 *                                                 happens to the shelf
 *
 * `drop` is a file to delete. Newest wins, so a picture that is shelved while
 * another one is already waiting deletes the older file; one waiting copy is
 * all the cache holds, and the native take() does the same on its side. The
 * file shelved AGAIN (the chip, answered Keep editing a second time) is never
 * its own `drop`, or declining twice would delete the picture.
 *
 * Only one picture is ever shelved, because the native module copies only the
 * first of a multi-picture share (see the Kotlin's `copy`); a queue would have
 * nothing to hold the rest.
 */
export function arrivalPlan({ uri, dirty, waiting = null }) {
  const older = waiting && waiting !== uri ? waiting : null;
  if (!dirty) return { act: 'open', waiting: null, drop: older };
  return {
    act: 'ask',
    // Keep editing: this picture waits.
    keep: { waiting: uri, drop: older },
    // Replace: it opens, and any older one is gone with the card it was for.
    replace: { waiting: null, drop: older },
  };
}

/** The chip's label key, or null when nothing waits. */
export function waitingChip(waiting) {
  return waiting ? COPY.waitingOne : null;
}
