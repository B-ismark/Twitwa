// Checks release/latest.json against the reader the app actually uses.
//
//   cd spike && node tools/check-release-manifest.mjs
//
// The manifest is the one file in this repository that installed copies of the
// app read over the network. A typo in it is not a build failure; it is a
// silently broken update path, or -- in the case of the url -- a download link
// that points somewhere it should not.
//
// It validates with src/update.js's own parseManifest rather than a second copy
// of the rules. A separate schema here would be a second source of truth for
// exactly the kind of thing that drifts: this gate would pass while the app
// refused the file, and nothing would say so.
//
// WHAT IT DELIBERATELY DOES NOT CHECK: that the manifest's versionCode equals
// spike/app.json's. Those two are SUPPOSED to differ while a new version is
// being built and has not been published yet -- app.json is the build, the
// manifest is what is published. Gating on equality would fire on every
// legitimate release in progress, and a gate that cries wolf gets bypassed.
//
// It also cannot check that the URL resolves. That needs the network and a
// published release; release/README.md says to publish the asset before
// editing this file, and this gate is why that order is worth following rather
// than merely stated.
import { readFileSync } from 'node:fs';
import { parseManifest, DOWNLOAD_PREFIX, isSha256 } from '../src/update.js';

const MANIFEST = '../../release/latest.json';

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

let text;
try {
  text = readFileSync(new URL(MANIFEST, import.meta.url), 'utf8');
} catch (e) {
  console.log(`REFUSING: ${MANIFEST} could not be read: ${e.message}`);
  console.log('This gate has nothing to check, which is not the same as a pass.');
  process.exit(1);
}

// A zero floor, for the same reason the other two rule-checkers have one: a
// gate that runs against nothing and exits 0 is worse than no gate.
if (text.trim().length === 0) {
  console.log('REFUSING: the manifest is empty.');
  process.exit(1);
}

const parsed = parseManifest(text);
check('the app would accept this manifest', parsed.ok === true, parsed.reason);
if (!parsed.ok) {
  console.log(`\n${ran - fails}/${ran} checks passed`);
  process.exit(1);
}
const m = parsed.manifest;

check('the download url is under the allowlisted prefix', m.url.startsWith(DOWNLOAD_PREFIX), m.url);

// The tag and the filename both carry the version, and both are written by
// hand at release time. Three hand-typed copies of one number is how a manifest
// ends up pointing at last month's APK.
const rest = m.url.slice(DOWNLOAD_PREFIX.length);
const [tag, ...file] = rest.split('/');
check('the url has a tag and a filename and nothing else', file.length === 1, rest);
check(`the tag is v${m.versionName}`, tag === `v${m.versionName}`, `${tag} vs v${m.versionName}`);
check(
  `the filename is twitwa-${m.versionName}.apk`,
  file[0] === `twitwa-${m.versionName}.apk`,
  file[0]
);
check('the filename ends .apk', /\.apk$/.test(file[0] ?? ''), file[0]);

// Optional to the schema, required to publish. From 1.0.4 the app downloads
// the APK itself and installs it only if it hashes to this; without one it
// falls back to the browser, whose download stalled on the owner's Pixel.
check('the manifest records the APK\'s sha256', isSha256(m.sha256), m.sha256);

console.log(`\n${ran - fails}/${ran} checks passed`);
process.exit(fails ? 1 : 0);
