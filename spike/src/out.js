// What the native out module's answers mean, and when Save has to ask first.
//
// Pure: no react-native, no Expo, so the decisions load in node and have a
// test. The native half is modules/twitwa-out (Kotlin) and cannot run anywhere
// but a phone; src/out-io.js is its optional JS face.
//
// WHY THE PERMISSION LINE IS 29. Saving to Photos needs WRITE_EXTERNAL_STORAGE
// only where the app has to write into the public DCIM folder itself, which is
// Android 9 and older (API 28 and below). From API 29 an app inserts its OWN
// image into MediaStore, with RELATIVE_PATH and IS_PENDING, and needs nothing;
// the Kotlin takes that route from 29 and its manifest declares the permission
// with maxSdkVersion 28. This used to be 30, copied from expo-media-library's
// own factory split, which asked Android 10 phones for a permission the save
// did not use. A prompt for access the app does not need is how a person
// learns to deny the one it does.

import { COPY } from './copy.js';
import { viewUri } from './saved.js';

/** The first API with no permission for a save. Kotlin's LEGACY_BELOW_API. */
export const LEGACY_BELOW_API = 29;

/**
 * Must Save ask for a permission before it starts? An API level that is not a
 * number asks: the native side answers "granted" without prompting wherever
 * nothing is needed, so asking wrongly costs one call and not asking wrongly
 * costs the save.
 */
export function needsSavePermission(api) {
  return !(typeof api === 'number' && Number.isFinite(api) && api >= LEGACY_BELOW_API);
}

/** Did the person grant it? Only a plain `granted: true` counts. */
export function permissionGranted(answer) {
  return answer != null && typeof answer === 'object' && answer.granted === true;
}

const SENTENCE = { share: COPY.shareFailed, save: COPY.saveFailed, copy: COPY.copyFailed };

/**
 * The sentence and the log reason for a Share, Save or Copy that threw.
 * `reason` is the native error's own ERR_OUT_ code, 'module-missing' when this
 * build has no module, and 'unknown' for anything else (a plain Error, a
 * string, undefined), so a log can tell a refusal from a build that never
 * linked the module. Every refusal gets the kind's one sentence on purpose:
 * none of them is something the person can act on differently.
 */
export function failure(kind, error) {
  if (!Object.prototype.hasOwnProperty.call(SENTENCE, kind)) throw new Error(`out: unknown kind: ${String(kind)}`);
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  let reason = 'unknown';
  if (code === 'ERR_OUT_MODULE_MISSING') reason = 'module-missing';
  else if (/^ERR_OUT_[A-Z_]+$/.test(code)) reason = code;
  return { message: SENTENCE[kind], reason };
}

/**
 * What a finished save tells the app: the URI to log (the old `id`) and the
 * one View opens. A save that resolved IS a save, so an answer with no usable
 * URI still reads as saved, just without a button (viewUri refuses anything
 * that is not MediaStore's).
 */
export function savedAnswer(answer) {
  const uri = answer != null && typeof answer === 'object' && typeof answer.uri === 'string' ? answer.uri : null;
  return { uri, view: uri === null ? null : viewUri(uri) };
}
