// Pure pixel math. Takes a flat RGBA byte array, so it runs identically in Node
// (see pixels.test.mjs) and on the device against Skia's readPixels output.
// Nothing here imports Skia; that is the point.

/** Read one pixel as [r,g,b,a]. */
function px(buf, rowBytes, x, y) {
  const i = y * rowBytes + x * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

/**
 * Colour statistics for the ring of pixels immediately OUTSIDE `box`.
 *
 * This is the measurement Q1 turns on: the Cover tool fills `box` with this
 * ring's mean, so the seam is invisible exactly to the degree the ring is flat.
 * stddev is therefore a prediction, made before anyone looks at the result.
 */
export function ringStats(buf, rowBytes, width, height, box, thickness = 6) {
  const { x, y, w, h } = box;
  const outer = {
    x0: Math.max(0, x - thickness),
    y0: Math.max(0, y - thickness),
    x1: Math.min(width, x + w + thickness),
    y1: Math.min(height, y + h + thickness),
  };
  let n = 0;
  let sr = 0, sg = 0, sb = 0;
  let qr = 0, qg = 0, qb = 0;
  const samples = [];

  for (let yy = outer.y0; yy < outer.y1; yy++) {
    const insideRows = yy >= y && yy < y + h;
    for (let xx = outer.x0; xx < outer.x1; xx++) {
      // skip the box interior itself
      if (insideRows && xx >= x && xx < x + w) continue;
      const [r, g, b] = px(buf, rowBytes, xx, yy);
      sr += r; sg += g; sb += b;
      qr += r * r; qg += g * g; qb += b * b;
      samples.push(r, g, b);
      n++;
    }
  }
  if (n === 0) return null;

  const mean = [sr / n, sg / n, sb / n];
  const sd = [
    Math.sqrt(Math.max(0, qr / n - mean[0] * mean[0])),
    Math.sqrt(Math.max(0, qg / n - mean[1] * mean[1])),
    Math.sqrt(Math.max(0, qb / n - mean[2] * mean[2])),
  ];
  let maxDev = 0;
  for (let i = 0; i < samples.length; i += 3) {
    const d = Math.max(
      Math.abs(samples[i] - mean[0]),
      Math.abs(samples[i + 1] - mean[1]),
      Math.abs(samples[i + 2] - mean[2]),
    );
    if (d > maxDev) maxDev = d;
  }
  return {
    n,
    mean: mean.map(Math.round),
    stddev: sd.map((v) => +v.toFixed(2)),
    maxDev: Math.round(maxDev),
    hex: rgbHex(mean),
  };
}

/**
 * The ring's BACKGROUND colour and how flat it is — robust to text in the ring.
 *
 * `ringStats` above reports a mean, and a mean is the wrong estimator here. The
 * ring around a like-count row catches ascenders and descenders from the rows
 * either side, and those outliers drag the mean off the background: on a real
 * Instagram capture a 1px target row sampled to #7F7F7F, a mid grey averaged
 * from black chrome and a white photo. Filling with that is a guaranteed seam.
 *
 * So: take the modal quantised colour as the background, then refine using only
 * the pixels near it.
 *
 *   hex/mean  the colour to fill with
 *   spread    how flat the background actually is — the seam predictor
 *   coverage  how much of the ring IS background. Low coverage means the ring is
 *             mostly other content, which is a badly placed box rather than a
 *             rough background, and the two need different fixes.
 */
function modalOf(pts, tolerance) {
  const n = pts.length / 3;
  if (n === 0) return null;

  const hist = new Int32Array(4096);
  for (let i = 0; i < pts.length; i += 3) hist[key12(pts[i], pts[i + 1], pts[i + 2])]++;

  let modeKey = 0;
  let best = -1;
  for (let k = 0; k < 4096; k++) if (hist[k] > best) { best = hist[k]; modeKey = k; }
  // Bucket centre, from the 4-bit-per-channel key.
  const cr = (((modeKey >> 8) & 0xf) << 4) + 8;
  const cg = (((modeKey >> 4) & 0xf) << 4) + 8;
  const cb = ((modeKey & 0xf) << 4) + 8;
  const near = (i) => Math.abs(pts[i] - cr) <= tolerance &&
    Math.abs(pts[i + 1] - cg) <= tolerance &&
    Math.abs(pts[i + 2] - cb) <= tolerance;

  let sr = 0, sg = 0, sb = 0, m = 0;
  for (let i = 0; i < pts.length; i += 3) {
    if (near(i)) { sr += pts[i]; sg += pts[i + 1]; sb += pts[i + 2]; m++; }
  }
  if (m === 0) return null;
  const mean = [sr / m, sg / m, sb / m];

  let qr = 0, qg = 0, qb = 0;
  for (let i = 0; i < pts.length; i += 3) {
    if (near(i)) {
      qr += (pts[i] - mean[0]) ** 2;
      qg += (pts[i + 1] - mean[1]) ** 2;
      qb += (pts[i + 2] - mean[2]) ** 2;
    }
  }
  const spread = Math.max(Math.sqrt(qr / m), Math.sqrt(qg / m), Math.sqrt(qb / m));

  return {
    n,
    background: m,
    coverage: +(m / n).toFixed(4),
    mean: mean.map(Math.round),
    hex: rgbHex(mean),
    spread: +spread.toFixed(2),
  };
}

/**
 * The ring around a box, as up to four non-overlapping rectangles.
 *
 * This exists so that sampling a box's surround does not require reading the
 * box. `ringBackground` takes a buffer that already contains the whole padded
 * region and skips the interior while scanning, which is fine for a detector
 * running on a crop already in memory — but `pipeline.js` was using it on a
 * Cover box by reading the box's padded bounding rectangle out of the source
 * image first. For a Cover box over a whole 1080x20000 capture that is an
 * 82.4MiB `readPixels` of which everything but a 6px border is discarded.
 *
 * The strips cover exactly the same pixels as the scan: top and bottom take the
 * full padded width including the corners, left and right take only the box's
 * own rows. So they tile the ring with no overlap and no gap — worth stating
 * because a corner counted twice would weight the estimator toward the corners,
 * and a corner missed would drop the pixels most likely to be background.
 *
 * Returns [] when the box covers the image and there is no surround to read.
 * That is a real case — a Cover box can be dragged over everything — and the
 * caller must treat it as "no answer", not as a black background.
 */
export function ringStrips(box, thickness, width, height) {
  const { x, y, w, h } = box;
  const t = thickness;
  const clip = (r) => {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(width, r.x + r.w);
    const y1 = Math.min(height, r.y + r.h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  return [
    { x: x - t, y: y - t, w: w + 2 * t, h: t },
    { x: x - t, y: y + h, w: w + 2 * t, h: t },
    { x: x - t, y, w: t, h },
    { x: x + w, y, w: t, h },
  ].map(clip).filter(Boolean);
}

export function ringBackground(buf, rowBytes, width, height, box, thickness = 6, tolerance = 16) {
  const { x, y, w, h } = box;
  const x0 = Math.max(0, x - thickness);
  const y0 = Math.max(0, y - thickness);
  const x1 = Math.min(width, x + w + thickness);
  const y1 = Math.min(height, y + h + thickness);

  const pts = [];
  for (let yy = y0; yy < y1; yy++) {
    const insideRows = yy >= y && yy < y + h;
    for (let xx = x0; xx < x1; xx++) {
      if (insideRows && xx >= x && xx < x + w) continue;
      const i = yy * rowBytes + xx * 4;
      pts.push(buf[i], buf[i + 1], buf[i + 2]);
    }
  }
  return modalOf(pts, tolerance);
}

/**
 * Modal background of an arbitrary rect. Same estimator, different geometry.
 *
 * The bounds are an INTERSECTION with the buffer. Deriving `x1` from the clamped
 * `x0` — `min(width, x0 + w)` — grows the rect by whatever hung off the left or
 * top edge, so a rect at x=-10 with w=30 sampled 30 columns instead of 20 and
 * pulled 10 columns of unrequested pixels into the estimate. Same mistake as the
 * one clampCrop had; see the note there.
 */
export function regionBackground(buf, rowBytes, width, height, rect, tolerance = 16, step = 1) {
  const r = intersectRect(width, height, rect);
  if (!r) return null;
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  const pts = [];
  for (let yy = r.y; yy < y1; yy += step) {
    for (let xx = r.x; xx < x1; xx += step) {
      const i = yy * rowBytes + xx * 4;
      pts.push(buf[i], buf[i + 1], buf[i + 2]);
    }
  }
  return modalOf(pts, tolerance);
}

/** Perceptual-ish luma in sRGB space. Enough to choose between Paper and Ink. */
export function luma([r, g, b]) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export const PAPER = '#F6F4EF';
export const INK = '#15181D';

/**
 * The card's background colour, sampled from the four inside edges of the crop.
 *
 * The four-edge agreement test is the point. Picking one edge and hoping is how
 * a card ends up framed in a colour that appears nowhere in the screenshot —
 * crop across a boundary and the top edge is a white photo while the bottom is
 * black chrome, and either answer is wrong. So all four are sampled and only a
 * consensus is trusted; without one, fall back to a neutral chosen by the crop's
 * own luminance, which is a deliberate frame rather than a wrong guess.
 */
/**
 * The four-edge agreement decision, separated from where the pixels came from.
 *
 * `edges` is `{top, bottom, left, right}`, each a regionBackground result or
 * null. `sampleWhole` is called ONLY on the fallback path and only if needed —
 * it is a function, not a value, because on a device that read is the expensive
 * one: a tall crop's full region can be tens of MiB, and paying for it before
 * knowing whether the edges agree would make the common case the slow case.
 *
 * Exported so the Skia pipeline and the desktop probe share one implementation
 * of the rule. Two copies of an agreement threshold is two thresholds.
 */
export function decideCropBackground(edges, sampleWhole, opts = {}) {
  const { agree = 12 } = opts;
  const order = ['top', 'bottom', 'left', 'right'];
  const means = [];
  for (const name of order) {
    const e = edges[name];
    if (e) means.push(e.mean);
  }
  if (means.length < 4) {
    return { source: 'fallback', reason: 'could not sample all four edges', edges };
  }

  // Agreement: every edge within `agree` of every other, per channel.
  let maxDiff = 0;
  for (let i = 0; i < means.length; i++) {
    for (let j = i + 1; j < means.length; j++) {
      for (let c = 0; c < 3; c++) {
        maxDiff = Math.max(maxDiff, Math.abs(means[i][c] - means[j][c]));
      }
    }
  }

  if (maxDiff <= agree) {
    const avg = [0, 1, 2].map((c) => means.reduce((a, m) => a + m[c], 0) / means.length);
    return {
      source: 'sampled',
      hex: rgbHex(avg),
      mean: avg.map(Math.round),
      maxEdgeDiff: Math.round(maxDiff),
      spread: Math.max(...order.map((n) => edges[n].spread)),
      edges,
    };
  }

  const whole = sampleWhole ? sampleWhole() : null;
  const l = whole ? luma(whole.mean) : 128;
  return {
    source: 'fallback',
    reason: `edges disagree by ${Math.round(maxDiff)} (> ${agree})`,
    hex: l < 128 ? INK : PAPER,
    luma: +l.toFixed(1),
    maxEdgeDiff: Math.round(maxDiff),
    edges,
  };
}

/** The rects the four edge samples come from. Shared so the device reads the same strips. */
export function cropEdgeStrips(crop, thickness = 8) {
  const t = Math.max(1, Math.min(thickness, Math.floor(Math.min(crop.w, crop.h) / 2)));
  return {
    top: { x: crop.x, y: crop.y, w: crop.w, h: t },
    bottom: { x: crop.x, y: crop.y + crop.h - t, w: crop.w, h: t },
    left: { x: crop.x, y: crop.y, w: t, h: crop.h },
    right: { x: crop.x + crop.w - t, y: crop.y, w: t, h: crop.h },
  };
}

/**
 * A grid of small tiles spread over a crop, for the fallback sample.
 *
 * The fallback used to read the whole crop. On a 1080x20000 capture that is an
 * 82MiB RGBA buffer — in a file whose stated rule is never to read a whole
 * image, on a path taken by 6 of the 12 crops in
 * results/phase1-card-background.md. Not a rare branch; the normal one for
 * anything off-centre.
 *
 * And the read was never needed at that size. Its result is used for exactly one
 * thing: `luma(mean) < 128`, choosing Ink or Paper. A grid of tiles answers
 * dark-versus-light from a fraction of a percent of the pixels, and the peak
 * buffer is ONE TILE rather than the whole crop.
 *
 * Tiles rather than a single sub-rect because the question is about the crop as a
 * whole: one region could land on a photo, a header, or a dark card on a light
 * page. Spread over the full height and width, a majority of tiles sit on
 * whatever is dominant, which is what the modal estimator then finds.
 */
export function tileGrid(crop, opts = {}) {
  const { tile = 48, cols = 5, rows = 12 } = opts;
  const tw = Math.max(1, Math.min(tile, crop.w));
  const th = Math.max(1, Math.min(tile, crop.h));
  // At most one tile per tile-width across, so a narrow crop does not ask for
  // overlapping columns and count the same pixels twice.
  const nx = Math.max(1, Math.min(cols, Math.floor(crop.w / tw)));
  const ny = Math.max(1, Math.min(rows, Math.floor(crop.h / th)));
  const out = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      // Tile centres at the (i+0.5)/nx points, so the grid is inset from the
      // edges rather than repeating the strips that were already sampled.
      const cx = crop.x + ((i + 0.5) * crop.w) / nx;
      const cy = crop.y + ((j + 0.5) * crop.h) / ny;
      out.push({
        x: Math.round(Math.max(crop.x, Math.min(crop.x + crop.w - tw, cx - tw / 2))),
        y: Math.round(Math.max(crop.y, Math.min(crop.y + crop.h - th, cy - th / 2))),
        w: tw,
        h: th,
      });
    }
  }
  return out;
}

/** Collect RGB triples from a rect, for an estimator fed from more than one read. */
export function collectPoints(buf, rowBytes, width, height, rect, step = 1, into = []) {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(width, Math.round(rect.x + rect.w));
  const y1 = Math.min(height, Math.round(rect.y + rect.h));
  for (let yy = y0; yy < y1; yy += step) {
    for (let xx = x0; xx < x1; xx += step) {
      const i = yy * rowBytes + xx * 4;
      into.push(buf[i], buf[i + 1], buf[i + 2]);
    }
  }
  return into;
}

/**
 * Intersect a requested rect with a width x height image. THE one copy.
 *
 * Clamping a rect field by field is the defect this repo kept re-finding: take
 * `max(0, x)` for the origin and then `min(width, x0 + w)` for the far edge and
 * a rect hanging off the left or top comes back WIDER than it was asked for,
 * because the width was measured from the clamped origin rather than from the
 * requested one. A rect at x=-10 with w=30 sampled 30 columns instead of 20.
 *
 * Deriving both edges from the REQUESTED rect and taking the width by
 * subtraction cannot make that mistake. It was written correctly in
 * `regionBackground`, in `plan.js`'s `clampCrop` and in `pipeline.js`'s
 * `clampRect` - three copies of five lines, each fixed on its own day - while
 * `measure.js` kept the broken one for weeks because nothing pointed from one
 * copy to the next. This is that pointer.
 *
 * And the pointer was not enough on its own. A sweep for duplicated code the
 * next day found a FIFTH copy the consolidation had walked straight past:
 * `readRect`, which wraps this intersect with a `readPixels`, existed in both
 * `measure.js` and `pipeline.js` under two different field spellings. Looking
 * for the shape you already fixed finds the copies that look like it; it does
 * not find the one wearing a larger function around it. That pair is now
 * `src/read.js`, and it is the only caller of this function that reads pixels.
 *
 * Returns null for a rect that misses the image entirely, which is a real
 * answer and not an error: callers decide whether no overlap is a bug (crop) or
 * simply nothing to read (a ring strip against the edge).
 */
export function intersectRect(width, height, box) {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(width, Math.round(box.x + box.w));
  const y1 = Math.min(height, Math.round(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The modal estimator over already-collected points. Shared by every sampler. */
export function modalOfPoints(pts, tolerance = 16) {
  return modalOf(pts, tolerance);
}

/**
 * Modal background of a crop, from its four edges, falling back to a tile grid.
 *
 * The desktop path and the device path must reach the same verdict or the probe
 * in tools/probe.mjs stops predicting anything, so both sample the same tiles
 * from the same tileGrid — the only difference is where the pixels come from.
 */
export function cropBackground(buf, rowBytes, width, height, crop, opts = {}) {
  const { thickness = 8, tolerance = 16, agree = 12, step = 2, tiles } = opts;
  const strips = cropEdgeStrips(crop, thickness);

  const edges = {};
  for (const [name, rect] of Object.entries(strips)) {
    edges[name] = regionBackground(buf, rowBytes, width, height, rect, tolerance, step);
  }

  return decideCropBackground(
    edges,
    () => {
      const pts = [];
      for (const t of tileGrid(crop, tiles)) {
        collectPoints(buf, rowBytes, width, height, t, 1, pts);
      }
      return modalOfPoints(pts, tolerance);
    },
    { agree },
  );
}

export function rgbHex([r, g, b]) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** Quantise to 4 bits per channel -> 12-bit key. Cheap modal-colour bucket. */
function key12(r, g, b) {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
}

/**
 * Per-row ink coverage: the fraction of pixels in a row that differ from that
 * row's own modal colour. A flat row scores ~0; a row of status-bar glyphs
 * scores low-but-nonzero; an app header scores high.
 *
 * `step` subsamples columns; coverage is a ratio, so the denominator moves with
 * it and the numbers stay comparable across step values.
 */
export function rowInkProfile(buf, rowBytes, width, height, rows, step = 2) {
  const limit = Math.min(rows, height);
  const hist = new Int32Array(4096);
  const out = new Float32Array(limit);
  for (let y = 0; y < limit; y++) {
    hist.fill(0);
    let n = 0;
    let best = 0;
    // Hand-inlined rather than calling px(): this is the only loop in the file
    // hot enough for it to matter, and px() returns a 4-element array, so it
    // allocated once per pixel — ~288k allocations for a 1440x400 band. The
    // running `best` replaces a 4096-bucket scan per row (another 1.6M
    // iterations over the band).
    //
    // See results/phase1-pipeline.md for the measured effect; do not quote a
    // number here. The first version of this comment claimed "~250ms to ~15ms",
    // which was written before measuring and was wrong — most of the original
    // 250ms was the lazy decode being paid inside findStatusBar, not this loop.
    // rowInkProfileNaive below is this function written the obvious way, and the
    // tests hold this one to it exactly.
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x += step) {
      const i = rowStart + x * 4;
      const k = ((buf[i] >> 4) << 8) | ((buf[i + 1] >> 4) << 4) | (buf[i + 2] >> 4);
      const c = ++hist[k];
      if (c > best) best = c;
      n++;
    }
    out[y] = n ? 1 - best / n : 0;
  }
  return out;
}

/**
 * Per-COLUMN ink coverage, the same measurement turned ninety degrees.
 *
 * Phase 4.5's auto-proposed crop trims the flat bands off all four edges, and
 * three of the four cannot be seen in a row profile: a uniform left gutter and
 * a uniform right gutter both leave every row inked, because the post in the
 * middle of the row is what the row's coverage is measuring.
 *
 * `step` subsamples ROWS here, where the row version subsamples columns, so
 * the two cost about the same on the same image and the coverage stays a ratio
 * either way.
 *
 * Not tested against a naive reimplementation, unlike `rowInkProfile`. It is
 * tested against `rowInkProfile` of a transposed buffer, which is a stronger
 * oracle than a second copy of the same loop: a transpose cannot share a bug
 * with either, and a second copy written from the first usually does.
 */
export function colInkProfile(buf, rowBytes, width, height, cols, step = 2) {
  const limit = Math.min(cols, width);
  const hist = new Int32Array(4096);
  const out = new Float32Array(limit);
  for (let x = 0; x < limit; x++) {
    hist.fill(0);
    let n = 0;
    let best = 0;
    for (let y = 0; y < height; y += step) {
      const i = y * rowBytes + x * 4;
      const k = ((buf[i] >> 4) << 8) | ((buf[i + 1] >> 4) << 4) | (buf[i + 2] >> 4);
      const c = ++hist[k];
      if (c > best) best = c;
      n++;
    }
    out[x] = n ? 1 - best / n : 0;
  }
  return out;
}

/**
 * `rowInkProfile` written the obvious way, kept as the reference the fast one is
 * tested against.
 *
 * Not dead code and not a duplicate rule: it is the specification. An
 * optimisation that changes an answer is a defect, and the only way to know it
 * did not is to have the unoptimised answer to compare with. Exported so the
 * test can reach it; nothing in the pipeline calls it.
 */
export function rowInkProfileNaive(buf, rowBytes, width, height, rows, step = 2) {
  const limit = Math.min(rows, height);
  const hist = new Int32Array(4096);
  const out = new Float32Array(limit);
  for (let y = 0; y < limit; y++) {
    hist.fill(0);
    let n = 0;
    for (let x = 0; x < width; x += step) {
      const [r, g, b] = px(buf, rowBytes, x, y);
      hist[key12(r, g, b)]++;
      n++;
    }
    let best = 0;
    for (let k = 0; k < 4096; k++) if (hist[k] > best) best = hist[k];
    out[y] = n ? 1 - best / n : 0;
  }
  return out;
}

/**
 * Cut row for the status bar: find the status bar's own content first, then the
 * first flat run AFTER it. Not a fixed fraction of screen height, because that
 * is exactly what differs between Android skins.
 *
 * The "after it" is load-bearing and was missing at first. A screenshot has
 * padding above the clock, so the rows at the very top are already flat; taking
 * the first flat run found cut at row 1 on a real layout and trimmed nothing.
 * The original unit test passed anyway, because its glyphs happened to start at
 * row 8 and `minRow: 8` cancelled exactly those 8 leading flat rows. A synthetic
 * screenshot with realistic padding is what exposed it.
 *
 * Returns `detected: false` with a reason when there is no such boundary — that
 * is an outcome, reported as one, not a silent zero that reads as "row 0".
 */
export function detectStatusBar(profile, { flat = 0.01, run = 8, minRow = 8 } = {}) {
  let inkAt = -1;
  for (let y = 0; y < profile.length; y++) {
    if (profile[y] > flat) { inkAt = y; break; }
  }
  if (inkAt < 0) {
    return { cut: 0, detected: false, reason: 'no ink in the search window' };
  }

  let y = inkAt;
  while (y < profile.length) {
    if (profile[y] > flat) { y++; continue; }
    const start = y;
    while (y < profile.length && profile[y] <= flat) y++;
    if (y - start >= run && start >= minRow) {
      return { cut: start, detected: true, inkAt };
    }
  }
  return { cut: 0, detected: false, inkAt, reason: 'no flat run after the status bar content' };
}

/**
 * Contiguous runs of inked rows, each with the flat gap above and below it.
 *
 * This is what finds the Cover tool's real targets. A like-count row is a thin
 * band of ink sitting on flat ground, which is exactly the shape that a flat
 * sampled fill can hide — so these runs, not a blind grid of boxes, are the
 * population Q1 should be measured over.
 */
export function inkRuns(profile, { flat = 0.01 } = {}) {
  const runs = [];
  let y = 0;
  while (y < profile.length) {
    if (profile[y] <= flat) { y++; continue; }
    const start = y;
    while (y < profile.length && profile[y] > flat) y++;
    runs.push({ start, end: y - 1, length: y - start });
  }
  // Measure each run's surrounding flat gap, since a fill can only be sampled
  // from a gap that exists.
  return runs.map((r, i) => {
    const prev = i > 0 ? runs[i - 1].end : -1;
    const next = i < runs.length - 1 ? runs[i + 1].start : profile.length;
    return { ...r, gapAbove: r.start - prev - 1, gapBelow: next - r.end - 1 };
  });
}

/**
 * Ink coverage per horizontal zone across a band of rows.
 *
 * Added to tell a status bar from any other top boundary. `detectStatusBar`
 * finds the first ink-then-flat edge, which on a screenshot whose status bar was
 * already cropped away is the app header instead — it reported a confident cut
 * on two real screenshots that had no status bar at all. A status bar puts
 * glyphs at both outer edges and leaves the middle empty; a header does not.
 */
export function zoneInk(buf, rowBytes, width, y0, y1, zones = 5, step = 2) {
  const out = new Float32Array(zones);
  const zw = width / zones;
  for (let z = 0; z < zones; z++) {
    const x0 = Math.floor(z * zw);
    const x1 = Math.floor((z + 1) * zw);
    const hist = new Int32Array(4096);
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x += step) {
        const i = y * rowBytes + x * 4;
        hist[key12(buf[i], buf[i + 1], buf[i + 2])]++;
        n++;
      }
    }
    let best = 0;
    for (let k = 0; k < 4096; k++) if (hist[k] > best) best = hist[k];
    out[z] = n ? 1 - best / n : 0;
  }
  return out;
}

/**
 * Does the band above a candidate cut actually look like a status bar?
 *
 * Shape test over five zones: ink at both outer edges, a clear middle. Returns
 * a verdict plus the zones, so a wrong answer is diagnosable instead of just
 * wrong. Height is checked too — a status bar is a thin strip, and an app header
 * with an avatar is not.
 */
export function looksLikeStatusBar(zones, bandHeight, imageHeight, opts = {}) {
  const { edgeMin = 0.005, middleMax = 0.02, maxFraction = 0.075 } = opts;
  const left = Math.max(zones[0], zones[1]);
  const right = Math.max(zones[zones.length - 1], zones[zones.length - 2]);
  const middle = zones[Math.floor(zones.length / 2)];
  const reasons = [];
  if (left <= edgeMin) reasons.push('no ink at the left edge');
  if (right <= edgeMin) reasons.push('no ink at the right edge');
  if (middle > middleMax) reasons.push('middle is not empty');
  if (bandHeight / imageHeight > maxFraction) reasons.push('band is too tall for a status bar');
  return {
    likely: reasons.length === 0,
    left: +left.toFixed(4),
    middle: +middle.toFixed(4),
    right: +right.toFixed(4),
    reasons,
  };
}

/** Max per-channel delta between two same-shaped RGBA buffers, over a region. */
export function maxChannelDelta(a, b, rowBytes, region) {
  const { x, y, w, h } = region;
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = yy * rowBytes + xx * 4;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a[i + c] - b[i + c]);
        if (d > max) max = d;
        sum += d;
        n++;
      }
    }
  }
  return { max, mean: n ? +(sum / n).toFixed(3) : 0, n };
}
