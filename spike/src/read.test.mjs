// Tests for src/read.js.
//
//   for b in $(grep -o "BREAK === '[a-z_]*'" src/read.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/read.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. Derive the list with that loop rather than typing it:
// three hand-written BREAK lists in this repo had fallen behind the suites they
// described.
//
// This is the first test either copy of readRect ever had. Both lived in files
// that import Skia and so cannot load in node, and the argument for leaving them
// untested was that they are "just a readPixels call". They are not: the rect
// arithmetic, the origin translation and two null paths are all in here, and the
// rect arithmetic is where the clamp defect lived for four days in four files.
import { readSubRect as realRead } from './read.js';

const BREAK = process.env.BREAK || '';

// Stand-in for a Skia image. Records every readPixels call so a test can assert
// what was ASKED FOR, not only what came back — the clamp defect was invisible
// in the returned statistics and only showed up in the bytes requested.
function fakeImage(w, h, opts = {}) {
  const calls = [];
  return {
    calls,
    width: () => w,
    height: () => h,
    readPixels(x, y, info) {
      calls.push({ x, y, ...info });
      if (opts.readFails) return null;
      // One byte per channel, valued so a caller reading the wrong row length
      // gets wrong numbers rather than plausible ones.
      const n = info.width * info.height * 4;
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = i % 251;
      return buf;
    },
  };
}

const RGBA = { colorType: 'RGBA_8888', alphaType: 'Unpremul' };

let readSubRect = realRead;

if (BREAK === 'clamp_fields') {
  // The original defect, restored: clamp the origin to 0 but keep the requested
  // width, so a rect hanging off the left reads WIDER than it asked for.
  readSubRect = (img, box, colour) => {
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.max(1, Math.min(Math.round(box.w), img.width() - x));
    const h = Math.max(1, Math.min(Math.round(box.h), img.height() - y));
    const buf = img.readPixels(x, y, { width: w, height: h, ...colour });
    if (!buf) return null;
    return { buf, rowBytes: w * 4, width: w, height: h, rect: { x, y, w, h }, bytes: buf.length };
  };
} else if (BREAK === 'no_null_offimage') {
  // The 1px-sliver behaviour: a rect entirely off the image answers anyway.
  readSubRect = (img, box, colour) => {
    const r = realRead(img, box, colour);
    if (r) return r;
    return realRead(img, { x: 0, y: 0, w: 1, h: 1 }, colour);
  };
} else if (BREAK === 'rowbytes_from_box') {
  // rowBytes taken from the REQUESTED width rather than the read width. Every
  // in-bounds case still passes; only a clipped read goes wrong, which is why
  // the asymmetric cases below exist.
  readSubRect = (img, box, colour) => {
    const r = realRead(img, box, colour);
    return r && { ...r, rowBytes: Math.round(box.w) * 4 };
  };
} else if (BREAK === 'drops_rect') {
  // `rect` omitted, so a caller cannot translate its box into the buffer.
  readSubRect = (img, box, colour) => {
    const r = realRead(img, box, colour);
    if (!r) return r;
    const { rect, ...rest } = r;
    return rest;
  };
} else if (BREAK === 'ignores_read_failure') {
  // readPixels returning null treated as success, which is the null dereference
  // one layer further down.
  readSubRect = (img, box, colour) => {
    const r = realRead(img, box, colour);
    if (r) return r;
    return { buf: new Uint8Array(0), rowBytes: 0, width: 0, height: 0, rect: { x: 0, y: 0, w: 0, h: 0 }, bytes: 0 };
  };
} else if (BREAK === 'wh_spelling') {
  // The shape this module exists to unify: `w`/`h` back instead of
  // `width`/`height`, which is how the two copies drifted apart.
  readSubRect = (img, box, colour) => {
    const r = realRead(img, box, colour);
    if (!r) return r;
    const { width, height, ...rest } = r;
    return { ...rest, w: width, h: height };
  };
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// A deliberately non-square image. A square one hides every transposition, and
// the two copies being merged were only ever exercised on 1080-wide captures.
const W = 140;
const H = 37;

console.log('a rect wholly inside the image');
{
  const img = fakeImage(W, H);
  const r = readSubRect(img, { x: 10, y: 5, w: 20, h: 8 }, RGBA);
  check('returns a result', r !== null);
  check('width is what was asked for', r.width === 20, r.width);
  check('height is what was asked for', r.height === 8, r.height);
  check('rowBytes is 4 per pixel of the READ width', r.rowBytes === 80, r.rowBytes);
  check('bytes is the whole buffer', r.bytes === 20 * 8 * 4, r.bytes);
  check('buffer length matches bytes', r.buf.length === r.bytes, r.buf.length);
  check('rect records what was read', JSON.stringify(r.rect) === JSON.stringify({ x: 10, y: 5, w: 20, h: 8 }),
    JSON.stringify(r.rect));
  check('readPixels was called at the rect origin', img.calls[0].x === 10 && img.calls[0].y === 5,
    JSON.stringify(img.calls[0]));
  check('and asked for exactly those dimensions',
    img.calls[0].width === 20 && img.calls[0].height === 8, JSON.stringify(img.calls[0]));
  check('the colour constants are passed straight through',
    img.calls[0].colorType === 'RGBA_8888' && img.calls[0].alphaType === 'Unpremul',
    JSON.stringify(img.calls[0]));
  check('no w/h aliases, so the two shapes cannot drift again',
    r.w === undefined && r.h === undefined, JSON.stringify(Object.keys(r)));
}

// The asymmetric cases. All four edges, on a non-square image, because a rect
// hanging off the LEFT is the one the published Q1 read actually used and a
// symmetric test cannot tell the two clamps apart.
console.log('a rect hanging off the left — the shape the Q1 box had');
{
  const img = fakeImage(W, H);
  // 781px off the left, scaled to this image: ask from -30 for 50 columns.
  const r = readSubRect(img, { x: -30, y: 4, w: 50, h: 10 }, RGBA);
  check('returns a result', r !== null);
  check('the read starts at column 0', r.rect.x === 0, r.rect.x);
  check('and is NARROWER than requested, not wider', r.width === 20, r.width);
  check('never wider than requested', r.width <= 50, r.width);
  check('rowBytes follows the read width, not the request', r.rowBytes === 80, r.rowBytes);
  check('buffer length agrees with rowBytes * height',
    r.buf.length === r.rowBytes * r.height, `${r.buf.length} vs ${r.rowBytes * r.height}`);
  check('readPixels was never asked for the off-image columns',
    img.calls[0].width === 20, JSON.stringify(img.calls[0]));
}

console.log('a rect hanging off the top');
{
  const img = fakeImage(W, H);
  const r = readSubRect(img, { x: 5, y: -8, w: 10, h: 20 }, RGBA);
  check('the read starts at row 0', r.rect.y === 0, r.rect.y);
  check('and is shorter than requested', r.height === 12, r.height);
  check('the width was untouched', r.width === 10, r.width);
}

console.log('a rect hanging off the right, on the long axis');
{
  const img = fakeImage(W, H);
  const r = readSubRect(img, { x: 130, y: 0, w: 40, h: 5 }, RGBA);
  check('stops at the image edge', r.rect.x + r.width === W, r.rect.x + r.width);
  check('width is the overlap only', r.width === 10, r.width);
}

console.log('a rect hanging off the bottom, on the short axis');
{
  const img = fakeImage(W, H);
  const r = readSubRect(img, { x: 0, y: 30, w: 10, h: 40 }, RGBA);
  check('stops at the image edge', r.rect.y + r.height === H, r.rect.y + r.height);
  check('height is the overlap only', r.height === 7, r.height);
}

console.log('a rect the image does not contain at all');
{
  const off = [
    { x: -100, y: 0, w: 50, h: 10 },
    { x: W + 5, y: 0, w: 50, h: 10 },
    { x: 0, y: -100, w: 10, h: 50 },
    { x: 0, y: H + 5, w: 10, h: 50 },
    { x: 500, y: 500, w: 10, h: 10 },
  ];
  for (const box of off) {
    const img = fakeImage(W, H);
    const r = readSubRect(img, box, RGBA);
    check(`returns null for ${JSON.stringify(box)}`, r === null, JSON.stringify(r));
    check('and never touches readPixels', img.calls.length === 0, img.calls.length);
  }
}

console.log('degenerate requests');
{
  for (const box of [{ x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 0, w: 10, h: 0 }, { x: 0, y: 0, w: -5, h: -5 }]) {
    const img = fakeImage(W, H);
    check(`returns null for ${JSON.stringify(box)}`, readSubRect(img, box, RGBA) === null);
    check('and never touches readPixels', img.calls.length === 0, img.calls.length);
  }
}

console.log('readPixels failing is not success');
{
  const img = fakeImage(W, H, { readFails: true });
  const r = readSubRect(img, { x: 0, y: 0, w: 10, h: 10 }, RGBA);
  check('a null from readPixels becomes a null result', r === null, JSON.stringify(r));
  check('readPixels was in fact attempted', img.calls.length === 1, img.calls.length);
}

console.log('the whole image, which is the request this module exists to avoid');
{
  const img = fakeImage(W, H);
  const r = readSubRect(img, { x: 0, y: 0, w: W, h: H }, RGBA);
  check('is allowed when genuinely asked for', r !== null);
  check('and costs exactly the image', r.bytes === W * H * 4, r.bytes);
  // The point of the sub-rect read: a caller asking for a strip pays for a strip.
  const strip = readSubRect(fakeImage(W, H), { x: 0, y: 0, w: W, h: 6 }, RGBA);
  check('a 6-row strip of the same image costs 6 rows',
    strip.bytes === W * 6 * 4, strip.bytes);
  check('which is a fraction of the whole', strip.bytes * 6 < r.bytes, `${strip.bytes} vs ${r.bytes}`);
}

// A sweep, so the invariants hold across all four quadrants rather than at the
// handful of points above. Every outcome is counted, and both outcomes must be
// observed: a sweep that only ever produced nulls would pass every invariant.
console.log('a sweep over all four quadrants');
{
  const img = fakeImage(W, H);
  const xs = [-200, -50, -1, 0, 1, 70, 139, 140, 200];
  const ys = [-100, -20, -1, 0, 1, 18, 36, 37, 90];
  const ws = [1, 7, 60, 300];
  const hs = [1, 3, 25, 300];
  let swept = 0;
  let got = 0;
  let nulls = 0;
  let bad = [];
  for (const x of xs) for (const y of ys) for (const w of ws) for (const h of hs) {
    swept++;
    const box = { x, y, w, h };
    const r = readSubRect(fakeImage(W, H), box, RGBA);
    if (!r) { nulls++; continue; }
    got++;
    if (r.width > w || r.height > h) bad.push(['wider than requested', box, r.width, r.height]);
    if (r.rect.x < 0 || r.rect.y < 0) bad.push(['negative origin', box, r.rect]);
    if (r.rect.x + r.width > W || r.rect.y + r.height > H) bad.push(['outside the image', box, r.rect]);
    if (r.rect.x < x || r.rect.y < y) bad.push(['outside the requested rect', box, r.rect]);
    if (r.rowBytes !== r.width * 4) bad.push(['rowBytes disagrees with width', box, r.rowBytes]);
    if (r.buf.length !== r.rowBytes * r.height) bad.push(['buffer disagrees with rowBytes', box, r.buf.length]);
  }
  // Printed, not just asserted: the write-up quoted this figure as 2,304 from
  // memory when the product is 1,296. A number a document repeats should be one
  // a run prints.
  check(`the sweep ran (${swept} rects)`, swept === xs.length * ys.length * ws.length * hs.length, swept);
  check('reads were observed', got > 0, got);
  check('and nulls were observed', nulls > 0, nulls);
  check('no invariant was violated', bad.length === 0,
    bad.slice(0, 3).map((b) => JSON.stringify(b)).join(' | '));
  check('every swept rect got an answer', got + nulls === swept, `${got}+${nulls}`);
  void img;
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
