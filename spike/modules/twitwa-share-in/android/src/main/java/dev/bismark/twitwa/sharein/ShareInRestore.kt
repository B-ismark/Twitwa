// One job: a RESTORED activity's launch intent is never a new share.
//
// ShareInModule marks a share read by putting an extra on the Intent object.
// That object lives in this process. Android's own copy of the intent, the one
// it keeps with the task, never gets the mark, so when Android rebuilds the
// activity from that copy -- the process was killed while Twitwa was in the
// background, and the owner comes back to it -- the activity arrives with an
// unmarked ACTION_SEND and the old picture is imported again.
//
// A restore is exactly the case where `savedInstanceState` is not null. This
// used to be read by a ReactActivityLifecycleListener in a ShareInPackage, and
// that could never work: Expo's template MainActivity calls
// `super.onCreate(null)`, so every listener downstream of it is handed null,
// restore or not. Found on the Pixel on 2026-09-23 -- share, Home, `am kill`,
// back through Recents, and the new process logged `share.in` `open` for the
// same picture. The review that added the listener had never seen it run.
//
// So the only place the real Bundle is visible is MainActivity.onCreate itself,
// BEFORE it passes null up. plugins/withShareInRestore.js writes a call to
// `markIfRestored` there, and the mark's name stays in this module.
//
// A config-change recreation also arrives with a saved state. Its intent is the
// same object and is already marked, so marking it again changes nothing.
package dev.bismark.twitwa.sharein

import android.app.Activity
import android.os.Bundle

object ShareInRestore {
  @JvmStatic
  fun markIfRestored(activity: Activity, savedInstanceState: Bundle?) {
    if (savedInstanceState != null) activity.intent?.putExtra(ShareInModule.READ_MARK, true)
  }
}
