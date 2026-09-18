# Phase 0 results — the device questions, measured 2026-09-16

Q2, Q4 and Q5 needed a phone. This is that run: the first time any Skia call in
`src/measure.js` has executed rather than been read.

| Thing | Value |
| --- | --- |
| Device | Pixel 6 Pro (`raven`), Android 17, API 37 |
| GPU | ARM Mali-G78, OpenGL ES 3.2 (`dumpsys SurfaceFlinger`) |
| Build | debug, `arm64-v8a` only, installed as `dev.bismark.twitwaspike` |
| Bundle | 1417 modules, served by Metro over `adb reverse tcp:8081` |

Numbers were taken off the device with `adb logcat -d -s ReactNativeJS:V`, filtered
on the `PHASE0` marker. The app was driven with `adb shell input tap`, so every
figure below came from a real touch on a real screen.

## Q3 — reproduced exactly, through a different decoder

The control first, before varying anything. Same capture
(`ig-feed-statusbar.png`, 1440x3120), same numbers:

| | cut | fraction | zones | verdict |
| --- | --- | --- | --- | --- |
| desktop, `tools/png.mjs` | 89 | 2.85% | `[0.278 0.075 0.000 0.048 0.332]` | YES |
| device, Skia | 89 | 2.85% | `[0.278 0.0749 0 0.048 0.3325]` | YES |

`shouldTrim: true`, `shapeReasons: []`. This matters more than a passing test: the
two paths share no decoder — mine is `zlib` plus five scanline filters, Skia's is
its own — so agreeing to four decimal places checks **both** implementations
against each other. Either one alone could have been confidently wrong.

Cost on device: `readMs 1.49`, `profileMs 137.05`. The row-ink profile over 400
rows is the expensive half by two orders of magnitude, and it is plain JS.

## Q1 — the modal-vs-mean gap is real on hardware

One ring, on the real capture:

| estimator | fill | spread / sd |
| --- | --- | --- |
| modal (`ringBackground`) | `#010101` | 3.15 |
| mean (`ringStats`) | `#222222` | **69.08** |

Coverage 0.7766, `bytesRead` 2,292,480 for a sub-rect rather than the full frame.
The design change the desktop probe forced is confirmed where it will actually
run: the mean is 22x rougher and lands on a visibly different grey.

### Re-run as the control after the clamp was fixed, 2026-09-17

`measure.js`'s `clampRect` was the last copy of the field-by-field clamp and was
held back on purpose, because this section is what it produced. Fixed, then Q1
re-run on the same fixture with the box untouched. **Every statistic above is
identical** — `#010101`, spread 3.15, coverage 0.7766, mean `#222222`, sd 69.08 —
and one number is not:

| | published | after the fix |
| --- | --- | --- |
| `bytesRead` | 2,292,480 | **1,604,736** |

That difference is the defect, and it says this section's own caveat was wrong.
The caveat read *"every box in the spike is dragged inside the on-screen canvas,
so no published figure is believed to have hit the defect"*. The box was logged
this time: `{"x":-781,"y":891,"w":1783,"h":386}`. **It hangs 781px off the left
edge of the image**, which is exactly the trigger, so the published figure above
went straight through it.

What the old clamp did with it, arithmetic rather than recollection. The ring's
outer rect is `{-787, 885, 1795, 398}`:

- **Old:** origin clamped to x=0, then the width measured from *that* origin —
  `min(1440, 1795)` — so it read **1440x398**, 2,292,480 bytes.
- **New:** both edges from the requested rect, `x1 = min(1440, -787+1795) = 1008`,
  so it reads **1008x398**, 1,604,736 bytes.
- The difference is **432 columns and 687,744 bytes, 30% of the read**, of pixels
  that were never asked for.

And the reason no statistic moved: the ring's rightmost column is local 1007, and
the new buffer is 1008 wide, so it still covers every pixel the estimator samples.
The 432 extra columns were read and then discarded — pure waste, invisible in the
output. That is the honest shape of this defect here: **it cost bandwidth, not
correctness**, and the five figures above stand exactly as published.

Worth keeping because it is the case the caveat assumed away. A reasoning defect
can be harmless in one caller and wrong in the next, and the way to tell is to log
the input, not to reason about where the user probably dragged.

### Reproduced a third time after the read.js merge, 2026-09-18

`readRect` moved out of this file into the shared `src/read.js`, so Q1 was run
again as the control for that. All five statistics and `bytesRead` are identical
to the figures above, on the same box `{-781, 891, 1783, 386}`.

One thing worth recording about *which* fixture: run on `x-timeline-statusbar.png`
instead, Q1 reports `#000000`, spread 1.12, coverage 0.7914, mean `#282321`,
sd 84.52. Five different numbers, none of them a regression — the ring sits on
post content and the two captures differ there. Both fixtures are 1440x3120 and
both label their picker tile `20:43`, so the fixture cannot be told apart on
screen; `MATCH_INDEX=1` is this one. Q3 agrees on both, because the two captures
share a status bar.

## Q2 — fast enough, and the answer is entirely PNG encode

Real capture, 4.49MP in, **1612x3292 = 5.31MP out**:

| step | ms | share |
| --- | --- | --- |
| `MakeOffscreen` | 19.19 | 5.1% |
| draw (clear + image + mask) | 8.44 | 2.2% |
| `makeImageSnapshot` | 0.46 | 0.1% |
| **`encodeToBytes(PNG)`** | **347.28** | **92.5%** |
| total | 375.37 | |

375ms against a ~400ms target, and **92.5% of it is the PNG encoder**. The Skia
composition this spike existed to de-risk costs 28ms. If Q2 ever needs to get
faster, nothing in the drawing path is worth touching.

Output was 875.5 KiB. Note the output here is *larger* than production will be —
the spike composes at crop size plus padding, while `src/sizing.js` targets 1080
wide, so a real card is roughly a quarter of these pixels.

### Scaling with output size

Synthetic 1080-wide inputs, so content is held constant and only size varies:

| output | MP | totalMs |
| --- | --- | --- |
| 1208x8128 | 9.82 | 492.8 |
| 1208x12128 | 14.65 | 770.5 |
| 1208x16128 | 19.48 | 1081.9 |
| 1208x16256 | 19.64 | 988.0 |

The first three are monotone and suggest roughly 60ms per megapixel. **The fourth
breaks that**: 19.64MP came in 94ms *faster* than 19.48MP. These are single runs,
so the honest reading is ~50-60ms/MP with about ±10% run-to-run noise, and the
direction is trustworthy while any single figure is not. Quoting 61ms/MP from the
three-point fit would have been reading a line through noise.

At production sizes (~2.6MP) that extrapolates to roughly 150ms. At 19MP it is
over a second, which is the ceiling's neighbourhood anyway.

## Q4 — the round trip is lossless, and that is not the whole question

`maxDelta 0, meanDelta 0` over 120,000 samples. Every time: sRGB and Display P3
offscreen surfaces, at four different output sizes. Encode → decode changes no
pixel value at all.

**What this does not establish.** Identical pixel values prove no gamut mapping
happened; they say nothing about whether the P3 *tag* survives into the PNG. A
file whose pixels are P3 but which carries no colour chunk is displayed as sRGB —
a silent shift, and exactly the failure this question was asked about. One hint
that a chunk *is* written: the P3 encode produced 876.8 KiB against sRGB's
875.5 KiB, and ~1.3 KiB is the right order for an ICC profile.

Settling it needs the PNG bytes inspected for `iCCP`/`cHRM`/`sRGB` chunks. The
spike never writes the file, so this is still open. It does not block the spec's
decision to convert to sRGB SDR deliberately — it supports it.

**Evidence short of an answer, from the fixtures.** `tools/chunks.mjs` walks a
PNG's chunk table, inflates any embedded ICC profile and reads its colorant tags.
Run over the four captures:

| fixture | colour type | colour space, and how it was established |
| --- | --- | --- |
| `ig-feed-statusbar.png` | 2 (RGB) | `sRGB` chunk, intent Perceptual |
| `x-timeline-statusbar.png` | 2 (RGB) | `sRGB` chunk, intent Perceptual |
| `ig-handwriting-dark.png` | 6 (RGBA) | **`iCCP` → Display P3**, by primaries |
| `x-quote-dark.png` | 6 (RGBA) | **`iCCP` → Display P3**, by primaries |

Both `iCCP` profiles inflate to 520 bytes from a 299-byte chunk, are named
"Skia", and carry red colorants `0.5151, 0.2412, -0.0011` — the published ICC
D50-adapted Display P3 red, where sRGB's is `0.4360, 0.2225, 0.0139`.

So **Skia's PNG encoder writes an `iCCP` profile that correctly identifies
Display P3.** That is the mechanism Q4 asks about, measured on a Skia-written
file. Two things it is still not:

- It is not this pipeline's output. Neither file was written by `renderCard`, and
  what the encoder does with a `DisplayP3` *offscreen surface* is a separate
  question from what it did with these.

  **Closed on 2026-09-17** by rendering both cards through `renderCard` and
  reading their own bytes — `results/phase1-pipeline.md` has the run. The answer
  is asymmetric, which was not the expectation here: `colorSpace: DisplayP3`
  writes the `iCCP`, with the same Display P3 primaries and the same "Skia" name,
  and re-encodes the pixels (961238 channel samples differ, max delta 83). The
  **default writes no profile at all** — `UNTAGGED`, sRGB by convention. This
  section's framing, "comparing the sRGB and P3 cards' profiles", assumed there
  would be two profiles to compare. There is one.
- The name was nearly read as the answer, and it is not one. "299 bytes is its
  sRGB profile" was written here first, on the reasoning that Skia's default
  space is sRGB and 299 bytes is about right for a small profile. Both profiles
  are named "Skia" whatever space they describe, so the name distinguishes
  nothing; the primaries do. `tools/chunks.test.mjs` carries that as
  `BREAK=name_identifies`.

The tool was checked against inputs designed to fool it, because a verdict that
over-reports would have been used to close a question it cannot answer. A second review
found two such cases and both are now tests: an `iCCP` **with a name and no
profile data**, and a file whose only colour-ish chunk is **`sBIT`** — which
declares significant bits per channel, not a colour space. Both were reported as
"tagged". Both now report untagged, with the malformed one naming what is wrong.

A **third** review found the same class again, three times over, and it is the
reason to distrust the paragraph above rather than the tool: the verdict tested
one of the four failure flags its own parser can set, so a chunk declaring bytes
absent from the file, a payload inflating to 18 bytes, and a header lying about
its own length were every one of them reported sound and tagged. The first of
those is what "truncated" should have meant all along — the case written up here
was a complete chunk with an empty payload, which is a different shape.

Every flag now passes through one `colourProblem`, the profile's `acsp`
signature is checked at offset 36, and the colorant tag bounds are checked.
Five malformed shapes are built as real files, with a conforming hand-built
profile as the positive control so the stricter checks are not blanket
rejection. **51 checks, 10 mutations, all observed failing** — and Q4's verdicts
re-measured identical afterwards, which is the only reason its answer survived a
validator this weak. See `results/phase1-pipeline.md`, defect 8.

## Q5 — the ceiling is not where the spec guessed, and not in the read path

### A full `readPixels` never failed

| MP | requested | gotBytes | ms | ok |
| --- | --- | --- | --- | --- |
| 4.49 | 17.1 MiB | 17,971,200 | 96.4 | yes |
| 8.64 | 33.0 MiB | 34,560,000 | 33.5 | yes |
| 12.96 | 49.4 MiB | 51,840,000 | 79.0 | yes |
| 17.28 | 65.9 MiB | 69,120,000 | 56.2 | yes |
| 21.60 | 82.4 MiB | 86,400,000 | 97.6 | yes |

Every byte count is exactly `w × h × 4`. The plan's stated worst case —
1080x20000, "about 82MiB for a single RGBA buffer" — reads fine in under 100ms.

The timings are **not** monotone (79.0ms for 49.4 MiB against 56.2ms for 65.9 MiB)
and must not be read as a throughput curve. Nor is the 4.49MP row comparable to
the rest: it is a real photograph while the others are synthetic bands, so its
decode cost differs. Size and content vary together there, which makes that one
row uninterpretable on its own.

### The real ceiling is `MakeOffscreen`, and it returns null

| surface | result |
| --- | --- |
| 1208x16128 | ok |
| 1208x16256 | **ok** |
| 1208x16384 | **null** |
| 1208x16388 | null |
| 1208x20128 | null |

**`Skia.Surface.MakeOffscreen` returns `null` rather than throwing.** Caller code
that assumes a surface would dereference null and fail somewhere unrelated, with a
message pointing at the wrong layer. `src/measure.js` checks, which is why this
came back as `Q2.error {"error":"MakeOffscreen(1208x20128) returned null"}` instead
of a crash. The app survived every failure.

The boundary sits in **[16256, 16384)** — a 128px window. 16384 is the Mali-G78's
expected `GL_MAX_TEXTURE_SIZE` and failing *at* it rather than above it is mildly
surprising; `dumpsys SurfaceFlinger` does not print the value, so the exact limit
is bracketed by measurement, not read from the driver.

### What this changes in the spec

- `MAX_H = 8000` in `src/sizing.js` is **safe with 2x headroom**, not a guess that
  happened to be wrong. It can stay.
- `MAX_PX = 10e6` **cannot fire at all**, which is a correction to what this
  document said first. It claimed the limit was over-restrictive and "the binding
  constraint for no reason". It is not the binding constraint and never was:
  `cardSize` scales the padded crop to fit `TARGET_W = 1080` and clamps height to
  `MAX_H = 8000`, so the largest output the function can produce is 8.64MP —
  under the ceiling, always. The `width * height > MAX_PX` disjunct is dead code.

  The 19.64MP surface that prompted the original note was composed by
  `src/measure.js`, which pads a crop without scaling it. Nothing that goes
  through `cardSize` can reach those sizes. Reading a measurement from one code
  path as a fact about another is what produced two wrong justifications in a row.
- Both were marked provisional pending this measurement. The height one survives
  and does real work. The pixel one is kept only as the guard that would matter if
  `TARGET_W` or `MAX_H` ever grew, and `src/sizing.test.mjs` now asserts the slack
  so that growing either past it fails a test rather than silently arming a limit.

## A measurement error worth naming: `decodeMs` is not a decode

| input | MP | reported `decodeMs` |
| --- | --- | --- |
| real capture | 4.49 | 12.65 |
| synthetic | 8.64 | 2.43 |
| synthetic | 12.96 | 12.29 |
| synthetic | 17.28 | 4.54 |
| synthetic | 21.60 | 2.72 / 4.71 |

A 21.6MP image "decoding" in 2.72ms while a 4.49MP one takes 12.65ms is not a
decode time. Skia's image creation from encoded bytes is lazy — the pixels are
decoded when first read, not when the image is made — so this figure is header
parsing plus an allocation, and it does not vary with size because almost nothing
size-dependent has happened yet. The real decode cost is inside the `readPixels`
numbers above.

The label is wrong, not the number. Anything planning a progress indicator or a
timeout around `decodeMs` would be planning around nothing.

## Reproducing this

The tall inputs are generated, not stored — `tools/make-tall.mjs` writes them
deterministically and an 82MiB-as-RGBA image is 0.14MiB on disk:

```
node tools/make-tall.mjs out.png 1080 20000
```

The real captures are in `fixtures/screenshots/`. To put any of them where the
picker can see them:

```
adb push <file> /sdcard/Pictures/TwitwaFixtures/
adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE \
  -d file:///sdcard/Pictures/TwitwaFixtures/<file>
```

Then `node tools/capture.mjs clear`, tap, `node tools/capture.mjs dump`.

## Still not answered

- **Q1 on a display.** Every number here predicts no visible seam. Nobody has
  looked at a rendered card on a screen, and that is the actual question.
- **The P3 colour chunk**, as above.
- **A gradient header.** Still the only plausible Q1 failure mode, still not found.
- **Other Android skins**, and any GPU that is not a Mali-G78. The ceiling above is
  one driver's number.
## The share target registers, resolves, and cannot be tested from here

Rebuilt with the filters and measured on the installed package, not read from
source. `cmd package query-activities` against `dev.bismark.twitwaspike`:

| action | image/png | image/jpeg | image/webp |
| --- | --- | --- | --- |
| `SEND` | resolves | resolves | resolves |
| `SEND_MULTIPLE` | resolves | resolves | resolves |

And the negative control matters as much: `SEND` + `text/plain` is **correctly not
offered**, so `image/*` is doing real filtering rather than matching everything. A
filter test that only checked the accepting case would pass with the mime type
wrong.

**But a real share never reaches the app.** Delivering one directly —

```
adb shell am start -a android.intent.action.SEND -t image/png   --grant-read-uri-permission -n dev.bismark.twitwaspike/.MainActivity   --eu android.intent.extra.STREAM content://media/external/images/media/<id>
```

— lands on `expo.modules.devlauncher.launcher.DevLauncherActivity`, which shows its
own "Development Build" home screen. No image, no handoff, nothing in the JS log.
The intent is consumed by the dev launcher and the spike never sees it.

This was predicted from reading `@expo/config-plugins` (filters are appended to the
**main** activity, and in a dev client the main activity is the launcher) and is now
confirmed by measurement. The consequence is stronger than "awkward": **the share
path cannot be verified through a dev client at all.** It needs a release-style
build, and Phase 1's stated goal of testing every later phase "through the real
front door" is not achievable with the build type in use.

## Still not answered
