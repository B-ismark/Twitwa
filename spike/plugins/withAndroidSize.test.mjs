// Tests for plugins/withAndroidSize.js.
//
//   for b in $(node plugins/withAndroidSize.test.mjs --list-mutants); do
//     BREAK=$b node plugins/withAndroidSize.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. Same harness as withReleaseSigning.test.mjs and for
// the same reason: each mutant is a textual edit to the REAL plugin source
// loaded from a temp copy, never a stub written here, because a stub proves
// the assertions redden against a different function.
//
// WHY THIS SUITE EXISTS AT ALL. Every defect this plugin can have is a silent
// one. It writes build configuration; a wrong value does not fail the build, it
// produces a working APK of the wrong size, and nobody looks at an APK's size
// until they try to send it to someone. There is no runtime symptom to notice.
// So the checks here are about the two failure shapes that produce a green
// build: a key written twice (Gradle takes the last, which may not be ours) and
// a key written but not taking effect.
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

const PLUGIN_SRC_PATH = 'plugins/withAndroidSize.js';
const LIVE_PROPERTIES = 'android/gradle.properties';

// --- the mutants -----------------------------------------------------------
const MUTANTS = {
  // The two emulator ABIs come back: 61,374,008 bytes of uncompressed native
  // code that no phone can run. This is the whole point of the plugin.
  x86_restored: ["value: 'arm64-v8a',", "value: 'arm64-v8a,x86,x86_64',"],
  // The 32-bit ABI comes back: 9,255,669 bytes the owner chose to drop.
  v7a_restored: ["value: 'arm64-v8a',", "value: 'arm64-v8a,armeabi-v7a',"],
  // R8 stays off, and the build succeeds as though nothing were asked of it.
  r8_off: ["key: 'android.enableMinifyInReleaseBuilds',\n    value: 'true'", "key: 'android.enableMinifyInReleaseBuilds',\n    value: 'false'"],
  // The name every guide gives, which this template never reads.
  r8_wrong_name: ["key: 'android.enableMinifyInReleaseBuilds',", "key: 'android.enableProguardInReleaseBuilds',"],
  // .so go back to Stored, which is where 110 MB of the original APK came from.
  packaging_not_legacy: ["key: 'expo.useLegacyPackaging',\n    value: 'true'", "key: 'expo.useLegacyPackaging',\n    value: 'false'"],
  gif_left_on: ["key: 'expo.gif.enabled',\n    value: 'false'", "key: 'expo.gif.enabled',\n    value: 'true'"],
  // A second entry for the same key instead of a replacement. Gradle reads the
  // last one, so this happens to work -- until the order changes.
  duplicate_instead_of_replace: ['else out[at] = { ...out[at], value };', 'else out.push({ type: \'property\', key, value });'],
  // A key absent from the template is never added.
  append_missing_dead: ['if (at === -1) out.push', 'if (at === -2) out.push'],
  // The plugin stops checking that what it wrote is what it meant.
  readback_dead: ['if (wrong.length) {', 'if (wrong.length && false) {'],
  // Edits the caller's array in place. Config plugins are composed, so a mod
  // that mutates its input corrupts whatever ran before it.
  mutates_input: ['const out = items.slice();', 'const out = items;'],
};

if (process.argv.includes('--list-mutants')) {
  console.log(Object.keys(MUTANTS).sort().join('\n'));
  process.exit(0);
}

const BREAK = process.env.BREAK || '';
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
  const dir = mkdtempSync(join(tmpdir(), 'twitwa-size-mutant-'));
  const f = join(dir, 'withAndroidSize.js');
  writeFileSync(f, realSource.split(find).join(replace));
  plugin = require(f);
} else if (BREAK) {
  console.log(`unknown BREAK=${BREAK}. Known: ${Object.keys(MUTANTS).join(', ')}`);
  process.exit(1);
} else {
  plugin = require('./withAndroidSize.js');
}

const { apply, PROPERTIES } = plugin;

// The values this plugin is supposed to produce, written down HERE rather than
// read from PROPERTIES. Reading them from the module is the mistake that let
// three mutants through on the first run of this suite: `gif_left_on` edits
// PROPERTIES, so a check of the form `vals(out, key) === PROPERTIES[key]` has
// its expected value edited by the same mutation and passes. An expectation
// that a mutation can move is not an expectation.
//
// Changing the plugin deliberately means changing this table in the same
// commit, after reading the diff.
const EXPECTED = {
  reactNativeArchitectures: 'arm64-v8a',
  'expo.useLegacyPackaging': 'true',
  'expo.gif.enabled': 'false',
  'android.enableMinifyInReleaseBuilds': 'true',
};
const EXPECTED_KEYS = Object.keys(EXPECTED);

let fails = 0;
let ran = 0;
let skipped = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}
function skip(name, why) { skipped++; console.log(`  SKIP  ${name}  -> ${why}`); }

/** Values read back from a result list, by key. */
function vals(items, key) {
  return items.filter((i) => i.type === 'property' && i.key === key).map((i) => i.value);
}
function prop(key, value) { return { type: 'property', key, value }; }

// The template as Expo SDK 57 generates it, recorded from android/gradle.properties
// on 2026-09-18. Kept here as a literal so the suite runs in a clone, where
// android/ does not exist; the check further down compares it against the real
// file whenever there IS one, so the two cannot drift silently.
// A FUNCTION, not an array. As an array it was shared across blocks, and the
// `mutates_input` mutant edited it during an earlier block -- to the correct
// values -- so by the time the "input is not modified" check ran there was
// nothing left to modify and the mutant survived at exit 0.
function template() { return TEMPLATE_ITEMS.map((i) => ({ ...i })); }
const TEMPLATE_ITEMS = [
  { type: 'comment', value: ' generated' },
  prop('org.gradle.jvmargs', '-Xmx2048m -XX:MaxMetaspaceSize=512m'),
  prop('org.gradle.parallel', 'true'),
  prop('android.useAndroidX', 'true'),
  prop('android.enablePngCrunchInReleaseBuilds', 'true'),
  prop('reactNativeArchitectures', 'armeabi-v7a,arm64-v8a,x86,x86_64'),
  prop('newArchEnabled', 'true'),
  prop('hermesEnabled', 'true'),
  prop('edgeToEdgeEnabled', 'true'),
  prop('expo.gif.enabled', 'true'),
  prop('expo.webp.enabled', 'true'),
  prop('expo.webp.animated', 'false'),
  prop('EX_DEV_CLIENT_NETWORK_INSPECTOR', 'true'),
  prop('expo.useLegacyPackaging', 'false'),
  prop('expo.inlineModules.watchedDirectories', '[]'),
  { type: 'empty' },
];

console.log('the four properties land with the intended values');
{
  const out = apply(template());
  for (const key of EXPECTED_KEYS) {
    check(`${key} == ${EXPECTED[key]}`, vals(out, key).join('|') === EXPECTED[key], vals(out, key).join('|'));
  }
  check(
    'the plugin sets exactly these four keys and no others',
    JSON.stringify(PROPERTIES.map((p) => p.key).sort()) === JSON.stringify(EXPECTED_KEYS.slice().sort()),
    PROPERTIES.map((p) => p.key).join(',')
  );
}

console.log('the ABI list, stated as facts about ABIs rather than as one string');
{
  const abis = vals(apply(template()), 'reactNativeArchitectures')[0].split(',');
  check('arm64-v8a is present', abis.includes('arm64-v8a'), abis.join(','));
  check('armeabi-v7a is gone, as the owner decided on 2026-09-22', !abis.includes('armeabi-v7a'), abis.join(','));
  check('x86 is gone', !abis.includes('x86'), abis.join(','));
  check('x86_64 is gone', !abis.includes('x86_64'), abis.join(','));
  check('exactly one ABI ships', abis.length === 1, abis.join(','));
}

console.log('replacement, not accumulation');
{
  const out = apply(template());
  for (const key of EXPECTED_KEYS) {
    check(`${key} appears exactly once`, vals(out, key).length === 1, vals(out, key).length);
  }
  // Three keys are already in the template and get replaced; the R8 key is not
  // (the template reads it with a `?: false` default) and gets appended. The
  // count is derived, so a key that moves into or out of the template shows up
  // here as a changed number rather than as a silent duplicate.
  const absent = EXPECTED_KEYS.filter((key) => vals(template(), key).length === 0);
  check('exactly one key is absent from the template, and it is R8', absent.join() === 'android.enableMinifyInReleaseBuilds', absent.join());
  check(
    'the list grows by exactly the keys the template lacked',
    out.length === template().length + absent.length,
    `${template().length} -> ${out.length}, ${absent.length} absent`
  );
}

console.log('everything the plugin does not name is left exactly as it was');
{
  const out = apply(template());
  const ours = new Set(EXPECTED_KEYS);
  const before = template().filter((i) => i.type !== 'property' || !ours.has(i.key));
  const after = out.filter((i) => i.type !== 'property' || !ours.has(i.key));
  check('same untouched entries, same order', JSON.stringify(before) === JSON.stringify(after));
  check('hermesEnabled survives', vals(out, 'hermesEnabled')[0] === 'true');
  check('newArchEnabled survives', vals(out, 'newArchEnabled')[0] === 'true');
  check('comments and blank lines survive', out.some((i) => i.type === 'comment') && out.some((i) => i.type === 'empty'));
}

console.log('the input list is not modified');
{
  const input = template();
  const snapshot = JSON.stringify(input);
  apply(input);
  check('apply() does not edit its argument', JSON.stringify(input) === snapshot);
}

console.log('idempotent, because prebuild runs the mods again on every run');
{
  const once = apply(template());
  const twice = apply(once);
  check('apply(apply(x)) == apply(x)', JSON.stringify(twice) === JSON.stringify(once));
  for (const key of EXPECTED_KEYS) {
    check(`${key} still appears exactly once after two passes`, vals(twice, key).length === 1, vals(twice, key).length);
  }
}

console.log('a key that is absent gets appended rather than dropped');
{
  const out = apply([prop('org.gradle.parallel', 'true')]);
  for (const key of EXPECTED_KEYS) {
    check(`${key} was appended`, vals(out, key).join('|') === EXPECTED[key], vals(out, key).join('|'));
  }
  check('the pre-existing entry is still there', vals(out, 'org.gradle.parallel')[0] === 'true');
  const empty = apply([]);
  check('an empty list yields exactly the properties the plugin sets', empty.length === EXPECTED_KEYS.length, empty.length);
}

console.log('it refuses rather than writing a file it cannot vouch for');
{
  // A hand-edited gradle.properties with the key already listed twice: the
  // replacement fixes the first and leaves the second, so Gradle would read a
  // value this plugin did not choose.
  const doubled = [...template(), prop('expo.gif.enabled', 'true')];
  let threw = null;
  try { apply(doubled); } catch (e) { threw = e; }
  check('a duplicated key throws', threw !== null);
  check('the message names the key', threw !== null && threw.message.includes('expo.gif.enabled'), threw && threw.message);
  check(
    'the message says what the consequence is, not just that something failed',
    threw !== null && /size/i.test(threw.message),
    threw && threw.message
  );
}

console.log('R8 is on, under the name this template reads');
{
  const out = apply(template());
  check(
    'android.enableMinifyInReleaseBuilds is true',
    vals(out, 'android.enableMinifyInReleaseBuilds').join('|') === 'true',
    vals(out, 'android.enableMinifyInReleaseBuilds').join('|')
  );
  check(
    'and the name every guide gives is not what got set',
    // android/app/build.gradle:69 reads android.enableMinifyInReleaseBuilds.
    // android.enableProguardInReleaseBuilds is from the bare React Native
    // template and is not read here, so setting it would look like R8 was on
    // while R8 stayed off.
    vals(out, 'android.enableProguardInReleaseBuilds').length === 0,
    vals(out, 'android.enableProguardInReleaseBuilds').join('|')
  );
}

console.log('every property carries a reason a later reader can check');
{
  for (const p of PROPERTIES) {
    check(`${p.key} explains itself`, typeof p.why === 'string' && p.why.length > 40, p.why && p.why.length);
  }
  check(
    'the reason for dropping x86 cites the measured byte count',
    PROPERTIES.find((p) => p.key === 'reactNativeArchitectures').why.includes('61,374,008')
  );
}

// --- against the real generated tree, when there is one ---------------------
console.log('the recorded template matches the one Expo actually generates');
if (!existsSync(LIVE_PROPERTIES)) {
  skip('TEMPLATE still matches android/gradle.properties', `${LIVE_PROPERTIES} needs a prebuild`);
  skip('the live file has the keys this plugin edits', `${LIVE_PROPERTIES} needs a prebuild`);
} else {
  const { parsePropertiesFile } = require('@expo/config-plugins/build/android/Properties');
  const live = parsePropertiesFile(readFileSync(LIVE_PROPERTIES, 'utf8'));
  const liveKeys = live.filter((i) => i.type === 'property').map((i) => i.key).sort();
  // The live file is what prebuild left AFTER this plugin ran, so it is
  // compared with the template as this plugin leaves it, not the bare one.
  // Comparing with the bare one went red the first time the plugin appended a
  // key the template lacks (android.enableMinifyInReleaseBuilds, 2026-09-22).
  const mineKeys = apply(template()).filter((i) => i.type === 'property').map((i) => i.key).sort();
  check(
    'TEMPLATE still matches android/gradle.properties',
    JSON.stringify(liveKeys) === JSON.stringify(mineKeys),
    `live-only: ${liveKeys.filter((k) => !mineKeys.includes(k))}; fixture-only: ${mineKeys.filter((k) => !liveKeys.includes(k))}`
  );
  const applied = apply(live);
  check(
    'the live file has the keys this plugin edits',
    EXPECTED_KEYS.every((key) => vals(applied, key).join('|') === EXPECTED[key]),
    EXPECTED_KEYS.map((key) => `${key}=${vals(applied, key).join('|')}`).join(' ')
  );
}

const tail = skipped ? `, ${skipped} SKIPPED (run: npx expo prebuild -p android)` : '';
console.log(`\n${ran - fails}/${ran} checks passed${tail}${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
