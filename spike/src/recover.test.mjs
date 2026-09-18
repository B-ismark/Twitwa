// Tests for src/recover.js.
//
//   for b in $(grep -o "BREAK [!=]== '[a-z_]*'" src/recover.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/recover.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. Derive the list with that loop rather than typing it,
// and note the `[!=]==` in the pattern: a loop written `BREAK === ` silently
// skipped a mutation spelled `BREAK !== ` elsewhere in this repo, so the gate
// reported on fewer mutations than existed.
//
// The reason this module exists as a separate pure file, rather than as three
// conditions inside App.js: App.js imports Skia, expo-image-picker and
// react-native, so nothing in it can be loaded by a desktop test. Every
// decision that lived there was, by construction, only ever checkable by hand
// on a phone.
import * as real from './recover.js';

const BREAK = process.env.BREAK || '';

let isStaleLauncherError = real.isStaleLauncherError;
let launcherWentStale = real.launcherWentStale;
let resumeDecision = real.resumeDecision;
let recoveryPlan = real.recoveryPlan;

if (BREAK === 'match_whole_sentence') {
  // Match Expo's formatted sentence instead of the AndroidX fragment. Passes
  // for the library picker and fails for anything whose contract differs.
  isStaleLauncherError = (m) =>
    String(m == null ? '' : m).includes(
      'Attempting to launch an unregistered ActivityResultLauncher with contract ' +
        'expo.modules.imagepicker.contracts.ImageLibraryContract',
    );
} else if (BREAK === 'stale_on_width') {
  // Treat any dimension change as a recreation. Rotation changes width and is
  // absorbed by configChanges, so this reports a stale launcher for the one
  // config change that cannot cause it.
  launcherWentStale = (a, b) => {
    if (!a || !b) return false;
    return a.fontScale !== b.fontScale || a.scale !== b.scale || a.width !== b.width;
  };
} else if (BREAK === 'no_age_bound') {
  // Resume on any flag at all. The app then opens the photo picker by itself on
  // an unrelated launch, because a flag file survives the runtime that wrote it.
  resumeDecision = (flag) => (flag ? { resume: true, reason: 'flag' } : { resume: false, reason: 'no flag' });
} else if (BREAK === 'future_flag_resumes') {
  // age < 0 slips through a bound written as `age > maxAge`.
  resumeDecision = (flag, nowMs, maxAgeMs = real.RESUME_MAX_AGE_MS) => {
    if (!flag || typeof flag.at !== 'number') return { resume: false, reason: 'no flag' };
    const age = nowMs - flag.at;
    if (age > maxAgeMs) return { resume: false, reason: 'old' };
    return { resume: true, reason: `age ${age}` };
  };
} else if (BREAK === 'unbounded_retry') {
  // Drop the already-tried guard: a runtime that cannot be repaired by a reload
  // reloads for ever.
  recoveryPlan = ({ canReload }) =>
    canReload
      ? { action: 'reload', message: 'reloading' }
      : { action: 'report', message: 'cannot reload' };
} else if (BREAK === 'reload_without_devsettings') {
  // Claim a reload is possible when nothing can perform one, which is how a
  // release build would silently do nothing at all.
  recoveryPlan = ({ alreadyTried }) =>
    alreadyTried
      ? { action: 'give-up', message: 'tried' }
      : { action: 'reload', message: 'reloading' };
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// The real message, copied from logcat on 2026-09-18 rather than paraphrased.
// A test that invents the string it matches is a test of the invention.
const REAL = "Call to function 'ExponentImagePicker.launchImageLibraryAsync' has been rejected.\n" +
  '→ Caused by: java.lang.IllegalStateException: Attempting to launch an unregistered ' +
  'ActivityResultLauncher with contract expo.modules.imagepicker.contracts.ImageLibraryContract@ffab8f ' +
  'and input ImageLibraryContractOptions(options=expo.modules.imagepicker.ImagePickerOptions@2bbce1c). ' +
  'You must ensure the ActivityResultLauncher is registered before calling launch()';

// The same fault from the camera contract. Never observed — constructed by
// swapping the contract class, which is the part of the sentence that varies.
// It is here because matching the whole formatted sentence passes the observed
// case and fails this one, and only one of the two is in any log.
const REAL_CAMERA = REAL.replace('ImageLibraryContract', 'CameraContract')
  .replace('launchImageLibraryAsync', 'launchCameraAsync');

console.log('recognising the error');
check('the real logcat message is recognised', isStaleLauncherError(REAL) === true);
check('the same fault from the camera contract is recognised too',
  isStaleLauncherError(REAL_CAMERA) === true);
check('a decode failure is not', isStaleLauncherError('Could not decode the image') === false);
check('a cancel is not', isStaleLauncherError('User cancelled') === false);
check('null is not', isStaleLauncherError(null) === false);
check('undefined is not', isStaleLauncherError(undefined) === false);
check('the empty string is not', isStaleLauncherError('') === false);
// An Error, not its message: the handler in App.js passes e.message, but a
// caller that passes the object itself should not silently get false.
check('an Error object is recognised through String()',
  isStaleLauncherError(new Error(REAL)) === true);

console.log('\ndetecting the recreation');
const base = { fontScale: 0.85, scale: 3.5, width: 411, height: 891 };
check('nothing changed -> not stale', launcherWentStale(base, { ...base }) === false);
check('fontScale changed -> stale',
  launcherWentStale(base, { ...base, fontScale: 1.15 }) === true);
check('fontScale changed back -> stale again',
  launcherWentStale({ ...base, fontScale: 1.15 }, base) === true);
check('density (scale) changed -> stale',
  launcherWentStale(base, { ...base, scale: 2.975 }) === true);
// The asymmetric case: rotation. It changes width AND height, and configChanges
// absorbs it, so it must not read as a recreation.
check('rotation (width and height swap) -> NOT stale',
  launcherWentStale(base, { ...base, width: 891, height: 411 }) === false);
check('width alone -> NOT stale', launcherWentStale(base, { ...base, width: 500 }) === false);
check('height alone -> NOT stale', launcherWentStale(base, { ...base, height: 500 }) === false);
check('both fontScale and scale -> stale',
  launcherWentStale(base, { fontScale: 1.3, scale: 2.0, width: 411, height: 891 }) === true);
check('no previous reading -> not stale (first render must not fire)',
  launcherWentStale(null, base) === false);
check('no next reading -> not stale', launcherWentStale(base, null) === false);
check('both missing -> not stale', launcherWentStale(null, null) === false);

console.log('\nresuming after a reload');
const NOW = 1_700_000_000_000;
check('no flag -> no resume', resumeDecision(null, NOW).resume === false);
check('undefined flag -> no resume', resumeDecision(undefined, NOW).resume === false);
check('a flag written now -> resume', resumeDecision({ at: NOW }, NOW).resume === true);
check('one second old -> resume', resumeDecision({ at: NOW - 1000 }, NOW).resume === true);
check('just inside the bound -> resume',
  resumeDecision({ at: NOW - real.RESUME_MAX_AGE_MS }, NOW).resume === true);
check('one ms past the bound -> no resume',
  resumeDecision({ at: NOW - real.RESUME_MAX_AGE_MS - 1 }, NOW).resume === false);
check('a day old -> no resume', resumeDecision({ at: NOW - 86_400_000 }, NOW).resume === false);
check('dated in the future -> no resume',
  resumeDecision({ at: NOW + 5000 }, NOW).resume === false);
check('and the reason says so',
  /future/.test(resumeDecision({ at: NOW + 5000 }, NOW).reason),
  resumeDecision({ at: NOW + 5000 }, NOW).reason);
check('no timestamp -> no resume', resumeDecision({}, NOW).resume === false);
check('a string timestamp -> no resume', resumeDecision({ at: '123' }, NOW).resume === false);
check('NaN timestamp -> no resume', resumeDecision({ at: NaN }, NOW).resume === false);
check('Infinity timestamp -> no resume', resumeDecision({ at: Infinity }, NOW).resume === false);
check('a custom bound is honoured',
  resumeDecision({ at: NOW - 5000 }, NOW, 1000).resume === false);
check('and a generous one too',
  resumeDecision({ at: NOW - 5000 }, NOW, 60_000).resume === true);
check('every answer carries a reason',
  [null, {}, { at: NOW }, { at: NOW - 86_400_000 }, { at: NOW + 1 }]
    .every((f) => typeof resumeDecision(f, NOW).reason === 'string'
      && resumeDecision(f, NOW).reason.length > 0));

console.log('\nchoosing the repair');
check('a fresh runtime that can reload -> reload',
  recoveryPlan({ canReload: true, alreadyTried: false }).action === 'reload');
check('already tried -> give up, not another reload',
  recoveryPlan({ canReload: true, alreadyTried: true }).action === 'give-up');
check('cannot reload -> report',
  recoveryPlan({ canReload: false, alreadyTried: false }).action === 'report');
check('cannot reload AND already tried -> give up',
  recoveryPlan({ canReload: false, alreadyTried: true }).action === 'give-up');
check('the report names what a release build would need',
  /expo-updates/.test(recoveryPlan({ canReload: false, alreadyTried: false }).message));
check('the report names the configChanges fix too',
  /configChanges/.test(recoveryPlan({ canReload: false, alreadyTried: false }).message));
check('every plan carries a message',
  [
    { canReload: true, alreadyTried: false },
    { canReload: true, alreadyTried: true },
    { canReload: false, alreadyTried: false },
    { canReload: false, alreadyTried: true },
  ].every((o) => typeof recoveryPlan(o).message === 'string' && recoveryPlan(o).message.length > 0));
// The bound is the whole safety property: reload at most once per runtime.
check('no input produces two reloads in one runtime',
  [
    { canReload: true, alreadyTried: true },
    { canReload: false, alreadyTried: true },
  ].every((o) => recoveryPlan(o).action !== 'reload'));

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
