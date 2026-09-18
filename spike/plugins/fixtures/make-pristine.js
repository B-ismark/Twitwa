// Regenerates plugins/fixtures/build.gradle.pristine.
//
//   cd spike && npx expo prebuild -p android --clean && node plugins/fixtures/make-pristine.js
//
// Run it when the template changes -- an Expo SDK bump, or a change to anything
// prebuild writes into app/build.gradle, which includes `namespace` and
// `applicationId`, so a package rename invalidates this fixture too.
//
// WHY IT INVERTS RATHER THAN COPIES. The fixture has to be the template BEFORE
// the signing plugin touches it, and prebuild never leaves that file on disk:
// it writes the template and then runs the mods over it in the same command.
// So the pristine form is recovered by undoing the plugin's own substitutions,
// and the recovery is PROVEN by patching the result forward and comparing it
// byte-for-byte with what prebuild actually wrote. A hand-copied fixture would
// have no such proof.
//
// An earlier version of the signing suite skipped the fixture entirely and read
// android/app/build.gradle directly. It passed before a prebuild and failed
// after one, because the transformation under test had consumed the anchors the
// suite asserted on.
//
// This script refuses rather than writing a fixture it cannot vouch for. Three
// separate conditions, because each one has a different failure:
//   round-trips  -- the inversion is faithful
//   carries bug  -- the fixture still has the debug-signed release the plugin
//                   exists to fix; without it the suite tests nothing
//   no twitwa ref-- no trace of the patched form leaked into the fixture
const fs = require('fs');
const path = require('path');

const SPIKE = path.resolve(__dirname, '..', '..');
const plugin = require(path.join(SPIKE, 'plugins/withReleaseSigning.js'));
const s = plugin.strings;

const LIVE = path.join(SPIKE, 'android/app/build.gradle');
const OUT = path.join(SPIKE, 'plugins/fixtures/build.gradle.pristine');

if (!fs.existsSync(LIVE)) {
  console.log(`REFUSING: ${LIVE} does not exist. Run: npx expo prebuild -p android --clean`);
  process.exit(1);
}
const live = fs.readFileSync(LIVE, 'utf8');

for (const [name, needle] of [
  ['SIGNING_CONFIGS_PATCHED', s.SIGNING_CONFIGS_PATCHED],
  ['RELEASE_SIGNING_PATCHED', s.RELEASE_SIGNING_PATCHED],
  ['LOADER', s.LOADER],
]) {
  if (!live.includes(needle)) {
    console.log(`REFUSING: the generated build.gradle does not contain ${name}; nothing to invert.`);
    console.log('That means the signing plugin did not run, or ran against a template it no longer fits.');
    process.exit(1);
  }
}

const pristine = live
  .split(s.SIGNING_CONFIGS_PATCHED).join(s.SIGNING_CONFIGS)
  .split(s.RELEASE_SIGNING_PATCHED).join(s.RELEASE_SIGNING)
  .split(s.LOADER).join('\nandroid {');

const round = plugin.patch(pristine);
const bug = /release \{[\s\S]{0,400}?signingConfig signingConfigs\.debug/.test(pristine);
const leaked = pristine.includes('twitwaKeystore');

console.log('bytes        ', pristine.length, '(live:', live.length + ')');
console.log('round-trips  ', round === live);
console.log('carries bug  ', bug, '(the debug-signed release this plugin exists to fix)');
console.log('no twitwa ref', !leaked);

if (round !== live || !bug || leaked) {
  console.log('REFUSING: the recovered fixture is not a faithful pristine template. Nothing written.');
  process.exit(1);
}

fs.writeFileSync(OUT, pristine);
console.log('wrote        ', OUT);
console.log('');
console.log('Now update FIXTURE_SHA256 and PATCHED_SHA256 in plugins/withReleaseSigning.test.mjs:');
const { createHash } = require('crypto');
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
console.log(`  const FIXTURE_SHA256 = '${sha(pristine)}';`);
console.log(`  const PATCHED_SHA256 = '${sha(round)}';`);
