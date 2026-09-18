// One clamped sub-rect read, shared by the product pipeline and the Phase 0
// measurement harness.
//
// It was two copies with different field names for the same values — pipeline.js
// returned `{width, height}` and measure.js returned `{w, h}` — which is worse
// than a plain duplicate, because a reader who knows one file's shape reads the
// other one wrong. This is the same lesson `intersectRect` recorded a day
// earlier: the fifth copy of a shape is not found by remembering the first four.
//
// No Skia import, deliberately. The colour constants arrive as an argument, so
// this module loads in node and `read.test.mjs` can exercise it against a fake
// image. Neither copy had a test before, because both sat in files that cannot
// load off-device, and the arithmetic they shared is exactly the part worth
// testing.
import { intersectRect } from './pixels.js';

/**
 * Read ONE sub-rect as a flat buffer, never the whole image.
 *
 * This is the memory fix: a 1080x20000 capture is ~82MiB as a single RGBA
 * buffer, and neither the ring statistics nor the status-bar profile needs more
 * than a slice. readPixels takes width/height in its ImageInfo, so the slice is
 * free — the full-buffer version was never necessary, only easier to write.
 *
 * The rect is INTERSECTED with the image, not clamped field by field, so a drag
 * past the edge cannot ask for pixels that do not exist. Two behaviour changes
 * came out of that fix, both only reachable by a rect the old code should never
 * have answered at all:
 *
 *   - A rect entirely off the image used to come back as a 1px sliver of the
 *     nearest edge, because the old clamp forced w and h to at least 1. It now
 *     returns null, and this function returns null with it.
 *   - A rect hanging off the left or top used to come back WIDER than requested,
 *     measuring its width from the clamped origin rather than the requested one.
 *
 * The comment this replaced claimed that every box is dragged inside the canvas,
 * so no published figure was believed to have hit the defect. **That was wrong,
 * and the re-run disproved it.** The default box logs as
 * `{x:-781, y:891, w:1783, h:386}` — 781px off the left edge — so the published
 * Q1 read went straight through the defect. It read 1440 columns where 1008 were
 * requested: 687,744 bytes, 30% of the read, discarded unused.
 *
 * Every Q1 statistic reproduced exactly anyway (`#010101`, spread 3.15, coverage
 * 0.7766, mean `#222222`, sd 69.08), because the ring's rightmost column is 1007
 * and a 1008-wide buffer still covers it. The defect cost bandwidth, not
 * correctness — there. See results/phase0-device.md for the arithmetic.
 *
 * @param img     anything with `width()`, `height()` and `readPixels(x, y, info)`
 * @param box     requested rect in image pixels; may hang off any edge
 * @param colour  `{colorType, alphaType}`, passed in so this file needs no Skia
 * @returns       `{buf, rowBytes, width, height, rect, bytes}`, or null
 *
 * `rect` is the rect actually read, which is what a caller needs to translate a
 * box into the returned buffer's own coordinates. `width`/`height` are the
 * spelling pixels.js's positional arguments are documented against; `w`/`h` are
 * deliberately absent so the two shapes cannot drift apart again.
 */
export function readSubRect(img, box, colour) {
  const r = intersectRect(img.width(), img.height(), box);
  if (!r) return null;
  const buf = img.readPixels(r.x, r.y, {
    width: r.w,
    height: r.h,
    colorType: colour.colorType,
    alphaType: colour.alphaType,
  });
  // readPixels returns null on failure rather than throwing, so an unchecked
  // caller gets a null dereference pointing at the wrong layer.
  if (!buf) return null;
  return { buf, rowBytes: r.w * 4, width: r.w, height: r.h, rect: r, bytes: buf.length };
}
