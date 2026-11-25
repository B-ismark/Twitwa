// Tests for src/prefs.js.
//
//   for b in read_throws read_all_or_nothing read_any_padding read_clamps \
//            read_any_background read_any_format read_any_version \
//            ser_unvalidated start_has_format start_ignores_prefs \
//            default_mutable; do
//     BREAK=$b node src/prefs.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
import * as real from './prefs.js';
import { PADDING } from './sizing.js';
import { PAD_MAX, PAD_MIN } from './shell.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

const obj = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw);
if (BREAK === 'read_throws') F.parsePrefs = (raw) => (typeof raw === 'string' ? real.parsePrefs(JSON.parse(raw)) : real.parsePrefs(raw));
else if (BREAK === 'read_all_or_nothing') {
  F.parsePrefs = (raw) => {
    const r = real.parsePrefs(raw);
    const o = obj(raw);
    return o && o.format === 'bmp' ? { ...real.DEFAULT_PREFS } : r;
  };
} else if (BREAK === 'read_any_padding') F.parsePrefs = (raw) => ({ ...real.parsePrefs(raw), padding: obj(raw).padding });
else if (BREAK === 'read_clamps') {
  F.parsePrefs = (raw) => {
    const r = real.parsePrefs(raw);
    const o = obj(raw);
    return typeof o.padding === 'number' && o.padding > PAD_MAX ? { ...r, padding: PAD_MAX } : r;
  };
} else if (BREAK === 'read_any_background') F.parsePrefs = (raw) => ({ ...real.parsePrefs(raw), background: obj(raw).background });
else if (BREAK === 'read_any_format') F.parsePrefs = (raw) => ({ ...real.parsePrefs(raw), format: obj(raw).format });
else if (BREAK === 'read_any_version') F.parsePrefs = (raw) => real.parsePrefs(typeof raw === 'object' && raw ? { ...raw, v: 1 } : raw);
else if (BREAK === 'ser_unvalidated') F.serialisePrefs = (p) => ({ v: 1, ...p });
else if (BREAK === 'start_has_format') F.startingStyle = (p) => ({ ...real.startingStyle(p), format: p && p.format });
else if (BREAK === 'start_ignores_prefs') F.startingStyle = () => real.startingStyle(undefined);
else if (BREAK === 'default_mutable') F.parsePrefs = (raw) => { const r = real.parsePrefs(raw); return r.format === 'png' && r.background === 'match' && r.padding === real.DEFAULT_PREFS.padding ? real.DEFAULT_PREFS : r; };

let ran = 0;
let fails = 0;
function check(name, ok, detail) {
  ran += 1;
  if (!ok) { fails += 1; console.log(`FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`); } else console.log(`ok    ${name}`);
}

const good = { v: 1, padding: PADDING.roomy, background: 'midnight', format: 'jpeg' };
const D = real.DEFAULT_PREFS;

console.log('parsePrefs: a good file comes back');
{
  check('from text', JSON.stringify(F.parsePrefs(JSON.stringify(good))) === JSON.stringify({ padding: PADDING.roomy, background: 'midnight', format: 'jpeg' }));
  check('from a parsed value', F.parsePrefs(good).background === 'midnight');
  check('a slider value between the stops is kept', F.parsePrefs({ ...good, padding: 0.0731 }).padding === 0.0731);
  check('every named background is accepted', ['match', 'paper', 'ink', 'sky', 'mint', 'sand', 'plum', 'slate', 'midnight']
    .every((b) => F.parsePrefs({ ...good, background: b }).background === b));
  check('the defaults are Standard, Match and PNG', D.padding === PADDING.standard && D.background === 'match' && D.format === 'png');
  check('the result is a fresh object, so a caller cannot edit the defaults', F.parsePrefs(null) !== D);
}

console.log('parsePrefs: bad values fall back one field at a time');
{
  const r = F.parsePrefs({ ...good, padding: 0.9 });
  check('padding out of range -> default, the others kept', r.padding === D.padding && r.background === 'midnight' && r.format === 'jpeg', JSON.stringify(r));
  check('padding under the range is refused, not clamped', F.parsePrefs({ ...good, padding: PAD_MIN / 2 }).padding === D.padding);
  check('padding NaN, a string or null -> default', [NaN, '0.06', null, Infinity].every((p) => F.parsePrefs({ ...good, padding: p }).padding === D.padding));
  const b = F.parsePrefs({ ...good, background: 'neon' });
  check('unknown background -> default, the others kept', b.background === 'match' && b.padding === PADDING.roomy && b.format === 'jpeg');
  check('a hex where a name goes -> default', F.parsePrefs({ ...good, background: '#ff0000' }).background === 'match');
  check('a non-string background -> default', F.parsePrefs({ ...good, background: 3 }).background === 'match');
  const f = F.parsePrefs({ ...good, format: 'bmp' });
  check('bad format -> png, the others kept', f.format === 'png' && f.background === 'midnight' && f.padding === PADDING.roomy);
  check('a missing field -> its default', F.parsePrefs({ v: 1, format: 'jpeg' }).background === 'match');
}

console.log('parsePrefs: a corrupt file is all defaults and never throws');
{
  const want = JSON.stringify(D);
  for (const [name, raw] of [['junk text', '{nope'], ['empty', ''], ['null', null], ['undefined', undefined], ['a number', 7], ['an array', [1]], ['the string null', 'null'], ['another version', { ...good, v: 2 }], ['no version', { padding: PADDING.roomy }]]) {
    let r;
    let threw = false;
    try { r = F.parsePrefs(raw); } catch { threw = true; }
    check(`${name}`, !threw && JSON.stringify(r) === want, threw ? 'threw' : JSON.stringify(r));
  }
}

console.log('serialisePrefs: only what can be read back is written');
{
  const w = F.serialisePrefs({ padding: PADDING.snug, background: 'sky', format: 'jpeg' });
  check('versioned', w.v === 1 && w.padding === PADDING.snug && w.background === 'sky' && w.format === 'jpeg');
  check('round trips through text', JSON.stringify(F.parsePrefs(JSON.stringify(w))) === JSON.stringify({ padding: PADDING.snug, background: 'sky', format: 'jpeg' }));
  const bad = F.serialisePrefs({ padding: 5, background: 'neon', format: 'bmp' });
  check('junk is replaced by defaults, never written', bad.padding === D.padding && bad.background === 'match' && bad.format === 'png', JSON.stringify(bad));
  check('nothing at all is the defaults', F.serialisePrefs(undefined).background === 'match');
}

console.log('startingStyle: what a NEW image opens on');
{
  const s = F.startingStyle(good);
  check('the remembered padding and background', s.padding === PADDING.roomy && s.background === 'midnight');
  check('and no format: that is not style', !('format' in s) && Object.keys(s).length === 2);
  check('no prefs is the defaults', JSON.stringify(F.startingStyle(undefined)) === JSON.stringify({ padding: D.padding, background: D.background }));
  check('a bad value starts on its default', F.startingStyle({ padding: 7, background: 'sky' }).padding === D.padding && F.startingStyle({ padding: 7, background: 'sky' }).background === 'sky');
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
