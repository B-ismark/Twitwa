# Build plan

*September 16, 2026. Reads against `social-card-renderer.md` — that doc holds the
decisions and the measured evidence; this one holds the order of work.*

## What we are building

Share a screenshot in, drag a crop, get a padded PNG on a background matched to
the screenshot. No network in v1.

## The one thing that could kill it

**History since 2026-09-22.** The owner cut Cover (see Phase 3), so nothing in the
app depends on this section any more. It stays because it is a real measurement,
and because it is what Phase 3's design stands on if redaction ever comes back.
What the cut gives up is exactly the case below: on Instagram a card now keeps the
like count or loses the caption.

The Cover tool. A crop cannot exclude the like count that sits between an Instagram
image and its caption, so Cover was what would make the app meet its own problem
statement. It filled a dragged box with the colour sampled from just outside that
box, which is seamless **only if** social backgrounds are as flat as they look.

**Answered, 2026-09-16: they are.** Four real captures, 58 Cover target rows,
nothing above 2.09/255 and 50 of 58 below 1 — including pure-white Facebook chrome
at 0.38, which closes the light-mode gap. Details in
`spike/results/phase0-q1-q3.md`.

It turned out to be verifiable from a terminal after all — Q1 and Q3 are pure
pixel math, and only Skia speed, the colour round trip and the memory ceiling
need a device. The assumption that they all needed hardware cost nothing here, but
it is the reason this was nearly deferred behind a Gradle build.

The condition it came with: the fill had to be the ring's **modal** colour. A mean
is dragged by text caught in the sampling ring and produced a mid-grey fill on a
pure-black background.

---

## Dependencies — and what got cut

The instinct with Skia is that it is heavy, so avoid it. That is backwards here.
Skia does the pixel sampling for background matching, the crop, the composition,
and the PNG encode — **one dependency replacing four**:

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
react-native-gesture-handler      crop gestures
react-native-reanimated           gesture values on the UI thread, the one morph
@shopify/react-native-skia        sample, crop, compose, encode
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

> **Superseded 2026-09-23, the owner's call:** the brackets read as boxy, and
> the crop now draws a white dot with a dark ring at all eight handles. The
> white-with-a-dark-outline reasoning below still holds and the dots keep it;
> the brackets-mean-a-frame argument in the survey was weighed and overruled.

**Corner brackets, not a rectangle.** Four corner marks plus edge midpoints, 2px,
white core with a thin dark outline. This is not decoration: the token table
guarantees Signal against Paper and Ink, but crop handles sit over *arbitrary
screenshot pixels*, and a blue handle over a blue image is invisible. Brackets also
read as photographic and add less visual noise than a full border.

**Show the result, not the rect.** Padding is the product, so the preview shows the
composed card on its sampled background — not a crop outline in isolation. Crop mode
while dragging, result mode on release.

**Three stops, and a drag between them** (revised 2026-09-18). Snug / Standard /
Roomy as a small segmented pill, with a continuous fine-tune on the drag. Decisive
defaults beat fiddling, so a tap is the common path; the drag is there because the
owner asked to be able to set the white space, and stops alone cannot.

**One radius, one shadow, one motion.** (It was "two radii" until 2026-09-24.) Pill for chrome, and the card's own radius
was a control rather than a fixed 14px from 2026-09-18 until it was removed on
2026-09-24; the card is square-cornered now. Still exactly one shadow
in the app, under the island: a second one on the card was wanted and dropped the
same day, because it could not be elevation and a Skia shadow clips against the
padding budget in the export where nobody would see it. The only animation is the
cross-fade between the composed card and the raw screenshot when Crop takes the
bar; gestures track the finger 1:1 with no easing theatrics.

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
   2x headroom and does real work. **`MAX_PX = 10e6` could not fire**: `cardSize`
   bounded width by `TARGET_W = 1080` and height by `MAX_H`, so its largest output
   was 8.64MP and the pixel disjunct was dead code. (2026-09-24: `TARGET_W` is gone,
   cards are the crop 1:1, and `MAX_PX` is now a live 14e6 beside a new `MAX_W`.) It was justified twice before
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
- ~~Cover boxes are clamped to the crop in pure code and clipped in Skia as
  defence; each box is filled with the modal colour of its **own** ring, not the
  card background~~ **Built, then removed with Cover on 2026-09-22**
- EXIF orientation is baked in **before** planning, because applying it at draw
  time also moves the destination rect and leaves a 90-degree rotation sized for
  the wrong aspect
- Edge sampling with the four-edge agreement test, Paper/Ink fallback by luminance
- **Never resample**: width is `crop_width + 2 × padding` (it was
  `min(1080, …)` until 2026-09-24, which blurred 1440-wide captures); height follows
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
build or Android skin. The Cover path, since removed, was density-**dependent** by
construction and measured to be; see `spike/results/phase1-pipeline.md`.

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
   free way to make Crop and Cover unmistakable without a word of copy. (Cover
   has since been cut; the bracket half of this stood until 2026-09-23, when
   the owner chose dots for Crop: see the note under "Corner brackets".)
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
| Auto-redact detected sensitive text | Xnapper, on Apple's Vision OCR | **Declined by the owner, 2026-09-18.** It would have been Cover's other half; the ML Kit native module and model download are not being added |
| Background: solid, gradient, or sampled from the image | Pika, Xnapper, PostSpark, Photoroom | **Have it.** Sampled is already the product |
| Padding or inset control | Pika, Xnapper, Photoroom "Resize" | **Have it.** `PADDING` snug/standard/roomy in `src/sizing.js` |
| Corner radius on the inner image | Pika, PostSpark | **Taken 2026-09-18, removed 2026-09-24** (owner: not needed). Was one slider in Style, partly reversing the spec's own "no border or shadow controls" |
| Drop shadow on the inner image | Pika, PostSpark, Photoroom "Shadows" | **Wanted, then declined the same day.** It cannot be elevation, so it is a Skia shadow that must fit inside the padding budget or clip — in the export only, where nobody is looking |
| Aspect presets named by destination rather than by ratio | Pika social sizes, TweetPik | **Skip.** Retracted 2026-09-18: the spec's argument is better than this one — the crop already *is* the aspect, so a preset can only fight it by padding unevenly or by discarding content the user chose |
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

The equivalent for Phase 3 would have been on-device OCR proposing boxes over
handles and @mentions, the way Xnapper proposes them over email addresses. **The
owner declined it on 2026-09-18**, so the ML Kit native module and its model
download are not being added. Recorded here because the survey turned it up, and
a later reader should find the decision rather than the idea.

### What `src/crop.js` is missing against the list above

| Missing | Consequence |
| --- | --- |
| No `aspect` parameter on `dragCrop` or `normalizeCrop` | Blocks the aspect row entirely |
| No user zoom: `fitView` derives scale from the viewport alone | Six image pixels per screen pixel, so precise trimming is not possible |
| No reset-to-original | Every surveyed app has one |
| ~~`TOUCH = 44`~~ | That is the **iOS** floor; Material's is **48dp** and this is an Android-first app. **DONE 2026-09-18**, and the constant moved: `crop.js` and `theme.js` each had one, both 44, both commented as the platform minimum. It lives in `theme.js` now and `crop.js` re-exports it |

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
already called out as the wrong shape. **Settled 2026-09-22: Phase 3 was cut
rather than built, and the placeholder went with it.**

The list below is what the survey above says a crop surface is. Items marked
NEW came out of that survey and were not in the original plan.

- Pan and resize from corners and edge midpoints, gesture-handler + reanimated,
  worklets so it runs off the JS thread
- Minimum crop clamped at ~120px on the short edge — clamp the gesture, do not error
- Corner brackets per the aesthetic notes, and **NEW:** brackets specifically,
  because eight dots is the other vocabulary and it means an object on the
  picture
- **NEW: a scrim over everything outside the crop.** Present in every surveyed
  surface without exception, and it is what makes the frame read as a frame
- **NEW: rule-of-thirds grid while a finger is down, and not at rest**
- **NEW: a loupe at the dragged corner.** Six image pixels per screen pixel
  means the alternative is guessing, and the finger covers the target
- **NEW: a reset-to-original control**, distinct from Start over
- ~~**NEW: `TOUCH` raised from 44 to 48.** 44 is the iOS floor; Material's is 48dp~~ **DONE 2026-09-18**
- ~~Status bar pre-trimmed, shown as an excluded band that can be dragged back in,
  and **NEW:** as the visible case of a general auto-propose, which is the one
  place this app can beat a general photo cropper~~ **DONE 2026-09-19, as a TAP
  rather than a drag, and generalised to all four edges**

Deferred out of Phase 2 on purpose, with the survey's reasoning: the aspect row
(needs an `aspect` parameter that `dragCrop` and `normalizeCrop` do not have)
and user pinch-zoom (the loupe answers the same need for less).

**Started 2026-09-18, and the surfaces followed on 2026-09-19.**
`spike/src/crop.js` holds the geometry -- contain-fit projection, viewport-to-image
conversion, the nine handles, the minimum clamp and hit testing -- as a pure module
with 135 checks and 20 mutations. Everything in it is in image pixels, per the
constraint below.

**Shipping as of 2026-09-18:** the scrim, the corner brackets, the drag itself
on the UI thread, Reset distinct from Start over, and the auto-proposed crop
the editor opens on, and **as of 2026-09-18 `TOUCH` at 48** -- one constant in
`theme.js`, re-exported by `crop.js`, rather than the two copies of 44 that
were there. Verified on the phone rather than only in node, because the
constant now crosses a module boundary into a worklet closure and that is the
exact shape of the bug recorded below: the crop opened, a corner drag moved the
card from 2178 to 2237 high, and nothing threw.

**The rule-of-thirds grid is written and NOT SEEN ON A DEVICE**, 2026-09-18.
`CropGrid` draws four lines off the same `liveCrop` shared value the frame
uses, with opacity on a second shared value so it appears and goes without a
React render. It shows only when `pickHandle` actually returned a handle -- a
finger landing outside the frame is not a drag. The lines carry the corner
brackets' white-with-a-dark-outline treatment, because a single-colour
hairline over arbitrary screenshot pixels is invisible against some of them
and a grid that vanishes on a pale screenshot cannot be told from one that
never appeared.

It is the app's SECOND piece of motion, against an aesthetic note that says
there is one. Argued rather than taken: the cross-fade is the app moving by
itself between two views and 160ms is a transition a person watches; this is
bound to a finger, has to be over before the drag is, and a hard cut at
finger-up reads as a flicker. `GRID_MS` is 120, under the cross-fade so the
two cannot be mistaken for each other. **Whether that is right is a judgement
about motion and no gate here can make it.**

**The loupe's arithmetic is in `crop.js` and its surface is not built.**
`handlePoint(handle, crop)` gives the image pixel a resize handle is holding,
and null for `move` -- a translation has no point to align. It is a table
rather than string tests for one reason worth keeping: `'move'.includes('e')`
is TRUE, so the obvious implementation puts the body handle on the east edge
unless an early return happens to catch it first. `handles_by_substring` is
that version. `loupeScale(view, want = 2)` derives the magnification from the
projection instead of picking a factor -- at 1080 wide in a 400pt stage one
image pixel is about a sixth of a point, and a fixed 2x or 3x would be right
for one screenshot width and wrong for the next. `loupe_fixed` returns 3 and
`loupe_shrinks` drops the clamp that stops a "loupe" reducing.

**The loupe's surface is written and NOT SEEN ON A DEVICE**, 2026-09-19.
`CropLoupe` draws the same `src.img` at the same contain-fit stage size the
layer underneath it draws, then applies a Skia transform that puts
`handlePoint`'s pixel under the crosshair. Drawing it from a second projection
was the alternative and it is the bug it would have caused: the user would
align the crop against a picture that is not quite the one on screen. It is
pinned to the top of the stage and swaps to the far side of whichever half the
handle is in, rather than following the finger -- one fewer moving thing, and
never under the hand. It is a square, because a round one needs a Skia clip
path and a matching RN outline, which is two shapes to keep in step for no
information. It never shows for `move`, because `handlePoint` returns null
there.

### The excluded bands -- 2026-09-19

Phase 2 promised the status bar "shown as an excluded band that can be dragged
back in". What shipped is that generalised, and the survey above is why: every
app surveyed auto-proposes, so the status bar is the visible case of a rule and
not a case of its own.

`edgeBand(edge, bounds, crop)` is the strip between one edge of the crop and
the same edge of the image, `expandToEdge` gives that edge back, and `pickBand`
says which strip a point is in. Computed from the LIVE crop, not from a
remembered proposal. That is the load-bearing choice and it removes a source of
truth rather than adding one: holding the proposal alongside the live crop for
the life of the editor means two rects that can disagree, a band that survives
the user dragging over it, and no good answer about what Reset does to it.

Each band is the width or height of the CROP, not of the image, so it sits
directly against the frame. Full-width was the obvious version and
`BREAK=band_full_width` is it: reclaiming the top would also widen the crop,
which is invisible on any screenshot whose crop is already full width --
which is most of them.

**A TAP, not a drag,** and that is a change to the plan's own phrase rather
than a shortfall. A band is reclaimed whole or not at all; half a status bar is
not a thing anyone wants, so a drag would be a gesture whose only meaningful
outcomes are its two ends. Dragging the edge back by hand is still there --
it is the `n` handle. The tap is RACED against the pan rather than sequenced
after it, so reclaiming never fires at the end of a drag.

`crop.test.mjs` is at 135 checks and 20 mutations. The four new ones are
`band_full_width`, `band_zero` (an edge already at the image offers a strip
that reclaims nothing), `grow_wrong_way` (the height grows and the origin does
not, so the top eats the picture downwards and the band stays put) and
`band_ignores_span` (the hit test checks only the axis the band is thick on, so
a tap beside a narrow crop reports the band above it).

### A gate that can see App.js calling a function wrongly -- 2026-09-19

`tools/check-call-arity.mjs`. `check-imports.mjs` proves an imported name
RESOLVES and says nothing about how it is then called; `expo export` bundles
arity-blind. That gap cost a day on 2026-09-18, when App.js called the
three-argument `readSubRect(img, box, colour)` with two and 1359 checks stayed
green.

It parses the consumer AND the module, rather than importing the module and
reading `fn.length`. Two reasons, and the first decides it: the modules most
worth checking are the ones that cannot be loaded in node at all, and
`fn.length` stops counting at the first default, so it cannot tell "three
required" from "one required and two optional".

Its last check injects a call one argument short into the REAL App.js and
requires the scan to catch it. Without that, a green would also be what a scan
that matched nothing looks like -- which is exactly how the original bug got
past three gates. Six mutants, all red: `arity_blind`, `min_blind`,
`max_blind`, `rest_blind`, `imports_blind`, `parse_blind`.

Nothing in the suites still loads App.js, and the gate does not change that: it
cannot see namespace imports, re-exported bindings, argument types or order, or
any decision the component makes.

**Still to do in this phase:** nothing on the list. What is left is device work
-- see below.

**Queued for the next time the phone is connected**, because the owner
unplugged it mid-session and none of the above has been seen:

- the grid appears on finger-down and goes on finger-up, and is legible on a
  pale screenshot as well as a dark one;
- 120ms reads as bound to the finger rather than as a second transition;
- the 48pt touch target has not made two adjacent handles fight on a small
  crop (the corner-beats-edge rule says it cannot, and that is an argument,
  not an observation);
- ~~`DEFAULT_RADIUS` 0.02 on a real card rather than on a cropped corner.~~
  Moot: corner radius was removed on 2026-09-24.

Added 2026-09-19, same reason -- the phone was still unplugged:

- the four excluded bands are visible over a real screenshot and read as
  removed rather than as part of the scrim, on a pale capture as well as a
  dark one;
- a tap on the band above the frame gives the status bar back, ONCE, and does
  not also widen the crop;
- a tap and a drag are actually separable by the race: a slow deliberate drag
  from inside a band does not reclaim it on release, and a quick tap is not
  swallowed as a zero-distance pan;
- the loupe appears at the dragged corner and shows the same pixels as the
  layer under it, offset by nothing;
- the loupe's side-swap does not flicker when a handle crosses the midline;
- the loupe does not cost frames -- a Skia canvas per drag frame is the one
  thing here that could, and `gfxinfo` is how to find out.

What WAS available without the phone and was used: `npx expo export` bundles
clean (1329 modules, a 3.4MB `.hbc`), which catches a syntax error or an
unresolved import; `check-call-arity.mjs` now catches a wrong argument count
as well. None of the three can catch a crash at render, and none of them can
see a pixel.

**The owner has now used it, 2026-09-18: "moving the crop is not as smooth as
I'd expect."** That is the verdict this phase exists to answer, and the cause
is already located rather than suspected. The crop gesture commits through
`setEd` on every move — a React setState per frame — and each one recomposes
the Skia card. The projection arithmetic is off the JS thread in name only:
`src/crop.js` is pure, but it is being called from the JS thread and its
result is being routed through React state. Worklets are not a refinement
here, they are the fix.

Two things to do, both "get the work off the main thread":

- ~~The drag itself, as a worklet driving shared values, with React state
  written once on gesture end rather than once per frame~~ **DONE
  2026-09-18**, measured below.
- The auto-crop's whole-image read, **measured at 200–234ms on the JS thread
  at import** on 2026-09-18. It is the largest single cost in the import, and
  it is the next thing in this phase.

### The drag, measured on the phone

`dumpsys gfxinfo` over eight `input swipe` drags of the SE corner, twice per
build, on the Pixel 6 Pro. Two runs rather than one because a single run
establishes a direction and not a magnitude.

| build | frames | janky | missed vsync | slow UI thread | 99th |
| --- | --- | --- | --- | --- | --- |
| `setEd` per frame, run 1 | 699 | 24 (3.4%) | 24 | 23 | 20ms |
| `setEd` per frame, run 2 | 657 | 50 (7.6%) | 50 | 46 | 22ms |
| worklet, run 1 | 830 | 1 (0.1%) | 0 | 1 | 13ms |
| worklet, run 2 | 982 | 1 (0.1%) | 0 | 1 | 13ms |

The two counters that name a thread — Missed Vsync and Slow UI thread — go to
zero and one. Frames PRODUCED go up, which is the same finding from the other
side: the old build was dropping frames of the gesture, not drawing them
cheaply.

**One counter moved the wrong way, and it was chased down rather than left as
a caveat.** "Number High input latency" rose from 106/213 to 824/964. It is
reported here rather than left out, because a table showing only the columns
that agree with the change is not a measurement.

It is not a latency regression. Three things settle it, measured 2026-09-18
after the owner asked:

- **A control in an unrelated app.** The same synthetic swipes against
  `com.android.settings` gave 343 of 1097 frames flagged at 0.09% jank. The
  counter fires freely in a healthy app that this change cannot have touched.
- **The end-to-end latency itself, from `framestats` rather than from a
  counter.** One swipe each, same gesture, minutes apart:

  | | frames | janky | missed vsync | high input latency | app work p50 | to panel p50 / p99 | frames carrying an InputEventId |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | `setEd` per frame | 108 | 0 | 0 | 0 | 4.45ms | 27.10 / 27.15ms | 83 of 107 |
  | worklet | 138 | 0 | 0 | 100 | 7.06ms | 27.10 / 27.14ms | 61 of 120 |

  `DisplayPresentTime - IntendedVsync` is the input-to-photon figure and it is
  **identical**: a fixed three-vsync pipeline, 50 microseconds of spread
  across a whole run. The counter moved; the latency did not.
- **What did change.** The new build draws about 28% more frames for the same
  gesture and only half of them carry a fresh `InputEventId`, because
  `input swipe` injects slower than a 120Hz panel refreshes. Per-frame app
  work rose 4.45ms to 7.06ms against a 16.6ms deadline — the cost of drawing
  every frame instead of dropping them, which is the same finding as "frames
  produced went up" seen from a third side.

**What was NOT derived:** the exact AOSP predicate behind the counter. The
obvious guess — that it equals the frames with no `InputEventId` — was tested
and is wrong (100 flagged against roughly 68 such frames), so it is recorded
as a failed hypothesis rather than repeated as an explanation. Note also that
`framestats` on this Android prints `InputEventId` and no longer prints
`OldestInputEvent`, which is the field the counter is computed from, so the
predicate cannot be reproduced from this output at all.

The owner used the build on 2026-09-18 and said "it's smooth now", which is
the instrument that matters and the one that had said otherwise.

**Two defects were found by putting this on the phone, neither visible to any
desktop check.** The first is the one that shipped: `pickHandle`'s
`{ touch = TOUCH }` default is not captured into a worklet's closure, so the
first finger-down threw `Property 'TOUCH' doesn't exist`. The second is that a
`gfxinfo` run over that broken build reported **0.52% jank** — a clean number
for a gesture that was throwing on every touch. Both are now guarded:
`BREAK=not_worklet` and `BREAK=default_captures` in `src/crop.test.mjs`, and
the bench takes a screenshot as a positive control before its number is
believed.

**The thumb has now confirmed it.** The owner used the build on 2026-09-18
and said "it's smooth now". That closes the complaint this phase opened with,
and it is the only instrument that could: `input swipe` is not a finger — it
cannot vary its pressure, it cannot pause, and it moves in a straight line.

**Still not done:** the same check on the slowest device available rather
than the fastest. Every frame number here is from a Pixel 6 Pro.

## Phase 3 — Cover — **CUT 2026-09-22**

The owner cut Cover, settling the question they had raised on 2026-09-18 after
using the build: "the Cover feature is still here, not sure its use." The app
is Crop and Style.

Removed end to end: the tool and its bar button, the box state and its Reset in
`src/shell.js`, the box clamp and output mapping in `src/plan.js`, the
ring-sampled fill and its clip in `src/pipeline.js`, the live preview's boxes in
`App.js`, the copy, and the developer panel's Cover buttons. The on-device half
of Phase 0's Q1 went too, because a drawn Cover box was its only input; the
desktop half, `tools/probe.mjs`, still runs. Kept, with their tests, because
`tools/probe.mjs` consumes them: `ringStats` and `ringBackground` in
`src/pixels.js`. Kept with only its own tests as a consumer: `ringStrips`, the
four-strip ring read, which is the sampling half of the design below already
written.

What the cut gives up: redaction of any kind — a handle, a face, a name — and
the like-count row between an Instagram image and its caption, which a single
crop cannot exclude. That row was "the one thing that could kill it" at the top
of this plan.

The question as it stood before the decision, kept as the record of what it was
taken against:

- Crop chooses what the card IS, Cover hides things inside that choice — a
  handle here, a face there. The two were called out as not substitutes.
- Since that reasoning, the editor had come to open on an auto-proposed crop
  that already removes the status bar, so the most common thing anyone wanted
  to hide was gone before the user saw the card. What remained for Cover was
  redaction, a real need but a rarer one, and the shipped single box was the
  shape the owner had already called wrong.
- The fork was **cut Cover** (one screen, one job) or **build it properly** as
  the objects-with-eight-dots surface below. Shipping the placeholder
  indefinitely was the one option ruled out.

The rest is kept as the design to return to if redaction is ever wanted:

- Drag to add a mask box, tap a box to remove it, multiple boxes. **The one
  box the Phase 4 build shipped was the placeholder this would replace**: it
  could not cover two places in one screenshot, which is the ordinary case, not
  the rare one
- Fill is the **modal** colour of the ring outside each box, recomputed live —
  never the mean, which text in the ring drags off the background
- Surface `coverage` when it is low: the box is misplaced, not the background rough
- Show the fill as it will look — no preview/apply split
- **NEW from the survey:** a box is an *object*, so it carries eight dots and a
  small floating toolbar with a delete, which is what Apple Markup, VSCO and
  Freeform all do. Tap-to-remove with no selected state is a gesture nobody
  else uses and nobody will guess
- **Not being built:** auto-redaction over OCR, declined by the owner on
  2026-09-18. Every box is one the user drew
- What the removed build had already learned, so it is not relearned: boxes are
  stored in **image** pixels, because view coordinates cover a different region
  at each density; a box is clamped to the final crop, which a later trim can
  move under it; and its output rect is snapped **outward** to whole pixels and
  drawn with anti-aliasing off, because an anti-aliased edge leaked the covered
  content at up to 53/255. `spike/results/phase1-pipeline.md` has the
  measurements

## Phase 4 — chrome

**Started, and on a phone: 2026-09-18.** `src/theme.js` is the token table,
`src/copy.js` every user-facing word, and the screen is three states with at
most three controls. Run on a Pixel 6 Pro through the debug build: empty state,
source state, Cover, Make card, result, Share (the chooser opens), and the long
press into the old measurement harness. Gated by `tools/check-copy.mjs`,
`tools/check-style-members.mjs`, `tools/check-call-arity.mjs` and
`contrast.py`.

Not done here: the nav island and the one morph below, which belong to a second
screen this app does not have yet.

**The dark palette was drawn on 2026-09-18**, after the owner noticed the app
staying light on a phone that was in night mode. `app.json` carried
create-expo-app's `"userInterfaceStyle": "light"`, which expo-dev-launcher
applies by overwriting React Native's AppearanceModule; the line this plan
used to carry -- "this phone locks night mode" -- was the wrong diagnosis and
it kept half the theme untested for the life of the project. Set to
`automatic`, the whole dark palette renders and the harness reports
`scheme:dark`. `contrast.py` now gates the key as well as the sixteen colour
pairs, and has been observed failing on `light` and on the key being absent.

Seen in dark on 2026-09-18: the empty state, the card, the Style strip, Crop
with its scrim and brackets, the overflow menu and Developer tools. Nothing
was wrong in any of them. **Not seen in dark, and named rather than implied:**
the error states, and the Share chooser — that one is the system's sheet and
it lists the owner's contacts, so it is not screenshotted here.

- `theme.ts` with the token table, both themes, Graphite-dark `#949BA2` and
  Signal-dark `#7C9AE0`
- Nav island, the detached pick-a-screenshot island, gradient fade
- Padding and background controls
- The one morph
- Empty states, copy voice per the spec

**Verification.** Run `contrast.py` against whatever ends up in `theme.ts`, not
against what this plan says. It exits 1 on failure.

## Phase 4.5 — the editor shell and Style — BUILT 2026-09-18

**Added 2026-09-18, after the owner settled the IA.** It comes before Phase 5
because Crop and (until it was cut on 2026-09-22) Cover both hang off this
shell, and because it is where the
render step gets deleted.

**Built 2026-09-18, and RUN ON THE PHONE the same day.** It did not survive
first contact, and the way it failed is the argument for the rule it broke.

**It crashed on every import, and had done since it was written.** App.js
called `readSubRect(img, {x, y, w, h})` with two of its three arguments, so
`colour.colorType` threw, and the catch set `problem` while the render went on
to read `ed.tool` with `ed` still null. The app died with *Cannot read property
'tool' of null*, which names neither the throw nor the decode under it. **The
editor had never once opened on a proposed crop** — the central claim of this
phase — and 1359 green checks, `check-imports`, and a clean `expo export` all
said otherwise, because no suite loads a component, `check-imports` verifies
that a name RESOLVES and not how it is CALLED, and bundling is arity-blind.

What that cost, and what was done about it rather than just fixing the call:

- `proposeFor` moved out of App.js into `src/autocrop.js` as
  `proposeFromImage(img, read)`, taking its reader as an ARGUMENT so the whole
  path runs in node against a fake image. Three profiles, a status band and a
  detector is not view code; it only looked like view code because it needs a
  Skia image. 15 new checks, 4 new mutants
- `src/skia.js` now owns the one `RGBA` constant and the one two-argument
  `readRect`. Both had been written privately in `pipeline.js` AND `measure.js`
  — two copies each — and App.js had neither, which is why it reached for the
  three-argument function. A two-argument function cannot be called this way
- `readSubRect` throws a named error when the colour is missing, rather than
  letting the dereference blame `read.js`. 9 new checks, 2 new mutants
- `setSrc` now runs AFTER the proposal instead of before it, so `src` and `ed`
  are set together or not at all. Guarding the render with `ed &&` would have
  hidden the crash rather than removed the state that caused it

**Two more defects the device found, neither visible in any test:**

- **Background = Paper drew the card on a full-width black slab.**
  `palette.stage` is documented as the ground *while cropping* — dark so Paper
  does not tint a light screenshot's edges — and it was painted under the
  finished card too. Invisible for as long as anyone looked, because the
  default is Match and Match sampled near-black on the fixture. The ground now
  rides the same shared value as the cross-fade
- **A quarter of every export was discarded work.** `renderCard` ran
  `findStatusBar` unconditionally, and since this phase the app always passes
  `trim: 'never'` because the proposal already did that trim. Measured 78.33ms
  of a 323ms Share. Now skipped, and reported as `null` rather than `0` — a
  zero would read as "looked for, cost nothing". The honest saving is the
  profile and zone scan, **38.2ms**; the read also paid for Skia's lazy decode,
  which moved to `planMs` (22 → 67) rather than disappearing

**Measured on the Pixel 6 Pro, 2026-09-18**, on `x-timeline-statusbar`
(1440x3120):

- The proposal: `{x:36, y:89, w:1404, h:3002}`, trimming 89 top / 29 bottom /
  36 left / 0 right. The status-bar floor did its job — cut at row 89 rather
  than at the flat lead's 56, which is exactly the case the floor exists for
- **The auto-crop's whole-image read costs 200–234ms** on the JS thread at
  import. This was listed here as unmeasured. It is the largest single cost in
  the import and it is not yet off the main thread
- The crop scrim halves luma outside the rect: a step from 33 to 67 across the
  edge, decoded from a screencap rather than eyeballed
- Padding is live and monotone at a fixed 1080 width: Snug 2240, Standard
  2178, Roomy 2105
- **The phase's own verification gate passed on the device.**
  `P4.sameComposition` across a 3.7x scale: preview 291x567 pad 24 radius 4,
  export 1080x2105 pad 90 radius 14, `aspectOff 0.00062`, `padFracOff
  0.00086`. A second run at a larger preview was tighter still: 0.00028 and
  0.00043

**Still not looked at:** the 160ms cross-fade as motion (a screencap catches
one frame of it, which is not the same as watching it), the corner radius as a
judgement, and how a padding DRAG feels as opposed to the three stops.

What landed, beyond the list below:

- `src/shell.js`, the tool sessions, as a module rather than as flags in the
  view. 70 checks, 13 mutants
- `src/autocrop.js`, the proposal. 60 checks, 12 mutants. Its whole-image read
  is bounded by `MAX_PROFILE_PX`, past which it trims vertically only and says
  so — that read is the one place in the app that breaks `src/pipeline.js`'s
  "never read a whole image" rule, and a column profile has no banded form
  - **It shipped cutting the byline, 2026-09-23.** It took `detectStatusBar`'s
    cut as the top floor without the shape test that `plan.js` and
    `pipeline.js` apply, so on a screenshot with no status bar the editor
    opened with the author's avatar-and-name row gone -- the exact failure
    Phase 0 measured and `social-card-renderer.md` records as "do nothing".
    The owner found it on a tweet in 1.0.2; on the captures it was rows 13-133
    of `x-quote-dark.png`. Fixed by `judgeStatusBar` in `pixels.js`, the one
    function that pairs the detector with the shape test, and a proposal that
    trims only on `likely === true`. The lesson is the two-sources one: this
    was written beside two copies of that pairing instead of calling one.
- `src/pixels.js` gains `colInkProfile`, tested against `rowInkProfile` of a
  transposed buffer rather than against a reimplementation
- `planOutput` gains `frame`, so the Background control changes the card
- `composeCard` clips the image to a rounded rect, and the pixel count comes
  from `compose.js`'s `radiusPx` — the same call the preview makes (removed
  with the corner radius on 2026-09-24)
- The preview's frame colour comes from `planOutput` itself, with the sample
  taken by the renderer's own `sampleCropBackground` at import and on Done.
  An earlier draft drew a neutral frame under Match and let the export decide,
  which would have put a preview/export divergence on the DEFAULT setting

**Still Phase 3.** Every item on Phase 2's list is written, as of 2026-09-19:
a scrim, corner brackets, drag handling through `crop.js`, a 48pt touch
target, the rule-of-thirds grid, the loupe, and the excluded bands. The last
three have not been seen on a device -- see the queue above, and do not read
"written" as "works". Cover was cut on 2026-09-22 rather than rebuilt; see
Phase 3.
**Built in Phase 5, 2026-09-22.** Save to Photos and Copy image are the first
two rows of the overflow, above Start over and the developer panel.

- **Delete the "Make card" step.** The canvas becomes the live card, composed at
  screen resolution, and re-composes on every change. `showingResult` and its
  two-preview state machine go with it. This is the preview/apply split that
  Phase 3's own line forbids and that nothing in the survey has
- One island, primary, **Share**. Save to Photos and Copy image move into an
  overflow with Start over and Settings
- A tool bar: Crop and Style. Crop takes the bar over and returns with Done;
  Style opens a control strip and needs no apply. (Built with Cover as a third
  takeover tool; Cover was cut on 2026-09-22)
- The canvas cross-fades between the composed card and the raw screenshot when a
  takeover tool opens. The one piece of motion in the app
- **Style: padding, corners, background.** Padding is three stops plus a drag to
  fine-tune, so `PADDING` in `src/sizing.js` needs a continuous path beside its
  named stops. Corners are new to the product and partly reverse the spec's own
  "no border or shadow controls" (removed 2026-09-24: Style is padding and
  background now)
- **No drop shadow.** Wanted on 2026-09-18 and dropped the same day: it cannot be
  platform elevation, which never reaches the exported pixels, so it would be a
  Skia shadow that has to fit inside the padding budget or clip — and clip in the
  PNG only, where nobody is looking. That failure mode is invisible on screen and
  permanent in the output, which is the expensive kind
- Auto-propose the crop from the pure-background bands, which is what makes step
  2 of the user flow true: the editor opens on a finished card

### The Style strip, after the owner used it — 2026-09-18

Two verdicts and two different causes, which is why they are recorded apart.

**"The stop drag isn't very smooth, the transition between the three stops is a
bit janky."** Measured before anything was changed, by tapping the padding
slider at five points and reading the thumb's position out of a screenshot:

| tap x | thumb's right edge |
| ---: | ---: |
| 540 | 565 |
| 590 | 654 |
| 640 | 654 |
| 690 | 654 |
| 740 | 765 |

A hundred pixels of finger travel through Standard moved the thumb by nothing,
and the next fifty jumped it 111. The cause was `SNAP = 0.004` in
`src/shell.js`: a hand-picked third of the gap between adjacent stops, which on
the 0.03–0.10 range is **11.4% of the whole track** pinned at each stop.

It is now derived instead. A drag snaps onto a stop when it rounds to the same
padding in *source pixels* — when it draws the same card — using `padPixels` in
`src/sizing.js`, which `cardSize` calls for the same rounding, so the control
and the layout cannot disagree. The still point at a stop is now 1.32% of the
track, the same as between any two adjacent whole pixels of padding, and under
the touch slop. Re-measured after: the thumb tracks the finger 1:1 through
Standard in 25px steps, and the chip still lights (`selected=true` at x=628 and
632, dark at 400 and 700).

`shell.test.mjs` walks the whole track at 20,000 samples, groups it into runs
where the thumb does not move, and fails if any stop holds it longer than one
pixel of padding does. `BREAK=snap_constant` restores the old band and it
reports "worst stop 0.06 holds 11.43% of the track; one pixel of padding is
1.32%" — the desktop suite and the device agree to two decimal places.
`BREAK=pad_divorced` in `sizing.test.mjs` makes `cardSize` round its own way
again, which is the drift the shared function exists to prevent.

**What this was NOT.** The frame counters barely moved: 2.30% janky before,
2.18% after, over ~800 frames each. The dead zone was never a dropped frame.
The Corners slider, which has no snap at all and was not complained about,
measures *worse* (3.25% and 2.65% over two runs) — so the residual jank is the
per-frame `setEd` that both sliders share, it is common to both, and it sits
below what the owner noticed. Getting rid of it means putting `padding` and
`radius` on the UI thread as shared values and driving the Skia card from
`useDerivedValue`, which requires worklet-ising `compose.js` and `sizing.js`
the way `crop.js` was. That is a real piece of work and it is not yet
justified by a complaint.

**"Not sure about the corner radius."** Delegated by the owner, so it was
measured rather than argued. The same card corner was captured at six radii
with a Paper frame behind a black screenshot — the only combination that shows
an arc at all — and read across: 0 is square and honest, 0.010 is
indistinguishable from anti-aliasing, 0.015 is visibly rounded only once you
are told, 0.020 is the first that reads as a deliberate corner, 0.030 is
comfortable, 0.040 is a tile. `DEFAULT_RADIUS` was **0.015, which sits in the
band that gives up the square corner's honesty and buys none of the card**, and
is now **0.02** — the smallest value that meets the criterion its own comment
already stated. `MAX_RADIUS` stays 0.04; the strip is what says why. The strip
itself is not in the repo: it is a crop of a fixture screenshot, and those
carry real posts by identifiable people.

Not re-decided: tying the radius to the padding. It is a tempting single rule
(`r = pad/2` lands almost exactly on 0.03) and `compose.js` already rejected it
in writing — widening the padding would fatten the corners, "a thing nobody
asks for and everybody notices".

**Verification.** The composed card and the exported PNG must be the same
composition at two scales, because the canvas runs at screen resolution and the
export runs at the crop's own size (it ran at up to 1080 wide until 2026-09-24).
A gate that composes both and compares geometry rather than pixels: same aspect,
same padding as a fraction of crop width, and, while it existed, the same radius
as a fraction of crop width. Break each on purpose and watch the gate go red
before trusting it.

## Phase 5 — save and share — **BUILT 2026-09-22**

- MediaStore save, scoped-storage behaviour per API level. **Done.**
  `Asset.create` from expo-media-library 57. On API 30 and later it asks for
  nothing: an app may insert its own image into MediaStore without a
  permission, and the card lands in `DCIM/` as `Twitwa-YYYYMMDD-HHMMSS.png`
  (`savedName` in `src/plan.js`, local time, sortable as a string except
  across a clock change). Below API 30
  it asks for `WRITE_EXTERNAL_STORAGE`, which the manifest carries with
  `maxSdkVersion` 32.
- `FileProvider` content URI for `ACTION_SEND` — WhatsApp sharing depends on
  it. **Done since Phase 4**, through expo-sharing.
- Photos permission denied falls back to the share sheet silently, no nag.
  **Written, not run**: it can only happen below API 30, and the one test phone
  is on 37.
- Picker via the permissionless photo picker, not a full-gallery permission.
  **Done**, and now enforced: `android.blockedPermissions` strips `CAMERA`,
  `RECORD_AUDIO`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO`,
  `READ_MEDIA_VISUAL_USER_SELECTED` and `ACCESS_MEDIA_LOCATION`, which the
  image-picker and media-library manifests add on their own. Read back from the
  built APK with `aapt2 dump permissions`: none of the seven is there.
- Copy image, added to this phase with the overflow. `Clipboard.setImageAsync`
  on the PNG's base64. The app says "Copied" only below API 33, because from 33
  the system shows its own clipboard preview and two confirmations of one copy
  read as two copies.

Share, Save and Copy all render through one `exportCard` in `App.js`, so the P4
same-composition check covers all three.

**Run on the Pixel 6 Pro (API 37), 2026-09-22, on the R8 release APK.** Save
wrote `DCIM/Twitwa-20260922-215520.png`, 1080×2229, owned by
`dev.bismark.twitwa`, with no prompt, and the caption read "Saved to Photos"
and then went back to the size. Copy put the card on the clipboard; the system
preview showed it and the app showed nothing, as intended. Share opened the
chooser on the card, with P4 at `aspectOff` 0.00107 and `padFracOff` 0.00094.
The test file was deleted afterwards.

**Receiving a share — BUILT 2026-09-22, and NOT RUN ON A DEVICE.** That run
found it missing: an `ACTION_SEND` to the running app left it on the empty
state, because nothing read `EXTRA_STREAM`. It is now read by a native module
of our own, `spike/modules/twitwa-share-in` (Kotlin, autolinked from
`modules/`), because no module in the project exposes the incoming intent.

- The module copies the ONE shared picture into `cache/shared-in/` and hands
  JS a `file://` URI. This is the Phase 6 note below, "copy the incoming image
  into app-owned storage at import", done: the export reads the source again,
  and a `content://` grant can be gone by then.
- It catches all three arrivals: the launch intent (cold start), `onNewIntent`
  (running; `MainActivity` is `singleTask`), and a new activity in a live
  process (Back, then share), through `OnActivityEntersForeground`. Each share
  is read once: the Intent object is marked, so a resume or a dev reload does
  not import it twice. Android also REPLAYS an old share with a fresh copy of
  the intent, from Recents and on a restore after process death; the first is
  refused by `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY` and the second marked read
  by `ShareInRestore` when `savedInstanceState` is set. The first version of
  that read the state in a `ShareInPackage` lifecycle listener, which is always
  handed null because the template `MainActivity` calls `super.onCreate(null)`;
  the Pixel showed the replay on 2026-09-23, and `plugins/withShareInRestore.js`
  now calls it from `MainActivity.onCreate` before the null is passed on.
- `App.js` takes shares one at a time, and only the newest import may commit
  to the editor. Each take deletes the shared copies not on screen, so two
  overlapping would delete the file the first is about to show (found in
  review).
- It refuses non-`content://` URIs, non-image types, empty reads and anything
  over 64 MiB. It keeps the copy the editor is showing and deletes the rest.
- `src/sharein.js` decides what the answer means (open, a sentence, or
  nothing), and `src/sharein.test.mjs` tests it. The same suite reads the
  Kotlin source for the contract between the two: module name, event name,
  the keys of each answer, and the exact set of refusal reasons. `App.js` routes the picker and
  a share through one `openImage`.
- A share of several pictures opens the first and says so.

The release build compiles and links it. It has not received a real share:
the phone was disconnected. See "What is still unverified".

## Phase 6 — Library — **CUT 2026-09-18**

The owner settled the app at one screen. There is no Library, no saved cards, no
grid, no card detail, and no re-edit path. That deletes a destination, a
persistence layer, six states and the only reason a nav bar existed.

One piece of it survives into Phase 4.5 and is not optional: **copy the incoming
image into app-owned storage at import**, while access is guaranteed. A shared
`content://` URI is a grant and not a file — it can be revoked, and the source
can move or be deleted mid-session. It is session-scoped now rather than
persistent.

The rest is kept here as the design to return to if a Library is ever wanted:
crop rect (and any boxes, should Cover return) persisted in **source-image pixel
space** so they
survive a different screen, a different density and a re-render at a different
size; two distinct destructive actions, never one button, because "clear
rendered outputs" loses nothing and "delete originals" destroys re-editability;
and a per-entry size, because 200KB–2MB per source adds up.

## Phase 7 — device matrix and polish

Screen densities, display-zoom settings, dark and light screenshots, a very tall
thread crop, a 720p device, a P3 device.

## Future — landscape — **TODO, not scheduled (noted 2026-09-23)**

The app is locked to portrait (`app.json` `"orientation": "portrait"`, and
`screenOrientation="portrait"` in the manifest), and the lock does not hold
everywhere:

- **Android 16 ignores it on large screens.** The app targets SDK 36, and from
  Android 16 an app's orientation lock is ignored on displays at least 600dp
  wide (Fold, tablets). Taken from the platform documentation; not yet observed,
  because the only device is a phone.
- **Split-screen gives a short, wide window even on a phone.** Nothing turns off
  resizing, and `App.js` already expects this case ("a short landscape window"
  in the card projection). When the card does not fit it returns `null`, so the
  stage shows nothing at all.

Rotation itself is cheap. `configChanges` includes `orientation|screenSize`, so
rotating does not recreate the activity and the edit survives. `recover.js`
deliberately ignores width and height, so a rotation is not reported as the
stale-launcher fault. The stage measures itself with `onLayout`, so
`fitView`/`project` recompute on their own. The pipeline doesn't depend on
orientation. What is missing is layout, and safe-area insets: `root` uses a
fixed `paddingTop`, so a side cutout or a 3-button nav bar on the side would
cover the controls.

Three options were weighed:

1. **Keep the lock, fix the windows it cannot stop.** Show a "window too small"
   message instead of an empty stage, let the tools row scroll, and shrink the
   bottom padding on short windows. Small, and needed whatever else is chosen.
2. **Unlock and keep the column.** Rejected: at 411dp tall the stage is
   about 200dp and a 1440x3120 screenshot fits at about 90dp wide.
3. **Unlock with a layout chosen by width (width > height).** Three prototypes
   of this are in `spike/results/landscape-prototypes.html` (open it in a
   browser; drawn at 891x411dp with the real tokens and labels, switchable
   rotation, nav mode and theme).

**Chosen for when this is picked up: option 1 first, then option 3 as the Rail
layout.** Rail puts today's controls in a 224dp column on the right, with the
same Style toggle and crop takeover, so there is one way of working in both
orientations and the change to `App.js` is smallest. Measured in the prototype
with headless Chrome, not on a device:

| Layout | Stage (gesture nav) | Card height vs portrait | Problem found |
|---|---|---|---|
| Rail | 599x339dp | 49% (52% with 3-button nav) | fits Style with about 29dp to spare, **only** if the tools and Share/Save/More are each one row; the stacked portrait bar overflows by 88dp |
| Inspector (Style always open in a side panel) | 523x339dp | 49% | 0-3dp to spare, overflowed by 2dp in one render; any larger text size breaks it. Two ways of working (toggle in portrait, always open in landscape) |
| Islands (controls float on a full-window stage) | 859x363dp | 52% (56%) | the floating Style panel covers the card by 13-49dp; needs its own colour tokens, `contrast.py` pairs, and touch handling over the crop gesture |

The layout barely changes the card size. A tall screenshot's card is limited by
the window's height in every layout, at about half its portrait height. The
layouts differ only in what they do with the spare width. Keep Inspector in mind
for screens at least 600dp wide, where a side panel is cheap.

What the prototype got wrong first, and is fixed in it: web flex children
shrink by default and React Native's do not (`flexShrink: 0`), so the page
squashed buttons instead of overflowing, and its overflow check could not fail.
Match that default before trusting any web mock of an RN layout.

Owed before this is done, none of it run yet:

- Add `react-native-safe-area-context` and replace the fixed `paddingTop`.
- On the Pixel: rotate both ways (`settings put system accelerometer_rotation 0`,
  then `user_rotation 1` and `3`), with gesture and 3-button nav. Which side the
  3-button bar sits on at 270° varies between Android versions.
- Split-screen (`am start --windowingMode 3`, or the recents menu), and a 600dp+
  emulator for the Android 16 case.
- Rotating mid-gesture on a crop handle, and a Skia canvas resize.
- A larger system text size in the rail. Check that it still fits, rather than
  assuming it does.
- The update banner: in Rail it goes at the top of the rail.
- No gate loads `App.js` (see the README), so none of this is covered by the
  suites.

---

## UX pass — 2026-09-23 — the owner's list

Asked for after Back handling and the round crop handles (branch
`back-and-dots`). Seven flows that did not make sense on the device, and what
each becomes. The owner chose all seven, and chose "show nothing" for 4.

1. **Developer tools out of More.** Friends saw a measurement panel meant for
   us. It stays behind the long press on the caption strip, which was already
   the documented way in; the strip keeps its height when empty, so the long
   press still has a target.
2. **"New screenshot" in More, replacing Start over.** Picking another
   screenshot was More, Start over, Choose screenshot. Now one item opens the
   picker. If the card has unsaved changes it asks "Discard this card?" first.
   A picker cancelled after that keeps the current card, since nothing was
   replaced. Start over goes: Back now returns to the empty screen, which was
   its only other job.
3. **A share into a changed card asks.** "Replace this card?" with Replace
   and Keep editing, using the same `unsaved` rule Back uses. Keep editing
   drops the share; the shared copy is cleaned up by the next take, as any
   copy that is not on screen already is. An untouched or kept card is
   replaced without asking, as before.
4. **The caption shows nothing at rest.** "1080 by 2173" was the export's
   pixel size, which nobody holding the app acts on. The caption still carries
   problems, "Making your card", confirmations and the crop hint.
5. **Save only on the bar.** More holds Copy image and New screenshot.
6. **Style gets Reset and Done.** Reset puts padding, corners and background
   (padding and background since corners went, 2026-09-24)
   back to the defaults a new card opens with, and is dead when they already
   are; Done closes the strip. Before, the only way out was tapping Style again
   and the only undo was by hand. `RESET_TO.style` in src/shell.js now holds
   those defaults, and `editorState` reads the same table.
7. **"Later" holds for three days per version.** Correction to the review
   that raised this: the check is already throttled to once a day, so the
   banner came back daily, not on every launch. Later now hides that version
   for three days; a newer version shows at once, and a clock that went
   backwards shows it rather than hiding it forever. `laterHides` in
   src/update.js is the rule; update-io.js stores it beside the check.

Each rule that can be pure is pure and has a mutant (6 in shell.test.mjs, 7 in
update.test.mjs). 1, 2, 3 and 5 live in App.js, which no gate loads, so they
are verified on the device or not at all.

---

## Order rationale

Phase 0 before everything because the premise is unproven. Phase 1 before the
gestures because a beautiful crop surface producing wrong-sized output is worse than
an ugly one producing right-sized output. Chrome at Phase 4 rather than Phase 1
because the aesthetic depends on seeing real crops in it — designing the island
against a placeholder rectangle is how apps end up looking generic.

**Revised 2026-09-18.** Phase 4.5 now sits between chrome and save, because the
IA changed under the build: the editor shell is what Crop and Cover hung off
(Cover since cut), and the live card it introduces is what makes them worth
having. Phase 4's screen was
built around a render button that the shell deletes, so doing Phase 2 first would
mean building the crop surface into a state machine already scheduled for
removal.

## What is still unverified

Phase 0 has run on a device and all five questions have measured answers
(`spike/results/`). What remains unverified is narrower, and none of it is a
measurement this repo can take on its own:

- ~~**Q1's verdict on a real display.** Every number predicts no visible seam. A
  number below the eye's threshold is not the eye. This is the one open item that
  could still change direction.~~ **Moot since 2026-09-22**: Cover was cut, so the
  app draws no fill for a seam to show in.
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
- ~~**Receiving a share: the cache cleanup.**~~ **Seen by the owner on
  2026-09-23**: the older shared-in copies were gone. Seen from inside the app,
  not measured (a release build has no `run-as`), so this is an observation
  rather than a byte count. Everything else ran on the Pixel the same day (cold
  start, running, after Back, `SEND_MULTIPLE`, a refused type, Recents, and the
  process-death replay withShareInRestore fixed).
- ~~**Save's permission fallback below API 30.**~~ **Out of scope, the owner's
  call on 2026-09-23**: no Android 10 testing. The code stays, unrun.
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
