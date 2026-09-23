# Twitwa — social card renderer

Share a screenshot in, drag a crop, get a padded PNG on a background matched to
the screenshot. Android first, Expo. Its only network use is the update check and,
when asked, the update download.

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
true: **1686 of the 1704 checks run in a clone**, and the 18 that cannot say so
and say why. The seven skipped there include the only test of the Q4 Display-P3
answer.

Treat the device figures as recorded measurements, not as reproducible ones.

## State

Decided: screenshot input; card background sampled from the crop's edges with a Paper/Ink fallback; no aspect presets (the crop
*is* the aspect); PNG **width-bounded** at `min(1080, crop + padding)` with height
following the crop; sRGB SDR output; link input deferred to the appendix.

Settled 2026-09-18, and they changed the shape of the app: **one screen and no
navigation**, so there is no Library and nothing persists past a session; **Share
is the primary action**, with Save to Photos and Copy image in an overflow
(Save moved to the bar beside Share on 2026-09-23);
**padding is three stops plus a drag** to fine-tune; **corner radius is in**,
partly reversing the spec's own refusal of it, while the **drop shadow was wanted
and dropped the same day** because it could not be platform elevation and a Skia
one clips against the padding budget in the export; **auto-redaction is out**.
**Cover is out too, cut by the owner on 2026-09-22**: the app does no redaction,
so on Instagram a card keeps the like count or loses the caption. BUILD-PLAN.md's
Phase 3 keeps the design to return to. The incoming image is still copied into app-owned storage at import,
because a `content://` URI from a share is a revocable grant and not a file — it
is just session-scoped now. See `social-card-renderer.md` for the IA and
`BUILD-PLAN.md` for the survey those decisions were taken against.

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
  debug key forces every recipient to uninstall.
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
  was **32,886,397 bytes** after two Gradle properties, and is **19,211,087**
  since 2026-09-22, when the owner dropped 32-bit and R8 went on; 1.0.2, with
  the share-in module, is **19,220,311**, 1.0.3 is **19,220,639**, and 1.0.4 is **19,230,939**. See "Making the
  APK small enough to send" below — the whole of the problem was in `lib/`.
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
| `src/sharein.js` | What the native share-in module's answer means: open a `file://` copy, show a sentence, or do nothing. Pure, and it tells "no share" apart from "the module is not in this build", which look the same on screen |
| `src/sharein-io.js` | The JS face of `modules/twitwa-share-in`. Optional, so a build without the module reads as no share rather than a crash |
| `modules/twitwa-share-in/` | Native module of our own. Kotlin: holds the newest unread `ACTION_SEND` or `ACTION_SEND_MULTIPLE`, copies the picture into `cache/shared-in/`, and emits `onShare` when one arrives while running. Autolinked from `modules/`. Run on the owner's Pixel on 2026-09-23: cold, warm, after Back, two pictures, a refused file, from Recents |
| `plugins/withShareInRestore.js` | Patches the generated `MainActivity.kt` so a share replayed after process death is not imported twice. The Expo template calls `super.onCreate(null)`, which hides the saved state from every lifecycle listener; the call goes in just before that line |
| `src/update-io.js` | The JS face of `modules/twitwa-updater`. Optional like share-in: without the module, Get it falls back to the browser |
| `modules/twitwa-updater/` | Native module of our own. Kotlin: downloads the release APK into `cache/update/`, checks its sha256 against the manifest, checks it again, and opens Android's installer through a FileProvider. Adds `REQUEST_INSTALL_PACKAGES` |
| `src/read.js` | One clamped sub-rect read, shared by the pipeline and the measurement harness. Was two copies returning the same values under different field names — `{width, height}` in one, `{w, h}` in the other. Pure: the colour constants arrive as an argument, so it loads in node and has a test |
| `src/skia.js` | The one `RGBA` colour shape and the one two-argument `readRect`. Both were written privately in `pipeline.js` AND `measure.js`, and App.js had neither — which is exactly why it called the three-argument `readSubRect` with two and crashed every import for a day. A function that binds the colour cannot be called without it |
| `src/pipeline.js` | The whole pipeline as one `renderCard()` call. **Run on device four times**, most recently 2026-09-18 after the `readRect` merge, and byte-identical again: `sha256 f9fbb1b4…`, 584991 bytes |
| `src/plan.js` | The decision layer: final crop (status-bar trim for `renderCard`'s `trim: 'auto'`; the editor's own proposal trims in `autocrop.js`, and the app exports with `trim: 'never'`), output size, frame colour. No Skia. Its `planCard` takes the background sampler as a *callback*, so the background cannot be sampled from the pre-trim rect |
| `src/measure.js` | Every Skia call, with timings. **Run on device** — see `results/phase0-device.md`. Its readRect now comes from `src/read.js`, and Q1/Q2/Q3/Q4 were all re-measured after that merge and reproduce exactly. Q1's device read was removed with Cover on 2026-09-22, since a drawn Cover box was its only input |
| `App.js` | The screen. Choose a screenshot, and it opens on a finished card; Crop and Style adjust it, Share sends it. The Phase 0 harness it used to be still exists, behind a long press on the caption |
| `src/theme.js` | The token table, and the only place a colour is written down. Plain data with no react-native import, so `contrast.py` reads the shipped values out of this file rather than a second copy of them |
| `src/copy.js` | Every user-facing word, as plain strings. A view that writes its own text is a gate failure, not a style preference |
| `src/crop.js` | Phase 2's gesture arithmetic, separated from the gesture: fit, drag, resize, clamp, handle hit-testing, all in image-pixel space. Pure, so the arithmetic is testable without a finger — and every function carries `'worklet'`, an inert string in node, so the drag calls it on the UI thread |
| `src/DevPanel.js` | The Phase 0/1 measurement harness, kept reachable because every measured number in this repository came out of its buttons. Deliberately outside `check-copy.mjs`'s view list: "Q1+Q3" is the right label for a cable, and the wrong one for a person |
| `plugins/withReleaseSigning.js` | Signs release builds with the project's own key instead of the debug key the RN template ships. A config plugin because `android/` is generated and gitignored, so a direct edit does not survive `prebuild`. Reads the keystore path from `TWITWA_KEYSTORE_PROPERTIES`, so no path and no secret is committed |
| `plugins/withAndroidSize.js` | The gradle properties that took the release APK from 124.5 MB down. Re-reads what it wrote, because both of the settings involved fail by silently doing nothing |
| `plugins/withDebugSuffix.js` | Gives the debug build `applicationIdSuffix '.debug'`, so a dev client and the released app coexist on one phone. Without it they share a package name and carry different signing keys, so testing either one means uninstalling the other |
| `tools/png.mjs` | PNG decoder built on node's `zlib`, no dependency |
| `tools/probe.mjs` | Answers Q1, Q3 and the card background from a PNG on disk |
| `tools/make-fixture.mjs` | Synthetic screenshot with known band positions |
| `tools/make-tall.mjs` | Tall synthetic PNGs for the Q5 ramp; 82MiB-as-RGBA costs 0.14MiB on disk |
| `tools/check-imports.mjs` | Verifies named imports between our own modules exist; `expo export` resolves modules but not named exports. Prints whether each module was loaded or source-parsed, because the Skia-importing ones cannot be loaded in node |
| `tools/check-dead.mjs` | Finds exported names nothing outside their own module refers to. Comments are stripped first, because this repo's comments name functions constantly and a dead export otherwise stays alive by being discussed |
| `tools/check-copy.mjs` | Fails when the app's words break the copy voice, or when a view writes its own words instead of taking them from `src/copy.js`. Reads the values by importing the module, not by grepping its source |
| `tools/check-style-members.mjs` | Fails on a `StyleSheet.<member>` the installed React Native does not define. The member list is read out of React Native's own source, so it cannot drift on an upgrade. Exists because `StyleSheet.absoluteFillObject` was removed in 0.86 and spreading a missing property is silent: two styles lost their positioning with no warning and no failing test |
| `tools/check-call-arity.mjs` | Fails on a call to one of our own imported functions with an illegal number of arguments. Parses the consumer AND the module rather than importing the module and reading `fn.length`: the modules most worth checking are the ones that cannot be loaded in node at all, and `fn.length` stops counting at the first default, so it cannot tell three required from one required and two optional. Its last check injects a short call into the real `App.js`, so its green cannot mean "matched nothing". Exists because `readSubRect(img, box, colour)` was called with two arguments, every import crashed for a day, and `check-imports`, a clean `expo export` and 1359 checks were all green throughout |
| `tools/check-fs-sync.mjs` | Fails on an expo-file-system member used as if it were synchronous. The trap names are derived from the library's own Kotlin module rather than listed here, so the list cannot drift on an upgrade. Exists because this defect was made twice: fixed and written into a comment in `App.js`, then written again into `src/update-io.js` — see "A throttle that never throttled" |
| `tools/chunks.mjs` | Reads a PNG's chunk table and any embedded ICC profile, and names the colour space **by its primaries** — the profile's name cannot, since Skia names both of the ones it writes "Skia". For the Display P3 question, which only the bytes can answer |
| `tools/capture.mjs` | Drains the device's `PHASE0` log lines into `results/phase0-device-raw.txt`; exits 1 rather than write an empty capture |
| `fixtures/screenshots/` | The four real captures every measured number rests on |

**Phase 1: run on the device.** `src/pipeline.js` assembles the whole path —
decode, orientation, status bar, crop, sample, compose, encode, write — with every
decision delegated to `plan.js`/`sizing.js`/`pixels.js`/`read.js`, which is why
those carry 411 checks and 78 mutations between them while the renderer carries
none (**1704 checks and 275 mutations** counting the two PNG tools, all four
config plugins, the update module, the share-in decision and the seven rule-checking gates). Eight of them
are not pixel work at all: `recover.js` is the picker's self-repair policy,
`plugins/withReleaseSigning.js` is the release-signing patch, `update.js`
decides whether a newer APK exists, `crop.js` is Phase 2 gesture arithmetic,
`compose.js` is Phase 4.5's rule that the live preview and the exported
PNG are one composition projected to two widths rather than two compositions,
`shell.js` is the editor's tool sessions, `autocrop.js` is the crop the
editor opens on, and `sharein.js` is what a received share means.

Those two numbers have a convention, because without one they are not
comparable between readings: every check each gate prints as run, on a tree
where `android/` exists, summed; and every mutant the loops below enumerate.
They were re-derived by running all of it on 2026-09-23, not by adding to the
previous figure. Doing that arithmetic instead is what published three wrong
counts in this file before.

**A clone runs 1686 of those 1704 and reports 18 skipped**, and it runs all 275
mutations with none surviving. Measured 2026-09-23 from `git archive` of
the UX-pass commit, extracted with CRLF line endings as a Windows clone gets it, so the thing gated is the commit and not the
working copy. The warm figure above was re-measured by the same script in the
same sitting rather than being carried over, because two numbers from two
instruments are not a comparison.

That pairing is the check: 1704 − 1686 = 18, which is the skip count, so the
clone is the warm run minus exactly the checks that announced they could not
run. The pair before Phase 4.5's device run was 1109 of 1125, and both figures
moved by 234 — the arithmetic this file refused to publish would have been
right, which is not a reason to have published it. It is the same arithmetic
that was wrong three times before.

The 203 was itself re-derived rather than incremented, and that caught
something. The enumerator written for it read only `if (BREAK === 'x')` chains
and reported **149**, printing a confident `0 mutants` for four suites that
declare theirs as a `MUTANTS` table and for the two gates that publish a
`--list-mutants` list. A zero printed for something never counted is the
failure this file's own rules are about; it now reads all three shapes, and the
two gates that publish a list are believed over a scan of their source.

One thing the clone cannot see, and it is worth naming here because it went
wrong: **no gate in this list loads App.js**. `check-imports` reads it, but it
verifies that an imported name RESOLVES, not how it is CALLED. On 2026-09-18
App.js passed two arguments to a three-argument function and crashed on every
single import, with all of the numbers above green. The fix was to move the
logic out of the view rather than to correct the call — see `src/autocrop.js`
and `src/skia.js`, and the Phase 4.5 section of `BUILD-PLAN.md`.

**There is a second kind of blindness, found the same way on the same day.**
Moving the crop drag onto the UI thread made `src/crop.js` a set of Reanimated
worklets, and a worklet's closure is built by a babel plugin from the
identifiers in the function BODY. `pickHandle`'s `{ touch = TOUCH }` default is
in the parameter list, so `TOUCH` never crossed the thread boundary and the
first finger-down threw `Property 'TOUCH' doesn't exist` — while node, which
resolves the same default from module scope, ran all 89 of that file's checks
green. Neither failure is about a missing test; both are about a gate that
cannot see the thread or the view the code actually runs in. `BREAK=not_worklet`
and `BREAK=default_captures` now read the source text of `crop.js`, which is
the only instrument a desktop has for either.

One qualification on the method, because it is the part that could rot: the
clone's `node_modules` is a **junction to the warm tree's**, which the recipe
below allows and which a cross-volume symlink is too slow for. It therefore
proves the tracked tree is self-sufficient — no untracked source file is
reached for — but it does not re-resolve the dependency versions. A figure that
has to survive a lockfile change needs a real install.

The clone number is the one to trust, because it is the
artifact anyone else gets. The skips are 7 in
`tools/chunks.test.mjs`, which needs a real capture that is deliberately not
published, and 4, 2 and 3 in the three plugin suites, which compare against the
generated `android/` tree that `prebuild` creates. Each prints the skips and
the reason rather than a full green total — a review found the signing suite
printing `18/18 checks passed` in a clone while silently dropping its strongest
check, and six mutants surviving in exactly that state.

**How to measure that, because the method published here before was wrong.**
It said to copy `src/`, `tools/`, `plugins/` and `app.json` somewhere with no
`android/`. That omits `App.js` and every root file, so `check-imports`,
`check-dead` and `check-release-manifest` crash instead of running and
`check-copy` fails three — an instrument that under-reports and looks like a
smaller app rather than like a broken measurement. A clone is the tracked tree
and nothing else, so take it from git:

```
git add <your work> && T=$(git write-tree)
git archive --format=tar "$T" | tar -x -C /tmp/clone
cd /tmp/clone && git init -q . && printf 'node_modules/\n' >> .git/info/exclude
git add -A && git -c user.email=x@y -c user.name=x commit -qm clone
# then junction or install node_modules under /tmp/clone/spike and run the list above
```

The `git init` is not ceremony: `check-dead` derives its file list from
`git ls-files` rather than walking the filesystem, which is the right design
and means a directory without a `.git` is not a clone. Reading its crash as a
defect in the gate, rather than in the instrument, is the mistake that costs an
afternoon.

**The signing suite's skip count was one short, and that was found this way.**
A warm run printed 38 and the clone 34, but only 3 SKIP lines — so one check
produced no line at all, and one SKIP line named `patch(fixture) reproduces the
generated file byte-for-byte`, a check renamed earlier the same day when it
became a plugin-chain comparison. Two hand-maintained copies of one list. Both
branches now read their names from a single `LIVE_CHECKS` object, so 34 + 4
equals 38 and the arithmetic itself is the check.

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
  rect was then snapped outward to whole pixels and drawn with AA off: 306 leaked
  pixels became 0 on the device. (History: Cover was cut on 2026-09-22.)
- **The status-bar detector cost ~245ms**, 45% of the wall. Now ~110: the ink
  loop was allocating an array per pixel and scanning 4096 histogram buckets per
  row. What is left is mostly the lazy decode, which the first pixel read pays
  for and nothing can avoid.
- **The card is byte-identical across a 2x density range** (320 / 476 / 640 dpi
  overrides on the one device), which is the Phase 1 density gate. The *Cover
  box*, since cut, was not — it came from view coordinates, so the same
  on-screen rectangle covered a different region at each density. A crop must be
  stored in image pixels the moment it is committed.
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
  second caller with the same shape, and it survived two passes. It was then read
  as four non-overlapping strips, held to a brute-force enumeration of the ring.
  Cover was cut on 2026-09-22; `ringStrips` and its tests stay in `pixels.js`.
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

**Q1 and Q3 are both answered** — `spike/results/phase0-q1-q3.md`. Q1 was Cover's
question, and is history since Cover was cut on 2026-09-22. Four real captures,
58 Cover target rows, nothing above 2.09/255 and 50 of 58 below 1,
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
python contrast.py                       # 16 WCAG token pairs + the scheme config
python og.py <pages...>                  # OG extraction; needs fixtures below
cd spike && node src/pixels.test.mjs     # 196 checks on the pixel math
cd spike && node src/read.test.mjs       # 61 checks on the shared sub-rect read
cd spike && node src/recover.test.mjs    # 49 checks on the picker-recovery policy
cd spike && node src/sizing.test.mjs     # 62 checks on the output sizing
cd spike && node src/plan.test.mjs       # 92 checks on the decision layer
cd spike && node src/crop.test.mjs       # 135 checks on the crop-gesture arithmetic
cd spike && node src/compose.test.mjs    # 80 checks that the preview and the export are one composition
cd spike && node src/shell.test.mjs      # 96 checks on the editor's tool sessions, Style controls and Back
cd spike && node src/autocrop.test.mjs   # 84 checks on the crop the editor opens on
cd spike && node src/update.test.mjs     # 135 checks on the update check, Later, its URL allowlist, and its contract with the Kotlin
cd spike && node src/sharein.test.mjs    # 60 checks on what a received share means, and its contract with the Kotlin
cd spike && node tools/check-imports.mjs # 135 imports + 7 self-checks on its own rule
cd spike && node tools/check-dead.mjs    # 174 exports + 7 self-checks on its own rule
cd spike && node tools/check-copy.mjs    # 48 checks on the app's words and where they live
cd spike && node tools/png.test.mjs      # 16 checks on the PNG decoder
cd spike && node tools/chunks.test.mjs   # 51 checks on the PNG chunk/ICC reader
cd spike && node tools/check-fs-sync.mjs  # 4 files scanned + 21 self-checks on its own rule
cd spike && node tools/check-style-members.mjs  # 60 checks; fails on a StyleSheet member RN does not define
cd spike && node tools/check-call-arity.mjs     # 14 checks; fails on a call with the wrong argument count
cd spike && node tools/check-release-manifest.mjs     # 7 checks on release/latest.json, its sha256 included
cd spike && node plugins/withReleaseSigning.test.mjs  # 34 checks on the release-signing patch (38 after a prebuild)
cd spike && node plugins/withAndroidSize.test.mjs     # 42 checks on the APK-size properties (44 after a prebuild)
cd spike && node plugins/withDebugSuffix.test.mjs     # 15 checks on the debug application id (18 after a prebuild)
cd spike && node plugins/withShareInRestore.test.mjs  # 22 checks on the MainActivity restore patch (24 after a prebuild)
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
         plugins/withDebugSuffix.test.mjs plugins/withShareInRestore.test.mjs tools/check-copy.mjs \
         tools/check-style-members.mjs tools/check-call-arity.mjs \
         src/update.test.mjs; do
  # The suite must be green unmutated first. A file that cannot load exits 1
  # under every BREAK, and without this line the loop read that as every
  # mutant red and printed nothing. Shown on 2026-09-22 with a syntax error, a
  # missing import and a missing export: silence all three times.
  node "$p" >/dev/null 2>&1 || echo "NOT GREEN: $p"
  for b in $(node "$p" --list-mutants); do
    # Exit 1 alone is not red: a mutant whose search string has rotted exits 1
    # with NO LONGER APPLIES, and one that breaks the syntax or an import exits
    # 1 before any assertion runs. None of them tests anything, and
    # slice_from_debug sat here as the first kind, counted red, until 2026-09-22.
    out=$(BREAK=$b node "$p" 2>&1); rc=$?
    [ $rc -eq 1 ] && ! printf '%s' "$out" | grep -q -E 'NO LONGER APPLIES|SyntaxError|ERR_MODULE_NOT_FOUND' || echo "NOT RED: $p $b"
  done
done
for t in src/pixels.test.mjs src/read.test.mjs src/recover.test.mjs \
         src/plan.test.mjs src/sizing.test.mjs src/crop.test.mjs \
         src/compose.test.mjs src/shell.test.mjs src/autocrop.test.mjs \
         src/sharein.test.mjs tools/chunks.test.mjs \
         tools/png.test.mjs \
         tools/check-imports.mjs tools/check-dead.mjs; do
  node "$t" >/dev/null 2>&1 || echo "NOT GREEN: $t"   # as above
  for b in $(grep -o "BREAK [!=]== '[a-z_0-9]*'" "$t" | sed "s/.*'\\(.*\\)'/\\1/" | sort -u); do
    BREAK=$b node "$t" >/dev/null 2>&1; [ $? = 1 ] || echo "NOT RED: $t $b"
  done
done                                     # silence is the pass; 275 mutations
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

## A style that was never applied

`StyleSheet.absoluteFillObject` does not exist in React Native 0.86. The export
that survives is `absoluteFill`. Two styles in this app spread the missing one,
and spreading `undefined` is legal and silent:

    empty: { ...StyleSheet.absoluteFillObject, alignItems: 'center', ... }
    sheet: { ...StyleSheet.absoluteFillObject, paddingTop: ..., ... }

Neither produced a warning, a red box, or a failing test. What they produced was
an empty-state message pinned to the top of the stage instead of its middle, and
a developer panel that laid out in flow below the controls instead of covering
the screen. Both look like flexbox mistakes and both were found by eye on a
phone on 2026-09-18, which is the expensive way to find anything.

Two things came out of it. The four inset properties are now written out in
full, which costs three lines and cannot half-apply. And
`tools/check-style-members.mjs` reads the member list out of React Native's own
source and fails on any `StyleSheet.<member>` this repository uses that the
installed version does not define. It was shown failing on the real defect
before being believed: a file spreading `absoluteFillObject` exits 1 and names
the file.

The same run turned up the contrast version of the same mistake, and the fix has
the same shape. The stage is dark **in both themes**, so a component running
light that reached for `graphite` drew at **2.37:1** on it — failing AA and the
3:1 UI floor. That is what the empty-state message did, and what the developer
log did. `contrast.py` could not see it because no pair involving `stage` was in
its table. There are now `onStage` and `onStageMuted` tokens, identical in both
palettes, and `contrast.py` checks both against the stage in both: 16 pairs, 0
failing. A seventeenth row was added later and is not a colour pair at all --
it asserts that something can actually SELECT the dark palette. See the
night-mode note below for why that was needed.

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

**The dark palette was drawn for the first time on 2026-09-18, and the reason
it had never been drawn was in `app.json`, not in the phone.** What this
section used to say — that the Pixel locks night mode, so dark could not be
shown — was the wrong diagnosis of a real observation, and it stood long
enough to leave half the theme untested.

`spike/app.json` carried `"userInterfaceStyle": "light"`. That is the
create-expo-app default and nobody had revisited it. expo-dev-launcher reads
the key out of the manifest Metro serves and overwrites React Native's
`AppearanceModule` with it — `DevLauncherExpoAppLoader.applyUserInterfaceStyle`,
which reaches in and sets both `overrideColorScheme` and `colorScheme` by
reflection. So `useColorScheme()` returned `light` on a phone whose Activity
configuration said `night`, and the harness line that was quoted as evidence
(`scheme:light`) was reporting the override rather than the device.

The half that was right: `cmd uimode night no` really is accepted and then
ignored here — the Activity config stays `night` through `no`, `yes` and
`auto` alike, which is Bedtime mode holding it. The wrong half was concluding
from that that the phone could not show dark. It shows dark all evening; the
app was being told not to.

Set to `automatic`, `scheme:dark` is what the harness prints and the whole
dark palette renders. **Two things worth keeping in mind about the scope of
that bug.** The override lives in expo-dev-launcher's **debug** source set
only, and this app ships no expo-updates, so the **release** APK never had it:
the theme nobody had tested was the one other people were given. And
`userInterfaceStyle` needs no rebuild to change — the dev client re-reads the
manifest from Metro on relaunch.

`contrast.py` now checks the key alongside the sixteen colour pairs, because a
contrast table for a palette nothing can select is decoration. It has been
observed failing two ways — the key set to `light`, and the key absent — and
green either side of both.

**Phase 4 was run on the phone on 2026-09-18**, through the debug build. The
empty state, the three-control source state, the Cover box, Make card, the
result state, the long press into Developer tools and **Share** were each
exercised and screenshotted. Share was the one with no prior evidence at all:
`Sharing.isAvailableAsync()` resolves true in this build and the Android chooser
opens on the rendered card.

**The share target registers but cannot be exercised here.** Rebuilt with the
filters and measured on the installed package: `ACTION_SEND` and
`ACTION_SEND_MULTIPLE` both resolve for `image/png`, `image/jpeg` and
`image/webp`, and `text/plain` is correctly refused. But a real share is consumed
by `DevLauncherActivity` and never reaches the app, because Expo appends filters
to the main activity and in a dev client that is the launcher.

**Settled on the release APK, 2026-09-18, and the answer has two halves.** In a
standalone build the filter does resolve straight to `dev.bismark.twitwa/
.MainActivity` with no launcher in the way, which is what the dev client could
never show. But sharing an image to it did nothing, because nothing in the
app read an incoming intent: no `getInitialURL`, no share handler, no consumer
of `EXTRA_STREAM`. Earlier wording here said only that "delivery needs a
release-style build", which read as though the code were waiting on a build.
It had not been written. See `spike/results/phase0-device.md`.

**Written on 2026-09-22, and run on the owner's Pixel on 2026-09-23** (1.0.3). `spike/modules/twitwa-share-in`
reads the intent (`ACTION_SEND` and `ACTION_SEND_MULTIPLE`) and copies the
picture into the cache; `spike/src/sharein.js` decides what to do with it.
BUILD-PLAN.md, Phase 5, has the design.

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
  `x86_64` native libraries that no phone can use. **Fixed 2026-09-18**: it was
  32,886,397 bytes, and since 2026-09-22 (64-bit only, R8 on) it is
  19,211,087. (Byte counts throughout, not MB — an earlier version of
  this bullet quoted MiB while the section below quoted bytes, so the same file
  appeared in this file as both 31.3 and 32.9.) See
  "Making the APK small enough to send" above for the measurements. Note that
  restricting the ABI list is the right lever and ABI *splits* are the wrong one
  — React Native disables the ABI filter when splits are enabled.

### Making the APK small enough to send

The first signed build was **124,548,439 bytes**. There is no store here, so that
number is not an abstraction: it is the size of a file a person has to receive
over a chat app before they can use this at all. After the packaging work below
it was **32,886,397 bytes**, a 73.6% cut, with no change to what the app does;
after dropping 32-bit and turning on R8 on 2026-09-22 it is **19,211,087**, 84.6%
below the first build (measured section at the end). (The build the size work was
measured against was 32,886,141; the shipped artifact is 256 bytes larger
because two later bug fixes changed the JS bundle. The reduction is the
measurement, the larger number is the file people receive, and quoting either
one as the other is how a byte count stops meaning anything.)

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

So: `reactNativeArchitectures` and `expo.useLegacyPackaging=true`, both written
by `spike/plugins/withAndroidSize.js`, which re-reads what it wrote and throws if
any value is not what it intended. The ABI list was `arm64-v8a,armeabi-v7a` until
2026-09-22 and is now `arm64-v8a` alone, the owner's decision; see the end of
this section for what that costs.

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

#### What is left, measured 2026-09-18 on a rebuilt release APK

The owner asked whether anything could be stripped -- code or a feature -- to
make the APK smaller. It was answered by rebuilding and reading the archive
rather than by reasoning about it, and the answer is **no, not by that route**.
`app-release.apk` is **32,940,585 bytes**:

| | in the APK | uncompressed | share |
| --- | ---: | ---: | ---: |
| `lib/arm64-v8a` | 10,722,649 | 29,149,672 | 32.6% |
| `lib/armeabi-v7a` | 9,255,669 | 19,929,648 | 28.1% |
| `classes*.dex` | 7,810,455 | 21,406,228 | 23.7% |
| `assets/` (the JS bundle is 2,762,388 of it) | 2,765,847 | 2,766,268 | 8.4% |
| everything else | 1,395,692 | 1,589,572 | 4.2% |
| `res/` | 829,390 | 1,146,702 | 2.5% |

**Deleting a feature is not a size lever here, and the arithmetic says so.**
Every line of this app's own JavaScript -- `App.js`, `index.js` and all of
`src/`, comments included, unminified -- is **239,506 bytes**. The whole
minified bundle is 2,762,388, so the app's own code is a fraction of a bundle
that is itself 8.4% of the APK. Deleting *all of it* would not reach half a
percent of the download. `src/measure.js` and the Q1-Q5 probe blocks in
`App.js` are a Phase 0 measurement rig that does ship; that is a reason to remove
them, but size is not one. (Cover was on this list as a placeholder the owner had
questioned; the owner cut it on 2026-09-22.)

The three levers that are real, in order, and none of them is code:

1. **Drop `armeabi-v7a`: 9,255,669 bytes, 28.1%.** Done 2026-09-22, the
   owner's decision.
2. **R8, on the 7,810,455-byte dex.** Done 2026-09-22; see below.
3. **Neither of these:** `libzstd-kmp.so` is 276,362 per ABI and nothing here
   was traced to it, and Fresco's four libraries (`imagepipeline`,
   `static-webp`, `native-imagetranscoder`, `native-filters`) are ~450,000 per
   ABI for React Native's `<Image>`, which this app never renders -- it draws
   through Skia. Both are transitive native dependencies and neither is
   removable without a Gradle exclusion and a device test. Recorded as
   unclaimed, not as savings.

One thing that is **not** a problem, checked because it would have been a large
one: the dev client does not leak into release. `libbarhopper_v3.so`, the ML
Kit barcode scanner behind expo-dev-launcher's QR reader, is 4,946,720 bytes
per ABI in the debug APK and **absent from the release APK**.

#### 64-bit only, and R8 on -- measured 2026-09-22

The owner took both levers. `app-release.apk` is **19,211,087 bytes**, down
13,729,498 (41.7%) from the 32,940,585 above:

| | in the APK | uncompressed | share |
| --- | ---: | ---: | ---: |
| `lib/arm64-v8a` | 10,722,649 | 29,149,672 | 55.8% |
| `classes*.dex` | 3,302,734 | 8,065,172 | 17.2% |
| `assets/` | 2,801,261 | 2,802,090 | 14.6% |
| everything else | 1,396,421 | 1,590,473 | 7.3% |
| `res/` | 829,548 | 1,146,998 | 4.3% |
| zip headers and central directory | 158,474 | | 0.8% |

`lib/arm64-v8a` is byte-identical in size to the build above, so nearly all of
the change is the two levers: the `armeabi-v7a` directory is gone, and R8 took
the dex from 7,810,455 to 3,302,734 in the APK (21.4 MB to 8.1 MB uncompressed).
`assets/` grew by 35,414 bytes over the same period, which is the JS bundle
gaining Save, Copy and the Phase 2 work. (The table above it has the same
shape of gap -- its rows are zip entries, and 160,883 bytes of that file were
the zip's own headers.)
`aapt2 dump badging` reports `native-code: 'arm64-v8a'` and nothing else. That
APK was built from the working tree at versionCode 2, before the version bump,
so a 1.0.2 build, when one is cut, differs by its version and manifest. The
same tree after the review fixes to `App.js` built to 19,211,235, 148 bytes
more; the table is of the first.

**What 64-bit only costs.** A phone that can only run 32-bit code cannot install
this, and sideloading has no Play filter, so it says only "App not installed",
with no reason. Anyone already on 1.0.1 with such a phone cannot update either.

**What R8 risks, and what was checked.** R8 rewrites and strips bytecode, and the
classic React Native failure is a module resolved by reflection at startup that
is no longer there. The minified APK was installed on the Pixel 6 Pro and
exercised: a cold start with no crash in `logcat -b crash`, the picker, the
editor, Share, Save to Photos and Copy image. That covers the modules this app
reaches. It does not prove every path R8 touched; a crash in a path not
exercised there would show on first use.

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

Three decisions worth stating:

- **From 1.0.4 the app downloads the update itself, and opens the installer.**
  Until 1.0.3 it handed the URL to the browser and stopped. On the owner's Pixel
  Chrome fetched every byte of the 1.0.3 APK and then left it as a `.pending-`
  file at 100%, never openable. So `modules/twitwa-updater` fetches it, keeps it
  only if its sha256 is the one `latest.json` names, hashes it again, and hands it
  to Android's installer. The cost is `REQUEST_INSTALL_PACKAGES`: the first time,
  Android asks to allow "Install unknown apps" for Twitwa. The owner chose that
  on 2026-09-23. Android's package manager still does the signature check; an
  APK signed by another key is refused by the OS, not by code written here. A
  build without the module, or a manifest without a sha256, falls back to the
  browser.
- **The download URL is confined to one literal prefix.**
  `https://github.com/B-ismark/Twitwa/releases/download/`. A full URL's authority
  ends at the first `/` after `//`, and that slash is inside the prefix, so one
  string comparison pins scheme, host and the first three path segments. The
  manifest arrives over the network; without this it would be a way to get
  someone to install an arbitrary APK under Twitwa's own prompt. Fourteen hostile
  URLs are enumerated individually in `src/update.test.mjs`, because a single
  "rejects a bad URL" check would pass while thirteen still got through.
- **The check is the app's one unasked network call, and that has a cost.** One
  HTTPS GET to `raw.githubusercontent.com`, no identifier, no query string. (The
  download happens only when the person taps Get it.) But
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

`versionCode` is `2` as of 1.0.1, and is set explicitly in `app.json`. Expo's own default is
`config.android?.versionCode ?? 1`, rewritten on every prebuild, so leaving it
implicit meant it could never move: two materially different APKs would have
been indistinguishable to Android and to whoever was holding one. **Bump it for
every build handed to anyone.**

### The update path, end to end, on the phone

Publishing 1.0.1 made the whole path exercisable for the first time, against a
real release on a real phone holding a real older build. Every step below is an
observation, not an inference:

| Step | What was observed |
| --- | --- |
| The throttle holds | A launch with the day's check already done logged `"action":"skipped"` |
| The check fires | After clearing it: `P0.updateCheck {"action":"update","installed":1,"latest":2}` |
| The banner renders | Title, the manifest's `notes`, and both buttons, in a screenshot |
| "Get it" opens | `P0.update {"opened":true,"url":".../v1.0.1/twitwa-1.0.1.apk"}`, focus moves to Chrome's `CustomTabActivity` |
| The download works | Chrome: `twitwa-1.0.1.apk`, 32.89 MB of 32.89 MB |

Two things are worth keeping from the run.

**The throttle got in the way of testing the throttle, which is how you know it
works.** The first launch after publishing answered `skipped`, correctly, because
the day's check had already happened. There is no force path in the app and a
release build is not debuggable, so `run-as` cannot reach the state file:
`adb shell pm clear` is the only way to re-arm it. Worth knowing before the next
person spends an hour on it — and worth noting that the same absence would stop
a user checking on demand, which is an argument for a manual check button in
Phase 4 rather than a defect now.

**`release/latest.json` moves after the release, never before.** It is stated in
`release/README.md`; what publishing proved is the cost of the other order. Every
installed copy reads that file on launch, so a manifest naming a release that
does not exist yet sends all of them to a 404 — and the app cannot tell that
apart from a download the user cancelled.
