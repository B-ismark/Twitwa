# Build plan

*September 16, 2026. Reads against `social-card-renderer.md` — that doc holds the
decisions and the measured evidence; this one holds the order of work.*

## What we are building

Share a screenshot in, drag a crop, optionally cover leftover chrome, get a padded
PNG on a background matched to the screenshot. No network in v1.

## The one thing that could kill it

The Cover tool. A crop cannot exclude the like count that sits between an Instagram
image and its caption, so Cover is what makes the app meet its own problem
statement. It fills a dragged box with the colour sampled from just outside that
box, which is seamless **only if** social backgrounds are as flat as they look.

**Answered, 2026-09-16: they are.** Four real captures, 58 Cover target rows,
nothing above 2.09/255 and 50 of 58 below 1 — including pure-white Facebook chrome
at 0.38, which closes the light-mode gap. Details in
`spike/results/phase0-q1-q3.md`.

It turned out to be verifiable from a terminal after all — Q1 and Q3 are pure
pixel math, and only Skia speed, the colour round trip and the memory ceiling
need a device. The assumption that they all needed hardware cost nothing here, but
it is the reason this was nearly deferred behind a Gradle build.

The condition it came with: the fill must be the ring's **modal** colour. A mean
is dragged by text caught in the sampling ring and produced a mid-grey fill on a
pure-black background.

---

## Dependencies — and what got cut

The instinct with Skia is that it is heavy, so avoid it. That is backwards here.
Skia does the pixel sampling for background matching, the crop, the mask fill, the
composition, and the PNG encode — **one dependency replacing four**:

| Cut | Why |
| --- | --- |
| `react-native-view-shot` | Skia's `makeImageSnapshot()` covers export |
| `expo-image-manipulator` | Skia draws a sub-rect; that is the crop |
| `nativewind` | For four screens and five tokens, a typed `theme.ts` enforces the palette *better* — a wrong token is a TypeScript error, a wrong class name is silent. Also removes a babel/metro config surface |
| `expo-blur` / any blur lib | Design decision already taken: opaque islands |
| a bundled font | The card draws no app text, only the user's pixels |

Final list — nine, three of them Expo-bundled:

```
expo
react-native-gesture-handler      crop + mask gestures
react-native-reanimated           gesture values on the UI thread, the one morph
@shopify/react-native-skia        sample, crop, mask, compose, encode
expo-image-picker                 pick a screenshot
expo-media-library                save via MediaStore
expo-sharing                      share sheet / WhatsApp
expo-linear-gradient              the nav fade
react-native-svg + lucide-react-native   icons
```

**Correction.** An earlier draft of this plan said Skia needs a custom dev client
and cannot run in Expo Go. That is wrong: the SDK 57 docs list
`@shopify/react-native-skia` as `inExpoGo: true`, so the spike's imaging work could
run in Expo Go.

A development build is still required, for a different reason — the incoming-share
intent filter. `ACTION_SEND` / `ACTION_SEND_MULTIPLE` are native manifest entries,
and Expo Go cannot register them under this app's identity. So the conclusion holds
and the justification does not, which is worth recording because the wrong reason
would have sent someone looking in the wrong place.

Pin the Expo SDK and resolve every native package through `npx expo install`, not by
hand.

---

## Aesthetic direction

"Minimal" as a set of constraints, not an adjective:

**The screenshot supplies all the colour.** The app is near-monochrome — Paper/Ink,
Graphite, Hairline. Signal appears in at most two places on any screen. Nothing in
the chrome competes with the image.

**The crop surface is the hero.** Full-bleed screenshot. Outside the crop is dimmed
to roughly 55% of the app background — soft, so it reads "inactive" rather than
"masked out". Not a black scrim.

**Corner brackets, not a rectangle.** Four corner marks plus edge midpoints, 2px,
white core with a thin dark outline. This is not decoration: the token table
guarantees Signal against Paper and Ink, but crop handles sit over *arbitrary
screenshot pixels*, and a blue handle over a blue image is invisible. Brackets also
read as photographic and add less visual noise than a full border.

**Show the result, not the rect.** Padding is the product, so the preview shows the
composed card on its sampled background — not a crop outline in isolation. Crop mode
while dragging, result mode on release.

**Three stops, not a slider.** Snug / Standard / Roomy as a small segmented pill.
Decisive defaults beat fiddling, and it is one gesture instead of a continuous one.

**Two radii, one shadow, one motion.** Pill for chrome, 14px for the card. The only
shadow in the app is under the nav pill. The only animation is Save morphing into
the export sheet — gestures track the finger 1:1 with no easing theatrics.

**Two type sizes, two weights.** System font. Empty states are one line of Graphite,
centred, no illustration.

---

## Phase 0 — de-risk, throwaway spike

One screen, no nav, no design. **Five** questions, not four — the memory ceiling
(5) was added after the first draft and is the only one with no pass condition,
because it is meant to fail and the number wanted is where. Do not start Phase 1
until these are known.

**The dev client builds and is installed** — `dev.bismark.twitwaspike` on a Pixel
6 Pro, after five attempts and four distinct causes (see `README.md`). The
package was renamed to `dev.bismark.twitwa` on 2026-09-18, once it was clear that
a name recorded as a build fix was about to become permanent; this line records
what was installed at the time. Q2, Q4 and
Q5 are now blocked only on driving the app, not on tooling.

1. ~~**Does the sampled fill look seamless?**~~ **Measured and passing** over 58
   target rows in four captures, dark and light — see
   `spike/results/phase0-q1-q3.md`. Remaining: the eye check on a display, and a
   gradient header, which nobody has been able to find.
2. ~~**Is Skia fast enough?**~~ **Measured and passing.** 375ms total for a
   5.31MP output, against a ~400ms target — but the shape of that number is the
   finding: **92.5% of it is `encodeToBytes(PNG)`** (347ms of 375ms). The Skia
   composition this phase existed to de-risk costs 28ms. Scaling is roughly
   50-60ms per megapixel with ±10% run-to-run noise. See
   `spike/results/phase0-device.md`. Nothing in the drawing path is worth
   optimising; if this ever needs to be faster, it is the PNG encoder or nothing.

   Read **sub-rects, not whole images**. Ring statistics need the pixels around one
   box and the status-bar profile needs the top few hundred rows; neither needs the
   full buffer, and a full `readPixels` is where the memory ceiling in (5) gets hit
   for no benefit.
5. ~~**Does a very tall screenshot survive at all?**~~ **Measured, and the
   ceiling is not where this plan put it.** A full RGBA `readPixels` never failed:
   1080×20000 — the stated worst case, 82.4MiB — read in under 100ms, as did
   every step of a 33/49/66/82 MiB ramp. Memory is not the constraint.

   The real ceiling is **`Skia.Surface.MakeOffscreen`, and it returns `null`
   rather than throwing**: 1208×16256 composes, 1208×16384 does not. Caller code
   that assumes a surface gets a null dereference somewhere unrelated, so the
   check is not optional.

   Consequences for the spec's provisional numbers: `MAX_H = 8000` survives with
   2x headroom and does real work. **`MAX_PX = 10e6` cannot fire**: `cardSize`
   bounds width by `TARGET_W = 1080` and height by `MAX_H`, so its largest output
   is 8.64MP and the pixel disjunct is dead code. It was justified twice before
   anyone checked that — first as a memory limit (wrong: a 19.64MP surface encoded
   fine) and then as a time limit (sound reasoning about an unreachable branch).
   The 19.64MP figure came from `src/measure.js`, which pads without scaling; no
   input through `cardSize` reaches it. Kept as the guard that would matter if
   either constant grew, with the slack asserted in `src/sizing.test.mjs`.
3. ~~**Does status-bar detection generalise?**~~ **Answered both directions.** The
   first heuristic confidently cut the author's byline on two captures whose status
   bar had already been cropped away. With a shape test over five horizontal zones
   — glyphs at both outer edges, empty middle, thin band — real status bars are
   accepted (row 89, 2.85% of height) and headers rejected. Remaining: the one skin
   tested is **stock Android on a Pixel 6 Pro**; One UI and the rest are untested,
   and captures 3 and 4 give byte-identical zone figures because they are the same
   status bar, so that is one sample and not two.
4. ~~**Does Display P3 survive the Skia encode?**~~ **Pixel values: yes,
   exactly.** `maxDelta 0, meanDelta 0` over 120,000 samples, on both sRGB and
   Display P3 offscreen surfaces, at four output sizes. Encode → decode changes
   nothing.

   **Still open, and it is the half that matters:** identical pixel values do not
   prove the P3 *tag* reaches the file. P3 pixels in a PNG with no colour chunk
   are shown as sRGB — a silent shift, which is what this question was really
   about. The P3 encode ran 1.3KiB larger than the sRGB one, which is the right
   order for an ICC profile, so a chunk is probably being written. Confirming it
   needs the bytes inspected for `iCCP`/`cHRM`/`sRGB`, and the spike writes no
   file.

**Exit criteria.** If (1) fails, stop — the premise does not hold and the link-input
appendix becomes the product rather than a v2. If (3) fails, fall back to the
fixed-fraction default. (2), (4) and (5) change implementation, not direction — but
(5) sets real numbers where the spec currently has placeholders, so it is not
optional.

**Status: all five have measured answers; none of them says stop.** What is left
is not a measurement but a judgement — Q1's verdict on a real display, which no
number in `spike/results/` can settle. Phase 1 is unblocked.

## Phase 1 — the pipeline, headless

No gestures. Hardcoded crop rect. Get the output correct before anything is
interactive.

- Load → crop to rect → sample edges → compose with padding → encode PNG.
  **Written as `src/pipeline.js`'s `renderCard()` and run on the device** —
  1080x2146 out, 550ms, geometry checked against the decoded pixels; see
  `spike/results/phase1-pipeline.md`
- The ordering is enforced in code, not documented: `src/plan.js` exposes
  `planCard`, which takes the edge sampler as a **callback** so there is no way to
  sample the background from the pre-trim rect and then throw those rows away
- Cover boxes are clamped to the crop in pure code and clipped in Skia as
  defence; each box is filled with the modal colour of its **own** ring, not the
  card background
- EXIF orientation is baked in **before** planning, because applying it at draw
  time also moves the destination rect and leaves a 90-degree rotation sized for
  the wrong aspect
- Edge sampling with the four-edge agreement test, Paper/Ink fallback by luminance
- **Never upscale**: width is `min(1080, crop_width + 2 × padding)`; height follows
  the crop, with no long-edge cap — see the output spec for why that cap was removed
- Padding is a fraction of crop width (3 / 6 / 10%), floored at 12px. **Not**
  rounded to an even number — that was cargo cult. Symmetry comes from adding
  one `pad` value twice, whatever its parity; the real hazard is scaling the
  crop independently of the padding, so `dest` is derived by subtraction
- Convert to sRGB SDR deliberately: gamut-map P3, tone-map HDR. **Not done, and
  the measured behaviour is the opposite**: `renderCard` passes `colorSpace`
  straight to the surface, so a `DisplayP3` request produces a P3 card with a P3
  `iCCP`, and the default produces an **untagged** one. Nothing gamut-maps, and
  nothing writes an sRGB profile
- Downscale at decode above the pixel ceiling rather than failing
- Register the share target now — `ACTION_SEND` *and* `ACTION_SEND_MULTIPLE` for
  `image/*` — so every later phase is tested through the real front door rather than
  the picker
- EXIF orientation honoured at decode

**Verification.** Same source screenshot on two devices of different density must
produce the **same dimensions**, and decoded pixels equal within a small tolerance.
Not byte-identical files: PNG encoders differ by version in filtering and chunk
order, so a byte comparison would fail on a correct result and send someone hunting
a bug in the wrong layer. Byte-identity is only worth asserting if deterministic
encoding is separately proven.

**Done, with one device and a density override** (`adb shell wm density`, at 320 /
476 / 640): the card is byte-identical across a 2x range. Byte-identity is
available here *because* it is one device and therefore one encoder — the caveat
above still governs a real second device. Not evidence about another GPU, Skia
build or Android skin. The masked path is density-**dependent** by construction and
measured to be; see `spike/results/phase1-pipeline.md`.

Then send one through WhatsApp and look at what arrives. The sizing rules were
chosen against WhatsApp's recompression and have never been checked against it.
**Left open deliberately** — no phone-plus-WhatsApp is available for this work.
`spike/results/phase1-pipeline.md` records what the absence costs (no
WhatsApp-derived constant exists in `sizing.js`, so the exposure is one number)
and the exact steps that would close it.

## What comparable apps do — surveyed 2026-09-18

Twenty-four shipped surfaces were read before writing Phase 2 and Phase 3: ten
crop screens and eight redaction screens on Mobbin, six canvas and background
editors, plus the Android crop libraries and the screenshot-beautifier category
on the web. This section is the evidence those two phases are written against,
so that the next person does not re-derive it. Sources are named inline; the
Mobbin screens are iOS, which is the survey's main limitation and is recorded
at the bottom.

### Seven things that are in every crop surface

1. **Outside the frame is dimmed or black.** Reddit, Google Photos, Apple
   Photos, X, eBay, Unfold, Yazio, Binance — all of them. The crop is the only
   lit region, so "what you keep" needs no label and no hint text. Twitwa draws
   its box on a fully lit image, which is why the box reads as a sticker rather
   than a frame.
2. **Corner brackets mean a frame; eight dots mean an object.** Apple Photos
   uses brackets in Crop and eight dots plus a floating toolbar in Markup. Same
   app, two vocabularies, and the line between them is exactly the line the
   owner drew: brackets for the frame the whole image sits inside, dots for a
   thing sitting on top of it. VSCO and Freeform agree on the dots. This is a
   free way to make Crop and Cover unmistakable without a word of copy.
3. **The grid appears on touch, not at rest.** X and Binance show rule-of-thirds
   during a drag; Reddit, Google Photos and Apple Photos show brackets only when
   idle. uCrop and Android-Image-Cropper both name "show on touch" as an option,
   which is what a convention looks like once it has reached a library's API.
4. **An aspect row.** `Original / Freeform / Square / 9:16 / 4:5` (Reddit),
   `Free / 9:16 / 2:3 / 3:4 / 4:5 / 1:1 / 5:4` (Unfold), a dropdown in Google
   Photos, an icon row in X. Universal.
5. **Auto-detect is a first-class button, not a setting.** Google Photos
   "Auto Frame", Apple Photos "AUTO", Alan "Detect", Apple Notes' automatic
   quadrilateral. See below: this is the one thing Twitwa can do better than a
   general photo cropper.
6. **A loupe at the dragged corner.** Apple Notes and Alan both float a
   magnifier where the finger is, because the finger covers the pixel being
   aligned. At a 1080-wide screenshot in a roughly 400pt stage, one screen pixel
   is about six image pixels, so trimming a status bar by eye is not something a
   person can do. Either a loupe or a pinch-zoom is required; the loupe is
   cheaper and does not touch the coordinate model.
7. **Cancel, reset, done — three controls, not one.** Google Photos is
   `X / Crop / check`; Reddit is `Cancel / revert / Save`. There is always a way
   back to the original that is not "start over".

### Crop and redaction are never the same surface

LINE lists them as sibling rows in one menu: "Crop and rotate", "Pixelate and
blur". Apple Photos puts Crop on a tab and Markup behind a different entry
point. Telegram gives blur its own mode row — Off, Radial, Linear — with a
strength slider. Nothing surveyed asks one rectangle to do both jobs.

And the redaction model is consistently **objects, not "the box"**: drag to add,
tap to select, a floating toolbar or a trash icon to remove. Apple Photos
Markup, VSCO, Freeform and Obsidian all show the same selected-object chrome.
Google Photos and CapCut go further, to a brush with a size slider, which is the
right shape for an irregular region and the wrong shape for a handle or a face.
Phase 3's "multiple boxes" is the settled answer in this category, not a
refinement of ours.

### The frame moves; the image does not

Two models exist and they are not interchangeable:

  - **Fixed frame, image pans and zooms underneath.** Avatar pickers. Correct
    when the aspect is locked and the subject is a face.
  - **Frame moves over a fixed, contain-fitted image.** Reddit, Google Photos,
    eBay, X. Correct when the aspect is free and the user is trimming chrome.

`src/crop.js` already implements the second, and the second is right for
screenshots. That decision does not need revisiting. What it is missing is
listed further down.

### The category around us, and what to take from it

Beyond the crop surface, the screenshot-to-shareable-image category has settled
on a fairly short feature list. Read against Twitwa:

| What they do | Who | Verdict |
| --- | --- | --- |
| Auto-trim the phone chrome: status bar, nav bar, compose bar | Picsew "clean the status bar", Xnapper "auto balance" | **Take.** Phase 2 already promises the status-bar band; generalise it |
| Auto-redact detected sensitive text | Xnapper, on Apple's Vision OCR | **Take, as Phase 3's other half.** Feasibility note below |
| Background: solid, gradient, or sampled from the image | Pika, Xnapper, PostSpark, Photoroom | **Have it.** Sampled is already the product |
| Padding or inset control | Pika, Xnapper, Photoroom "Resize" | **Have it.** `PADDING` snug/standard/roomy in `src/sizing.js` |
| Corner radius and drop shadow on the inner image | Pika, PostSpark, Photoroom "Shadows" | **Later.** Cheap in Skia, and the single biggest "looks designed" lever |
| Aspect presets named by destination rather than by ratio | Pika social sizes, TweetPik | **Later**, and name them by destination |
| Device or browser frames around the shot | Picsew, Pika, PostSpark | **Skip.** The input is already a phone screenshot; framing a phone inside a phone is noise |
| Stitch several screenshots into one long image | Picsew, Tailor, LongShot (Android, free, no watermark) | **Skip for v1.** A different product, and LongShot already owns it on Android |
| Text, stickers, arrows, annotation | PostSpark, Photoroom, Apple Markup | **Skip.** Against the stated no-chrome principle |
| Watermark | most of the paid ones | **Skip.** Explicitly against the product |
| Copy to clipboard beside Share | Xnapper, Pika | **Take.** One control, and it is how a card reaches a desktop chat |
| Remembered settings, so the second card costs one tap | Pika presets, Xnapper defaults | **Take later.** The whole pitch is speed |

### Auto-propose the crop — the thing only we can do well

Twitwa already samples the screenshot's background colour. The same scan finds
the horizontal bands that are *pure* background and touch both edges: the status
bar, the navigation bar, the compose bar, the tab bar. A general photo cropper
cannot assume any of that. We can, because the input is known to be a
screenshot, and the assumption is cheap to be wrong about — the proposal is a
starting rect the user drags, not a decision the user has to undo.

That turns Phase 2's "status bar pre-trimmed, shown as an excluded band that can
be dragged back in" from a special case into the general mechanism, and it gives
the surface the auto-detect button every surveyed app has.

The same machinery serves Phase 3. On-device OCR with word-level bounding boxes
is reachable from this stack — ML Kit Text Recognition v2 on Android, wrapped by
`expo-mlkit-ocr` among others — which would let Cover propose boxes over a
handle or an @mention the way Xnapper proposes them over an email address. That
is a native module and a model download, so it is a real dependency decision and
not a Phase 3 given. It is recorded here as the known route, not as a
commitment.

### What `src/crop.js` is missing against the list above

| Missing | Consequence |
| --- | --- |
| No `aspect` parameter on `dragCrop` or `normalizeCrop` | Blocks the aspect row entirely |
| No user zoom: `fitView` derives scale from the viewport alone | Six image pixels per screen pixel, so precise trimming is not possible |
| No reset-to-original | Every surveyed app has one |
| `TOUCH = 44` | That is the **iOS** floor. Material's minimum touch target is **48dp**, and this is an Android-first app |

### What this survey did not establish

- **Every Mobbin screen read was iOS.** The Android conventions came from
  library documentation (uCrop, Android-Image-Cropper) rather than from shipped
  Android surfaces, because the search tool available here covers iOS and web
  only.
- **Nothing here has been on the phone.** It is a survey of other people's
  decisions, not a measurement of ours.
- **The 48dp figure is Material's published floor**, not something measured
  against Twitwa's stage.
- **WhatsApp's recompression is still unmeasured.** Secondary sources say the
  long edge is capped near 1600px, and that PNG is re-encoded to JPEG on the
  photo path while the document path is lossless. `src/sizing.js` deliberately
  rejected a 1600px long-edge cap, with its reasoning in the header, so these
  claims bear on a decision already taken on other grounds. Settling it needs a
  real send to a real device, which is the only way it can be settled.

## Phase 2 — the crop gesture

**NEXT, and the owner said why on 2026-09-18: the app has no crop at all.** What
shipped in Phase 4 is the Cover mask, and it is standing in for two different
features it is bad at. A person opening Twitwa expects to crop a screenshot the
way every other app on the phone crops one -- drag the frame, pull a corner,
keep what is inside. Instead they get a single rectangle that hides what is
under it. The two are not substitutes, and neither is optional:

  - **Crop** chooses what the card is. Standard, familiar, direct manipulation.
  - **Cover** hides things inside that choice, and there is usually more than
    one thing to hide -- a handle here, a face there. One box cannot do it.

So Phase 2 delivers the real crop surface, and Phase 3's multiple boxes stop
being a refinement and become the rest of the answer. Until both land, the
single Cover box should be understood as a placeholder that the owner has
already called out as the wrong shape.

The list below is what the survey above says a crop surface is. Items marked
NEW came out of that survey and were not in the original plan.

- Pan and resize from corners and edge midpoints, gesture-handler + reanimated,
  worklets so it runs off the JS thread
- Minimum crop clamped at ~120px on the short edge — clamp the gesture, do not error
- Corner brackets per the aesthetic notes, and **NEW:** brackets specifically,
  because eight dots is the other vocabulary and it means Cover
- **NEW: a scrim over everything outside the crop.** Present in every surveyed
  surface without exception, and it is what makes the frame read as a frame
- **NEW: rule-of-thirds grid while a finger is down, and not at rest**
- **NEW: a loupe at the dragged corner.** Six image pixels per screen pixel
  means the alternative is guessing, and the finger covers the target
- **NEW: a reset-to-original control**, distinct from Start over
- **NEW: `TOUCH` raised from 44 to 48.** 44 is the iOS floor; Material's is 48dp
- Status bar pre-trimmed, shown as an excluded band that can be dragged back in,
  and **NEW:** as the visible case of a general auto-propose, which is the one
  place this app can beat a general photo cropper

Deferred out of Phase 2 on purpose, with the survey's reasoning: the aspect row
(needs an `aspect` parameter that `dragCrop` and `normalizeCrop` do not have)
and user pinch-zoom (the loupe answers the same need for less).

**Started 2026-09-18: the arithmetic exists, the surface does not.**
`spike/src/crop.js` holds the geometry -- contain-fit projection, viewport-to-image
conversion, the nine handles, the minimum clamp and hit testing -- as a pure module
with 78 checks and 9 mutations. Everything in it is in image pixels, per the
constraint below. What is left is the part that needs the phone: the
gesture-handler/reanimated surface, the corner brackets, the excluded status-bar
band, and the frame rate.

**Verification.** 60fps on the slowest device available, not on the fastest. A crop
surface that stutters is the one performance failure a user cannot ignore.

## Phase 3 — Cover

- Drag to add a mask box, tap a box to remove it, multiple boxes. **The one
  box in the Phase 4 build is the placeholder this replaces**: it cannot cover
  two places in one screenshot, which is the ordinary case, not the rare one
- Fill is the **modal** colour of the ring outside each box, recomputed live —
  never the mean, which text in the ring drags off the background
- Surface `coverage` when it is low: the box is misplaced, not the background rough
- Show the fill as it will look — no preview/apply split
- **NEW from the survey:** a box is an *object*, so it carries eight dots and a
  small floating toolbar with a delete, which is what Apple Markup, VSCO and
  Freeform all do. Tap-to-remove with no selected state is a gesture nobody
  else uses and nobody will guess
- **NEW, not a commitment:** on-device OCR (ML Kit Text Recognition v2) could
  propose boxes over handles and @mentions the way Xnapper proposes them over
  email addresses. A native module and a model download, so it is a dependency
  decision to take deliberately, not a given

## Phase 4 — chrome

**Started, and on a phone: 2026-09-18.** `src/theme.js` is the token table,
`src/copy.js` every user-facing word, and the screen is three states with at
most three controls. Run on a Pixel 6 Pro through the debug build: empty state,
source state, Cover, Make card, result, Share (the chooser opens), and the long
press into the old measurement harness. Gated by `tools/check-copy.mjs`,
`tools/check-style-members.mjs` and `contrast.py`.

Not done here: the nav island and the one morph below, which belong to a second
screen this app does not have yet; and the dark palette, which exists and is
measured but has never been drawn -- this phone locks night mode.

- `theme.ts` with the token table, both themes, Graphite-dark `#949BA2` and
  Signal-dark `#7C9AE0`
- Nav island, the detached pick-a-screenshot island, gradient fade
- Padding and background controls
- The one morph
- Empty states, copy voice per the spec

**Verification.** Run `contrast.py` against whatever ends up in `theme.ts`, not
against what this plan says. It exits 1 on failure.

## Phase 5 — save and share

- MediaStore save, scoped-storage behaviour per API level
- `FileProvider` content URI for `ACTION_SEND` — WhatsApp sharing depends on it
- Photos permission denied falls back to the share sheet silently, no nag
- Picker via the permissionless photo picker, not a full-gallery permission

## Phase 6 — Library

- **Copy the incoming image into app-owned storage at import**, while access is
  guaranteed. A shared `content://` URI is a grant, not a file: it can be revoked,
  and the source can move or be deleted without the user thinking of it as deleting
  a card. Storing a reference and calling it "store the source" was a contradiction
  in an earlier draft of this plan — it promised re-editability and then described
  losing it.
- Persist crop rect and mask boxes in **source-image pixel space**, so they survive
  a different screen, a different density, and a re-render at a different size
- Re-edit opens the crop surface in its prior state
- **Two distinct destructive actions, never one button.** "Clear rendered outputs"
  frees space and loses nothing — outputs regenerate from source + rect + masks.
  "Delete originals" destroys re-editability permanently and must say so.
- At 200KB–2MB per source plus its output, this grows; size is shown per entry

## Phase 7 — device matrix and polish

Screen densities, display-zoom settings, dark and light screenshots, a very tall
thread crop, a 720p device, a P3 device.

---

## Order rationale

Phase 0 before everything because the premise is unproven. Phase 1 before the
gestures because a beautiful crop surface producing wrong-sized output is worse than
an ugly one producing right-sized output. Chrome at Phase 4 rather than Phase 1
because the aesthetic depends on seeing real crops in it — designing the island
against a placeholder rectangle is how apps end up looking generic.

## What is still unverified

Phase 0 has run on a device and all five questions have measured answers
(`spike/results/`). What remains unverified is narrower, and none of it is a
measurement this repo can take on its own:

- **Q1's verdict on a real display.** Every number predicts no visible seam. A
  number below the eye's threshold is not the eye. This is the one open item that
  could still change direction.
- ~~**Whether the Display P3 colour chunk reaches the PNG.**~~ **Measured.**
  `colorSpace: DisplayP3` writes an `iCCP` whose colorant tags are Display P3's,
  and 961238 channel samples re-encode. The default output carries no colour
  chunk at all — sRGB by convention only. See `spike/results/phase0-device.md`.
- **WhatsApp's actual recompression**, which needs a real send to a real phone.
- **Crop-gesture performance on mid-range hardware.** One device so far, and it is
  a fast one — the Phase 2 target is the slowest device available, not this one.
- **Any GPU that is not a Mali-G78.** The composed-surface ceiling of
  [16256, 16384) is one driver's number.
- **Other Android skins.** The status-bar shape test is verified both directions,
  but on a single stock-Android status bar.
- **The share target's actual behaviour.** It registers and resolves correctly on
  the installed package — both actions, three mime types, with `text/plain`
  correctly refused. But a real `ACTION_SEND` is **consumed by the dev launcher**
  and never reaches the app, because Expo appends the filters to the main activity
  and in a dev client that is `DevLauncherActivity`. Measured, not assumed.

  This breaks Phase 1's stated reason for registering it early — "so every later
  phase is tested through the real front door". With a dev client there is no front
  door. Either a release-style build gets added to the loop before the share path
  is trusted, or Phases 2-4 are tested through the picker and the share path is
  deferred to Phase 5 where it already lives.
