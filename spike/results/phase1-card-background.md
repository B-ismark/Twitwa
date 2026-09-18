# Phase 1 results — card background, measured 2026-09-16

The card's background is sampled from the four inside edges of the crop, and only
a consensus is trusted. Measured against the same four real screenshots, three
crops each, with `node tools/probe.mjs`.

## Why four edges and not one

Picking one edge and hoping is how a card ends up framed in a colour that appears
nowhere in the screenshot. Crop across a boundary and the top edge is a white
photo while the bottom is black chrome; either answer is confidently wrong.
`BREAK=edge_one` in `src/pixels.test.mjs` restores the one-edge approach so the
agreement assertion is shown to be guarding something.

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

## Results

| # | Capture | Crop | Outcome | Edges (t/b/l/r) | Detail |
| --- | --- | --- | --- | --- | --- |
| 3 | IG feed | whole | **SAMPLED** `#000000` | all `#000000` | diff 0 |
| 3 | IG feed | centred 60% | FALLBACK `#15181D` | `000/FFF/010/010` | diff 255, luma 1 |
| 3 | IG feed | top third | **SAMPLED** `#000000` | all `#000000` | spread 0.67 |
| 4 | X timeline | whole | **SAMPLED** `#000000` | all `#000000` | diff 0 |
| 4 | X timeline | centred 60% | FALLBACK `#15181D` | `133AA1/000/000/000` | diff 161, luma 0 |
| 4 | X timeline | top third | **SAMPLED** `#000000` | all `#000000` | diff 0 |
| 1 | X quote | whole | **SAMPLED** `#000000` | all `#000000` | spread 1.73 |
| 1 | X quote | centred 60% | FALLBACK `#F6F4EF` | `000/000/FEF/FFF` | diff 255, luma 254 |
| 1 | X quote | top third | **SAMPLED** `#000000` | diff 1 | spread 2.26 |
| 2 | IG handwriting | whole | FALLBACK `#F6F4EF` | `000/000/FDF/FDF` | diff 253, luma 253.4 |
| 2 | IG handwriting | centred 60% | FALLBACK `#F6F4EF` | `FEF/000/FDF/FDF` | diff 254 |
| 2 | IG handwriting | top third | FALLBACK `#F6F4EF` | `000/FEF/FEF/FEF` | diff 254 |

Every decision is correct. The sampled cases genuinely have four matching edges;
the fallbacks genuinely straddle a boundary, and each one names what it hit —
`#133AA1` is the blue SanDisk product photo, `#FFFFFF` is the white Facebook card,
`#FDFDFD` is the photographed sheet of paper.

## The finding: the fallback is the common path, not an edge case

**6 of 12 crops fell back.** Every single `centred 60%` crop did, and that is not
an artifact of the test — a crop aimed at the middle of a post cuts through the
post's media almost by definition, which is exactly what users will do.

The spec treats the Paper/Ink fallback as an edge-case row in a table. It is
closer to half the traffic. Consequences:

- The luminance threshold carries real weight. It is currently a flat 128 on
  sRGB-space luma, chosen because it is obvious, not because it was tested.
  Every case here was unambiguous (luma 0, 1, 253.4, 254), so the threshold has
  never actually been exercised near its boundary.
- Paper and Ink are the frame the user will most often see. They are worth
  designing rather than treating as a failure colour.
- "Crop edges disagree on background colour" should not read as an error
  condition in the UI. It is normal.

## The second finding: every sampled frame so far is pure black

Look down the outcome column. All **6** sampled crops returned `#000000` — not
near-black, exactly zero on all three channels, luma 0. That is not a coincidence
of the sample; X and Instagram both use pure black for dark-mode chrome, and the
crops that agree on their edges are the ones sitting entirely on that chrome.

So the sampled frame, in every case measured, is a colour with **no edge at all
against a dark chat background**. The card's whole purpose is to be a framed
object in a conversation, and on the platform it is aimed at, in dark mode, the
frame is invisible. The same goes the other way for a light-mode capture whose
chrome is `#FFFFFF`, which capture 3's Facebook card already shows exists.

`src/plan.js` flags this rather than fixing it — `planOutput` emits *"the frame is
near-white / near-black; it will have no visible edge"* — because the fix is a
design decision about a hairline or an outline, and nothing here has been looked
at on a screen. What matters is that it is now surfaced on the common path
instead of being discovered in a chat thread.

### The bound is Paper and Ink, not a number

The two thresholds were first written as literals, 245 and 12. Paper's luma is
**244.03** — 0.97 below the threshold meant to catch colours *more extreme than
Paper*. The neutral frame passed its own check by under one luma unit, by luck,
and a one-digit nudge to Paper would have had it warning about itself.

They are now `luma(PAPER)` and `luma(INK)`, which makes it structural instead of
lucky. The first two tests written for this could not tell the two versions apart
— the fallback's fill is always exactly Paper or Ink, so it never lands in the
gap. Only a *sampled* colour inside it discriminates: `#F6F5F0` at luma 244.73
and `#141618` at 21.63. `BREAK=literal_bounds` restores the literals and those
two checks go red; without them it exited 0 and the assertion was decoration.

## A case the agreement rule cannot resolve, and does not pretend to

Capture 2's whole-image crop is a **2-2 split**: top and bottom are both
`#000000`, which is the real Instagram chrome, while left and right are both
`#FDFDFD`, the photographed paper spanning the full width. Two edges agree with
each other, and so do the other two.

A "majority of 4" rule would not help — there is no majority. Taking the
top/bottom pair would arguably be right here, since `#000000` *is* the app's
chrome, but it would be wrong whenever the media runs top-to-bottom instead. So
the current behaviour is to fall back, which gave `#F6F4EF` on a post that is
253/255 luma. Defensible.

Whether a pair-aware rule beats the neutral fallback is open, and it should be
decided by looking at cards on a screen rather than by argument.

## What is not answered

- Whether a sampled frame reads better than Paper or Ink at all. That was already
  an open question in the spec and remains one — it is an eye judgement.
- The luminance threshold near its boundary. No measured crop came close to 128.
- `agree = 12` per channel, and `thickness = 8`. Both are first guesses. The
  measured diffs were 0, 1, 161, 253, 254, 255 — nothing landed between 1 and
  161, so the threshold has enormous slack in this sample and is untested.
