// Tests for plugins/withReleaseSigning.js.
//
//   for b in $(node plugins/withReleaseSigning.test.mjs --list-mutants); do
//     BREAK=$b node plugins/withReleaseSigning.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. The list comes from `--list-mutants`, not from a grep
// in a comment: this file used to carry the grep and README carried a second
// copy of it, and the two already disagreed (`[a-z_]*` here, `[a-z_0-9]*`
// there), so a mutation named with a digit would have been silently skipped by
// one of them. One source, queried.
//
// HOW THE MUTANTS WORK, because the first version of this got it wrong in the
// way that matters most. Each BREAK used to REPLACE `patch` with a stub written
// in this file. That proves the assertions go red against a *different
// function* — it says nothing about a defect in the real one. A review made the
// point concretely: all three stubs lacked any anchor-check code, so five
// checks fired on every one of them, which is trivially true and worthless as
// signal; and `drop_anchor_check`'s failure set was a strict subset of
// `always_debug`'s, so one of the three added no coverage at all.
//
// Now every mutant is a textual edit to the REAL source of
// withReleaseSigning.js, loaded from a temp copy. If an edit's anchor is not
// found in the source, the harness fails loudly rather than testing nothing —
// a mutation that no longer applies is the same defect as an assertion that
// cannot fail.
//
// WHERE THE INPUT COMES FROM. The surgery runs against
// plugins/fixtures/build.gradle.pristine, which was not hand-copied: it was
// recovered by inverting the plugin's own substitutions on a generated file,
// and proven by patching it forward and comparing byte-for-byte. An earlier
// version read android/app/build.gradle directly and so passed before a
// prebuild and failed after it, because the transformation under test had
// consumed the anchors it asserted on.
//
// WHAT THIS FILE STILL CANNOT DO: run Gradle. That the patched file parses as
// Groovy, that `signingConfigs.release` resolves, and that the GradleException
// paths fire are all unobserved here. The gate for that is tools/verify-apk.sh,
// which reads the signature off the built APK — the only check in this repo
// that looks at the artifact instead of the source.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

const PLUGIN_SRC_PATH = 'plugins/withReleaseSigning.js';
const FIXTURE = 'plugins/fixtures/build.gradle.pristine';
const LIVE = 'android/app/build.gradle';
// sha256 of the fixture, recorded 2026-09-18 from the generated file the
// anchors were derived from. See the check that reads it for when to change it.
//
// Both digests moved once already, on 2026-09-18, when the package was renamed
// dev.bismark.twitwaspike -> dev.bismark.twitwa. `namespace` and `applicationId`
// are written into app/build.gradle by prebuild, so a rename changes the
// template. The diff was read before the digests were touched: exactly two
// lines, 10 bytes, which is `spike` removed twice. Regenerate with
// `node plugins/fixtures/make-pristine.js`, which prints both values and
// refuses if the recovery is not faithful.
//
// And again for 1.0.2 (2026-09-22): versionCode and versionName are in the
// template too, so every release moves both digests. Diff read first: the two
// version lines and nothing else. make-pristine.js was NOT used that time: it
// inverts only this plugin, so its output kept withDebugSuffix's block, which
// the chain check then applies a second time. The two lines were edited by
// hand instead, and the chain check going green is what shows that was right.
// 1.0.3 (2026-09-23): the same two lines, edited by hand the same way.
const FIXTURE_SHA256 = '0662fce30a5b1e7710db345845808b0a59464f3886ac217cfb8a8dfa0f5c0205';
// sha256 of patch(fixture) -- the expected PATCHED output, recorded the same day
// and equal to the generated android/app/build.gradle byte-for-byte.
//
// This exists because the `out.includes(S.LOADER)` style of check is derived
// from the module under test, so a mutation that edits the LOADER constant also
// edits the expected value and the check passes. That is how
// `loader_after_android` survived a cold-clone run at exit 0: the only thing
// that had caught it was the comparison against the generated tree, which a
// clone does not have. A digest recorded OUTSIDE the module cannot be moved by
// mutating the module.
//
// It fails on every intentional change to the plugin, by design. Update it in
// the same commit as the change, after reading the diff -- never to silence a
// red run.
const PATCHED_SHA256 = '8f5a13c6c3a354a32430ea737129b445dd7f2c12ef1edd6d96ddadf4636ba9ea';

// --- the mutants -----------------------------------------------------------
// Each is [find, replace] applied to the real plugin source. Keep them to the
// smallest edit that produces a plausible wrong plugin.
const MUTANTS = {
  // The anchor check stops working: a changed template is patched blind.
  anchor_check_dead: ['if (misses.length) {', 'if (misses.length && false) {'],
  // Release builds are signed with the debug key exactly when a real key IS
  // available. One character.
  invert_selector: ['twitwaKeystore != null ? signingConfigs.release', 'twitwaKeystore == null ? signingConfigs.release'],
  // The already-applied guard stops matching, so a second prebuild declares the
  // variable twice and Gradle cannot parse the file.
  idem_guard_dead: ["contents.includes('twitwaKeystore')", "contents.includes('twitwaKeystoreZ')"],
  // A set-but-missing properties file becomes a log line instead of a failure —
  // the single most dangerous edit in this list, and the one the old suite
  // could not see, because it only asserted that the MESSAGE text was present.
  throw_becomes_log: ['throw new GradleException("TWITWA_KEYSTORE_PROPERTIES is set', 'logger.lifecycle("TWITWA_KEYSTORE_PROPERTIES is set'],
  // The release signingConfig is emitted as a sibling of signingConfigs rather
  // than inside it, so signingConfigs.release does not exist.
  release_outside_block: ['        release {\n            if (twitwaKeystore != null) {', '    }\n    release {\n            if (twitwaKeystore != null) {'],
  // An absolute POSIX path is baked into the generated gradle file.
  posix_path_leak: ["def twitwaKeystore = null\n", "def twitwaKeystore = null\ndef fallbackKey = file('/home/someone/app-signing/release.jks')\n"],
  // The loader reads the wrong environment variable, so a correctly configured
  // machine still produces a debug-signed release.
  env_var_typo: ["System.getenv('TWITWA_KEYSTORE_PROPERTIES')", "System.getenv('TWITWA_KEYSTORE_PROPERTIE')"],
  // The loader is emitted after the android block instead of before it, so
  // signingConfigs cannot see the variable.
  loader_after_android: ['android {`;', 'android {\ndef twitwaKeystoreLate = null`;'],
  // prebuild's leftover template is no longer made unbuildable, so a failed
  // prebuild leaves a debug-signed release ready to build.
  no_poison: ['fs.writeFileSync(p, POISON_HEADER + current);', '/* removed */;'],
};

// Fixture mutants. These exist because three checks assert properties of the
// FIXTURE, and no edit to the plugin can redden them — a review correctly
// called them decoration. What can break them is the fixture being regenerated
// or normalised wrongly, so that is what these simulate. `fixture_crlf` is the
// real-world one: core.autocrlf=true on this machine rewrote this file on
// checkout until .gitattributes pinned it.
const FIXTURE_MUTANTS = {
  fixture_crlf: (s) => s.replace(/\n/g, '\r\n'),
  fixture_already_patched: (s) => s.replace('android {', 'def twitwaKeystore = null\nandroid {'),
  fixture_bug_removed: (s) => s.replace('signingConfig signingConfigs.debug', 'signingConfig signingConfigs.release'),
};

if (process.argv.includes('--list-mutants')) {
  console.log([...Object.keys(MUTANTS), ...Object.keys(FIXTURE_MUTANTS)].sort().join('\n'));
  process.exit(0);
}

const BREAK = process.env.BREAK || '';

// --- load the plugin, mutated or not ---------------------------------------
// Line endings normalised, because the mutants below are written with `\n`
// and a Windows clone (core.autocrlf=true) checks the plugin out with CRLF.
// Without this, every mutant spanning a line break reports NO LONGER APPLIES
// on that clone and tests nothing. Found 2026-09-22 by gating a CRLF export:
// six of them, in all three plugin suites. JS reads CRLF and LF alike, so the
// mutated copy behaves as the real file does.
const realSource = readFileSync(PLUGIN_SRC_PATH, 'utf8').replace(/\r\n/g, '\n');
let plugin;

if (BREAK && MUTANTS[BREAK]) {
  const [find, replace] = MUTANTS[BREAK];
  if (!realSource.includes(find)) {
    console.log(`MUTATION ${BREAK} NO LONGER APPLIES: ${JSON.stringify(find.slice(0, 60))} is not in ${PLUGIN_SRC_PATH}.`);
    console.log('A mutation that cannot be applied tests nothing. Update it or delete it.');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'twitwa-mutant-'));
  const f = join(dir, 'withReleaseSigning.js');
  writeFileSync(f, realSource.split(find).join(replace));
  plugin = require(f);
} else if (BREAK && !FIXTURE_MUTANTS[BREAK]) {
  console.log(`unknown BREAK=${BREAK}. Known: ${[...Object.keys(MUTANTS), ...Object.keys(FIXTURE_MUTANTS)].join(', ')}`);
  process.exit(1);
} else {
  plugin = require('./withReleaseSigning.js');
}

const patch = plugin.patch;
const S = plugin.strings;

// --- reporting -------------------------------------------------------------
let fails = 0;
let ran = 0;
let skipped = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}
function skip(name, why) {
  skipped++;
  console.log(`  SKIP  ${name}  -> ${why}`);
}

// --- helpers ---------------------------------------------------------------
/** Extract a brace-balanced block starting at `header`, so nesting can be
 *  asserted rather than guessed. A `[\s\S]*?` regex crosses block boundaries
 *  and cannot tell `release {}` inside `signingConfigs {}` from one after it —
 *  a review demonstrated a mutant that moved the block out and still passed. */
function blockAfter(text, header) {
  const i = text.indexOf(header);
  if (i < 0) return null;
  let depth = 0;
  for (let j = text.indexOf('{', i); j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(i, j + 1); }
  }
  return null;
}

/** Absolute paths and key material of every shape, not just this machine's.
 *  The old check matched only a Windows drive letter preceded by one of seven
 *  characters, so POSIX, UNC and `user.home` paths all sailed through. */
function findLeaks(text) {
  const pats = [
    [/(?:^|[\s'"(=,[\]>])[A-Za-z]:[\\/]/, 'windows drive path'],
    [/(?:^|[\s'"(=,[\]>])\/(?:home|Users|mnt|opt|var|tmp|root)\//, 'posix absolute path'],
    [/\\\\[A-Za-z0-9._-]+\\/, 'UNC path'],
    [/(?:^|[\s'"(=,])\/\/[A-Za-z0-9._-]+\//, 'UNC-style forward path'],
    [/user\.home|System\.getProperty/, 'host-derived path'],
    [/Twitwa-signing/, "this project's signing directory"],
    [/(?:storePassword|keyPassword|keyAlias)\s+['"][^'"$]+['"]/, 'literal credential'],
  ];
  const hits = [];
  for (const [re, label] of pats) {
    const m = text.match(re);
    if (m) hits.push(`${label}: ${JSON.stringify(m[0])}`);
  }
  return hits;
}

// --- the fixture -----------------------------------------------------------
if (!existsSync(FIXTURE)) {
  console.log(`SKIPPED: ${FIXTURE} is missing. Refusing to pass without an input.`);
  process.exit(1);
}
let pristine = readFileSync(FIXTURE, 'utf8');
if (BREAK && FIXTURE_MUTANTS[BREAK]) pristine = FIXTURE_MUTANTS[BREAK](pristine);

console.log('the fixture is a real pristine template');
check('it carries both anchors the plugin looks for',
  pristine.includes(S.SIGNING_CONFIGS) && pristine.includes(S.RELEASE_SIGNING));
check('it really does sign the release build with the debug key',
  /release \{[\s\S]{0,400}?signingConfig signingConfigs\.debug/.test(pristine));
check('it has not been patched already', !pristine.includes(S.VAR));
// LF, asserted directly. core.autocrlf=true on this machine rewrote this file
// on every checkout until .gitattributes pinned it, and the symptom was the
// plugin reporting "the Expo template changed" — a misdiagnosis, not a failure.
check('it is stored with LF endings, which exact matching depends on',
  !pristine.includes('\r'),
  pristine.includes('\r') ? 'contains CR — check .gitattributes' : undefined);
// Pinned by digest so fixture drift is caught on a FRESH CLONE too. Without
// this, the only check that could see a drifted fixture was the byte-for-byte
// comparison against android/app/build.gradle — which is skipped when there is
// no generated tree, i.e. in every clone. A review found two mutants that
// survived exactly there.
//
// When Expo's template legitimately changes: regenerate the fixture by
// inverting the plugin's substitutions on the new generated file, re-run, and
// update this digest deliberately in the same commit. Updating it to silence a
// failure without looking at the diff is the whole thing this guards against.
check('the fixture is byte-identical to the one these anchors were written against',
  createHash('sha256').update(pristine).digest('hex') === FIXTURE_SHA256,
  createHash('sha256').update(pristine).digest('hex'));

console.log('\npatching it');
let out = null;
let patchError = null;
try { out = patch(pristine); } catch (e) { patchError = e; }

if (patchError) {
  // A mutant may legitimately make patch() throw. Do not let that abort the
  // run: an uncaught throw prints no total and skips every later check, which
  // is how a mutant "passes" by crashing.
  check('patch() did not throw on a pristine template', false, patchError.message.split('\n')[0]);
  for (const n of [
    'the release build no longer selects the debug config unconditionally',
    'it selects the release config when a keystore is present',
    'the release signingConfig is nested INSIDE signingConfigs',
    'the debug signingConfig is left alone',
    'the loader is present, and before the android block',
    'the loader reads the environment variable this project documents',
    'the debug block was located, so the exemption is narrow and not a blanket',
    'no absolute path or credential leaked into the gradle file',
    'the loader block is emitted exactly as the module defines it',
    'the signingConfigs block is emitted exactly as the module defines it',
    'the release buildType line is emitted exactly as the module defines it',
    'the patched output matches the digest recorded outside this module',
    'a set-but-missing properties file raises a Gradle failure, not a log line',
  ]) check(n, false, 'patch() threw');
} else {
  check('the release build no longer selects the debug config unconditionally',
    !out.includes(S.RELEASE_SIGNING));
  check('it selects the release config when a keystore is present',
    out.includes(`signingConfig ${S.VAR} != null ? signingConfigs.release : signingConfigs.debug`));

  // Nesting, by brace matching rather than by a boundary-crossing regex.
  const sc = blockAfter(out, 'signingConfigs {');
  check('the release signingConfig is nested INSIDE signingConfigs',
    sc !== null && /release \{/.test(sc) && sc.includes(`storeFile file(${S.VAR}.getProperty('storeFile'))`),
    sc === null ? 'no signingConfigs block found' : 'release block not inside it');

  check('the debug signingConfig is left alone', out.includes(S.DEBUG_STORE));

  // `indexOf(a) < indexOf(b)` is true whenever a is absent, because -1 beats
  // everything. Renaming the Groovy variable made this pass on output with no
  // loader in it at all. Presence is now asserted first.
  const iVar = out.indexOf(`def ${S.VAR} = null`);
  const iAndroid = out.indexOf('\nandroid {');
  check('the loader is present, and before the android block',
    iVar >= 0 && iAndroid >= 0 && iVar < iAndroid,
    `loader@${iVar} android@${iAndroid}`);

  check('the loader reads the environment variable this project documents',
    out.includes(`System.getenv('${S.ENV}')`));

  // Each substitution pinned verbatim. This is what gives a fresh clone the
  // same coverage the byte-for-byte comparison gives a warm tree: any edit
  // inside an injected block -- a stray declaration, a leaked path, a reordered
  // loader -- fails here, with no generated file required. Two mutants
  // (loader_after_android, posix_path_leak) were caught ONLY by byte-for-byte
  // before this existed, and byte-for-byte is skipped in every clone.
  check('the loader block is emitted exactly as the module defines it',
    out.includes(S.LOADER));
  check('the signingConfigs block is emitted exactly as the module defines it',
    out.includes(S.SIGNING_CONFIGS_PATCHED));
  check('the release buildType line is emitted exactly as the module defines it',
    out.includes(S.RELEASE_SIGNING_PATCHED));
  // The one check above that is NOT derived from the module under test.
  check('the patched output matches the digest recorded outside this module',
    createHash('sha256').update(out).digest('hex') === PATCHED_SHA256,
    createHash('sha256').update(out).digest('hex'));

  // The debug signingConfig is exempt from the credential scan, and only it.
  // Its `storePassword 'android'` / `keyAlias 'androiddebugkey'` are public by
  // design — the same four lines are in every React Native project, and the
  // check above asserts they are left untouched. Everything outside that block
  // is scanned, so a real credential written into the release config, or
  // anywhere else in the file, still fires.
  const debugBlock = blockAfter(out, 'debug {\n            storeFile');
  const scanned = debugBlock ? out.split(debugBlock).join('/* debug signingConfig, exempt */') : out;
  check('the debug block was located, so the exemption is narrow and not a blanket',
    debugBlock !== null && debugBlock.includes(S.DEBUG_STORE));
  const leaks = findLeaks(scanned);
  check('no absolute path or credential leaked into the gradle file',
    leaks.length === 0, leaks.join('; '));

  // The property, not the prose. Asserting only that the message text is
  // present could not tell a throw from a log line — which is exactly the
  // property this check is named for, and a review showed the suite still
  // printed 21/21 after swapping the throw for logger.lifecycle.
  const loader = out.slice(0, iAndroid < 0 ? out.length : iAndroid);
  check('a set-but-missing properties file raises a Gradle failure, not a log line',
    loader.includes(S.GRADLE_THROW) && loader.includes(S.REFUSE_MESSAGE),
    loader.includes(S.REFUSE_MESSAGE) && !loader.includes(S.GRADLE_THROW)
      ? 'the message is there but it is not a throw'
      : undefined);
}

console.log('\nrunning twice (prebuild runs plugins every time)');
if (out === null) {
  check('the second application changes nothing', false, 'patch() threw');
  check('the loader is declared exactly once', false, 'patch() threw');
} else {
  let twice = null;
  try { twice = patch(out); } catch (e) { /* recorded by the check below */ }
  check('the second application changes nothing', twice === out);
  check('the loader is declared exactly once',
    (String(twice).match(new RegExp(`def ${S.VAR} = null`, 'g')) || []).length === 1,
    (String(twice).match(new RegExp(`def ${S.VAR} = null`, 'g')) || []).length);
}

console.log('\nfailing closed when the template is unrecognisable');
// prebuild writes the native template BEFORE running mods, so a throw alone
// leaves a buildable debug-signed tree behind. The poison header is what makes
// that tree refuse to build.
check('a poison header exists', typeof plugin.POISON_HEADER === 'string' && plugin.POISON_HEADER.length > 0);
check('and it is a Gradle-level throw, so every task fails',
  String(plugin.POISON_HEADER).includes('throw new GradleException('));
check('and it says why, in the file itself',
  /DELIBERATELY UNBUILDABLE/.test(String(plugin.POISON_HEADER)));
check('and it names the command that fixes it',
  /expo prebuild/.test(String(plugin.POISON_HEADER)));
// Applied to a real file, in a temp dir, and idempotent — a second failed
// prebuild must not stack headers.
const pdir = mkdtempSync(join(tmpdir(), 'twitwa-poison-'));
const appdir = join(pdir, 'app');
require('fs').mkdirSync(appdir, { recursive: true });
const pfile = join(appdir, 'build.gradle');
writeFileSync(pfile, pristine);
const ok1 = plugin.poisonOnDisk({ modRequest: { platformProjectRoot: pdir } });
const after1 = readFileSync(pfile, 'utf8');
const ok2 = plugin.poisonOnDisk({ modRequest: { platformProjectRoot: pdir } });
const after2 = readFileSync(pfile, 'utf8');
check('poisoning an existing build.gradle reports success', ok1 === true);
check('the throw lands at the very top of the file',
  after1.startsWith('// ------') && after1.includes('throw new GradleException('));
check('the original template is kept below it, not destroyed',
  after1.includes(S.RELEASE_SIGNING));
check('poisoning twice does not stack headers', after2 === after1 && ok2 === true);
check('poisoning a tree with no build.gradle reports failure rather than throwing',
  plugin.poisonOnDisk({ modRequest: { platformProjectRoot: join(pdir, 'nope') } }) === false);

// The four checks that need a prebuilt android/. Named once, so the skip
// branch and the live branch cannot drift apart.
//
// They did drift. On 2026-09-18 a warm run printed 38 checks and a real clone
// printed 34 with only 3 SKIP lines: the fourth check produced no line at all,
// and one of the three SKIP lines named 'patch(fixture) reproduces the
// generated file byte-for-byte', a check renamed earlier that same day when it
// became a plugin-chain comparison. So the clone's output accounted for a
// check that no longer existed and stayed silent about one that did. Both
// halves of that are the same defect: two hand-maintained copies of one list.
const LIVE_CHECKS = {
  patched: 'the generated file is patched, so the plugin really ran in prebuild',
  chain: 'the build.gradle plugin chain was derived from app.json',
  reproduces: 'every build.gradle plugin, in app.json order, reproduces the generated file',
  noDebug: 'no debug-signed release survives in the generated file',
};

console.log('\nagainst what prebuild actually wrote');
if (!existsSync(LIVE)) {
  // Counted, not hidden. `spike/android/` is gitignored, so absent is the
  // NORMAL state of every clone — and the old suite printed a full green
  // "18/18 checks passed" here while silently dropping its strongest check.
  for (const name of Object.values(LIVE_CHECKS)) skip(name, `${LIVE} absent`);
} else {
  const live = readFileSync(LIVE, 'utf8');
  check(LIVE_CHECKS.patched,
    live.includes(S.VAR));
  // EVERY plugin that edits build.gradle, applied in the order app.json
  // declares them -- not this one alone. The live file is the product of all
  // of them, so comparing one plugin's output against it fails the moment a
  // second plugin is added. That is exactly what happened: withDebugSuffix
  // landed and this check went red at 9774 vs 9969 bytes while nothing was
  // wrong with the signing patch.
  //
  // The list is DERIVED from app.json rather than typed here, so the next
  // plugin does not break it either. This module's own patch comes from the
  // loaded copy -- mutated when BREAK is set -- so the mutants still redden.
  const declared = JSON.parse(readFileSync('app.json', 'utf8')).expo.plugins || [];
  const chain = [];
  for (const entry of declared) {
    const name = typeof entry === 'string' ? entry : entry[0];
    if (typeof name !== 'string' || !name.startsWith('./plugins/')) continue;
    if (name.endsWith('withReleaseSigning')) { chain.push(['withReleaseSigning', patch]); continue; }
    const mod = require('.' + name.slice('./plugins'.length) + '.js');
    // A plugin that edits some other file says so with `target`, and is not
    // part of this chain: withShareInRestore patches MainActivity.kt, and
    // feeding it build.gradle made this check refuse a correct build.
    if (typeof mod.patch === 'function' && (mod.target ?? 'build.gradle') === 'build.gradle') chain.push([name, mod.patch]);
  }
  check(LIVE_CHECKS.chain,
    chain.some(([n]) => n === 'withReleaseSigning'), chain.map(([n]) => n).join(' -> '));
  let composed = pristine;
  let chainError = null;
  try {
    for (const [, fn] of chain) composed = fn(composed);
  } catch (e) { chainError = e; composed = null; }
  check(LIVE_CHECKS.reproduces,
    composed !== null && composed === live,
    chainError ? chainError.message.split('\n')[0] : `${composed.length} vs ${live.length} bytes (chain: ${chain.map(([n]) => n).join(' -> ')})`);
  check(LIVE_CHECKS.noDebug,
    !live.includes(S.RELEASE_SIGNING));
}

console.log('\nrefusing a template it does not recognise');
function throwsWith(fn, re) {
  try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
}
check('a gradle file with no signingConfigs block throws',
  throwsWith(() => patch(pristine.replace(S.SIGNING_CONFIGS, '    signingConfigs { }'))));
check('a gradle file with no release-signing line throws',
  throwsWith(() => patch(pristine.replace(S.RELEASE_SIGNING, '            // moved'))));
check('an empty file throws', throwsWith(() => patch('')));
check('the error names the file to fix', throwsWith(() => patch(''), /build\.gradle/));
check('the error says not to ship', throwsWith(() => patch(''), /do NOT ship/));

// The total never claims a number of checks that did not run. README quotes the
// cold figure, because that is what a clone gets.
const tail = skipped ? `, ${skipped} SKIPPED (run: npx expo prebuild -p android)` : '';
console.log(`\n${ran - fails}/${ran} checks passed${tail}${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
