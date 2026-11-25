// Which encoder writes the card, and a reader for what it wrote.
//
// Pure: no Skia, no react-native, so the decisions load in node and have a
// test. The native half is modules/twitwa-pixels (Kotlin, Dispatchers.IO) and
// cannot run anywhere but a phone; this file is the part that can be checked.
//
// WHY THERE ARE TWO ENCODERS. Skia's encodeToBytes + file.write run on the JS
// thread, and a PNG deflate of a multi-megapixel card froze the UI for the
// length of the export. The native one does the same job on another thread.
// Skia stays, for two reasons: it is the fallback for any native failure, and
// it is the only encoder that knows what to do with a colour space.
//
// WHY WIDE GAMUT NEVER GOES NATIVE. Skia embeds the surface's profile in the
// file. An Android sRGB Bitmap has no profile to embed, so a Display P3 card
// encoded natively would keep its numbers and silently change their meaning.
// `wideGamut` is derived at the call site (a Skia ColorSpace was requested),
// because the ColorSpace object cannot be imported here.

const NATIVE_FORMATS = ['png', 'jpeg'];

/**
 * Why a card stays on Skia, or null when it may go native.
 * `unavailable` (no module in this build), `wide-gamut`, `format`, `forced`.
 */
export function skiaReason({ available, wideGamut, format, force } = {}) {
  if (force === 'skia') return 'forced';
  if (!available) return 'unavailable';
  if (wideGamut) return 'wide-gamut';
  if (!NATIVE_FORMATS.includes(format)) return 'format';
  return null;
}

/** 'native' or 'skia'. See skiaReason for why a card is kept on Skia. */
export function pickEncoder(opts) {
  return skiaReason(opts) === null ? 'native' : 'skia';
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * What a PNG says about itself, from its chunk table alone. Never throws: a
 * truncated or garbage buffer comes back `ok: false` with whatever chunks were
 * readable before it ran out.
 *
 * `iccp` and `srgb` are the colour-space markers: Skia writes an iCCP chunk,
 * and a bare Android encode writes neither, which is exactly the difference
 * the dev panel's parity check is there to show.
 *
 * @returns {{ok:boolean, width:number, height:number, colorType:number,
 *            iccp:boolean, srgb:boolean, chunks:string[]}}
 */
export function pngInfo(bytes) {
  const info = { ok: false, width: 0, height: 0, colorType: -1, iccp: false, srgb: false, chunks: [] };
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < SIG.length) return info;
  for (let i = 0; i < SIG.length; i++) if (bytes[i] !== SIG[i]) return info;
  const u32 = (at) => ((bytes[at] * 0x1000000) + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]));
  let pos = SIG.length;
  let sawHeader = false;
  while (pos + 8 <= bytes.length) {
    const len = u32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) break;
    // A chunk that claims more than the buffer holds is truncation; stop
    // before reading it as if it were whole.
    if (pos + 12 + len > bytes.length) break;
    info.chunks.push(type);
    if (type === 'IHDR' && !sawHeader && len === 13) {
      info.width = u32(pos + 8);
      info.height = u32(pos + 12);
      info.colorType = bytes[pos + 17];
      sawHeader = true;
    } else if (type === 'iCCP') {
      info.iccp = true;
    } else if (type === 'sRGB') {
      info.srgb = true;
    }
    pos += 12 + len;
  }
  info.ok = sawHeader && info.chunks[0] === 'IHDR';
  return info;
}

/**
 * Index of the first byte at which two buffers differ, or -1 when they are the
 * same length and the same bytes. A length difference counts as a difference
 * at the shorter length.
 */
export function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * The rects a parity check reads from each decoded card: the whole card when it
 * is small (up to 2 MP), otherwise a band of about 1 MP at the top, the middle
 * and the bottom. A full read of a 14 MP card in the dev panel would be 56 MB a
 * side for no extra information about an encoder that treats every row alike.
 */
export function parityBands(width, height) {
  if (width <= 0 || height <= 0) return [];
  if (width * height <= 2e6) return [{ x: 0, y: 0, w: width, h: height }];
  const rows = Math.max(1, Math.min(height, Math.floor(1e6 / width)));
  const mid = Math.floor((height - rows) / 2);
  return [
    { x: 0, y: 0, w: width, h: rows },
    { x: 0, y: mid, w: width, h: rows },
    { x: 0, y: height - rows, w: width, h: rows },
  ];
}
