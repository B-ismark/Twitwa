// Find exported names that nothing outside their own module references.
//
//   node tools/check-dead.mjs
//
// This exists because `export` is how a module claims a seam, and a claimed seam
// nobody uses is a lie the next reader believes. Six functions in pipeline.js
// carried one: they were exported, called only from inside the file, and could
// not have been imported by anything even in principle — the module imports Skia
// and so cannot be loaded anywhere a test could reach it. One of them had a doc
// comment naming a caller that did not exist.
//
// Two mistakes are worth recording, because both produced a confident wrong
// answer from a working command:
//
//   1. The first version matched names with `new RegExp('\\b' + n + '\\b')`,
//      written through a bash heredoc that ate the backslashes. `'\b'` is a
//      literal backspace character, so every pattern matched nothing and the
//      report was "64 of 64 exported names are dead" — a gate that cannot pass,
//      which reads exactly like a gate that cannot fail. There are no
//      backslashes in any pattern here; word boundaries come from tokenising.
//   2. The second version counted a mention ANYWHERE in another file, comments
//      included. This repo's comments are long and name functions constantly, so
//      a dead export stayed "live" by being discussed. Comments are stripped
//      before anything is counted, and the self-test below asserts that, because
//      it is the difference between the two answers and nothing else shows it.
//
// Out of scope, deliberately: `export default`, `export * from`, and names
// reached only through a dynamic `import()`. None appear in this repo; the
// Metro bundle is what would catch them.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BREAK = process.env.BREAK || '';

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Remove comments, so a name that is only discussed does not read as used.
 *
 * Block comments first, then line comments to end of line. A `//` inside a
 * string literal — `'https://x'` — is over-stripped, which costs nothing here
 * because the tail of a URL holds no identifier this gate tracks. Under-
 * stripping is the direction that would matter, and this errs the other way.
 */
function stripComments(source) {
  if (BREAK === 'keep_comments') return source;
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Every name a module exports, read from its source. */
function exportedNames(source) {
  const names = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm)) {
    names.push(m[1]);
  }
  // CommonJS, because plugins/withReleaseSigning.js is a config plugin and
  // Expo loads those with require(). Without this branch the file entered the
  // denominator and contributed zero names, so the gate printed "all 62
  // exported names ... are used" while being structurally unable to see four of
  // them -- one of which was genuinely dead. A review found it.
  //
  // `module.exports = ...` (the default) is deliberately NOT collected: for a
  // config plugin the consumer is app.json, not another module, so it would
  // read as dead for ever.
  for (const m of source.matchAll(/^module\.exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gm)) {
    names.push(m[1]);
  }
  for (const m of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.push((as[1] || as[0]).trim());
    }
  }
  return [...new Set(names)];
}

/**
 * Which files refer to `name`, not counting the one that exports it.
 *
 * A named function because the self-test has to be able to see the DECISION.
 * `own_file_counts` was first written inline at the call site, where the
 * self-test could only reach the tokeniser, and the mutation exited 0: every
 * module mentions its own exported name in the `export` line itself, so counting
 * the defining file makes everything live and nothing is reported. A mutation
 * that cannot go red, in the file whose subject is gates that cannot go red.
 * This is the second time that exact shape has appeared in this repo's tools.
 */
function liveUsers(name, definedIn, tokenMap) {
  return [...tokenMap]
    .filter(([f, t]) => (BREAK === 'own_file_counts' ? true : f !== definedIn) && t.has(name))
    .map(([f]) => f);
}

/** Is this export dead? The one decision, so a mutation of it is visible. */
function isDead(name, definedIn, tokenMap) {
  if (BREAK === 'never_dead') return false;
  return liveUsers(name, definedIn, tokenMap).length === 0;
}

/**
 * The gate checks its own rule before it checks any code.
 *
 * The first assertion is the control that would have caught mistake 1 above; the
 * comment pair is the whole of mistake 2, invisible in a normal run because both
 * rules agree on every name that is genuinely imported. The last three assert
 * the liveness decision itself against a two-file fixture, which is what makes
 * `own_file_counts` and `never_dead` able to fail at all.
 */
function selfTest() {
  const bad = [];
  const expect = (what, cond, detail) => { if (!cond) bad.push(`${what} (${detail})`); };

  const tokensOf = (s) => new Set(stripComments(s).match(IDENT) || []);

  // Mistake 1: a name plainly used in code must read as used. If the matcher is
  // broken this is what says so, instead of a clean report of total death.
  expect('a name used in code reads as used',
    tokensOf("import { readSubRect } from './read';\nreadSubRect(img, box, RGBA);").has('readSubRect'),
    'matcher sees nothing');

  // Mistake 2: a name only discussed must NOT read as used.
  expect('a name only named in a line comment does not read as used',
    !tokensOf('// readSubRect is the shared body\nconst x = 1;').has('readSubRect'),
    'line comments are being counted');
  expect('nor one in a block comment',
    !tokensOf('/**\n * See readSubRect for the history.\n */\nconst x = 1;').has('readSubRect'),
    'block comments are being counted');

  // And the export reader must see both forms this repo uses.
  const forms = exportedNames('export function a() {}\nexport const b = 1;\nexport { c, d as e };\n');
  expect('every export form is read', forms.join() === 'a,b,c,e', forms.join());

  // The liveness decision, against a fixture rather than against this repo.
  // `used` is exported by one file and referenced by the other; `internal` is
  // exported and referenced only where it is defined, which is the whole rule.
  const fake = new Map([
    ['mod.js', new Set(['used', 'internal', 'helper'])],
    ['app.js', new Set(['used'])],
  ]);
  expect('an export referenced by another file is live',
    !isDead('used', 'mod.js', fake), JSON.stringify(liveUsers('used', 'mod.js', fake)));
  expect('an export referenced only inside its own file is dead',
    isDead('internal', 'mod.js', fake), JSON.stringify(liveUsers('internal', 'mod.js', fake)));
  expect('and the defining file never counts as a user',
    liveUsers('internal', 'mod.js', fake).length === 0,
    JSON.stringify(liveUsers('internal', 'mod.js', fake)));

  if (bad.length) {
    console.log('  SELFTEST FAILED - the gate cannot be trusted about anything else:');
    for (const b of bad) console.log(`    ${b}`);
    process.exit(1);
  }
  return 7;
}

const selfChecks = selfTest();

// Derived from git rather than a glob, so `node_modules`, `android/` and
// `.expo/` are excluded by the same .gitignore everything else obeys instead of
// by a hand-kept skip list.
//
// `--others --exclude-standard` as well as `--cached`: a file added this session
// and not yet committed is part of the project, and a plain `git ls-files` would
// have left src/read.js and its suite out of both the numerator and the
// denominator — the gate would have reported on a tree that no longer existed
// and said nothing about the module just written.
const tracked = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const code = tracked.filter((f) => /[.](js|mjs)$/.test(f));

const source = new Map(code.map((f) => [f, readFileSync(f, 'utf8')]));
const tokens = new Map([...source].map(([f, s]) => [f, new Set(stripComments(s).match(IDENT) || [])]));

let dead = 0;
let live = 0;
const report = [];

for (const [file, s] of source) {
  for (const name of exportedNames(s)) {
    if (!isDead(name, file, tokens)) { live++; continue; }
    dead++;
    report.push(`  DEAD     ${file} exports ${name}, and nothing outside it refers to that name`);
  }
}

for (const line of report) console.log(line);

const total = live + dead;

// A floor, because "all 0 exported names across 0 files are used" is a sentence
// this gate used to print, in green, with exit 0 -- pointed at an empty
// directory or the wrong working directory. Never print a zero for something
// you did not count.
if (code.length === 0 || total === 0) {
  console.log(
    `
REFUSING: found ${code.length} source file(s) and ${total} export(s).`
    + ' This gate has nothing to check, which is a failure and not a pass.'
    + ' Run it from the spike/ directory.',
  );
  process.exit(1);
}

console.log(
  dead
    ? `\n${dead} dead export(s) of ${total}, across ${code.length} files`
    : `\nall ${total} exported names across ${code.length} files are used outside their own module (plus ${selfChecks} self-checks on the rule itself)`,
);
process.exit(dead ? 1 : 0);
