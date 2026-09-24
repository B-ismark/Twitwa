// Output size for a rendered card. Pure arithmetic, no Skia, no device.
//
// This is the spec's "Output spec" section as code, so the rules stop living
// only in prose. The one that matters most is what is NOT here: there is no
// long-edge cap. An earlier draft capped the long edge at 1600px, which turned a
// 1080x6000 thread crop into 316x1600 — a 0.26 scale factor that renders 36px
// source text at 9.4px. Unreadable, silently, on the input most worth
// supporting. `BREAK=longedge` in the tests reintroduces that cap so the
// assertion guarding against it is shown to be live.
//
// NOR IS THERE A TARGET WIDTH, since 2026-09-24. The card used to be scaled to
// fit 1080 wide, padding included, which on the Pixel's 1440-wide screenshots
// is a 0.67 resample — and Skia's drawImageRect samples nearest-neighbour, so
// one row and one column in three simply vanished and the text came out broken.
// The owner reported it as "blurry after editing". The rule now is that the
// crop is copied 1:1 and the padding is added around it; the card is as wide
// as the crop plus its frame. The ceilings below are the only thing that can
// shrink it, and each one exists for a hardware reason, not for looks.

export const WARN_H = 4000;     // above this, chat apps will downscale the preview

// A width ceiling, which the 1080 target used to provide for free. Without one
// a panorama shared in from Photos composes to a surface wider than the
// measured MEASURED_SURFACE_MAX and MakeOffscreen answers null. Same value as
// MAX_H, for the same reason.
export const MAX_W = 8000;

// Both of the next two were provisional pending Phase 0 Q5. Q5 has now run on a
// device (results/phase0-device.md) and they come out differently:
//
// MAX_H survives with room to spare. The real hardware ceiling is
// Skia.Surface.MakeOffscreen, measured between 16256 (composes) and 16384
// (returns null) on a Mali-G78, so 8000 has about 2x headroom. It stays.
export const MAX_H = 8000;

// MAX_PX is live since the target width went (2026-09-24). Before that it could
// never fire: width was at most 1080 and height at most MAX_H, so no output
// exceeded 8.64MP, and it sat here as a guard for a branch nobody could reach.
//
// What it limits is TIME, not memory. On the device a 19.64MP surface composed
// and encoded without complaint and a full 82.4MiB readPixels never failed; the
// cost is ~50-60ms per megapixel, 92.5% of it the PNG encoder. So the value is
// the smallest one that keeps the promise "never shrink a phone screenshot":
// a full-width crop from the Pixel 6 Pro (1440 wide, like the other QHD+
// phones) at the ROOMIEST stop, MAX_H tall, is 1728 x 8000 = 13.8MP. 14MP is about 800ms of encoding at the far
// end, and only a scrolling capture of 8000px gets near it. sizing.test.mjs
// asserts that slack, so lowering this below it re-arms shrinking on real
// screenshots and fails a test instead of quietly blurring them again.
export const MAX_PX = 14e6;

// The measured surface ceiling. Not enforced per call: MAX_W and MAX_H bound
// the output to 8000 on a side, so this is unreachable through cardSize and a
// runtime guard here would be dead code. It is one driver's value, not a portable constant.
//
// It IS asserted, though, which it was not before. This was exported and
// referenced by nothing at all — a measured number with `export const` in front
// of it, which is a comment wearing a constant's clothes, and `check-dead.mjs`
// is what said so. Its own note already stated the rule: "the number to check
// first if TARGET_W or MAX_H ever grow" (TARGET_W is gone since 2026-09-24;
// MAX_W bounds the width now). sizing.test.mjs checks it, so growing MAX_W or
// MAX_H past this fails a test instead of producing an output size the
// driver answers with a null surface. `BREAK=surface_ceiling_slack` raises MAX_H
// past it.
export const MEASURED_SURFACE_MAX = 16256;

export const PADDING = {
  snug: 0.03,
  standard: 0.06,
  roomy: 0.10,
};

/**
 * The smallest padding in SOURCE pixels, whatever fraction was asked for. A
 * 2% frame on a 300px-wide crop is six pixels, which is a hairline rather than
 * a frame.
 */
export const MIN_PAD = 12;

/**
 * The padding a fraction comes to, in SOURCE pixels.
 *
 * ONE definition, because there are now two readers and they must agree
 * exactly. `cardSize` uses it to lay the card out; `setPadding` in src/shell.js
 * uses it to decide whether a dragged value is the same card as a named stop.
 *
 * That second reader is why this is a function and not a line inside
 * `cardSize`. The padding slider used to snap inside a hand-picked band of
 * 0.004, which on the 0.03-0.10 range is 11% of the track: measured on the
 * device on 2026-09-18, the thumb sat still through 100px of finger travel at
 * Standard and then jumped 89px. The band is now exactly the set of fractions
 * that round to the SAME padding in source pixels -- i.e. that draw the same
 * card -- so the thumb pauses at a stop for precisely as long as it pauses
 * anywhere else on the track, and not a pixel longer. Derived from this
 * rounding it cannot drift away from it; typed as a constant beside it, it
 * would.
 */
export function padPixels(cropW, pct) {
  return Math.max(MIN_PAD, Math.round(cropW * pct));
}

/**
 * @param crop   {w, h} in source pixels
 * @param stop   'snug' | 'standard' | 'roomy', or a number as a fraction of crop width
 * @returns      {width, height, pad, dest, scale, clamped, warnings}
 *
 * `pad` and `dest` are in OUTPUT pixels — they are what the compositor draws, so
 * returning source-space values would make every caller redo the same
 * multiplication and get the rounding slightly differently.
 *
 * `dest` is derived by SUBTRACTION — `width - 2 * pad` — rather than by scaling
 * the crop independently. That is the whole point of returning it. Scaling the
 * crop and the padding separately lets rounding land a different margin on each
 * side, which is a one-pixel bright line down one edge of a card whose entire
 * purpose is the frame. An earlier version of this file rounded the padding to an
 * even number believing that fixed it; it does not, and could not — padding is
 * added twice from one value, so it is symmetric whatever its parity. Subtraction
 * is what makes the two margins equal by construction.
 */
export function cardSize(crop, stop = 'standard') {
  const pct = typeof stop === 'number' ? stop : PADDING[stop];
  if (!pct) throw new Error(`unknown padding stop: ${String(stop)}`);
  if (!(crop.w > 0) || !(crop.h > 0)) throw new Error(`bad crop: ${crop.w}x${crop.h}`);

  const padSrc = padPixels(crop.w, pct);
  const paddedW = crop.w + padSrc * 2;
  const paddedH = crop.h + padSrc * 2;

  // 1:1. The crop's pixels are copied, not resampled, and the padding is added
  // around them: neither shrinking (which is what made cards blurry) nor
  // upscaling (which would make a 720p crop soft).
  let scale = 1;

  let width = Math.round(paddedW);
  let height = Math.round(paddedH);
  let clamped = false;

  // The ceilings are for the surface and the encoder, not for looks, and they
  // are the only way a card comes out smaller than its crop.
  if (width > MAX_W || height > MAX_H || width * height > MAX_PX) {
    scale = Math.min(MAX_W / width, MAX_H / height, Math.sqrt(MAX_PX / (width * height)));
    // FLOORED, not rounded. Rounding both sides of a sqrt-scaled pixel budget
    // can round both up: 1493x7700 at Roomy came out 1771x7907 = 14,003,297px,
    // over the ceiling it was clamped to (found in review, 2026-09-24). The
    // epsilon keeps an exact fit — paddedH * (8000 / paddedH) — from flooring to
    // 7999 on float error. And never below one pixel: a 1x1e6 crop rounded its
    // width to 0 and planned a surface with no columns and a pad of -1.
    const fit = (v) => Math.max(1, Math.floor(v + 1e-9));
    width = fit(paddedW * scale);
    height = fit(paddedH * scale);
    clamped = true;
  }

  const warnings = [];
  if (clamped) warnings.push('clamped to the encode ceiling; the card is smaller than requested');
  // The number is interpolated, not written out. It used to read "taller than
  // 4000px" beside a comparison against WARN_H, so lowering WARN_H would have
  // produced a warning naming a height it no longer used — and sizing.test.mjs
  // asserted on the string '4000px', so the test would have kept passing while
  // saying the wrong thing. The test now asserts against the constant.
  if (height > WARN_H) warnings.push(`taller than ${WARN_H}px: chat apps will downscale the preview`);

  let pad = Math.round(padSrc * scale);

  // `height`, `width` and `pad` are each rounded independently, and for a very
  // thin crop the padding catches up with the whole card: a 1440x1 crop, back
  // when cards were scaled to 1080 wide, gave width 1080, height 116, pad 58 —
  // and a destination 964x0, with no warning, because 2*58 is exactly 116. The planner accepted it and composition then
  // had no row to draw into.
  //
  // The repair GROWS the card rather than shrinking the padding, because the
  // padding is what the caller asked for and the height is free — except on the
  // width axis, which only a clamped card can reach, and a clamped width is at
  // its ceiling and so has to give up padding instead. Both keep one integer `pad` on all four sides, so the margins stay
  // equal; see the note on `dest` below for why that is derived by subtraction.
  //
  // Reachable today only from a synthetic crop — the detector never emits a crop
  // this thin — but Phase 2 hands the crop to a thumb, and a thin drag is the
  // easiest gesture to make by accident.
  let repaired = null;
  if (width - pad * 2 < 1) {
    pad = Math.floor((width - 1) / 2);
    repaired = 'width';
  }
  if (height - pad * 2 < 1) {
    height = pad * 2 + 1;
    repaired = repaired ? 'both' : 'height';
  }
  if (repaired) {
    warnings.push(`the crop is thinner than the padding rounds to; the card grew on the ${repaired} axis to keep one row of image`);
  }

  return {
    width,
    height,
    pad,
    repaired,
    // Derived by subtraction so the left margin and the right margin are the
    // same integer, and likewise top and bottom. Never scale the crop separately.
    dest: { x: pad, y: pad, w: width - pad * 2, h: height - pad * 2 },
    scale: +scale.toFixed(6),
    clamped,
    warnings,
  };
}

/**
 * How the crop must be drawn into `dest`: 'exact' or 'smooth'.
 *
 * Exact when the destination is the crop's own size, which is every card below
 * the ceilings. Skia's plain drawImageRect samples nearest-neighbour, and at
 * 1:1 on integer rects nearest-neighbour IS a copy: measured on the device on
 * 2026-09-24, all 4,214,808 image pixels of a 1440-wide card equal the source.
 *
 * Smooth for everything else, which is only a card a ceiling has shrunk. That
 * same nearest-neighbour sampling at 0.67 dropped a row and a column in three
 * and was the blur the owner reported; a clamped card is still resampled, so it
 * is resampled with filtering (linear, with mipmaps for the heavy clamps,
 * drawn through an image shader in pipeline.js because RN Skia's
 * drawImageRectOptions silently drops the mipmaps) rather than by throwing
 * pixels away.
 *
 * Decided from the geometry rather than from `scale`, because `scale` is
 * rounded for reporting and the geometry is what is actually drawn.
 */
export function samplingFor(crop, dest) {
  return dest.w === crop.w && dest.h === crop.h ? 'exact' : 'smooth';
}
