// The JS face of the native pixels module. See
// modules/twitwa-pixels/android/src/main/java/dev/bismark/twitwa/pixels/PixelsModule.kt
// for what it does and why, and src/encoder.js for when the app uses it. It
// lives in src/ rather than beside the Kotlin so that the import, dead-export
// and fs-sync gates, which all read src/, can see it.
//
// Optional rather than required, as src/sharein-io.js is: a dev client built
// before this module existed, or any platform but Android, has no such native
// module, and that should mean "encode with Skia" rather than a crash on
// import. src/pipeline.js records WHY it fell back (`encoderFallback`), so a
// build that failed to link the module is distinguishable from one that
// refused a card.
import { requireOptionalNativeModule } from 'expo';

const Native = requireOptionalNativeModule('TwitwaPixels');

export const nativeEncodeAvailable = Native != null;

/**
 * Encode `pixels` (unpremultiplied RGBA_8888, rows packed) to `path` natively.
 * Resolves `{bytes, ms}` (the file's real size, and encode plus write time) or
 * rejects with a coded error. `byteLength` is read HERE, on the JS thread, and
 * handed over as a number because the native side may not ask the typed array
 * for it from its own thread.
 */
export async function nativeEncode({ pixels, width, height, format, quality, path }) {
  if (!Native) throw new Error('TwitwaPixels is not linked in this build');
  return Native.encode(pixels, width, height, format, quality, path, pixels.byteLength);
}
