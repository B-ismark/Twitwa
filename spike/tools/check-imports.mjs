// Verify every named import between our own modules actually exists.
//
//   node tools/check-imports.mjs
//
// This exists because `npx expo export` — the cheap pre-device gate — resolves
// MODULES but not named exports. A typo'd or renamed named import bundles
// perfectly and arrives as `undefined is not a function` on the device, which is
// the most expensive possible place to find it.
//
// It checks only our own files, because they are the ones that get refactored:
// pulling `cropBackground`'s decision logic out into `decideCropBackground` is
// exactly the change that leaves a stale import behind somewhere.
//
// Two modes, and the output says which was used for each module:
//
//   import  — the module was loaded and its real export list read. Strongest.
//   parse   — the module imports Skia or expo-file-system and CANNOT be loaded
//             in node, so its `export` statements are read out of the source.
//             Weaker: it trusts the text, and would miss `export * from`.
//
// The parse path is not a shortcut, it is the only option. pipeline.js exists to
// hold the Skia calls, so the file most in need of this check is the one that
// cannot be executed here. Naming the mode per module keeps that visible instead
// of letting a weaker check hide behind the same green.
import { readFileSync, readdirSync } from 'node:fs';

// Mutations for the self-test below. A gate with no way to go red is the
// thing this file exists to stop being.
const BREAK = process.env.BREAK || '';
import { join } from 'node:path';

const SRC = 'src';

// DERIVED, not typed. This was `['pixels', 'plan', 'sizing', 'measure',
// 'pipeline']` — a hand-kept list, and it had already gone stale: `src/read.js`
// was added, two files imported `readSubRect` from it, `ourModuleName` returned
// null for './read', and both imports were silently skipped while this gate
// printed that every named import resolves.
//
// That is the FOURTH hole in this one file, and the same root cause as the
// first: the first version globbed `src/*.js` and so missed App.js, and was
// fixed by listing App.js. A list a person maintains is a list that falls
// behind; `ours_missing_module` below is the mutation that restores this one.
//
// `.js` only, so the `.test.mjs` suites in src/ are consumers here, not modules
// to resolve against.
const OURS = BREAK === 'ours_missing_module'
  ? ['pixels', 'plan', 'sizing', 'measure', 'pipeline']
  : readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));

// The modules that CANNOT load in node, because they import Skia, expo or
// react-native. Only these may fall back to source parsing. Anything else
// failing to load is a real error: a syntax error or a broken import in a pure
// module would otherwise be silently downgraded to the weaker check and
// reported as green, which is the exact failure mode this file exists to
// prevent.
//
// DERIVED, not listed. This was `new Set(['measure', 'pipeline'])` until
// src/update-io.js was added, at which point the gate correctly said the new
// module would not load and incorrectly said it "does not import anything
// native" -- it imports react-native on its first line. A hand-kept list beside
// the thing it describes is the fifth hole in this one file and the same root
// cause as the other four. Now a module is native if it says so in its own
// import statements.
const NATIVE_SPECIFIERS = /^(react-native|@shopify\/react-native-skia|react-native-.*|expo|expo-.*|@expo\/.*)$/;
function importsSomethingNative(source) {
  const specs = [
    ...source.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm),
    ...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
  return specs.some((sp) => NATIVE_SPECIFIERS.test(sp));
}
const NATIVE = new Set(
  readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => importsSomethingNative(readFileSync(join(SRC, f), 'utf8')))
    .map((f) => f.replace(/\.js$/, '')),
);

// App.js is included because it is a consumer of every module here and lives
// outside src/: the first import added to it after this file was written was
// `renderCard` from './src/pipeline', which a src-only glob would have missed.
// A gate that only watches the files that export is half a gate.
const files = [
  ...readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => join(SRC, f)),
  'App.js',
];

/** Exported names read out of source text, for modules node cannot load. */
function parseExports(source) {
  const names = new Set();
  for (const [, n] of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(n);
  for (const [, n] of source.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(n);
  // export { a, b as c }
  for (const [, list] of source.matchAll(/export\s*\{([^}]*)\}\s*;?/g)) {
    for (const part of list.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+\*/.test(source)) names.add('*');
  return names;
}

const modes = {};
const cache = {};
const loadErrors = [];

async function exportsOf(mod) {
  if (cache[mod]) return cache[mod];
  try {
    const m = await import(`../${SRC}/${mod}.js`);
    modes[mod] = 'import';
    cache[mod] = new Set(Object.keys(m));
  } catch (e) {
    if (!NATIVE.has(mod)) {
      modes[mod] = 'LOAD FAILED';
      loadErrors.push(
        `  FAILED   ./${mod} could not be loaded and does not import anything native: ${e.message}`,
      );
      cache[mod] = new Set(['*']); // do not also report every name in it as missing
      return cache[mod];
    }
    modes[mod] = 'parse';
    cache[mod] = parseExports(readFileSync(join(SRC, `${mod}.js`), 'utf8'));
  }
  return cache[mod];
}

/**
 * One import specifier, split into the two names it carries.
 *
 * `{ luma as first }` has an EXPORTED name, which the module must actually
 * export, and a LOCAL name, which is the binding this file declares. They are
 * different questions and this gate used to answer both with the exported name:
 *
 *   import { luma as first, luma as second } from './pixels';
 *   // legal - two distinct bindings - and the old gate called it a duplicate
 *
 *   import { luma as same, rgbHex as same } from './pixels';
 *   // a SyntaxError, and the old gate passed it
 *
 * The second is the one that matters, because it is the shape this gate was
 * added to catch. It was added after a duplicate import made pipeline.js
 * unparseable while the gate printed that every name resolved, and one alias was
 * enough to put that hole straight back.
 */
function parseSpecifiers(list) {
  return list
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const parts = t.split(/\s+as\s+/);
      const exported = parts[0].trim();
      const local = (parts[1] || parts[0]).trim();
      return { exported, local: BREAK === 'dup_by_exported' ? exported : local };
    });
}

/**
 * Which of a specifier's two names is checked against the module's exports.
 *
 * A one-line function because the self-test has to be able to see it: the first
 * version of BREAK=resolve_by_local changed the decision at its call site, where
 * the self-test could only reach the parser, and the mutation exited 0 — a
 * mutation that cannot go red, in the file whose whole subject is gates that
 * cannot go red.
 */
function resolvedName(sp) {
  return BREAK === 'resolve_by_local' ? sp.local : sp.exported;
}

/** './pixels' | './src/pixels.js' -> 'pixels', for our own modules only. */
function ourModuleName(spec) {
  const m = /^\.\/(?:src\/)?([A-Za-z0-9_-]+)(?:\.js)?$/.exec(spec);
  return m && OURS.includes(m[1]) ? m[1] : null;
}

/**
 * The gate checks its own rule before it checks any code.
 *
 * A duplicate-detection rule is invisible when it is wrong: every real import in
 * this repo passes under both the right rule and the broken one, so nothing in a
 * normal green run distinguishes them. These four cases do, they cost no
 * measurable time, and they run every time rather than living in a test file
 * somebody remembers to run.
 *
 * BREAK=dup_by_exported restores the old rule; BREAK=resolve_by_local checks the
 * wrong name against the module's exports. Both must make this exit 1.
 */
function selfTest() {
  const bad = [];
  const dupsOf = (list) => {
    const seen = new Set();
    const dup = [];
    for (const sp of parseSpecifiers(list)) {
      if (seen.has(sp.local)) dup.push(sp.local);
      seen.add(sp.local);
    }
    return dup;
  };
  const expect = (what, cond, detail) => { if (!cond) bad.push(`${what} (${detail})`); };

  // Two bindings from one export is legal, however odd.
  expect('two aliases of one export are not a duplicate',
    dupsOf('luma as first, luma as second').length === 0,
    JSON.stringify(dupsOf('luma as first, luma as second')));
  // Two exports aliased to one binding is a SyntaxError.
  expect('two exports aliased to one binding is a duplicate',
    dupsOf('luma as same, rgbHex as same').join() === 'same',
    JSON.stringify(dupsOf('luma as same, rgbHex as same')));
  // The unaliased case that started all this.
  expect('the same name twice is a duplicate',
    dupsOf('luma, rgbHex, luma').join() === 'luma',
    JSON.stringify(dupsOf('luma, rgbHex, luma')));
  // Resolution must use the EXPORTED name. `nope as luma` must not pass merely
  // because `luma` happens to be a real export, so the assertion is on the
  // resolution DECISION against a fake export list, not on the parsed fields.
  const pretendExports = new Set(['luma', 'rgbHex']);
  const aliased = parseSpecifiers('nope as luma')[0];
  expect('resolution reads the exported name, not the local one',
    resolvedName(aliased) === 'nope', JSON.stringify(aliased));
  expect('so an alias cannot smuggle a missing export past the check',
    !pretendExports.has(resolvedName(aliased)), resolvedName(aliased));
  const plain = parseSpecifiers('luma as first')[0];
  expect('while a real export behind an alias still resolves',
    pretendExports.has(resolvedName(plain)), resolvedName(plain));

  // The stale-list hole, asserted rather than trusted.
  //
  // A relative specifier that `ourModuleName` does not recognise is not reported
  // as a problem — it is skipped, and the summary still says every named import
  // resolves. So the coverage is the thing to check: every relative import in
  // every scanned file must land on a module this gate knows how to read. That
  // is what a hand-kept OURS quietly stops being true.
  const unresolved = [];
  for (const file of files) {
    const s = readFileSync(file, 'utf8');
    for (const m of s.matchAll(/import\s*\{[^}]+\}\s*from\s*'(\.[^']+)'/g)) {
      if (!ourModuleName(m[1])) unresolved.push(`${file} -> ${m[1]}`);
    }
  }
  expect('every relative import resolves to a module this gate can read',
    unresolved.length === 0, unresolved.join(', ') || 'none');

  if (bad.length) {
    console.log('  SELFTEST FAILED - the gate cannot be trusted about anything else:');
    for (const b of bad) console.log(`    ${b}`);
    process.exit(1);
  }
  return 7;
}

const selfChecks = selfTest();

let problems = 0;
let checked = 0;

// Every name a file imports from our own modules, so a name pulled in twice is
// caught here rather than by the bundler.
//
// This gate reported "39 named imports across 6 files all resolve" for a
// pipeline.js that could not be parsed at all: `modalOfPoints` had been added to
// an import list that already contained it, which is a SyntaxError — "Identifier
// has already been declared" — and resolving each name separately says nothing
// about the list as a whole. A gate that answers "fine" about code that cannot
// compile is the failure this file exists to prevent, so it checks the list too.
const seenPerFile = new Map();

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // Multi-line named imports from one of our own modules, whether the importer
  // sits beside them ('./pixels') or above them ('./src/pixels'), with or
  // without the extension. Without the optional `.js` this skipped plan.js's own
  // `from './pixels.js'` and `from './sizing.js'` — four names unchecked, while
  // it printed that every named import resolves.
  // Any named import, not only ours: a local binding that collides with one
  // taken from react or expo is the same SyntaxError. Resolution still only
  // applies to our own modules, since theirs are not ours to police.
  //
  // Still out of scope, and deliberately: `import X from`, `import * as X from`
  // and a binding shadowed by a later `const`. Regex is the wrong tool for those
  // and the Metro bundle is the gate that catches them.
  const re = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;
  for (const [, list, spec] of src.matchAll(re)) {
    const specs = parseSpecifiers(list);
    const mod = ourModuleName(spec);

    if (!seenPerFile.has(file)) seenPerFile.set(file, new Map());
    const seen = seenPerFile.get(file);
    for (const sp of specs) {
      const before = seen.get(sp.local);
      if (before !== undefined) {
        console.log(`  DUPLICATE  ${file} declares { ${sp.local} } twice (from '${before}' and '${spec}') — a SyntaxError, not a warning`);
        problems++;
      } else {
        seen.set(sp.local, spec);
      }
    }

    if (!mod) continue;
    const exported = await exportsOf(mod);
    if (exported.has('*')) continue; // cannot resolve through a star re-export
    for (const sp of specs) {
      checked++;
      if (!exported.has(resolvedName(sp))) {
        const shown = sp.exported === sp.local ? sp.exported : `${sp.exported} as ${sp.local}`;
        console.log(`  MISSING  ${file} imports { ${shown} } from './${mod}' — not exported`);
        problems++;
      }
    }
  }
}

const modeLine = Object.entries(modes)
  .map(([m, how]) => `${m}:${how}`)
  .sort()
  .join('  ');
console.log(`  modes  ${modeLine}`);
for (const line of loadErrors) console.log(line);
const failed = problems + loadErrors.length;

// The same floor as check-dead. With an empty src/ this printed "0 named
// imports across 1 files all resolve" and exited 0.
if (files.length === 0 || OURS.length === 0 || checked === 0) {
  console.log(
    `
REFUSING: ${files.length} file(s), ${OURS.length} of our module(s),`
    + ` ${checked} named import(s) checked. Nothing was verified, so this is not a pass.`
    + ' Run it from the spike/ directory.',
  );
  process.exit(1);
}

console.log(
  failed
    ? `\n${problems} import problem(s), ${loadErrors.length} load failure(s), across ${files.length} files`
    : `\n${checked} named imports across ${files.length} files all resolve, no binding declared twice`
      + ` (plus ${selfChecks} self-checks on the rule itself)`,
);
process.exit(failed ? 1 : 0);
