// Knowing that a newer Twitwa exists. Pure: no react-native, no fetch of its
// own, no clock of its own -- everything comes in as an argument, so this loads
// in node and has a test. The I/O lives in App.js.
//
// WHY THIS IS NOT expo-updates. expo-updates ships new JavaScript over the air.
// Twitwa's next several releases change native code (the ABI list below is one
// of them), and OTA cannot deliver native code at all. It also needs a server
// or an EAS account. This app is handed out as an APK file, so the thing that
// has to change is the APK, and the only job here is to notice that a newer one
// was published and say so.
//
// WHY THE APP DOES NOT DOWNLOAD OR INSTALL ANYTHING. It hands the URL to the
// system browser and stops. That is a deliberate limit, and it buys three
// things:
//
//   - No REQUEST_INSTALL_PACKAGES permission. An app that can install packages
//     is a meaningfully more dangerous app to be handed by a friend, and the
//     permission prompt says so in those words.
//   - Android's package manager does the signature check. An APK signed by a
//     different key is refused by the OS, not by code written here. That is the
//     real protection, and it is one we cannot weaken by accident.
//   - No partial downloads, no resume logic, no storage permission, no
//     integrity check of our own to get wrong.
//
// WHAT THIS COSTS IN PRIVACY, stated plainly because it is the first network
// call this app has ever made. Checking means one HTTPS GET to
// raw.githubusercontent.com. It carries no identifier, no query string and no
// app data -- but GitHub sees the requesting IP address and the time, and a
// check happens when the app is used. Anyone who can see that traffic learns
// roughly when this person opens Twitwa. That is why checking is throttled to
// once a day and never happens before the person has opened the app.
//
// NOT YET BUILT: a way to turn it off. It belongs in Settings, which does not
// exist until the app has chrome (Phase 4), and the switch is one boolean that
// decides whether App.js calls `check` at all -- nothing in this module needs to
// know about it. Said here rather than left implied, because "the user can turn
// it off" is the kind of claim a comment makes on a feature's behalf before
// anyone writes it.

/** Where the manifest lives. A raw file on the default branch, so publishing a
 *  release is one commit and needs no server. */
export const MANIFEST_URL =
  'https://raw.githubusercontent.com/B-ismark/Twitwa/main/release/latest.json';

/** The ONLY place a download link may point. This is the security boundary of
 *  the whole feature, so it is a literal prefix rather than a parsed-URL check.
 *
 *  A full absolute URL's authority ends at the first `/` after `//`, and that
 *  slash is inside this string -- so matching this prefix pins the scheme, the
 *  host and the first three path segments in one comparison. There is no
 *  `https://github.com.example.invalid/...` that satisfies it, and no
 *  `https://user@evil.invalid/...` either, because the authority is spelled out
 *  in full.
 *
 *  It matters because the manifest is fetched over the network and then used to
 *  send a person to a download. A manifest that could name any host would be a
 *  way to get someone to install an arbitrary APK under Twitwa's own prompt. */
export const DOWNLOAD_PREFIX =
  'https://github.com/B-ismark/Twitwa/releases/download/';

// Android's own ceiling for versionCode. Not exported: the test records the
// number itself rather than importing it, because an expectation read out of
// the module under test moves when the module is mutated.
const MAX_VERSION_CODE = 2100000000;

/** One day. Short enough to be useful, long enough that the timing signal
 *  described at the top of this file is coarse. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Longest a check may take before it is abandoned. A person who opened the app
 *  to crop a screenshot must never wait on this. */
export const CHECK_TIMEOUT_MS = 8000;

/** Longest `notes` we will read out of the manifest. Untrusted text: whatever
 *  displays it must render it as plain text. */
export const MAX_NOTES = 500;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Integers only, and in Android's range. `1.0` is not a versionCode, and
 *  neither is "1" -- a manifest that has drifted to strings is a manifest to
 *  refuse, not to coerce. */
export function isVersionCode(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_VERSION_CODE;
}

/** A download URL we are willing to send a person to. */
export function isAllowedDownloadUrl(url) {
  if (typeof url !== 'string') return false;
  if (!url.startsWith(DOWNLOAD_PREFIX)) return false;
  const rest = url.slice(DOWNLOAD_PREFIX.length);
  if (rest.length === 0) return false;
  // `..` would still be on github.com, but it would no longer be in this
  // project's releases -- the path could resolve to anything the host serves.
  if (rest.split('/').includes('..')) return false;
  // Nothing legitimate here needs a query string, a fragment, whitespace or a
  // backslash; all four are ways to make a URL read as one thing and resolve as
  // another.
  if (/[?#\s\\]/.test(rest)) return false;
  return true;
}

/**
 * Read a manifest that arrived over the network. Returns
 * `{ ok: true, manifest }` or `{ ok: false, reason }`; it never throws, because
 * the input is whatever the network produced.
 *
 * `reason` is for a log, not for a person. Nothing here is shown in the UI.
 */
export function parseManifest(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not a string' };
  if (text.length > 8192) return { ok: false, reason: 'manifest too large' };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'not JSON' };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: 'not a JSON object' };

  if (!isVersionCode(raw.versionCode)) {
    return { ok: false, reason: `versionCode is not an integer in 1..${MAX_VERSION_CODE}` };
  }
  if (typeof raw.versionName !== 'string' || !/^[0-9A-Za-z.+-]{1,32}$/.test(raw.versionName)) {
    return { ok: false, reason: 'versionName is missing or has characters that are not version characters' };
  }
  if (!isAllowedDownloadUrl(raw.url)) {
    return { ok: false, reason: `url is not under ${DOWNLOAD_PREFIX}` };
  }
  if (raw.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    return { ok: false, reason: 'sha256 is present but is not 64 lowercase hex characters' };
  }
  if (raw.notes !== undefined && (typeof raw.notes !== 'string' || raw.notes.length > MAX_NOTES)) {
    return { ok: false, reason: `notes is not a string of at most ${MAX_NOTES} characters` };
  }

  return {
    ok: true,
    manifest: {
      versionCode: raw.versionCode,
      versionName: raw.versionName,
      url: raw.url,
      sha256: raw.sha256,
      notes: raw.notes,
    },
  };
}

/**
 * What to do, given a valid manifest and what is installed.
 *
 * Only ever forward. An older manifest than the installed build means someone
 * is testing an unreleased APK, or a publish went out wrong; either way Android
 * would refuse the install, and offering it would be a prompt that cannot
 * succeed.
 */
export function decide(manifest, installedVersionCode) {
  if (!isVersionCode(installedVersionCode)) {
    return { action: 'unknown', reason: 'the installed versionCode could not be read' };
  }
  if (manifest.versionCode <= installedVersionCode) {
    return { action: 'current', installedVersionCode, latestVersionCode: manifest.versionCode };
  }
  return {
    action: 'update',
    installedVersionCode,
    latestVersionCode: manifest.versionCode,
    versionName: manifest.versionName,
    url: manifest.url,
    notes: manifest.notes,
  };
}

/**
 * Whether enough time has passed. `lastCheckedAt` is a millisecond timestamp or
 * null/undefined for "never".
 *
 * A clock that has gone backwards -- a person changing the date, or a restore
 * onto a device with a different time -- must not mean "never check again".
 */
export function shouldCheck(lastCheckedAt, now, intervalMs = CHECK_INTERVAL_MS) {
  if (typeof now !== 'number' || !Number.isFinite(now)) return false;
  if (lastCheckedAt === null || lastCheckedAt === undefined) return true;
  if (typeof lastCheckedAt !== 'number' || !Number.isFinite(lastCheckedAt)) return true;
  if (lastCheckedAt > now) return true;
  return now - lastCheckedAt >= intervalMs;
}

/**
 * The whole flow, with every effect injected: `fetchImpl(url, opts)` and the
 * clock. Returns one of:
 *
 *   { action: 'skipped' }   too soon since the last check
 *   { action: 'current' }   a manifest was read and it is not newer
 *   { action: 'update' }    a manifest was read and it IS newer
 *   { action: 'failed' }    no usable manifest; `reason` says why
 *   { action: 'unknown' }   the installed versionCode could not be read
 *
 * `failed` is deliberately quiet. Before the first GitHub Release exists this
 * request is a 404, and a person who has just installed the app should not be
 * shown an error for that.
 */
export async function checkForUpdate({
  fetchImpl,
  installedVersionCode,
  now,
  lastCheckedAt = null,
  intervalMs = CHECK_INTERVAL_MS,
  force = false,
  url = MANIFEST_URL,
}) {
  if (!force && !shouldCheck(lastCheckedAt, now, intervalMs)) {
    return { action: 'skipped', lastCheckedAt };
  }
  let res;
  try {
    res = await fetchImpl(url, { method: 'GET', cache: 'no-store' });
  } catch (e) {
    return { action: 'failed', reason: `request failed: ${e && e.message ? e.message : e}`, checkedAt: now };
  }
  if (!res || res.ok !== true) {
    return { action: 'failed', reason: `HTTP ${res ? res.status : 'no response'}`, checkedAt: now };
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    return { action: 'failed', reason: 'body could not be read', checkedAt: now };
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) return { action: 'failed', reason: parsed.reason, checkedAt: now };
  return { ...decide(parsed.manifest, installedVersionCode), checkedAt: now };
}
