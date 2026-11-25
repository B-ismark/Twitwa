// Receiving a share: the one piece of Twitwa that has to be native.
//
// The manifest has registered ACTION_SEND / ACTION_SEND_MULTIPLE for image/*
// since Phase 0, so Twitwa has always appeared in the share sheet. Nothing read
// the intent, so choosing it opened an empty editor. Neither React Native nor
// any Expo module in this project exposes EXTRA_STREAM, which is why this is a
// module and not a line of JS.
//
// WHAT IT DOES, and deliberately no more: it holds the newest unread share,
// copies its pictures (up to MAX_ITEMS, each one by the same rules) into the
// cache, and hands JS their file:// URIs, in the order they were shared. The
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
// and on a restore after process death (ShareInRestore marks it).
package dev.bismark.twitwa.sharein

import android.app.Activity
import android.content.ContentResolver
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

    // `keep` is every file:// URI JS still needs: the one the editor is
    // showing and every one still queued behind it, or null. Every other copy
    // in the directory is deleted, so shared pictures do not pile up in the
    // cache, and nothing on screen or waiting is pulled out from under an
    // export or the next card.
    AsyncFunction("take") { keep: List<String>? ->
      absorb(appContext.currentActivity)
      val intent = synchronized(lock) { pending.also { pending = null } }
        ?: return@AsyncFunction mapOf("status" to "none")
      copy(intent, keep ?: emptyList())
    }
  }

  /** Take the activity's launch intent if it is an unread share. */
  private fun absorb(activity: Activity?): Boolean {
    val intent = activity?.intent ?: return false
    // Reopened from Recents. Android relaunches a finished task with its
    // original intent -- on API 31 and later, Back finishes a task whose root
    // was a share rather than the launcher -- so this is an old share
    // delivered a second time, never a new one. ShareInRestore covers the
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

  /**
   * One stream, copied or refused. `file` is null exactly when `reason` is set.
   * A refusal here is never fatal to the share: the caller skips the item and
   * keeps going, and reports the FIRST reason only if nothing at all copied.
   */
  private class Copy(val file: File?, val mime: String, val bytes: Long, val reason: String?)

  private fun failed(reason: String) = Copy(null, "", 0L, reason)

  private fun copy(intent: Intent, keep: List<String>): Map<String, Any?> {
    val context = appContext.reactContext ?: return rejected("no-context")
    val streams = streams(intent)
    if (streams.isEmpty()) return rejected("no-stream")
    val resolver = context.contentResolver

    val dir = File(context.cacheDir, DIR)
    dir.mkdirs()
    val keepPaths = keep.mapNotNull { Uri.parse(it).path }.toSet()
    dir.listFiles()?.forEach { if (it.absolutePath !in keepPaths) it.delete() }

    // One timestamp for the whole share, and the stream's index after it: two
    // copies inside the same millisecond would otherwise take the same name.
    val stamp = System.currentTimeMillis()
    val uris = mutableListOf<String>()
    var firstMime = ""
    var firstBytes = 0L
    var firstFailure: String? = null
    for ((index, uri) in streams.withIndex()) {
      // Past the cap the rest are not even opened. They count as skipped.
      if (uris.size >= MAX_ITEMS) break
      val c = copyOne(resolver, uri, intent.type, dir, stamp, index)
      val file = c.file
      if (file == null) {
        if (firstFailure == null) firstFailure = c.reason
        continue
      }
      if (uris.isEmpty()) {
        firstMime = c.mime
        firstBytes = c.bytes
      }
      uris.add(Uri.fromFile(file).toString())
    }
    if (uris.isEmpty()) return rejected(firstFailure ?: "unreadable", streams.size)
    return mapOf(
      "status" to "ok",
      "uris" to uris,
      "uri" to uris[0],
      "mime" to firstMime,
      "bytes" to firstBytes.toDouble(),
      "count" to streams.size,
      "skipped" to streams.size - uris.size,
    )
  }

  private fun copyOne(
    resolver: ContentResolver,
    uri: Uri,
    fallbackType: String?,
    dir: File,
    stamp: Long,
    index: Int,
  ): Copy {
    // content:// only. A file:// URI from another app could name one of
    // Twitwa's own private files, and Android has refused to send file:// URIs
    // between apps since 7.0, so nothing legitimate is lost.
    if (uri.scheme != "content") return failed("scheme")
    val mime = try { resolver.getType(uri) } catch (e: Exception) { null } ?: fallbackType ?: ""
    if (!mime.startsWith("image/")) return failed("not-image")

    // Never over a file that survived the clean-up: that is a picture still
    // queued in JS, and a share landing in the same millisecond as an earlier
    // one would otherwise write the new picture over it.
    var out = File(dir, "shared-$stamp-$index.${extension(mime)}")
    var n = 0
    while (out.exists()) {
      n += 1
      out = File(dir, "shared-$stamp-$index-$n.${extension(mime)}")
    }
    return try {
      val input = resolver.openInputStream(uri) ?: return failed("unreadable")
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
        total > MAX_BYTES -> { out.delete(); failed("too-big") }
        total == 0L -> { out.delete(); failed("empty") }
        else -> Copy(out, mime, total, null)
      }
    } catch (e: Exception) {
      // SecurityException when the sender's grant does not cover us, and
      // IOException from a provider that goes away mid-read. Both mean the same
      // thing to the person holding the phone.
      out.delete()
      failed("unreadable")
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
    // The most pictures one share copies. The JS queue (src/queue.js) holds
    // the same number; a share past it reports the rest as skipped.
    private const val MAX_ITEMS = 10
  }
}
