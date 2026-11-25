// What to do with the answer the native share-in module gives. Pure: no
// react-native, no Expo, so it loads in node and has a test. The native half
// is modules/twitwa-share-in, and the I/O around both lives in App.js.
//
// The native module answers one of three ways:
//
//   { status: 'none' }                                 nothing was shared
//   { status: 'ok', uris, uri, mime, bytes,
//     count, skipped }                                 copies in our cache
//   { status: 'rejected', reason, count }              a share we cannot use
//
// `uris` are the file:// copies in the order shared (up to the native cap),
// `uri` is the first, `mime` and `bytes` describe it, `count` is how many
// pictures the share held and `skipped` how many of those were not copied.
//
// and App.js can also hand this `null`, when the module is not linked into the
// build at all. That case is the one worth being careful about: it looks
// exactly like "nothing was shared", and it is the case where the share sheet
// offers Twitwa and choosing it silently does nothing. It gets its own reason
// so the log says which of the two it was.
import { COPY } from './copy.js';
import { enqueue, skippedNotice, takeNext } from './queue.js';

/**
 * The one shape App.js acts on:
 *
 *   { action: 'open', uri, uris, skipped }   uris[0] === uri; skipped is a count
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
    // will read. Every one of the list, not only the first.
    const isFile = (u) => typeof u === 'string' && u.startsWith('file://');
    // A single-picture answer without a list is still understood.
    const uris = answer.uris === undefined ? [answer.uri] : answer.uris;
    if (!isFile(answer.uri) || !Array.isArray(uris) || uris.length === 0
        || !uris.every(isFile) || uris[0] !== answer.uri) {
      return { action: 'problem', message: COPY.sharedFailed, reason: 'bad-answer' };
    }
    const skipped = Number.isInteger(answer.skipped) && answer.skipped > 0 ? answer.skipped : 0;
    return { action: 'open', uri: answer.uri, uris: uris.slice(), skipped };
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

// One way a plan can end: which picture opens (or null), what the queue is
// afterwards, which files to delete, and the notice to show.
function leaf(open, queue, drop, skipped) {
  return { open, queue, drop, notice: skippedNotice(skipped) };
}

/**
 * What a share's pictures do to the editor and to the queue behind it.
 *
 * @param uris     the copies native take() made, in order; uris[0] is the one
 *                 that opens
 * @param skipped  how many pictures of the share were not copied
 * @param dirty    does the card on screen hold changes nobody kept?
 * @param queue    the pictures already waiting
 *
 *   { act: 'open', open, queue, drop, notice }     nothing to lose: open it
 *   { act: 'ask', keep:    {open: null, queue, drop, notice},
 *                 replace: {open, queue, drop, notice} }
 *
 * Keep editing queues all of them; Replace opens the first and queues the
 * rest. A second share appends, it never replaces what already waits. What
 * the queue's cap refuses is in `drop` (files to delete) and is counted into
 * the notice with the native skips. `drop` never names the file that opens.
 */
export function arrivalPlan({ uris, skipped = 0, dirty, queue = [] }) {
  const first = uris[0];
  const opens = enqueue(queue, uris, first);
  const open = leaf(first, opens.queue, opens.dropped, skipped + opens.dropped.length);
  if (!dirty) return { act: 'open', ...open };
  const keeps = enqueue(queue, uris, null);
  return {
    act: 'ask',
    keep: leaf(null, keeps.queue, keeps.dropped, skipped + keeps.dropped.length),
    replace: open,
  };
}

/**
 * The next queued picture, now: the chip's tap, and a card that was closed.
 * `act: 'none'` when nothing waits. Same ask as a fresh share when the card
 * has unkept changes; Keep editing leaves the queue exactly as it was.
 */
export function advancePlan({ dirty, queue = [] }) {
  const { next, rest } = takeNext(queue);
  if (next === null) return { act: 'none' };
  const open = leaf(next, rest, [], 0);
  if (!dirty) return { act: 'open', ...open };
  return { act: 'ask', keep: leaf(null, queue.slice(), [], 0), replace: open };
}
