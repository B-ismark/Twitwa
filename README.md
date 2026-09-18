# Twitwa — social card renderer

Share a screenshot in, drag a crop, cover any leftover chrome, get a padded PNG on a
background matched to the screenshot. Android first, Expo, no network in v1.

## Read in this order

| File | What it is |
| --- | --- |
| `BUILD-PLAN.md` | **Start here.** Phases, dependency list and what got cut, aesthetic constraints |
| `social-card-renderer.md` | The spec. Decisions, edge cases, screen inventory. The appendix holds the deferred link-input design |
| `measured-endpoints.md` | Four rounds of measured endpoint behaviour, including where earlier rounds were wrong. Only relevant to the v2 appendix |
| `test-links.md` | The five real posts used for endpoint measurement, and what each one exercises. v2 only — Phase 0 needs screenshots, not links |
| `spike/PHASE0.md` | What the Phase 0 spike measures, what counts as a pass, and the Android toolchain setup |
| `spike/results/` | Measured results: `phase0-q1-q3.md`, `phase0-device.md`, `phase1-card-background.md`, `phase1-pipeline.md` |

### Two things to know about this repository

**`spike/` is one squashed commit, not a history.** It was its own git repository
for Phase 0 and Phase 1, and the root repository *ignored* it — so the tree
carrying every argument about the code did not contain the code. It is imported
here as a single commit. Its original 14 commits exist only on the machine that
made them, because their history carries the fixture files described next.

**The real captures are not published, and that is not a size decision.**
`spike/fixtures/screenshots/` and `spike/results/cards/` are gitignored. They are
screenshots of real posts by identifiable people — handles, profile photos, words
— and the rendered cards contain the same content by construction. A public repo
under this project's name is the last place that should live, particularly one
whose design deliberately removes attribution.

The cost is real and worth naming rather than hiding: **a stranger cannot
reproduce the measured device numbers** in `spike/results/`. Those rest on inputs
that are not here.

An earlier version of this paragraph went on to claim a stranger "can run every
gate, because `node tools/make-fixture.mjs` builds synthetic screenshots". That
was **false**, and a review caught it. `tools/chunks.test.mjs` reads
`fixtures/screenshots/ig-handwriting-dark.png` by name, and `make-fixture.mjs`
writes only IHDR/IDAT/IEND — so it cannot produce the embedded ICC profile that
test inspects, and it takes an output path rather than that filename. What is
true: **674 of the 686 checks run in a clone**, and the 12 that cannot say so
and say why. The seven skipped there include the only test of the Q4 Display-P3
answer.

Treat the device figures as recorded measurements, not as reproducible ones.

## State

Decided: screenshot input; Cover tool with a flat sampled fill; card background
sampled from the crop's edges with a Paper/Ink fallback; no aspect presets (the crop
*is* the aspect); PNG **width-bounded** at `min(1080, crop + padding)` with height
following the crop; sRGB SDR output; Library keeps an app-owned **copy** of the
source plus crop rect and mask boxes, so cards stay re-editable whatever happens in
Photos; link input deferred to the appendix.

Distribution is sideload: the owner's own phone, **plus an APK handed to a
handful of known people** (decided 2026-09-18 — an earlier draft of this file said
"personal sideload" and stopped there). That still settles store policy and the
platform display requirements — neither is engaged by an app that reads pixels the
user already had, and no listing exists — and it still settles nothing about the
rights in someone else's post. Those are three questions and an older draft answered
all three with the first one's answer.

What the extra recipients *do* change, none of it about policy:

- **A stable keystore must exist before anyone installs anything.** Android
  refuses an update signed by a different key, so a v1 shipped under a throwaway
  debug key forces every recipient to uninstall — which deletes their Library.
  This is the one decision here that is expensive to take late and free to take
  first. **Done 2026-09-18**; `tools/verify-apk.sh` proves which key signed a
  given APK.
- **The package name is the other half of the same argument.** Android
  identifies an app by package name *plus* signing key, so a rename after v1
  carries exactly the same uninstall-everyone cost as a lost key. A review
  pointed out that the keystore bullet above had been written as though the key
  were the whole of app identity. **Settled 2026-09-18**: the app is called
  Twitwa and the package is `dev.bismark.twitwa`, renamed from
  `dev.bismark.twitwaspike` while nothing had shipped and the rename was still
  free.
- **The APK has to be small enough to send.** The first signed build was
  **124,548,439 bytes**, which is not a thing anyone sends over a chat app. It
  is now **32,886,141 bytes**. See "Making the APK small enough to send" below —
  the whole of the problem was in `lib/`, and the whole of the fix was two
  Gradle properties.
- **Nothing tells a recipient that a new version exists.** There is no store, so
  there is no update notification unless the app makes one. See "Telling people
  there is an update" below.
- **`adb logcat` is no longer the observability story.** Every measured number in
  this repo came off a cable attached to one phone. A friend's failure arrives as
  "it didn't work", so the app needs to be able to hand its own diagnostic text to
  the person holding it.
- **The device matrix stops being hypothetical.** Phase 7 was one device and a
  list of aspirations; it is now other people's phones, which is also the only way
  the Q1 "no visible seam" verdict gets seen by an eye that is not the author's.
- **No dev client.** Everything observed so far ran under `expo-dev-client` with
  Metro attached. Cold start, release JS, and human-readable failure copy are all
  unmeasured.
- **The interface is now load-bearing.** A debug harness is fine for the author of
  the harness. Phase 4 is not optional and not thin.

Started: `spike/`. An Expo SDK 57 project holding the Phase 0 spike.

| File | What it is |
| --- | --- |
| `src/pixels.js` | All the pixel math. Ring flatness, modal background, row ink profile, status-bar cut and shape test, four-edge card background, colour round-trip delta. No Skia — none of it needs Skia to be correct |
| `src/sizing.js` | Output size: width-bounded, never upscaling, no long-edge cap, encode ceiling |
| `src/recover.js` | When the photo picker's launcher has died and what to do about it: detect the recreation, recognise the rejection, bound the resume flag, and reload at most once. Pure, so the policy is testable without a phone |
| `src/read.js` | One clamped sub-rect read, shared by the pipeline and the measurement harness. Was two copies returning the same values under different field names — `{width, height}` in one, `{w, h}` in the other. Pure: the colour constants arrive as an argument, so it loads in node and has a test |
| `src/pipeline.js` | The whole pipeline as one `renderCard()` call. **Run on device four times**, most recently 2026-09-18 after the `readRect` merge, and byte-identical again: `sha256 f9fbb1b4…`, 584991 bytes |
| `src/plan.js` | The decision layer: final crop (status-bar trim), output size, frame colour. No Skia. Its `planCard` takes the background sampler as a *callback*, so the background cannot be sampled from the pre-trim rect |
| `src/measure.js` | Every Skia call, with timings. **Run on device** — see `results/phase0-device.md`. Its readRect now comes from `src/read.js`, and Q1/Q2/Q3/Q4 were all re-measured after that merge and reproduce exactly |
| `App.js` | The spike screen: one button per Phase 0 question, plus two that run the Phase 1 pipeline and draw the written card back off disk |
| `plugins/withReleaseSigning.js` | Signs release builds with the project's own key instead of the debug key the RN template ships. A config plugin because `android/` is generated and gitignored, so a direct edit does not survive `prebuild`. Reads the keystore path from `TWITWA_KEYSTORE_PROPERTIES`, so no path and no secret is committed |
| `tools/png.mjs` | PNG decoder built on node's `zlib`, no dependency |
| `tools/probe.mjs` | Answers Q1, Q3 and the card background from a PNG on disk |
| `tools/make-fixture.mjs` | Synthetic screenshot with known band positions |
| `tools/make-tall.mjs` | Tall synthetic PNGs for the Q5 ramp; 82MiB-as-RGBA costs 0.14MiB on disk |
| `tools/check-imports.mjs` | Verifies named imports between our own modules exist; `expo export` resolves modules but not named exports. Prints whether each module was loaded or source-parsed, because the Skia-importing ones cannot be loaded in node |
| `tools/check-dead.mjs` | Finds exported names nothing outside their own module refers to. Comments are stripped first, because this repo's comments name functions constantly and a dead export otherwise stays alive by being discussed |
| `tools/check-fs-sync.mjs` | Fails on an expo-file-system member used as if it were synchronous. The trap names are derived from the library's own Kotlin module rather than listed here, so the list cannot drift on an upgrade. Exists because this defect was made twice: fixed and written into a comment in `App.js`, then written again into `src/update-io.js` — see "A throttle that never throttled" |
| `tools/chunks.mjs` | Reads a PNG's chunk table and any embedded ICC profile, and names the colour space **by its primaries** — the profile's name cannot, since Skia names both of the ones it writes "Skia". For the Display P3 question, which only the bytes can answer |
| `tools/capture.mjs` | Drains the device's `PHASE0` log lines into `results/phase0-device-raw.txt`; exits 1 rather than write an empty capture |
| `fixtures/screenshots/` | The four real captures every measured number rests on |

**Phase 1: run on the device.** `src/pipeline.js` assembles the whole path —
decode, orientation, status bar, crop, sample, compose, encode, write — with every
decision delegated to `plan.js`/`sizing.js`/`pixels.js`/`read.js`, which is why
those carry 422 checks and 71 mutations between them while the renderer carries
none (**686 checks and 123 mutations** counting the two PNG tools, both config
plugins, the update module and the four rule-checking gates). Three of them are
not pixel work at all: `recover.js` is the picker's self-repair policy,
`plugins/withReleaseSigning.js` is the release-signing patch, and `update.js`
decides whether a newer APK exists.

**A clone runs 674 of those 686 and reports 12 skipped**, which is the number to
trust, because it is the artifact anyone else gets. The skips are in
`tools/chunks.test.mjs`, which needs a real capture that is deliberately not
published, and in the two plugin suites, which compare against the generated
`android/` tree that `prebuild` creates. Both print the skips and the reason
rather than a full green total — a review found the signing suite printing
`18/18 checks passed` in a clone while silently dropping its strongest check,
and six mutants surviving in exactly that state.

`renderCard()` was run four times on a Pixel 6 Pro against a real 1440x3120 capture
picked through the system photo picker, so the input was a `content://` URI:
**1080x2146 out, 550ms wall, status bar found and 89 rows trimmed.** The card was
pulled off the device byte-exact and decoded with `tools/png.mjs`, which shares no
code with Skia: 431117 non-black pixels inside the destination rect and **zero
outside it**, with the content's bounding box matching the rect to the pixel.

Things the runs changed that no test could have:

- **Colour tagging is asymmetric.** `colorSpace: DisplayP3` writes an `iCCP`
  whose primaries are Display P3's, and re-encodes the pixels; the default writes
  **no profile at all** — sRGB by convention only. That closes Q4, and it means
  an sRGB card travels on a viewer's assumption rather than on its own bytes.
- **A Cover box's edge was anti-aliased**, leaving one pixel of the covered
  content at up to 53/255 — a leak, since covering a handle is a redaction. The
  rect is now snapped outward to whole pixels and drawn with AA off: 306 leaked
  pixels became 0 on the device.
- **The status-bar detector cost ~245ms**, 45% of the wall. Now ~110: the ink
  loop was allocating an array per pixel and scanning 4096 histogram buckets per
  row. What is left is mostly the lazy decode, which the first pixel read pays
  for and nothing can avoid.
- **The card is byte-identical across a 2x density range** (320 / 476 / 640 dpi
  overrides on the one device), which is the Phase 1 density gate. The *Cover
  box* is not — it comes from view coordinates, so the same on-screen rectangle
  covers a different region at each density. A crop must be stored in image
  pixels the moment it is committed.
- **Light captures work, including the fallback.** An Instagram capture whose
  crop edges disagree falls back to the neutral frame and reaches the identical
  verdict the desktop predictor had printed before any phone was involved.
- **A configuration change breaks the image picker.** After the density change,
  `launchImageLibraryAsync` rejects with `Attempting to launch an unregistered
  ActivityResultLauncher`. It used to surface as an unhandled rejection with
  nothing on screen; it is now caught and reported under its own label, which
  does not re-register the launcher but does stop the app losing its input
  action silently — **and that catch has now been seen firing on the phone**,
  provoked with a font-scale change. This paragraph used to add that "rotation
  and a font-size change would do the same"; the font scale does, and rotation
  does **not**, because `MainActivity` declares `orientation|screenSize` in
  `configChanges` and absorbs it without recreating the activity. Two guesses,
  one of them wrong, which is why the sentence is gone.
- **The repair itself did not work in the release build, and that took a release
  build to find.** `recoveryPlan` has always had three answers, and one of them
  — `report` — exists precisely for a build that cannot reload itself.
  It could never be reached. `App.js` decided by asking
  `typeof DevSettings.reload === 'function'`, and React Native declares
  `reload(reason) {}` — an empty function — replacing it with a working one
  only inside `if (__DEV__)`
  (`react-native/Libraries/Utilities/DevSettings.js:37` and `:45`). So in the
  release APK the method is present, `typeof` says `function`, the call is
  legal, and it does nothing. Measured on the phone on 2026-09-18: the app
  logged `pick.recover` with `"action":"reload"`, logged
  `pick.recover.reload {"resumeFlagWritten":true}`, called `reload()` — and
  the process id was 29696 before and 29696 after. The picker stayed dead and
  the app had announced a repair it did not perform. The guard is now
  `canReloadRuntime(DevSettings, __DEV__)` in `src/recover.js`, pure and tested,
  with `typeof_only` as one of its mutants.

And two from a third review pass, both cases of a check that could not go red:

- **The Cover ring was read as the whole box.** Sampling the surround of a Cover
  box asked for the box's padded bounding rectangle and threw the interior away —
  82.2MiB of `readPixels` on a 1080x20000 source to use 165KiB of it. The same
  defect had already been found and fixed in the background fallback; this was the
  second caller with the same shape, and it survived two passes. Now read as four
  non-overlapping strips, held to a brute-force enumeration of the ring.
- **The PNG colour validator reported malformed profiles as sound.** It tested one
  of the four failure flags its parser can set, so a truncated chunk, an
  18-byte profile and a header lying about its own length were all `tagged: true`.
  This is the tool that closed Q4, so it mattered more than its severity suggested;
  Q4's answer survives because the colorants are read down a separate path, and
  re-running the fixed tool reproduces both published verdicts.

**Never sent through WhatsApp, and not going to be from here.** The output spec
was chosen against WhatsApp's recompression, so that part stays an assumption;
`spike/results/phase1-pipeline.md` says what it costs and what would settle it.

`spike/results/phase1-pipeline.md` has the log lines and what each check was.

Two review passes over it found five real defects, four of them in code written
the same day. The one worth naming here: rectangle clipping was **clamped field
by field instead of intersected**, so a crop hanging off the left edge came back
wider than it was asked for. It was in three files at once, and the test that
should have caught it used the one input where both rules agree.
`spike/results/phase1-pipeline.md` has all five.

Not started: the app itself. The spike is throwaway by design.

**Q1 and Q3 are both answered** — `spike/results/phase0-q1-q3.md`. Four real
captures, 58 Cover target rows, nothing above 2.09/255 and 50 of 58 below 1,
including pure-white Facebook chrome at 0.38. Q3's shape test now accepts real
status bars and rejects app headers, verified in both directions.

Q1 comes with one design change: the fill is the ring's **modal** colour, never
its mean. Text caught in the sampling ring produced a `#838383` fill on pure white
and `#7F7F7F` on pure black, and overstated roughness by up to 62x — a mean would
have read Q1 as failing on screenshots that pass comfortably.

## Next action — Phase 0

A throwaway spike. One screen, no nav, no design. It exists to answer four
questions, and the first one can kill the project:

1. ~~Does the sampled fill look seamless?~~ **Answered: yes**, dark and light.
   Remaining is the eye check on a display and a gradient header.
2. Is Skia fast enough? Real captures are **4.49MP / 17.1MiB RGBA**, measured — not
   the 2.6MP earlier drafts assumed.
3. ~~Does status-bar detection generalise?~~ **Answered**, once a shape test was
   added. One device so far, so other Android skins are untested.
4. Does Display P3 survive the Skia encode?
5. Does a very tall screenshot survive at all? 1080×20000 is ~82MiB as a single
   RGBA buffer, before copies, textures and the export allocation.

Do not start Phase 1 until 1 and 3 are known. (5) sets the decode and output
ceilings, which the spec currently carries as visible guesses. Full exit criteria in
`BUILD-PLAN.md`.

## Gates

Both exit 1 on failure and have been verified to actually go red:

```
python contrast.py                       # WCAG ratios for every token pair
python og.py <pages...>                  # OG extraction; needs fixtures below
cd spike && node src/pixels.test.mjs     # 168 checks on the pixel math
cd spike && node src/read.test.mjs       # 52 checks on the shared sub-rect read
cd spike && node src/recover.test.mjs    # 49 checks on the picker-recovery policy
cd spike && node src/sizing.test.mjs     # 60 checks on the output sizing
cd spike && node src/plan.test.mjs       # 99 checks on the decision layer
cd spike && node src/update.test.mjs     # 84 checks on the update check and its URL allowlist
cd spike && node tools/check-imports.mjs # 52 imports + 7 self-checks on its own rule
cd spike && node tools/check-dead.mjs    # 83 exports + 7 self-checks on its own rule
cd spike && node tools/png.test.mjs      # 16 checks on the PNG decoder
cd spike && node tools/chunks.test.mjs   # 51 checks on the PNG chunk/ICC reader
cd spike && node tools/check-fs-sync.mjs  # 4 files scanned + 11 self-checks on its own rule
cd spike && node tools/check-release-manifest.mjs     # 6 checks on release/latest.json
cd spike && node plugins/withReleaseSigning.test.mjs  # 34 checks on the release-signing patch (37 after a prebuild)
cd spike && node plugins/withAndroidSize.test.mjs     # 37 checks on the APK-size properties (39 after a prebuild)
cd spike && bash tools/verify-apk.sh     # which key actually signed the APK
cd spike && npx expo export --platform android --output-dir %TEMP%\pf0
```

That last one is the cheapest pre-device gate — it catches import typos, syntax and
babel breakage in ~40s with no phone. It is also how the `babel.config.js` mistake
was found; see `spike/PHASE0.md`. It resolves modules, not named exports, so it
cannot catch a wrong named import.

Every suite carries a `BREAK=` mutation per assertion group, so a green run can be
shown to mean something. Derive the names from the files rather than listing them
here — this README carried three hand-written lists and all three had fallen
behind, which is the same failure as a mutation that cannot go red:

```
cd spike
# Three suites are listed separately: their mutants are edits to the REAL
# source of the module under test, loaded from a temp copy, rather than BREAK
# branches written in the suite. So each publishes its own list with
# --list-mutants. Two hand-written copies of a grep had already drifted apart
# ([a-z_]* here, [a-z_0-9]* there), which is the same defect as a mutation
# that cannot fire.
#
# The `|| true` that used to be on the line below was a defect in this very
# loop. `cmd || true` sets $? to 0 whether cmd failed or not, so the test
# after it read 0 every time and the loop printed NOT RED for mutants that
# were red and for mutants that were not, indiscriminately. Do not put it
# back.
for p in plugins/withReleaseSigning.test.mjs plugins/withAndroidSize.test.mjs \
         src/update.test.mjs; do
  for b in $(node "$p" --list-mutants); do
    BREAK=$b node "$p" >/dev/null 2>&1
    [ $? -eq 1 ] || echo "NOT RED: $p $b"
  done
done
for t in src/pixels.test.mjs src/read.test.mjs src/recover.test.mjs \
         src/plan.test.mjs src/sizing.test.mjs tools/chunks.test.mjs \
         tools/png.test.mjs \
         tools/check-imports.mjs tools/check-dead.mjs; do
  for b in $(grep -o "BREAK [!=]== '[a-z_0-9]*'" "$t" | sed "s/.*'\\(.*\\)'/\\1/" | sort -u); do
    BREAK=$b node "$t" >/dev/null 2>&1; [ $? = 1 ] || echo "NOT RED: $t $b"
  done
done                                     # silence is the pass; 123 mutations
```

Two things this loop had wrong, both of which hid mutations rather than reporting
them. It matched `BREAK === ` only, so a mutation written as `BREAK !== ` was
never run — `check-dead.mjs` had one, and it exited 0 unnoticed until the pattern
was widened. And it listed the five suites and neither gate, so the mutations on
`check-imports.mjs` and `check-dead.mjs` were outside the loop that exists to
prove mutations fail. Both are the README's own warning, one paragraph up, coming
true twice.

## Answering Q1 and Q3 without a phone

Ring flatness and status-bar detection are pure pixel math — only Skia speed, the
colour round trip and the memory ceiling need a device. So:

```
cd spike
node tools/probe.mjs <your-screenshot.png> [more.png ...]
```

Handles PNG colour types 0/2/4/6 — captures off the same phone came back as both
type 2 and type 6, so anything assuming four channels would be wrong half the
time.

It prints the ring-flatness distribution over several hundred candidate boxes and
the detected status-bar cut row. **Drop real Instagram and X screenshots on it and
Q1 gets a number today** — the eye still decides the seam on a device, but the
number predicts it. PNG only; `tools/png.mjs` decodes with node's `zlib` and no
dependency.

This already paid for itself: a synthetic fixture run exposed `detectStatusBar`
cutting at row 1, because screenshots have flat padding above the clock and it
took the first flat run it found. Its unit test had passed by coincidence. Details
in `spike/PHASE0.md`.

`contrast.py` should be re-run against whatever lands in `theme.ts`, not against
what the docs claim.

`og.py` only matters for the v2 appendix. Its fixtures are archived because the
originals lived in a session-scoped temp directory — a gate whose fixtures are gone
is not a gate:

```
python -c "import tarfile;tarfile.open('fixtures/og-pages.tar.gz').extractall('fixtures/pages', filter='data')"   # filter= needs Python 3.12+
python og.py fixtures/pages/*.html       # expect exit 0 across 8 pages
```

## Unverified

The pixel math is tested against synthetic buffers in Node, which proves the
arithmetic and proves nothing about a real screenshot — so the real captures in
`spike/fixtures/screenshots/` carry every measured claim, and the device run in
`spike/results/phase0-device.md` carries the rest.

**All five Phase 0 questions now have measured answers, and none says stop.** The
two numbers that were placeholders waiting on Q5 came back split: the 8000px
height ceiling survives with about 2x headroom and does real work, while the
~10MP total turns out to be **unreachable** — `cardSize` caps width at 1080 and
height at 8000, so its largest output is 8.64MP and the pixel check is dead code.
It was justified twice before anyone checked that. Kept as a guard, with the
slack asserted in `spike/src/sizing.test.mjs`.

What is left in Phase 0 is not a measurement. Q1's verdict belongs to an eye on a
real display, and no number in `spike/results/` can settle it.

**The dev-client build completes and the spike runs.** It took five attempts and
four distinct causes: a `local.properties` backslash bug (Java properties files eat single
backslashes), a space in `rootProject.name`, a missing NDK r27b, and a full C:
drive. The fifth succeeded — 419 tasks, `BUILD SUCCESSFUL`, a 96MB debug APK
installed on the Pixel 6 Pro as `dev.bismark.twitwaspike` (the package was
renamed to `dev.bismark.twitwa` on 2026-09-18; this paragraph records what was
installed at the time). Gradle also pulled in
`cmake;3.22.1` on its own during the native build.

**The Skia calls now run.** Every signature in `spike/src/measure.js` was read
out of Skia 2.6.2's own `.d.ts` rather than recalled, and all of it executed on a
Pixel 6 Pro without a single signature error — decode, sub-rect `readPixels`,
`MakeOffscreen`, `makeImageSnapshot`, `encodeToBytes`, and both colour spaces.

Still unverified: WhatsApp's real recompression, crop-gesture performance on
mid-range hardware, **Q1 on an actual display** (every number predicts no seam;
nobody has looked), and whether the Display P3 colour chunk survives into the PNG.

**The share target registers but cannot be exercised here.** Rebuilt with the
filters and measured on the installed package: `ACTION_SEND` and
`ACTION_SEND_MULTIPLE` both resolve for `image/png`, `image/jpeg` and
`image/webp`, and `text/plain` is correctly refused. But a real share is consumed
by `DevLauncherActivity` and never reaches the app, because Expo appends filters
to the main activity and in a dev client that is the launcher.

**Settled on the release APK, 2026-09-18, and the answer has two halves.** In a
standalone build the filter does resolve straight to `dev.bismark.twitwa/
.MainActivity` with no launcher in the way, which is what the dev client could
never show. But sharing an image to it does nothing, because **nothing in the
app reads an incoming intent**: there is no `getInitialURL`, no share handler,
no consumer of `EXTRA_STREAM` anywhere in `App.js`. Earlier wording here said
only that "delivery needs a release-style build", which read as though the code
were waiting on a build. It is not written yet. See
`spike/results/phase0-device.md`.

## Building it — local Android

Chosen over EAS cloud. The toolchain was already most of the way there:

| Present | Was missing |
| --- | --- |
| JDK 17 with `JAVA_HOME` set, platforms 34 and 35, build-tools 34 and 35, cmdline-tools | `ANDROID_HOME`, `platforms;android-36`, `build-tools;36.0.0`, `platform-tools` on PATH, NDK 27.1.12297006 |

The SDK now lives at `D:\AndroidDev\sdk` and the Gradle home at
`D:\AndroidDev\gradle`, both moved off `C:` because it hit **0 bytes free** and
Gradle failed with `There is not enough space on the disk`. `ANDROID_HOME`,
`ANDROID_SDK_ROOT` and `GRADLE_USER_HOME` are persisted at User scope. Android
Studio, if used, still points at the old path.

Expo needs compileSdk 36 — read out of `expo-modules-core`'s gradle plugin
defaults, not assumed — so the 36 packages were installed. **NDK 27.1.12297006 is
also required and must be installed with `sdkmanager` first**: Gradle names the
version but cannot fetch it itself. An earlier guess here that RN 0.86 needed no
NDK was wrong.

Two Windows traps cost a build each, both written up in `spike/PHASE0.md`:
`android/local.properties` must use forward slashes (Java properties files consume
single backslashes as escapes), and `rootProject.name` must not contain a space.

`spike/android/local.properties` pins `sdk.dir`, so Gradle works in a shell with no
`ANDROID_HOME`.

**The device is a Pixel 6 Pro** (density override 476); its serial is in the
`TWITWA_DEVICE` environment variable rather than in this file, because the repo is
public and an adb serial is a hardware identifier with no upside in being read by
strangers. `adb devices -l` prints it. It is
authorized and has carried every device run since Phase 0; this paragraph used to
say it read `unauthorized` and needed the "Allow USB debugging" prompt, which was
true on the first attempt only. If a fresh checkout does read `unauthorized`, that
prompt is still the answer, and the full steps are in `spike/PHASE0.md`. Two things
the phone needs from its owner and no flag can supply: it must be **unlocked**
(a secure fingerprint lock sends every tap to the keyguard) and its screen must be
**on** — `dumpsys power` reporting `mWakefulness=Dozing` looks exactly like a
hung app from the shell.

### Building a release APK

The signing key is **not** in this repository and never will be. Gradle finds it
through one environment variable naming a properties file that lives outside the
tree:

```
cd spike/android
TWITWA_KEYSTORE_PROPERTIES=/path/to/keystore.properties ./gradlew assembleRelease
cd .. && bash tools/verify-apk.sh
```

**The second command is not optional.** With the variable unset, Gradle prints
one `logger.lifecycle` line and then produces a **debug-signed**
`app-release.apk` under the identical filename, and exits 0. A review made the
point that killed any argument for leaving this to a log line: that message is
emitted at configuration time, so it fires on every ordinary
`expo run:android` too — it is trained noise long before a release is built.
`tools/verify-apk.sh` reads the signature off the artifact and exits 2 if it
carries the shared Android debug key. It is the only check here that looks at
the artifact rather than the source.

Set-but-wrong is handled differently from unset, on purpose: if the variable
points at a file that is not there, Gradle raises a `GradleException` instead of
falling back.

**`spike/eas.json` deliberately has no build profiles.** It used to carry a
`preview` profile, which was a second signing source of truth: `eas build`
generates and uses its own keystore, so an APK built that way carries a
different signature, and Android refuses to install it over one signed by the
key above — the recipient sees only "App not installed", with no reason given.
Nothing here builds on EAS. With the profiles gone, `eas build` fails on a
missing profile, which is the intended outcome. The file is kept rather than
deleted so the reason survives where someone would go looking for it.

Two more things a review established about this path, both counter-intuitive:

- **`expo prebuild` writes the native template BEFORE it runs plugins.** So if
  `plugins/withReleaseSigning.js` cannot find its anchors, prebuild exits 1 and
  still leaves a complete, buildable, pristine `android/` tree whose release
  buildType reads `signingConfig signingConfigs.debug`. The plugin therefore
  also prepends a `throw new GradleException(...)` to the generated
  `build.gradle` on failure, so the leftover cannot be built. Failing closed
  beats failing loudly.
- **The APK was 124,548,439 bytes**, and 61,374,008 of that was `x86` /
  `x86_64` native libraries that no phone can use. **Fixed 2026-09-18**: it is
  32,886,141 bytes. (Byte counts throughout, not MB — an earlier version of
  this bullet quoted MiB while the section below quoted bytes, so the same file
  appeared in this file as both 31.3 and 32.9.) See
  "Making the APK small enough to send" above for the measurements. Note that
  restricting the ABI list is the right lever and ABI *splits* are the wrong one
  — React Native disables the ABI filter when splits are enabled.

### Making the APK small enough to send

The first signed build was **124,548,439 bytes**. There is no store here, so that
number is not an abstraction: it is the size of a file a person has to receive
over a chat app before they can use this at all. It is now **32,886,141 bytes**,
a 73.6% cut, with no change to what the app does.

The whole of the problem was in `lib/`, and `unzip -v` said so before anything
was changed:

| | uncompressed | in the APK |
| --- | ---: | ---: |
| `lib/x86` | 31,051,496 | 31,051,496 |
| `lib/x86_64` | 30,322,512 | 30,322,512 |
| `lib/arm64-v8a` | 29,468,664 | 29,468,664 |
| `lib/armeabi-v7a` | 20,114,028 | 20,114,028 |
| everything else | 165,100,694 | 12,820,537 |

Two readings, both of which point at a fix:

- **All 72 `.so` entries were `Stored`**, not deflated — the only part of the
  archive receiving no compression was the part that was 80% of it. React Native
  0.73 made that the default so libraries can be mapped straight out of the APK
  at runtime, which is a real gain and the wrong trade when the APK is the
  delivery mechanism.
- **Two of the four ABIs cannot run on a phone.** `x86` and `x86_64` are there
  for emulators. That is 61,374,008 bytes, at full size, in every copy sent to
  everyone.

So: `reactNativeArchitectures=arm64-v8a,armeabi-v7a` and
`expo.useLegacyPackaging=true`, both written by `spike/plugins/withAndroidSize.js`,
which re-reads what it wrote and throws if any value is not what it intended.
`armeabi-v7a` is kept deliberately: sideloading has no Play filter, so a 32-bit
device that cannot install says only "App not installed", with no reason. It
costs 9,255,669 bytes of the 32.9 MB and buys a failure mode that never happens.

Two traps here, and both fail by doing nothing rather than by erroring:

- **The minify property is `android.enableMinifyInReleaseBuilds`.** Expo SDK 57's
  template reads that name (`android/app/build.gradle:69`). Nearly every guide
  names `android.enableProguardInReleaseBuilds`, which comes from the bare React
  Native template and is not read here at all. Setting the guide's key leaves R8
  off and looks like it was turned on.
- **ABI splits would have silently undone the ABI fix.** React Native's Gradle
  plugin applies `reactNativeArchitectures` as `defaultConfig.ndk.abiFilters`
  *only when `splits.abi` is disabled*, and says so in a comment
  (`NdkConfiguratorUtils.kt:58-63`). Enabling splits would have put all four
  ABIs back into the split that got built.

**R8 is deliberately still off.** Every lever above is packaging: the bytes move,
the program does not. R8 rewrites and strips bytecode, and the classic React
Native failure is a module resolved by reflection at startup that is no longer
there. The dex is 21,380,964 bytes uncompressed and 7,800,880 in the APK, so the
upside is real — but it is a separate change with a device test attached, and it
has not been made.

### Telling people there is an update

No store means nothing tells a recipient that a new version exists. So the app
asks.

`release/latest.json` in this repository is the manifest. `spike/src/update.js`
reads it, compares its `versionCode` against `expo-application`'s
`nativeBuildVersion` — the number Android itself compares, not a copy of
`app.json` baked into the bundle — and if the manifest is newer, offers the
download. `release/README.md` is the publishing procedure and the order in it
matters: publish the release asset first, edit the manifest second, or every
installed copy points at a 404.

Three decisions worth stating, because each one is a thing deliberately *not*
done:

- **The app does not download or install anything.** It hands the URL to the
  system browser. That means no `REQUEST_INSTALL_PACKAGES` permission — which is
  a meaningfully scarier thing to be handed by a friend, and the permission
  prompt says so — and it means Android's own package manager performs the
  signature check. An APK signed by another key is refused by the OS, not by code
  written here.
- **The download URL is confined to one literal prefix.**
  `https://github.com/B-ismark/Twitwa/releases/download/`. A full URL's authority
  ends at the first `/` after `//`, and that slash is inside the prefix, so one
  string comparison pins scheme, host and the first three path segments. The
  manifest arrives over the network; without this it would be a way to get
  someone to install an arbitrary APK under Twitwa's own prompt. Fourteen hostile
  URLs are enumerated individually in `src/update.test.mjs`, because a single
  "rejects a bad URL" check would pass while thirteen still got through.
- **This is the app's first and only network call, and that has a cost.** One
  HTTPS GET to `raw.githubusercontent.com`, no identifier, no query string. But
  GitHub sees the IP and the time, and a check happens when the app is used, so
  anyone watching that traffic learns roughly when this person opens Twitwa.
  Hence once a day, never before the app is opened — though see below: the
  throttle did not work at all until a device run caught it. A switch to turn it off
  belongs in Settings and does not exist yet, because Settings does not exist
  yet.

### A throttle that never throttled

The first thing a device run found, and nothing else could have found it.

Two launches of the release APK three minutes apart, from logcat:

```
I ReactNativeJS: 'PHASE0', 'P0.updateCheck {"action":"current","installed":1,"latest":1,"reason":null}'
I ReactNativeJS: 'PHASE0', 'P0.updateCheck {"action":"current","installed":1,"latest":1,"reason":null}'
```

The second had to read `"action":"skipped"`. `current` means it went to the
network, three minutes into a twenty-four hour throttle.

The cause is one word. `readLastChecked` called `f.text()`, and `text` is
declared with `AsyncFunction` in expo-file-system's native module — it returns a
promise. `JSON.parse` of a promise throws, the function's own `try/catch` turned
that into `null`, and `null` means "never checked". So the throttle did not
degrade: it did not exist, and the app made its one network call on every single
launch. The privacy cost written three paragraphs above was not being paid down
at all.

Three things about this are worth more than the fix:

- **Nothing failed.** No log line, no crash, no red test. The only visible
  evidence was two launches' output side by side, which is not a thing anyone
  looks at unless they are already suspicious.
- **The `try/catch` did the damage.** It was there to keep a corrupt file from
  bricking the check, and it is right to be there. But it cannot tell a corrupt
  file from a programming error, and it answered the same way for both. A
  `catch` that returns a plausible value converts a crash into a wrong answer,
  which is strictly worse.
- **It had already been found once.** `takeResumeFlag` in `App.js` carries a
  comment saying exactly this, written after the same mistake cost a debugging
  session on the resume flag. `src/update-io.js` was written afterwards, by
  someone who had read that comment, and made the same mistake anyway. That is
  the whole argument for `tools/check-fs-sync.mjs`: a comment is a thing you
  have to be reading at the moment you need it, and a gate is not.

The gate derives the trap names — `text`, `bytes`, `base64`, `copy`, `move` — by
reading which members expo-file-system declares with `AsyncFunction` and which
have a `*Sync` twin, out of the library's own Kotlin source. Typing that list
here would be the same defect one level up, and it would go stale silently on
the next upgrade.

`versionCode` is `1` and is set explicitly in `app.json`. Expo's own default is
`config.android?.versionCode ?? 1`, rewritten on every prebuild, so leaving it
implicit meant it could never move: two materially different APKs would have
been indistinguishable to Android and to whoever was holding one. **Bump it for
every build handed to anyone.**
