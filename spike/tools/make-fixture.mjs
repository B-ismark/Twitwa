// Write a synthetic "social post" screenshot as a valid PNG.
//
//   node tools/make-fixture.mjs out.png
//
// This is not a substitute for a real screenshot — it cannot answer Q1, because
// its flat regions are flat by construction and its textured region is noise
// rather than a photograph. Its job is to make tools/probe.mjs verifiable:
// the bands below have known positions, so a probe that reports the wrong cut
// row or the wrong flatness mix is wrong in a way that shows.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 1080;
const H = 2400;

// Band layout, and what each is there to exercise.
const GLYPH_TOP = 26;    // status-bar glyphs start here, NOT at row 0
const GLYPH_H = 20;      // so rows 0..25 are flat padding above them
const HEADER_END = 200;  // dense ink
const PHOTO_END = 1300;  // textured, so "roughest" has somewhere to be
const LIKES_END = 1360;  // the thin row on flat ground that Q1 measures
const CAPTION_END = 1600;

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(CRC(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Deterministic pseudo-noise: a fixture that changed between runs would make
// every probe number unattributable.
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const px = new Uint8Array(W * H * 3);
const set = (x, y, r, g, b) => {
  const i = (y * W + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
};

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (y < PHOTO_END && y >= HEADER_END) {
      // Textured photo: a smooth gradient plus noise.
      const g = 60 + ((x / W) * 120) + ((y - HEADER_END) / (PHOTO_END - HEADER_END)) * 60;
      const n = (rnd() - 0.5) * 24;
      set(x, y, Math.max(0, Math.min(255, g + n)),
        Math.max(0, Math.min(255, g * 0.8 + n)),
        Math.max(0, Math.min(255, g * 0.65 + n)));
    } else {
      set(x, y, 255, 255, 255);
    }
  }
}

const ink = (x0, y0, w, h, v = 30) => {
  for (let y = y0; y < y0 + h && y < H; y++) {
    for (let x = x0; x < x0 + w && x < W; x++) set(x, y, v, v, v);
  }
};

// Status bar: clock on the left, indicators on the right, flat between — and
// crucially, flat ABOVE. The padding over the glyphs is what broke the first
// detectStatusBar, which took the first flat run and cut at row 1.
for (let x = 40; x < 160; x += 14) ink(x, GLYPH_TOP, 6, GLYPH_H);
for (let x = 900; x < 1030; x += 16) ink(x, GLYPH_TOP, 7, GLYPH_H);

// Header: avatar block plus two name lines.
ink(40, HEADER_END - 90, 72, 72, 90);
ink(130, HEADER_END - 85, 260, 18);
ink(130, HEADER_END - 55, 180, 14, 120);

// Like-count row: short text on flat white. This is the shape Q1 measures.
ink(40, PHOTO_END + 18, 44, 22);
ink(100, PHOTO_END + 20, 150, 16, 90);

// Caption: several text lines.
for (let i = 0; i < 5; i++) ink(40, LIKES_END + 20 + i * 34, 700 - i * 60, 18, 40);
void CAPTION_END;

// Encode as colour type 2, filter 0 per row.
const stride = W * 3;
const rows = Buffer.alloc((stride + 1) * H);
for (let y = 0; y < H; y++) {
  rows[y * (stride + 1)] = 0;
  Buffer.from(px.buffer, y * stride, stride).copy(rows, y * (stride + 1) + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;

const out = process.argv[2];
if (!out) {
  console.log('Usage: node tools/make-fixture.mjs <out.png>');
  process.exit(2);
}
writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(rows)),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`wrote ${out}  ${W}x${H}`);
// Derived from where the glyphs were actually drawn, not asserted separately —
// a hardcoded expectation here once disagreed with the drawing above.
console.log(`expected status-bar cut: row ${GLYPH_TOP + GLYPH_H} (glyphs occupy ` +
  `${GLYPH_TOP}..${GLYPH_TOP + GLYPH_H - 1}, flat above and below)`);
console.log(`expected mix: flat over white bands, textured over rows ${HEADER_END}-${PHOTO_END}`);
