# Improvement plan — evaluation of 2026-11-25

Android only. Each phase is one branch commit with its own gates, so they can be
done, reviewed and released one at a time. Paths are under `spike/`.

**Gates for every phase:** `node src/*.test.mjs`, all `BREAK=` mutants in the
touched suites (each must exit 1), `tools/check-copy`, `check-dead`,
`check-imports`, `check-call-arity`, `check-style-members`, `check-fs-sync`.
Every new word goes in `src/copy.js`, and every decision goes in a pure module
with a test, not in `App.js`.

**Who does what (to save tokens):** Opus designs each phase and does the
adversarial review. Sonnet writes the code from the spec below. Haiku does
mechanical work: running the gates and mutant loops, bumping counts in the
README, and generating icon PNGs from SVG.

## Done
- **P0 · Colour.** Edges now vote on the card colour, and the colour snaps to the exact background pixel
  (`src/pixels.js` `decideCropBackground`, `modalOf`). Six new tests and four new mutants.
- **P0 · Save twice.** Saving an unchanged card again now asks first (`shell.alreadySaved`), and a ref
  guards Share, Save and Copy against double taps.
- **P1 · Opening and closing.** Importing state and fade-in, session restore (`src/session.js`,
  only unfinished cards come back), `fontScale|density` in `configChanges` (`plugins/withConfigChanges.js`),
  a Close control plus Back giving up on a stuck export after 15s, and a "1 waiting" chip for a share
  that arrives mid-edit. Multi-image queueing moved to P6.5 and is done there.
- **P4 · Performance (1, 2, 4, 5).** Export reuses the editor's picture and its colour sample (only for the
  exact crop it was read from), the dev log stops re-rendering in release, scroll captures past 4096px get a
  2048px on-screen copy (the card layer drops back to the full picture whenever the copy would be soft), and
  `tools/coldstart.sh` times cold start. Decisions in `src/perf.js`. Item 3 (Kotlin pixels) is built and waits for a device.
- **P5 · Size (settings).** Measured 1.0.6 (19.1 MB): the Hermes bundle shipped Stored. `withAndroidSize` now
  compresses it, keeps English resources only, turns on shrinkResources, drops WebP and Fresco's JPEG
  transcoder. Expected about 16.8 MB, unbuilt. Replacing media-library/clipboard/sharing with our own Kotlin
  is deferred with P4.3: small dex saving, and it rewrites Share/Save/Copy without a phone to test on.
- **P6 · Features 1–4.** Remembered style (`src/prefs.js`, documents/prefs.json), six curated tones (Sky, Mint,
  Sand, Plum, Slate, Midnight), a remembered "Save as JPEG" switch (`src/format.js`; Copy stays PNG), and
  "Saved to Photos" with View (`src/saved.js`). Item 5, one card per image, is done below.

## P1 · Opening and closing (the flow problems) — done, spec kept for reference
1. **Importing state.** Add `importing` (a ref plus state) in `openImage`/`receive`, show a skeleton card
   with a spinner over the empty state, disable Choose, and fade the card in (`raw`
   from 0 to 1 with `withTiming`). The cold-share flash of the empty screen goes.
2. **Session restore.** Add a new pure module, `src/session.js`, that serialises `{uri, crop, padding,
   background}` and validates it on read. Write it to `cache/session.json` on each commit (crop
   done, style change, after export), using expo-file-system `File` (async). On launch with no
   share, if the file and its `uri` still exist, open them and show the notice
   "Picked up where you left off". Clear it on Discard or New. Allow restored shares
   (`withShareInRestore` keeps its dedupe, and session.json covers the rest).
3. **Font or display-size change.** In a config plugin, add `fontScale|density|uiMode` to MainActivity's
   `configChanges`, so the activity is not recreated and the picker launcher survives. Keep
   `recover.js` for anything else.
4. **Close, and a way out.** Add an explicit Close (X) at the top-left of the editor. It asks when the
   card is unsaved, and returns to the empty state. "New screenshot" stays in More. Back
   during `busy` cancels the wait after 15s, and the export reports `renderFailed`.
5. **Warm share while editing.** The dialog's "Keep editing" keeps the shared file in
   `cache/shared-in`, and a "1 waiting" chip opens it later. Multi-image share
   queues the rest (a chip with N waiting) rather than dropping them.

## P2 · A layout that stays still — done
1. Turn the update banner, the More menu and the Style strip into **overlays/bottom sheets**
   (absolute, over the stage), so the stage's size never changes. Give the caption a fixed one-line slot
   (`numberOfLines={2}` and a fixed height) and send errors to a toast.
2. **Edge-to-edge:** add `react-native-safe-area-context` (already in the Expo SDK) to replace
   `paddingTop: 44` and the bottom padding, and set `StatusBar`/nav-bar styles per scheme.
3. **Style as a sheet:** padding chips plus the slider, and the background as swatches (Match / Paper / Ink and,
   later, Custom). Done is a text button, not a filled chip, so Share stays the only
   primary.
4. **Slider:** drive it with a shared value and commit on release, like the crop. Add
   `onAccessibilityAction` for TalkBack.
5. **Crop:** inset the handles 24dp from the screen edges, away from the back-swipe zone. Cancel asks
   when changed (the same rule as Back), and pinch-zoom comes later.

## P3 · Identity — done
1. **Icon:** whichever concept the owner picks from the concept page. Produce the adaptive foreground
   and background plus a monochrome layer at 432px, and replace `assets/*icon*` and `#E6F4FE` in `app.json`.
2. **Splash:** `expo-splash-screen` plugin, using the icon on Ink (dark) and on Paper (light), with
   `imageWidth` 120.
3. **Icons in the app:** `lucide-react-native` plus `react-native-svg` (about 150KB). Add icons to
   Share, Save, Copy, Crop, Style, More and Close, keeping the labels on Share and Save.
4. **Empty state:** the wordmark, a large tappable "Choose a screenshot" panel with the mark, and a
   line saying you can also Share into Twitwa from any app.

## P4 · Performance (no change to output quality) — 1, 2, 4, 5 done; 3 built, waits for a device
1. **Reuse the loaded image when exporting:** `build()` passes `src.img` and the `sampled` result into
   `renderCard`, so the file isn't decoded twice and the colour isn't sampled twice. Add one test to the pipeline's pure
   part to prove the preview and the export use the same fill.
2. **Turn off the test-panel logging in release:** make `emit` a no-op for state when `!__DEV__ && !devOpen` (logcat
   only). That removes a full re-render per event.
3. **Native encode (built, uncompiled, awaiting the device pass):** `modules/twitwa-pixels` (Kotlin) takes the
   finished card's RGBA pixels, builds an sRGB Bitmap, and compresses it to PNG or JPEG on `Dispatchers.IO`
   into a temp file that is renamed over the target, so the export no longer holds the JS thread for the
   length of the deflate. `src/encoder.js` decides when it is used (only with the module present, only for
   sRGB, only png/jpeg; a Display P3 card stays on Skia, which embeds the profile) and `src/pipeline.js`
   falls back to the old Skia encode and write on any rejection, recording `encoder` and `encoderFallback`
   in the timings. The dev panel's "Encoder parity" renders a card both ways and compares decoded pixels,
   file sizes and iCCP/sRGB chunks. Region reads (`BitmapRegionDecoder`) were dropped: the editor decodes
   the whole image in Skia to show it anyway, so a second decoder would add orientation and colour-space
   parity risk for no memory win. Needs the device pass in `release/checklist-1.0.7.md`.
4. **Downsampled preview image** (longest side 2048) for captures past 4096px. Export still uses
   full resolution.
5. **Measure cold start** before and after: `adb shell am start -W`.

## P5 · Size — settings done; Kotlin replacements wait for a device
1. Measure first: `unzip -v app-release.apk 'lib/*'` to get the real size of each native library.
2. Exclude the Fresco native libraries, replace `expo-media-library`, `expo-clipboard` and `expo-sharing` with
   three functions in our own Kotlin module, and turn on `shrinkResources` with `resConfigs "en"`.
   Expected result: about 18.4 MB.
3. **Decision for the owner:** if the app stays Android-only for good, the only path to a much smaller
   app is a native Kotlin/Compose rebuild, at **2–5 MB**. The pure JS rules port to Kotlin with their
   tests. Recommended as v2, after P1–P4 settle the design.

## P6 · Features not yet built
1. Remembered settings (padding and background), via the session file from P1.
2. Custom background swatches, as one row in the Style sheet.
3. JPEG export option for chat apps (quality 92). PNG stays the default.
4. A "Saved to Photos" toast with a View action (open the MediaStore URI).
5. ~~One card per image for multi-image shares (builds on the P1 queue).~~ **Done, unbuilt.** The native
   module copies up to 10 images (`take(keep)` keeps the card on screen and the queue); `src/queue.js` holds the
   queue (cap 10, overflow counted as skipped), `src/sharein.js` plans arrivals and advances. The "N waiting"
   chip opens the next; Close and Discard open the next queued image instead of the empty state; Back always returns to the start screen, where the chip still shows the queue. The
   Kotlin is uncompiled and untested on a device, and the queue is not restored after a process death.

## Release
For each phase, an adversarial review of the diff, then the gates, then bump `versionCode`/`version`,
then a signed APK and `tools/verify-apk.sh`, then `latest.json`. Re-derive the README totals by
running every check, not by adding to the old numbers.
