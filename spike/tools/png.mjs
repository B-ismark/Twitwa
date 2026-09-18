// Minimal PNG decoder: inflate, unfilter, emit RGBA.
//
// Exists so Q1 and Q3 can be answered on a desktop from a real screenshot
// instead of waiting for a device. Both are pure pixel math — only the Skia
// speed, the colour round trip and the memory ceiling actually need a phone.
//
// Node ships zlib, and PNG is zlib plus five per-scanline filters, so this
// needs no dependency. Scope is deliberately narrow: 8-bit, non-interlaced,
// colour types 0/2/4/6. Android screenshots are type 6 or 2. Anything else
// throws by name rather than decoding to plausible garbage.
import { inflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error('not a PNG (bad signature)');
  }

  let pos = 8;
  let ihdr = null;
  const idat = [];

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len; // length + type + data + crc

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) throw new Error('no IHDR chunk');
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported bitDepth ${ihdr.bitDepth} (need 8)`);
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG not supported');
  const ch = CHANNELS[ihdr.colorType];
  if (!ch) throw new Error(`unsupported colorType ${ihdr.colorType} (palette not supported)`);

  const { width, height } = ihdr;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const expected = (stride + 1) * height;
  if (raw.length < expected) {
    throw new Error(`short inflate: ${raw.length} bytes, expected ${expected}`);
  }

  // Unfilter in place into a contiguous stride-major buffer.
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;          // left
      const b = prev ? prev[i] : 0;                  // up
      const c = prev && i >= ch ? prev[i - ch] : 0;  // upper-left
      const x = src[i];
      switch (ft) {
        case 0: cur[i] = x; break;
        case 1: cur[i] = (x + a) & 0xff; break;
        case 2: cur[i] = (x + b) & 0xff; break;
        case 3: cur[i] = (x + ((a + b) >> 1)) & 0xff; break;
        case 4: cur[i] = (x + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`unknown filter type ${ft} on row ${y}`);
      }
    }
  }

  // Widen to RGBA so callers share one layout with Skia's readPixels output.
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * ch;
    const d = p * 4;
    if (ch === 4) {
      out[d] = lines[s]; out[d + 1] = lines[s + 1]; out[d + 2] = lines[s + 2]; out[d + 3] = lines[s + 3];
    } else if (ch === 3) {
      out[d] = lines[s]; out[d + 1] = lines[s + 1]; out[d + 2] = lines[s + 2]; out[d + 3] = 255;
    } else if (ch === 2) {
      out[d] = out[d + 1] = out[d + 2] = lines[s]; out[d + 3] = lines[s + 1];
    } else {
      out[d] = out[d + 1] = out[d + 2] = lines[s]; out[d + 3] = 255;
    }
  }

  return { buf: out, rowBytes: width * 4, width, height, colorType: ihdr.colorType };
}
