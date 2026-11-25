// Tests for src/queue.js.
//
//   for b in $(grep -o "BREAK [!=]== '[a-z_0-9]*'" src/queue.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/queue.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
import * as real from './queue.js';
import { COPY, fill } from './copy.js';

const BREAK = process.env.BREAK || '';
let { enqueue, takeNext, dropAll, keepList, queueCount, waitingLabel, skippedNotice } = real;

if (BREAK === 'enqueue_keeps_opening') {
  // The picture being opened is queued too, so it would open twice.
  enqueue = (q, u) => real.enqueue(q, u, null);
} else if (BREAK === 'enqueue_no_cap') {
  enqueue = (q, u, o) => ({ queue: q.concat(u.filter((x) => x !== o)), dropped: [] });
} else if (BREAK === 'enqueue_cap_off_by_one') {
  enqueue = (q, u, o) => {
    const out = q.slice(); const dropped = [];
    for (const x of u) { if (x === o) continue; if (out.length <= real.MAX_QUEUE) out.push(x); else dropped.push(x); }
    return { queue: out, dropped };
  };
} else if (BREAK === 'enqueue_forgets_dropped') {
  enqueue = (q, u, o) => ({ queue: real.enqueue(q, u, o).queue, dropped: [] });
} else if (BREAK === 'enqueue_newest_first') {
  enqueue = (q, u, o) => { const r = real.enqueue(q, u, o); return { ...r, queue: r.queue.slice().reverse() }; };
} else if (BREAK === 'enqueue_replaces') {
  enqueue = (q, u, o) => real.enqueue([], u, o);
} else if (BREAK === 'enqueue_duplicates') {
  enqueue = (q, u, o) => ({ queue: q.concat(u.filter((x) => x !== o)).slice(0, real.MAX_QUEUE), dropped: [] });
} else if (BREAK === 'next_takes_last') {
  takeNext = (q) => (q.length ? { next: q[q.length - 1], rest: q.slice(0, -1) } : { next: null, rest: [] });
} else if (BREAK === 'next_keeps_next') {
  takeNext = (q) => (q.length ? { next: q[0], rest: q.slice() } : { next: null, rest: [] });
} else if (BREAK === 'next_empty_undefined') {
  takeNext = (q) => (q.length ? real.takeNext(q) : { next: undefined, rest: [] });
} else if (BREAK === 'next_mutates') {
  takeNext = (q) => { const next = q.length ? q.shift() : null; return { next, rest: q }; };
} else if (BREAK === 'dropall_keeps_one') {
  dropAll = (q) => ({ queue: q.slice(0, 1), dropped: q.slice(1) });
} else if (BREAK === 'dropall_forgets_files') {
  dropAll = () => ({ queue: [], dropped: [] });
} else if (BREAK === 'keep_forgets_shown') {
  keepList = (s, q) => real.keepList(null, q);
} else if (BREAK === 'keep_forgets_queue') {
  keepList = (s) => real.keepList(s, []);
} else if (BREAK === 'keep_nulls') {
  keepList = (s, q) => [s, ...q];
} else if (BREAK === 'keep_duplicates') {
  keepList = (s, q) => [s, ...q].filter((u) => typeof u === 'string');
} else if (BREAK === 'count_off_by_one') {
  queueCount = (q) => q.length + 1;
} else if (BREAK === 'label_always_plural') {
  waitingLabel = (q) => (q.length ? fill(COPY.waitingMany, { count: q.length }) : null);
} else if (BREAK === 'label_empty_shows') {
  waitingLabel = (q) => (q.length === 1 ? COPY.waitingOne : fill(COPY.waitingMany, { count: q.length }));
} else if (BREAK === 'label_no_count') {
  waitingLabel = (q) => (q.length === 0 ? null : COPY.waitingOne);
} else if (BREAK === 'skipped_zero_shows') {
  skippedNotice = (n) => fill(COPY.skipped, { count: n });
} else if (BREAK === 'skipped_nan_shows') {
  skippedNotice = (n) => (n > 0 || Number.isNaN(n) ? fill(COPY.skipped, { count: n }) : null);
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}
const j = JSON.stringify;
const f = (n) => `file:///cache/shared-in/${n}.png`;
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(f);
const many = (n, p = 'q') => Array.from({ length: n }, (_, i) => f(`${p}${i}`));

console.log('enqueue');
{
  const r = enqueue([], [A, B, C], A);
  check('the picture being opened is left out', j(r.queue) === j([B, C]), j(r.queue));
  check('nothing is dropped under the cap', r.dropped.length === 0);
  const all = enqueue([], [A, B], null);
  check('with nothing opening, all are queued', j(all.queue) === j([A, B]), j(all.queue));
  const behind = enqueue([A], [B, C], null);
  check('a second share goes behind the first, in order', j(behind.queue) === j([A, B, C]), j(behind.queue));
  const input = [A];
  enqueue(input, [B], null);
  check('the input is not changed', j(input) === j([A]));
  const dup = enqueue([A, B], [B, C], null);
  check('a picture already queued is not queued twice', j(dup.queue) === j([A, B, C]), j(dup.queue));
  check('...and is not counted as dropped', dup.dropped.length === 0);
  const ten = enqueue([], many(10), null);
  check('ten fit', ten.queue.length === 10 && ten.dropped.length === 0, `${ten.queue.length}/${ten.dropped.length}`);
  const eleven = enqueue([], many(11), null);
  check('the eleventh is refused', eleven.queue.length === 10 && j(eleven.dropped) === j([many(11)[10]]), `${eleven.queue.length}/${j(eleven.dropped)}`);
  check('...the cap is the exported number', real.MAX_QUEUE === 10);
  const over = enqueue(many(8), many(5, 'n'), null);
  check('a share onto a part-full queue fills it and drops the rest', over.queue.length === 10 && over.dropped.length === 3, `${over.queue.length}/${over.dropped.length}`);
  check('...the oldest stay, the newest overflow', over.queue[7] === many(8)[7] && over.queue[8] === many(5, 'n')[0] && j(over.dropped) === j(many(5, 'n').slice(2)), j(over.dropped));
  const full = enqueue(many(10), [A], null);
  check('a full queue refuses everything', full.queue.length === 10 && j(full.dropped) === j([A]));
  const openingFull = enqueue(many(10), [A, B], A);
  check('the opening picture never counts against the cap', openingFull.dropped.length === 1 && openingFull.dropped[0] === B, j(openingFull.dropped));
}

console.log('\ntakeNext');
{
  const r = takeNext([A, B, C]);
  check('the first in is the next', r.next === A, r.next);
  check('...and the rest stay in order', j(r.rest) === j([B, C]), j(r.rest));
  const one = takeNext([A]);
  check('the last one leaves an empty queue', one.next === A && one.rest.length === 0, j(one));
  const none = takeNext([]);
  check('an empty queue has no next, and it is null', none.next === null && none.rest.length === 0, j(none));
  const input = [A, B];
  takeNext(input);
  check('the input is not changed', j(input) === j([A, B]), j(input));
}

console.log('\ndropAll');
{
  const r = dropAll([A, B]);
  check('empties the queue', r.queue.length === 0, j(r.queue));
  check('...and names every file to delete', j(r.dropped) === j([A, B]), j(r.dropped));
  check('an empty queue drops nothing', dropAll([]).dropped.length === 0);
}

console.log('\nkeepList: what native take() must not delete');
{
  const r = keepList(A, [B, C]);
  check('the picture on screen and the whole queue', j(r) === j([A, B, C]), j(r));
  check('nothing on screen -> just the queue', j(keepList(null, [B])) === j([B]), j(keepList(null, [B])));
  check('an empty editor and queue keep nothing', keepList(null, []).length === 0);
  check('...an undefined one too', keepList(undefined, []).length === 0);
  check('the same file twice is listed once', j(keepList(A, [A, B])) === j([A, B]), j(keepList(A, [A, B])));
}

console.log('\nthe chip');
{
  check('the count is the length', queueCount([A, B, C]) === 3 && queueCount([]) === 0);
  check('nothing waiting -> no chip', waitingLabel([]) === null, waitingLabel([]));
  check('one -> singular', waitingLabel([A]) === COPY.waitingOne, waitingLabel([A]));
  check('two -> plural with the count', waitingLabel([A, B]) === '2 screenshots waiting', waitingLabel([A, B]));
  check('ten -> plural with the count', waitingLabel(many(10)) === '10 screenshots waiting', waitingLabel(many(10)));
}

console.log('\nthe skipped notice');
{
  check('none skipped -> no notice', skippedNotice(0) === null, skippedNotice(0));
  check('a missing count -> no notice', skippedNotice(undefined) === null && skippedNotice(NaN) === null);
  check('a negative count -> no notice', skippedNotice(-1) === null);
  check('one -> the sentence with 1', skippedNotice(1) === "Skipped 1 that couldn't be opened", skippedNotice(1));
  check('three -> the sentence with 3', skippedNotice(3) === "Skipped 3 that couldn't be opened", skippedNotice(3));
  check('a fractional count -> no notice', skippedNotice(1.5) === null);
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
