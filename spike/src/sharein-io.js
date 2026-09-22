// The JS face of the native share-in module. See
// modules/twitwa-share-in/android/src/main/java/dev/bismark/twitwa/sharein/ShareInModule.kt
// for what it does and why, and src/sharein.js for what the app does with the
// answer. It lives in src/ rather than beside the Kotlin so that the import,
// dead-export and fs-sync gates, which all read src/, can see it.
//
// Optional rather than required: a dev client built before this module
// existed, or any platform but Android, has no such native module, and that
// should mean "no share to read" rather than a crash on import. The cost is
// that a build which silently failed to link the module also reads as "no
// share"; src/sharein.js reports that case under its own reason so a log can
// tell the two apart.
import { requireOptionalNativeModule } from 'expo';

const Native = requireOptionalNativeModule('TwitwaShareIn');

export const shareInAvailable = Native != null;

/** The newest unread share, copied into the cache. See src/sharein.js. */
export async function takeShare(keepUri) {
  if (!Native) return null;
  return Native.take(keepUri ?? null);
}

/** Call `listener` whenever a share arrives. Returns an unsubscribe function. */
export function onShare(listener) {
  if (!Native) return () => {};
  const sub = Native.addListener('onShare', listener);
  return () => sub.remove();
}
