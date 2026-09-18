// Phase 1's decision layer: everything the renderer must decide before Skia
// draws anything. No Skia import, so all of it is testable on a desktop.
//
// It is deliberately TWO functions rather than one, and the split is the point.
// The card's background is sampled from the inside edges of the crop, so it can
// only be sampled once the crop is final. A single plan() taking both a crop and
// a background would invite sampling first and trimming second, which samples
// the status bar's own chrome and then throws those rows away — a fill drawn from
// pixels that are no longer in the card. Ordering:
//
//   1. planCrop()    -> the final crop rect (trim decided here)
//   2. sample the background from THAT rect        (pixels.js cropBackground)
//   3. planOutput()  -> output size, dest rect, fill colour
//
// `BREAK=sample_order` in the tests asserts step 2 is fed the trimmed rect.
import { cardSize } from './sizing.js';
import { intersectRect, luma, PAPER, INK } from './pixels.js';

const hexLuma = (hex) => luma([
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]);

/**
 * Intersect a crop with the image.
 *
 * This is an INTERSECTION, not a clamp of each field on its own, and the
 * difference is a real defect that was in this file: moving `x` up to 0 while
 * keeping `w` grows the rect by exactly the amount that hung off the edge. A
 * crop of `{-10,-20,30,40}` came back as `{0,0,30,40}` — 30 columns wide when
 * only 20 of them were ever asked for.
 *
 * It survived a test because the only case tested was `{-50,-50,9999,9999}`,
 * which overshoots every edge at once. There, clamping each field and
 * intersecting give the same answer, so the assertion could not tell them
 * apart. Partial overlap is the discriminating input, and clampMasks — written
 * later, and correctly — is what made the inconsistency visible.
 *
 * An empty intersection throws. A crop entirely outside its image is a caller
 * bug, not a rendering decision: every real gesture is clamped to the image
 * before it gets here, and silently returning a 1px rect at the nearest edge
 * would render a card of one column of pixels rather than say so.
 */
export function clampCrop(imageW, imageH, box) {
  // The geometry lives in pixels.js; what is local to a CROP is that no overlap
  // is a caller bug worth throwing over, where a sampling rect may legitimately
  // fall off the edge and read nothing.
  const r = intersectRect(imageW, imageH, box);
  if (!r) {
    throw new Error(
      `crop {${box.x},${box.y},${box.w},${box.h}} does not intersect the ${imageW}x${imageH} image`,
    );
  }
  return r;
}

/**
 * Decide the final crop, including whether to cut the status bar.
 *
 * @param image     {width, height}
 * @param crop      {x,y,w,h} source px; omit for the whole image
 * @param statusBar the merged detect + shape result: {detected, cut, likely}
 * @param trim      'auto' (cut only a confirmed status bar) | 'always' | 'never'
 */
export function planCrop({ image, crop, statusBar = null, trim = 'auto' }) {
  if (!(image && image.width > 0 && image.height > 0)) {
    throw new Error(`bad image: ${image && image.width}x${image && image.height}`);
  }
  if (!['auto', 'always', 'never'].includes(trim)) {
    throw new Error(`unknown trim mode: ${String(trim)}`);
  }

  const asked = crop || { x: 0, y: 0, w: image.width, h: image.height };
  const requested = clampCrop(image.width, image.height, asked);
  const warnings = [];
  // Said out loud, because the card is then smaller than the box the user drew
  // and nothing else downstream can tell that happened.
  if (requested.w !== Math.round(asked.w) || requested.h !== Math.round(asked.h)) {
    warnings.push(
      `the crop extended past the image and was cut to it (${Math.round(asked.w)}x${
        Math.round(asked.h)} asked, ${requested.w}x${requested.h} used)`,
    );
  }
  const cut = statusBar && statusBar.detected ? statusBar.cut : 0;

  let trimmed = false;
  let reason;
  if (trim === 'never') {
    reason = 'trim disabled';
  } else if (!statusBar || !statusBar.detected) {
    reason = 'no top boundary found';
  } else if (!statusBar.likely && trim === 'auto') {
    // The expensive mistake this prevents: on two of the four real captures the
    // boundary detector landed confidently on the author's byline. Auto-trim
    // without the shape test removes the one row nobody wants removed.
    reason = 'boundary found but it does not look like a status bar';
  } else if (cut <= requested.y) {
    reason = 'the crop already starts below the boundary';
  } else if (cut >= requested.y + requested.h) {
    reason = 'the boundary is below the crop';
  } else {
    trimmed = true;
  }

  if (trim === 'always' && statusBar && statusBar.detected && !statusBar.likely && trimmed) {
    warnings.push('trimming a boundary that failed the status-bar shape test; this may be a header');
  }

  const final = trimmed
    ? { x: requested.x, y: cut, w: requested.w, h: requested.y + requested.h - cut }
    : requested;

  return {
    crop: final,
    requested,
    trimmed,
    trimmedRows: trimmed ? cut - requested.y : 0,
    reason: trimmed ? undefined : reason,
    warnings,
  };
}

/**
 * Output size, destination rect and frame colour.
 *
 * @param crop        the crop returned by planCrop — not the user's request
 * @param padding     a PADDING key or a fraction
 * @param background  cropBackground() run on THAT crop
 */
export function planOutput({ crop, padding = 'standard', background = null }) {
  const size = cardSize(crop, padding);
  const warnings = [...size.warnings];

  let fill;
  let fillSource;
  if (background && background.source === 'sampled' && background.hex) {
    fill = background.hex;
    fillSource = 'sampled';
  } else {
    // Measured, not assumed: 6 of 12 crops in results/phase1-card-background.md
    // land here, and every centred crop did. This is a normal path.
    const l = background && background.luma !== undefined
      ? background.luma
      : luma([0x80, 0x80, 0x80]);
    fill = l < 128 ? INK : PAPER;
    fillSource = 'fallback';
    warnings.push(`background sampled from the crop edges disagreed (${
      (background && background.reason) || 'no sample taken'}); using the neutral frame`);
  }

  // A near-white frame vanishes on a light chat background and a near-black one
  // on a dark chat background, so the card loses the border that is its whole
  // reason to exist. Flagged rather than corrected: the fix is a design decision
  // about a hairline, and nothing here has been looked at on a screen yet.
  //
  // The bounds are Paper and Ink themselves, not hand-picked numbers. Written as
  // literals they were 245 and 12, which left Paper — at luma 244.03 — exactly
  // 0.97 below the threshold meant to catch colours *more extreme than Paper*.
  // The neutral frame passed its own check by under one unit, by luck. Anchoring
  // to the constants makes that structural: Paper and Ink can never warn about
  // themselves, and anything past them always does.
  const fl = hexLuma(fill);
  if (fl > hexLuma(PAPER)) warnings.push('the frame is near-white; it will have no visible edge on a light background');
  if (fl < hexLuma(INK)) warnings.push('the frame is near-black; it will have no visible edge on a dark background');

  return { ...size, fill, fillSource, fillLuma: +fl.toFixed(1), warnings };
}

/**
 * The two steps in the only order that is correct, with the sampling in between.
 *
 * `sampleBackground` is a callback rather than a value precisely so the crop it
 * is given cannot be the wrong one: there is no way to call this and sample the
 * untrimmed rect. A renderer passes
 * `(rect) => cropBackground(buf, rowBytes, w, h, rect)`; a test passes a spy and
 * asserts which rect arrived. `BREAK=sample_order` feeds it the pre-trim rect
 * and the spy assertion goes red.
 */
export function planCard({ image, crop, padding = 'standard', statusBar = null, trim = 'auto', sampleBackground }) {
  const c = planCrop({ image, crop, statusBar, trim });
  const background = sampleBackground ? sampleBackground(c.crop) : null;
  const out = planOutput({ crop: c.crop, padding, background });
  return {
    ...out,
    crop: c.crop,
    requested: c.requested,
    trimmed: c.trimmed,
    trimmedRows: c.trimmedRows,
    trimReason: c.reason,
    background,
    warnings: [...c.warnings, ...out.warnings],
  };
}

/**
 * Clamp Cover boxes to the crop, in source pixels.
 *
 * A box is dragged over the on-screen image and can extend past the crop edge —
 * the gesture is clamped to the image, not to the crop, and the crop can also be
 * trimmed AFTER a box was placed. Mapping such a box straight into the output
 * draws it over the padding, i.e. a grey rectangle sitting on the frame, outside
 * the picture it was meant to cover.
 *
 * Clamping here rather than relying on a Skia clip keeps the decision testable
 * and keeps one answer: the renderer additionally clips, but that is defence, not
 * the rule. Boxes with no overlap at all are dropped, and reported, because
 * silently drawing nothing and silently drawing in the wrong place are both worse
 * than saying a box fell outside the crop.
 */
export function clampMasks(masks, crop) {
  const kept = [];
  const dropped = [];
  for (const m of masks || []) {
    const x0 = Math.max(crop.x, Math.round(m.x));
    const y0 = Math.max(crop.y, Math.round(m.y));
    const x1 = Math.min(crop.x + crop.w, Math.round(m.x + m.w));
    const y1 = Math.min(crop.y + crop.h, Math.round(m.y + m.h));
    if (x1 <= x0 || y1 <= y0) {
      dropped.push(m);
      continue;
    }
    kept.push({ ...m, x: x0, y: y0, w: x1 - x0, h: y1 - y0, clipped: x0 !== Math.round(m.x) || y0 !== Math.round(m.y) || x1 - x0 !== Math.round(m.w) || y1 - y0 !== Math.round(m.h) });
  }
  return { masks: kept, dropped };
}

/**
 * Map one Cover box from source pixels into output pixels.
 *
 * The scale comes from `dest/crop`, not from `plan.scale`, so it cannot drift
 * from where the image was actually drawn — `dest` was derived by subtraction and
 * is a rounded integer, so `dest.w / crop.w` is the real scale and `plan.scale`
 * is only what it was before rounding.
 */
export function maskToDest(mask, plan) {
  const sx = plan.dest.w / plan.crop.w;
  const sy = plan.dest.h / plan.crop.h;
  return {
    x: plan.dest.x + (mask.x - plan.crop.x) * sx,
    y: plan.dest.y + (mask.y - plan.crop.y) * sy,
    w: mask.w * sx,
    h: mask.h * sy,
  };
}

/**
 * The output pixels one Cover box owns: `maskToDest` snapped OUTWARD to integers
 * and intersected with `dest`.
 *
 * `maskToDest` answers where the box lands, which is a fraction of a pixel almost
 * always — the scale is `dest/crop` and neither is a multiple of the other. Drawn
 * from those coordinates, Skia anti-aliases the boundary and **one row of the
 * covered content survives**: measured at up to 53/255 on the first device run,
 * see results/phase1-pipeline.md. A Cover box is a redaction, so that is a leak,
 * not a rounding detail.
 *
 * Outward rather than nearest, because the two errors are not symmetric: covering
 * one pixel more than asked costs a pixel of background-coloured fill on a
 * background-coloured surround, and covering one pixel less leaves part of what
 * the user was hiding. Then intersected with `dest`, so growing outward cannot
 * push fill onto the frame.
 *
 * Returns null for a box that owns nothing: a degenerate source rect, or one that
 * falls outside `dest` entirely. The degenerate case is checked **before**
 * rounding, and it has to be: outward rounding of a zero-width box at a
 * fractional coordinate would otherwise manufacture a 1px mark out of no area at
 * all. `clampMasks` cannot catch it either — a zero-size rect inside the crop
 * overlaps it and is a legal source rect.
 */
export function maskToDestPixels(mask, plan) {
  if (!(mask.w > 0) || !(mask.h > 0)) return null;
  const f = maskToDest(mask, plan);
  const x0 = Math.max(plan.dest.x, Math.floor(f.x));
  const y0 = Math.max(plan.dest.y, Math.floor(f.y));
  const x1 = Math.min(plan.dest.x + plan.dest.w, Math.ceil(f.x + f.w));
  const y1 = Math.min(plan.dest.y + plan.dest.h, Math.ceil(f.y + f.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Output size after an EXIF orientation is applied. Pure, because the swap is
 * where this goes wrong: orientations 5-8 exchange width and height, so a plan
 * computed before normalising would size the card to the un-rotated image and
 * produce a card with the picture rotated inside the wrong aspect.
 *
 * Screenshots carry no orientation tag, so none of this fires on any input
 * measured so far. That is the argument for handling it now rather than when
 * someone shares a photo of a screen.
 */
export function orientedSize(width, height, orientation = 1) {
  return orientation >= 5 && orientation <= 8
    ? { width: height, height: width, swapped: true }
    : { width, height, swapped: false };
}

/** Whether an orientation needs any work at all. 1 and anything unknown mean no. */
export function needsOrientation(orientation) {
  return Number.isInteger(orientation) && orientation >= 2 && orientation <= 8;
}
