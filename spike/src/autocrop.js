// Phase 4.5: the crop the editor opens on, so step 2 of the user flow is true.
//
// The flow says the editor opens on a finished card. That is only true if
// something proposes a crop, because the whole screenshot is not a card — it
// is a status bar, a post, and whatever empty feed happened to be below it.
//
// WHAT THIS IS AND IS NOT. It is a trim of the FLAT BANDS at the four edges,
// which is a different job from `detectStatusBar`. The status bar is inked —
// a clock, a battery, two or three icons — so no amount of flat-band trimming
// removes it, and a proposal that leaves it on is not a card. So this takes
// the status-bar cut as a floor on the top edge and does the four edges
// itself. Both, or neither works.
//
// It is NOT a subject detector. Nothing here knows what a post is; it knows
// what an unbroken run of one colour is. On a screenshot with a gradient
// background it finds nothing and proposes the whole image, which is the right
// answer to give when the answer is not known.
//
// PURE, and it stays pure even though `proposeFromImage` at the bottom takes a
// decoded image: the read is an injected FUNCTION, so this module imports no
// Skia and the whole path is exercisable in node against a fake image. That is
// the reason src/crop.js is pure over rects — the arithmetic can be wrong in a
// test rather than on a phone.
//
// `proposeFromImage` lives here rather than in App.js because it was in App.js,
// and that is precisely where it broke: the view called `readSubRect` with two
// of its three arguments and every import threw, unseen by every gate, because
// no suite loads a component. Logic that needs a Skia image is still logic.

import { MIN_CROP } from './crop.js';
import { rowInkProfile, colInkProfile, detectStatusBar, judgeStatusBar } from './pixels.js';

/**
 * Ink coverage at or below this counts as flat.
 *
 * The same default `detectStatusBar` uses, and deliberately the same number:
 * the two run on the same profile of the same image, and a top edge that two
 * functions disagree about the flatness of is a proposal that trims to one
 * place and reports another.
 */
export const FLAT = 0.01;

/**
 * The largest image whose COLUMNS will be profiled, in pixels.
 *
 * A column profile is defined over whole columns, and there is no banded form
 * of it: the statistic is each column's modal colour, so computing it across
 * strips would need a 4096-bucket histogram per column and cost more memory
 * than the image. That makes it the one place in this app that reads a whole
 * decoded image, against the rule src/pipeline.js states at the top.
 *
 * So it is bounded rather than excused. 30MP is 120MiB of RGBA; a Pixel 6 Pro
 * read 82MiB without complaint (results/phase0-device.md) and that is one
 * driver, which is exactly the reason for a ceiling rather than a reason
 * against one. Past it the proposal trims vertically only and says so — a
 * worse proposal is a fine outcome, and an out-of-memory on import is not.
 */
export const MAX_PROFILE_PX = 30e6;

/**
 * Is this image small enough to profile its columns?
 *
 * Separated from `proposeCrop` because the caller has to decide BEFORE it
 * reads any pixels, and a function that answers after the read has already
 * happened would be decoration.
 */
export function canProfileColumns(width, height, budget = MAX_PROFILE_PX) {
  return width * height <= budget;
}

/**
 * The flat run at each end of a profile.
 *
 * @returns {{lead, trail, inked}} `inked` is false when nothing in the profile
 * is above `flat`, in which case `lead` and `trail` are both 0 rather than the
 * whole length. Trimming everything is not an answer, and returning the length
 * would make a blank image produce a zero-sized crop through arithmetic that
 * looks correct at every step.
 */
export function flatBand(profile, flat = FLAT) {
  const n = profile.length;
  let lead = 0;
  while (lead < n && profile[lead] <= flat) lead++;
  if (lead === n) return { lead: 0, trail: 0, inked: false };
  let trail = 0;
  while (trail < n && profile[n - 1 - trail] <= flat) trail++;
  return { lead, trail, inked: true };
}

/**
 * The crop to open the editor on.
 *
 * @param width, height  the source image, in pixels
 * @param rows           `rowInkProfile` over EVERY row
 * @param cols           `colInkProfile` over EVERY column, or null when the
 *                       image was too large to profile them (see
 *                       `canProfileColumns`), in which case nothing is
 *                       trimmed horizontally and the reason says so
 * @param statusBar      `judgeStatusBar`'s result, or null. Its cut is taken
 *                       only when `likely` is true; a bare `detectStatusBar`
 *                       result has no `likely` and so trims nothing
 * @param min            the smallest crop a person could have dragged
 *
 * @returns {{crop, trimmed, reasons}} `reasons` is never empty: a proposal
 * that trimmed nothing has to say why, or the editor looks like it ignored
 * the picture. Every path through here appends one.
 *
 * The two profiles must cover the whole image. A profile shorter than its axis
 * throws rather than being treated as the whole of it, because the failure is
 * otherwise silent and directional: `rowInkProfile` takes a row cap, and a
 * capped profile reports the flat band at the CAP as the flat band at the
 * bottom of the image. The proposal then trims a few hundred rows off the
 * middle of the post and looks deliberate.
 */
export function proposeCrop({ width, height, rows, cols, statusBar = null, flat = FLAT, min = MIN_CROP }) {
  if (!(width > 0) || !(height > 0)) throw new Error(`autocrop: bad image ${width}x${height}`);
  if (rows.length !== height) {
    throw new Error(`autocrop: the row profile covers ${rows.length} of ${height} rows`);
  }
  if (cols && cols.length !== width) {
    throw new Error(`autocrop: the column profile covers ${cols.length} of ${width} columns`);
  }

  const whole = { x: 0, y: 0, w: width, h: height };
  const v = flatBand(rows, flat);
  // No column profile is not the same as a flat one. A flat profile means the
  // screenshot has no ink at all, which gives up on BOTH axes; an unmeasured
  // one means only that the horizontal answer is unknown, and the vertical
  // trim is still good.
  const h = cols ? flatBand(cols, flat) : null;
  const reasons = [];
  if (!cols) reasons.push('the image was too large to profile its columns; nothing was trimmed sideways');

  if (!v.inked || (h && !h.inked)) {
    reasons.push('no ink found; the whole screenshot is the crop');
    return {
      crop: whole,
      trimmed: { top: 0, bottom: 0, left: 0, right: 0, columnsProfiled: Boolean(cols) },
      reasons,
    };
  }

  let top = v.lead;
  const bottom = v.trail;
  let left = h ? h.lead : 0;
  let right = h ? h.trail : 0;

  // The status bar is ink, so the band trim above walked straight past it.
  // Only ever a floor: a screenshot already cropped below the status bar has a
  // larger flat lead than the cut, and taking the cut there would put the top
  // of the card back into empty space.
  //
  // And only when the boundary passed the shape test. A screenshot with no
  // status bar still has a first ink-then-flat edge, and on a post that edge is
  // the avatar-and-name row: taking it as the floor opens the editor with the
  // author cut off. That shipped in 1.0.2 and the owner found it on a tweet.
  // `likely` has to be true, not merely present, so a caller that skipped the
  // test gets no trim rather than the old behaviour.
  if (statusBar && statusBar.detected && statusBar.cut > top) {
    if (statusBar.likely === true) {
      reasons.push(`the status bar is inked, so the top was cut at row ${statusBar.cut} instead of ${top}`);
      top = statusBar.cut;
    } else {
      reasons.push(`the edge at row ${statusBar.cut} does not look like a status bar, so the top was left at row ${top}`);
    }
  }

  // Per axis, not per proposal. A screenshot with a wide flat gutter and a
  // full-height post should lose the gutter even if the vertical trim has to
  // be abandoned, and backing the whole thing out would throw away the trim
  // that was fine.
  let w = width - left - right;
  let hh = height - top - bottom;
  let vTop = top;
  let vBottom = bottom;
  if (hh < min) {
    reasons.push(`the vertical trim left only ${hh}px, below the ${min}px floor; it was dropped`);
    vTop = 0;
    vBottom = 0;
    hh = height;
  }
  if (w < min) {
    reasons.push(`the horizontal trim left only ${w}px, below the ${min}px floor; it was dropped`);
    left = 0;
    right = 0;
    w = width;
  }

  const trimmed = { top: vTop, bottom: vBottom, left, right, columnsProfiled: Boolean(cols) };
  if (!vTop && !vBottom && !left && !right && reasons.length === 0) {
    reasons.push('the screenshot has no flat edges to trim');
  }
  if (reasons.length === 0) {
    reasons.push(`trimmed ${vTop} top, ${vBottom} bottom, ${left} left, ${right} right`);
  }

  return { crop: { x: left, y: vTop, w, h: hh }, trimmed, reasons };
}

/**
 * How many rows/columns the profiles step over.
 *
 * Every 8th pixel, because these profiles decide where a flat band ends and a
 * flat band is hundreds of pixels deep; sampling one row in eight cannot move
 * the boundary by more than 7 and costs an eighth of the read. `detectStatusBar`
 * below runs at step 2 instead: it is looking for a gap of `run = 8` flat rows,
 * so a step of 8 could straddle it and report no status bar on a screenshot
 * that plainly has one.
 */
export const PROFILE_STEP = 8;

/**
 * Rows of the image `detectStatusBar` is given.
 *
 * A status bar is at the top or it is not a status bar. Profiling the whole
 * height to find it would multiply the one expensive read in this app by
 * nothing useful.
 */
export const STATUS_BAND = 400;

/**
 * The proposal, from a decoded image rather than from profiles.
 *
 * WHY THIS IS HERE AND NOT IN App.js. It was in App.js, and that is exactly
 * where the 2026-09-18 crash lived: the view called `readSubRect` with two of
 * its three arguments, every import threw, and the editor never opened once.
 * Nothing could have caught it, because this arithmetic sat in a component no
 * suite loads. Three profiles, a band and a detector is not view code; it only
 * looked like view code because it needs a Skia image.
 *
 * So the Skia part is the `read` ARGUMENT — inject src/skia.js's `readRect`
 * and this whole function is testable in node against a fake image, which is
 * what `autocrop.test.mjs` does. The module stays Skia-free.
 *
 * @param img   anything with `width()` and `height()`
 * @param read  `(img, box) => {buf, rowBytes, ...} | null`; pass `readRect`
 * @returns the same `{crop, trimmed, reasons}` as `proposeCrop`
 *
 * Throws when the read fails rather than proposing the whole image. A null
 * read means the pixels could not be got at all, and a proposal invented on
 * top of that would be a confident answer about an image nobody looked at.
 */
export function proposeFromImage(
  img,
  read,
  { step = PROFILE_STEP, band = STATUS_BAND, budget = MAX_PROFILE_PX } = {},
) {
  if (typeof read !== 'function') {
    throw new Error('proposeFromImage: pass a read function, e.g. readRect from src/skia.js');
  }
  const width = img.width();
  const height = img.height();
  const full = read(img, { x: 0, y: 0, w: width, h: height });
  if (!full) throw new Error(`autocrop: could not read the image (${width}x${height})`);

  const rows = rowInkProfile(full.buf, full.rowBytes, width, height, height, step);
  // Asked BEFORE the profile is computed rather than after, because the point
  // of the ceiling is to not do the work. See MAX_PROFILE_PX for why this is
  // the one whole-image read in the app and why it is bounded rather than
  // excused.
  // `budget` is an argument rather than a constant read straight from module
  // scope so the over-budget path is reachable in a test. It was not, and an
  // untestable branch is a branch nobody has seen run: proving it with a real
  // 30MP image would mean allocating 120MiB inside a unit suite.
  const cols = canProfileColumns(width, height, budget)
    ? colInkProfile(full.buf, full.rowBytes, width, height, width, step)
    : null;

  const h = Math.min(band, height);
  const bandRows = rowInkProfile(full.buf, full.rowBytes, width, h, h, 2);
  const statusBar = judgeStatusBar(detectStatusBar(bandRows), full.buf, full.rowBytes, width, height);

  return proposeCrop({ width, height, rows, cols, statusBar });
}
