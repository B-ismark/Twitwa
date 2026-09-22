// One job: a RESTORED activity's launch intent is never a new share.
//
// ShareInModule marks a share read by putting an extra on the Intent object.
// That object lives in this process. Android's own copy of the intent, the one
// it keeps with the task, never gets the mark, so when Android rebuilds the
// activity from that copy -- the process was killed while Twitwa was in the
// background, and the owner taps the icon -- the activity arrives with an
// unmarked ACTION_SEND and the old picture would be imported again. Found in
// review on 2026-09-22; not seen on a device.
//
// A restore is exactly the case where `savedInstanceState` is not null, and
// the only place that argument is visible is the activity's onCreate, which a
// Module cannot hook. A Package can, through a lifecycle listener, and Expo
// autolinking finds it by its file name and its import of Package.
//
// A config-change recreation also arrives here with a saved state. Its intent
// is the same object and is already marked, so marking it again changes
// nothing.
package dev.bismark.twitwa.sharein

import android.app.Activity
import android.content.Context
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class ShareInPackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context): List<ReactActivityLifecycleListener> =
    listOf(object : ReactActivityLifecycleListener {
      override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
        if (savedInstanceState != null) activity.intent?.putExtra(ShareInModule.READ_MARK, true)
      }
    })
}
