// Write a tall synthetic PNG, for the Q5 memory ramp only.
//
//   node tools/make-tall.mjs out.png 1080 20000
//
// Separate from make-fixture.mjs on purpose. That file's band positions are
// hardcoded and are what make tools/probe.mjs verifiable — its expected cut row
// is derived from its own geometry, so parameterising its height would quietly
// invalidate the claim it exists to support.
//
// Q5 asks where a full-buffer read dies, which needs pixel COUNT and nothing
// else: no status bar, no glyphs, no realism. The content here is chosen to
// compress well so that pushing an 86MiB-as-RGBA image over USB stays cheap,
// while still not being a single flat colour — a uniform image could in
// principle be special-cased by a decoder, and a ceiling measured on a
// degenerate input would not be the ceiling.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

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

const [, , outPath, wArg, hArg] = process.argv;
if (!outPath) {
  console.log('Usage: node tools/make-tall.mjs <out.png> [width=1080] [height=20000]');
  process.exit(2);
}
const W = Number(wArg) || 1080;
const H = Number(hArg) || 20000;

// One scanline at a time, so the encoder never holds the whole RGB buffer.
// Filter 0 (None) on every row: cheap to write, and deflate still collapses the
// long runs.
const rowBytes = W * 3;
const raw = Buffer.alloc((rowBytes + 1) * H);
let o = 0;
for (let y = 0; y < H; y++) {
  raw[o++] = 0; // filter: None
  // A dark ground with a periodic lighter band, so the image has structure
  // without having detail.
  const band = Math.floor(y / 400) % 2 === 0;
  const base = band ? 0x12 : 0x06;
  for (let x = 0; x < W; x++) {
    const edge = x < 24 || x >= W - 24 ? 0x1a : 0;
    raw[o++] = base + edge;
    raw[o++] = base + edge;
    raw[o++] = base + edge + (band ? 2 : 0);
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 2;  // colour type 2 = RGB, matching what this phone actually produces
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // non-interlaced

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(outPath, png);
const mp = (W * H) / 1e6;
console.log(
  `${outPath}  ${W}x${H}  ${mp.toFixed(2)}MP  ` +
  `${((W * H * 4) / (1024 * 1024)).toFixed(1)}MiB as RGBA  ` +
  `${(png.length / (1024 * 1024)).toFixed(2)}MiB on disk`,
);
