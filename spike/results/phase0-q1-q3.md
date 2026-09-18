# Phase 0 results — Q1 and Q3, measured 2026-09-16

Four real screenshots supplied by the user, measured on a desktop with
`node tools/probe.mjs`. No device involved: both questions are pure pixel math,
and only Q2, Q4 and Q5 need a phone.

| # | Source | Size | MP | PNG type | Status bar |
| --- | --- | --- | --- | --- | --- |
| 1 | X, dark, a quote post wrapping a white journal screenshot | 1411x1756 | 2.48 | 2 (RGB) | cropped away |
| 2 | Instagram, dark, a white handwriting image | 1440x2050 | 2.95 | 6 (RGBA) | cropped away |
| 3 | Instagram feed, dark, with a white Facebook card near the bottom | 1440x3120 | 4.49 | 2 (RGB) | **present** |
| 4 | X timeline, dark, six posts and a link card | 1440x3120 | 4.49 | 2 (RGB) | **present** |

## Reproducing this

The four screenshots are archived in the repo, because they arrived through a
session-scoped uploads folder and every number below depends on them — the same
lesson `fixtures/og-pages.tar.gz` exists for. Verified to reproduce every figure
here exactly:

```
cd spike && node tools/probe.mjs fixtures/screenshots/*.png
```

| # | File |
| --- | --- |
| 1 | `fixtures/screenshots/x-quote-dark.png` |
| 2 | `fixtures/screenshots/ig-handwriting-dark.png` |
| 3 | `fixtures/screenshots/ig-feed-statusbar.png` |
| 4 | `fixtures/screenshots/x-timeline-statusbar.png` |

## Q1 — does the sampled fill look seamless? **Passes**

Measured over the rows Cover would actually target: thin bands of ink sitting on
flat ground. Background spread is the seam predictor — the standard deviation of
the ring's background pixels once outliers are excluded.

| # | target rows | spread p50 | p90 | max | under 1 |
| --- | --- | --- | --- | --- | --- |
| 1 | 9 | 0.32 | 0.59 | 0.74 | 9/9 |
| 2 | 8 | 1.74 | 2.08 | 2.09 | 3/8 |
| 3 | 25 | 0.62 | 1.01 | 1.21 | 22/25 |
| 4 | 16 | 0.22 | 0.51 | 0.51 | 16/16 |

**58 target rows across four captures. Nothing above 2.09, and 50 of 58 below 1.**
The X timeline is the cleanest — its six engagement rows all land at spread 0.22,
identical, because they are the same widget repeated down a flat ground.

Screenshot 2's eight rows are the outlier set, and they are not chrome: they are
text lines inside a *photographed sheet of paper*, so the spread is paper grain.
Nobody covers those.

Representative chrome rows:

| # | row | what it is | fill | spread |
| --- | --- | --- | --- | --- |
| 1 | y=1492 h=35 | `432 Reposts · 9 Quotes · 18.4K Likes · 1,968 Bookmarks` | `#000000` | 0.59 |
| 3 | y=1203 h=40 | a feed post's engagement row | `#000000` | 1.01 |
| 3 | y=2940 h=77 | the bottom navigation bar | `#000000` | 0.33 |
| 4 | y=695 h=45 | `197 · 3K · 69.9K` | `#000000` | 0.22 |
| 4 | y=2445 h=25 | the BBC link-card caption | `#000000` | 0.44 |

### Light-mode chrome: also flat

This was an open gap — the first two captures were both dark, and `#FFFFFF` has no
headroom above it. Screenshot 3 carries a white Facebook card:

| row | fill | spread | coverage |
| --- | --- | --- | --- |
| y=2737 h=83 | `#FFFFFF` | 0.38 | 100% |
| y=2848 h=58 | `#FFFFFF` | 0.62 | 50% |

Pure white, spread under 1. Light chrome is as flat as dark chrome. Gap closed.

### The condition: the fill must be the MODAL colour, not the mean

A design change, not a detail, and the new captures make it much starker. The
sampling ring around a like-count row catches ascenders and descenders from the
rows either side, and a mean is dragged by them:

| # | row | modal fill | mean fill | mean's sd | true spread | overestimate |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | y=2848 | `#FFFFFF` | `#838383` | 124.74 | 0.62 | mid-grey on pure white |
| 2 | y=182 | `#000000` | `#7F7F7F` | 126.95 | 0.00 | mid-grey on pure black |
| 4 | y=1775 | `#000000` | `#030303` | 24.84 | 0.40 | 62x |
| 3 | y=612 | `#000000` | `#010101` | 16.03 | 0.27 | 59x |
| 3 | y=150 | `#000000` | `#030304` | 13.32 | 0.00 | unbounded |

Two failure modes, both fatal to the feature:

1. **Wrong fill colour.** `#838383` over pure white and `#7F7F7F` over pure black
   are not subtle seams, they are grey rectangles. Both occur where ring coverage
   is 50% — the ring straddles a light/dark boundary, and the mean lands halfway
   between two real colours that each exist.
2. **Wrong verdict.** The mean overstates roughness by up to 62x. Q1 measured with
   a mean would have read as *failing* on screenshots that pass comfortably.

`ringBackground` in `src/pixels.js` does this: modal quantised colour, refined
over the pixels near it, plus **coverage** — how much of the ring is background at
all. Low coverage is a badly placed box, not a rough background, and the two want
different responses. 10 of the 41 rows in captures 3 and 4 have mean ≠ mode.

## Q3 — does status-bar detection generalise? **Verified both directions**

The shape test over five horizontal zones: a status bar puts glyphs at both outer
edges and leaves the middle empty, within a thin band.

| # | boundary found | zone ink | verdict | correct? |
| --- | --- | --- | --- | --- |
| 1 | row 133 (7.57%) | `[0.419 0.055 0.000 0.000 0.006]` | NO — band too tall | yes, that is the avatar/name row |
| 2 | row 162 (7.90%) | `[0.314 0.097 0.078 0.127 0.457]` | NO — middle not empty, too tall | yes, that is the username row |
| 3 | row 89 (2.85%) | `[0.278 0.075 0.000 0.048 0.332]` | **YES** | yes, a real status bar |
| 4 | row 89 (2.85%) | `[0.278 0.075 0.000 0.048 0.332]` | **YES** | yes, a real status bar |

Accepts real status bars, rejects headers. Both ends tested, which matters —
a test that only ever saw the accepting case would pass with the test stubbed out.

Without the shape test the heuristic cut the author's byline on captures 1 and 2
with full confidence. Auto-trim would have removed the one part of a post nobody
wants removed.

**Honest limit: captures 3 and 4 give the same row 89 and byte-identical zone
figures, because they are the same phone and the same status bar.** That is one
distinct status bar, not two.

The phone is named now that it is attached: **Pixel 6 Pro (`raven`), Android 17,
API 37, 1440x3120 at density 560** — so the one skin tested is **stock Android**,
and the fixtures are native full-resolution captures, which is where 4.49MP comes
from. Generalisation to One UI, and to any skin that centres its clock or hides
the cutout differently, is still untested.

## Corrections to the plan from these captures

Real screenshots off this device are **1440x3120 = 4.49MP, 17.1MiB as RGBA** — 73%
more pixels than the 2.6MP figure `BUILD-PLAN.md` used for the Q2 timing target.
The plan's numbers were written for 1080x2400.

PNG colour type varies between captures on the same phone: 2 (RGB) and 6 (RGBA).
The decoder handles both, but anything assuming four channels would be wrong half
the time.

## What is still not answered

- **Q1's verdict on a display.** Spread under 1 predicts no visible seam; it does
  not prove one is invisible. An eye judgement on a real screen.
- **A gradient header.** The user looked and could not find one. Still open, and
  it remains the only plausible Q1 failure mode left.
- **Threads.** Claimed as a supported platform, never looked at.
- **Status bars from other Android skins.** One device so far.
- **Q2, Q4, Q5.** Skia speed, the colour round trip, the memory ceiling. Device,
  and now against 4.49MP rather than 2.6MP.
