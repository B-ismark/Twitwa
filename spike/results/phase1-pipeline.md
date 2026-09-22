# Phase 1 — the pipeline, status as of 2026-09-17 (third pass)

`src/pipeline.js` is written: decode → normalise orientation → detect status bar →
plan crop → sample background → plan output → compose → encode → write. One call,
`renderCard()`.

**It has now been run, twice, on the device** — see "renderCard on the device"
below for the two log lines and what was checked against them. Until 2026-09-17
this section said it had never executed; the claims in the rest of this document
were claims about code. The ones the run touched are now claims about a result,
and the two that the run contradicted are corrected in place and named as
corrections.

It was wired to **Render** and **Render + cover** in `App.js` (the second went
with Cover on 2026-09-22), and both were pressed by driving the device over `adb shell input tap`.

Two things the wiring changed in the code itself:

- **`renderCard` takes a `uri`.** It took encoded `bytes`, which nothing in the
  product has: a share arrives as a `content://` URI and the picker returns one
  too. `decodeUri` was added beside `decodeImage`, and the doc comment at the top
  of the file — which had said `uri` all along — is no longer describing a
  signature that did not exist.
- **The card is decoded back off disk and drawn.** Cheaper than any assertion: a
  throw means the bytes on disk are not a PNG, a wrong size means the encode and
  the plan disagree, and it is the only way Q1's "is the seam visible" question
  can be answered at all, since no measurement can settle it.

## renderCard on the device

Pixel 6 Pro, debug dev client, fixture `x-timeline-statusbar.png` (1440x3120)
chosen through the system photo picker, so the input was a real `content://` URI
and not a path. Both runs, verbatim from `adb logcat -s ReactNativeJS:V`:

```
P1.render {"path":"file:///data/user/0/dev.bismark.twitwaspike/cache/cards/card.png",
 "out":"1080x2146","fileBack":"1080x2146","kiB":611,
 "fill":"#000000","fillSource":"sampled","fillLuma":0,
 "crop":{"x":0,"y":89,"w":1440,"h":3031},"dest":{"x":58,"y":58,"w":964,"h":2030},
 "pad":58,"trimmed":true,"trimmedRows":89,"masks":[],
 "warnings":["the frame is near-black; it will have no visible edge on a dark background"],
 "timings":{"decodeMs":59.93,"decodeIsLazy":true,"statusBarMs":249.47,
   "planMs":17.33,"drawMs":17.43,"encodeMs":177,"writeMs":10.99},"wallMs":550}

P1.render { ... same geometry ...,"kiB":572,
 "masks":[{"fill":"#000000","coverage":0.7914,"clipped":true}],
 "warnings":["the frame is near-black; ...",
   "a Cover box extended past the crop and was clipped to it"],
 "timings":{...,"statusBarMs":245.65,"planMs":13.65,"drawMs":13.17,
   "encodeMs":212.96,"writeMs":4.39},"wallMs":533}
```

### What the run settles

- **The assembled path works.** 550ms wall for a 4.49MP source, and `fileBack`
  equals `out`, so the bytes on disk decode back to the size the plan intended.
- **The status bar was found and trimmed**: 89 rows, `trimmed:true`, and the crop
  starts at `y:89`. This is the first time the detector and the planner have
  agreed on a real capture rather than on a fixture built to be detected.
- **`encodeToBytes(PNG)` is the cost**, as Phase 0 measured: 177ms and 213ms of a
  ~540ms wall. `decodeMs` stays labelled `decodeIsLazy` because it is a header
  parse, not a decode.
- **`statusBarMs` is the second cost and was not budgeted for**: 249ms and 246ms,
  ~45% of the wall, more than the encode of the second run. Nothing in
  `results/phase1-*` had predicted that; the detector reads rows until it finds a
  boundary and on a 3120-row capture that is a lot of rows.

### Geometry, checked against the pixels rather than the log

The card was pulled off the device and decoded with `tools/png.mjs`, which shares
no code with Skia:

| check | result |
| --- | --- |
| decoded size | 1080x2146, colour type 6, fully opaque |
| non-black pixels **inside** `dest` | 431117 of 1956920 (22.03%) |
| non-black pixels **outside** `dest` | **0 of 360760** |
| bounding box of all non-black pixels | x 58..1021, y 58..2068 |
| `dest` from the log | x 58..1021, y 58..2087 |

The content bounding box matches `dest` exactly on both x edges and on its top,
and stops 19 rows short of the bottom — which is the capture's own black nav area,
not a geometry error. Nothing bled into the padding: the four 1px gutters just
outside `dest` are pad colour for their whole length. That is the clamping
question from defect 4 answered on a real render rather than in a unit test.

### The Cover box leaves an anti-aliased edge

Diffing the masked card against the unmasked one isolates what the mask changed:
20329 pixels, bounding box x 58..728, y 595..832. Inside that box the masked card
is **exactly** the fill colour everywhere except two lines:

| where | pixels | worst surviving channel |
| --- | --- | --- |
| interior | **0** | — |
| row 595 (top edge) | 268 | 34/255 |
| column 728 (right edge) | 38 | 53/255 |

So the mask is opaque, and its boundary is not: the box's rect lands on fractional
pixel coordinates after being scaled into `dest`, and Skia anti-aliases it. One
pixel of the covered content survives at up to 53/255.

Not legible, and irrelevant to the spike's job. It mattered for the product,
because covering a handle is a **redaction** and 21% of a pixel row is not
nothing.

**Fixed, and verified on the device.** `maskToDestPixels` in `plan.js` snaps
`maskToDest`'s fractional rect *outward* to integers and intersects it with
`dest`, and `composeCard` draws it with anti-aliasing off. Re-run on the same
fixture with the same box: same covered region (20329 differing pixels, bbox
x 58..728, y 595..832) and **0 non-fill pixels inside it**, against 306 before.

Two things the fix needed that were not obvious:

- **Outward, not nearest.** The two errors are not symmetric. Covering a pixel
  more than asked costs a pixel of background-coloured fill on a
  background-coloured surround; covering a pixel less leaves part of what the
  user was hiding. `BREAK=mask_px_nearest` and `BREAK=mask_px_inward` are both
  red.
- **Degenerate boxes have to be rejected before the rounding, not after.**
  Outward-rounding a zero-width box at a fractional coordinate manufactures a 1px
  mark out of no area at all, and `clampMasks` cannot catch it — a zero-size rect
  inside the crop overlaps the crop and is a legal source rect. `BREAK=mask_px_no_null`.

`maskToDest` is unchanged and still returns the exact fractional mapping. Two
functions, but not two rules: the integer one is *defined in terms of* the
continuous one, so they cannot disagree — which is the difference between this and
the clamp-versus-intersect split that was defect 4.

### Two claims this document made that the run contradicted

1. **The default output carries no colour tag at all.** `tools/chunks.mjs` on the
   card:

   ```
   IHDR    1080x2146  depth 8  colorType 6
   chunks  IHDR sBIT IDATx77 IEND
   colour  UNTAGGED — a viewer will assume sRGB
   ```

   Phase 0's `composeAndEncode` wrote an `iCCP` on *both* its sRGB and its
   Display P3 output (`results/phase0-device.md`), which is where the expectation
   of a tag came from. `renderCard` called without `colorSpace` creates its
   surface without one, and Skia then writes no profile. The bytes are sRGB by
   convention only.

   A **Render P3** button was then added — `render(false, ColorSpace.DisplayP3)`,
   writing to `card-p3.png` so the two cards coexist — and the same fixture
   rendered again. That closes Q4; see below.

2. **The pull recipe was wrong in the direction that corrupts silently** — see
   "Getting the card off the device" below.

### The status-bar detector cost, attributed then cut

It was ~245ms, 45% of the wall, and the total said nothing about which part. Now
timed in three pieces. Same fixture, four consecutive renders:

| | before | after |
| --- | --- | --- |
| `statusBarMs` | 239, 246, 249 | 110, 125, 106, 102 |
| `statusBarRead` | — | 66, 75, 64, 59 |
| `statusBarProfile` | — | 36, 46, 38, 38 |
| `statusBarZones` | — | 4.4, 4.3, 4.0, 4.2 |

Quoted as ranges over four runs, not as one number: the spread is ~20% and a
single reading would have supported any story.

**What was actually slow.** `rowInkProfile` called a `px()` helper that returns a
4-element array, so it allocated **once per pixel** — about 288k allocations for a
1440x400 band — and then scanned all 4096 histogram buckets per row to find the
maximum, another 1.6M iterations. Both are gone: the pixel read is hand-inlined
and the maximum is tracked while the histogram is built. The loop went from
roughly 170ms to under 40.

**What was never the loop.** `statusBarRead` is ~65ms and is mostly the **lazy
decode**: Skia decodes on first pixel access, `renderCard` decodes from the URI on
every call, so the first `readPixels` in `findStatusBar` pays for the whole image.
`decodeMs` reports 6-17ms because it only parses the header. An earlier version of
the comment in `pixels.js` claimed this change took the step "from ~250ms to
~15ms" — written before measuring, and wrong, because ~65ms of the original was
never the loop at all. The comment now points here and quotes no number.

Remaining headroom, not taken: the band is 400 rows when a status bar is ~130, and
the column step is 2. Both would cut the ~40ms further and both change answers, so
neither is worth it against a 400ms wall without a reason.

**The optimisation is held to the unoptimised answer.** `rowInkProfileNaive` is
the same function written the obvious way, exported only so the tests can compare:
four buffers x four step values, exact equality, plus an assertion that the
reference produced non-zero ink at all — without which the group would pass on two
all-zero arrays.

One mutation had to be **withdrawn**, and it is the more interesting half. The
first attempt permuted the 12-bit key's nibble fields (`R<<4|G<<8|B` instead of
`R<<8|G<<4|B`), on the theory that a wrong shift order is the likely typo. It
cannot be caught: both forms are bijections on the triple, and the function only
reads the *largest* bucket count, so relabelling buckets changes nothing. The
channel order inside `key12` is not load-bearing, and a test asserting it would
have been asserting an implementation detail no output depends on. The replacement,
`BREAK=ink_fast_offset`, reads bytes `i+1..i+3` — G, B, A — which is observable
precisely because alpha is constant, so one nibble carries no information and
distinct buckets collapse.

### Light captures, and the fallback branch on a device

Both earlier runs sampled `#000000` and took the near-black warning, so the fill
had only ever been exercised on the branch where the frame is invisible by design.
Three light captures were added as fixtures. Two were rendered:

| fixture | fill | source | fillLuma | warning |
| --- | --- | --- | --- | --- |
| `x-tweet-light` | `#F7FAFC` | sampled | 249.3 | near-**white**, no visible edge on a light background |
| `ig-feed-light` | `#F6F4EF` | **fallback** | 244 | edges disagreed by 19 (> 12); using the neutral frame |

Both trimmed 93 status-bar rows, out `1080x2143`. Two things worth having:

- **The near-white warning fires.** It is the counterpart of the near-black one
  and had never been seen; the luminance branch in `planOutput` works in both
  directions on real input rather than only on a synthetic.
- **The fallback path ran on a device for the first time**, and it agrees with the
  desktop predictor *to the sentence*: `tools/probe.mjs` had said
  `FALLBACK #F6F4EF  edges disagree by 19 (> 12)` before the phone was involved.
  That is the tile-grid sampler from defect 5 executing on the device and
  reaching the same verdict as the pure implementation. `planMs` rises to 121ms
  when it fires, against 15-32ms when the edges agree, which is the tile grid
  being read.

The light card's padding is **exactly** `#F6F4EF` across all 360412 pixels
outside `dest`, and this is the first card where the frame is *visible*: a warm
off-white mat around a white Instagram header.

**A design question it exposes, recorded rather than fixed.** The edges disagreed
because the crop's top and bottom edges land on Instagram's white chrome
(`#FFFFFF`) while its left and right edges land on the cream post body
(`#FBF7EC`). The disagreement is real, and the fallback's answer — the brand
neutral — is *safe* but not *matched*: the body cream would have been a better
frame and was sitting right there on the two long edges. A rule that preferred the
long edges' modal colour over the neutral would have found it. Whether that is
better in general is exactly the kind of judgement that needs more than two light
captures, so it is written down here and not coded.

### The density gate, simulated on one device

The Phase 1 gate in `BUILD-PLAN.md` asks that the same source screenshot produce
the same card on two devices of different density. There is only one device, so
the density was overridden with `adb shell wm density` — a real configuration
change: the app re-laid out, and `Render` moved from y=1787 to y=1208 at 320 and
y=2409 at 640.

Same fixture, same PNG pulled and hashed each time:

| override density | card | sha256 (first 16) | bytes |
| --- | --- | --- | --- |
| 320 | 1080x2146 | `f4f24a280ad50c81` | 625660 |
| 476 (the device's own) | 1080x2146 | `f4f24a280ad50c81` | 625660 |
| 640 | 1080x2146 | `f4f24a280ad50c81` | 625660 |

**Byte-identical across a 2x density range.** Three points rather than two,
because a pair cannot tell a flat response from a coincidence. The same hash also
appeared on the run from before the `rowInkProfile` rewrite, so that optimisation
is confirmed output-preserving on real input as well as on the test buffers.

What this is and is not evidence for:

- It **is** the gate's claim, and stronger than the gate asked: the gate wants
  equal dimensions and pixels within tolerance, and this is byte-identity. That is
  available only because it is one device and therefore one encoder build; across
  two real devices the encoders can differ in filtering and chunk order, so
  dimensions-plus-pixels would remain the right assertion.
- It is **not** evidence about a second GPU, a second Skia build, or a second
  Android skin. A density override changes layout, not the renderer.
- It is **not** true of the masked path. `renderCard`'s crop and masks are in
  *image* pixels, which is why the unmasked card cannot vary — but the Cover box
  comes from `App.js`'s `boxInImageSpace`, which divides by a view-space fit
  computed in density-independent units. The same on-screen box covered a
  different region at each density: ring coverage `0.7914` at 476 against
  `0.7845` at 640. That is not a bug in the pipeline and it is a real constraint
  on Phase 2: **a crop or Cover rect is only meaningful together with the
  viewport it was drawn in**, so either must be stored in image pixels the moment
  it is committed.

**What the override cost the owner, which no one should pay twice.** A density
change makes the launcher migrate its workspace grid, and the icons that do not
fit the smaller grid are dropped. Restoring the density does not restore them:
the migration has already written `launcher.db`, there is no overflow page to
recover them from, and the backup table Launcher3 keeps for exactly this rollback
sits in the launcher's private data — unreachable on a stock Pixel, which has no
root and whose launcher is not debuggable. The apps stay installed; only the
placements go, and the only record of what was where is a screenshot nobody took.

So: **capture the home screen, every page, before overriding density**, and
treat that as part of the procedure rather than a nicety. This gate does not need
re-running — the table above is the answer — but anything else that changes a
device configuration should budget for the same class of damage.

**A configuration-change bug found on the way, and it is the product's, not the
harness's.** After a density change the picker throws:

```
Error: Call to function 'ExponentImagePicker.launchImageLibraryAsync' has been rejected.
→ Caused by: java.lang.IllegalStateException: Attempting to launch an
  unregistered ActivityResultLauncher with contract
  expo.modules.imagepicker.contracts.ImageLibraryContract
```

The activity was recreated and `expo-image-picker`'s `ActivityResultLauncher` did
not re-register. A density override is an unusual way to trigger it; **rotation, a
font-size change and a light/dark switch are not**, and any of them would leave a
user with a Pick button that silently rejects until the app is restarted. It
surfaced here as an unhandled promise rejection, which is a second small defect:
`App.js`'s `pick()` wraps the decode in `try/catch` but not the launch.

### Q4, answered: P3 is tagged, sRGB is not

Same fixture, same geometry (`1080x2146`, crop `y:89`, `dest` identical), 530ms.
`tools/chunks.mjs` on the two cards:

```
### default (no colorSpace) ###
  chunks  IHDR sBIT IDATx77 IEND
  colour  UNTAGGED — a viewer will assume sRGB

### colorSpace: DisplayP3 ###
  chunks  IHDR sBIT iCCP IDATx77 IEND
  iCCP    name "Skia", chunk 290B, profile 520B
          ICC mntr RGB->XYZ intent 1
          primaries R 0.5151,0.2412,-0.0011 G 0.292,0.6922,0.0419 B 0.1572,0.0666,0.7844
          space by primaries: displayP3
  colour  tagged: iCCP
```

The primaries are Display P3's D50-adapted colorants to four decimal places, which
is why `chunks.mjs` identifies the space from them and not from the profile's name:
Skia calls this one "Skia" too.

**And the P3 render is a real conversion, not a tag bolted onto the same bytes.**
Diffing the two cards channel by channel: **961238 of 6953040 channel samples
differ**, max delta 83, mean 4.79 over those that differ. So the wide-gamut path
re-encodes the pixels and ships the profile that makes them mean what they say.

The asymmetry is the finding worth carrying forward: a P3 card travels with its
profile, an sRGB card travels on convention alone. That is fine for a viewer that
assumes sRGB and wrong for one that assumes the display's own space. The product
should decide whether to write an sRGB `iCCP` explicitly rather than inherit
Skia's default of writing nothing, and `renderCard` cannot currently be asked to.

### The eye check, and the warning being right

The three cards are kept at `results/cards/`. Looked at: the status bar is gone,
the content is whole, the padding is even on all four sides, and **the seam is
invisible** — pad `#000000` against a near-black timeline, which is exactly what
`the frame is near-black; it will have no visible edge on a dark background` says.
So Q1's "is the seam visible" question is answered *for a dark capture*: no, and
the pipeline predicted it.

Still not answered for a **light** capture, which is the case where the seam is
supposed to show and where a wrong fill would be obvious. Both fixtures rendered
here sampled `#000000`; nothing light has been through `renderCard`.

One thing visible in the card that is not a defect: a one-pixel white sliver on
the right edge partway down, which is the source screenshot's own scroll
indicator, cropped in with everything else.

### The result-preview guard, tested rather than read

Defect 6 added `showingResult` and disabled every box-reading button while a
result is shown. On the device the state line reads
`... uncovered — showing RESULT, box hidden`, and **`uiautomator dump` reports
`Render + cover` as `enabled="true"`** — React Native's `disabled` prop does not
project into the accessibility node here. Tapping it anyway while the result was
shown produced **zero** `P1.render` lines, so the guard is real and only its
accessibility state is missing. Worth recording because the dump is the obvious
instrument to check a guard with, and on this stack it answers wrongly.

## What it deliberately does not decide

Nothing. Every judgement lives in `plan.js`, `sizing.js` or `pixels.js`, which is
what keeps them testable without a device — 99 checks and 17 mutations on `plan.js`
alone. The rule the file states about itself: *if a question here has a right
answer that does not depend on Skia, it does not belong in this file.*

## Twelve defects found in review, and what they were

Three review passes found twelve between them. All were real and all are fixed.

The first three share one underlying mistake: a decision living in the renderer
where it could not be tested. The rest are different and worse in a way worth
naming — in most of them a **test or a tool was passing while the thing it
guarded was broken**, which is the failure that costs the most because it
converts doubt into false confidence. Six of the twelve are of that kind, and the
third pass found four of those six, which is the argument for a third pass.

One pattern is worth stating on its own, because it recurred across passes: a
defect was fixed in one code path and left standing in a second path with the
same shape. The whole-crop background read was fixed while the Cover ring read —
the same mistake, two hundred lines away — survived two passes. When a fix is
written, the question to ask is which other caller does this too.

### 1. Cover boxes were not clamped to the crop

A box is dragged over the on-screen image, so the gesture is clamped to the
**image**. The crop is smaller, and can be trimmed *after* a box is placed. Mapping
such a box straight into output coordinates draws it over the padding: a grey
rectangle sitting on the frame, which is the most visible possible defect in a
product whose entire output is a framed picture.

Fixed with `clampMasks(masks, crop)` in `plan.js` — pure, so the property is
asserted directly ("no kept box escapes the crop"), and boxes with no overlap are
**dropped and reported** rather than silently drawn somewhere wrong. `composeCard`
also `clipRect`s to the destination, but that is defence; the clamp is the rule.
`BREAK=no_mask_clamp` and `BREAK=mask_keep_outside` cover both halves.

### 2. Mask mapping used `plan.scale`

`plan.scale` is the scale *before* rounding. `dest` is an integer derived by
subtraction, so the scale the image is actually drawn at is `dest.w / crop.w`.
Using the former puts Cover boxes progressively off-target the further they are
from the crop origin.

Fixed with `maskToDest`, which derives the scale from `dest/crop`. The test needed
an input where the two genuinely diverge — `904x904` at `roomy` — plus an
assertion that they diverge for that input, because otherwise the check would pass
under the bug. `BREAK=mask_scale_from_plan`.

### 3. EXIF orientation was applied as a canvas transform

The worst of the three. `composeCard` rotated the canvas before drawing, which
also rotated the destination rect and the Cover boxes — and for a 90° rotation the
planned output size was still the *un-rotated* one, so the picture would have been
rotated inside a card shaped for the wrong aspect.

Fixed by baking orientation into a new image **before planning**
(`normaliseOrientation`), so everything downstream is orientation-free and cannot
get it wrong. Costs one extra surface, only when orientation ≠ 1. The pure part —
that orientations 5-8 exchange width and height — is `orientedSize`, tested at all
eight values. `BREAK=no_swap`.

Orientations 5 and 7 are transposed diagonals and are implemented but have never
been seen in the wild here; they are the least trustworthy lines in the file.

### 4. Rectangles were clamped field by field, not intersected

In three files at once: `clampCrop` in `plan.js`, `regionBackground` in
`pixels.js`, `clampRect` in `pipeline.js`. Each moved the origin up to 0 and kept
the width, which **grows the rect by whatever hung off the edge**:

```
asked for  {-10, -20, 30, 40}
got        {  0,   0, 30, 40}   <- 30 columns, 20 of them requested
intersect  {  0,   0, 20, 20}
```

For a crop that means rendering a card of content the user did not select. For
`regionBackground` it means estimating the background from columns nobody asked
about.

**Why the tests did not catch it, which is the more useful half.** The only
clamping input tested was `{-50,-50,9999,9999}` — overshooting every edge at once.
There, clamping each field and intersecting produce the *same* answer, so the
assertion could not distinguish the rule it was checking from the bug. Partial
overlap is the discriminating input and nothing exercised it.

The new tests assert partial overlap in both directions, and also assert *that the
two rules differ on that input* (`check('the two rules really do differ...')`) —
without that line, a future simplification could quietly make the case
non-discriminating again and everything would still pass. `BREAK=clamp_fields`
restores the original implementation verbatim; `BREAK=region_clamp_fields` does the
same in `pixels.js`.

**Closed 2026-09-17, and the shape deleted rather than fixed a fourth time.** The
fourth copy in `measure.js` was held back on purpose so Q1 could be re-run as a
control; that is done, and results/phase0-device.md carries the comparison. Q1's
five statistics reproduced exactly and its `bytesRead` fell from 2,292,480 to
1,604,736, because the published run *had* been hitting the defect — the default
box logs at x=-781, off the left edge, and the old clamp read 432 columns nobody
asked for.

Four copies of five lines is what let it survive four separate fixes, so the
geometry now lives once, as `intersectRect` in `pixels.js`, and `clampCrop` and
`regionBackground` delegate to it. The two `clampRect` wrappers this sentence
used to name — `pipeline.js`'s and `measure.js`'s — no longer exist at all: the
cleanup pass below found that both sat inside a `readRect` that was itself
duplicated, and merged the pair into `src/read.js`, which calls `intersectRect`
once for both. So the count of copies went four to one and then, a day later,
five to one. `clampCrop` keeps its throw and the sampling callers keep their null, because
whether "no overlap" is a bug or simply nothing to read is the caller's business
and the only part that differed. One shared function also means one place to
mutate: `isect_clamp_fields` restores the field-by-field rule, `isect_never_null`
restores the 1px-sliver answer, `isect_transpose` swaps the bounds (caught only
because the assertions use a 140x37 image, not a square one) and
`isect_unrounded` drops the rounding.

`clampMasks`, written later, had always done a true intersection. Two rules for one
geometric question in one codebase is the thing that made the inconsistency
visible, and is itself the finding.

### 5. The fallback background sample read the whole crop

`sampleCropBackground` reads four thin edge strips — and when they disagree, the
fallback called `stripBackground(img, crop, ...)`: a `readPixels` of the **entire
crop**, 82.4MiB of RGBA on a 1080x20000 capture. The subsampling `step` reduced the
loop, not the allocation.

Three things made this worse than a slow path:

- It is in the file whose **first stated rule is never to read a whole image**, and
  this document's "Memory discipline" section previously described the fallback as
  deferred behind a closure — true, and beside the point. What was deferred was the
  82MiB read.
- The fallback is **not rare**: 6 of the 12 crops in
  `results/phase1-card-background.md` take it, and every off-centre crop did.
- The read was never needed at that size. Its result feeds exactly one decision:
  `luma(mean) < 128`, Ink or Paper.

Fixed with `tileGrid` in `pixels.js` — a grid of 48px tiles spread over the crop,
read one at a time. On 1080x20000 that is 60 tiles, 0.64% of the pixels, and a
**peak read buffer of 9KiB against 82.4MiB**. Spread out rather than one region
because a single sub-rect can land entirely on a photo; a majority of tiles sit on
whatever is dominant, which is what the modal estimator then finds.

The desktop path uses the same `tileGrid`, because if the two sampled different
rects then `tools/probe.mjs` would stop predicting what the device does.

**Control, before anything was built on it:** all 12 published crops reach the
identical verdict — same source, same fill, same edge diffs. One number moved,
and it is recorded rather than smoothed over: the IG-handwriting whole-crop
fallback luma went from 253.4 to 253.0, on the same side of the only threshold it
feeds. `BREAK=tiles_whole` restores the whole-crop read and `BREAK=tiles_one`
collapses the grid to a single central tile; both go red.

### 6. The result preview kept the source's coordinate mapping

Not in the pipeline — in `App.js`, which is how the pipeline is driven, so it
would have corrupted every measurement taken through it.

After a render, the canvas shows the **card**: trimmed, padded and rescaled. The
Cover box overlay stayed live, and `boxInImageSpace` converts view coordinates to
**source** pixels. So the box sat over one image and reported a rectangle in
another, and a second "Render + cover" would have covered a region other than the
one selected — while looking correct on screen.

Fixed by separating the two previews rather than by inverting the transform: a
`showingResult` flag hides the box and disables every button that reads it, and
"Back to source" is the only way back. The full source-to-preview transform and its
inverse is the other option and is what the real app will need for re-editing; for
a spike whose job is to produce trustworthy measurements, the cheaper fix that
cannot be subtly wrong is the better one.

### 7. The Cover ring was read as the whole box, again

`maskFill` asked for the box's padded bounding rectangle in one `readPixels` and
handed it to `ringBackground`, which scanned the ring and skipped the interior —
so the interior was read and then discarded. The cost was the area of the BOX,
not of the ring.

This is defect 5 in a second location. That one was found and fixed in the
background fallback; this one sat in the Cover path through two review passes
because the fix was applied where the defect was reported rather than everywhere
the pattern occurred.

Measured on the read rectangles themselves, which is the thing that was wrong —
a bounded tile generator says nothing about this path:

| Cover box on a 1080x20000 source | requested read |
| --- | --- |
| the whole image, as one padded rect (before) | 21557844 px, **82.2MiB** |
| inset by 1px, as four strips (after) | 42156 px, **165KiB** |
| 800x9000 partial box, as four strips | 117744 px, **460KiB** |

`ringStrips` in `pixels.js` returns the ring as up to four non-overlapping
rectangles: top and bottom take the full padded width including the corners,
left and right take only the box's own rows. It is pure, so it is tested without
Skia, and it is held to a brute-force enumeration of the pixels `ringBackground`
scans rather than to a description of them — at nine box positions including
every edge, both corners, both aspect orientations and a single pixel, because a
strip layout with a sign error is invisible on a centred square box.

The estimator's answer is unchanged, and that is asserted rather than assumed:
accumulating the strips and calling `modalOfPoints` gives the same sample count,
fill, coverage and spread as `ringBackground` over the full region, on an image
with ink in the ring and a different colour inside the box, so a layout that
leaked interior pixels or double-counted corners would move one of the four.

A box covering the whole image now returns `null` — no surround exists to sample.
That is a real case, since a Cover box can be dragged over everything, and the
caller must read it as "no answer" rather than as a black background.

### 8. The colour verdict tested one failure flag out of four

`colourVerdict` decided soundness from `c.invalid` alone. The parser could set
three other failure flags, and a file carrying any of them was reported
`sound: ["iCCP"], tagged: true`:

| input | flag the parser set | what the verdict said |
| --- | --- | --- |
| chunk declares bytes absent from the file | `truncated` | tagged |
| payload inflates to 18 bytes | `iccInvalid` | tagged |
| header's size field disagrees with the payload | `iccSizeMismatch` | tagged |

This is the worst of the twelve, because `tools/chunks.mjs` is the instrument
that closed Q4. A validator that answers "sound" to malformed input cannot be
quoted about a file that is sound. Q4's answer survives only because
`identifySpace` reads the colorants down a separate path, and re-running the tool
after the fix reproduces both published verdicts unchanged — the default card
`UNTAGGED`, the P3 card `tagged: iCCP` identified as Display P3 by its primaries.

The file's own doc comment already claimed this class of bug had been fixed
("three distinct states, because they were one and it hid two failures"). It had
been, for one flag. There is now a single `colourProblem` that every flag must
pass through, and the tests pin each flag separately, because one mutation
covering all four would still pass with only one of them wired up.

**A correction to the test file's own claim, too.** Its header said it covered a
truncated `iCCP`. It covered a *complete* chunk with an empty payload, which is a
different shape and not the one that escaped. Five malformed shapes are now built
as actual files, and a conforming profile is built by the same builder as the
positive control — without which every new assertion would also pass if the
stricter checks rejected everything, the card this project writes included.

One format detail worth recording, because the first proposed fix had it wrong:
an ICC profile does not begin with the bytes `ICC_PROFILE`. That string is the
APP2 marker identifier JPEG uses to package a profile. The profile's own
signature is **`acsp` at byte offset 36**, and that is what is checked.

### 9. A thin crop planned a card with nothing to draw into

`cardSize` rounds `width`, `height` and `pad` independently, and for a very thin
crop the padding catches up with the whole card:

```
crop 1440x1  ->  card 1080x116, pad 58, dest 964x0, warnings []
```

2 x 58 is exactly 116. The planner accepted it, reported no warning, and
composition had no row to draw into.

Bounded rather than taken as one instance, because the reach decides the
severity — swept over 34920 crops across all three padding stops:

| crop height | degenerate results |
| --- | --- |
| 1 | 412 |
| 2 | 148 |
| 3 | 40 |
| 4 | 4 |

Nothing at 5 or above. **And it is one-sided**: a crop thin in the other
direction (`1x1440`) is fine, because only the axis that gets scaled collapses.
Any test built on square-ish input would never have seen it, which is the general
lesson — the asymmetric case is where a rounding defect lives.

The repair grows the card rather than shrinking the padding, since the padding is
what the caller asked for and the height is free; the width axis is capped at
`TARGET_W` and so gives up padding instead. One integer `pad` still serves all
four sides, so the margins stay equal by construction. `repaired` names the axis,
and a warning is emitted.

Not reachable from the detector, which never emits a crop this thin. It becomes
reachable the moment Phase 2 hands the crop to a thumb, and a thin drag is the
easiest gesture to make by accident. The sweep is the assertion, plus pinned
numbers from the real 1440x3031 capture so the repair cannot quietly alter the
card whose sha256 the density gate rests on.

### 10. The picker launch sat outside its own error boundary

`launchImageLibraryAsync` ran above the `try`, so its rejection escaped as an
unhandled promise and the button stopped working with nothing on screen. The
failure is not hypothetical — it is the configuration-change bug recorded above,
reproduced when the density override recreated the activity.

It now reports under `pick.error`, deliberately a different label from
`decode.error`. One says the picker never opened and the other says it returned
something unreadable, and reporting both as a decode failure is what made the
first look like a bad file. Catching it does not re-register the launcher;
restarting the app does.

### 11. The import gate passed code that could not compile

While fixing defect 7, `modalOfPoints` was added to an import list in
`pipeline.js` that already contained it. `tools/check-imports.mjs` printed

```
39 named imports across 6 files all resolve
```

and exited 0. The file was a `SyntaxError` — "Identifier 'modalOfPoints' has
already been declared" — and no bundle could be produced from it. Metro caught
it; the gate did not, because resolving each name separately says nothing about
the list as a whole.

That is precisely the failure this repository keeps finding: a green from a gate
that could not go red. The gate now tracks the names each file has already
imported and reports a duplicate as a problem, and it was observed exiting 1 on
the real duplicate before the duplicate was removed.

`node --check` does not help here either — `App.js` is JSX, so it cannot parse
it. The honest syntax gate for this project is a Metro bundle, and that is now
how an `App.js` edit is checked: `curl` the bundle endpoint and require HTTP 200.

### 12. This document contradicted its own evidence

"What is left in Phase 1" still read *"Run it. The buttons exist; the phone was
unplugged. Nothing below this line has been observed"*, and listed PNG validity
and the P3 tag as outstanding — with the runs, the pulled bytes and the answered
Q4 documented above it in the same file. The verification table carried the test
counts from before two rounds of additions, and described the Cover edge in its
pre-fix state.

Low severity and the most likely to cost someone a day, because a hand-off
document is what the next reader trusts instead of re-deriving. The counts are
now taken from a run of every suite rather than written alongside the code that
changed them.

## What each Cover box is filled with

The modal colour of **its own ring**, not the card background. Those differ
whenever a box sits on chrome that is not the card's edge colour, which is most of
the time. `maskFill()` reads a sub-rect around the box and calls `ringBackground`.

`coverage` comes back with it and is surfaced as a warning below 0.6, because a low
value means *the box is misplaced*, not *the background is rough* — two problems
that want opposite responses, and the reason `ringBackground` returns coverage at
all.

## Memory discipline

Every `readPixels` in the file is a sub-rect, and as of the fifth defect above that
is now true of the fallback too. The background sampler reads four thin edge
strips; when they disagree it reads a grid of 48px tiles rather than the crop.
Peak read buffer on a 1080x20000 capture: **9KiB**.

This section previously said the fallback's whole-crop read was "deferred behind a
closure, so a crop whose edges agree never pays for it". Every word of that was
true and it described an 82.4MiB read as though deferring it were the same as not
doing it. A rule stated in a file's own header is not evidence that the file
follows it.

Making that possible needed a refactor of `pixels.js`: the four-edge agreement rule
was inlined in `cropBackground`, which takes one whole buffer. It is now
`decideCropBackground(edges, sampleWhole, opts)` — the decision separated from
where the pixels came from — with `cropEdgeStrips()` naming the four rects so the
device reads the same strips the desktop probe does. The alternative was a second
copy of the agreement threshold for the Skia path, and two copies of a threshold
is two thresholds.

The refactor was confirmed behaviour-preserving before anything was built on it:
63/63 checks still passed, all 19 mutations still went red, and `tools/probe.mjs`
reproduced every figure in `phase1-card-background.md` exactly. (Those were the
counts at the time; the suite is larger now.) The tile-grid change in defect 5 was
put through the same control, with the one moved number recorded there.

A full 82.4MiB read measured fine on the Pixel 6 Pro, which is exactly why it is
tempting and exactly why it is not the habit: that ceiling is one driver's number.

### Cleanup pass, 2026-09-17: two copies, seven empty exports, and a fourth hole

No review prompted this one; it was a sweep for unused artefacts and duplicated
code. It found more than expected, and two of the finds were in the instruments
rather than in the product.

**`readRect` was the fifth copy of the same shape.** The `intersectRect`
consolidation a day earlier had folded four copies of a rect intersect into one.
It did not catch `readRect`, which wraps that intersect with a `readPixels` and
an ImageInfo, and existed twice — `measure.js` and `pipeline.js`. The two were
not merely duplicated, they returned **the same values under different field
names**: `{buf, rowBytes, w, h, rect, bytes}` in one and
`{buf, rowBytes, width, height, rect}` in the other. That is worse than a plain
duplicate, because a reader who knows one file's shape reads the other one
wrong.

Both now delegate to `src/read.js`, which takes the colour constants as an
argument and so imports no Skia. That is what made the merge worth doing beyond
tidiness: the shared body **loads in node and has a test for the first time**,
52 checks and 6 mutations, on a deliberately non-square 140x37 image and a
1,296-rect sweep across all four quadrants. Neither copy had ever been tested,
and the argument for that — "it is just a readPixels call" — was wrong: the rect
arithmetic, the origin translation and two null paths are all in there, and the
rect arithmetic is where the clamp defect lived for four days in four files.

**The rename nearly silenced a guard.** `measureRoundTrip` compared
`a.w !== b.w` to detect dimension drift between a card and its re-decoded self.
Adopting the shared `{width, height}` shape would have made that
`undefined !== undefined` — false for every input, forever, with nothing
failing. A guard that stops firing does not announce it. Renaming a returned
field is exactly how that happens, and no gate in this repo would have caught
it; it was found by grepping every use of the merged result's fields, which is
the only reason it is a footnote instead of defect 15.

**Seven `export`s in `pipeline.js` had no importer and could not have had one.**
`decodeImage`, `normaliseOrientation`, `findStatusBar`, `sampleCropBackground`,
`sampleFallbackTiles`, `composeCard` and `maskFill` were each called only from
inside the file. Nothing imported them, and nothing could: the module imports
Skia, so it cannot be loaded anywhere a test could reach it, and `App.js` takes
only `renderCard` and `decodeUri`. One of them carried a doc comment naming a
caller — "`decodeImage` stays for callers that already hold bytes" — that did not
exist and never had. All seven are now internal; re-exporting one is a single
word if a device harness ever wants to time a stage on its own.

**`MEASURED_SURFACE_MAX` was a comment wearing a constant's clothes.** Exported
from `sizing.js`, referenced by nothing, and its own note said it is "the number
to check first if `TARGET_W` or `MAX_H` ever grow". That check is now an
assertion: `MAX_H` must stay under the measured ceiling with the 2x headroom the
device measurement claimed, so raising it fails a test instead of producing an
output size the driver answers with a null surface.

**`WARN_H` and its message had drifted apart.** The comparison used the
constant; the warning text said `taller than 4000px` in prose. Lowering `WARN_H`
would have produced a warning naming a height nothing compared against — and
`sizing.test.mjs` asserted on the literal string `'4000px'`, so the test would
have kept passing while the message was wrong. The number is interpolated now
and the assertion is against the constant, with `warn_hardcoded` restoring the
coupling.

### And a fourth hole, one module wide

`tools/check-imports.mjs` reached its fourth defect, and it was waiting before
this session started. Its `OURS` list of own-module names was **hand-typed**:

```js
const OURS = ['pixels', 'plan', 'sizing', 'measure', 'pipeline'];
```

Adding `src/read.js` put two `import { readSubRect } from './read'` statements
into the tree. `ourModuleName('./read')` returned null, both imports were
**silently skipped**, and the gate printed that every named import resolves.
Not a failure — a skip, which is the quieter of the two.

This is the same root cause as the gate's *first* hole. That one globbed
`src/*.js` and so missed `App.js`, and it was fixed by adding `App.js` to a
list. A list a person maintains is a list that falls behind, and fixing a
derivation bug by typing the missing entry is how the same defect returns under
a different name. `OURS` is now read from the directory.

The mutation is `ours_missing_module`, and writing it exposed the familiar
second-order problem: with the stale list restored, nothing is reported, so the
gate exits **0**. A mutation that cannot go red, in the file whose entire
subject is gates that cannot go red — for the second time in this one file. The
fix is to assert the coverage rather than the result: every relative import in
every scanned file must resolve to a module the gate can read. Under the
mutation that assertion names both skipped imports and exits 1.

`tools/check-dead.mjs` hit the identical shape while being written. Its
`own_file_counts` mutation was inline at the call site, and every module
mentions its own exported name in its own `export` line, so counting the
defining file made everything live and nothing was reported: exit 0 again. The
decision is now a named `isDead()` the self-test asserts against a two-file
fixture. Third occurrence of this shape in this repo's tools, which is enough to
call it the default failure rather than an accident: **a mutation belongs on a
named decision, never at a call site the self-test cannot reach.**

The new gate had two earlier wrong answers worth recording, both from commands
that ran and exited cleanly. It first matched names with
`new RegExp('\\b' + n + '\\b')` written through a bash heredoc that ate the
backslashes, making `'\b'` a literal backspace character; every pattern matched
nothing and it reported **64 dead exports out of 64**. A gate that cannot pass
reads exactly like a gate that cannot fail, and the only reason it was caught is
that `renderCard` is obviously imported by `App.js`. It then counted a mention
anywhere in another file, comments included — and this repo's comments name
functions constantly, so `findStatusBar` read as live on the strength of one
sentence in `pixels.js`. Comments are stripped now, and the self-test asserts
that, because it is the entire difference between the two answers.

Finally, the README's own mutation loop — the one immediately below a paragraph
warning that hand-written lists fall behind — matched `BREAK === ` only, so a
mutation written `BREAK !== ` was never run, and it listed the five suites and
neither gate. Both fixed; the loop now runs 84 and was executed verbatim from
the README before this was written.

## Verified, and not

| | |
| --- | --- |
| release signing | `plugins/withReleaseSigning.js`, 37 checks and 12 mutations, every mutant an edit to the real plugin source rather than a stub — see "The release build" below. 34 of the checks run without a generated `android/`, and the other 3 report as skipped rather than vanishing into a green total |
| APK size | `plugins/withAndroidSize.js`, 39 checks and 8 mutations. Three Gradle properties that took the signed APK from 124,548,439 to 32,886,141 bytes (the shipped v1.0.0 is 32,886,397: same packaging, two later bug fixes in the bundle). Every defect this plugin can have is silent — a wrong value builds a working APK of the wrong size, and nobody looks at an APK size until they try to send it — so it re-reads what it wrote and throws on any disagreement. See "Making the APK small enough to send" in README for the measurements, and for the two settings that fail by doing nothing rather than by erroring |
| update check | `src/update.js`, 84 checks and 10 mutations. Reads a manifest off the network and decides whether to offer a download. Fourteen hostile URLs are enumerated individually against the one-prefix allowlist, because a single "rejects a bad URL" check would pass while thirteen of them still got through |
| fs sync | `tools/check-fs-sync.mjs`, 11 self-checks and 1 real-source mutant. Fails on an expo-file-system member called as if synchronous. It exists because the defect was made twice: found on device, fixed, and written into a comment in `App.js`, then written again into `src/update-io.js` by someone who had read that comment. The trap names are derived from the library's own Kotlin module, so the list cannot go stale on an upgrade — a hand-typed list would be the same defect one level up |
| **totals** | **686 checks, 123 mutations, every one observed failing.** Counts taken from a run of all ten suites and all four gates, not written from memory — they had gone stale in this table five times now (446/84, 510/93, then 526/102, then 669/120). **A clone runs 674 and reports 12 skipped**: 7 need an unpublished capture, 5 need a generated `android/`. Both figures are from runs, not arithmetic: the clone number was computed once and was wrong by twelve, so it is now measured against a tree built with `git ls-files -co --exclude-standard`, which is what a clone actually contains |
| `plan.js` decisions | 99 checks, 17 mutations all observed failing |
| `pixels.js` | 168 checks, 32 mutations; every refactor confirmed behaviour-preserving against a reference implementation kept beside it |
| `sizing.js` | 60 checks, 10 mutations; `MAX_PX`'s slack asserted, since it cannot fire; the measured Skia surface ceiling asserted for the same reason; the degenerate-destination family swept, not sampled |
| **Q1 re-run as the control** | **run on the device** after `measure.js`'s clamp was fixed: all five statistics identical to the published figures, `bytesRead` 2,292,480 -> 1,604,736. The published run had been hitting the defect, which this table's own caveat denied; the arithmetic is in `results/phase0-device.md` |
| the rect geometry | one `intersectRect`, four call sites delegating to it; asserted on a 140x37 image so a transposed bound cannot pass, and swept over 9280 rects in all four quadrants |
| peak fallback read | bounded by assertion, not by comment: 9KiB on a 1080x20000 crop |
| peak Cover ring read | bounded on the **read rectangles**: 165KiB where it was 82.2MiB, and a whole-image box returns `null` rather than sampling nothing |
| named imports | `tools/check-imports.mjs`, **46 across 8 files** plus 7 self-checks on its own rule; proven to go red on a typo in each of its two modes, on a pure module that fails to load, on a name imported twice, on the duplicate rule comparing the wrong name, and on its own module list going stale. This row said 38 for three passes while the gate printed 39, then 41, then 42 |
| dead exports | `tools/check-dead.mjs`, **66 exported names across 26 files**, none unused outside its own module, plus 7 self-checks. It found seven empty `export`s in `pipeline.js` and one exported constant referenced by nothing at all. The count jumped from 57/22 partly because a review found the rule **structurally blind to CommonJS**: `plugins/withReleaseSigning.js` was in the file count and contributed zero names, so the gate reported "all 62 are used" while unable to see four of them — one genuinely dead. It now reads `module.exports.X` too, and refuses to pass on a zero count |
| the shared sub-rect read | `src/read.js`, 52 checks and 6 mutations — the first either copy has ever had, since both lived in files that cannot load in node. **Re-run on the device 2026-09-18 and byte-identical**: same `sha256 f9fbb1b4…`, same 584991 bytes. Both callers were re-measured, not only the pipeline — see "The fourth run" below |
| `App.js` syntax | a Metro bundle at HTTP 200, since `node --check` cannot parse JSX |
| PNG chunk reader | `tools/chunks.test.mjs`, 51 checks, 10 mutations; five malformed ICC shapes each built as a file and each reported untagged, with a conforming hand-built profile as the positive control |
| the `acsp` signature | checked at offset 36, and Skia's own profile confirmed to carry it |
| the Cover box mapping | only ever applied to the image it was drawn over; the result preview disables it |
| Cover box pixel snapping | outward then intersected with `dest`; on device, 306 leaked pixels became **0** |
| the `rowInkProfile` rewrite | held to `rowInkProfileNaive` exactly, 16 buffer/step combinations; and the card's sha256 is unchanged from before it |
| **the density gate** | **three densities over a 2x range, byte-identical card**; one device, so not evidence about a second GPU or encoder |
| the light fill branch | two light captures rendered; sampled and fallback both correct, near-white warning fires |
| the fallback sampler on device | agrees with `tools/probe.mjs`'s prediction to the sentence |
| **`renderCard()` end to end** | **run twice on device**, 1440x3120 real capture through a `content://` URI; 550ms and 533ms |
| the written PNG | pulled byte-exact (sha256 matched the device's) and decoded with `tools/png.mjs`; geometry matches `dest` to the pixel |
| Cover boxes on device | run; **306 leaked boundary pixels became 0** after outward pixel snapping with anti-aliasing off. The ≤53/255 boundary this table used to report was the pre-fix measurement |
| the `showingResult` guard | tapped while a result was shown: 0 renders |
| **`maskFill`'s four strip reads** | **run on the device**, and the card is byte-identical: `sha256 f9fbb1b422193f609599f47ba524a8cc4059cc41ec5c77d02101bd632d1d1ff8`, 584991 bytes, the same hash on the device, on the pull and on `results/cards/card-covered-aa-off.png`. Same crop `{0,89,1440,3031}`, pad 58, dest 964x2030, mask coverage 0.7914 clipped. The four `readPixels` calls that replaced the one therefore agree with it on real Skia output, not only against `ringBackground` in the tests. To reproduce: fixture `x-timeline-statusbar.png`, Cover box left where it starts — the byte comparison is only meaningful if nothing dragged it |
| `pick.error` on device | **run**, and the catch holds: the launch was rejected, the label was emitted, and the app stayed up with its other buttons live. Provoked with `settings put system font_scale 1.15`, because `MainActivity`'s `configChanges` lists `orientation` and `screenSize` but not `fontScale` — so rotation is absorbed and a font-scale change is the cheap recreation. It is also the *safe* one: `wm density` recreates the activity too and destroys the launcher's workspace layout doing it. The exception, verbatim: `java.lang.IllegalStateException: Attempting to launch an unregistered ActivityResultLauncher with contract expo.modules.imagepicker.contracts.ImageLibraryContract`. Restoring the font scale does not re-register it; restarting the app does, as the note claims |
| the colour tag on the default output | measured: **none**. `UNTAGGED`, sRGB by convention only |
| **Q4, the P3 tag** | **closed**: `colorSpace: DisplayP3` writes an `iCCP` whose primaries are Display P3's, and re-encodes 961238 channel samples |
| orientation ≠ 1 | never executed; no input has the tag |
| **WhatsApp** | **never sent, and will not be from here.** The output spec was chosen against WhatsApp's recompression and that choice is therefore still an assumption, not a measurement — see below |
| a second device, GPU or Skia build | not available; the density ramp is not a substitute |
| the Cover box across densities | measured to **differ** (coverage 0.7914 at 476dpi, 0.7845 at 640dpi) — correct behaviour, and a constraint on Phase 2 |
| rotation vs font-size as recreation triggers | **both settled, and they differ.** A font-scale change recreates the activity and reproduces the picker failure (see the `pick.error` row above); **rotation cannot**, because `MainActivity` declares `orientation|screenSize` in `configChanges` and absorbs it. This row used to say both were untested and group them with the density change, which contradicted the row above it and was found by a review pass, not by the grep that was supposed to catch it — that grep searched for "not run", and this row said "not tested" |

## The import gate had a hole, and it was where the new import went

`tools/check-imports.mjs` globbed `src/*.js` only. `App.js` is outside `src/`, is
the consumer of every module in it, and is where `renderCard` was imported from
`./src/pipeline` — so the one import added this session was in the one file the
gate did not read. A gate that only watches the files that *export* is half a
gate.

Extending it exposed a second problem: `App.js` imports `pipeline.js`, which
imports Skia, which cannot be loaded in node — so the module most in need of the
check is the one that cannot be executed to produce an export list. It now runs in
two modes and **prints which was used per module**:

```
modes  measure:parse  pipeline:parse  pixels:import  plan:import  sizing:import
```

`import` reads the real export list. `parse` reads `export` statements out of the
source, which is weaker — it trusts the text and would miss `export * from`.
Printing the mode keeps a weaker check from hiding behind the same green. Both
modes were observed failing: a typo in `App.js`'s import of the parse-mode
`pipeline`, and one in `pipeline.js`'s import of the import-mode `plan`.

### And a third hole, one alias wide

The duplicate check added above compared the **exported** name. JavaScript's
declaration conflict is about the **local binding**, and the two differ the moment
anything is aliased:

```js
import { luma as first, luma as second } from './pixels';  // legal; gate said DUPLICATE
import { luma as same, rgbHex as same } from './pixels';   // SyntaxError; gate said fine
```

The second line is the shape this check was *added for*. It went in because a
duplicate import left `pipeline.js` unparseable while the gate printed that every
name resolved — and one alias was enough to put that hole straight back. Nothing
in the repo imports with an alias, so every real run passed identically under the
right rule and the wrong one.

Fixed by keeping both names: the exported one is checked against the module's
exports, the local one against the other bindings in the file. The duplicate check
now also covers named imports from **any** module, since a binding that collides
with one taken from `react` is the same SyntaxError. Still out of scope, and said
so in the file: `import X from`, `import * as X from`, and shadowing by a later
`const`. Regex is the wrong tool for those and the Metro bundle is what catches
them.

**The gate now checks its own rule before it checks any code** — six assertions,
run on every invocation, printed in the summary line. That is not decoration here:
a duplicate-detection rule is invisible when it is wrong, because every real
import in this repo satisfies both rules, so no normal green run distinguishes
them. `BREAK=dup_by_exported` restores the old rule and `BREAK=resolve_by_local`
checks the wrong name against the exports; both must exit 1.

`resolve_by_local` did not, at first. It changed the decision at its call site
where the self-test could only reach the parser, so the mutation exited 0 — a
mutation that could not go red, inside the file whose entire subject is gates that
cannot go red. The decision is now a named `resolvedName()` the self-test asserts
directly. Third pass on this one gate, third hole; the pattern is that each fix
was verified against the code in the repo rather than against the rule being
claimed.

### The fourth run, 2026-09-18: the merged read, on hardware

The `readRect` merge made `pipeline.js` and `measure.js` a different program from
the one that produced the byte-identical card, so the claim was marked lapsed
rather than holding. It has now been re-measured, and the merge is
behaviour-preserving on real Skia:

| leg | fixture | result |
| --- | --- | --- |
| `renderCard()` + Cover | `x-timeline-statusbar.png` | `sha256 f9fbb1b422193f609599f47ba524a8cc4059cc41ec5c77d02101bd632d1d1ff8`, **584991 bytes** — identical on the device, on the `exec-out` pull, and to `results/cards/card-covered-aa-off.png`. Same crop `{0,89,1440,3031}`, pad 58, dest 964x2030, mask coverage 0.7914 clipped |
| Q1 ring (`measure.js`) | `ig-feed-statusbar.png` | all five statistics identical to the published control: `#010101`, spread 3.15, coverage 0.7766, mean `#222222`, sd 69.08, and `bytesRead` 1,604,736 on the same box `{-781, 891, 1783, 386}` |
| Q3 status bar | both | cut 89, 2.85%, zones `[0.278 0.0749 0 0.048 0.3325]`, `shapeReasons: []` |
| Q2 compose | `ig-feed-statusbar.png` | 1612x3292, 5.31MP, 875.5 KiB — the published output exactly. Timings 341ms against the published 375ms, inside the ±10% that section already claims |
| Q4 round trip | `ig-feed-statusbar.png` | `maxDelta 0, meanDelta 0` over 120,000 samples |

**`renderCard` alone would not have covered the merge.** It never calls
`measureRoundTrip`, `measureRing` or `measureStatusBar`, and those are where the
field rename landed — so the measurement buttons were driven too. Q1 is the leg
that matters most, because its five statistics are sensitive to the rect
arithmetic the shared read now owns, and `bytesRead` is sensitive to the clamp.

**The dimension-drift guard was observed failing on the device, on purpose.**
This is the guard whose fields were renamed, and the one that would have read
`undefined !== undefined` if the rename had been taken silently. A passing run
says nothing about a guard that cannot fire, so `readRect(back, region)` was
temporarily narrowed by one pixel and Cover on re-run:

```
Q4.roundtrip {"error":"dimension drift: 200x200 vs 199x200"}
```

Reverted, and the next run returned `maxDelta 0` over 120,000 samples again.
That is the only evidence available that this particular comparison is live,
since `measure.js` imports Skia and cannot be loaded by a desktop test.

Two things about the *instrument* came out of this run and are now encoded rather
than written down. The picker harness tapped a row whose coordinates came from a
dump taken while the album list was still flinging, opened a different album, and
ended inside the owner's personal library with a photo selected; `drive-pick.sh`
now requires the coordinates to be stable across two consecutive dumps and
confirms the album by name before touching a tile. And a mutation sat in Metro's
served bundle while the device kept reporting the pre-mutation result for two
full cycles, because the HMR socket had gone with the `adb reverse` tunnel —
which is indistinguishable from a mutation that does not work.
`tools/preflight.sh` now checks the tunnel, whose Metro is on the port, and
whether the served bundle contains a token from the code under test.

### The picker repairs itself, 2026-09-18

The rejection had been caught and labelled since Phase 1, which stopped the app
losing its input action silently but left the owner reading an instruction to
restart it by hand. The repair closes that.

**What was measured first, because the recorded diagnosis was a claim.**
expo-modules-core already contains the fix for this: `AppContext.onHostResume`
calls `registry.registerActivityContracts()` when `hostWasDestroyed`, with a
comment saying it exists for reusing an AppContext with a new Activity. So the
first question was not how to repair it but why that does not. Two legs, both
run on the device:

| after the activity is recreated | result |
| --- | --- |
| background the app, foreground it again | **still broken** |
| recreate the activity a second time (restore `font_scale`) | **still broken** |

So `onHostDestroy` is not delivered on a config-change recreation, nothing
re-registers for the life of the runtime, and **a new JS runtime is the only
repair available from JS.** That is what makes this a reload and not a retry.

**The shape of the repair.** Three decisions, in `src/recover.js` and therefore
pure, testable and mutation-covered — 43 checks, 6 mutations. Everything that
used to be a condition inside `App.js` was, by construction, only checkable by
hand on a phone, because `App.js` imports Skia and cannot load in node.

- `launcherWentStale(prev, next)` watches **`fontScale` and `scale` only**. Those
  are the two configuration values `configChanges` does not absorb. Width and
  height are deliberately not watched: rotation changes both and IS absorbed, so
  watching them would report a dead launcher for the one config change that
  cannot cause it.
- `isStaleLauncherError(message)` matches the AndroidX fragment, not Expo's
  formatted sentence, because the sentence interpolates the contract class and
  differs between the library picker and the camera.
- `resumeDecision(flag, now)` bounds a resume flag to 30 seconds. The flag exists
  so the recovery costs one tap instead of two: the runtime about to be destroyed
  writes down that a pick was wanted, and the fresh runtime finishes it. The age
  bound is the safety property — there is no reliable moment to clean that file
  up, since the process that writes it is about to die, so without a bound the
  app would open the photo picker by itself on some unrelated launch days later.
- `recoveryPlan({canReload, alreadyTried})` reloads **at most once**. A
  self-reloading app that never comes back is worse than a button that does not
  work.

**Observed end to end on the device**, driven by `adb`, with a single tap on
Pick:

```
pick.stale         {"from":{"fontScale":1.15,...},"to":{"fontScale":0.85,...}}
pick.recover       {"action":"reload","why":"the activity was recreated, ..."}
pick.recover.reload {"resumeFlagWritten":true}
Running "main"     (a new runtime)
pick.resume        {"resume":true,"reason":"flag is 2238ms old"}
```

and the photo picker then had window focus without anyone tapping again
(`com.google.android.photopicker` in `dumpsys window`). A full pick afterwards
decoded normally, so the launcher is genuinely live and not merely quiet. Both
directions of the trigger were run (0.85 to 1.15, and back), and each recovered.

**Two defects in the repair itself, both found on the device and neither by a
test.** They are recorded because one of them is the more interesting failure:

1. `takeResumeFlag` called `File.text()`, which is **async**, then deleted the
   file before the read resolved. The read failed with `ENOENT` on a file that
   had just been written successfully, and because the rejection was a promise
   rather than a throw, the `try/catch` around it never saw it. `textSync()` is
   the fix. The comment in the code claiming the delete-before-parse ordering
   was deliberate was *right about the reasoning and wrong about the API*.
2. `pick()` was memoised on `[emit]` while reading `staleLauncher`, so it kept
   the first render's `false` for the life of the component and **the proactive
   branch could never fire**. Every recreation went the long way round: launch,
   reject, report, recover. It was invisible precisely because the reactive path
   caught it and the repair still worked — one scary stack trace later. This is
   the same class as the renamed field that silenced a comparison earlier in this
   file: a second path that works is how a first path's death goes unnoticed.

**One trap worth carrying, about the instruments again.** Grepping the whole
project for the old claims from the project root finds nothing in `spike/`,
because the root `.gitignore` ignores `spike/` and ripgrep honours it. The
habit-5 sweep after a rename is only as good as its search path, and from the
root it silently skips the entire codebase.

## What is left in Phase 1

Everything this section used to list is done. It said the pipeline had never run
and that PNG validity and the P3 tag were outstanding; all three stopped being
true on 2026-09-17 and the text survived a further review pass, which is defect
12 above. What is actually left:

- **Orientation ≠ 1.** Never executed, because no input carries the tag. Needs a
  constructed fixture, not a device.
- ~~**`measure.js`'s `clampRect`**~~ **done 2026-09-17.** Fixed, Q1 re-run as the
  control, and the geometry extracted to one shared `intersectRect` so there is no
  longer a copy to miss. See defect 4 above and the re-run in
  results/phase0-device.md: the five statistics reproduced exactly, the read
  shrank by 30%, and the caveat claiming no published figure had hit the defect
  turned out to be false.
- **Downscale-at-decode above the pixel ceiling.** The ceiling is measured
  (between 16256 and 16384 on this driver) and nothing yet reduces a source that
  exceeds it.
- ~~**The picker's launcher lifecycle**~~ **repaired 2026-09-18.** The app
  recovers itself; see "The picker repairs itself" below. What is NOT established
  is whether a release build has the fault at all — every observation is from
  the dev client, whose `DevLauncherActivity` already interferes with the
  activity lifecycle in this project.
- **Share-target delivery**, deferred to Phase 5: it needs a release-style build.
- ~~**A fourth `renderCard()` device run**~~ **done 2026-09-18.** Byte-identical
  again, and both callers of the merged read were measured rather than just the
  pipeline. See "The fourth run" above. The byte-identical claim holds again.

Two more are closed **by decision rather than by measurement**, and are recorded
here so they are not re-raised as tasks: WhatsApp (below) and a second device
(above). Neither will be measured from this machine.
## WhatsApp, which will not be measured

The sizing rules were chosen against WhatsApp's in-chat recompression, and that
send is not available. Rather than leave it as an open checkbox, here is what the
absence actually costs, so nobody re-derives it later:

- **What is unaffected.** The long-edge cap was *removed*, not chosen — width is
  `min(1080, crop_width + 2 x padding)` and height follows the crop. There is no
  WhatsApp-derived magic number in `sizing.js` to be wrong. PNG over JPEG is
  decided by the content (text on flat ground rings under JPEG), not by WhatsApp.
- **What is assumed.** That 1080px wide survives WhatsApp's downscale legibly. If
  it does not, the failure is visible to any user immediately and the remedy is a
  larger long edge, which is one constant.
- **What would settle it**, whenever a phone and WhatsApp are in the same place:
  send `results/cards/card-light-fallback.png` to any chat, save the received
  copy, and run `node tools/chunks.mjs` and a `tools/png.mjs` decode on it. The
  numbers to compare are the received dimensions and whether the text edges are
  still clean. Document sharing is lossless and is the fallback if in-chat is not.

Treat every claim about WhatsApp in this repository as an assumption until that
happens. It is recorded in `BUILD-PLAN.md` as a Phase 1 gate that was consciously
left open, not as one that passed.

### Getting the card off the device

`renderCard` writes to the app's cache directory, which is app-private, so a plain
`adb pull` cannot see it. The debug build is debuggable, so `run-as` can:

```
adb exec-out run-as dev.bismark.twitwaspike cat cache/cards/card.png > card.png
node tools/chunks.mjs card.png
```

**`exec-out`, not `shell` — and the difference is silent corruption.** The recipe
first written here used `adb shell run-as ... cat`, with a note that the shell
"can also mangle binary output". It does, every time. A 64KiB `/dev/urandom` file
was staged inside the app's own cache with `run-as`, hashed on the device, and
pulled both ways:

| | bytes | sha256 |
| --- | --- | --- |
| on the device | 65536 | `a0b06223…cfd851` |
| `adb exec-out run-as … cat` | 65536 | `a0b06223…cfd851` |
| `adb shell run-as … cat` | **65783** | `afa0cadd…ae1c12` |

247 extra bytes: every `0x0A` widened to `0x0D 0x0A` by the pty. The old note
predicted this would be *loud* — "the signature check in `chunks.mjs` fails". It
would not: the 8-byte signature contains one `0x0A`, at offset 3, which becomes
`0x0D 0x0A` and shifts everything after it. The reader would reject it, but a
different reader that seeks chunks rather than checking bytes 0..7 would report
confident nonsense. The real card was pulled with `exec-out` and its sha256
matched the device's, which is the check that makes the rest of this section
trustworthy.

Two smaller facts from the same probe:

- `run-as` starts in the package's data directory, so `cache/cards/card.png` is
  enough and there is no absolute path to get wrong. `Paths.cache` is confirmed as
  `/data/user/0/dev.bismark.twitwaspike/cache/`.
- `run-as` cannot read `/sdcard` — staging a fixture through external storage
  fails with `cat: /sdcard/probe.bin: Permission denied` — so the probe had to be
  generated inside the sandbox.

- Downscale-at-decode above the pixel ceiling. `sizing.js` clamps the *output*;
  nothing yet reduces a source that is too large to plan against.
- The share target is registered and resolving but cannot be delivered to through a
  dev client. Deferred to Phase 5 by decision, not oversight — see `BUILD-PLAN.md`.
