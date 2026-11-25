// Tests for src/saved.js.
//
//   for b in uri_bare_id uri_rewrites uri_any_scheme uri_no_digit_check \
//            notice_same notice_never_long; do
//     BREAK=$b node src/saved.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
import * as real from './saved.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'uri_bare_id') F.viewUri = (id) => (typeof id === 'string' && /^[0-9]+$/.test(id) ? id : real.viewUri(id));
else if (BREAK === 'uri_rewrites') F.viewUri = (id) => (typeof id === 'string' && id.startsWith('content://') ? `content://media/external/images/media/${id.split('/').pop()}` : real.viewUri(id));
else if (BREAK === 'uri_any_scheme') F.viewUri = (id) => (typeof id === 'string' && id.startsWith('file://') ? id : real.viewUri(id));
else if (BREAK === 'uri_no_digit_check') F.viewUri = (id) => (typeof id === 'string' && id.startsWith('content://media/') ? id : real.viewUri(id));
else if (BREAK === 'notice_same') F.noticeMs = () => real.NOTICE_MS;
else if (BREAK === 'notice_never_long') F.noticeMs = (a) => (a ? real.NOTICE_MS : real.NOTICE_ACTION_MS);

let ran = 0;
let fails = 0;
function check(name, ok, detail) {
  ran += 1;
  if (!ok) { fails += 1; console.log(`FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`); } else console.log(`ok    ${name}`);
}

console.log('viewUri: the id an Asset reports, as a URI the gallery opens');
{
  const full = 'content://media/external/images/media/12345';
  check('an id that already is the MediaStore URI is kept as it is (SDK 57 Android)', F.viewUri(full) === full);
  check('so is the external_primary form Android 10 reports', F.viewUri('content://media/external_primary/images/media/7') === 'content://media/external_primary/images/media/7');
  check('a bare row id gets the images prefix', F.viewUri('12345') === full, F.viewUri('12345'));
  check('so does a number', F.viewUri(12345) === full);
  for (const [name, id] of [['null', null], ['undefined', undefined], ['empty', ''], ['zero', '0'], ['negative', -3], ['a fraction', 1.5], ['leading zero', '007'], ['an object', {}], ['a file path', 'file:///sdcard/a.png'],
    ['another provider', 'content://com.android.providers.downloads/12'], ['media with no row', 'content://media/external/images/media/'], ['a word', 'abc']]) {
    check(`${name} is refused`, F.viewUri(id) === null, String(F.viewUri(id)));
  }
}

console.log('noticeMs: a notice with a button stays longer');
{
  check('no action: 2.5s', F.noticeMs(false) === 2500);
  check('an action: 6s', F.noticeMs(true) === 6000);
  check('and the longer one is longer', F.noticeMs(true) > F.noticeMs(false));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
