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
// PURE, over profiles, for the reason src/crop.js is pure over rects: the
// arithmetic can then be wrong in a test rather than on a phone. The caller
// reads the pixels.

import { MIN_CROP } from './crop.js';

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
 * @param statusBar      `detectStatusBar`'s result, or null
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
  if (statusBar && statusBar.detected && statusBar.cut > top) {
    reasons.push(`the status bar is inked, so the top was cut at row ${statusBar.cut} instead of ${top}`);
    top = statusBar.cut;
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
