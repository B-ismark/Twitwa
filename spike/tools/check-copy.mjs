// Fails when the app's words break the spec's copy voice, or when a view
// writes its own words instead of taking them from src/copy.js.
//
//   cd spike && node tools/check-copy.mjs
//
//   for b in emdash_blind caps_blind bang_blind dead_copy_blind \
//            literal_text_blind floor_blind label_len_blind; do
//     BREAK=$b node tools/check-copy.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// WHY A GATE AND NOT A PROOFREAD. The copy rules are the kind of thing that is
// true on the day someone tidies the strings and false a fortnight later, and
// nothing about a stray em dash or a shouty label fails a build. It is also
// the one quality in this app a person notices immediately and that no other
// test in this repository could see.
//
// It reads the VALUES out of src/copy.js by importing it, not by grepping the
// source text. Gates here have been wrong before for reading a transcript of
// the data rather than the data, and each time the gate passed while the thing
// it guarded was broken.
//
// THE FIRST VERSION OF THIS FILE COULD NOT FAIL, and the way it could not is
// worth keeping. Its mutations removed a rule from the list that gets applied
// to the copy. But the copy does not break those rules, so removing one
// changed nothing and all six mutations exited 0. A mutation has to make the
// gate BLIND to a defect and then something has to notice the blindness, which
// means every decision needs a name and a fixture: `unusedKeys`,
// `literalWords`, `belowFloor`, and each rule's own `test`. That is the third
// time this exact shape has appeared here. Expect it; it is the default.
import { readFileSync, existsSync } from 'node:fs';
import { COPY, fill } from '../src/copy.js';

// Files that may show words to a person. src/DevPanel.js is deliberately NOT
// here: it is the measurement harness, its words are for whoever is holding a
// cable, and "Q1+Q3" is exactly the label this gate exists to stop everywhere
// else. Its buttons take `name` rather than `label` so the boundary is visible
// in the source and not only in this comment.
const VIEWS = ['App.js'];

const EM_DASH = '—';
const EN_DASH = '–';
const ELLIPSIS = '…';
const MIDDLE_DOT = '·';
const ARROWS = '→⟶»';

// Acronyms allowed to stay capitalised. Everything else in capitals is the
// tracked-out label the spec rules out.
const ALLOWED_CAPS = new Set(['PNG', 'APK', 'JPEG', 'HTTP', 'HTTPS', 'OK']);

// Keys whose value is a control's label rather than a sentence. They get the
// stricter rules: short, and no full stop, because a button is not a sentence.
const LABEL_KEYS = new Set([
  'choose', 'share', 'startOver', 'close', 'more',
  'crop', 'cover', 'style',
  'cancel', 'reset', 'done',
  'padding', 'corners', 'background',
  'snug', 'standard', 'roomy',
  'matchFrame', 'paperFrame', 'inkFrame',
  'updateGet', 'updateLater', 'devTitle',
]);

const BREAK = process.env.BREAK || '';
const KNOWN = [
  'emdash_blind', 'caps_blind', 'bang_blind', 'dead_copy_blind',
  'literal_text_blind', 'floor_blind', 'label_len_blind',
];
// Published rather than hand-copied into the README's mutation loop. Three
// hand-written copies of a list in this repository had already fallen behind
// the thing they listed, which is the same defect as a mutation that cannot
// fire: the loop reports a green it never ran.
if (process.argv.includes('--list-mutants')) {
  console.log(KNOWN.slice().sort().join('\n'));
  process.exit(0);
}
if (BREAK && !KNOWN.includes(BREAK)) {
  console.log(`unknown BREAK: ${BREAK}`);
  process.exit(2);
}
const blind = (which) => BREAK === which;

/**
 * The rules. Each carries the sample it must reject and the sample it must
 * accept, so the self-check can prove the rule works without the real copy
 * having to be broken.
 */
const RULES = [
  {
    name: 'no em or en dash',
    bad: `Save ${EM_DASH} now`,
    good: 'Save now',
    test: (s) => (!blind('emdash_blind') && (s.includes(EM_DASH) || s.includes(EN_DASH))
      ? 'contains an em or en dash' : null),
  },
  {
    name: 'no ellipsis',
    bad: `Working${ELLIPSIS}`,
    good: 'Working',
    test: (s) => (s.includes(ELLIPSIS) || s.includes('...') ? 'contains an ellipsis' : null),
  },
  {
    name: 'no middle dot',
    bad: `1080 ${MIDDLE_DOT} PNG`,
    good: '1080 PNG',
    test: (s) => (s.includes(MIDDLE_DOT) ? 'contains a middle dot' : null),
  },
  {
    name: 'no arrow',
    bad: `Continue →`,
    good: 'Continue',
    test: (s) => ([...s].some((c) => ARROWS.includes(c)) ? 'contains an arrow' : null),
  },
  {
    name: 'no exclamation mark',
    bad: 'Saved!',
    good: 'Saved',
    test: (s) => (!blind('bang_blind') && s.includes('!')
      ? 'contains an exclamation mark' : null),
  },
  {
    name: 'no tracked-out capitals',
    bad: 'SAVE TO PHOTOS',
    good: 'Save to Photos',
    test: (s) => {
      if (blind('caps_blind')) return null;
      const shouty = (s.match(/\b[A-Z]{2,}\b/g) || []).filter((w) => !ALLOWED_CAPS.has(w));
      return shouty.length ? `capitalised: ${shouty.join(', ')}` : null;
    },
  },
  {
    name: 'no double space',
    bad: 'Card  ready',
    good: 'Card ready',
    test: (s) => (s.includes('  ') ? 'contains a double space' : null),
  },
  {
    name: 'no stray whitespace at the ends',
    bad: ' Card ready',
    good: 'Card ready',
    test: (s) => (s !== s.trim() ? 'has leading or trailing whitespace' : null),
  },
  {
    name: 'not empty',
    bad: '',
    good: 'Card ready',
    test: (s) => (s.length === 0 ? 'is empty' : null),
  },
  {
    name: 'placeholders are well formed',
    bad: 'Twitwa {0} is available',
    good: 'Twitwa {version} is available',
    // A brace that is not a `{name}` is either a typo or a value that will be
    // rendered to the screen as literal braces.
    test: (s) => {
      const braces = s.match(/\{[^}]*\}/g) || [];
      const malformed = braces.filter((b) => !/^\{[a-zA-Z]+\}$/.test(b));
      if (malformed.length) return `malformed placeholder: ${malformed.join(', ')}`;
      return (s.match(/[{}]/g) || []).length !== braces.length * 2 ? 'unbalanced brace' : null;
    },
  },
];

// Applied to LABEL_KEYS only.
const LABEL_RULES = [
  {
    name: 'a label is short',
    bad: 'Choose a screenshot from your photo library',
    good: 'Choose screenshot',
    test: (s) => (!blind('label_len_blind') && s.length > 24
      ? `${s.length} characters, over 24` : null),
  },
  {
    name: 'a label is not a sentence',
    bad: 'Start over.',
    good: 'Start over',
    test: (s) => (/[.]$/.test(s) ? 'ends with a full stop' : null),
  },
];

/** Keys in the deck that no view ever shows. Named so it can be fixtured. */
function unusedKeys(keys, sourceText) {
  if (blind('dead_copy_blind')) return [];
  return keys.filter((k) => !new RegExp(`COPY\\.${k}\\b`).test(sourceText));
}

/**
 * Places where a view writes its own user-facing words. Two shapes: a literal
 * `label` prop, and a literal run of words as the child of a Text element.
 * Comment lines are skipped, because a comment is for a developer.
 */
function literalWords(file, text) {
  if (blind('literal_text_blind')) return [];
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const label = line.match(/\blabel=\{?["'`]([^"'`]{2,})["'`]/);
    if (label) found.push(`${file}:${i + 1} label="${label[1]}"`);
    const textChild = line.match(/<Text[^>]*>\s*([A-Za-z][A-Za-z ,']{4,})\s*(<|$)/);
    if (textChild) found.push(`${file}:${i + 1} <Text>${textChild[1].trim()}`);
  });
  return found;
}

/** Is this too small a deck to be worth calling a pass? */
function belowFloor(count) {
  return count < (blind('floor_blind') ? 0 : 6);
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// --- self-checks: every decision proven to work, before any is trusted ------
console.log('each rule rejects its bad sample and accepts its good one');
{
  for (const r of [...RULES, ...LABEL_RULES]) {
    check(`${r.name}: rejects`, r.test(r.bad) !== null, JSON.stringify(r.bad));
    check(`${r.name}: accepts`, r.test(r.good) === null,
      `${JSON.stringify(r.good)} -> ${r.test(r.good)}`);
  }
}

console.log('the three source-reading decisions work on a fixture');
{
  check('unusedKeys finds a key no view mentions',
    unusedKeys(['ghost'], 'nothing in here').join(',') === 'ghost');
  check('unusedKeys stays quiet about a key a view uses',
    unusedKeys(['ghost'], 'const x = COPY.ghost;').length === 0);
  // The discriminating pair: a prefix must not count as a use.
  check('unusedKeys does not accept a longer name as a use',
    unusedKeys(['cover'], 'COPY.coverHint').join(',') === 'cover');

  check('literalWords finds a hardcoded label',
    literalWords('f.js', '<Action label="Save it" />').length === 1);
  check('literalWords finds words inside a Text element',
    literalWords('f.js', '<Text style={s}>Share in a screenshot</Text>').length === 1);
  check('literalWords allows a label taken from the deck',
    literalWords('f.js', '<Action label={COPY.share} />').length === 0);
  check('literalWords allows an expression inside a Text element',
    literalWords('f.js', '<Text style={s}>{COPY.emptyTitle}</Text>').length === 0);
  check('literalWords ignores a comment',
    literalWords('f.js', '  // <Text>Share in a screenshot</Text>').length === 0);

  check('belowFloor rejects an empty deck', belowFloor(0) === true);
  check('belowFloor rejects a deck of one', belowFloor(1) === true);
  check('belowFloor accepts a real deck', belowFloor(20) === false);
}

// --- a floor, so a gate with nothing to read cannot pass --------------------
const entries = Object.entries(COPY).filter(([, v]) => typeof v === 'string');
if (belowFloor(entries.length)) {
  console.log(`REFUSING: src/copy.js has ${entries.length} strings, which is not a copy deck.`);
  console.log('An empty deck passing every rule is not the same as copy that is fine.');
  process.exit(1);
}
console.log('there is something to check');
{
  check('every value in the deck is a string',
    Object.values(COPY).every((v) => typeof v === 'string'), 'a non-string value is present');
  check('every label key exists in the deck',
    [...LABEL_KEYS].every((k) => k in COPY),
    [...LABEL_KEYS].filter((k) => !(k in COPY)).join(', '));
}

// --- the copy itself --------------------------------------------------------
console.log(`the ${entries.length} strings follow the voice`);
{
  const problems = [];
  for (const [key, value] of entries) {
    for (const r of RULES) {
      const why = r.test(value);
      if (why) problems.push(`${key}: ${why}`);
    }
    if (LABEL_KEYS.has(key)) {
      for (const r of LABEL_RULES) {
        const why = r.test(value);
        if (why) problems.push(`${key}: ${why}`);
      }
    }
  }
  check(`all ${entries.length} strings pass all ${RULES.length} rules`,
    problems.length === 0, problems.join(' | '));

  // Two keys with the same words means one is a leftover, or they are one
  // string being maintained twice.
  const seen = new Map();
  const dupes = [];
  for (const [key, value] of entries) {
    if (seen.has(value)) dupes.push(`${seen.get(value)} and ${key}`);
    else seen.set(value, key);
  }
  check('no two keys carry the same words', dupes.length === 0, dupes.join(', '));
}

// --- fill() ------------------------------------------------------------------
console.log('fill refuses a placeholder it has no value for');
{
  check('it substitutes',
    fill('Twitwa {version} is available', { version: '1.0.1' }) === 'Twitwa 1.0.1 is available');
  let threw = null;
  try { fill('Twitwa {version} is available', {}); } catch (e) { threw = e; }
  check('a missing value throws rather than rendering braces', threw !== null, String(threw));
  check('and the message names the placeholder', /\{version\}/.test(threw ? threw.message : ''),
    threw && threw.message);
}

// --- the views ---------------------------------------------------------------
console.log('the views exist and take their words from the deck');
{
  const sources = new Map();
  for (const f of VIEWS) {
    check(`${f} exists`, existsSync(f), 'listed in VIEWS but not on disk');
    if (existsSync(f)) sources.set(f, readFileSync(f, 'utf8'));
  }
  check('at least one view was read', sources.size > 0, String(sources.size));
  const all = [...sources.values()].join('\n');

  const unused = unusedKeys(Object.keys(COPY), all);
  check('no key in the deck goes unused', unused.length === 0, unused.join(', '));

  const literals = [];
  for (const [file, text] of sources) literals.push(...literalWords(file, text));
  check('no view writes its own user-facing words', literals.length === 0, literals.join(' | '));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
