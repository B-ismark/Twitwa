# Phase 0 — de-risk spike

Throwaway. One screen, no nav, no design. Exists to answer four questions from
`../BUILD-PLAN.md` and to write the answers somewhere they survive.

## Why this is measured, not eyeballed

Q1 ("does the sampled fill look seamless?") is stated as a taste question, and
taste does not survive a compaction. So the spike computes a **flatness number**
for the ring it samples — mean colour plus per-channel standard deviation and
max deviation — and shows the fill next to the untouched pixels. A high ring
stddev predicts a visible seam before anyone squints at it. The eye still
decides; the number is what gets recorded and compared across screenshots.

## What each question produces

| Q | Measurement | Pass condition |
| --- | --- | --- |
| 1. Seamless fill | ring mean RGB, per-channel stddev, max deviation; A/B toggle of covered vs original | judged on device, with stddev recorded alongside the verdict |
| 2. Skia fast enough | ms for decode, `readPixels`, ring sample, composite, PNG encode; pixel count | composite + encode under ~400ms at **4.49MP** — the plan's 2.6MP was a 1080x2400 guess, and this device shoots 1440x3120 |
| 3. Status-bar detect | per-row ink-coverage profile, chosen cut row, cut as fraction of height | cut lands on the real boundary on 3 Android skins. **1 of 3 done** — stock Android, on the Pixel 6 Pro below; the shape test is verified in both directions but on one status bar |
| 4. P3 survives encode | max per-channel delta over an encode -> decode round trip on a saturated region | delta small enough to be invisible; large delta = document it, not fix it |
| 5. Memory ceiling | the height at which a full RGBA `readPixels` throws or the app dies, and the pixel count that went with it | **no pass condition — this one is meant to fail.** The number wanted is where it fails, so the spec carries a measured ceiling instead of a guess |

## Status-bar heuristic under test

Not a fixed fraction. Per row from the top, compute *ink coverage* — the
fraction of pixels in that row deviating from the row's own modal colour. The
status bar is a low-but-nonzero-ink band; the app header sits below a short run
of near-zero-ink rows. Cut at the first run of >= 8 consecutive near-zero-ink
rows. The spike shows the whole profile so a miss is diagnosable rather than
just wrong.

## Not answered here

WhatsApp recompression (Phase 1, needs a real send) and gesture performance
(Phase 2, needs the slowest device). This spike does not test them.

## Running it on a local Android build

Derived from this machine and the installed packages, not from recollection:

| Thing | Value | Where it came from |
| --- | --- | --- |
| Android SDK | `D:\AndroidDev\sdk` | **relocated from `%LOCALAPPDATA%\Android\Sdk`** — see the disk note below |
| Gradle home | `D:\AndroidDev\gradle` | relocated from `%USERPROFILE%\.gradle`, same reason |
| JDK | 17.0.19 (Adoptium), `JAVA_HOME` set | `java -version` |
| compileSdk / minSdk / targetSdk | 36 / 24 / 36 | `expo-modules-core/expo-module-gradle-plugin/.../ProjectConfiguration.kt` defaults |
| Gradle | 9.3.1 | `android/gradle/wrapper/gradle-wrapper.properties` |
| Skia | 2.6.2 | resolved by `npx expo install` |
| Reanimated / worklets | 4.5.1 / 0.10.4 | reanimated 4 peer-pins worklets to `0.10.x`. **There is deliberately no `babel.config.js`** — see below |

`platforms;android-36` and `build-tools;36.0.0` were missing and were installed;
only 34 and 35 were present. `cmake;3.22.1` was pulled in by Gradle itself
during the native build, unprompted.

| Device | Value | Where it came from |
| --- | --- | --- |
| Model | Pixel 6 Pro (`raven`), Google | `adb shell getprop ro.product.manufacturer` |
| Android | 17, **API 37** | `ro.build.version.release` / `.sdk` |
| Screen | 1440x3120, density 560 (override 476) | `adb shell wm size` / `wm density` |
| Serial | not recorded here — this repo is public | `adb devices -l` |

**`keystore.properties` is a second Java properties file with the same
backslash trap as `android/local.properties`, and it is read by
`Properties.load()` in the signing plugin.** `storeFile=D:\CODES\...` has its
single backslashes consumed as escapes, `file()` then gets a garbage path, and
the failure surfaces at `assembleRelease` rather than at the plugin's own
existence check — which validates the path to the properties file, not the
`storeFile` inside it. Use forward slashes. This trap has now been paid for
once in this repo and found by review in a second place before it was paid for
again.
| ABI built | `arm64-v8a` only | `expo run:android` builds the attached device's ABI |

**The device runs one API level above what the app targets** (37 vs targetSdk
36). That is forward-compatible and fine to measure on, but it also means
Android 17's target-level behaviour changes do not apply here and will not be
seen by this spike. Anything the real app does with MediaStore or the photo
picker has to be re-checked against targetSdk 37 before release.

**NDK 27.1.12297006 is required, and Gradle cannot install it for you.** The guess
that RN 0.86 would consume only prebuilt native artifacts and need no NDK was
wrong. Gradle names the exact version, tries to fetch it, and fails:

```
com.android.builder.sdk.InstallFailedException: Failed to install the following
SDK components: ndk;27.1.12297006
```

Install it first, with sdkmanager, and let the build come second.

An interrupted attempt leaves a directory containing only `.installer/.installData`
and nothing else. That looks like an empty stub worth deleting and is not — it is
sdkmanager's resume marker, and re-running sdkmanager continues from it. Deleting
it costs the whole ~700MB again.

## Two Windows traps, one build each

- **`local.properties` needs forward slashes.** It is a Java properties file, so
  the single backslashes in `C\:\Users\you\...` are consumed as escape sequences
  and the path becomes `C:UsersyouAppData...`. Gradle reports only
  `The filename, directory name, or volume label syntax is incorrect`, nested
  inside `Failed to notify project evaluation listener`, which points nowhere near
  the cause. Write `sdk.dir=C:/Users/...` instead.
- **No space in `rootProject.name`.** `expo prebuild` takes it from `app.json`'s
  `name`, so "Twitwa spike" became the Gradle project name and the build died the
  same opaque way. Renamed to `TwitwaSpike` in both places, so a re-prebuild does
  not reintroduce it. **Renamed again on 2026-09-18 to `Twitwa`**, which is also
  the launcher label, at the same time as the package name below.

- **The package name is `dev.bismark.twitwa`, decided 2026-09-18.** It was
  `dev.bismark.twitwaspike`, a name this file recorded as a build fix rather
  than a product decision. Android identifies an app by package name *plus*
  signing key, so changing either after v1 ships forces every recipient to
  uninstall, which deletes their Library. Nothing had shipped, so the rename was
  free; after the first APK leaves this machine it costs exactly what losing the
  key costs. `namespace` and `applicationId` are written into
  `android/app/build.gradle` by prebuild, so the rename also invalidated
  `plugins/fixtures/build.gradle.pristine` and both pinned digests in the
  signing suite -- regenerate with `node plugins/fixtures/make-pristine.js`,
  which prints the new digests and refuses if the recovery is not faithful.

  The old package appears in `results/phase0-device.md` and
  `results/phase1-pipeline.md`, deliberately: those are dated records of runs
  that really did install `dev.bismark.twitwaspike`, and rewriting them would
  falsify the record rather than update it.

```
# ANDROID_HOME, ANDROID_SDK_ROOT and GRADLE_USER_HOME are persisted at User
# scope, so a fresh shell already has them. In this session's shells:
$env:ANDROID_HOME = 'D:\AndroidDev\sdk'
$env:ANDROID_SDK_ROOT = 'D:\AndroidDev\sdk'
$env:GRADLE_USER_HOME = 'D:\AndroidDev\gradle'
$env:PATH = "$env:ANDROID_HOME\platform-tools;$env:PATH"
adb devices                      # must read "device", not "unauthorized"
npx expo run:android             # builds the dev client and installs it
```

## Two things about `expo prebuild` that cost time here

**`prebuild` clears `android/`, it does not merge into it.** Running
`npx expo prebuild --platform android` to pick up a config change printed
`- Clearing android` / `✔ Cleared android code` and regenerated the directory from
scratch. Consequences, all of which had to be undone or redone:

- `android/local.properties` was deleted. That is the file whose backslashes cost
  a whole build earlier, so it is worth restoring deliberately rather than letting
  the next `run:android` guess: `sdk.dir=D:/AndroidDev/sdk`, forward slashes.
- `android/app/build/` went with it, so the 419-task build has to run again. The
  Gradle caches live in `D:\AndroidDev\gradle` and survive, so the rebuild is much
  cheaper than the first — but it is not free, and it is not incremental.
- `rootProject.name` survived, because it is derived from `expo.name` in
  `app.json` rather than hand-edited. That is the one hand-fix that stuck, and
  only because it stopped being a hand-fix.

Back up `local.properties`, `settings.gradle`, `gradle.properties` and the
manifest before running it.

**Share-target filters land on the MAIN activity.** Read out of
`@expo/config-plugins/build/android/IntentFilters.js` rather than assumed:
`setAndroidIntentFilters` calls `getMainActivityOrThrow` and appends there, tagging
each filter `data-generated="true"` so a re-run replaces rather than duplicates.
The renderer prefixes `android.intent.action.` to `action` and
`android.intent.category.` to each `category`, and turns each `data` key into
`android:<key>` — so this in `app.json`:

```json
"intentFilters": [
  { "action": "SEND",          "category": ["DEFAULT"], "data": [{ "mimeType": "image/*" }] },
  { "action": "SEND_MULTIPLE", "category": ["DEFAULT"], "data": [{ "mimeType": "image/*" }] }
]
```

produces exactly the two filters wanted, verified in the regenerated
`AndroidManifest.xml`. **Both** actions are registered deliberately: with only
`SEND`, a two-image share does not offer the app at all, which reads as a broken
share target rather than a missing filter.

The consequence turned out to be stronger than "arrives there first". Measured: a
real `ACTION_SEND` is **swallowed** by `DevLauncherActivity`, which shows its own
home screen and hands nothing on. The filters resolve correctly — both actions,
three mime types, `text/plain` properly refused — so registration is right and
verifiable; delivery is simply untestable on this build type. See
`results/phase0-device.md`.

## The disk note

The build failed once with `java.io.IOException: There is not enough space on the
disk`, buried ~4000 lines into Gradle's output. `C:` was at **0 bytes free** — the
2.2GB NDK was the last straw on a 117GB volume.

Both the SDK and the Gradle home were moved to `D:` with `robocopy /MOVE`, which
took C: from 0 to 6.97GB free. `robocopy` rather than `Move-Item` because the NDK
has paths past 260 characters.

**`robocopy` exit code 1 means success** — "one or more files were copied". Its
codes are a bitmask where only >= 8 is a failure, so the shell reported the move
as failed when it had worked. Verify by looking at the filesystem, not the exit
code.

If Android Studio is used on this machine, its own SDK path setting still points
at the old `%LOCALAPPDATA%` location and needs repointing by hand.

`android/local.properties` already pins `sdk.dir`, so Gradle finds the SDK even
in a shell where `ANDROID_HOME` is unset.

## Getting results off the phone

Every measurement is printed with a `PHASE0` marker as well as shown on screen.
The spike writes no file of its own: `adb` is right here, and a log line cannot
be lost to a permission dialog.

Watching it live is fine —

```
adb logcat -s ReactNativeJS:V | grep PHASE0
```

— but that pipe never exits, so the numbers only ever exist in a terminal
scrollback, which is the one place a measurement must not live. Use the script
instead, which drains the buffer and writes a file:

```
node tools/capture.mjs clear     # before tapping anything
#   ... tap the buttons on the phone ...
node tools/capture.mjs dump      # -> results/phase0-device-raw.txt
```

`dump` **exits 1 and writes nothing** on an empty capture, because zero lines has
three different causes — nothing was tapped, the installed build predates the
marker, or logcat rotated — and an empty file reports all three as success. That
guard was watched failing before it was trusted.

## Buttons, and why they are separate

`Q1+Q3` are the cheap reads. `Cover on` / `Cover off` are the A/B for the seam,
and also produce the Q2 timings and the Q4 round trip. `P3` repeats the compose
through a Display P3 offscreen surface. `Q5 stress` deliberately asks for the
whole RGBA buffer — the thing production must never do — so the ceiling becomes a
measurement instead of the guess the spec currently carries.

One button per question rather than one Measure that runs them all, because Q5 is
expected to be able to die and a single button would lose the four cheap answers
every time it did.

`Q1+Q3` emits **both** estimators side by side — the modal fill that is actually
used, and the mean fill that would have been used — so the device confirms on real
captures what the desktop probe already measured, rather than taking it on trust.
It also emits the status-bar shape verdict and `shouldTrim`, which is `false`
whenever the shape test fails.

## Findings before the device

**Do not add a `babel.config.js` for Reanimated 4 on SDK 57.** Every Reanimated
guide says to add its babel plugin. On this stack that instruction is stale and
adding it broke the bundle two ways at once:

- `babel-preset-expo` is not a hoisted dependency — it lives under
  `node_modules/expo/node_modules/`. A project-level babel config makes babel
  resolve it from the project root, where it is not, giving
  `Cannot find module 'babel-preset-expo'`.
- The plugin was already there. `babel-preset-expo` adds
  `react-native-worklets/plugin` on its own whenever the package is installed —
  see `configs/expo.js`, "Automatically add worklets or reanimated plugin when
  package is installed". So the config duplicated it.

Deleting `babel.config.js` fixed it. The blank template ships without one, which
was the hint.

**The cheapest pre-device gate is a bundle.** It catches import typos, syntax and
babel breakage in about 40 seconds with no phone attached:

```
npx expo export --platform android --output-dir <tmp>
```

That is what caught the babel problem. Clean run: 1289 modules, 3.2MB `.hbc`.

Note its limit. Metro resolves *modules*, not *named exports*, so a wrong named
import bundles happily and is `undefined` at runtime. `ColorSpace` was checked the
other way — by confirming the string `display-p3` reached the compiled bundle — and
the Skia call signatures were read from the installed 2.6.2 `.d.ts`. Read, not run.

## Q1 and Q3 do not need the device

They are pure pixel math. Only Q2 (Skia speed), Q4 (the colour round trip) and
Q5 (the memory ceiling) actually need a phone. So `tools/` answers the first two
from a PNG on disk:

```
node tools/probe.mjs <screenshot.png> [...]        # Q1 distribution + Q3 cut row
node tools/probe.mjs shot.png --box=40,1180,980,64 # one specific region
```

`tools/png.mjs` decodes the PNG using nothing but node's `zlib` — PNG is inflate
plus five per-scanline filters, so no dependency was needed. Narrow on purpose:
8-bit, non-interlaced, colour types 0/2/4/6. Anything else throws by name rather
than decoding to plausible garbage. 16 checks in `tools/png.test.mjs`, all five
filter types round-tripped against a gradient-plus-hard-edge image, because a
wrong Paeth predictor decodes fine and reports wrong colours.

`tools/make-fixture.mjs` writes a synthetic screenshot with known band positions.
It cannot answer Q1 — its flat regions are flat by construction — but it makes
the probe falsifiable.

### What the synthetic fixture immediately caught

`detectStatusBar` was wrong. It took the first run of flat rows from the top, and
a screenshot has **padding above the clock**, so the first flat run is at the very
top. It cut at row 1 and trimmed nothing.

Its unit test had passed. The test's glyphs started at row 8 and `minRow: 8`
cancelled exactly those 8 leading flat rows — a coincidence, not a check. The fix
finds the status bar's own ink first and then the first flat run *after* it;
`BREAK=sb_lead` restores the original so the new test is shown to catch that
specific regression. On the fixture it now cuts at row 46, with glyphs at 26..45.

Worth stating plainly: the heuristic would have shipped to the device broken, and
the device would have shown a wrong trim without saying why.
