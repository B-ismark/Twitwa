// When the photo picker's launcher dies, and what to do about it. Pure: no
// react-native, no expo-file-system, no Skia, so it loads in node and has a
// test. The I/O around it lives in App.js.
//
// THE DEFECT THIS EXISTS FOR, measured rather than assumed (2026-09-18):
//
// `MainActivity`'s `configChanges` declares
// `keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize|assetsPaths`.
// It does NOT declare `fontScale` or `density`, so a change to either recreates
// the activity while the JS runtime survives. The surviving runtime holds an
// `ActivityResultLauncher` that the new Activity never registered, and
// `launchImageLibraryAsync` then rejects with:
//
//   java.lang.IllegalStateException: Attempting to launch an unregistered
//   ActivityResultLauncher with contract
//   expo.modules.imagepicker.contracts.ImageLibraryContract@...
//
// expo-modules-core is *supposed* to handle this. `AppContext.onHostResume`
// re-registers every module's contracts when `hostWasDestroyed`, with a comment
// saying it exists for reusing an AppContext with a new Activity. On this build
// it never fires. Both legs were measured:
//
//   - background the app and foreground it again: still broken.
//   - recreate the activity a SECOND time (restoring font_scale): still broken.
//
// So `onHostDestroy` is not being delivered on a config-change recreation, and
// nothing re-registers for the life of the runtime. That is why the repair here
// is a new JS runtime and not a retry: retrying is what the old code did by
// asking the owner to restart the app by hand.
//
// NOT ESTABLISHED, and it matters: this was only ever seen under the dev client,
// whose `DevLauncherActivity` already demonstrably interferes with the activity
// lifecycle in this project (it swallows `ACTION_SEND` — see PHASE0.md). A
// release build may not have the defect at all. Until someone measures that,
// this is a repair for a fault whose blast radius is unknown, which is an
// argument for keeping it cheap and loud, not for skipping it.

/** The AndroidX message, whatever wrapper text Expo puts around it. */
export function isStaleLauncherError(message) {
  const s = String(message == null ? '' : message);
  // Matched on both halves rather than the whole sentence: Expo's wrapper
  // interpolates the contract and the options object, and the contract name
  // differs between the library picker and the camera. Matching the formatted
  // sentence would make this true for one caller and false for the other.
  return s.includes('unregistered ActivityResultLauncher');
}

// The two configuration values `configChanges` does not absorb. Watched from JS
// because they are the only visible evidence the activity was recreated — the
// runtime itself is not restarted and has no other signal.
//
// `useWindowDimensions()` is the source. Width and height are deliberately NOT
// compared: rotation changes both and is absorbed by `configChanges`, so
// treating a width change as a recreation would report a stale launcher on the
// one configuration change that cannot cause it.
export function launcherWentStale(prev, next) {
  if (!prev || !next) return false;
  return prev.fontScale !== next.fontScale || prev.scale !== next.scale;
}

export const RESUME_MAX_AGE_MS = 30000;

/**
 * Should a fresh runtime pick up the pick that the previous one could not make?
 *
 * @param flag  what was read back from disk, or null if there was nothing
 * @param nowMs Date.now()
 * @returns {{resume: boolean, reason: string}}
 *
 * The age bound is the point of this function. A flag file is written and then
 * the runtime is torn down, so there is no reliable moment to clean it up: a
 * crash between the write and the reload leaves it behind, and without an age
 * bound the app would open the photo picker by itself on some unrelated launch
 * days later. `resume` says yes only for a flag written seconds ago.
 */
export function resumeDecision(flag, nowMs, maxAgeMs = RESUME_MAX_AGE_MS) {
  if (!flag) return { resume: false, reason: 'no flag' };
  if (typeof flag.at !== 'number' || !Number.isFinite(flag.at)) {
    return { resume: false, reason: 'flag has no usable timestamp' };
  }
  const age = nowMs - flag.at;
  // A flag from the future is a clock change, not a recent pick. Treated as
  // stale rather than as age<=0, which would pass the bound below.
  if (age < 0) return { resume: false, reason: 'flag is dated in the future' };
  if (age > maxAgeMs) return { resume: false, reason: `flag is ${age}ms old` };
  return { resume: true, reason: `flag is ${age}ms old` };
}

/**
 * What can this runtime actually do about a dead launcher?
 *
 * Split out from the effect so the policy is one testable decision instead of a
 * condition buried in a handler. `reload` is the only repair known to work; the
 * other two answers exist so the app says something true instead of nothing.
 */
/**
 * Can this runtime actually replace itself?
 *
 * Not the same question as "does DevSettings.reload exist". React Native
 * declares `reload(reason) {}` -- an empty function -- and only replaces it
 * with a working one inside `if (__DEV__)`
 * (react-native/Libraries/Utilities/DevSettings.js:37 and :45). So in a release
 * build the method is present, `typeof` says 'function', calling it is legal,
 * and it does nothing whatsoever.
 *
 * App.js used to test only for the method, which meant the release APK chose
 * the `reload` plan, announced it, wrote the resume flag, called reload() and
 * stayed exactly where it was. Measured on the release APK on 2026-09-18: pid
 * 29696 before the call and pid 29696 after it. The picker stayed dead and the
 * one branch written to say so -- `report` -- could never be reached in the
 * only build that needed it.
 *
 * Pure so it can be tested, because the thing it guards cannot be: App.js
 * imports Skia and does not load in node.
 */
export function canReloadRuntime(devSettings, isDev) {
  if (!isDev) return false;
  return Boolean(devSettings) && typeof devSettings.reload === 'function';
}

export function recoveryPlan({ canReload, alreadyTried }) {
  if (alreadyTried) {
    return {
      action: 'give-up',
      // Bounded on purpose. If a reload does not fix it, reloading again will
      // not either, and a self-reloading app that never comes back is worse
      // than a dead button.
      message: 'the picker was already recovered once in this runtime and is still failing',
    };
  }
  if (!canReload) {
    return {
      action: 'report',
      message:
        'the picker launcher did not survive an activity recreation, and this build cannot reload ' +
        'itself: DevSettings.reload is the empty release stub, not the real one. Close Twitwa and ' +
        'open it again. A release build needs expo-updates reloadAsync, or the ' +
        'fontScale|density configChanges fix, neither of which is in this spike',
    };
  }
  return { action: 'reload', message: 'reloading the JS runtime to re-register the picker launcher' };
}
