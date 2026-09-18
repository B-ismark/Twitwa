// Every Skia call the Phase 0 spike makes, with timings. No UI here.
//
// API signatures were read out of node_modules/@shopify/react-native-skia's own
// .d.ts at 2.6.2 rather than recalled, because a wrong signature here fails as a
// null and then as a wrong number, which is worse than a crash.
// ColorType and AlphaType are gone: the one deliberate whole-image read below
// now spells its colour with src/skia.js's RGBA, so this file names the shape
// in no place at all.
import {
  Skia,
  ImageFormat,
  ColorSpace,
} from '@shopify/react-native-skia';

import {
  ringStats,
  ringBackground,
  rowInkProfile,
  detectStatusBar,
  zoneInk,
  looksLikeStatusBar,
  maxChannelDelta,
  rgbHex,
} from './pixels';
import { RGBA, readRect } from './skia';

const now = () => (global.performance && global.performance.now ? global.performance.now() : Date.now());

function timed(label, fn) {
  const t0 = now();
  const value = fn();
  return { label, ms: +(now() - t0).toFixed(2), value };
}

// `RGBA` and `readRect` used to be defined here AND in pipeline.js. Both now
// come from src/skia.js. The merge that removed the second copy is described
// there; what it did NOT remove was the third absence — App.js, which had
// neither and so called the three-argument `readSubRect` with two.
//
// This file is the instrument that produced the published Q1/Q2/Q4 figures in
// results/phase0-device.md, so changing it owes a re-run: the clamp fix that
// preceded this one was made with the device attached and Q1 reproduced
// straight after. **The readRect merge has not been re-run on a device.** See
// src/read.js for the clamp defect the shared body carries the history of, and
// read.test.mjs for the checks neither copy ever had.

export async function decodeFromUri(uri) {
  const t0 = now();
  const data = await Skia.Data.fromURI(uri);
  const img = Skia.Image.MakeImageFromEncoded(data);
  if (!img) {
    throw new Error('MakeImageFromEncoded returned null - unsupported or corrupt encoding');
  }
  return {
    img,
    decodeMs: +(now() - t0).toFixed(2),
    width: img.width(),
    height: img.height(),
    megapixels: +((img.width() * img.height()) / 1e6).toFixed(2),
    rgbaMiB: +((img.width() * img.height() * 4) / (1024 * 1024)).toFixed(1),
  };
}

// --- Q1: is the ring flat enough for the fill to be seamless? ---------------
export function measureRing(img, box, thickness = 6) {
  const outer = {
    x: box.x - thickness,
    y: box.y - thickness,
    w: box.w + thickness * 2,
    h: box.h + thickness * 2,
  };
  const read = timed('readPixels(ring sub-rect)', () => readRect(img, outer));
  if (!read.value) return { error: 'readPixels returned null' };

  const { buf, rowBytes, width, height, rect } = read.value;
  // Box position inside the sub-rect we actually read, after clamping.
  const local = { x: box.x - rect.x, y: box.y - rect.y, w: box.w, h: box.h };

  // Both estimators, deliberately. The modal one is what fills the box; the mean
  // is kept alongside it so the device confirms on real captures what the desktop
  // probe already measured — that text in the sampling ring drags a mean fill off
  // the background, once to #7F7F7F on a #000000 ground.
  const bg = timed('ringBackground', () => ringBackground(buf, rowBytes, width, height, local, thickness));
  const mean = timed('ringStats (mean, for comparison)', () =>
    ringStats(buf, rowBytes, width, height, local, thickness));

  return {
    readMs: read.ms,
    bgMs: bg.ms,
    meanMs: mean.ms,
    bytesRead: read.value.bytes,
    subRect: rect,
    ring: bg.value,       // the fill: modal colour, spread, coverage
    meanRing: mean.value, // comparison only, never the fill
  };
}

// --- Q2: composite + encode cost, and Q4: what the colour space does --------
export function composeAndEncode(img, crop, padPx, fillBox, colors, colorSpace) {
  const outW = crop.w + padPx * 2;
  const outH = crop.h + padPx * 2;

  const make = timed('MakeOffscreen', () =>
    Skia.Surface.MakeOffscreen(outW, outH, colorSpace ? { colorSpace } : undefined),
  );
  const surface = make.value;
  if (!surface) {
    return { error: 'MakeOffscreen(' + outW + 'x' + outH + ') returned null', outW, outH };
  }

  const draw = timed('draw (clear + image + mask)', () => {
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color(colors.background));
    canvas.drawImageRect(
      img,
      Skia.XYWHRect(crop.x, crop.y, crop.w, crop.h),
      Skia.XYWHRect(padPx, padPx, crop.w, crop.h),
      Skia.Paint(),
    );
    if (fillBox) {
      const mask = Skia.Paint();
      mask.setColor(Skia.Color(colors.mask));
      canvas.drawRect(
        Skia.XYWHRect(
          fillBox.x - crop.x + padPx,
          fillBox.y - crop.y + padPx,
          fillBox.w,
          fillBox.h,
        ),
        mask,
      );
    }
    return true;
  });

  const snap = timed('makeImageSnapshot', () => surface.makeImageSnapshot());
  const enc = timed('encodeToBytes(PNG)', () => snap.value.encodeToBytes(ImageFormat.PNG, 100));
  const steps = [make, draw, snap, enc];

  return {
    outW,
    outH,
    outMegapixels: +((outW * outH) / 1e6).toFixed(2),
    pngBytes: enc.value ? enc.value.length : 0,
    steps: steps.map((s) => ({ label: s.label, ms: s.ms })),
    totalMs: +steps.reduce((a, s) => a + s.ms, 0).toFixed(2),
    snapshot: snap.value,
    png: enc.value,
  };
}

// --- Q3: does the status-bar heuristic generalise? --------------------------
export function measureStatusBar(img, rows = 400) {
  const read = timed('readPixels(top band)', () =>
    readRect(img, { x: 0, y: 0, w: img.width(), h: rows }),
  );
  if (!read.value) return { error: 'readPixels returned null' };

  const { buf, rowBytes, width, height } = read.value;
  const prof = timed('rowInkProfile', () => rowInkProfile(buf, rowBytes, width, height, height));
  const det = detectStatusBar(prof.value);

  const out = {
    readMs: read.ms,
    profileMs: prof.ms,
    rowsScanned: height,
    detected: det.detected,
    reason: det.reason,
    cut: det.cut,
    cutFraction: img.height() ? +(det.cut / img.height()).toFixed(4) : 0,
    // First 64 rows, so a miss is diagnosable rather than just wrong.
    profileHead: Array.from(prof.value.slice(0, 64), (v) => +v.toFixed(3)),
  };

  // Finding a top boundary is not the same as finding chrome. On two real
  // captures whose status bar had already been cropped away, the boundary landed
  // on the author's avatar-and-name row, so trimming it would have removed the
  // byline. The shape test is what stops that.
  if (det.detected) {
    const zones = zoneInk(buf, rowBytes, width, det.inkAt, det.cut);
    const verdict = looksLikeStatusBar(zones, det.cut, img.height());
    out.zones = Array.from(zones, (z) => +z.toFixed(4));
    out.looksLikeStatusBar = verdict.likely;
    out.shapeReasons = verdict.reasons;
    out.shouldTrim = verdict.likely;
  } else {
    out.shouldTrim = false;
  }
  return out;
}

// --- Q4: does the colour survive an encode -> decode round trip? ------------
export function measureRoundTrip(pngBytes, reference, region) {
  if (!pngBytes) return { error: 'nothing encoded to round-trip' };

  const back = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(pngBytes));
  if (!back) return { error: 'could not re-decode our own PNG' };

  const a = readRect(reference, region);
  const b = readRect(back, region);
  if (!a || !b) return { error: 'readPixels returned null on round trip' };
  // `width`/`height`, not `w`/`h`. This guard read `a.w !== b.w` while readRect
  // returned those names; after the merge to the shared shape it would have been
  // `undefined !== undefined` — false for every input, a guard that stops firing
  // without failing. Renaming a returned field is exactly how a comparison goes
  // quiet, and nothing here would have said so.
  if (a.width !== b.width || a.height !== b.height) {
    return { error: 'dimension drift: ' + a.width + 'x' + a.height + ' vs ' + b.width + 'x' + b.height };
  }

  const d = maxChannelDelta(a.buf, b.buf, a.rowBytes, { x: 0, y: 0, w: a.width, h: a.height });
  return { region: a.rect, maxDelta: d.max, meanDelta: d.mean, samples: d.n };
}

// --- Q5: where does a tall image actually die? ------------------------------
/**
 * Deliberately asks for the whole buffer, which is the thing production must not
 * do. It runs here so the ceiling is a measurement instead of the guess the spec
 * currently carries. A throw is a result, not a failure of the spike.
 */
export function stressFullRead(img) {
  const px = img.width() * img.height();
  const want = +((px * 4) / (1024 * 1024)).toFixed(1);
  try {
    const t0 = now();
    const buf = img.readPixels(0, 0, {
      width: img.width(),
      height: img.height(),
      colorType: RGBA.colorType,
      alphaType: RGBA.alphaType,
    });
    return {
      requestedMiB: want,
      ok: !!buf,
      gotBytes: buf ? buf.length : 0,
      ms: +(now() - t0).toFixed(2),
    };
  } catch (e) {
    return { requestedMiB: want, ok: false, threw: String(e && e.message ? e.message : e) };
  }
}

export { rgbHex, ColorSpace };
