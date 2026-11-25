// Tests for src/icons.js.
//
//   for b in $(grep -o "BREAK === '[a-z_0-9]*'" src/icons.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/icons.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// A bad icon is quiet: a mistyped path draws half a glyph, or nothing, and a
// name App.js uses that the table lacks is `undefined.map` on the first frame
// of the editor. Both are readable from here, so neither needs a device.
import { readFileSync } from 'node:fs';
import * as real from './icons.js';
import { TOOLS } from './shell.js';
import { TOUCH } from './theme.js';

const BREAK = process.env.BREAK || '';
const F = { ...real, ICONS: { ...real.ICONS }, ICON_ONLY: { ...real.ICON_ONLY } };

// Mutants edit the data under test, then the same checks must notice.
if (BREAK === 'icon_missing') {
  delete F.ICONS.copy;
} else if (BREAK === 'path_garbled') {
  F.ICONS.crop = ['M6 2v14a2 2 0 0 0 2 2h', ...F.ICONS.crop.slice(1)];
} else if (BREAK === 'path_no_move') {
  F.ICONS.save = ['l5 5', ...F.ICONS.save.slice(1)];
} else if (BREAK === 'path_bad_command') {
  F.ICONS.close = ['M18 6X6 18', 'M6 6l12 12'];
} else if (BREAK === 'path_bad_flag') {
  F.ICONS.more = ['M11 5a1 1 0 2 0 2 0', ...F.ICONS.more.slice(1)];
} else if (BREAK === 'path_off_grid') {
  F.ICONS.share = [...F.ICONS.share, 'M30 5l2 2'];
} else if (BREAK === 'icon_empty') {
  F.ICONS.style = [];
} else if (BREAK === 'icon_only_small') {
  F.ICON_ONLY.bar = 40;
} else if (BREAK === 'icon_only_fit_small') {
  F.ICON_ONLY.fit = 36;
}

let ran = 0;
let fails = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// How many numbers each SVG path command takes. Anything else is not a command.
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * Parse a path string against SVG's grammar closely enough to catch the
 * mistakes a hand edit makes: a letter that is not a command, a missing
 * moveto, an argument count that is not a whole number of repeats, an arc flag
 * that is not 0 or 1, a stray character. Returns the absolute extremes it
 * can know (the endpoints are enough: every curve here stays inside its box)
 * or an error string.
 */
function parsePath(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)/g) || [];
  if (tokens.join('') .length === 0) return 'empty';
  // Everything that is not a token, a space or a comma is junk.
  if (d.replace(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)|[\s,]/g, '') !== '') return 'stray character';
  let i = 0;
  let cmd = null;
  let first = true;
  let x = 0, y = 0;
  const pts = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[a-zA-Z]/.test(t)) {
      if (!(t.toUpperCase() in ARITY)) return `unknown command ${t}`;
      cmd = t;
      i++;
      if (ARITY[t.toUpperCase()] === 0) { continue; }
    } else if (cmd === null) {
      return 'numbers before any command';
    }
    if (first && cmd.toUpperCase() !== 'M') return 'does not start with a moveto';
    first = false;
    const up = cmd.toUpperCase();
    const n = ARITY[up];
    if (n === 0) continue;
    const args = tokens.slice(i, i + n);
    if (args.length < n || args.some((a) => /[a-zA-Z]/.test(a))) return `${cmd} needs ${n} numbers`;
    const v = args.map(Number);
    if (up === 'A' && ![v[3], v[4]].every((f) => f === 0 || f === 1)) return 'arc flag is not 0 or 1';
    i += n;
    const rel = cmd === cmd.toLowerCase();
    if (up === 'H') x = rel ? x + v[0] : v[0];
    else if (up === 'V') y = rel ? y + v[0] : v[0];
    else { const ex = v[n - 2], ey = v[n - 1]; x = rel ? x + ex : ex; y = rel ? y + ey : ey; }
    pts.push([x, y]);
    // A repeated implicit command after a moveto is a lineto, by the grammar.
    if (up === 'M') cmd = rel ? 'l' : 'L';
  }
  return { pts };
}

console.log('the table: every icon the app names is there, and nothing is unused');
{
  const app = readFileSync(new URL('../App.js', import.meta.url), 'utf8');
  const named = new Set([...app.matchAll(/\bicon="([a-z]+)"/g)].map((m) => m[1]));
  for (const t of TOOLS) named.add(t); // `icon={t}` on the tools row: one glyph per tool
  for (const n of ['share', 'save', 'copy', 'crop', 'style', 'more', 'close']) {
    check(`the brief's ${n} exists`, Array.isArray(F.ICONS[n]) && F.ICONS[n].length > 0);
  }
  for (const n of named) {
    check(`App.js names "${n}" and it exists`, Array.isArray(F.ICONS[n]) && F.ICONS[n].length > 0);
  }
  for (const n of Object.keys(F.ICONS)) {
    check(`"${n}" is used by App.js`, named.has(n));
  }
  check('App.js names every glyph through a literal or a tool', named.size >= 7, named.size);
}

console.log('the paths: every one parses, and stays on the 24 grid');
{
  for (const [name, paths] of Object.entries(F.ICONS)) {
    check(`${name} has paths`, paths.length > 0 && paths.every((p) => typeof p === 'string'));
    for (const [i, d] of paths.entries()) {
      const r = typeof d === 'string' ? parsePath(d) : 'not a string';
      check(`${name}[${i}] is valid path syntax`, typeof r === 'object', r);
      if (typeof r === 'object') {
        check(`${name}[${i}] ends on the grid`, r.pts.every(([x, y]) => x >= 0 && x <= real.ICON_GRID && y >= 0 && y <= real.ICON_GRID),
          JSON.stringify(r.pts));
      }
    }
  }
}

console.log('the parser itself: it rejects what it claims to');
{
  check('accepts a closed shape', typeof parsePath('M1 1h4v4H1z') === 'object');
  check('accepts glued negatives', typeof parsePath('M7 10l5 5 5-5') === 'object');
  check('rejects a lineto start', parsePath('l5 5') === 'does not start with a moveto');
  check('rejects an unknown letter', parsePath('M1 1X2 2') === 'unknown command X');
  check('rejects a short argument list', typeof parsePath('M1 1h') === 'string');
  check('rejects an arc flag of 2', parsePath('M1 1a1 1 0 2 0 2 0') === 'arc flag is not 0 or 1');
}

console.log('icon-only controls: square, and never under the touch floor');
{
  check('the bar size is at least 44', F.ICON_ONLY.bar >= 44, F.ICON_ONLY.bar);
  check('the bar size is at least TOUCH', F.ICON_ONLY.bar >= TOUCH, F.ICON_ONLY.bar);
  check('the floating size is at least 44', F.ICON_ONLY.fit >= 44, F.ICON_ONLY.fit);
  check('the floating size is at least TOUCH', F.ICON_ONLY.fit >= TOUCH, F.ICON_ONLY.fit);
  check('the bar size matches a labelled action on the bar', F.ICON_ONLY.bar === TOUCH + 4);
  check('the default icon fits inside the smallest control', real.ICON_SIZE <= F.ICON_ONLY.fit);
  check('stroke is 2 on a 24 grid', real.ICON_STROKE === 2 && real.ICON_GRID === 24);
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
