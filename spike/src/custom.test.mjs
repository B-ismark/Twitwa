// Tests for src/custom.js: the saved colours and the three-slider mixer.
//
//   for b in $(grep -o "BREAK === '[a-z_0-9]*'" src/custom.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/custom.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// The rule with teeth is the luma bound: a mixed colour must never trip
// planOutput's near-white or near-black warning, so the whole mixer is swept
// on a dense grid, corners included.
import * as real from './custom.js';
import { TONES, planOutput } from './plan.js';
import { PAPER, INK, luma } from './pixels.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };
const hexLuma = (h) => luma([1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

if (BREAK === 'luma_unbounded') {
  F.mixColour = (m) => (m.shade >= 1 ? '#000000' : m.shade <= 0 && m.strength >= 1 ? '#FFFFFF' : real.mixColour(m));
} else if (BREAK === 'mru_oldest_first') {
  F.addCustom = (l, h) => (real.isCustom(h) ? [...l.filter((x) => x !== h), h].slice(-real.CUSTOM_MAX) : l.slice());
} else if (BREAK === 'no_dedupe') {
  F.addCustom = (l, h) => (real.isCustom(h) ? [h, ...l].slice(0, real.CUSTOM_MAX) : l.slice());
} else if (BREAK === 'no_cap') {
  F.addCustom = (l, h) => (real.isCustom(h) ? [h, ...l.filter((x) => x !== h)] : l.slice());
} else if (BREAK === 'cap_drops_newest') {
  F.addCustom = (l, h) => (real.isCustom(h) ? (l.length >= real.CUSTOM_MAX && !l.includes(h) ? l.slice() : [h, ...l.filter((x) => x !== h)]) : l.slice());
} else if (BREAK === 'add_invalid') {
  F.addCustom = (l, h) => [h, ...l.filter((x) => x !== h)].slice(0, real.CUSTOM_MAX);
} else if (BREAK === 'remove_noop') {
  F.removeCustom = (l) => l.slice();
} else if (BREAK === 'is_custom_lowercase') {
  F.isCustom = (v) => typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
} else if (BREAK === 'is_custom_length') {
  F.isCustom = (v) => typeof v === 'string' && /^#[0-9A-F]{3,8}$/.test(v);
} else if (BREAK === 'is_custom_no_hash') {
  F.isCustom = (v) => typeof v === 'string' && /^#?[0-9A-F]{6}$/.test(v);
} else if (BREAK === 'parse_throws') {
  F.parseCustomList = (v) => v.slice(0, real.CUSTOM_MAX);
} else if (BREAK === 'parse_keeps_junk') {
  F.parseCustomList = (v) => (Array.isArray(v) ? v.slice(0, real.CUSTOM_MAX) : []);
} else if (BREAK === 'parse_keeps_repeats') {
  F.parseCustomList = (v) => (Array.isArray(v) ? v.filter(real.isCustom).slice(0, real.CUSTOM_MAX) : []);
} else if (BREAK === 'parse_no_cap') {
  F.parseCustomList = (v) => (Array.isArray(v) ? [...new Set(v.filter(real.isCustom))] : []);
} else if (BREAK === 'inverse_hue_flipped') {
  F.mixFromHex = (h) => { const m = real.mixFromHex(h); return { ...m, hue: 1 - m.hue }; };
} else if (BREAK === 'inverse_shade_flipped') {
  F.mixFromHex = (h) => { const m = real.mixFromHex(h); return { ...m, shade: 1 - m.shade }; };
} else if (BREAK === 'inverse_grey_nan') {
  F.mixFromHex = (h) => { const m = real.mixFromHex(h); return h.slice(1, 3) === h.slice(3, 5) && h.slice(3, 5) === h.slice(5, 7) ? { ...m, hue: NaN } : m; };
} else if (BREAK === 'inverse_throws_on_junk') {
  F.mixFromHex = (h) => { if (!real.isCustom(h)) throw new Error('bad'); return real.mixFromHex(h); };
} else if (BREAK === 'stops_hold_nothing') {
  F.trackStops = (w, m, n) => real.trackStops(w, { hue: 0, strength: 0, shade: 0 }, n);
} else if (BREAK === 'stops_wrong_length') {
  F.trackStops = (w, m, n) => real.trackStops(w, m, n).slice(1);
} else if (BREAK === 'stops_ends_short') {
  F.trackStops = (w, m, n) => Array.from({ length: n }, (_, i) => real.mixColour({ ...m, [w]: i / n }));
} else if (BREAK === 'nudge_unclamped') {
  F.nudge = (v, d) => v + d * 0.05;
} else if (BREAK === 'nudge_wrong_way') {
  F.nudge = (v, d) => real.nudge(v, -d);
}

let ran = 0;
let fails = 0;
function check(name, ok, detail) {
  ran += 1;
  if (!ok) { fails += 1; console.log(`FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`); } else console.log(`ok    ${name}`);
}
const A = '#112233';
const B = '#445566';
const C = '#778899';
const D = '#AABBCC';
const E = '#DDEEFF';

console.log('isCustom: an uppercase six-digit hex and nothing else');
{
  check('uppercase hex', F.isCustom('#A1B2C3') && F.isCustom('#000000'));
  check('lowercase is not', !F.isCustom('#a1b2c3'));
  check('three digits is not', !F.isCustom('#ABC'));
  check('eight digits is not', !F.isCustom('#A1B2C3FF'));
  check('no hash is not', !F.isCustom('A1B2C3'));
  check('a name is not', !F.isCustom('sky') && !F.isCustom('match'));
  check('non-strings are not', [null, undefined, 7, {}, ['#A1B2C3']].every((v) => !F.isCustom(v)));
  check('a trailing newline is not', !F.isCustom('#A1B2C3\n'));
}

console.log('addCustom: most recent first, no repeats, capped');
{
  check('the cap is four: four saved and Add fit at 360dp', real.CUSTOM_MAX === 4);
  check('first colour goes in', JSON.stringify(F.addCustom([], A)) === JSON.stringify([A]));
  check('most recent first', JSON.stringify(F.addCustom([A, B], C)) === JSON.stringify([C, A, B]));
  check('a repeat moves to the front, once', JSON.stringify(F.addCustom([A, B, C], C)) === JSON.stringify([C, A, B]));
  check('the fifth drops the oldest', JSON.stringify(F.addCustom([A, B, C, D], E)) === JSON.stringify([E, A, B, C]));
  check('never more than the cap', F.addCustom([A, B, C, D], E).length === real.CUSTOM_MAX);
  check('a repeat at full length drops nothing', JSON.stringify(F.addCustom([A, B, C, D], D)) === JSON.stringify([D, A, B, C]));
  const bad = [A, B];
  check('an invalid hex changes nothing', JSON.stringify(F.addCustom(bad, '#abc')) === JSON.stringify(bad) && JSON.stringify(F.addCustom(bad, 'sky')) === JSON.stringify(bad));
  check('the input list is not edited', (() => { const l = [A]; F.addCustom(l, B); return l.length === 1; })());
  check('a missing list is empty', JSON.stringify(F.addCustom(undefined, A)) === JSON.stringify([A]));
}

console.log('removeCustom');
{
  check('takes it out, keeps the order', JSON.stringify(F.removeCustom([A, B, C], B)) === JSON.stringify([A, C]));
  check('a colour not there changes nothing', JSON.stringify(F.removeCustom([A], B)) === JSON.stringify([A]));
  check('a missing list is empty', JSON.stringify(F.removeCustom(null, A)) === '[]');
}

console.log('parseCustomList: tolerant of anything on disk');
{
  let threw = false;
  let out;
  try { out = [undefined, null, 'x', 7, {}, '#112233'].map(F.parseCustomList); } catch { threw = true; }
  check('a non-array is empty, never a throw', !threw && out.every((l) => l.length === 0), threw ? 'threw' : JSON.stringify(out));
  check('junk entries are dropped, valid ones kept in order', JSON.stringify(F.parseCustomList([A, 'sky', '#abc', 5, null, B])) === JSON.stringify([A, B]));
  check('repeats are dropped', JSON.stringify(F.parseCustomList([A, A, B, A])) === JSON.stringify([A, B]));
  check('only the first four are kept', JSON.stringify(F.parseCustomList([A, B, C, D, E])) === JSON.stringify([A, B, C, D]));
  check('junk does not use up the cap', F.parseCustomList(['x', 'y', A, B, C, D, E]).length === 4);
}

console.log('mixColour: always a hex between Ink and Paper in luma');
{
  const lo = hexLuma(INK);
  const hi = hexLuma(PAPER);
  let n = 0;
  let bad = 0;
  let notHex = 0;
  let warned = 0;
  let worst = '';
  const crop = { x: 0, y: 0, w: 1000, h: 2000 };
  for (let i = 0; i <= 36; i += 1) {
    for (let j = 0; j <= 10; j += 1) {
      for (let k = 0; k <= 20; k += 1) {
        const h = F.mixColour({ hue: i / 36, strength: j / 10, shade: k / 20 });
        n += 1;
        if (!real.isCustom(h)) { notHex += 1; continue; }
        const l = hexLuma(h);
        if (l < lo || l > hi) { bad += 1; worst = `${h} luma ${l.toFixed(2)}`; }
        if (planOutput({ crop, frame: h }).warnings.length) warned += 1;
      }
    }
  }
  check('the grid is 37 x 11 x 21', n === 8547, n);
  check('every output is an uppercase six-digit hex', notHex === 0, notHex);
  check('every output is within [luma(Ink), luma(Paper)]', bad === 0, `${bad} outside, e.g. ${worst}`);
  check('so none raises a near-white or near-black warning', warned === 0, warned);
  for (const [name, m] of [['lightest vivid yellow', { hue: 1 / 6, strength: 1, shade: 0 }], ['darkest vivid blue', { hue: 2 / 3, strength: 1, shade: 1 }],
    ['lightest muted', { hue: 0, strength: 0, shade: 0 }], ['darkest muted', { hue: 0, strength: 0, shade: 1 }]]) {
    const l = hexLuma(F.mixColour(m));
    check(`corner: ${name}`, l >= lo && l <= hi, l.toFixed(2));
  }
  check('values outside 0..1 are held to the ends', real.isCustom(F.mixColour({ hue: 9, strength: -3, shade: 12 })));
  check('shade runs light to dark', hexLuma(F.mixColour({ hue: 0.5, strength: 0.5, shade: 0.1 })) > hexLuma(F.mixColour({ hue: 0.5, strength: 0.5, shade: 0.9 })));
  check('strength runs muted to vivid', (() => {
    const sat = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); return Math.max(...c) - Math.min(...c); };
    return sat(F.mixColour({ hue: 0, strength: 0.9, shade: 0.5 })) > sat(F.mixColour({ hue: 0, strength: 0.1, shade: 0.5 }));
  })());
  check('hue 0 and hue 1 meet on the wheel', F.mixColour({ hue: 0, strength: 0.5, shade: 0.5 }) === F.mixColour({ hue: 1, strength: 0.5, shade: 0.5 }));
}

console.log('mixFromHex: the mixer opens on the colour the card shows');
{
  const dist = (a, b) => Math.max(...[1, 3, 5].map((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16))));
  const samples = [...Object.values(TONES), PAPER, INK, '#336699', '#C0504D', '#8E7CC3', '#6AA84F', '#E69138'];
  for (const h of samples) {
    const back = real.mixColour(F.mixFromHex(h));
    check(`round trip ${h} -> ${back}`, dist(h, back) <= 3, dist(h, back));
  }
  const keys = (m) => Object.keys(m).sort().join();
  check('a mix has hue, strength and shade, all in 0..1', samples.every((h) => { const m = F.mixFromHex(h); return keys(m) === 'hue,shade,strength' && Object.values(m).every((v) => v >= 0 && v <= 1); }));
  let threw = false;
  let finite = true;
  try {
    for (let r = 0; r < 256; r += 5) for (let g = 0; g < 256; g += 5) for (let b = 0; b < 256; b += 5) {
      const h = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
      const m = F.mixFromHex(h);
      if (!Object.values(m).every(Number.isFinite)) finite = false;
    }
  } catch { threw = true; }
  check('never throws on a valid hex, and never NaN', !threw && finite);
  check('a grey opens at hue 0', ['#808080', '#000000', '#FFFFFF', '#404040'].every((h) => F.mixFromHex(h).hue === 0));
  check('junk opens on Paper rather than throwing', (() => { try { return JSON.stringify(F.mixFromHex(undefined)) === JSON.stringify(real.mixFromHex(PAPER)) && Number.isFinite(F.mixFromHex('sky').hue); } catch { return false; } })());
  check('a dark colour has a high shade, a light one a low one', F.mixFromHex(TONES.midnight).shade > 0.7 && F.mixFromHex(TONES.sky).shade < 0.3);
  check('a red hue is near 0 and a blue one near 2/3', F.mixFromHex('#C03030').hue < 0.03 && Math.abs(F.mixFromHex('#3030C0').hue - 2 / 3) < 0.03);
}

console.log('trackStops: a track as colours, the other two values held');
{
  const mix = { hue: 0.3, strength: 0.6, shade: 0.4 };
  for (const which of ['hue', 'strength', 'shade']) {
    const s = F.trackStops(which, mix, 24);
    check(`${which}: 24 stops, all hex`, s.length === 24 && s.every(real.isCustom));
    check(`${which}: the first and last are the two ends`, s[0] === real.mixColour({ ...mix, [which]: 0 }) && s[23] === real.mixColour({ ...mix, [which]: 1 }));
  }
  const h1 = F.trackStops('shade', { hue: 0.1, strength: 0.6, shade: 0.4 }, 8).join();
  const h2 = F.trackStops('shade', { hue: 0.6, strength: 0.6, shade: 0.4 }, 8).join();
  check('the shade track re-tints as hue moves', h1 !== h2);
  const s1 = F.trackStops('shade', { hue: 0.3, strength: 0.1, shade: 0.4 }, 8).join();
  const s2 = F.trackStops('shade', { hue: 0.3, strength: 0.9, shade: 0.4 }, 8).join();
  check('and as strength moves', s1 !== s2);
  check('a track holds its own value out of the picture', F.trackStops('hue', { hue: 0.1, strength: 0.6, shade: 0.4 }, 8).join() === F.trackStops('hue', { hue: 0.9, strength: 0.6, shade: 0.4 }, 8).join());
  check('one stop is the start of the track', F.trackStops('hue', mix, 1).length === 1);
}

console.log('nudge: one TalkBack step');
{
  check('up is five hundredths', Math.abs(F.nudge(0.5, 1) - 0.55) < 1e-9, F.nudge(0.5, 1));
  check('down is five hundredths', Math.abs(F.nudge(0.5, -1) - 0.45) < 1e-9);
  check('held at the ends', F.nudge(0.98, 1) === 1 && F.nudge(0.02, -1) === 0 && F.nudge(1, 1) === 1 && F.nudge(0, -1) === 0);
  let v = 0;
  for (let i = 0; i < 20; i += 1) v = F.nudge(v, 1);
  check('twenty steps reach exactly 1, with no float drift', v === 1, v);
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
