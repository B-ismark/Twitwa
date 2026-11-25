// The pictures of a multi-image share that are waiting their turn. Pure: an
// array of file:// URIs in, an array out, so it loads in node and has a test.
// The I/O (deleting files, opening the next one) is App.js's.
//
// Twitwa makes one card at a time, so a share of several pictures opens the
// first and queues the rest. The native module copies up to its own MAX_ITEMS
// into the cache and `take` is told which of those copies to keep (keepList),
// so the queue's files survive every later take.
//
// THE CAP. The queue holds MAX_QUEUE and no more, however many shares feed
// it. What does not fit is not shelved, and the caller deletes its files
// (`dropped`) and counts it as skipped, so a person is told rather than left
// to find out that picture eleven never arrived. The picture on screen is not
// in the queue and does not count against it.
//
// A restored session (P1) does NOT restore a queue: it is in memory only,
// and its files are not guaranteed to survive a process death.
import { COPY, fill } from './copy.js';

export const MAX_QUEUE = 10;

/**
 * Add `uris` behind what is already queued.
 *
 * @param opening the uri being opened right now, if any. It is the card, not a
 *                waiting picture, so it is left out.
 * @returns {{queue: string[], dropped: string[]}} `dropped` is what the cap
 *          refused; the caller deletes those files.
 */
export function enqueue(queue, uris, opening = null) {
  const out = queue.slice();
  const dropped = [];
  for (const u of uris) {
    if (u === opening || out.includes(u) || dropped.includes(u)) continue;
    if (out.length < MAX_QUEUE) out.push(u);
    else dropped.push(u);
  }
  return { queue: out, dropped };
}

/** The picture to open next and what stays behind it. */
export function takeNext(queue) {
  if (queue.length === 0) return { next: null, rest: [] };
  return { next: queue[0], rest: queue.slice(1) };
}

/** Empty the queue; `dropped` is every file that was in it. */
export function dropAll(queue) {
  return { queue: [], dropped: queue.slice() };
}

/**
 * What native take() is told to keep: the picture on screen and everything
 * queued behind it. Anything else in the cache directory is deleted.
 */
export function keepList(shownUri, queue) {
  const out = [];
  for (const u of [shownUri, ...queue]) {
    if (typeof u === 'string' && u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** The chip's count. */
export function queueCount(queue) {
  return queue.length;
}

/** The chip's label, or null when nothing waits. */
export function waitingLabel(queue) {
  const n = queueCount(queue);
  if (n <= 0) return null;
  return n === 1 ? COPY.waitingOne : fill(COPY.waitingMany, { count: n });
}

/** "Skipped N that couldn't be opened", or null when nothing was skipped. */
export function skippedNotice(n) {
  if (!Number.isInteger(n) || n <= 0) return null;
  return fill(COPY.skipped, { count: n });
}
