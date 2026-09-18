// Tests for src/pixels.js against synthetic buffers.
//
// Each assertion group has a matching BREAK= mutation that makes it go red, so
// a green run is evidence rather than decoration:
//
// Derive the list from this file rather than typing it — the hand-written
// list that used to sit here had fallen nine names behind, and a mutation nobody
// runs is indistinguishable from one that cannot fail:
//
//   for b in $(grep -o "BREAK === '[a-z_0-9]*'" src/pixels.test.mjs \
//              | sed "s/.*'\\(.*\\)'/\\1/" | sort -u); do
//     BREAK=$b node src/pixels.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one of those must print 1. There are 32 as of 2026-09-17.
import * as real from './pixels.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

// --- mutations, each aimed at exactly one assertion group -------------------
if (BREAK === 'ring_flat') {
  F.ringStats = (...a) => { const r = real.ringStats(...a); r.stddev = [9, 9, 9]; return r; };
} else if (BREAK === 'ring_var') {
  F.ringStats = (...a) => { const r = real.ringStats(...a); r.stddev = [0, 0, 0]; return r; };
} else if (BREAK === 'ring_clip') {
  F.ringStats = () => null;
} else if (BREAK === 'ink') {
  F.rowInkProfile = (b, rb, w, h, rows) => new Float32Array(Math.min(rows, h));
} else if (BREAK === 'col_is_row') {
  // The transposition bug in its purest form: a column profile that is a row
  // profile. Identical on a square image, and the auto-crop's left and right
  // trims then come from the top and bottom of the screenshot.
  F.colInkProfile = (buf, rowBytes, width, height, cols, step = 2) =>
    real.rowInkProfile(buf, rowBytes, width, height, cols, step);
} else if (BREAK === 'col_limit_height') {
  // `cols` clamped against the height instead of the width. On a tall phone
  // screenshot this returns a profile longer than the image is wide, whose
  // tail is read from off the right-hand edge.
  F.colInkProfile = (buf, rowBytes, width, height, cols, step = 2) => {
    const full = real.colInkProfile(buf, rowBytes, width, height, width, step);
    const out = new Float32Array(Math.min(cols, height));
    for (let i = 0; i < out.length; i++) out[i] = full[i] || 0;
    return out;
  };
} else if (BREAK === 'col_no_step') {
  // Subsample nothing, so the answer is right and the cost is not. Invisible
  // against a reference that also ignores step; caught by the transpose,
  // which does not.
  F.colInkProfile = (buf, rowBytes, width, height, cols) =>
    real.colInkProfile(buf, rowBytes, width, height, cols, 1);
} else if (BREAK === 'ink_fast_max') {
  // The running-max optimisation done wrong: take the LAST bucket's count
  // instead of the largest. Plausible, and silently changes every row.
  F.rowInkProfile = (buf, rowBytes, width, height, rows, step = 2) => {
    const limit = Math.min(rows, height);
    const hist = new Int32Array(4096);
    const out = new Float32Array(limit);
    for (let y = 0; y < limit; y++) {
      hist.fill(0);
      let n = 0;
      let last = 0;
      const rowStart = y * rowBytes;
      for (let x = 0; x < width; x += step) {
        const i = rowStart + x * 4;
        const k = ((buf[i] >> 4) << 8) | ((buf[i + 1] >> 4) << 4) | (buf[i + 2] >> 4);
        last = ++hist[k];
        n++;
      }
      out[y] = n ? 1 - last / n : 0;
    }
    return out;
  };
} else if (BREAK === 'ink_fast_offset') {
  // The hand-inlined read off by one byte: G, B, A instead of R, G, B. This is
  // the slip inlining actually invites, and it is observable because alpha is
  // constant, so one of the three nibbles carries no information and buckets
  // that were distinct collapse together.
  //
  // A NOTE ON A MUTATION THAT WAS REJECTED. The first attempt here permuted the
  // key's nibble fields — R<<4|G<<8|B instead of R<<8|G<<4|B — on the theory
  // that a wrong shift order is the likely typo. It cannot be caught, and the
  // reason is worth keeping: both forms are bijections on the 12-bit triple, and
  // rowInkProfile only ever reads the LARGEST bucket count. Relabelling buckets
  // does not change which one is largest. So the channel order inside key12 is
  // not load-bearing, and a test asserting it would be asserting an
  // implementation detail that no output depends on.
  F.rowInkProfile = (buf, rowBytes, width, height, rows, step = 2) => {
    const limit = Math.min(rows, height);
    const hist = new Int32Array(4096);
    const out = new Float32Array(limit);
    for (let y = 0; y < limit; y++) {
      hist.fill(0);
      let n = 0;
      let best = 0;
      const rowStart = y * rowBytes;
      for (let x = 0; x < width; x += step) {
        const i = rowStart + x * 4;
        const k = ((buf[i + 1] >> 4) << 8) | ((buf[i + 2] >> 4) << 4) | (buf[i + 3] >> 4);
        const c = ++hist[k];
        if (c > best) best = c;
        n++;
      }
      out[y] = n ? 1 - best / n : 0;
    }
    return out;
  };
} else if (BREAK === 'sb_cut') {
  F.detectStatusBar = (...a) => { const r = real.detectStatusBar(...a); r.cut += 50; return r; };
} else if (BREAK === 'sb_none') {
  F.detectStatusBar = (...a) => ({ ...real.detectStatusBar(...a), detected: true });
} else if (BREAK === 'sb_lead') {
  // The ORIGINAL detectStatusBar, restored verbatim. It took the first flat run
  // from the top, so the padding above the clock satisfied it and it cut at row
  // 1. Kept here so the leading-padding test below is shown to catch that exact
  // regression rather than merely agreeing with the current code.
  F.detectStatusBar = (profile, { flat = 0.01, run = 8, minRow = 8 } = {}) => {
    let streak = 0;
    for (let y = 0; y < profile.length; y++) {
      if (profile[y] <= flat) {
        streak++;
        if (streak >= run && y >= minRow) return { cut: y - run + 1, detected: true };
      } else {
        streak = 0;
      }
    }
    return { cut: 0, detected: false };
  };
} else if (BREAK === 'delta') {
  F.maxChannelDelta = (...a) => ({ ...real.maxChannelDelta(...a), max: 0 });
} else if (BREAK === 'bg_mean') {
  // The naive implementation: use the ring's MEAN as the background. This is
  // the bug the robust version exists to avoid, so the text-in-ring assertions
  // must catch it.
  F.ringBackground = (...a) => {
    const m = real.ringStats(...a);
    if (!m) return null;
    return { n: m.n, background: m.n, coverage: 1, mean: m.mean, hex: m.hex,
      spread: Math.max(...m.stddev) };
  };
} else if (BREAK === 'ring_overlap') {
  // Let left and right run the full padded height, so the corners are read
  // twice. The estimator then double-weights four small regions.
  F.ringStrips = (box, t, width, height) => {
    const { x, y, w, h } = box;
    const clip = (r) => {
      const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
      const x1 = Math.min(width, r.x + r.w), y1 = Math.min(height, r.y + r.h);
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    };
    return [
      { x: x - t, y: y - t, w: w + 2 * t, h: t },
      { x: x - t, y: y + h, w: w + 2 * t, h: t },
      { x: x - t, y: y - t, w: t, h: h + 2 * t },
      { x: x + w, y: y - t, w: t, h: h + 2 * t },
    ].map(clip).filter(Boolean);
  };
} else if (BREAK === 'ring_gap') {
  // Drop the corners: top and bottom span only the box's own width.
  F.ringStrips = (box, t, width, height) => {
    const { x, y, w, h } = box;
    const clip = (r) => {
      const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
      const x1 = Math.min(width, r.x + r.w), y1 = Math.min(height, r.y + r.h);
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    };
    return [
      { x, y: y - t, w, h: t },
      { x, y: y + h, w, h: t },
      { x: x - t, y, w: t, h },
      { x: x + w, y, w: t, h },
    ].map(clip).filter(Boolean);
  };
} else if (BREAK === 'ring_unclamped') {
  // Skip the intersection with the image, which is how a strip ends up asking
  // for pixels outside the buffer.
  F.ringStrips = (box, t) => {
    const { x, y, w, h } = box;
    return [
      { x: x - t, y: y - t, w: w + 2 * t, h: t },
      { x: x - t, y: y + h, w: w + 2 * t, h: t },
      { x: x - t, y, w: t, h },
      { x: x + w, y, w: t, h },
    ];
  };
} else if (BREAK === 'ring_whole_box') {
  // The defect being fixed: one read of the box's padded bounding rectangle.
  F.ringStrips = (box, t, width, height) => {
    const x0 = Math.max(0, box.x - t), y0 = Math.max(0, box.y - t);
    const x1 = Math.min(width, box.x + box.w + t), y1 = Math.min(height, box.y + box.h + t);
    return x1 > x0 && y1 > y0 ? [{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }] : [];
  };
} else if (BREAK === 'bg_spread') {
  F.ringBackground = (...a) => { const r = real.ringBackground(...a); if (r) r.spread = 0; return r; };
} else if (BREAK === 'bg_cov') {
  F.ringBackground = (...a) => { const r = real.ringBackground(...a); if (r) r.coverage = 1; return r; };
} else if (BREAK === 'runs') {
  F.inkRuns = (...a) => real.inkRuns(...a).map((r) => ({ ...r, gapAbove: 0, gapBelow: 0 }));
} else if (BREAK === 'sb_shape') {
  F.looksLikeStatusBar = (...a) => ({ ...real.looksLikeStatusBar(...a), likely: true, reasons: [] });
} else if (BREAK === 'zones') {
  F.zoneInk = (b, rb, w) => new Float32Array(5);
} else if (BREAK === 'edge_one') {
  // Pick the top edge and hope — the approach the agreement test exists to
  // replace. On a crop straddling a boundary it returns a confident wrong colour.
  F.cropBackground = (buf, rb, w, h, crop, opts = {}) => {
    const t = opts.thickness || 8;
    const s = real.regionBackground(buf, rb, w, h, { x: crop.x, y: crop.y, w: crop.w, h: t });
    return { source: 'sampled', hex: s.hex, mean: s.mean, maxEdgeDiff: 0, edges: { top: s } };
  };
} else if (BREAK === 'no_agree') {
  F.cropBackground = (...a) => {
    const r = real.cropBackground(...a);
    return { ...r, source: 'sampled' };
  };
} else if (BREAK === 'crop_mid') {
  // Sample the whole crop rather than its edges, so middle content reaches the
  // frame colour.
  F.cropBackground = (buf, rb, w, h, crop) => {
    const s = real.regionBackground(buf, rb, w, h, crop, 16, 2);
    return { source: 'sampled', hex: s.hex, mean: s.mean, maxEdgeDiff: 0, edges: {} };
  };
} else if (BREAK === 'luma_flip') {
  F.cropBackground = (...a) => {
    const r = real.cropBackground(...a);
    if (r.source !== 'fallback' || !r.hex) return r;
    return { ...r, hex: r.hex === real.INK ? real.PAPER : real.INK };
  };
} else if (BREAK === 'isect_clamp_fields') {
  // THE defect this function was extracted to delete, in its original form:
  // measure.js's clamp, which measured the width from the CLAMPED origin and so
  // returned a rect wider than the one it was asked for.
  F.intersectRect = (width, height, box) => {
    const x0 = Math.max(0, Math.min(width - 1, Math.round(box.x)));
    const y0 = Math.max(0, Math.min(height - 1, Math.round(box.y)));
    return {
      x: x0,
      y: y0,
      w: Math.max(1, Math.min(width - x0, Math.round(box.w))),
      h: Math.max(1, Math.min(height - y0, Math.round(box.h))),
    };
  };
} else if (BREAK === 'isect_never_null') {
  // The other half of the old behaviour: a rect entirely off the image came back
  // as a 1px sliver of the nearest edge rather than as "no overlap".
  F.intersectRect = (width, height, box) => {
    const r = real.intersectRect(width, height, box);
    if (r) return r;
    return {
      x: Math.max(0, Math.min(width - 1, Math.round(box.x))),
      y: Math.max(0, Math.min(height - 1, Math.round(box.y))),
      w: 1,
      h: 1,
    };
  };
} else if (BREAK === 'isect_transpose') {
  // Bound x by the height and y by the width. Invisible on a square image,
  // which is why the assertions use 140x37.
  F.intersectRect = (width, height, box) => real.intersectRect(height, width, box);
} else if (BREAK === 'isect_unrounded') {
  // Drop the rounding. A fractional rect then yields fractional w/h, and every
  // caller multiplies those into a byte offset.
  F.intersectRect = (width, height, box) => {
    const x0 = Math.max(0, box.x);
    const y0 = Math.max(0, box.y);
    const x1 = Math.min(width, box.x + box.w);
    const y1 = Math.min(height, box.y + box.h);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
} else if (BREAK === 'region_unclipped') {
  F.regionBackground = (...a) => { const r = real.regionBackground(...a); if (r) r.n = 999; return r; };
} else if (BREAK === 'region_clamp_fields') {
  // The original bounds: x1 derived from the CLAMPED x0, so a rect hanging off
  // the left or top edge samples wider than it was asked for.
  F.regionBackground = (buf, rowBytes, width, height, rect, tolerance = 16, step = 1) => {
    const x0 = Math.max(0, Math.round(rect.x));
    const y0 = Math.max(0, Math.round(rect.y));
    const x1 = Math.min(width, x0 + Math.round(rect.w));
    const y1 = Math.min(height, y0 + Math.round(rect.h));
    const pts = [];
    for (let yy = y0; yy < y1; yy += step) {
      for (let xx = x0; xx < x1; xx += step) {
        const i = yy * rowBytes + xx * 4;
        pts.push(buf[i], buf[i + 1], buf[i + 2]);
      }
    }
    return real.modalOfPoints(pts, tolerance);
  };
} else if (BREAK === 'tiles_one') {
  // One tile in the middle instead of a grid, which is the tempting cheap
  // version and is wrong: a single region can land entirely on a photo.
  F.tileGrid = (crop) => [{
    x: Math.round(crop.x + crop.w / 2 - 24),
    y: Math.round(crop.y + crop.h / 2 - 24),
    w: Math.min(48, crop.w),
    h: Math.min(48, crop.h),
  }];
} else if (BREAK === 'tiles_whole') {
  // The fallback as it was: one rect covering the entire crop.
  F.tileGrid = (crop) => [{ x: crop.x, y: crop.y, w: crop.w, h: crop.h }];
}

// --- tiny harness -----------------------------------------------------------
let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// --- synthetic images -------------------------------------------------------
function blank(w, h, rgb) {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = rgb[0]; buf[i * 4 + 1] = rgb[1]; buf[i * 4 + 2] = rgb[2]; buf[i * 4 + 3] = 255;
  }
  return { buf, w, h, rowBytes: w * 4 };
}
function fillRect(img, { x, y, w, h }, rgb) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = yy * img.rowBytes + xx * 4;
      img.buf[i] = rgb[0]; img.buf[i + 1] = rgb[1]; img.buf[i + 2] = rgb[2];
    }
  }
}

// ===========================================================================
console.log('ringStats on a flat ground');
{
  const img = blank(120, 120, [246, 244, 239]);          // Paper
  const box = { x: 40, y: 40, w: 30, h: 12 };
  const s = F.ringStats(img.buf, img.rowBytes, img.w, img.h, box);
  check('mean equals the ground', s.hex === '#F6F4EF', s.hex);
  check('stddev is zero on flat pixels', s.stddev.every((v) => v === 0), JSON.stringify(s.stddev));
  check('maxDev is zero on flat pixels', s.maxDev === 0, s.maxDev);
  check('box interior is excluded from n', s.n === 42 * 24 - 30 * 12, s.n);
}

console.log('ringStats on a vertical gradient — the case that predicts a seam');
{
  const img = blank(120, 120, [0, 0, 0]);
  for (let y = 0; y < 120; y++) fillRect(img, { x: 0, y, w: 120, h: 1 }, [y * 2, y * 2, y * 2]);
  const s = F.ringStats(img.buf, img.rowBytes, img.w, img.h, { x: 40, y: 40, w: 30, h: 12 });
  check('stddev is non-zero on a gradient', s.stddev.every((v) => v > 1), JSON.stringify(s.stddev));
  check('maxDev is non-zero on a gradient', s.maxDev > 5, s.maxDev);
}

console.log('ringStats clipped at the top-left corner (asymmetric)');
{
  const img = blank(120, 120, [30, 30, 30]);
  const s = F.ringStats(img.buf, img.rowBytes, img.w, img.h, { x: 0, y: 0, w: 20, h: 20 }, 6);
  const clipped = 26 * 26 - 20 * 20;                     // no ring above or left
  check('does not return null at the corner', s !== null);
  check('n reflects the clip', s && s.n === clipped, s && `${s.n} != ${clipped}`);
}

console.log('ringStats when the box swallows the whole image');
{
  const img = blank(20, 20, [10, 10, 10]);
  const s = F.ringStats(img.buf, img.rowBytes, img.w, img.h, { x: 0, y: 0, w: 20, h: 20 }, 0);
  check('returns null rather than dividing by zero', s === null, JSON.stringify(s));
}

console.log('rowInkProfile');
{
  const img = blank(200, 60, [255, 255, 255]);
  fillRect(img, { x: 10, y: 20, w: 6, h: 6 }, [0, 0, 0]);   // a glyph
  fillRect(img, { x: 0, y: 40, w: 200, h: 6 }, [0, 0, 0]);  // a solid band
  const p = F.rowInkProfile(img.buf, img.rowBytes, img.w, img.h, 60);
  check('flat row scores zero', p[0] === 0, p[0]);
  check('glyph row scores above zero', p[22] > 0, p[22]);
  check('glyph row scores small', p[22] < 0.2, p[22]);
  check('solid band scores zero (it is its own modal colour)', p[42] === 0, p[42]);
}

console.log('detectStatusBar on a synthetic One-UI-ish screenshot');
{
  const img = blank(200, 300, [255, 255, 255]);
  for (let x = 4; x < 60; x += 8) fillRect(img, { x, y: 8, w: 3, h: 10 }, [0, 0, 0]);   // clock etc
  for (let x = 150; x < 190; x += 8) fillRect(img, { x, y: 8, w: 3, h: 10 }, [0, 0, 0]); // battery
  // rows 24..39 are flat, then a header full of ink
  for (let x = 0; x < 200; x += 3) fillRect(img, { x, y: 40, w: 1, h: 30 }, [40, 40, 40]);
  const p = F.rowInkProfile(img.buf, img.rowBytes, img.w, img.h, 120);
  const r = F.detectStatusBar(p);
  check('detects a cut', r.detected === true);
  check('cut lands in the flat gap, not in the glyphs', r.cut >= 18 && r.cut <= 32, r.cut);
}

console.log('detectStatusBar with realistic padding above the clock');
{
  // The case the first implementation got wrong. Rows 0-25 are flat because a
  // status bar has padding above its glyphs, so the FIRST flat run is at the
  // very top and cutting there trims nothing at all.
  const img = blank(200, 300, [255, 255, 255]);
  for (let x = 10; x < 70; x += 12) fillRect(img, { x, y: 26, w: 5, h: 20 }, [0, 0, 0]);
  for (let x = 140; x < 190; x += 14) fillRect(img, { x, y: 26, w: 5, h: 20 }, [0, 0, 0]);
  // flat 46..79, then a dense header
  for (let x = 0; x < 200; x += 3) fillRect(img, { x, y: 80, w: 1, h: 40 }, [40, 40, 40]);
  const p = F.rowInkProfile(img.buf, img.rowBytes, img.w, img.h, 120);
  const r = F.detectStatusBar(p);
  check('detects a cut', r.detected === true, JSON.stringify(r));
  check('cut is below the glyphs, not above them', r.cut >= 46 && r.cut <= 52, r.cut);
  check('cut is not in the leading padding', r.cut > 25, r.cut);
}

console.log('detectStatusBar when there is no flat gap');
{
  const img = blank(200, 300, [255, 255, 255]);
  for (let y = 0; y < 300; y++) fillRect(img, { x: (y * 7) % 190, y, w: 6, h: 1 }, [0, 0, 0]);
  const p = F.rowInkProfile(img.buf, img.rowBytes, img.w, img.h, 120);
  const r = F.detectStatusBar(p);
  check('reports not-detected instead of cutting at 0', r.detected === false, JSON.stringify(r));
}

console.log('maxChannelDelta');
{
  const a = blank(40, 40, [200, 50, 90]);
  const b = blank(40, 40, [200, 50, 90]);
  const region = { x: 5, y: 5, w: 20, h: 20 };
  check('identical buffers give zero', F.maxChannelDelta(a.buf, b.buf, a.rowBytes, region).max === 0);
  b.buf[10 * a.rowBytes + 10 * 4 + 1] = 57;             // +7 on green, inside region
  const d = F.maxChannelDelta(a.buf, b.buf, a.rowBytes, region);
  check('a single off pixel is caught', d.max === 7, d.max);
  check('mean stays small for one off pixel', d.mean > 0 && d.mean < 0.01, d.mean);
  const outside = { x: 30, y: 30, w: 5, h: 5 };
  check('region is respected', F.maxChannelDelta(a.buf, b.buf, a.rowBytes, outside).max === 0);
}

console.log('ringBackground is robust to text in the sampling ring');
{
  // Black ground with white glyphs in the ring — the real case. A mean fill is
  // dragged towards grey; a modal fill must not move.
  const img = blank(200, 200, [0, 0, 0]);
  const box = { x: 0, y: 100, w: 200, h: 20 };
  fillRect(img, { x: 20, y: 96, w: 40, h: 3 }, [255, 255, 255]);   // above the box
  fillRect(img, { x: 20, y: 121, w: 40, h: 3 }, [255, 255, 255]);  // below it

  const bg = F.ringBackground(img.buf, img.rowBytes, img.w, img.h, box, 6);
  const mean = F.ringStats(img.buf, img.rowBytes, img.w, img.h, box, 6);
  check('modal fill stays on the background', bg.hex === '#000000', bg.hex);
  check('modal spread stays near zero', bg.spread < 0.5, bg.spread);
  check('coverage reports the glyphs as not-background', bg.coverage < 1 && bg.coverage > 0.5,
    bg.coverage);
  check('a MEAN fill would have drifted', Math.max(...mean.stddev) > 5,
    JSON.stringify(mean.stddev));
}

console.log('ringBackground on a flat ring, and on a gradient');
{
  const flat = blank(120, 120, [30, 40, 50]);
  const b1 = F.ringBackground(flat.buf, flat.rowBytes, 120, 120, { x: 40, y: 40, w: 30, h: 12 }, 6);
  check('flat ring: spread zero', b1.spread === 0, b1.spread);
  check('flat ring: coverage 100%', b1.coverage === 1, b1.coverage);
  check('flat ring: exact colour', b1.hex === '#1E2832', b1.hex);

  const grad = blank(120, 120, [0, 0, 0]);
  for (let y = 0; y < 120; y++) fillRect(grad, { x: 0, y, w: 120, h: 1 }, [100 + y / 4, 100, 100]);
  const b2 = F.ringBackground(grad.buf, grad.rowBytes, 120, 120, { x: 40, y: 40, w: 30, h: 12 }, 6);
  check('gradient ring: spread non-zero', b2.spread > 0.5, b2.spread);
}

console.log('ringBackground when the box swallows the image');
{
  const img = blank(20, 20, [10, 10, 10]);
  const b = F.ringBackground(img.buf, img.rowBytes, 20, 20, { x: 0, y: 0, w: 20, h: 20 }, 0);
  check('returns null rather than dividing by zero', b === null, JSON.stringify(b));
}

console.log('inkRuns finds bands and their surrounding gaps');
{
  // flat 0-9, ink 10-19, flat 20-39, ink 40-44, flat 45-59
  const p = new Float32Array(60);
  for (let y = 10; y < 20; y++) p[y] = 0.2;
  for (let y = 40; y < 45; y++) p[y] = 0.5;
  const runs = F.inkRuns(p);
  check('finds both runs', runs.length === 2, runs.length);
  check('first run start/length', runs[0] && runs[0].start === 10 && runs[0].length === 10,
    JSON.stringify(runs[0]));
  check('second run start/length', runs[1] && runs[1].start === 40 && runs[1].length === 5,
    JSON.stringify(runs[1]));
  check('gap above the first run', runs[0] && runs[0].gapAbove === 10, runs[0] && runs[0].gapAbove);
  check('gap between the runs', runs[0] && runs[0].gapBelow === 20, runs[0] && runs[0].gapBelow);
  check('gap below the last run', runs[1] && runs[1].gapBelow === 15, runs[1] && runs[1].gapBelow);
}

console.log('looksLikeStatusBar separates a status bar from an app header');
{
  // Status bar shape: glyphs at both outer edges, empty middle, thin band.
  const sbImg = blank(200, 1000, [255, 255, 255]);
  for (let x = 4; x < 40; x += 8) fillRect(sbImg, { x, y: 10, w: 3, h: 12 }, [0, 0, 0]);
  for (let x = 160; x < 196; x += 8) fillRect(sbImg, { x, y: 10, w: 3, h: 12 }, [0, 0, 0]);
  const zsb = F.zoneInk(sbImg.buf, sbImg.rowBytes, 200, 8, 30);
  const vsb = F.looksLikeStatusBar(zsb, 30, 1000);
  check('status bar: ink at both edges', zsb[0] > 0 && zsb[4] > 0, JSON.stringify(Array.from(zsb)));
  check('status bar: empty middle', zsb[2] === 0, zsb[2]);
  check('status bar: judged likely', vsb.likely === true, JSON.stringify(vsb.reasons));

  // Header shape: an avatar and a name, so the middle is full.
  const hdImg = blank(200, 1000, [255, 255, 255]);
  fillRect(hdImg, { x: 8, y: 10, w: 150, h: 60 }, [40, 40, 40]);
  const zhd = F.zoneInk(hdImg.buf, hdImg.rowBytes, 200, 8, 80);
  const vhd = F.looksLikeStatusBar(zhd, 80, 1000);
  check('header: judged NOT a status bar', vhd.likely === false, JSON.stringify(vhd));
  check('header: gives a reason', vhd.reasons.length > 0, JSON.stringify(vhd.reasons));

  // Right shape, but far too tall to be chrome.
  const tall = F.looksLikeStatusBar(zsb, 400, 1000);
  check('correct shape but too tall is rejected', tall.likely === false, JSON.stringify(tall));
  check('and says why', tall.reasons.some((r) => r.includes('too tall')), JSON.stringify(tall.reasons));
}

console.log('regionBackground respects its rect');
{
  const img = blank(100, 100, [10, 20, 30]);
  fillRect(img, { x: 50, y: 0, w: 50, h: 100 }, [200, 200, 200]);
  const left = F.regionBackground(img.buf, img.rowBytes, 100, 100, { x: 0, y: 0, w: 50, h: 100 });
  const right = F.regionBackground(img.buf, img.rowBytes, 100, 100, { x: 50, y: 0, w: 50, h: 100 });
  check('left half reads its own colour', left.hex === '#0A141E', left.hex);
  check('right half reads its own colour', right.hex === '#C8C8C8', right.hex);
  const over = F.regionBackground(img.buf, img.rowBytes, 100, 100, { x: 90, y: 90, w: 500, h: 500 });
  check('a rect past the edge is clipped, not crashed', over !== null && over.n === 100, over && over.n);
}

console.log('luma orders light above dark');
{
  check('white is bright', F.luma([255, 255, 255]) > 250);
  check('black is dark', F.luma([0, 0, 0]) === 0);
  check('green weighs more than blue', F.luma([0, 255, 0]) > F.luma([0, 0, 255]));
}

console.log('cropBackground: four edges agreeing');
{
  const img = blank(200, 200, [32, 32, 32]);
  // Content in the middle, large enough to dominate the crop as a whole. The
  // edges must decide the frame; the middle must not reach it.
  fillRect(img, { x: 25, y: 25, w: 150, h: 150 }, [240, 200, 60 ]);
  const r = F.cropBackground(img.buf, img.rowBytes, 200, 200, { x: 0, y: 0, w: 200, h: 200 });
  check('agrees, so it samples', r.source === 'sampled', JSON.stringify(r).slice(0, 120));
  check('takes the edge colour, not the middle', r.hex === '#202020', r.hex);
  check('reports zero edge disagreement', r.maxEdgeDiff === 0, r.maxEdgeDiff);
}

console.log('cropBackground: a crop straddling a boundary must NOT pick an edge');
{
  // Top 40% white, bottom 60% black — the case where top and bottom edges each
  // give a confident, different, wrong answer.
  const img = blank(200, 200, [0, 0, 0]);
  fillRect(img, { x: 0, y: 0, w: 200, h: 80 }, [255, 255, 255]);
  const r = F.cropBackground(img.buf, img.rowBytes, 200, 200, { x: 0, y: 0, w: 200, h: 200 });
  check('refuses to trust one edge', r.source === 'fallback', JSON.stringify(r).slice(0, 140));
  check('says why', typeof r.reason === 'string' && r.reason.includes('disagree'), r.reason);
  check('falls back to Ink, since the crop is mostly dark', r.hex === real.INK, r.hex);
  check('the fallback is never a colour from halfway between',
    r.hex !== '#7F7F7F' && r.hex !== '#808080', r.hex);
  check('records the disagreement size', r.maxEdgeDiff > 200, r.maxEdgeDiff);
}

console.log('cropBackground: fallback picks Paper for a light crop');
{
  const img = blank(200, 200, [255, 255, 255]);
  fillRect(img, { x: 0, y: 160, w: 200, h: 40 }, [0, 0, 0]);
  const r = F.cropBackground(img.buf, img.rowBytes, 200, 200, { x: 0, y: 0, w: 200, h: 200 });
  check('still a fallback', r.source === 'fallback', r.source);
  check('falls back to Paper', r.hex === real.PAPER, r.hex);
}

console.log('cropBackground on a crop smaller than the strip thickness');
{
  const img = blank(40, 40, [77, 88, 99]);
  const r = F.cropBackground(img.buf, img.rowBytes, 40, 40, { x: 10, y: 10, w: 4, h: 4 },
    { thickness: 8 });
  check('clamps the strip instead of crashing', r !== null && r.source === 'sampled',
    JSON.stringify(r).slice(0, 100));
  check('still reads the right colour', r.hex === '#4D5863', r.hex);
}

console.log('regionBackground intersects its rect with the buffer');
{
  // 40x40, left half black and right half white. A rect at x=-10 w=30 asks for
  // 20 columns; the old bounds read 30, pulling in columns nobody asked for.
  // Asymmetric on purpose: with a symmetric buffer the two rules agree.
  const W = 40, H = 40, rb = W * 4;
  const buf = new Uint8Array(rb * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * rb + x * 4;
      const v = x < 20 ? 0 : 255;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
    }
  }
  const r = F.regionBackground(buf, rb, W, H, { x: -10, y: 0, w: 30, h: 40 }, 16, 1);
  check('samples only the requested columns', r.n === 20 * 40, r.n);
  check('and reads the colour there', r.hex === '#000000', r.hex);
  const inside = F.regionBackground(buf, rb, W, H, { x: 0, y: 0, w: 20, h: 40 }, 16, 1);
  check('a rect fully inside samples the same count', inside.n === r.n, inside.n + ' vs ' + r.n);
  // The discriminating assertion: without it, a rule that read 30 columns of a
  // buffer whose first 20 are black would still report #000000 and pass.
  check('the count is what separates the two rules', r.n !== 30 * 40, r.n);
}

console.log('a ring split between two colours reports it through coverage, not spread');
{
  // The boundary case for Q1. The modal estimator answers "which colour is the
  // background", so on a 50/50 ring it picks one and reports spread ~0 for that
  // cluster. Spread is NOT the signal here and never was; coverage is, which is
  // why ringBackground returns it and why pipeline.js warns below 0.6.
  const W = 40, H = 40, rb = W * 4;
  const buf = new Uint8Array(rb * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * rb + x * 4;
      const v = x < 20 ? 0 : 255;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
    }
  }
  const r = F.ringBackground(buf, rb, W, H, { x: 10, y: 10, w: 20, h: 20 }, 6);
  check('spread is near zero, which alone would look flat', r.spread < 1, r.spread);
  check('coverage exposes the split', r.coverage > 0.4 && r.coverage < 0.6, r.coverage);
  // And on a genuinely flat ring the same call must be near 1, or the check
  // above is measuring nothing.
  const flat = new Uint8Array(rb * H).fill(255);
  const f = F.ringBackground(flat, rb, W, H, { x: 10, y: 10, w: 20, h: 20 }, 6);
  check('a flat ring instead reports full coverage', f.coverage > 0.99, f.coverage);
}

console.log('the fallback tile grid is bounded and spread out');
{
  const tall = { x: 0, y: 0, w: 1080, h: 20000 };
  const tiles = F.tileGrid(tall);
  const px = tiles.reduce((a, t) => a + t.w * t.h, 0);
  check('more than one tile', tiles.length > 1, tiles.length);
  check('every tile is inside the crop', tiles.every((t) =>
    t.x >= tall.x && t.y >= tall.y && t.x + t.w <= tall.x + tall.w && t.y + t.h <= tall.y + tall.h));
  // The constraint that matters: peak read buffer. The whole-crop read this
  // replaced was 82.4MiB of RGBA.
  const peak = Math.max(...tiles.map((t) => t.w * t.h * 4));
  check('peak read stays under 64KiB', peak < 64 * 1024, (peak / 1024).toFixed(1) + 'KiB');
  check('total sampled is under 1% of the crop', px / (tall.w * tall.h) < 0.01,
    ((100 * px) / (tall.w * tall.h)).toFixed(3) + '%');
  // Spread, not one region: tiles must span most of the height, or a grid that
  // collapsed into the middle would pass everything above.
  const ys = tiles.map((t) => t.y);
  check('tiles span most of the height',
    Math.max(...ys) - Math.min(...ys) > tall.h * 0.7, Math.max(...ys) - Math.min(...ys));
  const xs = tiles.map((t) => t.x);
  check('and more than one column', new Set(xs).size > 1, new Set(xs).size);

  // A crop smaller than one tile still yields a usable rect rather than nothing.
  const tiny = F.tileGrid({ x: 5, y: 5, w: 10, h: 10 });
  check('a tiny crop still gives a tile', tiny.length >= 1, tiny.length);
  check('and it fits inside', tiny.every((t) => t.w <= 10 && t.h <= 10 && t.x >= 5 && t.y >= 5));
}

console.log('the tile fallback finds the dominant tone, which is all it feeds');
{
  // 200x600: top third light, bottom two thirds dark. The edges disagree, so
  // this is the fallback's real job - dark or light, nothing more.
  const W = 200, H = 600, rb = W * 4;
  const buf = new Uint8Array(rb * H);
  const paint = (lightTop) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * rb + x * 4;
        const v = (y < 200) === lightTop ? 255 : 0;
        buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
      }
    }
  };
  const crop = { x: 0, y: 0, w: W, h: H };
  paint(true);
  const r = F.cropBackground(buf, rb, W, H, crop);
  check('it falls back', r.source === 'fallback', r.source);
  check('and picks Ink for a mostly dark crop', r.hex === real.INK, r.hex);
  check('reporting the luma it decided on', r.luma < 128, r.luma);
  // Inverted, so the decision is shown to follow the content and not the code
  // path. A rule that always returned Ink would pass the check above.
  paint(false);
  const r2 = F.cropBackground(buf, rb, W, H, crop);
  check('and Paper when the same crop is mostly light', r2.hex === real.PAPER, r2.hex);
}


console.log('the fast row-ink loop agrees exactly with the obvious one');
{
  // A behaviour-preserving optimisation is only preserving if something checks.
  // These buffers are built to exercise what the inlining could break: the 12-bit
  // key's channel order, the running max against a tie, and a row where the modal
  // colour is not the first colour seen.
  const cases = [];

  // asymmetric per-channel values, so a wrong shift order shows up
  {
    const w = 64, h = 24, rb = w * 4;
    const buf = new Uint8Array(rb * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * rb + x * 4;
      buf[i] = (x * 4) & 255;          // R varies fast
      buf[i + 1] = (y * 11) & 255;     // G varies by row
      buf[i + 2] = (x * y) & 255;      // B varies both ways
      buf[i + 3] = 255;
    }
    cases.push(['asymmetric channels', buf, rb, w, h]);
  }

  // an exact two-colour tie in every row: the running max must not prefer the
  // later bucket
  {
    const w = 64, h = 8, rb = w * 4;
    const buf = new Uint8Array(rb * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * rb + x * 4;
      const v = x < w / 2 ? 16 : 240;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
    }
    cases.push(['a 50/50 tie', buf, rb, w, h]);
  }

  // the modal colour appears only after a run of other colours
  {
    const w = 96, h = 6, rb = w * 4;
    const buf = new Uint8Array(rb * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * rb + x * 4;
      const v = x < 8 ? (x * 30) & 255 : 200;
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
    }
    cases.push(['modal colour arrives late', buf, rb, w, h]);
  }

  // a flat row and an empty-sample row (step wider than the row)
  {
    const w = 3, h = 4, rb = w * 4;
    const buf = new Uint8Array(rb * h);
    buf.fill(120);
    cases.push(['a 3px-wide buffer', buf, rb, w, h]);
  }

  let anyNonZero = false;
  for (const [label, buf, rb, w, h] of cases) {
    for (const step of [1, 2, 3, 5]) {
      const fast = F.rowInkProfile(buf, rb, w, h, h, step);
      const slow = real.rowInkProfileNaive(buf, rb, w, h, h, step);
      let same = fast.length === slow.length;
      for (let i = 0; same && i < fast.length; i++) if (fast[i] !== slow[i]) same = false;
      check(label + ', step ' + step + ': fast === naive', same,
        Array.from(fast).slice(0, 4) + ' vs ' + Array.from(slow).slice(0, 4));
      for (let i = 0; i < slow.length; i++) if (slow[i] > 0) anyNonZero = true;
    }
  }
  // Without this the whole group would pass on two all-zero arrays.
  check('the reference produced some non-zero ink, so equality means something',
    anyNonZero);
}

// ===========================================================================
console.log('colInkProfile is rowInkProfile turned ninety degrees');
{
  // The oracle is a transpose, not a second copy of the loop. A reimplemented
  // reference and the thing it checks are written by the same hand minutes
  // apart and share the bug that matters; a transposed buffer cannot.
  //
  // This also covers the asymmetric case on purpose: every fixture below is
  // non-square with different content on each axis, because a column profile
  // that is secretly reading rows is exactly right on a square and exactly
  // wrong everywhere else.
  const transpose = (buf, rb, w, h) => {
    const trb = h * 4;
    const out = new Uint8Array(trb * w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * rb + x * 4;
        const j = x * trb + y * 4;
        out[j] = buf[i]; out[j + 1] = buf[i + 1]; out[j + 2] = buf[i + 2]; out[j + 3] = buf[i + 3];
      }
    }
    return { buf: out, rb: trb, w: h, h: w };
  };

  const cases = [];
  {
    // Flat gutters of DIFFERENT widths on the two sides, with a striped middle.
    // 11 left, 23 right: equal gutters would hide a lead/trail swap.
    const w = 120, h = 40, rb = w * 4;
    const buf = new Uint8Array(rb * h);
    buf.fill(255);
    for (let y = 0; y < h; y++) {
      for (let x = 11; x < w - 23; x++) {
        const i = y * rb + x * 4;
        const v = (x + y) % 7 === 0 ? 20 : 240;
        buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
      }
    }
    cases.push(['unequal gutters with a striped middle', buf, rb, w, h]);
  }
  {
    // A single inked column, so most columns score exactly 0.
    const w = 33, h = 17, rb = w * 4;
    const buf = new Uint8Array(rb * h);
    buf.fill(90);
    for (let y = 0; y < h; y++) {
      const i = y * rb + 19 * 4;
      buf[i] = y * 13 & 255; buf[i + 1] = 200; buf[i + 2] = 5;
    }
    cases.push(['one inked column in a flat field', buf, rb, w, h]);
  }

  let anyNonZero = false;
  let anyZero = false;
  for (const [label, buf, rb, w, h] of cases) {
    const t = transpose(buf, rb, w, h);
    for (const step of [1, 2, 3]) {
      const cols = F.colInkProfile(buf, rb, w, h, w, step);
      const rows = real.rowInkProfile(t.buf, t.rb, t.w, t.h, t.h, step);
      let same = cols.length === rows.length;
      for (let i = 0; same && i < cols.length; i++) if (cols[i] !== rows[i]) same = false;
      check(`${label}, step ${step}: columns === rows of the transpose`, same,
        Array.from(cols).slice(0, 4) + ' vs ' + Array.from(rows).slice(0, 4));
      for (const v of rows) { if (v > 0) anyNonZero = true; else anyZero = true; }
    }
  }
  // Both, because all-zero and all-inked each make the equality vacuous in a
  // different direction.
  check('the transpose produced some inked columns', anyNonZero);
  check('and some flat ones', anyZero);

  // `cols` bounds the scan the way `rows` does, and it bounds the WIDTH.
  // Reading it as a height is the transposition bug in the argument list
  // rather than in the loop, and it is silent on a square image.
  const w = 50, h = 9, rb = w * 4;
  const flat = new Uint8Array(rb * h);
  flat.fill(7);
  check('cols bounds the number of columns returned', F.colInkProfile(flat, rb, w, h, 12).length === 12);
  check('and is clamped to the width, not to the height',
    F.colInkProfile(flat, rb, w, h, 9999).length === w,
    String(F.colInkProfile(flat, rb, w, h, 9999).length));
  check('a flat image has no inked column', Array.from(F.colInkProfile(flat, rb, w, h, w)).every((v) => v === 0));
}

// ===========================================================================
console.log('the ring strips tile the ring exactly, and cost the ring not the box');
{
  // The set of pixels `ringBackground` scans, derived the obvious way. The
  // strips are held to THIS, not to a description of it.
  const ringSet = (box, t, width, height) => {
    const out = new Set();
    const x0 = Math.max(0, box.x - t), y0 = Math.max(0, box.y - t);
    const x1 = Math.min(width, box.x + box.w + t), y1 = Math.min(height, box.y + box.h + t);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const inside = yy >= box.y && yy < box.y + box.h && xx >= box.x && xx < box.x + box.w;
        if (!inside) out.add(`${xx},${yy}`);
      }
    }
    return out;
  };

  // Asymmetric on purpose, and at every edge and corner: a strip layout with a
  // sign error is invisible on a centred square box.
  const W = 200, H = 120;
  const boxes = [
    ['centred, wider than tall', { x: 60, y: 40, w: 50, h: 20 }],
    ['centred, taller than wide', { x: 60, y: 20, w: 20, h: 70 }],
    ['against the left edge', { x: 0, y: 40, w: 30, h: 20 }],
    ['against the right edge', { x: W - 30, y: 40, w: 30, h: 20 }],
    ['against the top edge', { x: 60, y: 0, w: 30, h: 20 }],
    ['against the bottom edge', { x: 60, y: H - 20, w: 30, h: 20 }],
    ['in the top-left corner', { x: 0, y: 0, w: 25, h: 15 }],
    ['in the bottom-right corner', { x: W - 25, y: H - 15, w: 25, h: 15 }],
    ['one pixel', { x: 100, y: 60, w: 1, h: 1 }],
  ];
  for (const [label, box] of boxes) {
    const strips = F.ringStrips(box, 6, W, H);
    const seen = [];
    for (const st of strips) {
      for (let yy = st.y; yy < st.y + st.h; yy++) {
        for (let xx = st.x; xx < st.x + st.w; xx++) seen.push(`${xx},${yy}`);
      }
    }
    const want = ringSet(box, 6, W, H);
    check(`${label}: no pixel read twice`, seen.length === new Set(seen).size,
      `${seen.length} reads, ${new Set(seen).size} distinct`);
    check(`${label}: covers the ring exactly`,
      seen.length === want.size && seen.every((k) => want.has(k)),
      `${seen.length} vs ${want.size}`);
    check(`${label}: every strip is inside the image`,
      strips.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H),
      JSON.stringify(strips));
    check(`${label}: nothing inside the box is read`,
      !seen.some((k) => {
        const [xx, yy] = k.split(',').map(Number);
        return xx >= box.x && xx < box.x + box.w && yy >= box.y && yy < box.y + box.h;
      }), label);
  }
}

console.log('the requested read is proportional to the ring, not to the box');
{
  // The actual defect: the read rectangles, measured. A tile-grid generator
  // being bounded says nothing about this path.
  const W = 1080, H = 20000;
  const area = (strips) => strips.reduce((a, r) => a + r.w * r.h, 0);

  const whole = F.ringStrips({ x: 0, y: 0, w: W, h: H }, 6, W, H);
  check('a box over the whole image has no surround to read', whole.length === 0,
    JSON.stringify(whole));

  const inset = { x: 1, y: 1, w: W - 2, h: H - 2 };
  const insetPx = area(F.ringStrips(inset, 6, W, H));
  const insetBox = inset.w * inset.h;
  check('a box inset by one pixel reads the border, not the image',
    insetPx > 0 && insetPx * 4 < 1e6, `${(insetPx * 4 / 1024).toFixed(0)}KiB`);
  // The old single read was the BOX's area. The ratio is the whole point of the
  // fix, so it is asserted as a ratio rather than as a byte threshold.
  check('and it is under 1% of what the single read cost',
    insetPx / insetBox < 0.01, `${(100 * insetPx / insetBox).toFixed(3)}% of ${insetBox}`);
  // This box is inset by one pixel, so its ring is clamped to one pixel deep —
  // a 1px border of the image, less the four corners it does not reach.
  check('and it is exactly the one-pixel border the clamp leaves',
    insetPx === 2 * W + 2 * H - 4, `${insetPx} vs ${2 * W + 2 * H - 4}`);

  // A large PARTIAL box, which the review named as having the same problem.
  // This one is far enough from every edge that nothing clamps, so its area is
  // the ring formula exactly: top and bottom at full padded width, sides at the
  // box's own height.
  const half = { x: 100, y: 100, w: 800, h: 9000 };
  const halfPx = area(F.ringStrips(half, 6, W, H));
  const expect = (half.w + 12) * 6 * 2 + half.h * 6 * 2;
  check('a large partial box likewise reads only its border',
    halfPx * 4 < 1e6, `${(halfPx * 4 / 1024).toFixed(0)}KiB`);
  check('and its area is the unclamped ring, to the pixel',
    halfPx === expect, `${halfPx} vs ${expect}`);
  check('which is a thousandth of the box it surrounds',
    halfPx / (half.w * half.h) < 0.02, `${(100 * halfPx / (half.w * half.h)).toFixed(3)}%`);
}

console.log('sampling the strips gives the same answer as scanning the whole region');
{
  // The behaviour-preserving proof. `ringBackground` over a buffer containing
  // the padded region is the reference; accumulating the strips must agree with
  // it exactly, or the read was made cheaper by changing the answer.
  const W = 160, H = 120;
  const img = blank(W, H, [246, 244, 239]);
  // Text IN the ring — the top strip is rows 44..49 for the box below, and ink
  // at y=30 would have left the ring uniform and the agreement vacuous — plus a
  // different colour inside the box, so a strip layout that leaked interior
  // pixels would shift the estimate.
  for (let i = 0; i < 20; i++) fillRect(img, { x: 56 + i * 3, y: 45, w: 2, h: 4 }, [40, 44, 48]);
  fillRect(img, { x: 60, y: 50, w: 40, h: 24 }, [200, 30, 30]);

  const box = { x: 60, y: 50, w: 40, h: 24 };
  const t = 6;
  const reference = real.ringBackground(img.buf, img.rowBytes, W, H, box, t);

  const pts = [];
  for (const st of F.ringStrips(box, t, W, H)) {
    for (let yy = st.y; yy < st.y + st.h; yy++) {
      for (let xx = st.x; xx < st.x + st.w; xx++) {
        const i = yy * img.rowBytes + xx * 4;
        pts.push(img.buf[i], img.buf[i + 1], img.buf[i + 2]);
      }
    }
  }
  const viaStrips = real.modalOfPoints(pts, 16);

  check('the reference actually sampled something', reference && reference.n > 0,
    JSON.stringify(reference));
  check('same number of samples', viaStrips.n === reference.n, `${viaStrips.n} vs ${reference.n}`);
  check('same fill', viaStrips.hex === reference.hex, `${viaStrips.hex} vs ${reference.hex}`);
  check('same coverage', viaStrips.coverage === reference.coverage,
    `${viaStrips.coverage} vs ${reference.coverage}`);
  check('same spread', viaStrips.spread === reference.spread,
    `${viaStrips.spread} vs ${reference.spread}`);
  // Without this the four above would agree on an all-background ring for the
  // wrong reason: the interior colour must be absent from the estimate.
  check('the red interior never reached the estimate', viaStrips.hex !== '#c81e1e', viaStrips.hex);
  check('and the ring was not uniform, so agreement means something',
    reference.coverage < 1, reference.coverage);
}

console.log('intersectRect never returns more than it was asked for');
{
  // Deliberately NOT square, and not a multiple of anything: a function that
  // bounds x by the height passes every test on a square image. 140x37.
  const W = 140;
  const H = 37;
  const isect = (box) => F.intersectRect(W, H, box);

  const inside = isect({ x: 10, y: 5, w: 20, h: 8 });
  check('a rect wholly inside is returned unchanged',
    inside && inside.x === 10 && inside.y === 5 && inside.w === 20 && inside.h === 8,
    JSON.stringify(inside));

  // The defect, in the direction that produced it. A rect at x=-10 with w=30
  // covers columns -10..19, of which 0..19 exist: twenty columns, not thirty.
  const offLeft = isect({ x: -10, y: 0, w: 30, h: 5 });
  check('a rect off the left edge loses the columns that do not exist',
    offLeft && offLeft.x === 0 && offLeft.w === 20, JSON.stringify(offLeft));
  const offTop = isect({ x: 0, y: -10, w: 5, h: 30 });
  check('and off the top edge, the rows',
    offTop && offTop.y === 0 && offTop.h === 20, JSON.stringify(offTop));

  // The far edges, which the old code did clamp correctly. Asserted so a repair
  // cannot fix one end by breaking the other.
  const offRight = isect({ x: W - 10, y: 0, w: 30, h: 5 });
  check('a rect off the right edge stops at the edge',
    offRight && offRight.x === W - 10 && offRight.w === 10, JSON.stringify(offRight));
  const offBottom = isect({ x: 0, y: H - 7, w: 5, h: 30 });
  check('and off the bottom edge',
    offBottom && offBottom.y === H - 7 && offBottom.h === 7, JSON.stringify(offBottom));

  // No overlap is an answer, not an error, and not a 1px sliver of the edge.
  check('a rect entirely off the left is no overlap', isect({ x: -50, y: 0, w: 20, h: 5 }) === null);
  check('entirely off the right', isect({ x: W + 5, y: 0, w: 20, h: 5 }) === null);
  check('entirely above', isect({ x: 0, y: -50, w: 5, h: 20 }) === null);
  check('entirely below', isect({ x: 0, y: H + 5, w: 5, h: 20 }) === null);
  check('a rect flush against the left edge but outside it',
    isect({ x: -20, y: 0, w: 20, h: 5 }) === null);
  check('a zero-width rect', isect({ x: 10, y: 10, w: 0, h: 5 }) === null);
  check('a negative-size rect', isect({ x: 10, y: 10, w: -5, h: -5 }) === null);

  // Rounding is deliberate: every caller turns w into a byte count.
  const frac = isect({ x: 0.6, y: 0.4, w: 10.1, h: 10.1 });
  check('a fractional rect comes back on whole pixels',
    frac && Number.isInteger(frac.x) && Number.isInteger(frac.y)
      && Number.isInteger(frac.w) && Number.isInteger(frac.h), JSON.stringify(frac));
  check('and rounds both edges, not the width',
    frac && frac.x === 1 && frac.w === 10, JSON.stringify(frac));
}

console.log('and it holds over a sweep, in all four quadrants');
{
  // One case fixed by hand says nothing about the family. This sweep is the
  // assertion: every rect that overlaps a 140x37 image at all, from well outside
  // each edge to well outside the opposite one.
  const W = 140;
  const H = 37;
  let swept = 0;
  let overlapping = 0;
  let wider = 0;
  let outside = 0;
  let escaped = 0;
  const bad = [];
  // The ranges are built once and the expected count is derived from their
  // lengths. Writing `25 * 14 * 4 * 4` by hand got it wrong on the first run -
  // the real product is 29 * 20 * 16 - and a sweep whose size is typed from
  // memory is the one place a miscount looks exactly like a pass.
  const xs = [];
  for (let x = -30; x <= W + 30; x += 7) xs.push(x);
  const ys = [];
  for (let y = -30; y <= H + 30; y += 5) ys.push(y);
  const ws = [1, 9, 40, 200];
  const hs = [1, 9, 40, 200];
  for (const x of xs) {
    for (const y of ys) {
      for (const w of ws) {
        for (const h of hs) {
          swept++;
          const box = { x, y, w, h };
          const r = F.intersectRect(W, H, box);
          if (!r) {
            // Null must mean there was genuinely nothing to read.
            const reallyEmpty = x + w <= 0 || y + h <= 0 || x >= W || y >= H;
            if (!reallyEmpty) { escaped++; if (bad.length < 3) bad.push(`null for ${JSON.stringify(box)}`); }
            continue;
          }
          overlapping++;
          // Never wider or taller than requested...
          if (r.w > w || r.h > h) { wider++; if (bad.length < 3) bad.push(`wider: ${JSON.stringify(box)} -> ${JSON.stringify(r)}`); }
          // ...never outside the image...
          if (r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H) {
            outside++; if (bad.length < 3) bad.push(`outside: ${JSON.stringify(box)} -> ${JSON.stringify(r)}`);
          }
          // ...and never outside the rect that was asked for.
          if (r.x < Math.round(x) || r.y < Math.round(y)
            || r.x + r.w > Math.round(x + w) || r.y + r.h > Math.round(y + h)) {
            wider++; if (bad.length < 3) bad.push(`not a subset: ${JSON.stringify(box)} -> ${JSON.stringify(r)}`);
          }
        }
      }
    }
  }
  check('the sweep ran', swept === xs.length * ys.length * ws.length * hs.length,
    `${swept} vs ${xs.length} * ${ys.length} * ${ws.length} * ${hs.length}`);
  // Counting both outcomes, because a sweep that found nothing to check is the
  // easiest way to print a confident zero.
  check('and it found rects on both sides of the edge',
    overlapping > 0 && overlapping < swept, `${overlapping} of ${swept} overlapped`);
  check('nothing came back wider than it was asked for', wider === 0, bad.join(' | '));
  check('nothing came back outside the image', outside === 0, bad.join(' | '));
  check('and nothing that overlapped was reported as no overlap', escaped === 0, bad.join(' | '));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
