// Phase 1: the whole pipeline, decode to PNG on disk, as one call.
//
//   const card = await renderCard({ uri, padding: 'standard', trim: 'auto' });
//   // -> { path, width, height, fill, fillSource, trimmed, warnings, timings }
//
// The spike's six buttons proved each Skia call works. This is those calls in
// the order the product needs them, with src/plan.js making every decision and
// this file making none. If a question here has a right answer that does not
// depend on Skia, it does not belong in this file — that is what kept plan.js,
// sizing.js and pixels.js testable on a desktop, and it is worth defending.
//
// Two rules this file exists to enforce:
//
//   1. Never read a whole image. Every readPixels below is a sub-rect. A full
//      1080x20000 buffer is 82MiB and measured fine on a Pixel 6 Pro, which is
//      exactly why it is tempting and exactly why it must not be the habit —
//      the ceiling is one driver's number, and nothing here needs it.
//   2. Sample the background from the FINAL crop. planCard takes the sampler as
//      a callback so this cannot be got wrong; see the note in plan.js.
import { Skia, ColorType, AlphaType, ImageFormat, ColorSpace } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';

import {
  regionBackground,
  ringBackground,
  ringStrips,
  rowInkProfile,
  detectStatusBar,
  zoneInk,
  looksLikeStatusBar,
  cropEdgeStrips,
  decideCropBackground,
  tileGrid,
  collectPoints,
  modalOfPoints,
} from './pixels';
import { planCard, clampMasks, maskToDestPixels, orientedSize, needsOrientation } from './plan';
import { readSubRect } from './read';
import { MAX_PX } from './sizing';
import { radiusPx } from './compose';

const STATUS_BAND_ROWS = 400;   // enough to hold any status bar; never the whole image
const EDGE_THICKNESS = 8;       // matches pixels.js's default, kept explicit here

const now = () => (global.performance && global.performance.now ? global.performance.now() : Date.now());

// The colour shape every read in this file uses, hoisted so read.js needs no
// Skia import of its own and can therefore be tested in node.
const RGBA = { colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };

/**
 * Read one sub-rect as RGBA.
 *
 * A one-line adapter over `readSubRect`, which measure.js also uses. The body
 * used to live here and again in measure.js, with the same arithmetic under two
 * different field spellings — `{width, height}` here and `{w, h}` there. See
 * src/read.js for why the arithmetic is worth having in one place, and for the
 * clamp defect that lived in it.
 */
const readRect = (img, box) => readSubRect(img, box, RGBA);

/** regionBackground over a strip read on its own, with the rect translated to the strip's origin. */
function stripBackground(img, rect, tolerance, step) {
  const s = readRect(img, rect);
  if (!s) return null;
  return regionBackground(
    s.buf,
    s.rowBytes,
    s.width,
    s.height,
    { x: 0, y: 0, w: s.width, h: s.height },
    tolerance,
    step,
  );
}

/** Decode. Skia's image creation is lazy; pixels are decoded on first read. */
function decodeImage(bytes) {
  return imageFromData(Skia.Data.fromBytes(bytes));
}

/**
 * Decode from a URI, which is what the product actually gets.
 *
 * A share arrives as a `content://` URI and the picker returns one too, so bytes
 * were never the real input. `decodeImage` is kept for the one caller inside this
 * file and is no longer exported: the comment here used to say it "stays for
 * callers that already hold bytes", and there were none — not in App.js, not in
 * measure.js, and none were possible, because this module imports Skia and so
 * cannot be loaded anywhere a test could reach it. Six other functions carried
 * the same empty `export`. Re-exporting one is a single word if a device harness
 * ever wants to time a stage on its own.
 */
export async function decodeUri(uri) {
  return imageFromData(await Skia.Data.fromURI(uri));
}

function imageFromData(data) {
  const img = Skia.Image.MakeImageFromEncoded(data);
  if (!img) throw new Error('MakeImageFromEncoded returned null: not a decodable image');
  return img;
}

/**
 * Bake an EXIF orientation into a new image, so everything downstream is
 * orientation-free.
 *
 * An earlier version of this file applied the orientation as a canvas transform
 * inside composeCard, which was wrong in two ways at once: the transform also
 * moved the destination rect and the Cover boxes, and for a 90 degree rotation
 * the planned output size was still the un-rotated one, so the picture would have
 * been rotated inside a card shaped for the wrong aspect. Normalising first costs
 * one extra surface and makes the rest of the pipeline unable to get it wrong.
 *
 * Skia's MakeImageFromEncoded does not apply the tag itself, so the caller passes
 * it in (expo-image-picker can report it). Orientation 1, and anything not in
 * 2..8, is returned untouched with no surface allocated.
 *
 * NOT YET RUN ON A DEVICE. Screenshots have no orientation tag, so no input
 * measured so far reaches this path.
 */
function normaliseOrientation(img, orientation = 1) {
  if (!needsOrientation(orientation)) return { img, applied: false };

  const w = img.width();
  const h = img.height();
  const out = orientedSize(w, h, orientation);
  const surface = Skia.Surface.MakeOffscreen(out.width, out.height);
  if (!surface) {
    return { img, applied: false, error: `MakeOffscreen(${out.width}x${out.height}) returned null` };
  }
  const canvas = surface.getCanvas();
  switch (orientation) {
    case 2: canvas.translate(w, 0); canvas.scale(-1, 1); break;
    case 3: canvas.translate(w, h); canvas.scale(-1, -1); break;
    case 4: canvas.translate(0, h); canvas.scale(1, -1); break;
    case 5: canvas.scale(1, -1); canvas.rotate(-90, 0, 0); break;
    case 6: canvas.translate(out.width, 0); canvas.rotate(90, 0, 0); break;
    case 7: canvas.translate(out.width, out.height); canvas.scale(-1, 1); canvas.rotate(-90, 0, 0); break;
    case 8: canvas.translate(0, out.height); canvas.rotate(-90, 0, 0); break;
    default: break;
  }
  const paint = Skia.Paint();
  paint.setAntiAlias(true);
  canvas.drawImage(img, 0, 0, paint);
  return { img: surface.makeImageSnapshot(), applied: true, orientation, size: out };
}

/**
 * Status bar detection over the top band only.
 *
 * Broken into three timed steps because the total was the second-largest cost in
 * the whole pipeline and nothing said which part it was. `readMs` is the band's
 * readPixels — and on the first call it also pays for the lazy decode of the
 * whole image, which is why it dwarfs the later calls on the same image.
 */
function findStatusBar(img, rows = STATUS_BAND_ROWS) {
  const t0 = now();
  const band = readRect(img, { x: 0, y: 0, w: img.width(), h: Math.min(rows, img.height()) });
  const readMs = +(now() - t0).toFixed(2);
  if (!band) return { detected: false, reason: 'could not read the top band', readMs };

  const t1 = now();
  const profile = rowInkProfile(band.buf, band.rowBytes, band.width, band.height, band.height);
  const profileMs = +(now() - t1).toFixed(2);

  const sb = detectStatusBar(profile);
  if (!sb.detected) {
    return { detected: false, reason: sb.reason, cut: 0, readMs, profileMs, zonesMs: 0 };
  }

  const t2 = now();
  const zones = zoneInk(band.buf, band.rowBytes, band.width, sb.inkAt, sb.cut);
  const zonesMs = +(now() - t2).toFixed(2);

  const shape = looksLikeStatusBar(zones, sb.cut, img.height());
  return {
    detected: true,
    cut: sb.cut,
    inkAt: sb.inkAt,
    zones,
    likely: shape.likely,
    shapeReasons: shape.reasons,
    readMs,
    profileMs,
    zonesMs,
    bandPx: band.width * band.height,
  };
}

/**
 * Sample the card background from a crop, reading only the four edge strips.
 *
 * The fallback's whole-crop read is deferred behind a closure, so a crop whose
 * edges agree never pays for it. On a tall crop that is the difference between
 * four thin strips and tens of MiB.
 *
 * EXPORTED for Phase 4.5's live preview, which has to draw the same frame
 * colour the export will write. The alternative was a second sampler in
 * App.js, and a preview whose background is computed by different rules from
 * the PNG's is the exact defect the phase exists to remove — worse here than
 * anywhere, because Match is the default, so the divergence would be on every
 * card by default rather than on an unusual one.
 */
export function sampleCropBackground(img, crop, opts = {}) {
  const { thickness = EDGE_THICKNESS, tolerance = 16, agree = 12, step = 2, tiles } = opts;
  const strips = cropEdgeStrips(crop, thickness);
  const edges = {};
  for (const [name, rect] of Object.entries(strips)) {
    edges[name] = stripBackground(img, rect, tolerance, step);
  }
  return decideCropBackground(edges, () => sampleFallbackTiles(img, crop, tolerance, tiles), { agree });
}

/**
 * The fallback sample: a grid of small tiles, read one at a time.
 *
 * This used to be `stripBackground(img, crop, ...)` — a readPixels of the whole
 * crop, 82MiB on a 1080x20000 capture, in the file whose first stated rule is
 * never to read a whole image. The subsampling `step` reduced the loop, not the
 * allocation, so the rule was being broken by the one path that looked like it
 * respected it. And the fallback is not rare: 6 of the 12 crops in
 * results/phase1-card-background.md take it.
 *
 * Peak buffer is now one tile — 9KiB against 82.4MiB — and the grid comes from
 * pixels.js's tileGrid so the desktop probe samples exactly the same rects.
 * Verified to change no verdict on all 12 published crops; one fallback luma
 * moved from 253.4 to 253, on the same side of the only threshold it feeds.
 */
function sampleFallbackTiles(img, crop, tolerance = 16, tileOpts) {
  const pts = [];
  for (const t of tileGrid(crop, tileOpts)) {
    const s = readRect(img, t);
    if (!s) continue;
    collectPoints(s.buf, s.rowBytes, s.width, s.height, { x: 0, y: 0, w: s.width, h: s.height }, 1, pts);
  }
  if (!pts.length) return null;
  return modalOfPoints(pts, tolerance);
}

/**
 * Compose the card and encode it.
 *
 * The crop is drawn into `plan.dest`, which plan.js derived by SUBTRACTION from
 * the output width. Passing `crop.w * scale` here instead would let the two
 * roundings disagree and put a one-pixel bright line down one edge of a card
 * whose whole point is the frame.
 */
function composeCard(img, plan, opts = {}) {
  const { colorSpace, masks = [], radius = 0 } = opts;
  const t0 = now();
  let subpixel = 0;   // boxes that owned no whole output pixel

  const surface = Skia.Surface.MakeOffscreen(
    plan.width,
    plan.height,
    colorSpace ? { colorSpace } : undefined,
  );
  // Measured on a Mali-G78: this returns NULL rather than throwing, somewhere in
  // [16256, 16384) on a side. An unchecked caller gets a null dereference
  // pointing at the wrong layer.
  if (!surface) {
    return {
      error: `MakeOffscreen(${plan.width}x${plan.height}) returned null`,
      width: plan.width,
      height: plan.height,
    };
  }

  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color(plan.fill));

  const paint = Skia.Paint();
  paint.setAntiAlias(true);

  // Rounded corners, drawn as a clip on the IMAGE rather than as a shape over
  // it. Painting the frame colour into the corners would be a second thing
  // that has to be exactly the background, and the two go out of step the
  // moment the Style strip changes one of them.
  //
  // The pixel count comes from compose.js's radiusPx, the same call the
  // on-screen preview makes, because "a fraction of the image's width" is a
  // one-line multiplication and a one-line multiplication written twice gets
  // rounded differently the second time.
  //
  // Anti-aliasing ON here, unlike the Cover clip below, and for the opposite
  // reason: a corner is a curve, so the stair-stepping AA removes is the whole
  // defect, and there is no hidden content for a blended edge to leak.
  const rPx = radiusPx(plan.dest.w, radius);
  const rounded = rPx > 0;
  if (rounded) {
    canvas.save();
    canvas.clipRRect(
      Skia.RRectXY(
        Skia.XYWHRect(plan.dest.x, plan.dest.y, plan.dest.w, plan.dest.h),
        rPx,
        rPx,
      ),
      1, // Intersect
      true,
    );
  }
  canvas.drawImageRect(
    img,
    Skia.XYWHRect(plan.crop.x, plan.crop.y, plan.crop.w, plan.crop.h),
    Skia.XYWHRect(plan.dest.x, plan.dest.y, plan.dest.w, plan.dest.h),
    paint,
  );
  // NOT restored before the Cover boxes, on purpose. A box overlapping a
  // rounded corner has to be clipped to the SAME rounding the image is, or it
  // paints a grey square into the corner where the frame shows through. That
  // hides nothing: the image is clipped there too, so the corner carries no
  // content for the missing part of the box to leak.
  //
  // Cover boxes. Already clamped to the crop by plan.clampMasks, so this clip is
  // defence rather than the rule — but it is cheap, and the failure it prevents
  // is a grey rectangle sitting on the frame, which is the most visible possible
  // defect in a product whose entire output is a framed picture.
  if (masks.length) {
    canvas.save();
    canvas.clipRect(
      Skia.XYWHRect(plan.dest.x, plan.dest.y, plan.dest.w, plan.dest.h),
      1, // Intersect
      false,
    );
    // One paint, anti-aliasing OFF. A Cover box is a redaction and its edges are
    // axis-aligned integers, so there is nothing for AA to improve and one thing
    // for it to break: a blended boundary row leaves part of the covered content
    // visible. Measured at up to 53/255 before this was turned off.
    const p = Skia.Paint();
    p.setAntiAlias(false);
    for (const m of masks) {
      const r = maskToDestPixels(m, plan);
      // Null means the box owns no whole output pixel. Skipping is right and the
      // count is reported, because a box the user drew and cannot see is a bug
      // upstream, not something to swallow here.
      if (!r) {
        subpixel += 1;
        continue;
      }
      // Each box gets the modal colour of ITS OWN ring, not the card background.
      // Those differ whenever a box sits on chrome that is not the card's edge
      // colour, which is most of the time — see results/phase0-q1-q3.md.
      p.setColor(Skia.Color(m.fill || plan.fill));
      canvas.drawRect(Skia.XYWHRect(r.x, r.y, r.w, r.h), p);
    }
    canvas.restore();
  }
  if (rounded) canvas.restore();

  const drawMs = +(now() - t0).toFixed(2);
  const t1 = now();
  const snapshot = surface.makeImageSnapshot();
  const png = snapshot.encodeToBytes(ImageFormat.PNG, 100);
  const encodeMs = +(now() - t1).toFixed(2);

  return {
    png,
    width: plan.width,
    height: plan.height,
    bytes: png ? png.length : 0,
    subpixelMasks: subpixel,
    drawMs,
    encodeMs,
    totalMs: +(drawMs + encodeMs).toFixed(2),
  };
}

/**
 * The modal colour of the ring around one Cover box, read as four strips.
 *
 * `coverage` comes back with it and is worth surfacing rather than hiding: a low
 * value means the ring is mostly not background, i.e. the box is misplaced, which
 * wants a different response from a rough background.
 *
 * Four reads, not one. This used to read the box's padded bounding rectangle in
 * a single `readPixels` and hand it to `ringBackground`, which scanned the ring
 * and skipped the interior — so the interior was read and thrown away. The cost
 * is the BOX's area, not the ring's: a Cover box over a whole 1080x20000 capture
 * asked for 82.4MiB to use about 150KiB of it, and a review found it still there
 * after the same defect had been fixed in the background fallback. Reading the
 * strips makes the request proportional to the ring, so a full-image box and a
 * thumbnail-sized one cost the same.
 *
 * `peakReadBytes` is returned so the bound is a measurement at the call site
 * rather than a claim in this comment.
 */
function maskFill(img, box, thickness = 6, tolerance = 16) {
  const strips = ringStrips(box, thickness, img.width(), img.height());
  // No surround at all: the box covers the image. Not an error, and not black.
  if (!strips.length) return null;

  const pts = [];
  let peakReadBytes = 0;
  for (const strip of strips) {
    const s = readRect(img, strip);
    if (!s) continue;
    peakReadBytes = Math.max(peakReadBytes, s.buf.length);
    for (let yy = 0; yy < s.height; yy++) {
      const row = yy * s.rowBytes;
      for (let xx = 0; xx < s.width; xx++) {
        const i = row + xx * 4;
        pts.push(s.buf[i], s.buf[i + 1], s.buf[i + 2]);
      }
    }
  }
  if (!pts.length) return null;
  const r = modalOfPoints(pts, tolerance);
  return r && { ...r, peakReadBytes, strips: strips.length };
}

/**
 * The whole thing.
 *
 * @param uri          a content:// or file:// URI — what a share or the picker gives
 * @param bytes        encoded image bytes, as an alternative to `uri`
 * @param crop         {x,y,w,h} in source pixels; omit for the whole image
 * @param padding      'snug' | 'standard' | 'roomy', or a fraction
 * @param trim         'auto' | 'always' | 'never'
 * @param frame        'match' | 'paper' | 'ink' — the Style strip's Background
 * @param radius       corner radius as a fraction of the image's own width
 * @param masks        Cover boxes in source pixels
 * @param colorSpace   a Skia ColorSpace, or omit for sRGB
 * @param outputName   basename for the written file
 */
export async function renderCard({
  uri,
  bytes,
  crop,
  padding = 'standard',
  trim = 'auto',
  frame = 'match',
  radius = 0,
  masks = [],
  colorSpace,
  orientation = 1,
  outputName,
}) {
  const timings = {};
  let t = now();

  if (!uri && !bytes) throw new Error('renderCard needs either a uri or bytes');
  const decoded = uri ? await decodeUri(uri) : decodeImage(bytes);
  // Orientation is baked in BEFORE planning, so plan.js sizes the card to the
  // dimensions the picture actually has. Identity for every screenshot.
  const oriented = normaliseOrientation(decoded, orientation);
  const img = oriented.img;
  const source = { width: img.width(), height: img.height() };
  timings.decodeMs = +(now() - t).toFixed(2);
  // Named honestly: Skia's decode is lazy, so this is header parse plus an
  // allocation, not the cost of decoding pixels. Measured at 2-13ms regardless
  // of whether the image was 4.49MP or 21.6MP. The real decode is paid inside
  // the first readPixels below.
  timings.decodeIsLazy = true;

  t = now();
  const statusBar = findStatusBar(img);
  timings.statusBarMs = +(now() - t).toFixed(2);
  // Attributed, because the total alone sent me optimising the wrong half once
  // already: readMs on the first call also pays for the lazy decode.
  timings.statusBarRead = statusBar.readMs;
  timings.statusBarProfile = statusBar.profileMs;
  timings.statusBarZones = statusBar.zonesMs;

  t = now();
  let plan;
  const planned = planCard({
    image: source,
    crop,
    padding,
    statusBar: statusBar.detected ? statusBar : null,
    trim,
    frame,
    sampleBackground: (rect) => sampleCropBackground(img, rect),
  });
  plan = planned;
  timings.planMs = +(now() - t).toFixed(2);

  const warnings = [...plan.warnings];
  if (plan.width * plan.height > MAX_PX) {
    // plan.js already clamps to MAX_PX, so reaching here means the clamp changed
    // or was bypassed. Say so rather than silently encoding something huge.
    warnings.push(`output exceeds MAX_PX after planning (${plan.width}x${plan.height})`);
  }

  // Clamp Cover boxes to the FINAL crop, which may have moved under them if the
  // status bar was trimmed after they were placed.
  const clamped = clampMasks(masks, plan.crop);
  if (clamped.dropped.length) {
    warnings.push(`${clamped.dropped.length} Cover box(es) fell entirely outside the crop and were dropped`);
  }
  if (clamped.masks.some((m) => m.clipped)) {
    warnings.push('a Cover box extended past the crop and was clipped to it');
  }
  // Each box's fill is the modal colour of its own ring, computed here because
  // it needs pixels. A box with an explicit fill keeps it.
  const filledMasks = clamped.masks.map((m) => {
    if (m.fill) return m;
    const r = maskFill(img, m);
    if (r && r.coverage < 0.6) {
      warnings.push(`a Cover box's ring is only ${Math.round(r.coverage * 100)}% background: the box looks misplaced`);
    }
    return { ...m, fill: r ? r.hex : plan.fill, coverage: r ? r.coverage : undefined };
  });

  const composed = composeCard(img, plan, { colorSpace, masks: filledMasks, radius });
  if (composed.error) {
    return { error: composed.error, plan, statusBar, source, warnings, timings };
  }
  timings.drawMs = composed.drawMs;
  timings.encodeMs = composed.encodeMs;

  t = now();
  const dir = new Directory(Paths.cache, 'cards');
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, outputName || `card-${Date.now()}.png`);
  // create({overwrite}) rather than delete-then-create: one call, and no window
  // where the old file is gone and the new one does not exist yet.
  file.create({ overwrite: true });
  file.write(composed.png);
  timings.writeMs = +(now() - t).toFixed(2);

  return {
    path: file.uri,
    width: composed.width,
    height: composed.height,
    bytes: composed.bytes,
    fill: plan.fill,
    fillSource: plan.fillSource,
    fillLuma: plan.fillLuma,
    crop: plan.crop,
    dest: plan.dest,
    pad: plan.pad,
    // Both, because the fraction is what the editor holds and the pixels are
    // what landed. A gate comparing the preview with the export needs the
    // fraction; someone reading a log wanting to know why a corner looks wrong
    // needs the pixels.
    radius,
    radiusPx: radiusPx(plan.dest.w, radius),
    frame,
    scale: plan.scale,
    clamped: plan.clamped,
    trimmed: plan.trimmed,
    trimmedRows: plan.trimmedRows,
    orientation: { requested: orientation, applied: oriented.applied, error: oriented.error },
    masks: filledMasks,
    statusBar,
    source,
    background: plan.background,
    warnings,
    timings,
  };
}

export { ColorSpace };
