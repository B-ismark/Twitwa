// Tests for src/session.js.
//
//   for b in $(grep -o "BREAK === '[a-z_0-9]*'" src/session.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/session.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// A bad session is quiet: it restores a card nobody made, or throws in the
// renderer after the launch screen has already been replaced. So each rule
// here is one way a file can be wrong, and each has a mutant that accepts it.
import * as real from './session.js';
import { editorState, openTool, cardOf } from './shell.js';
import { PADDING } from './sizing.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

const ok = (j) => JSON.parse(JSON.stringify(j));

if (BREAK === 'read_any_version') {
  F.readSession = (raw) => real.readSession(typeof raw === 'object' && raw ? { ...raw, v: 1 } : raw);
} else if (BREAK === 'read_content_uri') {
  F.readSession = (raw) => {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && typeof o.uri === 'string' && o.uri.startsWith('content://')
      ? { ...o } : real.readSession(raw);
  };
} else if (BREAK === 'read_nan_crop') {
  F.readSession = (raw) => {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && o.crop && Number.isNaN(o.crop.w) ? { ...o } : real.readSession(raw);
  };
} else if (BREAK === 'read_empty_crop') {
  F.readSession = (raw) => {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && o.crop && o.crop.w === 0 ? { ...o } : real.readSession(raw);
  };
} else if (BREAK === 'read_negative_origin') {
  F.readSession = (raw) => {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && o.crop && o.crop.x < 0 ? { ...o } : real.readSession(raw);
  };
} else if (BREAK === 'read_any_padding') {
  F.readSession = (raw) => {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && typeof o.padding === 'number' && (o.padding > 0.5 || o.padding < 0.01) ? { ...o } : real.readSession(raw);
  };
} else if (BREAK === 'read_stops_only') {
  F.readSession = (raw) => {
    const r = real.readSession(raw);
    return r && !Object.values(PADDING).includes(r.padding) ? null : r;
  };
} else if (BREAK === 'read_any_background') {
  F.readSession = (raw) => {
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return o && o.background === 'neon' ? { ...o } : real.readSession(raw);
  };
} else if (BREAK === 'read_throws_on_junk') {
  F.readSession = (raw) => (typeof raw === 'string' ? JSON.parse(raw) && real.readSession(raw) : real.readSession(raw));
} else if (BREAK === 'read_aliases_input') {
  // Hands back the very object it was given, so a later edit of the crop edits
  // the parsed file too.
  F.readSession = (raw) => (real.readSession(raw) ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null);
} else if (BREAK === 'ser_live_crop') {
  F.serialiseSession = (state, uri) => real.serialiseSession({ ...state, session: null }, uri);
} else if (BREAK === 'ser_no_uri_check') {
  F.serialiseSession = (state, uri) => real.serialiseSession(state, uri || 'file:///x') && { ...real.serialiseSession(state, uri || 'file:///x'), uri };
} else if (BREAK === 'ser_aliases_crop') {
  F.serialiseSession = (state, uri) => {
    const r = real.serialiseSession(state, uri);
    return r && { ...r, crop: state.crop };
  };
} else if (BREAK === 'ser_wrong_version') {
  F.serialiseSession = (state, uri) => {
    const r = real.serialiseSession(state, uri);
    return r && { ...r, v: 2 };
  };
} else if (BREAK === 'fits_ignores_edge') {
  F.cropFits = (crop, w, h) => real.cropFits({ ...crop, w: Math.min(crop.w, w - crop.x), h: Math.min(crop.h, h - crop.y) }, w, h);
} else if (BREAK === 'fits_ignores_height') {
  F.cropFits = (crop, w) => real.cropFits(crop, w, Infinity);
} else if (BREAK !== '') {
  console.log(`unknown BREAK=${BREAK}`);
  process.exit(1);
}

let ran = 0;
let fails = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

const CROP = { x: 10, y: 20, w: 300, h: 600 };
const URI = 'file:///data/cache/shared-in/shared-1.png';
const state = () => editorState(CROP);

console.log('serialiseSession: the card, in the shape the file holds');
{
  const s = { ...state(), padding: PADDING.roomy, background: 'ink' };
  const j = F.serialiseSession(s, URI);
  check('version, uri and the three card fields', j && j.v === 1 && j.uri === URI && j.padding === PADDING.roomy && j.background === 'ink', JSON.stringify(j));
  check('the crop is the card crop', JSON.stringify(j.crop) === JSON.stringify(CROP));
  check('it survives JSON', JSON.stringify(JSON.parse(JSON.stringify(j))) === JSON.stringify(j));
  check('it is a copy: editing the state later does not edit it', (() => {
    const st = state();
    const out = F.serialiseSession(st, URI);
    st.crop.w = 1;
    return out.crop.w === CROP.w;
  })());
  check('no editor, nothing to write', F.serialiseSession(null, URI) === null);
  check('no uri, nothing to write', F.serialiseSession(state(), '') === null && F.serialiseSession(state(), null) === null);
  check('the file holds the card and nothing about the editor', Object.keys(j).sort().join() === 'background,crop,padding,uri,v', Object.keys(j).join());
}

console.log('serialiseSession: an open Crop is not committed yet');
{
  const open = openTool(state(), 'crop');
  const dragged = { ...open, crop: { ...open.crop, x: 90, w: 100 } };
  const j = F.serialiseSession(dragged, URI);
  check('the crop written is the one from before the tool opened', j.crop.x === CROP.x && j.crop.w === CROP.w, JSON.stringify(j.crop));
  const done = { ...dragged, tool: null, session: null };
  check('after Done it is the dragged one', F.serialiseSession(done, URI).crop.x === 90);
}

console.log('readSession: a good file comes back');
{
  const good = F.serialiseSession({ ...state(), padding: PADDING.snug }, URI);
  const back = F.readSession(JSON.stringify(good));
  check('from text', back && JSON.stringify(back) === JSON.stringify(good), JSON.stringify(back));
  check('from a parsed value', F.readSession(good) && F.readSession(good).uri === URI);
  for (const [name, p] of Object.entries(PADDING)) {
    check(`the ${name} stop is accepted`, F.readSession({ ...good, padding: p }) !== null);
  }
  check('so is a slider value between stops', F.readSession({ ...good, padding: 0.0731 }) !== null);
  for (const b of ['match', 'paper', 'ink']) {
    check(`background ${b} is accepted`, F.readSession({ ...good, background: b }) !== null);
  }
  check('the result is a copy, not the input', (() => {
    const r = F.readSession(good);
    r.crop.w = 1;
    return good.crop.w === CROP.w;
  })());
}

console.log('readSession: everything else is null, and never throws');
{
  const good = ok(F.serialiseSession(state(), URI));
  const bad = (name, patch) => {
    const v = patch(ok(good));
    check(name, F.readSession(v) === null, JSON.stringify(F.readSession(v)));
  };
  check('not JSON', F.readSession('{nope') === null);
  check('empty text', F.readSession('') === null);
  check('null', F.readSession(null) === null);
  check('a number', F.readSession(7) === null);
  check('an array', F.readSession([]) === null);
  bad('another version', (j) => ({ ...j, v: 2 }));
  bad('no version', (j) => { delete j.v; return j; });
  bad('a content:// uri', (j) => ({ ...j, uri: 'content://media/external/images/1' }));
  bad('an http uri', (j) => ({ ...j, uri: 'https://example.com/a.png' }));
  bad('no uri', (j) => { delete j.uri; return j; });
  bad('a numeric uri', (j) => ({ ...j, uri: 5 }));
  bad('no crop', (j) => { delete j.crop; return j; });
  bad('a crop that is a string', (j) => ({ ...j, crop: 'all' }));
  bad('a crop missing h', (j) => { delete j.crop.h; return j; });
  bad('a string width', (j) => { j.crop.w = '300'; return j; });
  bad('a NaN width', (j) => { j.crop.w = NaN; return j; });
  bad('an Infinity height', (j) => { j.crop.h = Infinity; return j; });
  bad('a zero width', (j) => { j.crop.w = 0; return j; });
  bad('a negative height', (j) => { j.crop.h = -5; return j; });
  bad('a negative x', (j) => { j.crop.x = -1; return j; });
  bad('a negative y', (j) => { j.crop.y = -1; return j; });
  bad('a padding of 0.5', (j) => ({ ...j, padding: 0.5 }));
  bad('a padding of 0', (j) => ({ ...j, padding: 0 }));
  bad('a padding below the snug stop', (j) => ({ ...j, padding: 0.029 }));
  bad('a string padding', (j) => ({ ...j, padding: 'roomy' }));
  bad('a NaN padding', (j) => ({ ...j, padding: NaN }));
  bad('an unknown background', (j) => ({ ...j, background: 'neon' }));
  bad('no background', (j) => { delete j.background; return j; });
  check('JSON text that is null', F.readSession('null') === null);
}

console.log('cropFits: the saved crop is checked against the picture it meets');
{
  check('inside', F.cropFits({ x: 10, y: 20, w: 300, h: 600 }, 400, 700) === true);
  check('exactly to the edges', F.cropFits({ x: 0, y: 0, w: 400, h: 700 }, 400, 700) === true);
  check('one pixel too wide', F.cropFits({ x: 10, y: 0, w: 391, h: 700 }, 400, 700) === false);
  check('one pixel too tall', F.cropFits({ x: 0, y: 10, w: 400, h: 691 }, 400, 700) === false);
  check('a smaller picture than the one saved', F.cropFits({ x: 0, y: 0, w: 1080, h: 2000 }, 720, 1280) === false);
  check('no crop', F.cropFits(null, 100, 100) === false);
  check('no picture', F.cropFits({ x: 0, y: 0, w: 1, h: 1 }, 0, 0) === false);
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
