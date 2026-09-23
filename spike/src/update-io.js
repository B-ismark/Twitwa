// The effects src/update.js deliberately does not have: the network, the clock,
// a place to remember the last check, a way to hand a URL to the browser, and
// the native updater that downloads and installs an APK itself.
//
// Everything here is a thin adapter. The decisions all live in src/update.js,
// which is pure and has a test.
//
// This file used to say it needed no test "because there is nothing in it to be
// wrong about except plumbing, and plumbing fails loudly". That was wrong twice
// over, and a device run proved it: the plumbing was wrong, and it failed in
// total silence. `readLastChecked` called the async `text()` as if it were
// synchronous, its own try/catch turned the resulting throw into "never
// checked", and the once-a-day throttle simply did not exist. Nothing logged,
// nothing failed, and the only visible symptom was a network request on every
// launch -- which you only notice if you read two launches' logs side by side.
// `tools/check-fs-sync.mjs` now derives the async member names from
// expo-file-system's own native module and fails on this shape.
//
// WHY expo-application RATHER THAN app.json. `Constants.expoConfig.android.
// versionCode` is a copy of app.json baked into the JS bundle. The number
// Android actually compares when deciding whether an APK is an update is the
// one in the installed package, and `Application.nativeBuildVersion` reads
// that. They agree today because prebuild writes one from the other -- but a
// build made from a stale bundle, or a bundle loaded into a different APK by a
// dev client, makes them disagree, and the failure would be an update prompt
// that is wrong in whichever direction nobody expects.
import * as Application from 'expo-application';
import { requireOptionalNativeModule } from 'expo';
import { Linking, Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';

import { checkForUpdate, CHECK_TIMEOUT_MS, isAllowedDownloadUrl, isSha256 } from './update';

// modules/twitwa-updater. Optional for the same reason as src/sharein-io.js: a
// build without it should fall back to the browser, not crash on import.
const Updater = requireOptionalNativeModule('TwitwaUpdater');

/** Whether this build can download and install an update itself. */
export const updaterAvailable = Updater != null;

const STATE_FILE = 'update-check.json';

/** The versionCode of the APK this code is running inside, or null. */
export function installedVersionCode() {
  if (Platform.OS !== 'android') return null;
  const raw = Application.nativeBuildVersion;
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
  return Number.isInteger(n) ? n : null;
}

function stateFile() {
  return new File(Paths.document, STATE_FILE);
}

/** When we last asked, in epoch ms, or null. Any failure reads as "never":
 *  checking one extra time is harmless, and refusing to ever check again
 *  because a file is corrupt is not. Internal: `check` below is the only
 *  caller, and the state file is not something another module should reach. */
function readLastChecked() {
  try {
    const f = stateFile();
    if (!f.exists) return null;
    // textSync, NOT text. `text` is declared with AsyncFunction in
    // expo-file-system's native module, so it returns a promise; JSON.parse of
    // a promise throws, the catch below swallows it, and this function then
    // answers "never checked" on every single launch. The throttle silently
    // stops existing and the app makes its one network call every time it is
    // opened, which is the opposite of what update.js's header promises.
    // Observed on device 2026-09-18: two launches three minutes apart both
    // logged `"action":"current"` where the second had to be `"skipped"`.
    // App.js's takeResumeFlag already carried this warning in a comment; this
    // module was written afterwards and made the same mistake anyway.
    const v = JSON.parse(f.textSync()).lastCheckedAt;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch (e) {
    return null;
  }
}

function writeLastChecked(ms) {
  try {
    stateFile().write(JSON.stringify({ lastCheckedAt: ms }));
  } catch (e) {
    // A check that cannot record itself is a check that happens again
    // tomorrow's worth of launches early. Not worth surfacing.
  }
}

/**
 * Ask whether a newer Twitwa exists. Returns the same shapes src/update.js
 * documents. Never throws.
 *
 * `force` is for a "check now" control: it bypasses the once-a-day throttle but
 * not the timeout.
 */
export async function check({ force = false } = {}) {
  const now = Date.now();
  const result = await checkForUpdate({
    fetchImpl: (url, opts) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
      return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(timer));
    },
    installedVersionCode: installedVersionCode(),
    now,
    lastCheckedAt: readLastChecked(),
    force,
  });
  // Only a check that actually reached the network resets the clock. Recording
  // a skip would make the throttle self-perpetuating.
  if (result.action !== 'skipped') writeLastChecked(now);
  return result;
}

/**
 * Open a download link in the browser, so Android's own installer handles the
 * APK and its signature check.
 *
 * The allowlist is applied AGAIN here, not only at parse time. This is the last
 * point before a URL reaches the system, it costs one comparison, and the two
 * call sites are far enough apart in the code that "the caller already checked"
 * is exactly the assumption that stops being true.
 */
export async function openDownload(url) {
  if (!isAllowedDownloadUrl(url)) return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Download `update`'s APK into the cache and keep it only if its sha256 is the
 * manifest's. `onProgress({bytes, total})` is called as it arrives. Resolves to
 * the native answer, `{status: 'ok'}` or `{status: 'rejected', reason}`; never
 * throws. See modules/twitwa-updater/.../UpdaterModule.kt.
 */
export async function downloadUpdate(update, onProgress) {
  if (!Updater) return { status: 'rejected', reason: 'no-module' };
  if (!isAllowedDownloadUrl(update.url) || !isSha256(update.sha256)) {
    return { status: 'rejected', reason: 'refused' };
  }
  const sub = onProgress ? Updater.addListener('onProgress', onProgress) : null;
  try {
    return await Updater.download(update.url, update.sha256);
  } catch (e) {
    return { status: 'rejected', reason: 'threw' };
  } finally {
    if (sub) sub.remove();
  }
}

/** Check the downloaded APK again and open Android's installer on it. */
export async function installUpdate(update) {
  if (!Updater) return { status: 'rejected', reason: 'no-module' };
  try {
    return await Updater.install(update.sha256);
  } catch (e) {
    return { status: 'rejected', reason: 'threw' };
  }
}

/** Delete any downloaded APK. Called once the app is running a build that no
 *  longer needs it, so a 19 MB file does not sit in the cache for good. */
export async function clearUpdate() {
  if (!Updater) return;
  try {
    await Updater.clear();
  } catch (e) {
    // The cache is the system's to clear as well; a failure here costs space,
    // not correctness.
  }
}
