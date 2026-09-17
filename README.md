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

## State

Decided: screenshot input; Cover tool with a flat sampled fill; card background
sampled from the crop's edges with a Paper/Ink fallback; no aspect presets (the crop
*is* the aspect); PNG **width-bounded** at `min(1080, crop + padding)` with height
following the crop; sRGB SDR output; Library keeps an app-owned **copy** of the
source plus crop rect and mask boxes, so cards stay re-editable whatever happens in
Photos; link input deferred to the appendix.

Distribution is personal sideload. That settles store policy and the platform
display requirements — neither is engaged by an app that reads pixels the user
already had — and settles nothing about the rights in someone else's post. Those are
three questions and an earlier draft of this file answered all three with the first
one's answer.

Started: `spike/`. An Expo SDK 57 project holding the Phase 0 spike.

| File | What it is |
| --- | --- |
| `src/pixels.js` | All the pixel math. Ring flatness, modal background, row ink profile, status-bar cut and shape test, four-edge card background, colour round-trip delta. No Skia — none of it needs Skia to be correct |
| `src/sizing.js` | Output size: width-bounded, never upscaling, no long-edge cap, encode ceiling |
| `src/pipeline.js` | The whole pipeline as one `renderCard()` call. **Run on device** — three times now, most recently byte-identically after the ring read was rewritten; see `spike/results/phase1-pipeline.md` |
| `src/plan.js` | The decision layer: final crop (status-bar trim), output size, frame colour. No Skia. Its `planCard` takes the background sampler as a *callback*, so the background cannot be sampled from the pre-trim rect |
| `src/measure.js` | Every Skia call, with timings. **Run on device** — see `results/phase0-device.md` |
| `App.js` | The spike screen: one button per Phase 0 question, plus two that run the Phase 1 pipeline and draw the written card back off disk |
| `tools/png.mjs` | PNG decoder built on node's `zlib`, no dependency |
| `tools/probe.mjs` | Answers Q1, Q3 and the card background from a PNG on disk |
| `tools/make-fixture.mjs` | Synthetic screenshot with known band positions |
| `tools/make-tall.mjs` | Tall synthetic PNGs for the Q5 ramp; 82MiB-as-RGBA costs 0.14MiB on disk |
| `tools/check-imports.mjs` | Verifies named imports between our own modules exist; `expo export` resolves modules but not named exports. Prints whether each module was loaded or source-parsed, because the Skia-importing ones cannot be loaded in node |
| `tools/chunks.mjs` | Reads a PNG's chunk table and any embedded ICC profile, and names the colour space **by its primaries** — the profile's name cannot, since Skia names both of the ones it writes "Skia". For the Display P3 question, which only the bytes can answer |
| `tools/capture.mjs` | Drains the device's `PHASE0` log lines into `results/phase0-device-raw.txt`; exits 1 rather than write an empty capture |
| `fixtures/screenshots/` | The four real captures every measured number rests on |

**Phase 1: run on the device.** `src/pipeline.js` assembles the whole path —
decode, orientation, status bar, crop, sample, compose, encode, write — with every
decision delegated to `plan.js`/`sizing.js`/`pixels.js`, which is why those carry
323 checks and 57 mutations between them while the renderer carries none
(390 checks and 70 mutations counting the two PNG tools).

`renderCard()` was run twice on a Pixel 6 Pro against a real 1440x3120 capture
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
cd spike && node src/sizing.test.mjs     # 56 checks on the output sizing
cd spike && node src/plan.test.mjs       # 99 checks on the decision layer
cd spike && node tools/check-imports.mjs # 41 imports + 6 self-checks on its own rule
cd spike && node tools/png.test.mjs      # 16 checks on the PNG decoder
cd spike && node tools/chunks.test.mjs   # 51 checks on the PNG chunk/ICC reader
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
for t in src/pixels.test.mjs src/plan.test.mjs src/sizing.test.mjs \
         tools/chunks.test.mjs tools/png.test.mjs; do
  for b in $(grep -o "BREAK === '[a-z_0-9]*'" "$t" | sed "s/.*'\\(.*\\)'/\\1/" | sort -u); do
    BREAK=$b node "$t" >/dev/null 2>&1; [ $? = 1 ] || echo "NOT RED: $t $b"
  done
done                                     # silence is the pass; 70 mutations
```

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
python -c "import tarfile;tarfile.open('fixtures/og-pages.tar.gz').extractall('fixtures/pages')"
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
installed on the Pixel 6 Pro as `dev.bismark.twitwaspike`. Gradle also pulled in
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
to the main activity and in a dev client that is the launcher. Registration is
verified; delivery needs a release-style build. See `spike/results/phase0-device.md`.

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

**The device is `21241FDEE0019C`** (Pixel 6 Pro, density override 476). It is
authorized and has carried every device run since Phase 0; this paragraph used to
say it read `unauthorized` and needed the "Allow USB debugging" prompt, which was
true on the first attempt only. If a fresh checkout does read `unauthorized`, that
prompt is still the answer, and the full steps are in `spike/PHASE0.md`. Two things
the phone needs from its owner and no flag can supply: it must be **unlocked**
(a secure fingerprint lock sends every tap to the keyguard) and its screen must be
**on** — `dumpsys power` reporting `mWakefulness=Dozing` looks exactly like a
hung app from the shell.
