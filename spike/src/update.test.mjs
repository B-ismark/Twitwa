// Tests for src/update.js.
//
//   for b in $(node src/update.test.mjs --list-mutants); do
//     BREAK=$b node src/update.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// These mutants are textual edits to the REAL source of src/update.js, loaded
// from a temp copy -- not replacement functions written in this file, which is
// how the older suites in src/ do it. The newer form is stronger: a replacement
// function proves the assertions redden against a DIFFERENT function, and in
// one case in this repo a stub happened to omit a whole code path, so five
// checks fired on it trivially and one of three mutations added no coverage at
// all. An edit to the real source cannot do that.
//
// WHAT IS AT STAKE HERE, because it is not the usual "wrong pixel" risk. This
// module reads a file off the network and, on the strength of it, sends a person
// to install an APK. `isAllowedDownloadUrl` is the only thing standing between a
// manifest and an arbitrary download, so it gets tested as a security boundary:
// not "does the happy path pass" but "which of these twelve hostile strings get
// through". Android's package manager refuses an APK signed by another key, and
// that is the real protection -- but it is the second line, not the first.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC_PATH = 'src/update.js';

const MUTANTS = {
  // The host allowlist stops working: the manifest can send a person anywhere.
  // This is the one that matters.
  prefix_check_dead: ['if (!url.startsWith(DOWNLOAD_PREFIX)) return false;', 'if (!url.startsWith(DOWNLOAD_PREFIX) && false) return false;'],
  // `..` segments get through, so the path can climb out of this project's
  // releases and resolve to anything the host serves.
  dotdot_allowed: ["if (rest.split('/').includes('..')) return false;", "if (rest.split('/').includes('..') && false) return false;"],
  // The URL may be the bare prefix -- a directory, not an APK.
  empty_rest_allowed: ['if (rest.length === 0) return false;', 'if (rest.length === 0 && false) return false;'],
  // Anything at all may appear in the version name, which is then displayed.
  versionname_any_chars: ['/^[0-9A-Za-z.+-]{1,32}$/.test(raw.versionName)', '/^[\\s\\S]*$/.test(raw.versionName)'],
  // notes is no longer bounded, so a manifest can push an arbitrary wall of
  // text into the app's own dialog.
  notes_unbounded: ['raw.notes.length > MAX_NOTES', 'raw.notes.length > MAX_NOTES * 1000'],
  // 1.5 becomes an acceptable versionCode. Android has no such thing, and the
  // comparison against the installed code then means nothing.
  float_versioncode: ["typeof v === 'number' && Number.isInteger(v) && v >= 1", "typeof v === 'number' && v >= 1"],
  // The same version is offered as an update: a prompt that appears every day
  // and cannot ever be satisfied.
  downgrade_offered: ['if (manifest.versionCode <= installedVersionCode) {', 'if (manifest.versionCode < installedVersionCode) {'],
  // The throttle goes away, so the app talks to GitHub on every launch. No
  // visible symptom at all -- it just turns a daily timing signal into a
  // per-launch one.
  interval_off_by_one: ['return now - lastCheckedAt >= intervalMs;', 'return now - lastCheckedAt > 0;'],
  // A clock that has gone backwards means never check again.
  clock_back_never_checks: ['if (lastCheckedAt > now) return true;', 'if (lastCheckedAt > now) return false;'],
  // The HTTP status is ignored, so a 404 page gets parsed as a manifest.
  http_status_ignored: ['if (!res || res.ok !== true) {', 'if (!res) {'],
  // The banner is handed no sha256, so every update falls back to the browser
  // that stalled on the Pixel -- silently, since the browser still opens.
  sha_not_passed: ['    sha256: manifest.sha256,\n', ''],
  // Any string passes as a sha256, so the updater is asked to check a file
  // against something that is not a hash.
  sha_any_string: ["return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);", "return typeof v === 'string';"],
  // The in-app route is taken without a hash to check against.
  route_ignores_sha: ["if (updaterAvailable === true && isSha256(update.sha256)) return 'app';", "if (updaterAvailable === true) return 'app';"],
  // The in-app route is taken on a build whose updater did not link.
  route_ignores_module: ["if (updaterAvailable === true && isSha256(update.sha256)) return 'app';", "if (isSha256(update.sha256)) return 'app';"],
  // A URL outside the allowlist falls through to the browser instead of nowhere.
  route_url_unchecked: ["if (!update || !isAllowedDownloadUrl(update.url)) return 'none';", "if (!update) return 'none';"],
  // Rounded instead of floored: 100% shows while bytes are still arriving.
  percent_rounds: ['Math.floor((bytes / total) * 100)', 'Math.round((bytes / total) * 100)'],
  // An unknown size (-1 from HttpURLConnection) reads as a negative percent.
  percent_unknown_total: ['total <= 0 || bytes < 0', 'bytes < 0'],
  // A download that did not match reads as "try again later", which will
  // fail the same way every time.
  mismatch_generic: ["if (reason === 'digest') return COPY.updateMismatch;", ''],
  // A phone with no installer is told to try again later, forever.
  no_installer_generic: ["if (reason === 'no-installer') return COPY.updateNoInstaller;", ''],
};

if (process.argv.includes('--list-mutants')) {
  console.log(Object.keys(MUTANTS).sort().join('\n'));
  process.exit(0);
}

const BREAK = process.env.BREAK || '';
// Line endings normalised, as in the plugin suites: a CRLF checkout would
// otherwise make every mutant that spans a line break NO LONGER APPLY.
const realSource = readFileSync(SRC_PATH, 'utf8').replace(/\r\n/g, '\n');
let mod;

if (BREAK && MUTANTS[BREAK]) {
  const [find, replace] = MUTANTS[BREAK];
  if (!realSource.includes(find)) {
    console.log(`MUTATION ${BREAK} NO LONGER APPLIES: ${JSON.stringify(find.slice(0, 60))} is not in ${SRC_PATH}.`);
    console.log('A mutation that cannot be applied tests nothing. Update it or delete it.');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'twitwa-update-mutant-'));
  const f = join(dir, 'update.js');
  // The copy lives in a temp directory, so its one relative import is pointed
  // back at the real src/copy.js. Without that, every mutant dies of
  // ERR_MODULE_NOT_FOUND and reads as red while testing nothing.
  const copyUrl = pathToFileURL(join(process.cwd(), 'src', 'copy.js')).href;
  writeFileSync(f, realSource.split(find).join(replace).replace("from './copy.js'", `from '${copyUrl}'`));
  mod = await import(pathToFileURL(f).href);
} else if (BREAK) {
  console.log(`unknown BREAK=${BREAK}. Known: ${Object.keys(MUTANTS).join(', ')}`);
  process.exit(1);
} else {
  mod = await import('./update.js');
}

const {
  parseManifest, decide, shouldCheck, checkForUpdate, isAllowedDownloadUrl,
  isVersionCode, MANIFEST_URL, DOWNLOAD_PREFIX, CHECK_INTERVAL_MS, MAX_NOTES,
  isSha256, installRoute, downloadPercent, updateProblem,
} = mod;

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// Recorded here, not read from the module, so a mutation of the module cannot
// move the expectation with it.
const GOOD_URL = 'https://github.com/B-ismark/Twitwa/releases/download/v1.1.0/twitwa-1.1.0-arm64-v8a.apk';
const DAY = 24 * 60 * 60 * 1000;

function manifestText(over = {}) {
  return JSON.stringify({
    versionCode: 2, versionName: '1.1.0', url: GOOD_URL, ...over,
  });
}

console.log('the download allowlist: what gets through');
{
  check('the real release URL is accepted', isAllowedDownloadUrl(GOOD_URL) === true);
  check(
    'a nested path under the prefix is accepted',
    isAllowedDownloadUrl(DOWNLOAD_PREFIX + 'v2.0.0/twitwa.apk') === true
  );
}

console.log('the download allowlist: what does not');
{
  // Each of these is a real technique, not a synthetic string. The point of
  // listing them individually is that a single "rejects a bad URL" check would
  // pass while nine of the ten still got through.
  const hostile = [
    ['a different host entirely', 'https://evil.invalid/twitwa.apk'],
    ['a lookalike host that has the real one as a prefix', 'https://github.com.evil.invalid/B-ismark/Twitwa/releases/download/v1/x.apk'],
    ['userinfo pointing the authority elsewhere', 'https://github.com/B-ismark/Twitwa/releases/download/@evil.invalid/x.apk'.replace('/B-', '@evil.invalid/B-')],
    ['plain http', 'http://github.com/B-ismark/Twitwa/releases/download/v1/x.apk'],
    ['a different repository on the same host', 'https://github.com/someone-else/Twitwa/releases/download/v1/x.apk'],
    ['a different path on the same host', 'https://github.com/B-ismark/Twitwa/raw/main/x.apk'],
    ['path traversal out of the releases area', DOWNLOAD_PREFIX + '../../../someone-else/evil/x.apk'],
    ['the bare prefix with no file', DOWNLOAD_PREFIX],
    ['a query string', DOWNLOAD_PREFIX + 'v1/x.apk?redirect=https://evil.invalid'],
    ['a fragment', DOWNLOAD_PREFIX + 'v1/x.apk#https://evil.invalid'],
    ['a backslash where a slash is expected', DOWNLOAD_PREFIX + 'v1\\x.apk'],
    ['a newline', DOWNLOAD_PREFIX + 'v1/x.apk\nhttps://evil.invalid'],
    ['not a string at all', { toString: () => GOOD_URL }],
    ['null', null],
  ];
  for (const [why, url] of hostile) {
    check(`rejected: ${why}`, isAllowedDownloadUrl(url) === false, String(url).slice(0, 70));
  }
  check(
    'and the prefix pins the scheme and host in one string, so there is one boundary rather than three',
    DOWNLOAD_PREFIX.startsWith('https://') && DOWNLOAD_PREFIX.split('/')[2] === 'github.com',
    DOWNLOAD_PREFIX
  );
}

console.log('a versionCode is an integer in Android\'s range');
{
  check('1 is one', isVersionCode(1) === true);
  check('2100000000 is the ceiling and is allowed', isVersionCode(2100000000) === true);
  check('2100000001 is over it', isVersionCode(2100000001) === false);
  check('0 is not one', isVersionCode(0) === false);
  check('-1 is not one', isVersionCode(-1) === false);
  check('1.5 is not one', isVersionCode(1.5) === false);
  check('"2" is not one -- a drifted manifest is refused, not coerced', isVersionCode('2') === false);
  check('NaN is not one', isVersionCode(NaN) === false);
  check('null is not one', isVersionCode(null) === false);
}

console.log('parsing a manifest off the network');
{
  const ok = parseManifest(manifestText());
  check('a well-formed manifest parses', ok.ok === true, ok.reason);
  check('versionCode survives as a number', ok.ok && ok.manifest.versionCode === 2);
  check('the url survives unchanged', ok.ok && ok.manifest.url === GOOD_URL);

  const bad = [
    ['not JSON', 'this is not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
    ['no versionCode', JSON.stringify({ versionName: '1.1.0', url: GOOD_URL })],
    ['a float versionCode', manifestText({ versionCode: 1.5 })],
    ['a string versionCode', manifestText({ versionCode: '2' })],
    ['no versionName', JSON.stringify({ versionCode: 2, url: GOOD_URL })],
    ['a versionName with a newline', manifestText({ versionName: '1.1\n0' })],
    ['a versionName that is 33 characters', manifestText({ versionName: 'x'.repeat(33) })],
    ['a url on another host', manifestText({ url: 'https://evil.invalid/x.apk' })],
    ['no url', JSON.stringify({ versionCode: 2, versionName: '1.1.0' })],
    ['a short sha256', manifestText({ sha256: 'abc' })],
    ['an uppercase sha256', manifestText({ sha256: 'A'.repeat(64) })],
    ['notes over the limit', manifestText({ notes: 'x'.repeat(MAX_NOTES + 1) })],
    ['notes that are not a string', manifestText({ notes: 42 })],
    ['a manifest larger than 8 KiB', JSON.stringify({ versionCode: 2, versionName: '1.0', url: GOOD_URL, notes: 'x'.repeat(9000) })],
    ['a number instead of text', 42],
    ['undefined', undefined],
  ];
  for (const [why, text] of bad) {
    const r = parseManifest(text);
    check(`refused: ${why}`, r.ok === false, JSON.stringify(r));
  }
  check('a refusal says why, for the log', parseManifest('nope').reason.length > 3);
  check(
    'notes exactly at the limit is accepted, so the bound is not off by one',
    parseManifest(manifestText({ notes: 'x'.repeat(MAX_NOTES) })).ok === true
  );
  check('an absent sha256 is fine', parseManifest(manifestText()).ok === true);
  check('a valid sha256 is fine', parseManifest(manifestText({ sha256: 'a'.repeat(64) })).ok === true);
  check(
    'unknown fields are dropped rather than carried through',
    !Object.prototype.hasOwnProperty.call(parseManifest(manifestText({ evil: 1 })).manifest, 'evil')
  );
}

console.log('deciding, which only ever goes forward');
{
  const m = { versionCode: 2, versionName: '1.1.0', url: GOOD_URL };
  check('a newer manifest is an update', decide(m, 1).action === 'update');
  check('the same version is current', decide(m, 2).action === 'current', JSON.stringify(decide(m, 2)));
  check('an older manifest is current, not a downgrade prompt', decide(m, 3).action === 'current', JSON.stringify(decide(m, 3)));
  check('an unreadable installed version is unknown, not an update', decide(m, undefined).action === 'unknown');
  check('a string installed version is unknown', decide(m, '1').action === 'unknown');
  const u = decide(m, 1);
  check('an update carries the url', u.url === GOOD_URL);
  check('an update carries both version codes, so a log can say what it compared', u.installedVersionCode === 1 && u.latestVersionCode === 2);
}

console.log('the throttle, which is a privacy control and not a performance one');
{
  const now = 1_700_000_000_000;
  check('never checked before -> check', shouldCheck(null, now) === true);
  check('undefined -> check', shouldCheck(undefined, now) === true);
  check('checked a second ago -> do not', shouldCheck(now - 1000, now) === false);
  check('checked 23 hours ago -> do not', shouldCheck(now - 23 * 60 * 60 * 1000, now) === false);
  check('checked exactly a day ago -> check', shouldCheck(now - DAY, now) === true);
  check('checked over a day ago -> check', shouldCheck(now - DAY - 1, now) === true);
  check('the interval is one day', CHECK_INTERVAL_MS === DAY, CHECK_INTERVAL_MS);
  check(
    'a clock that went backwards checks rather than never checking again',
    shouldCheck(now + 10 * DAY, now) === true
  );
  check('a nonsense stored value checks', shouldCheck('yesterday', now) === true);
  check('a NaN stored value checks', shouldCheck(NaN, now) === true);
  check('a nonsense clock does not check', shouldCheck(null, NaN) === false);
}

console.log('the whole flow, with the network injected');
{
  const now = 1_700_000_000_000;
  function fakeFetch(body, init = {}) {
    const calls = [];
    const f = async (url, opts) => {
      calls.push({ url, opts });
      if (init.throws) throw new Error('offline');
      return { ok: init.ok !== false, status: init.status ?? 200, text: async () => body };
    };
    f.calls = calls;
    return f;
  }

  const f1 = fakeFetch(manifestText());
  const r1 = await checkForUpdate({ fetchImpl: f1, installedVersionCode: 1, now });
  check('a newer manifest over a working network is an update', r1.action === 'update', JSON.stringify(r1));
  check('it went to the manifest URL and nowhere else', f1.calls.length === 1 && f1.calls[0].url === MANIFEST_URL, JSON.stringify(f1.calls.map((c) => c.url)));
  check('the manifest URL is https', MANIFEST_URL.startsWith('https://'), MANIFEST_URL);
  check(
    'the request carries no query string, so nothing about this install is sent',
    !MANIFEST_URL.includes('?'),
    MANIFEST_URL
  );

  const f2 = fakeFetch(manifestText());
  const r2 = await checkForUpdate({ fetchImpl: f2, installedVersionCode: 1, now, lastCheckedAt: now - 1000 });
  check('too soon: skipped', r2.action === 'skipped', JSON.stringify(r2));
  check('too soon: and nothing was sent at all', f2.calls.length === 0, f2.calls.length);

  const f3 = fakeFetch(manifestText());
  const r3 = await checkForUpdate({ fetchImpl: f3, installedVersionCode: 1, now, lastCheckedAt: now - 1000, force: true });
  check('force overrides the throttle', r3.action === 'update', JSON.stringify(r3));

  const r4 = await checkForUpdate({ fetchImpl: fakeFetch('', { throws: true }), installedVersionCode: 1, now });
  check('offline is a quiet failure, not a throw', r4.action === 'failed', JSON.stringify(r4));

  const r5 = await checkForUpdate({ fetchImpl: fakeFetch('<html>404</html>', { ok: false, status: 404 }), installedVersionCode: 1, now });
  check('a 404 before the first release exists is a quiet failure', r5.action === 'failed', JSON.stringify(r5));
  check('and the reason names the status', /404/.test(r5.reason), r5.reason);

  const r6 = await checkForUpdate({ fetchImpl: fakeFetch('{"versionCode":2,"versionName":"1.1.0","url":"https://evil.invalid/x.apk"}'), installedVersionCode: 1, now });
  check('a manifest naming another host is refused, not followed', r6.action === 'failed', JSON.stringify(r6));

  const r7 = await checkForUpdate({ fetchImpl: fakeFetch(manifestText()), installedVersionCode: 2, now });
  check('already on the latest: current', r7.action === 'current', JSON.stringify(r7));

  const r8 = await checkForUpdate({ fetchImpl: fakeFetch(manifestText()), installedVersionCode: 1, now });
  check('a result records when it happened, so the throttle can be stored', r8.checkedAt === now, r8.checkedAt);
}

// --- getting the update onto the phone -------------------------------------
{
  const SHA = 'b17266dd291e9ff18bdde9f33577358a882ae91a3dc7631d3c97c1f79a4682fd';
  const m = parseManifest(manifestText({ sha256: SHA })).manifest;
  const u = decide(m, 1);
  check('decide hands the banner the sha256', u.sha256 === SHA, u.sha256);
  check('decide with no sha256 in the manifest hands none', decide(parseManifest(manifestText()).manifest, 1).sha256 === undefined);

  check('a 64-char lowercase hex string is a sha256', isSha256(SHA));
  check('uppercase is not', !isSha256(SHA.toUpperCase()));
  check('63 characters is not', !isSha256(SHA.slice(1)));
  check('a non-string is not', !isSha256(12345) && !isSha256(undefined));

  check('updater present, sha256 present: app', installRoute(u, true) === 'app', installRoute(u, true));
  check('no updater module: browser', installRoute(u, false) === 'browser', installRoute(u, false));
  check('updater present but no sha256: browser', installRoute({ ...u, sha256: undefined }, true) === 'browser');
  check('a truthy non-true updater flag is not the updater', installRoute(u, 'yes') === 'browser');
  check('a URL off the allowlist: none, not browser', installRoute({ ...u, url: 'https://evil.invalid/x.apk' }, true) === 'none');
  check('no update at all: none', installRoute(null, true) === 'none');

  check('0 of 100 is 0%', downloadPercent(0, 100) === 0);
  check('half is 50%', downloadPercent(50, 100) === 50);
  check('99.6% is 99, not 100', downloadPercent(996, 1000) === 99, downloadPercent(996, 1000));
  check('every byte is 100%', downloadPercent(19220639, 19220639) === 100);
  check('more bytes than the size says is still 100%', downloadPercent(120, 100) === 100);
  check('an unknown size (-1) is null, not a negative percent', downloadPercent(10, -1) === null, downloadPercent(10, -1));
  check('a zero size is null', downloadPercent(10, 0) === null);
  check('NaN bytes is null', downloadPercent(Number.NaN, 100) === null);

  // The sentences themselves are recorded here, so a mutation that swaps which
  // key a reason maps to is seen.
  check('digest: the file did not match', updateProblem('digest') === 'The download did not match the release, so it was not installed.', updateProblem('digest'));
  check('no-installer: this phone cannot', updateProblem('no-installer') === 'This phone could not open the installer.', updateProblem('no-installer'));
  for (const r of ['network', 'http-404', 'short', 'too-big', 'rename', 'missing', undefined]) {
    check(`${String(r)}: try again later`, updateProblem(r) === 'The update did not download. Try again later.', updateProblem(r));
  }
}

// --- the Kotlin side agrees with this one ----------------------------------
// Read as text, because Kotlin does not run here. Each of these is a place the
// two languages must say the same thing, and a disagreement is found otherwise
// only on a phone, as a banner that does nothing.
{
  const here = new URL('.', import.meta.url);
  const kt = readFileSync(new URL('../modules/twitwa-updater/android/src/main/java/dev/bismark/twitwa/updater/UpdaterModule.kt', here), 'utf8');
  const io = readFileSync(new URL('./update-io.js', here), 'utf8');
  const manifest = readFileSync(new URL('../modules/twitwa-updater/android/src/main/AndroidManifest.xml', here), 'utf8');
  const paths = readFileSync(new URL('../modules/twitwa-updater/android/src/main/res/xml/twitwa_update_paths.xml', here), 'utf8');
  const ktPrefix = (kt.match(/DOWNLOAD_PREFIX = "([^"]+)"/) || [])[1];
  check('the Kotlin download prefix is the JS one', ktPrefix === DOWNLOAD_PREFIX, ktPrefix);
  check('the Kotlin module is named TwitwaUpdater', /Name\("TwitwaUpdater"\)/.test(kt));
  check('...and that is the name the JS asks for', /requireOptionalNativeModule\('TwitwaUpdater'\)/.test(io));
  check('the progress event is the one the JS listens to', /PROGRESS = "onProgress"/.test(kt) && /addListener\('onProgress'/.test(io));
  const suffix = (kt.match(/AUTHORITY_SUFFIX = "([^"]+)"/) || [])[1];
  check('the provider authority in Kotlin is the manifest one', suffix !== undefined && manifest.includes(`android:authorities="\${applicationId}.${suffix}"`), suffix);
  const ktDir = (kt.match(/DIR = "([^"]+)"/) || [])[1];
  check('the provider shares exactly the directory Kotlin downloads into', ktDir !== undefined && paths.includes(`path="${ktDir}/"`) && (paths.match(/-path /g) || []).length === 1, ktDir);
  check('the manifest asks for REQUEST_INSTALL_PACKAGES', manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES'));
  check('the provider is not exported', /android:exported="false"/.test(manifest));
  // A plain AsyncFunction body runs on the one queue every Expo module shares;
  // a download there stalled Save and Share for its whole length.
  for (const fn of ['download', 'install']) {
    const re = new RegExp(`AsyncFunction\\("${fn}"\\) Coroutine \\{[^}]*withContext\\(Dispatchers\\.IO\\)`);
    check(`Kotlin ${fn} runs on Dispatchers.IO, off the shared async queue`, re.test(kt));
  }
  check('Kotlin checks the hash again before installing', /private fun install[\s\S]*?hashFile\(apk\) != sha256/.test(kt));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
