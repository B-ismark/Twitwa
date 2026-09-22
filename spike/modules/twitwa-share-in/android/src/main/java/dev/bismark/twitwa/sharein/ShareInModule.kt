// Receiving a share: the one piece of Twitwa that has to be native.
//
// The manifest has registered ACTION_SEND / ACTION_SEND_MULTIPLE for image/*
// since Phase 0, so Twitwa has always appeared in the share sheet. Nothing read
// the intent, so choosing it opened an empty editor. Neither React Native nor
// any Expo module in this project exposes EXTRA_STREAM, which is why this is a
// module and not a line of JS.
//
// WHAT IT DOES, and deliberately no more: it holds the newest unread share,
// copies that one picture into the cache, and hands JS a file:// URI. The
// decision about what to do with the answer lives in src/sharein.js, which is
// pure and has a test; this file cannot be run anywhere but a phone.
//
// WHY COPY rather than hand JS the content:// URI. The read grant that comes
// with a share belongs to the activity that received it and can end when that
// activity does. The card is rendered from the source URI again at export
// time, possibly minutes later, so a URI that works at import can fail at
// Share. A copy in our own cache has no grant to lose.
//
// THREE WAYS A SHARE ARRIVES, and each is handled here because missing any one
// is silent -- Twitwa opens, and the picture simply is not there:
//
//   1. Cold start. The share is the launch intent. JS asks with take() once it
//      has mounted, and absorb() finds it on the activity.
//   2. Twitwa is running. MainActivity is singleTask, so the share arrives
//      through onNewIntent, and JS is told with an onShare event.
//   3. The process is alive but the activity was destroyed (Back from the
//      editor, then share). A NEW activity is created with the share as its
//      launch intent, which is not a new intent, and the module outlives the
//      activity, so nothing in (1) re-runs either. OnActivityEntersForeground
//      catches it.
//
// A share is read ONCE. absorb() marks the Intent object itself, so a dev
// reload, or the next resume of the same activity, does not import the same
// picture again. The mark is an extra on that object, not a flag here,
// because this module is recreated with the JS runtime and the activity is
// not. Android can also REPLAY an old share with a fresh, unmarked copy of the
// intent: from Recents (absorb() refuses FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
// and on a restore after process death (ShareInPackage marks it).
package dev.bismark.twitwa.sharein

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Parcelable
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ShareInModule : Module() {
  private val lock = Any()
  private var pending: Intent? = null

  override fun definition() = ModuleDefinition {
    Name("TwitwaShareIn")

    Events(EVENT)

    OnNewIntent { intent ->
      if (hold(intent)) sendEvent(EVENT, mapOf<String, Any>())
    }

    OnActivityEntersForeground {
      if (absorb(appContext.currentActivity)) sendEvent(EVENT, mapOf<String, Any>())
    }

    // `keep` is the file:// URI the editor is showing, or null. Every other
    // copy in the directory is deleted, so shared pictures do not pile up in
    // the cache, and the one on screen is not pulled out from under an export.
    AsyncFunction("take") { keep: String? ->
      absorb(appContext.currentActivity)
      val intent = synchronized(lock) { pending.also { pending = null } }
        ?: return@AsyncFunction mapOf("status" to "none")
      copy(intent, keep)
    }
  }

  /** Take the activity's launch intent if it is an unread share. */
  private fun absorb(activity: Activity?): Boolean {
    val intent = activity?.intent ?: return false
    // Reopened from Recents. Android relaunches a finished task with its
    // original intent -- on API 31 and later, Back finishes a task whose root
    // was a share rather than the launcher -- so this is an old share
    // delivered a second time, never a new one. ShareInPackage covers the
    // other replay, a restore after the process was killed.
    if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
    return hold(intent)
  }

  /** Remember `intent` as the newest share, once. */
  private fun hold(intent: Intent): Boolean {
    if (!isShare(intent)) return false
    synchronized(lock) {
      if (intent.getBooleanExtra(READ_MARK, false)) return false
      intent.putExtra(READ_MARK, true)
      pending = intent
    }
    return true
  }

  private fun isShare(intent: Intent): Boolean =
    intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE

  /**
   * The shared URIs, in order. EXTRA_STREAM first; ClipData is the fallback.
   *
   * The typed getters from 34, not 33: on 33 they have a platform bug that
   * AndroidX's IntentCompat also works around by using the untyped ones there.
   */
  private fun streams(intent: Intent): List<Uri> {
    val out = mutableListOf<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      val list: List<Parcelable>? = if (Build.VERSION.SDK_INT >= 34) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Parcelable::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableArrayListExtra<Parcelable>(Intent.EXTRA_STREAM)
      }
      list?.forEach { if (it is Uri) out.add(it) }
    } else {
      val one: Parcelable? = if (Build.VERSION.SDK_INT >= 34) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Parcelable::class.java)
      } else {
        @Suppress("DEPRECATION")
        intent.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM)
      }
      if (one is Uri) out.add(one)
    }
    if (out.isEmpty()) {
      val clip = intent.clipData
      if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { out.add(it) }
    }
    return out
  }

  private fun rejected(reason: String, count: Int = 0) =
    mapOf("status" to "rejected", "reason" to reason, "count" to count)

  private fun copy(intent: Intent, keep: String?): Map<String, Any?> {
    val context = appContext.reactContext ?: return rejected("no-context")
    val uris = streams(intent)
    val uri = uris.firstOrNull() ?: return rejected("no-stream")
    // content:// only. A file:// URI from another app could name one of
    // Twitwa's own private files, and Android has refused to send file:// URIs
    // between apps since 7.0, so nothing legitimate is lost.
    if (uri.scheme != "content") return rejected("scheme", uris.size)
    val resolver = context.contentResolver
    val mime = try { resolver.getType(uri) } catch (e: Exception) { null } ?: intent.type ?: ""
    if (!mime.startsWith("image/")) return rejected("not-image", uris.size)

    val dir = File(context.cacheDir, DIR)
    dir.mkdirs()
    val keepPath = keep?.let { Uri.parse(it).path }
    dir.listFiles()?.forEach { if (it.absolutePath != keepPath) it.delete() }

    val out = File(dir, "shared-${System.currentTimeMillis()}.${extension(mime)}")
    return try {
      val input = resolver.openInputStream(uri) ?: return rejected("unreadable", uris.size)
      var total = 0L
      input.use { src ->
        out.outputStream().use { dst ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = src.read(buf)
            if (n < 0) break
            total += n
            if (total > MAX_BYTES) break
            dst.write(buf, 0, n)
          }
        }
      }
      when {
        total > MAX_BYTES -> { out.delete(); rejected("too-big", uris.size) }
        total == 0L -> { out.delete(); rejected("empty", uris.size) }
        else -> mapOf(
          "status" to "ok",
          "uri" to Uri.fromFile(out).toString(),
          "mime" to mime,
          "bytes" to total.toDouble(),
          "count" to uris.size,
        )
      }
    } catch (e: Exception) {
      // SecurityException when the sender's grant does not cover us, and
      // IOException from a provider that goes away mid-read. Both mean the same
      // thing to the person holding the phone.
      out.delete()
      rejected("unreadable", uris.size)
    }
  }

  private fun extension(mime: String): String = when (mime) {
    "image/jpeg", "image/jpg" -> "jpg"
    "image/png" -> "png"
    "image/webp" -> "webp"
    "image/gif" -> "gif"
    "image/heic" -> "heic"
    "image/heif" -> "heif"
    else -> "img"
  }

  companion object {
    private const val EVENT = "onShare"
    private const val DIR = "shared-in"
    internal const val READ_MARK = "dev.bismark.twitwa.sharein.READ"
    // A 1440x3120 PNG screenshot is 2-6 MB. This is ten times the worst of
    // those, and small enough that a mistaken share of a video-sized file
    // cannot fill the cache before it is refused.
    private const val MAX_BYTES = 64L * 1024 * 1024
  }
}
