// The JS face of the native out module. See
// modules/twitwa-out/android/src/main/java/dev/bismark/twitwa/out/OutModule.kt
// for what it does and why, and src/out.js for what the app does with its
// answers. It lives in src/ rather than beside the Kotlin so that the import,
// dead-export and fs-sync gates, which all read src/, can see it.
//
// Optional rather than required, as src/sharein-io.js is: a dev client built
// before this module existed, or any platform but Android, has no such native
// module, and Share, Save and Copy should then fail with their ordinary
// sentence rather than crash on import. The error carries a code of its own so
// src/out.js can log "this build has no module" apart from "the module refused".
import { requireOptionalNativeModule } from 'expo';

const Native = requireOptionalNativeModule('TwitwaOut');

function native() {
  if (Native) return Native;
  const e = new Error('TwitwaOut is not linked in this build');
  e.code = 'ERR_OUT_MODULE_MISSING';
  throw e;
}

/** Open the system chooser for the card at `path`. Resolves when it is shown. */
export async function shareCard(path, mime) {
  return native().share(path, mime);
}

/** Put the PNG card at `path` on the clipboard as an image. */
export async function copyCardImage(path) {
  return native().copyImage(path);
}

/** Insert the card into Photos. Resolves `{uri}`, a MediaStore content URI. */
export async function saveCard(path, mime, displayName) {
  return native().save(path, mime, displayName);
}

/** Ask for what a save needs on this Android. Resolves `{granted}`. */
export async function requestSavePermission() {
  return native().requestSavePermission();
}
