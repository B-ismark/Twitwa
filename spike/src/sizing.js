// Output size for a rendered card. Pure arithmetic, no Skia, no device.
//
// This is the spec's "Output spec" section as code, so the rules stop living
// only in prose. The one that matters most is what is NOT here: there is no
// long-edge cap. An earlier draft capped the long edge at 1600px, which turned a
// 1080x6000 thread crop into 316x1600 — a 0.26 scale factor that renders 36px
// source text at 9.4px. Unreadable, silently, on the input most worth
// supporting. `BREAK=longedge` in the tests reintroduces that cap so the
// assertion guarding against it is shown to be live.

export const TARGET_W = 1080;   // width to aim for; never exceeded, never upscaled to
export const WARN_H = 4000;     // above this, chat apps will downscale the preview

// Both of the next two were provisional pending Phase 0 Q5. Q5 has now run on a
// device (results/phase0-device.md) and they come out differently:
//
// MAX_H survives with room to spare. The real hardware ceiling is
// Skia.Surface.MakeOffscreen, measured between 16256 (composes) and 16384
// (returns null) on a Mali-G78, so 8000 has about 2x headroom. It stays.
export const MAX_H = 8000;

// MAX_PX HAS NEVER BEEN ABLE TO FIRE, and two justifications were written for it
// before anyone checked that.
//
// The first called it an encoder and heap limit. The device disagreed: a 19.64MP
// surface composed and encoded without complaint, and a full 82.4MiB readPixels
// never failed. So it was re-justified on TIME — ~50-60ms per megapixel, 92.5% of
// it the PNG encoder, making 10MP about 550ms of encoding. That reasoning is
// sound and it is still about a branch that cannot be reached.
//
// cardSize scales the PADDED crop to fit TARGET_W, so width is at most 1080, and
// clamps height to MAX_H = 8000. The largest output the function can produce is
// therefore 8.64MP — below this ceiling, always. The `width * height > MAX_PX`
// disjunct in the clamp is dead code.
//
// It is kept rather than deleted because it is the guard that would matter the
// moment TARGET_W or MAX_H grows, and `sizing.test.mjs` asserts the slack
// (TARGET_W * MAX_H <= MAX_PX) so that raising either constant past it fails a
// test instead of silently arming a limit nobody has thought about since.
export const MAX_PX = 10e6;

// The measured surface ceiling. Not enforced per call: MAX_H bounds output
// height to 8000, so this is unreachable through cardSize and a runtime guard
// here would be dead code. It is one driver's value, not a portable constant.
//
// It IS asserted, though, which it was not before. This was exported and
// referenced by nothing at all — a measured number with `export const` in front
// of it, which is a comment wearing a constant's clothes, and `check-dead.mjs`
// is what said so. Its own note already stated the rule: "the number to check
// first if TARGET_W or MAX_H ever grow". sizing.test.mjs now checks it, so
// growing either past this fails a test instead of producing an output size the
// driver answers with a null surface. `BREAK=surface_ceiling_slack` raises MAX_H
// past it.
export const MEASURED_SURFACE_MAX = 16256;

export const PADDING = {
  snug: 0.03,
  standard: 0.06,
  roomy: 0.10,
};

const MIN_PAD = 12;

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

  const padSrc = Math.max(MIN_PAD, Math.round(crop.w * pct));
  const paddedW = crop.w + padSrc * 2;
  const paddedH = crop.h + padSrc * 2;

  // Width-bounded, and never upscaling: a crop from a 720p phone yields a
  // smaller card rather than a soft one.
  let scale = Math.min(1, TARGET_W / paddedW);

  let width = Math.round(paddedW * scale);
  let height = Math.round(paddedH * scale);
  let clamped = false;

  // The ceiling is for the encoder and the heap, not for looks.
  if (height > MAX_H || width * height > MAX_PX) {
    const byHeight = MAX_H / height;
    const byPixels = Math.sqrt(MAX_PX / (width * height));
    scale *= Math.min(byHeight, byPixels);
    width = Math.round(paddedW * scale);
    height = Math.round(paddedH * scale);
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
  if (scale === 1 && paddedW < TARGET_W) warnings.push('source is smaller than the target; not upscaled');

  let pad = Math.round(padSrc * scale);

  // `height`, `width` and `pad` are each rounded independently, and for a very
  // thin crop the padding catches up with the whole card: a 1440x1 crop gave
  // width 1080, height 116, pad 58 — and a destination 964x0, with no warning,
  // because 2*58 is exactly 116. The planner accepted it and composition then
  // had no row to draw into.
  //
  // The repair GROWS the card rather than shrinking the padding, because the
  // padding is what the caller asked for and the height is free — except on the
  // width axis, which is capped at TARGET_W and so has to give up padding
  // instead. Both keep one integer `pad` on all four sides, so the margins stay
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
