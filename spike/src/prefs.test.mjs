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
else if (BREAK === 'custom_unparsed') F.parsePrefs = (raw) => ({ ...real.parsePrefs(raw), custom: obj(raw).custom || [] });
else if (BREAK === 'custom_dropped') F.parsePrefs = (raw) => ({ ...real.parsePrefs(raw), custom: [] });
else if (BREAK === 'custom_required') F.parsePrefs = (raw) => (obj(raw) && obj(raw).v === 1 && !('custom' in obj(raw)) ? { ...real.DEFAULT_PREFS, custom: [] } : real.parsePrefs(raw));
else if (BREAK === 'hex_bg_refused') F.parsePrefs = (raw) => { const r = real.parsePrefs(raw); const o = obj(raw); return o && /^#[0-9A-F]{6}$/.test(o.background) ? { ...r, background: 'match' } : r; };
else if (BREAK === 'start_keeps_removed') F.startingStyle = (p) => { const s = real.startingStyle(p); return p && /^#[0-9A-F]{6}$/.test(p.background) ? { ...s, background: p.background } : s; };
else if (BREAK === 'start_drops_listed') F.startingStyle = (p) => { const s = real.startingStyle(p); return p && /^#[0-9A-F]{6}$/.test(p.background) ? { ...s, background: 'match' } : s; };
else if (BREAK === 'forget_keeps_habit') F.forgetCustom = (p, h) => ({ custom: real.forgetCustom(p, h).custom });
else if (BREAK === 'forget_resets_always') F.forgetCustom = (p, h) => ({ ...real.forgetCustom(p, h), background: 'match' });
else if (BREAK === 'forget_keeps_colour') F.forgetCustom = (p, h) => ({ ...real.forgetCustom(p, h), custom: p.custom });
else if (BREAK === 'remember_no_list') F.rememberCustom = (p, h) => ({ background: h, custom: p.custom });
else if (BREAK === 'remember_no_habit') F.rememberCustom = (p, h) => ({ custom: real.rememberCustom(p, h).custom });
else if (BREAK === 'default_shared_list') F.parsePrefs = (raw) => { const r = real.parsePrefs(raw); return r.custom.length === 0 ? { ...r, custom: real.DEFAULT_PREFS.custom } : r; };
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
  check('from text', JSON.stringify(F.parsePrefs(JSON.stringify(good))) === JSON.stringify({ padding: PADDING.roomy, background: 'midnight', format: 'jpeg', custom: [] }));
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
  check('a lowercase or short hex where a name goes -> default', ['#ff0000', '#F00', '#FF0000FF'].every((h) => F.parsePrefs({ ...good, background: h }).background === 'match'));
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
  check('round trips through text', JSON.stringify(F.parsePrefs(JSON.stringify(w))) === JSON.stringify({ padding: PADDING.snug, background: 'sky', format: 'jpeg', custom: [] }));
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

console.log('custom colours: the saved row and a hex background');
{
  const row = ['#7A8FA6', '#C9A66B'];
  check('a v1 file from before custom colours is valid, with none', (() => { const r = F.parsePrefs(JSON.stringify({ v: 1, padding: PADDING.roomy, background: 'sky', format: 'jpeg' })); return r.custom.length === 0 && r.background === 'sky' && r.padding === PADDING.roomy; })());
  check('the default has no saved colours', D.custom.length === 0);
  check('a saved row is read back, in order', JSON.stringify(F.parsePrefs({ ...good, custom: row }).custom) === JSON.stringify(row));
  const junk = F.parsePrefs({ ...good, custom: ['#7A8FA6', 'sky', '#abc', 4, '#7A8FA6', null, '#112233'] });
  check('a garbage list keeps what is valid and drops the rest', JSON.stringify(junk.custom) === JSON.stringify(['#7A8FA6', '#112233']), JSON.stringify(junk.custom));
  check('a garbage list costs the other fields nothing', junk.padding === PADDING.roomy && junk.background === 'midnight' && junk.format === 'jpeg');
  check('a list that is not a list is none', ['nope', 5, { a: 1 }, null].every((c) => F.parsePrefs({ ...good, custom: c }).custom.length === 0));
  check('five saved is cut to four', F.parsePrefs({ ...good, custom: ['#000001', '#000002', '#000003', '#000004', '#000005'] }).custom.length === 4);
  check('a custom hex background is valid', F.parsePrefs({ ...good, background: '#7A8FA6', custom: row }).background === '#7A8FA6');
  check('and valid even with no list at all (the file is read whole)', F.parsePrefs({ ...good, background: '#7A8FA6' }).background === '#7A8FA6');
  check('the saved row survives a round trip through serialisePrefs', JSON.stringify(F.parsePrefs(JSON.stringify(F.serialisePrefs({ ...good, custom: row }))).custom) === JSON.stringify(row));
  check('serialise drops junk from the list', JSON.stringify(F.serialisePrefs({ ...good, custom: ['x', '#7A8FA6'] }).custom) === JSON.stringify(['#7A8FA6']));
  check('a parsed default never shares the default list', (() => { const a = F.parsePrefs(null); const b = F.parsePrefs({ v: 1 }); return a.custom !== D.custom && b.custom !== D.custom; })());
  check('a new card opens on a custom colour that is still in the row', F.startingStyle({ ...good, background: '#7A8FA6', custom: row }).background === '#7A8FA6');
  check('but on the default when the colour has been removed from the row', F.startingStyle({ ...good, background: '#112233', custom: row }).background === 'match');
  check('and when there is no row at all', F.startingStyle({ ...good, background: '#112233' }).background === 'match');
  check('a name is unaffected by the row', F.startingStyle({ ...good, background: 'midnight', custom: [] }).background === 'midnight');
  check('startingStyle still has two keys', Object.keys(F.startingStyle({ ...good, background: '#7A8FA6', custom: row })).length === 2);
}

console.log('rememberCustom and forgetCustom: the patches the Style sheet writes');
{
  const p = { ...good, background: 'sky', custom: ['#7A8FA6'] };
  const r = F.rememberCustom(p, '#C9A66B');
  check('saving puts the colour first and makes it the habit', JSON.stringify(r) === JSON.stringify({ background: '#C9A66B', custom: ['#C9A66B', '#7A8FA6'] }), JSON.stringify(r));
  check('saving a fifth drops the oldest', F.rememberCustom({ custom: ['#000001', '#000002', '#000003', '#000004'] }, '#000005').custom.join() === '#000005,#000001,#000002,#000003');
  const f = F.forgetCustom({ ...p, background: '#7A8FA6' }, '#7A8FA6');
  check('removing the remembered colour empties the row and resets the habit', JSON.stringify(f) === JSON.stringify({ custom: [], background: 'match' }), JSON.stringify(f));
  const g = F.forgetCustom({ ...p, custom: ['#7A8FA6', '#C9A66B'] }, '#C9A66B');
  check('removing another colour leaves the habit alone', JSON.stringify(g) === JSON.stringify({ custom: ['#7A8FA6'] }), JSON.stringify(g));
  check('removing a colour that is not there changes nothing', JSON.stringify(F.forgetCustom(p, '#111111')) === JSON.stringify({ custom: ['#7A8FA6'] }));
  const patched = F.serialisePrefs({ ...p, ...f });
  check('the patched prefs read back as the default habit and an empty row', patched.background === 'match' && patched.custom.length === 0);
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
