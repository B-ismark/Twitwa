// Encoding the finished card off the JS thread.
//
// WHY THIS EXISTS. Export used to be `snapshot.encodeToBytes(...)` followed by
// `file.write(png)`, both on the JS thread. A PNG deflate of a multi-megapixel
// card (a long capture is up to 14 MP) held that thread for the whole encode,
// and a frozen JS thread is a frozen spinner and a dead touch handler. The
// pixels are already final by then; encoding them needs nothing from React or
// Skia, so it moves here, onto Dispatchers.IO.
//
// WHAT IT DOES, and deliberately no more: take the card's pixels (unpremultiplied
// RGBA_8888, rows packed, rowBytes = width * 4), build an sRGB Bitmap, compress
// it to PNG or JPEG into a temp file beside the target, and rename it into
// place. It decodes nothing, reads no regions, and never touches a colour
// profile. The decision about WHEN to use it lives in src/encoder.js, which is
// pure and has a test; src/pipeline.js falls back to Skia's encoder on any
// rejection from here, so this file is an optimisation that is allowed to fail.
//
// COLOUR. An Android Bitmap made with ARGB_8888 is sRGB and the encoder writes
// no profile for it. Skia's own encode embeds the surface's profile, so a
// Display P3 card MUST NOT come here: the pixels would be kept and the meaning
// silently changed. src/encoder.js pickEncoder keeps every non-sRGB card on
// Skia. The card is also fully opaque (plan.fill is an opaque hex and
// everything is drawn over it), so premultiplied-versus-straight alpha is moot:
// alpha is 255 everywhere and both representations are the same bytes.
//
// WHAT JS HANDS US, AND THE THREAD IT MAY BE READ ON. Read in
// node_modules/expo-modules-core (57.0.18):
//   - A Coroutine AsyncFunction converts its arguments INSIDE scope.launch
//     (functions/SuspendFunctionComponent.kt convertArgs), i.e. on
//     appContext.modulesQueue, not on the JS thread.
//   - A Uint8Array argument arrives as a JavaScriptTypedArray, a jsi::Object
//     wrapper whose class comment says "Should be used only on the runtime
//     thread". Its `length`, `byteLength`, `byteOffset` and `kind` are lazy
//     JSI property reads, and `toDirectBuffer()` reads byteLength through the
//     runtime: ALL of those are unsafe here, and none is touched below.
//   - Its `read(ByteArray, position, size)` is safe: the C++ side caches the
//     raw data pointer when the wrapper is built (JavaScriptTypedArray.cpp,
//     rawPointer) and read() is a memcpy from it with no runtime access. The
//     wrapper holds a shared_ptr to the JS object, so the memory stays alive.
// So the copy is made here with read() alone, in bands, and the byte length is
// validated against a number JS read on its own thread (`declaredBytes`, from
// pixels.byteLength) rather than asked of the typed array. JS must not write
// to or drop the array until the promise settles; src/pipeline.js awaits it.
//
// Bands, with Bitmap.setPixels, rather than one toDirectBuffer() and
// copyPixelsFromBuffer: the latter needs the runtime (above), and a whole-card
// intermediate ByteArray would be a second 56 MB on a Java heap that does not
// have it. Memory order, for whoever changes this: ARGB_8888 is stored in
// memory as R, G, B, A (copyPixelsFromBuffer expects exactly the order Skia's
// RGBA_8888 readPixels writes), but setPixels takes ARGB *ints*, so the
// packing below is explicit and independent of that order.
//
// WHAT CANNOT BE TESTED OFF A PHONE: all of it. This file compiles and runs
// only in the Android build. src/encoder.test.mjs checks that the module name,
// the function name, the result keys and the error codes JS depends on are the
// ones written here, and the dev panel's "Encoder parity" renders a card both
// ways on the device and compares decoded pixels.
package dev.bismark.twitwa.pixels

import android.graphics.Bitmap
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.net.URI

class PixelsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TwitwaPixels")

    AsyncFunction("encode") Coroutine { pixels: Uint8Array, width: Int, height: Int, format: String,
                                         quality: Int, path: String, declaredBytes: Double ->
      encode(pixels, width, height, format, quality, path, declaredBytes)
    }
  }

  private suspend fun encode(
    pixels: Uint8Array,
    width: Int,
    height: Int,
    format: String,
    quality: Int,
    path: String,
    declaredBytes: Double,
  ): Map<String, Any> {
    // Everything is checked before the first byte is read.
    if (width <= 0 || height <= 0) throw fail("bad-size", "size ${width}x$height")
    val expected = width.toLong() * height.toLong() * 4L
    if (expected > Int.MAX_VALUE) throw fail("bad-size", "size ${width}x$height is past 2 GiB")
    if (declaredBytes != expected.toDouble()) {
      throw fail("bad-length", "got ${declaredBytes.toLong()} bytes for ${width}x$height, need $expected")
    }
    val compress = when (format) {
      "png" -> Bitmap.CompressFormat.PNG
      "jpeg" -> Bitmap.CompressFormat.JPEG
      else -> throw fail("bad-format", "format $format")
    }
    if (quality !in 0..100) throw fail("bad-quality", "quality $quality")
    val target = resolve(path)

    return withContext(Dispatchers.IO) {
      val started = System.nanoTime()
      var bitmap: Bitmap? = null
      var temp: File? = null
      try {
        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bitmap = bmp
        fill(bmp, pixels, width, height)
        // Opaque by construction (see COLOUR above), so say so: the PNG is
        // then written as RGB rather than RGBA, a quarter less to deflate and
        // to send, with the same decoded pixels. JPEG ignores it.
        bmp.setHasAlpha(false)
        target.parentFile?.mkdirs()
        // Beside the target, so the rename stays on one filesystem and is
        // atomic: a reader sees the old file or the whole new one.
        val part = File(target.parentFile, ".${target.name}.${System.nanoTime()}.part")
        temp = part
        FileOutputStream(part).use { out ->
          if (!bmp.compress(compress, quality, out)) throw fail("encode-failed", "Bitmap.compress returned false")
          out.fd.sync()
        }
        if (!part.renameTo(target)) throw fail("rename-failed", "could not move the file into place")
        temp = null
        mapOf(
          "bytes" to target.length().toDouble(),
          "ms" to (System.nanoTime() - started) / 1_000_000.0,
        )
      } catch (e: CodedException) {
        throw e
      } catch (e: Throwable) {
        // OutOfMemoryError included: a 14 MP Bitmap can fail to allocate, and
        // JS has a working fallback, so this is a rejection and not a crash.
        throw fail("encode-error", "${e.javaClass.simpleName}: ${e.message}", e)
      } finally {
        temp?.delete()
        bitmap?.recycle()
      }
    }
  }

  /** Copy `pixels` into `bitmap` a band of rows at a time, using read() only. */
  private fun fill(bitmap: Bitmap, pixels: Uint8Array, width: Int, height: Int) {
    val rowBytes = width * 4
    val bandRows = maxOf(1, BAND_BYTES / rowBytes)
    val raw = ByteArray(bandRows * rowBytes)
    val ints = IntArray(bandRows * width)
    var y = 0
    while (y < height) {
      val rows = minOf(bandRows, height - y)
      val size = rows * rowBytes
      pixels.read(raw, y * rowBytes, size)
      var i = 0
      for (p in 0 until rows * width) {
        val r = raw[i].toInt() and 0xFF
        val g = raw[i + 1].toInt() and 0xFF
        val b = raw[i + 2].toInt() and 0xFF
        val a = raw[i + 3].toInt() and 0xFF
        ints[p] = (a shl 24) or (r shl 16) or (g shl 8) or b
        i += 4
      }
      bitmap.setPixels(ints, 0, width, 0, y, width, rows)
      y += rows
    }
  }

  /**
   * `path` as a File, or a refusal. Only the cache directory is writable from
   * here: a file:// URI or an absolute path whose canonical form is inside it,
   * so `..` and a symlink out cannot name anything else.
   */
  private fun resolve(path: String): File {
    val raw = try {
      if (path.startsWith("file:")) File(URI(path).path) else File(path)
    } catch (e: Exception) {
      throw fail("bad-path", "unparseable path")
    }
    if (!raw.isAbsolute) throw fail("bad-path", "path is not absolute")
    val cache = appContext.cacheDirectory.canonicalFile
    val canonical = try {
      raw.canonicalFile
    } catch (e: Exception) {
      throw fail("bad-path", "unresolvable path")
    }
    if (!canonical.path.startsWith(cache.path + File.separator)) {
      throw fail("bad-path", "path is outside the cache directory")
    }
    return canonical
  }

  private fun fail(code: String, message: String, cause: Throwable? = null) =
    CodedException("ERR_PIXELS_${code.uppercase().replace('-', '_')}", message, cause)

  companion object {
    // About 1 MiB of source per band: a ByteArray and an IntArray of that
    // size, instead of the whole card.
    private const val BAND_BYTES = 1024 * 1024
  }
}
