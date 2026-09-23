// Getting the next Twitwa onto the phone without the browser.
//
// WHY THIS EXISTS. Until 1.0.3 the update banner handed the APK's URL to the
// browser and stopped, deliberately (src/update.js explains the trade). On the
// owner's Pixel on 2026-09-23, Chrome -- its custom tab and the full browser
// alike -- fetched every byte of twitwa-1.0.3.apk, the bytes matched the
// release's sha256, and the download then sat at 100% as a `.pending-` file
// for minutes and never became a file anyone could open. A friend handed the
// app would be stuck exactly there, with no way to tell why.
//
// WHAT IT DOES, and no more:
//
//   download(url, sha256)  fetch the APK into cache/update/, hashing it as it
//                          is written, and keep it only if the hash is the
//                          one the manifest names;
//   install(sha256)        hash that file AGAIN and, only if it still matches,
//                          hand it to Android's own installer;
//   clear()                delete whatever is in cache/update/.
//
// WHAT STILL PROTECTS THE PERSON. Android's package manager checks that the
// APK is signed by the same key as the installed Twitwa and refuses it if not;
// nothing here can weaken that. The sha256 check is ours, and it is a second,
// weaker line: the manifest and the APK both come from this project's GitHub,
// so it catches a corrupt or truncated download, not a compromised account.
//
// WHAT IT COSTS. REQUEST_INSTALL_PACKAGES, declared in this module's manifest.
// The first time, Android asks the person to allow "Install unknown apps" for
// Twitwa instead of for Chrome. The owner chose that on 2026-09-23 over a
// system-download path that needs no permission and cannot check the file.
//
// The decisions about what to show live in src/update.js, which is pure and
// has a test. This file cannot run anywhere but a phone.
package dev.bismark.twitwa.updater

import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.core.content.FileProvider
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

class UpdaterModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TwitwaUpdater")

    Events(PROGRESS)

    // Coroutines on Dispatchers.IO, NOT plain AsyncFunction bodies. A plain
    // body runs on expo-modules-core's single "expo.modules.AsyncFunctionQueue"
    // thread (AppContext.kt), which EVERY Expo module's async calls share: a
    // blocking 19 MB download there held up Save, Share, Copy and the picker
    // until it finished. Found in review of the first version.
    AsyncFunction("download") Coroutine { url: String, sha256: String ->
      withContext(Dispatchers.IO) { download(url, sha256) }
    }

    AsyncFunction("install") Coroutine { sha256: String ->
      withContext(Dispatchers.IO) { install(sha256) }
    }

    AsyncFunction("clear") Coroutine { ->
      withContext(Dispatchers.IO) { dir()?.listFiles()?.forEach { it.delete() } }
      null
    }
  }

  private fun rejected(reason: String) = mapOf("status" to "rejected", "reason" to reason)

  private fun dir(): File? {
    val context = appContext.reactContext ?: return null
    return File(context.cacheDir, DIR)
  }

  private fun download(url: String, sha256: String): Map<String, Any?> {
    // The same two checks src/update.js makes, made again at the last point
    // before the network: the JS side is far enough away that "the caller
    // already checked" is the assumption that stops being true.
    if (!url.startsWith(DOWNLOAD_PREFIX) || url.length == DOWNLOAD_PREFIX.length) return rejected("url")
    if (!SHA256.matches(sha256)) return rejected("sha256")
    val dir = dir() ?: return rejected("no-context")
    dir.mkdirs()
    dir.listFiles()?.forEach { it.delete() }
    val part = File(dir, "$APK.part")
    val apk = File(dir, APK)

    var conn: HttpURLConnection? = null
    return try {
      conn = (URL(url).openConnection() as HttpURLConnection).apply {
        // GitHub answers a release asset with a redirect to its asset host.
        // HttpURLConnection follows https to https and refuses to fall back to
        // http, which is the only redirect this should ever take.
        instanceFollowRedirects = true
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
      }
      val code = conn.responseCode
      if (code != 200) return rejected("http-$code")
      if (conn.url.protocol != "https") return rejected("not-https")
      val total = conn.contentLengthLong
      if (total > MAX_BYTES) return rejected("too-big")

      val digest = MessageDigest.getInstance("SHA-256")
      var bytes = 0L
      var reported = 0L
      // readTimeout bounds one silent read, not the whole file: a link that
      // trickles a byte every 29 s would never end. This does.
      val deadline = System.nanoTime() + DEADLINE_MS * 1_000_000
      var late = false
      conn.inputStream.use { src ->
        part.outputStream().use { dst ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = src.read(buf)
            if (n < 0) break
            bytes += n
            if (bytes > MAX_BYTES) break
            if (System.nanoTime() > deadline) { late = true; break }
            digest.update(buf, 0, n)
            dst.write(buf, 0, n)
            if (bytes - reported >= PROGRESS_STEP) {
              reported = bytes
              sendEvent(PROGRESS, mapOf("bytes" to bytes.toDouble(), "total" to total.toDouble()))
            }
          }
        }
      }
      when {
        bytes > MAX_BYTES -> { part.delete(); rejected("too-big") }
        late -> { part.delete(); rejected("slow") }
        total >= 0 && bytes != total -> { part.delete(); rejected("short") }
        hex(digest.digest()) != sha256 -> { part.delete(); rejected("digest") }
        !part.renameTo(apk) -> { part.delete(); rejected("rename") }
        else -> mapOf("status" to "ok", "bytes" to bytes.toDouble())
      }
    } catch (e: Exception) {
      // No network, a timeout, a connection dropped mid-file. All the same to
      // the person holding the phone: try again later.
      part.delete()
      rejected("network")
    } finally {
      conn?.disconnect()
    }
  }

  private fun install(sha256: String): Map<String, Any?> {
    if (!SHA256.matches(sha256)) return rejected("sha256")
    val context = appContext.reactContext ?: return rejected("no-context")
    val apk = File(dir() ?: return rejected("no-context"), APK)
    if (!apk.isFile) return rejected("missing")
    // Again, because the file has sat in the cache since download() and the
    // cost is a fraction of a second. What is handed to the installer is what
    // was checked, not what was checked a while ago.
    val sum = try { hashFile(apk) } catch (e: Exception) { return rejected("unreadable") }
    if (sum != sha256) {
      apk.delete()
      return rejected("digest")
    }
    // "ok" means the installer opened, not that anything was installed: that
    // happens in Android's own screen, and the new Twitwa replaces this one.
    return try {
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.$AUTHORITY_SUFFIX", apk)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, APK_MIME)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      (appContext.currentActivity ?: context).startActivity(intent)
      mapOf("status" to "ok")
    } catch (e: ActivityNotFoundException) {
      rejected("no-installer")
    } catch (e: IllegalArgumentException) {
      // getUriForFile: the path is outside every <paths> entry.
      rejected("provider")
    } catch (e: SecurityException) {
      rejected("refused")
    }
  }

  private fun hashFile(f: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(f).use { src ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = src.read(buf)
        if (n < 0) break
        digest.update(buf, 0, n)
      }
    }
    return hex(digest.digest())
  }

  private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

  companion object {
    private const val PROGRESS = "onProgress"
    private const val DIR = "update"
    private const val APK = "twitwa-update.apk"
    private const val APK_MIME = "application/vnd.android.package-archive"
    // Must match android:authorities in this module's AndroidManifest.xml.
    private const val AUTHORITY_SUFFIX = "TwitwaUpdateProvider"
    // Must match DOWNLOAD_PREFIX in src/update.js; src/update.test.mjs reads
    // both and fails if they differ.
    private const val DOWNLOAD_PREFIX = "https://github.com/B-ismark/Twitwa/releases/download/"
    private val SHA256 = Regex("^[0-9a-f]{64}$")
    // 1.0.3 is 19 MB. Five times that is room for growth and small enough that
    // a wrong URL cannot fill the phone.
    private const val MAX_BYTES = 100L * 1024 * 1024
    private const val PROGRESS_STEP = 256L * 1024
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 30_000
    // Ten minutes for 19 MB is 32 KB/s. Slower than that, "try again later"
    // is the honest answer.
    private const val DEADLINE_MS = 10L * 60 * 1000
  }
}
