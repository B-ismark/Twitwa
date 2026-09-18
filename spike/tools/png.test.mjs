// Tests for tools/png.mjs.
//
// The encoder below exists only here, to build test inputs. It can emit any of
// the five filter types, because unfiltering is exactly where a PNG decoder
// stops throwing and starts producing plausible garbage instead — a wrong Paeth
// gives an image that decodes, looks nearly right, and reports wrong colours.
//
// BREAK= mutations, each of which must exit 1:
//   for b in mislabel truncate noguard; do
//     BREAK=$b node tools/png.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
import { deflateSync } from 'node:zlib';
import { decodePng } from './png.mjs';

const BREAK = process.env.BREAK || '';

// --- test-only PNG encoder --------------------------------------------------
// CRC fields are written as zeros: the decoder does not verify them, and a real
// CRC here would test node's zlib rather than our unfiltering.
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(0, 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodePng(pixels, width, height, channels, filterType, opts = {}) {
  const stride = width * channels;
  const rows = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    // BREAK=mislabel claims "no filter" while actually filtering the bytes, so
    // the decoder unfilters wrongly. It proves the filter assertions are live.
    rows[y * (stride + 1)] = BREAK === 'mislabel' ? 0 : filterType;
    for (let i = 0; i < stride; i++) {
      const x = pixels[y * stride + i];
      const a = i >= channels ? pixels[y * stride + i - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels] : 0;
      let v;
      switch (filterType) {
        case 0: v = x; break;
        case 1: v = x - a; break;
        case 2: v = x - b; break;
        case 3: v = x - ((a + b) >> 1); break;
        case 4: v = x - paeth(a, b, c); break;
        default: v = x;
      }
      rows[y * (stride + 1) + 1 + i] = v & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = opts.bitDepth ?? 8;
  ihdr[9] = channels === 4 ? 6 : channels === 3 ? 2 : channels === 2 ? 4 : 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = opts.interlace ?? 0;

  let idat = deflateSync(rows);
  if (BREAK === 'truncate') idat = idat.subarray(0, idat.length - 4);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- harness ---------------------------------------------------------------
let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}
function throwsWith(name, fn, needle) {
  ran++;
  try {
    fn();
    fails++;
    console.log(`  FAIL  ${name}  -> did not throw`);
  } catch (e) {
    if (String(e.message).includes(needle)) {
      console.log(`  pass  ${name}`);
    } else {
      fails++;
      console.log(`  FAIL  ${name}  -> threw "${e.message}", wanted "${needle}"`);
    }
  }
}

// A gradient plus hard edges: gradients exercise Sub/Up/Average, hard edges
// exercise Paeth, and a flat image would pass with almost any filter maths.
function makeRGBA(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const edge = x > w / 2 && y > h / 3;
      px[i] = edge ? 250 : (x * 7) & 0xff;
      px[i + 1] = edge ? 10 : (y * 11) & 0xff;
      px[i + 2] = edge ? 90 : (x * y) & 0xff;
      px[i + 3] = 255;
    }
  }
  return px;
}

const W = 23; // deliberately not a round number, so stride bugs show
const H = 17;
const rgba = makeRGBA(W, H);

console.log('every filter type decodes to the same pixels');
for (const ft of [0, 1, 2, 3, 4]) {
  const png = encodePng(rgba, W, H, 4, ft);
  let got = null;
  let err = null;
  try { got = decodePng(png); } catch (e) { err = e.message; }
  if (!got) {
    check(`filter ${ft}`, false, err);
    continue;
  }
  let diff = 0;
  let firstAt = -1;
  for (let i = 0; i < rgba.length; i++) {
    if (got.buf[i] !== rgba[i]) { diff++; if (firstAt < 0) firstAt = i; }
  }
  check(`filter ${ft} round-trips exactly`, diff === 0, `${diff} bytes differ, first at ${firstAt}`);
}

console.log('geometry and channel handling');
{
  const png = encodePng(rgba, W, H, 4, 4);
  const got = decodePng(png);
  check('width/height', got.width === W && got.height === H, `${got.width}x${got.height}`);
  check('rowBytes is RGBA stride', got.rowBytes === W * 4, got.rowBytes);
  check('buffer length', got.buf.length === W * H * 4, got.buf.length);
}
{
  // colorType 2 has no alpha channel; it must be widened to opaque.
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 13) & 0xff;
  const got = decodePng(encodePng(rgb, W, H, 3, 3));
  check('RGB decodes', got.colorType === 2, got.colorType);
  let opaque = true;
  for (let p = 0; p < W * H; p++) if (got.buf[p * 4 + 3] !== 255) opaque = false;
  check('RGB gains opaque alpha', opaque);
  check('RGB channel order preserved', got.buf[0] === rgb[0] && got.buf[1] === rgb[1] && got.buf[2] === rgb[2]);
}
{
  // colorType 0 is greyscale; it must broadcast across R, G and B.
  const grey = new Uint8Array(W * H);
  for (let i = 0; i < grey.length; i++) grey[i] = (i * 5) & 0xff;
  const got = decodePng(encodePng(grey, W, H, 1, 1));
  check('grey broadcasts to RGB',
    got.buf[4] === grey[1] && got.buf[5] === grey[1] && got.buf[6] === grey[1],
    `${got.buf[4]},${got.buf[5]},${got.buf[6]} vs ${grey[1]}`);
}

console.log('rejects what it cannot decode, by name');
{
  // BREAK=noguard hands each of these a perfectly valid PNG instead, so an
  // assertion that only ever saw a throw is shown to be checking for one.
  const valid = () => encodePng(rgba, W, H, 4, 0);
  const bad = BREAK === 'noguard';

  throwsWith('bad signature', () => {
    const b = valid();
    if (!bad) b[1] = 0x00;
    decodePng(b);
  }, 'bad signature');

  throwsWith('16-bit', () => {
    decodePng(bad ? valid() : encodePng(rgba, W, H, 4, 0, { bitDepth: 16 }));
  }, 'unsupported bitDepth');

  throwsWith('interlaced', () => {
    decodePng(bad ? valid() : encodePng(rgba, W, H, 4, 0, { interlace: 1 }));
  }, 'interlaced');

  throwsWith('unknown filter byte', () => {
    const b = valid();
    if (bad) { decodePng(b); return; }
    // Re-encode with an out-of-range filter byte on row 0.
    const stride = W * 4;
    const rows = Buffer.alloc((stride + 1) * H);
    rows[0] = 9;
    const idat = deflateSync(rows);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    decodePng(Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
    ]));
  }, 'unknown filter type');
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
