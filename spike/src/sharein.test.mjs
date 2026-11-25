// Tests for src/sharein.js.
//
//   for b in $(grep -o "BREAK [!=]== '[a-z_0-9]*'" src/sharein.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/sharein.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// The native half cannot run here. What CAN be checked from a desktop is the
// contract between the two: the module name, the event name, the keys of the
// answer, and the reason strings src/sharein.js gives their own words must all
// be ones the Kotlin actually uses. That is read out of the Kotlin source,
// which is the kind of transcript-of-the-data check this repo usually calls
// the wrong instrument. The exception is named: the data lives in a language
// node cannot load, and every one of these drifting is silent. A renamed event
// means a share to the running app does nothing; a renamed module means every
// share does nothing; a renamed key means the useful sentence becomes the
// generic one. None of them fails anything.
//
// The `kt_*` and `io_*` mutants edit the real source text in memory, so they
// prove the contract checks can see a real drift, not only a mocked one.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as real from './sharein.js';
import { COPY } from './copy.js';
import { skippedNotice } from './queue.js';

const BREAK = process.env.BREAK || '';
let shareOutcome = real.shareOutcome;
let arrivalPlan = real.arrivalPlan;
let advancePlan = real.advancePlan;

if (BREAK === 'missing_is_none') {
  // A build without the module reads as "nothing shared". This is the silent
  // case: the share sheet offers Twitwa and choosing it does nothing.
  shareOutcome = (answer, available = true) =>
    (!available ? { action: 'ignore', reason: 'none' } : real.shareOutcome(answer, available));
} else if (BREAK === 'any_uri') {
  // Open whatever URI the native side hands over, content:// included, which
  // is the grant that can expire before the card is exported.
  shareOutcome = (answer, available = true) =>
    (answer && answer.status === 'ok' && typeof answer.uri === 'string'
      ? { action: 'open', uri: answer.uri, uris: [answer.uri], skipped: 0 }
      : real.shareOutcome(answer, available));
} else if (BREAK === 'drop_the_rest_silently') {
  // Open the first of several pictures and lose the rest.
  shareOutcome = (answer, available = true) => {
    const r = real.shareOutcome(answer, available);
    return r.action === 'open' ? { ...r, uris: [r.uri] } : r;
  };
} else if (BREAK === 'skipped_forgotten') {
  // Pictures that could not be copied are not reported.
  shareOutcome = (answer, available = true) => {
    const r = real.shareOutcome(answer, available);
    return r.action === 'open' ? { ...r, skipped: 0 } : r;
  };
} else if (BREAK === 'rest_unchecked') {
  // Only the first URI is checked to be a file:// one.
  shareOutcome = (answer, available = true) => {
    if (answer && answer.status === 'ok' && Array.isArray(answer.uris)
        && typeof answer.uri === 'string' && answer.uri.startsWith('file://')) {
      return { action: 'open', uri: answer.uri, uris: answer.uris.slice(), skipped: 0 };
    }
    return real.shareOutcome(answer, available);
  };
} else if (BREAK === 'every_reject_generic') {
  // One sentence for every refusal, so "that was a video" reads as a fault.
  shareOutcome = (answer, available = true) => {
    const r = real.shareOutcome(answer, available);
    return r.action === 'problem' ? { ...r, message: COPY.sharedFailed } : r;
  };
} else if (BREAK === 'unknown_status_ignored') {
  // A status nobody expected is swallowed instead of reported.
  shareOutcome = (answer, available = true) =>
    (answer && typeof answer === 'object' && !['ok', 'none', 'rejected'].includes(answer.status)
      ? { action: 'ignore', reason: 'unknown' }
      : real.shareOutcome(answer, available));
} else if (BREAK === 'uri_includes') {
  // Accept any URI with file:// somewhere in it.
  shareOutcome = (answer, available = true) =>
    (answer && answer.status === 'ok' && typeof answer.uri === 'string' && answer.uri.includes('file://')
      ? { action: 'open', uri: answer.uri, uris: [answer.uri], skipped: 0 }
      : real.shareOutcome(answer, available));
} else if (BREAK === 'no_answer_is_none') {
  // A null reply logged as "nothing shared", so the log cannot tell them apart.
  shareOutcome = (answer, available = true) =>
    (available && answer == null ? { action: 'ignore', reason: 'none' } : real.shareOutcome(answer, available));
} else if (BREAK === 'bad_answer_unlabelled') {
  // The refusal of a non-file URI logged under a generic reason.
  shareOutcome = (answer, available = true) => {
    const r = real.shareOutcome(answer, available);
    return r.reason === 'bad-answer' ? { ...r, reason: 'rejected' } : r;
  };
} else if (BREAK === 'first_not_first') {
  // The list's order is not the order shared: the opened picture is the last.
  shareOutcome = (answer, available = true) => {
    const r = real.shareOutcome(answer, available);
    return r.action === 'open' ? { ...r, uri: r.uris[r.uris.length - 1] } : r;
  };
}

// arrivalPlan / advancePlan: a share over unsaved work is kept, not deleted,
// and the pictures behind the first are queued, not dropped.
if (BREAK === 'plan_always_opens') {
  // Replaces the card without asking, as a clean card would.
  arrivalPlan = (a) => real.arrivalPlan({ ...a, dirty: false });
} else if (BREAK === 'plan_never_asks_when_clean_inverted') {
  // Asks over a card nobody changed.
  arrivalPlan = (a) => real.arrivalPlan({ ...a, dirty: true });
} else if (BREAK === 'plan_keep_forgets') {
  // Keep editing queues nothing new: the old behaviour, which deleted them.
  arrivalPlan = (a) => {
    const r = real.arrivalPlan(a);
    return r.act === 'ask' ? { ...r, keep: { ...r.keep, queue: a.queue ?? [] } } : r;
  };
} else if (BREAK === 'plan_replaces_queue') {
  // A second share throws away what already waits (the old newest-wins).
  arrivalPlan = (a) => real.arrivalPlan({ ...a, queue: [] });
} else if (BREAK === 'plan_open_queues_first') {
  // The picture that opens is also queued, so it would open twice.
  arrivalPlan = (a) => {
    const r = real.arrivalPlan(a);
    return r.act === 'open' ? { ...r, queue: [a.uris[0], ...r.queue] } : r;
  };
} else if (BREAK === 'plan_keep_opens') {
  // Keep editing opens the picture anyway.
  arrivalPlan = (a) => {
    const r = real.arrivalPlan(a);
    return r.act === 'ask' ? { ...r, keep: { ...r.keep, open: a.uris[0] } } : r;
  };
} else if (BREAK === 'plan_overflow_kept') {
  // What the cap refused is neither deleted nor counted.
  arrivalPlan = (a) => {
    const r = real.arrivalPlan(a);
    const strip = (l) => ({ ...l, drop: [], notice: a.skipped ? l.notice : null });
    return r.act === 'ask' ? { ...r, keep: strip(r.keep), replace: strip(r.replace) } : { ...r, ...strip(r) };
  };
} else if (BREAK === 'plan_replace_keeps_first') {
  // Replace queues the picture it just opened.
  arrivalPlan = (a) => {
    const r = real.arrivalPlan(a);
    return r.act === 'ask' ? { ...r, replace: { ...r.replace, queue: [a.uris[0], ...r.replace.queue] } } : r;
  };
} else if (BREAK === 'advance_never_asks') {
  advancePlan = (a) => real.advancePlan({ ...a, dirty: false });
} else if (BREAK === 'advance_keep_pops') {
  // Keep editing on the chip still loses the picture it was about to open.
  advancePlan = (a) => {
    const r = real.advancePlan(a);
    return r.act === 'ask' ? { ...r, keep: r.replace } : r;
  };
} else if (BREAK === 'advance_takes_last') {
  advancePlan = (a) => real.advancePlan({ ...a, queue: a.queue.slice().reverse() });
} else if (BREAK === 'advance_empty_opens') {
  advancePlan = (a) => (a.queue.length === 0 ? { act: 'open', open: null, queue: [], drop: [], notice: null } : real.advancePlan(a));
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

const DIR = 'file:///data/user/0/dev.bismark.twitwa/cache/shared-in';
const OK = { status: 'ok', uri: `${DIR}/shared-1-0.png`, uris: [`${DIR}/shared-1-0.png`], mime: 'image/png', bytes: 123, count: 1, skipped: 0 };

console.log('nothing to open');
{
  const missing = shareOutcome(null, false);
  check('no native module -> ignored', missing.action === 'ignore', missing.action);
  check('...under its own reason, not "none"', missing.reason === 'module-missing', missing.reason);
  const noAnswer = shareOutcome(null);
  check('no answer -> ignored', noAnswer.action === 'ignore');
  check('...under its own reason, not "none"', noAnswer.reason === 'no-answer', noAnswer.reason);
  check('an answer that is not an object -> ignored', shareOutcome('ok').action === 'ignore');
  const none = shareOutcome({ status: 'none' });
  check('nothing shared -> ignored', none.action === 'ignore' && none.reason === 'none', JSON.stringify(none));
}

console.log('\na picture to open');
{
  const r = shareOutcome(OK);
  check('ok -> open', r.action === 'open', r.action);
  check('...the URI it was given', r.uri === OK.uri, r.uri);
  check('...with a list of just that one', JSON.stringify(r.uris) === JSON.stringify([OK.uri]), JSON.stringify(r.uris));
  check('...and nothing skipped', r.skipped === 0, r.skipped);
  const old = shareOutcome({ status: 'ok', uri: OK.uri, mime: 'image/png', bytes: 1, count: 1 });
  check('an answer without a list is one picture', old.action === 'open' && old.uris.length === 1 && old.uris[0] === OK.uri, JSON.stringify(old));
  const B = `${DIR}/shared-1-1.png`;
  const C = `${DIR}/shared-1-2.png`;
  const three = shareOutcome({ ...OK, uris: [OK.uri, B, C], count: 3 });
  check('three pictures -> opens', three.action === 'open', three.action);
  check('...all three kept, in order', JSON.stringify(three.uris) === JSON.stringify([OK.uri, B, C]), JSON.stringify(three.uris));
  check('...the first is the one to open', three.uri === OK.uri, three.uri);
  const some = shareOutcome({ ...OK, uris: [OK.uri, B], count: 5, skipped: 3 });
  check('three that could not be copied are reported', some.skipped === 3, some.skipped);
  check('a non-count skipped is zero', shareOutcome({ ...OK, skipped: 'x' }).skipped === 0 && shareOutcome({ ...OK, skipped: -2 }).skipped === 0);
}

console.log('\nwhat it refuses to open');
{
  const content = shareOutcome({ ...OK, uri: 'content://media/external/images/media/1' });
  check('a content:// URI -> problem, not open', content.action === 'problem', content.action);
  check('...with the generic sentence', content.message === COPY.sharedFailed, content.message);
  check('...under its own reason, for the log', content.reason === 'bad-answer', content.reason);
  // `file://` somewhere in the URI is not a file URI. An `includes` would let
  // this through, which is the widening the check exists to stop.
  const embedded = shareOutcome({ ...OK, uri: 'content://evil/x?next=file:///data/a.png' });
  check('a content:// URI with file:// inside it -> problem', embedded.action === 'problem', embedded.action);
  check('a missing URI -> problem', shareOutcome({ ...OK, uri: undefined }).action === 'problem');
  check('a non-string URI -> problem', shareOutcome({ ...OK, uri: 42 }).action === 'problem');
  check('an http URI -> problem', shareOutcome({ ...OK, uri: 'http://example.com/a.png' }).action === 'problem');
  // Every URI of the list is checked, not only the one that opens.
  const bad = shareOutcome({ ...OK, uris: [OK.uri, 'content://media/external/images/media/2'] });
  check('a content:// URI later in the list -> problem', bad.action === 'problem' && bad.reason === 'bad-answer', JSON.stringify(bad));
  check('an empty list -> problem', shareOutcome({ ...OK, uris: [] }).action === 'problem');
  check('a list that is not an array -> problem', shareOutcome({ ...OK, uris: OK.uri }).action === 'problem');
  check('a list that does not start with uri -> problem', shareOutcome({ ...OK, uris: [`${DIR}/other.png`] }).action === 'problem');
}

console.log('\nrefusals get the right sentence');
{
  const notImage = shareOutcome({ status: 'rejected', reason: 'not-image', count: 1 });
  check('not-image -> problem', notImage.action === 'problem');
  check('...says it has to be a picture', notImage.message === COPY.sharedNotImage, notImage.message);
  const big = shareOutcome({ status: 'rejected', reason: 'too-big', count: 1 });
  check('too-big -> says it is too large', big.message === COPY.sharedTooBig, big.message);
  for (const reason of ['unreadable', 'no-stream', 'scheme', 'empty', 'no-context']) {
    const r = shareOutcome({ status: 'rejected', reason, count: 1 });
    check(`${reason} -> the generic sentence`, r.action === 'problem' && r.message === COPY.sharedFailed, r.message);
    check(`${reason} -> reason kept for the log`, r.reason === reason, r.reason);
  }
  // The prototype trap: a lookup table would find Object.prototype's own key.
  const proto = shareOutcome({ status: 'rejected', reason: 'constructor' });
  check('a reason of "constructor" -> a real sentence', typeof proto.message === 'string' && proto.message === COPY.sharedFailed, typeof proto.message);
  const weird = shareOutcome({ status: 'exploded' });
  check('an unknown status -> reported, not swallowed', weird.action === 'problem', weird.action);
  check('...with the generic sentence', weird.message === COPY.sharedFailed, weird.message);
}

console.log('\nevery message is a real sentence from the deck');
{
  const samples = [
    shareOutcome({ status: 'rejected', reason: 'not-image' }),
    shareOutcome({ status: 'rejected', reason: 'too-big' }),
    shareOutcome({ status: 'rejected', reason: 'unreadable' }),
    shareOutcome({ ...OK, uri: 'content://x' }),
  ];
  const values = new Set(Object.values(COPY));
  check('four samples produced', samples.length === 4);
  check('each is a string in COPY', samples.every((s) => typeof s.message === 'string' && values.has(s.message)),
    samples.map((s) => s.message).join(' | '));
}

console.log('\na share over unsaved work is queued, not deleted');
{
  const A = `${DIR}/shared-1-0.png`;
  const B = `${DIR}/shared-1-1.png`;
  const C = `${DIR}/shared-1-2.png`;
  const D = `${DIR}/shared-2-0.png`;
  const clean = arrivalPlan({ uris: [A], dirty: false, queue: [] });
  check('a clean card opens it', clean.act === 'open' && clean.open === A, JSON.stringify(clean));
  check('...and nothing waits afterwards', clean.queue.length === 0 && clean.drop.length === 0 && clean.notice === null, JSON.stringify(clean));

  const multi = arrivalPlan({ uris: [A, B, C], dirty: false, queue: [] });
  check('a clean card opens the first of several', multi.act === 'open' && multi.open === A, JSON.stringify(multi));
  check('...and queues the rest, in order', JSON.stringify(multi.queue) === JSON.stringify([B, C]), JSON.stringify(multi.queue));

  const dirty = arrivalPlan({ uris: [A, B], dirty: true, queue: [] });
  check('a changed card asks', dirty.act === 'ask', dirty.act);
  check('Keep editing queues them all', dirty.keep.open === null && JSON.stringify(dirty.keep.queue) === JSON.stringify([A, B]), JSON.stringify(dirty.keep));
  check('Replace opens the first and queues the rest', dirty.replace.open === A && JSON.stringify(dirty.replace.queue) === JSON.stringify([B]), JSON.stringify(dirty.replace));
  check('...with nothing to delete either way', dirty.keep.drop.length === 0 && dirty.replace.drop.length === 0);

  const again = arrivalPlan({ uris: [D], dirty: false, queue: [B, C] });
  check('a second share appends behind what waits', JSON.stringify(again.queue) === JSON.stringify([B, C]) && again.open === D, JSON.stringify(again));
  const appended = arrivalPlan({ uris: [D, A], dirty: false, queue: [B, C] });
  check('...the rest of it goes behind', JSON.stringify(appended.queue) === JSON.stringify([B, C, A]), JSON.stringify(appended.queue));
  const keepMore = arrivalPlan({ uris: [D], dirty: true, queue: [B] });
  check('Keep editing over a queue appends too', JSON.stringify(keepMore.keep.queue) === JSON.stringify([B, D]), JSON.stringify(keepMore.keep));
  check('Replace over a queue leaves it alone', JSON.stringify(keepMore.replace.queue) === JSON.stringify([B]), JSON.stringify(keepMore.replace));

  // The cap. Ten fit; the eleventh is deleted and counted.
  const many = Array.from({ length: 10 }, (_, i) => `${DIR}/q-${i}.png`);
  const extra = [0, 1, 2].map((i) => `${DIR}/x-${i}.png`);
  const full = arrivalPlan({ uris: [A, ...extra.slice(0, 2)], dirty: false, queue: many });
  check('the queue holds at most ten', full.queue.length === 10, full.queue.length);
  check('...what did not fit is deleted', full.drop.length === 2, JSON.stringify(full.drop));
  check('...and said so', full.notice === skippedNotice(2), full.notice);
  const natives = arrivalPlan({ uris: [A], skipped: 3, dirty: false, queue: [] });
  check('native skips are reported', natives.notice === skippedNotice(3), natives.notice);
  const both = arrivalPlan({ uris: [A, ...extra.slice(0, 2)], skipped: 1, dirty: false, queue: many });
  check('...and add to the cap\'s', both.notice === skippedNotice(3), both.notice);
  const fullKeep = arrivalPlan({ uris: [A, B], dirty: true, queue: many.slice(0, 9).concat(C) });
  check('Keep editing over a full queue deletes the overflow', fullKeep.keep.queue.length === 10 && fullKeep.keep.drop.length === 2, JSON.stringify(fullKeep.keep.drop));
  check('the picture that opens is never in drop', !full.drop.includes(A) && !fullKeep.replace.drop.includes(A));

  console.log('\nthe chip and a closed card open the next one');
  const none = advancePlan({ dirty: false, queue: [] });
  check('nothing waiting -> nothing to do', none.act === 'none', none.act);
  const next = advancePlan({ dirty: false, queue: [B, C] });
  check('a clean card opens the first waiting', next.act === 'open' && next.open === B, JSON.stringify(next));
  check('...and the rest stay queued', JSON.stringify(next.queue) === JSON.stringify([C]), JSON.stringify(next.queue));
  const ask = advancePlan({ dirty: true, queue: [B, C] });
  check('a changed card asks', ask.act === 'ask', ask.act);
  check('Keep editing leaves the queue as it was', ask.keep.open === null && JSON.stringify(ask.keep.queue) === JSON.stringify([B, C]), JSON.stringify(ask.keep));
  check('Replace opens the first and queues the rest', ask.replace.open === B && JSON.stringify(ask.replace.queue) === JSON.stringify([C]), JSON.stringify(ask.replace));
  check('nothing is deleted', next.drop.length === 0 && ask.keep.drop.length === 0 && ask.replace.drop.length === 0);
}

console.log('\nthe contract with the Kotlin');
{
  const here = dirname(fileURLToPath(import.meta.url));
  // Comments stripped first: the Kotlin's own comments quote these names, and
  // a name that survives only in a comment is a name the code stopped sending.
  // Line comments go first: the header's "image/*" would otherwise open a
  // block comment that swallows code down to the next "*/". Neither pass
  // knows about string literals, which is safe only while no Kotlin string
  // contains "//" or "/*"; the last check in this block holds that.
  const strip = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  let kt = readFileSync(join(here, '../modules/twitwa-share-in/android/src/main/java/dev/bismark/twitwa/sharein/ShareInModule.kt'), 'utf8');
  let io = readFileSync(join(here, 'sharein-io.js'), 'utf8');
  let app = readFileSync(join(here, '../App.js'), 'utf8');
  if (BREAK === 'kt_event_renamed') kt = kt.replace('EVENT = "onShare"', 'EVENT = "onShared"');
  if (BREAK === 'kt_module_renamed') kt = kt.replace('Name("TwitwaShareIn")', 'Name("ShareIn")');
  if (BREAK === 'kt_reason_key_renamed') kt = kt.replace('"reason" to reason', '"why" to reason');
  if (BREAK === 'kt_count_key_renamed') kt = kt.replace('"count" to streams.size,\n', '"n" to streams.size,\n').replace('"count" to streams.size,\r\n', '"n" to streams.size,\r\n');
  if (BREAK === 'kt_skipped_key_renamed') kt = kt.replace('"skipped" to ', '"left" to ');
  if (BREAK === 'kt_uris_key_renamed') kt = kt.replace('"uris" to uris,', '"files" to uris,');
  if (BREAK === 'kt_keep_not_a_list') kt = kt.replace('keep: List<String>?', 'keep: String?');
  // A rename in the code that leaves the old name standing in a comment.
  if (BREAK === 'kt_reason_only_in_comment') kt = kt.replace('failed("not-image"', '/* failed("not-image" */ failed("notimage"');
  if (BREAK === 'kt_new_reason') kt = kt.replace('failed("empty"', 'failed("vanished"');
  if (BREAK === 'io_listener_renamed') io = io.replace("addListener('onShare'", "addListener('share'");
  if (BREAK === 'app_drops_message') app = app.replace('setProblem(o.message)', 'setProblem(COPY.sharedFailed)');
  if (BREAK === 'app_take_forgets_queue') app = app.replace('keepList(shownUri.current, queueRef.current)', 'shownUri.current');
  if (BREAK === 'app_drops_notice') app = app.replace('setNotice(leaf.notice)', 'setNotice(null)');
  const ktRaw = kt;
  kt = strip(kt);
  // The stripped source must still hold the whole module, or every check
  // below is reading a fragment.
  check('comment stripping kept the code (take, copy, companion)',
    /AsyncFunction\("take"\)/.test(kt) && /private fun copy\(/.test(kt) && /companion object/.test(kt));

  // The module and the event, as the JS spells them.
  check('the Kotlin module is named TwitwaShareIn', /Name\("TwitwaShareIn"\)/.test(kt));
  check('...and that is the name the JS asks for', /requireOptionalNativeModule\('TwitwaShareIn'\)/.test(io));
  const event = (kt.match(/EVENT = "([A-Za-z]+)"/) || [])[1];
  check('the Kotlin declares its event name', typeof event === 'string', event);
  check('...and the JS listens for that same name', io.includes(`addListener('${event}'`), event);
  check('...and it is declared with Events()', /Events\(EVENT\)/.test(kt));

  // The keys of the answer, as src/sharein.js reads them.
  // Scoped to each map. `"count"` is in both, so a search of the whole file
  // stayed green with the ok map's key renamed.
  const okMap = (kt.match(/"status" to "ok",[\s\S]*?\n\s*\)/) || [''])[0];
  const rejectedMap = (kt.match(/fun rejected\([^)]*\)\s*=\s*mapOf\([^\n]*\)/) || [''])[0];
  check('found the ok answer and the rejected answer', okMap.length > 0 && rejectedMap.length > 0);
  for (const key of ['uri', 'uris', 'count', 'skipped']) {
    check(`the ok answer carries "${key}"`, okMap.includes(`"${key}" to `), okMap.replace(/\s+/g, ' '));
  }
  for (const key of ['status', 'reason', 'count']) {
    check(`a refusal carries "${key}"`, rejectedMap.includes(`"${key}" to `), rejectedMap);
  }
  check('the Kotlin says "ok"', /"status" to "ok"/.test(kt));
  check('the Kotlin says "none"', /"status" to "none"/.test(kt));
  check('the Kotlin says "rejected"', /"status" to "rejected"/.test(kt));
  check('the Kotlin sends a file:// URI (Uri.fromFile)', /Uri\.fromFile\(/.test(kt));
  check('take() is handed a list of URIs to keep, which JS sends', /AsyncFunction\("take"\) \{ keep: List<String>\? ->/.test(kt) && /Native\.take\(keepUris/.test(io));
  const cap = (kt.match(/MAX_ITEMS = (\d+)/) || [])[1];
  const qcap = (readFileSync(join(here, 'queue.js'), 'utf8').match(/MAX_QUEUE = (\d+)/) || [])[1];
  check('the native cap and the JS queue cap are the same number', cap !== undefined && cap === qcap, `${cap} vs ${qcap}`);
  check('App.js hands take() the keep list', app.includes('takeShare(keepList(shownUri.current, queueRef.current))'));

  // The reasons. Listed here ON PURPOSE, as the one place a person decides
  // what each new refusal should say: a reason added on the Kotlin side fails
  // this until someone has chosen its sentence, rather than getting the
  // generic one by default and nobody noticing.
  const sent = [...new Set([...kt.matchAll(/(?:rejected|failed)\("([a-z-]+)"/g)].map((m) => m[1]))].sort();
  const decided = ['empty', 'no-context', 'no-stream', 'not-image', 'scheme', 'too-big', 'unreadable'];
  check('the Kotlin sends exactly the reasons decided here', sent.join(',') === decided.join(','), sent.join(','));
  check('not-image gets its own sentence', shareOutcome({ status: 'rejected', reason: 'not-image' }).message === COPY.sharedNotImage);
  check('too-big gets its own sentence', shareOutcome({ status: 'rejected', reason: 'too-big' }).message === COPY.sharedTooBig);

  // The deck's share sentences are only reachable through App.js acting on
  // what src/sharein.js returns. check-copy counts a key as used when either
  // file names it, so it cannot see App.js dropping the message.
  check('App.js shows the problem sharein.js chose', app.includes('setProblem(o.message)'));
  check('App.js shows the notice the plan chose', app.includes('setNotice(leaf.notice)') && app.includes('setNotice(plan.keep.notice)'));
  check('no Kotlin string literal contains // or /* (the stripper would cut it)',
    !/"[^"\n]*(\/\/|\/\*)[^"\n]*"/.test(ktRaw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
