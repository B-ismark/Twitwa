// Tests for src/mark.js.
//
//   for b in $(grep -o "BREAK === '[a-z_0-9]*'" src/mark.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/mark.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// The mark is one set of shapes read by two renderers, so what can go wrong
// is the data: a shape pushed out of the launcher's safe circle (the system
// mask then crops it), a colour role with no colour (an SVG with fill="undefined"
// renders black), or the dark mode leaking light values.
import { readFileSync } from 'node:fs';
import * as real from './mark.js';
import { group } from '../tools/icon/art.mjs';

const BREAK = process.env.BREAK || '';
const F = {
  ...real,
  BAR: { ...real.BAR, rects: real.BAR.rects.map((r) => ({ ...r })) },
  CARD: real.CARD.map((r) => ({ ...r })),
  COLOURS: { light: { ...real.COLOURS.light }, dark: { ...real.COLOURS.dark }, mono: { ...real.COLOURS.mono } },
};
if (BREAK === 'card_too_tall') {
  F.CARD[0].height = 46;
} else if (BREAK === 'bar_too_wide') {
  F.BAR.rects[0].width = 60;
  F.BAR.rects[0].x = 24;
} else if (BREAK === 'dark_is_light') {
  F.COLOURS.dark = { ...F.COLOURS.light };
} else if (BREAK === 'role_missing') {
  delete F.COLOURS.dark.screen;
} else if (BREAK === 'unknown_role') {
  F.CARD[1].fill = 'accent';
}

let ran = 0;
let fails = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// `reach` reads the module's own exports, so a mutant on the geometry has to be
// measured with the same function: bind it to the mutated copies.
function reachOf(scale) {
  const saved = [real.BAR.rects, real.CARD];
  const mutated = BREAK === 'card_too_tall' || BREAK === 'bar_too_wide';
  if (!mutated) return real.reach(scale);
  // The module's arrays are shared objects; apply the same edit in place for the call.
  const undo = [];
  const patch = (arr, src) => arr.forEach((r, i) => { undo.push([r, { ...r }]); Object.assign(r, src[i]); });
  patch(saved[0], F.BAR.rects);
  patch(saved[1], F.CARD);
  const out = real.reach(scale);
  for (const [r, o] of undo) Object.assign(r, o);
  return out;
}

console.log('the safe circle: nothing leaves it at the launcher scale');
{
  const r = reachOf(real.LAUNCHER_SCALE);
  check('reach at 0.928 is inside 33 units', r <= real.SAFE_RADIUS, r);
  check('reach at 0.928 is within 1 unit of the measured 32.55', Math.abs(r - 32.55) < 1, r);
  check('at scale 1 the mark does NOT fit (the scale is doing work)', reachOf(1) > real.SAFE_RADIUS, reachOf(1));
  check('reach scales linearly', Math.abs(reachOf(0.5) * 2 - reachOf(1)) < 1e-9);
}

console.log('the colours: every role the shapes use has one in every mode');
{
  const roles = new Set([...F.BAR.rects, ...F.CARD].map((r) => r.fill));
  roles.add(real.LINE.fill);
  for (const mode of ['light', 'dark', 'mono']) {
    for (const role of roles) {
      check(`${mode} has a colour for "${role}"`, typeof F.COLOURS[mode][role] === 'string' && F.COLOURS[mode][role] !== '');
    }
  }
  check('dark body is paper and light body is ink',
    F.COLOURS.dark.body === real.PAPER && F.COLOURS.light.body === real.INK);
  check('dark differs from light in every role', ['body', 'cut', 'line', 'screen'].every((k) => F.COLOURS.dark[k] !== F.COLOURS.light[k]));
  check('the cuts are the ground: light cut is paper, dark cut is ink',
    F.COLOURS.light.cut === real.PAPER && F.COLOURS.dark.cut === real.INK);
  check('coloursFor picks by mode', real.coloursFor('dark') === real.COLOURS.dark
    && real.coloursFor('light') === real.COLOURS.light && real.coloursFor('mono') === real.COLOURS.mono);
  check('coloursFor falls back to light', real.coloursFor(null) === real.COLOURS.light);
}

console.log('art.mjs draws from this data, and nothing else');
{
  const svg = group('dark', 1);
  check('dark SVG uses the dark accent', svg.includes(real.SIGNAL_DARK) && !svg.includes(real.SIGNAL + '"'));
  check('SVG carries the bar rotation', svg.includes('rotate(-9 54 30)'));
  check('SVG has every rect', (svg.match(/<rect /g) || []).length === real.BAR.rects.length + real.CARD.length);
  check('SVG carries the dash', svg.includes('stroke-dasharray="4 6"'));
  const art = readFileSync(new URL('../tools/icon/art.mjs', import.meta.url), 'utf8');
  check('art.mjs writes no shape of its own', !/<rect x="\d/.test(art) && !/x1="\d/.test(art));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
