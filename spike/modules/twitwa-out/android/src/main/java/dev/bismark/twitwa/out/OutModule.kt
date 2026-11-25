// Getting a finished card out of the app: Share, Save to Photos, Copy.
//
// WHY THIS EXISTS. Those three were expo-sharing, expo-media-library and
// expo-clipboard. Each is a general library of which Twitwa used one call
// (shareAsync, Asset.create plus requestPermissionsAsync, setImageAsync), and
// each carried its own dex, resources, FileProvider and manifest permissions
// into a 16 MB APK that is sent to people over a chat app. This file is what
// those three calls did, read from their 57.x Android sources, and no more.
//
// WHAT IT DOES, and no more:
//
//   share(path, mime)          open the system chooser for one card;
//   copyImage(path)            put one PNG card on the clipboard;
//   save(path, mime, name)     insert one card into MediaStore's images, in
//                              DCIM, and answer its content URI;
//   requestSavePermission()    ask for the one permission the save needs on
//                              Android 9 and older, and on nothing newer.
//
// Every one takes a card that src/pipeline.js wrote into cache/cards/ and
// refuses anything whose canonical path is not inside it. The JS side checks
// nothing about the path, and nothing here can be pointed at another file.
//
// WHERE A SAVE LANDS, because people's earlier saves must sit beside new ones.
// expo-media-library's Asset.create(path) with no album inserts into
// MediaStore.Images.Media.EXTERNAL_CONTENT_URI with DISPLAY_NAME = the file's
// name, MIME_TYPE from the extension, RELATIVE_PATH = "DCIM/" (the root of
// DCIM, no subfolder: RelativePath.create(mime) for an image) and IS_PENDING = 1
// while the bytes are copied, then IS_PENDING = 0. On API 30 and up that is
// its "modern" factory; below 30 its "legacy" one copies the file into
// Environment.getExternalStoragePublicDirectory(DIRECTORY_DCIM) under a name
// that does not clash (name_2, name_3 ...) and has MediaScannerConnection
// report the row's URI. This does the same, with one change of threshold:
//
//   API 29 and up  -> the RELATIVE_PATH route. MediaStore.MediaColumns
//                     .RELATIVE_PATH and IS_PENDING were added in 29, and an
//                     app targeting 29+ may insert its own media with no
//                     permission (scoped storage; this app targets 36, so the
//                     requestLegacyExternalStorage opt-out that expo's config
//                     plugin used to add is ignored here anyway). expo drew the
//                     line at 30 and asked for WRITE_EXTERNAL_STORAGE on API 29
//                     for nothing; src/out.js needsSavePermission is 29 too.
//   API 24 to 28   -> write the file into public DCIM, which needs
//                     WRITE_EXTERNAL_STORAGE (declared in this module's
//                     manifest with maxSdkVersion 28), then scan it.
//
// SHARE. expo-sharing builds ACTION_SEND with EXTRA_STREAM = a FileProvider URI,
// the MIME type and FLAG_GRANT_READ_URI_PERMISSION, wraps it in
// Intent.createChooser, grants the permission by hand to every resolved app and
// starts it with startActivityForResult, resolving its promise when the chooser
// RETURNS. This sets the URI as ClipData as well, which is what makes the
// chooser pass the grant on to whatever the person picks (createChooser copies
// the flag and the ClipData onto the chooser), so no per-app grant loop and no
// package-visibility query are needed. It resolves when the chooser is
// STARTED, not when it returns: App.js does nothing that depends on the
// return (it marks the card kept and logs), a promise held until return can
// never settle if the process is killed behind the chooser, and expo's
// "another share is in progress" guard was exactly the failure that left over.
// There is no isAvailable check either: the chooser itself is the answer to
// "is there anything to share to", it exists on every Android, and starting it
// cannot meaningfully fail with ActivityNotFoundException. The one such failure
// that can still happen is mapped to ERR_OUT_NO_APP.
//
// COPY. expo-clipboard's setImageAsync decodes the base64 it is given into a
// Bitmap, re-encodes it under a random name in cache/.clipboard (deleting what
// was there), makes a content URI with its own provider and sets
// ClipData.newUri(resolver, "image", uri). This copies the file's bytes instead
// of decoding and re-encoding them, under a UNIQUE name in cache/clipboard/,
// and deletes every older copy. The unique name matters: Share re-exports to
// the same cards/card.png, and a clip that pointed at THAT file would paste a
// later card than the one that was copied.
//
// WHAT IT COSTS. Three libraries' worth of dex and resources gone. What it
// risks is the thing it replaces: this was written without a phone or a
// compiler, from the sources above.
//
// WHAT CANNOT BE TESTED OFF A PHONE: all of it. This file compiles and runs
// only in the Android build. src/out.test.mjs checks that the names, keys,
// error codes, provider authority and paths JS and the manifest depend on are
// the ones written here, and release/checklist-1.0.7.md lists the device passes.
package dev.bismark.twitwa.out

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.net.URI
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

class OutModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TwitwaOut")

    // Coroutines on Dispatchers.IO, as the updater does: a plain AsyncFunction
    // body runs on the one queue every Expo module shares, and a save copies a
    // multi-megabyte file.
    // The file checks and the content URI on IO; the chooser on Main. An
    // activity is started from the main thread: some OEM builds misbehave, or
    // drop the transition, when startActivity comes from a worker.
    AsyncFunction("share") Coroutine { path: String, mime: String ->
      val chooser = withContext(Dispatchers.IO) { chooserFor(path, mime) }
      withContext(Dispatchers.Main) { launch(chooser) }
      null
    }

    AsyncFunction("copyImage") Coroutine { path: String ->
      withContext(Dispatchers.IO) { copyImage(path) }
      null
    }

    AsyncFunction("save") Coroutine { path: String, mime: String, displayName: String ->
      withContext(Dispatchers.IO) { save(path, mime, displayName) }
    }

    // Promise-style, because the permissions manager answers through a
    // listener on the main thread and nothing here needs to wait on it.
    AsyncFunction("requestSavePermission") { promise: Promise ->
      if (Build.VERSION.SDK_INT >= LEGACY_BELOW_API) {
        // Nothing to ask: see WHERE A SAVE LANDS above.
        promise.resolve(mapOf("granted" to true))
        return@AsyncFunction
      }
      val permissions = appContext.permissions
      if (permissions == null) {
        promise.reject(fail("no-permissions", "the permissions manager is not linked"))
        return@AsyncFunction
      }
      if (permissions.hasGrantedPermissions(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
        promise.resolve(mapOf("granted" to true))
        return@AsyncFunction
      }
      try {
        permissions.askForPermissions(
          PermissionsResponseListener { result ->
            val granted = result[Manifest.permission.WRITE_EXTERNAL_STORAGE]?.status == PermissionsStatus.GRANTED
            promise.resolve(mapOf("granted" to granted))
          },
          Manifest.permission.WRITE_EXTERNAL_STORAGE,
        )
      } catch (e: Exception) {
        promise.reject(fail("permission-request", "${e.javaClass.simpleName}: ${e.message}", e))
      }
    }
  }

  // --- Share ---------------------------------------------------------------

  private fun chooserFor(path: String, mime: String): Intent {
    if (mime !in MIMES) throw fail("bad-mime", "mime $mime")
    val file = resolveIn(path, CARDS)
    val context = context()
    val uri = contentUri(context, file)
    val send = Intent(Intent.ACTION_SEND)
    send.setType(mime)
    send.putExtra(Intent.EXTRA_STREAM, uri)
    send.setClipData(ClipData.newRawUri(null, uri))
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return Intent.createChooser(send, null)
  }

  private fun launch(chooser: Intent) {
    val activity = appContext.currentActivity ?: throw fail("no-activity", "no foreground activity to show the chooser from")
    try {
      activity.startActivity(chooser)
    } catch (e: ActivityNotFoundException) {
      throw fail("no-app", "nothing can handle the chooser", e)
    } catch (e: Exception) {
      throw fail("share-failed", "${e.javaClass.simpleName}: ${e.message}", e)
    }
  }

  // --- Copy ----------------------------------------------------------------

  private fun copyImage(path: String) {
    val src = resolveIn(path, CARDS)
    if (!isPng(src)) throw fail("not-png", "the file is not a PNG")
    val context = context()
    val dir = File(context.cacheDir, CLIPBOARD)
    dir.mkdirs()
    // A name nothing else has: see COPY above.
    val dest = File(dir, "clip-${UUID.randomUUID()}.png")
    val part = File(dir, ".${dest.name}.part")
    try {
      FileInputStream(src).use { input -> part.outputStream().use { out -> input.copyTo(out) } }
      if (!part.renameTo(dest)) throw fail("copy-failed", "could not move the copy into place")
    } catch (e: CodedException) {
      part.delete()
      throw e
    } catch (e: Exception) {
      part.delete()
      throw fail("copy-failed", "${e.javaClass.simpleName}: ${e.message}", e)
    }
    // Every older copy goes, the new one first being safely in place. A clip
    // that still points at a deleted copy pastes nothing, which is what
    // setting the new clip below replaces.
    dir.listFiles()?.forEach { if (it.path != dest.path) it.delete() }
    try {
      val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        ?: throw fail("no-clipboard", "no clipboard service")
      manager.setPrimaryClip(ClipData.newUri(context.contentResolver, "image", contentUri(context, dest)))
    } catch (e: CodedException) {
      throw e
    } catch (e: Exception) {
      throw fail("copy-failed", "${e.javaClass.simpleName}: ${e.message}", e)
    }
  }

  private fun isPng(file: File): Boolean {
    val head = ByteArray(PNG_SIGNATURE.size)
    val read = FileInputStream(file).use { it.read(head) }
    return read == head.size && head.contentEquals(PNG_SIGNATURE)
  }

  // --- Save ----------------------------------------------------------------

  private suspend fun save(path: String, mime: String, displayName: String): Map<String, Any?> {
    if (mime !in MIMES) throw fail("bad-mime", "mime $mime")
    if (!NAME.matches(displayName) || !displayName.lowercase().endsWith(MIMES.getValue(mime))) {
      throw fail("bad-name", "display name does not fit the type")
    }
    val src = resolveIn(path, CARDS)
    val uri = try {
      if (Build.VERSION.SDK_INT >= LEGACY_BELOW_API) saveModern(src, mime, displayName) else saveLegacy(src, mime, displayName)
    } catch (e: CodedException) {
      throw e
    } catch (e: SecurityException) {
      throw fail("permission", "${e.javaClass.simpleName}: ${e.message}", e)
    } catch (e: Exception) {
      throw fail("save-failed", "${e.javaClass.simpleName}: ${e.message}", e)
    }
    return mapOf("uri" to uri.toString())
  }

  // API 29 and up. No permission.
  @RequiresApi(Build.VERSION_CODES.Q)
  private fun saveModern(src: File, mime: String, name: String): Uri {
    return try {
      insertCopyPublish(src, mime, name)
    } catch (e: IllegalStateException) {
      // MediaStore resolves a name clash by itself up to 32 files and then
      // throws this. expo retries once under a name that cannot clash.
      if (e.message?.contains("Failed to build unique file", ignoreCase = true) != true) throw e
      insertCopyPublish(src, mime, uniqueName(name))
    }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun insertCopyPublish(src: File, mime: String, name: String): Uri {
    val resolver = context().contentResolver
    val pending = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, name)
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DCIM}/")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, pending)
      ?: throw fail("save-failed", "MediaStore returned no row")
    try {
      val out = resolver.openOutputStream(uri, "w") ?: throw fail("save-failed", "no stream for the new row")
      FileInputStream(src).use { input -> out.use { input.copyTo(it) } }
      val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
      if (resolver.update(uri, done, null, null) < 1) throw fail("save-failed", "could not publish the row")
      return uri
    } catch (e: Throwable) {
      // No half row: a pending row nobody finishes is invisible and permanent.
      try { resolver.delete(uri, null, null) } catch (ignored: Exception) { }
      throw e
    }
  }

  // API 24 to 28. WRITE_EXTERNAL_STORAGE, or the caller was never asked.
  private suspend fun saveLegacy(src: File, mime: String, name: String): Uri {
    val context = context()
    if (context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
      throw fail("permission", "WRITE_EXTERNAL_STORAGE is not granted")
    }
    @Suppress("DEPRECATION")
    val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM)
    dir.mkdirs()
    val dest = uniqueFileIn(dir, name)
    // Hidden while it is written, so the scanner never sees half a file.
    val part = File(dir, ".${dest.name}.part")
    try {
      FileInputStream(src).use { input -> part.outputStream().use { out -> input.copyTo(out) } }
      if (!part.renameTo(dest)) throw fail("save-failed", "could not move the file into place")
    } catch (e: Throwable) {
      part.delete()
      dest.delete()
      throw e
    }
    val uri = suspendCoroutine<Uri?> { done ->
      MediaScannerConnection.scanFile(context, arrayOf(dest.path), arrayOf(mime)) { _, scanned -> done.resume(scanned) }
    }
    if (uri == null) {
      dest.delete()
      throw fail("save-failed", "the media scanner added no row")
    }
    return uri
  }

  private fun uniqueFileIn(dir: File, name: String): File {
    var file = File(dir, name)
    val stem = name.substringBeforeLast('.')
    val ext = name.substringAfterLast('.', "")
    var n = 2
    while (file.exists()) {
      if (n > MAX_SUFFIX) throw fail("save-failed", "no free file name in DCIM")
      file = File(dir, "${stem}_$n.$ext")
      n++
    }
    return file
  }

  private fun uniqueName(name: String): String {
    val stem = name.substringBeforeLast('.')
    val ext = name.substringAfterLast('.', "")
    return "${stem}_${UUID.randomUUID().toString().take(8)}.$ext"
  }

  // --- Shared --------------------------------------------------------------

  private fun context(): Context = appContext.reactContext ?: throw fail("no-context", "no React context")

  private fun contentUri(context: Context, file: File): Uri =
    try {
      FileProvider.getUriForFile(context, "${context.packageName}.$AUTHORITY_SUFFIX", file)
    } catch (e: IllegalArgumentException) {
      // The file is outside every <paths> entry.
      throw fail("provider", "the file is not one this provider serves", e)
    }

  /**
   * `path` as an existing File inside cache/`sub`, or a refusal. A file URI or
   * an absolute path whose canonical form is inside it, so `..` and a symlink
   * out cannot name anything else.
   */
  private fun resolveIn(path: String, sub: String): File {
    val raw = try {
      if (path.startsWith("file:")) File(URI(path).path) else File(path)
    } catch (e: Exception) {
      throw fail("bad-path", "unparseable path")
    }
    if (!raw.isAbsolute) throw fail("bad-path", "path is not absolute")
    val root = try {
      File(context().cacheDir, sub).canonicalFile
    } catch (e: CodedException) {
      throw e
    } catch (e: Exception) {
      throw fail("bad-path", "unresolvable directory")
    }
    val canonical = try {
      raw.canonicalFile
    } catch (e: Exception) {
      throw fail("bad-path", "unresolvable path")
    }
    if (!canonical.path.startsWith(root.path + File.separator)) throw fail("bad-path", "path is outside cache/$sub")
    if (!canonical.isFile) throw fail("missing", "no such file")
    return canonical
  }

  private fun fail(code: String, message: String, cause: Throwable? = null) =
    CodedException("ERR_OUT_${code.uppercase().replace('-', '_')}", message, cause)

  companion object {
    // Must match android:authorities in this module's AndroidManifest.xml.
    private const val AUTHORITY_SUFFIX = "TwitwaOutProvider"
    // Must match the two <cache-path> entries in res/xml/twitwa_out_paths.xml,
    // and CARDS the directory src/pipeline.js writes cards into.
    private const val CARDS = "cards"
    private const val CLIPBOARD = "clipboard"
    // The first API at which an app may insert its own image into MediaStore
    // with no permission. Must match LEGACY_BELOW_API in src/out.js, and the
    // manifest's maxSdkVersion is this minus one.
    private const val LEGACY_BELOW_API = 29
    // The types src/format.js can produce, each with the extension it must
    // wear: MediaStore takes the gallery's type from the name.
    private val MIMES = mapOf("image/png" to ".png", "image/jpeg" to ".jpg")
    // What src/plan.js savedName makes, with room: letters, digits, dot, dash,
    // underscore, and never a slash.
    private val NAME = Regex("^[A-Za-z0-9._-]{1,100}$")
    private val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    private const val MAX_SUFFIX = 9999
  }
}
