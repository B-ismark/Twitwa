// The effects src/update.js deliberately does not have: the network, the clock,
// a place to remember the last check, and a way to hand a URL to the browser.
//
// Everything here is a thin adapter. The decisions all live in src/update.js,
// which is pure and has a test; this file has no test because there is nothing
// in it to be wrong about except plumbing, and plumbing fails loudly.
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
import { Linking, Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';

import { checkForUpdate, CHECK_TIMEOUT_MS, isAllowedDownloadUrl } from './update';

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
    const v = JSON.parse(f.text()).lastCheckedAt;
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
