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
import { COPY, fill } from './copy.js';

const BREAK = process.env.BREAK || '';
let shareOutcome = real.shareOutcome;

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
      ? { action: 'open', uri: answer.uri, notice: null }
      : real.shareOutcome(answer, available));
} else if (BREAK === 'drop_the_rest_silently') {
  // Open the first of several pictures without saying so.
  shareOutcome = (answer, available = true) => {
    const r = real.shareOutcome(answer, available);
    return r.action === 'open' ? { ...r, notice: null } : r;
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
      ? { action: 'open', uri: answer.uri, notice: null }
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
} else if (BREAK === 'count_off_by_one') {
  // A share of exactly one picture announces "the first of 1".
  shareOutcome = (answer, available = true) => {
    const r = real.shareOutcome(answer, available);
    if (r.action !== 'open') return r;
    const count = Number.isInteger(answer.count) ? answer.count : 1;
    return { ...r, notice: count >= 1 ? fill(COPY.sharedFirstOnly, { count }) : null };
  };
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

const OK = { status: 'ok', uri: 'file:///data/user/0/dev.bismark.twitwa/cache/shared-in/shared-1.png', mime: 'image/png', bytes: 123, count: 1 };

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
  check('one picture -> no notice', r.notice === null, r.notice);
  const noCount = shareOutcome({ ...OK, count: undefined });
  check('no count -> treated as one, no notice', noCount.action === 'open' && noCount.notice === null, noCount.notice);
  const three = shareOutcome({ ...OK, count: 3 });
  check('three pictures -> still opens', three.action === 'open', three.action);
  check('...and says only the first was opened',
    three.notice === fill(COPY.sharedFirstOnly, { count: 3 }), three.notice);
  const two = shareOutcome({ ...OK, count: 2 });
  check('two pictures -> the notice carries 2', typeof two.notice === 'string' && two.notice.includes('2'), two.notice);
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
  if (BREAK === 'kt_count_key_renamed') kt = kt.replace('"count" to uris.size,\n', '"n" to uris.size,\n').replace('"count" to uris.size,\r\n', '"n" to uris.size,\r\n');
  // A rename in the code that leaves the old name standing in a comment.
  if (BREAK === 'kt_reason_only_in_comment') kt = kt.replace('rejected("not-image"', '/* rejected("not-image" */ rejected("notimage"');
  if (BREAK === 'kt_new_reason') kt = kt.replace('rejected("empty"', 'rejected("vanished"');
  if (BREAK === 'io_listener_renamed') io = io.replace("addListener('onShare'", "addListener('share'");
  if (BREAK === 'app_drops_message') app = app.replace('setProblem(o.message)', 'setProblem(COPY.sharedFailed)');
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
  for (const key of ['uri', 'count']) {
    check(`the ok answer carries "${key}"`, okMap.includes(`"${key}" to `), okMap.replace(/\s+/g, ' '));
  }
  for (const key of ['status', 'reason', 'count']) {
    check(`a refusal carries "${key}"`, rejectedMap.includes(`"${key}" to `), rejectedMap);
  }
  check('the Kotlin says "ok"', /"status" to "ok"/.test(kt));
  check('the Kotlin says "none"', /"status" to "none"/.test(kt));
  check('the Kotlin says "rejected"', /"status" to "rejected"/.test(kt));
  check('the Kotlin sends a file:// URI (Uri.fromFile)', /Uri\.fromFile\(/.test(kt));

  // The reasons. Listed here ON PURPOSE, as the one place a person decides
  // what each new refusal should say: a reason added on the Kotlin side fails
  // this until someone has chosen its sentence, rather than getting the
  // generic one by default and nobody noticing.
  const sent = [...new Set([...kt.matchAll(/rejected\("([a-z-]+)"/g)].map((m) => m[1]))].sort();
  const decided = ['empty', 'no-context', 'no-stream', 'not-image', 'scheme', 'too-big', 'unreadable'];
  check('the Kotlin sends exactly the reasons decided here', sent.join(',') === decided.join(','), sent.join(','));
  check('not-image gets its own sentence', shareOutcome({ status: 'rejected', reason: 'not-image' }).message === COPY.sharedNotImage);
  check('too-big gets its own sentence', shareOutcome({ status: 'rejected', reason: 'too-big' }).message === COPY.sharedTooBig);

  // The deck's share sentences are only reachable through App.js acting on
  // what src/sharein.js returns. check-copy counts a key as used when either
  // file names it, so it cannot see App.js dropping the message.
  check('App.js shows the problem sharein.js chose', app.includes('setProblem(o.message)'));
  check('App.js shows the notice sharein.js chose', app.includes('setNotice(o.notice)'));
  check('no Kotlin string literal contains // or /* (the stripper would cut it)',
    !/"[^"\n]*(\/\/|\/\*)[^"\n]*"/.test(ktRaw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
