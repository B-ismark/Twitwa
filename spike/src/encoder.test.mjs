// Tests for src/encoder.js and the wiring around the native pixels module.
//
//   for b in $(grep -o "BREAK [!=]== '[a-z_0-9]*'" src/encoder.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/encoder.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// The Kotlin cannot run here. What can be checked is the contract between the
// two halves, read out of the source text (the sharein.test.mjs exception,
// and for the same reason: each of these drifting is silent -- a renamed
// module means every export quietly takes the slow Skia path forever, because
// the fallback is the correct response to "not available"). The `kt_*`, `io_*`
// and `pl_*` mutants edit the real source in memory.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import * as real from './encoder.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'native_when_missing') {
  F.pickEncoder = (o) => (o.wideGamut || !['png', 'jpeg'].includes(o.format) ? 'skia' : 'native');
} else if (BREAK === 'native_when_wide') {
  F.pickEncoder = (o) => (!o.available || !['png', 'jpeg'].includes(o.format) ? 'skia' : 'native');
} else if (BREAK === 'native_any_format') {
  F.pickEncoder = (o) => (!o.available || o.wideGamut ? 'skia' : 'native');
} else if (BREAK === 'never_native') {
  F.pickEncoder = () => 'skia';
} else if (BREAK === 'force_ignored') {
  F.pickEncoder = (o) => real.pickEncoder({ ...o, force: undefined });
} else if (BREAK === 'reason_wide_first') {
  F.skiaReason = (o) => (o.wideGamut ? 'wide-gamut' : real.skiaReason(o));
} else if (BREAK === 'reason_none_when_unavailable') {
  F.skiaReason = (o) => (o.available ? real.skiaReason(o) : o.wideGamut ? 'wide-gamut' : 'format');
} else if (BREAK === 'png_no_signature') {
  F.pngInfo = (b) => real.pngInfo(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...b.slice(8)]));
} else if (BREAK === 'png_ok_on_garbage') {
  F.pngInfo = (b) => ({ ...real.pngInfo(b), ok: true });
} else if (BREAK === 'png_iccp_always') {
  F.pngInfo = (b) => ({ ...real.pngInfo(b), iccp: true });
} else if (BREAK === 'png_iccp_never') {
  F.pngInfo = (b) => ({ ...real.pngInfo(b), iccp: false });
} else if (BREAK === 'png_srgb_never') {
  F.pngInfo = (b) => ({ ...real.pngInfo(b), srgb: false });
} else if (BREAK === 'png_swapped_dims') {
  F.pngInfo = (b) => { const i = real.pngInfo(b); return { ...i, width: i.height, height: i.width }; };
} else if (BREAK === 'png_no_chunks') {
  F.pngInfo = (b) => ({ ...real.pngInfo(b), chunks: [] });
} else if (BREAK === 'diff_ignores_length') {
  F.firstDifference = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i; return -1; };
} else if (BREAK === 'diff_skips_first') {
  F.firstDifference = (a, b) => { for (let i = 1; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i; return a.length === b.length ? -1 : Math.min(a.length, b.length); };
} else if (BREAK === 'diff_always_same') {
  F.firstDifference = () => -1;
} else if (BREAK === 'bands_always_whole') {
  F.parityBands = (w, h) => (w > 0 && h > 0 ? [{ x: 0, y: 0, w, h }] : []);
} else if (BREAK === 'bands_no_bottom') {
  F.parityBands = (w, h) => real.parityBands(w, h).slice(0, 2);
} else if (BREAK === 'bands_overrun') {
  F.parityBands = (w, h) => real.parityBands(w, h).map((r) => ({ ...r, h: r.h + 1 }));
}

let ran = 0;
let fails = 0;
function check(name, ok) {
  ran += 1;
  if (!ok) { fails += 1; console.log(`FAIL  ${name}`); } else console.log(`ok    ${name}`);
}

// --- which encoder ---------------------------------------------------------
const base = { available: true, wideGamut: false, format: 'png' };
check('an sRGB png with the module goes native', F.pickEncoder(base) === 'native');
check('an sRGB jpeg with the module goes native', F.pickEncoder({ ...base, format: 'jpeg' }) === 'native');
check('no module means Skia', F.pickEncoder({ ...base, available: false }) === 'skia');
check('a wide-gamut card stays on Skia', F.pickEncoder({ ...base, wideGamut: true }) === 'skia');
check('a format the native side does not know stays on Skia', F.pickEncoder({ ...base, format: 'webp' }) === 'skia');
check('no format at all stays on Skia', F.pickEncoder({ ...base, format: undefined }) === 'skia');
check('force skia wins over everything', F.pickEncoder({ ...base, force: 'skia' }) === 'skia');
check('force auto changes nothing', F.pickEncoder({ ...base, force: 'auto' }) === 'native');
check('no arguments is Skia', F.pickEncoder() === 'skia');

check('the reason is null when native may run', F.skiaReason(base) === null);
check('unavailable is named', F.skiaReason({ ...base, available: false }) === 'unavailable');
check('wide gamut is named', F.skiaReason({ ...base, wideGamut: true }) === 'wide-gamut');
check('an unknown format is named', F.skiaReason({ ...base, format: 'gif' }) === 'format');
check('a forced skia is named', F.skiaReason({ ...base, force: 'skia' }) === 'forced');
check('a missing module outranks a wide gamut in the reason', F.skiaReason({ ...base, available: false, wideGamut: true }) === 'unavailable');

// --- reading a PNG ---------------------------------------------------------
const crcless = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  return out; // the CRC is not read, so it is left zero
};
const ihdr = (w, h, colorType) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = 8; d[9] = colorType;
  return crcless('IHDR', d);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (...chunks) => new Uint8Array(Buffer.concat([SIG, ...chunks]));
const idat = crcless('IDAT', deflateSync(Buffer.alloc(8)));
const iend = crcless('IEND', Buffer.alloc(0));

const plain = F.pngInfo(png(ihdr(1080, 2400, 6), idat, iend));
check('a plain png is ok', plain.ok === true);
check('its size is read big-endian, width first', plain.width === 1080 && plain.height === 2400);
check('its colour type is read', plain.colorType === 6);
check('with no profile chunk', plain.iccp === false && plain.srgb === false);
check('its chunks are listed in order', plain.chunks.join(',') === 'IHDR,IDAT,IEND');

const tagged = F.pngInfo(png(ihdr(9, 5, 2), crcless('sRGB', Buffer.from([0])), crcless('iCCP', Buffer.from('Skia\0\0xx')), idat, iend));
check('an iCCP chunk is seen', tagged.iccp === true);
check('an sRGB chunk is seen', tagged.srgb === true);
check('they are independent: sRGB without iCCP', F.pngInfo(png(ihdr(1, 1, 2), crcless('sRGB', Buffer.from([0])), idat, iend)).iccp === false);
check('and iCCP without sRGB', F.pngInfo(png(ihdr(1, 1, 2), crcless('iCCP', Buffer.from('x')), idat, iend)).srgb === false);
check('a size past 2^31 is not read as negative', F.pngInfo(png(ihdr(3000000000, 1, 6), iend)).width === 3000000000);

const big = new Uint8Array(png(ihdr(10, 10, 6), idat, iend));
const cut = F.pngInfo(big.slice(0, 8 + 20));
check('a file cut inside its first chunk is not ok', cut.ok === false);
const cutLater = F.pngInfo(big.slice(0, 8 + 25 + 14));
check('a file cut after the header keeps the header', cutLater.ok === true && cutLater.width === 10);
check('and lists only the chunks that were whole', cutLater.chunks.join(',') === 'IHDR');
check('the empty buffer is not ok', F.pngInfo(new Uint8Array(0)).ok === false);
check('null is not ok and does not throw', F.pngInfo(null).ok === false);
check('a JPEG is not a PNG', F.pngInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])).ok === false);
check('garbage after a good signature is not ok', F.pngInfo(Uint8Array.from([...SIG, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).ok === false);
check('a chunk claiming more than the buffer holds ends the walk', F.pngInfo(Uint8Array.from([...SIG, 0x7f, 0xff, 0xff, 0xff, 0x49, 0x48, 0x44, 0x52])).ok === false);
check('a header that is not first is not ok', F.pngInfo(png(idat, ihdr(2, 2, 6), iend)).ok === false);
check('a header of the wrong length is not ok', F.pngInfo(png(crcless('IHDR', Buffer.alloc(5)), iend)).ok === false);
check('a Buffer works as well as a Uint8Array', F.pngInfo(Buffer.concat([SIG, ihdr(4, 4, 6), iend])).width === 4);

// --- comparing two reads ---------------------------------------------------
check('equal buffers have no difference', F.firstDifference(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])) === -1);
check('the first differing index is returned', F.firstDifference(new Uint8Array([1, 2, 3]), new Uint8Array([1, 9, 3])) === 1);
check('a difference at index 0 is found', F.firstDifference(new Uint8Array([5, 2]), new Uint8Array([6, 2])) === 0);
check('a shorter buffer differs at its end', F.firstDifference(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])) === 2);
check('two empty buffers are the same', F.firstDifference(new Uint8Array(0), new Uint8Array(0)) === -1);

// --- which rects a parity check reads ---------------------------------------
const small = F.parityBands(1080, 1500);
check('a small card is read whole', small.length === 1 && small[0].w === 1080 && small[0].h === 1500);
const long = F.parityBands(1440, 9000);
check('a long card is read in three bands', long.length === 3);
check('the first band is the top and the last is the bottom', long[0].y === 0 && long[2].y + long[2].h === 9000);
check('the middle band is between them', long[1].y > long[0].y + long[0].h - 1 && long[1].y + long[1].h < 9000);
check('each band is about a megapixel', long.every((r) => r.w * r.h <= 1e6 && r.w * r.h > 0.9e6));
check('every band is inside the card', long.every((r) => r.x === 0 && r.w === 1440 && r.y >= 0 && r.y + r.h <= 9000));
check('a card of 2 MP exactly is still read whole', F.parityBands(1000, 2000).length === 1);
check('a width past a megapixel still reads whole rows inside the card', F.parityBands(3000000, 1).every((r) => r.h === 1 && r.y === 0) && F.parityBands(1500000, 4).every((r) => r.h >= 1 && r.y + r.h <= 4));
check('an empty card has no bands', F.parityBands(0, 10).length === 0);

// --- the contract with the Kotlin and the pipeline --------------------------
const here = dirname(fileURLToPath(import.meta.url));
let kt = readFileSync(join(here, '../modules/twitwa-pixels/android/src/main/java/dev/bismark/twitwa/pixels/PixelsModule.kt'), 'utf8');
let io = readFileSync(join(here, 'pixels-io.js'), 'utf8');
let pl = readFileSync(join(here, 'pipeline.js'), 'utf8');
const cfg = readFileSync(join(here, '../modules/twitwa-pixels/expo-module.config.json'), 'utf8');
const gradle = readFileSync(join(here, '../modules/twitwa-pixels/android/build.gradle'), 'utf8');
if (BREAK === 'kt_module_renamed') kt = kt.replace('Name("TwitwaPixels")', 'Name("Pixels")');
if (BREAK === 'kt_function_renamed') kt = kt.replace('AsyncFunction("encode")', 'AsyncFunction("compress")');
if (BREAK === 'kt_ms_key_renamed') kt = kt.replace('"ms" to', '"millis" to');
if (BREAK === 'kt_bytes_key_renamed') kt = kt.replace('"bytes" to', '"size" to');
if (BREAK === 'kt_not_on_io') kt = kt.replace('withContext(Dispatchers.IO)', 'withContext(Dispatchers.Main)');
if (BREAK === 'kt_no_coroutine') kt = kt.replace('AsyncFunction("encode") Coroutine {', 'AsyncFunction("encode") {');
if (BREAK === 'kt_no_rename') kt = kt.replace('part.renameTo(target)', 'part.exists()');
if (BREAK === 'kt_no_cache_check') kt = kt.replace('canonical.path.startsWith(cache.path + File.separator)', 'true');
if (BREAK === 'kt_no_length_check') kt = kt.replace('declaredBytes != expected.toDouble()', 'false');
if (BREAK === 'kt_no_recycle') kt = kt.replace('bitmap?.recycle()', '');
if (BREAK === 'kt_no_format_check') kt = kt.replace('else -> throw fail("bad-format"', 'else -> Bitmap.CompressFormat.PNG; /* */ throw fail("bad-format"');
if (BREAK === 'kt_reads_byte_length') kt = kt.replace('pixels.read(raw,', 'pixels.byteLength; pixels.read(raw,');
if (BREAK === 'kt_swallows_throwable') kt = kt.replace('catch (e: Throwable)', 'catch (e: Exception)');
if (BREAK === 'kt_args_dropped') kt = kt.replace('quality: Int, path: String, declaredBytes: Double ->', 'quality: Int, path: String ->');
if (BREAK === 'io_module_renamed') io = io.replace("requireOptionalNativeModule('TwitwaPixels')", "requireOptionalNativeModule('Pixels')");
if (BREAK === 'io_function_renamed') io = io.replace('Native.encode(', 'Native.compress(');
if (BREAK === 'io_no_byte_length') io = io.replace(', pixels.byteLength)', ')');
if (BREAK === 'io_always_available') io = io.replace('Native != null', 'true');
if (BREAK === 'pl_no_fallback') pl = pl.replace("fallback = `native-rejected:", "throw (e); fallback = `native-rejected:");
if (BREAK === 'pl_bytes_from_png') pl = pl.replace('bytes: encoded.bytes,', 'bytes: 0,');
if (BREAK === 'pl_wide_gamut_dropped') pl = pl.replace('const wideGamut = Boolean(colorSpace);', 'const wideGamut = false;');
if (BREAK === 'pl_force_dropped') pl = pl.replace("force: encoder === 'skia' ? 'skia' : undefined,", 'force: undefined,');
if (BREAK === 'pl_no_readback_check') pl = pl.replace("if (!read || read.width !== plan.width || read.height !== plan.height) {", 'if (false) {');
if (BREAK === 'pl_path_not_file') pl = pl.replace('path: file.uri,', 'path: outputName,');

const has = (text, re) => re.test(text);
// Comments name the unsafe members to explain why they are avoided.
const ktCode = kt.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
check('the Kotlin module is named what JS asks for', has(kt, /Name\("TwitwaPixels"\)/) && has(io, /requireOptionalNativeModule\('TwitwaPixels'\)/));
check('the function JS calls is the one declared', has(kt, /AsyncFunction\("encode"\)/) && has(io, /Native\.encode\(/));
check('the answer carries bytes and ms, which the pipeline reads', has(kt, /"bytes" to/) && has(kt, /"ms" to/) && has(pl, /out\.bytes/) && has(pl, /out\.ms/));
check('it is a Coroutine on Dispatchers.IO, not a body on the module queue', has(kt, /AsyncFunction\("encode"\) Coroutine/) && has(kt, /withContext\(Dispatchers\.IO\)/));
check('JS passes the byte length it read itself, and Kotlin checks it', has(io, /pixels\.byteLength\)/) && has(kt, /declaredBytes != expected/));
check('the Kotlin takes the seven arguments JS sends', has(kt, /pixels: Uint8Array, width: Int, height: Int, format: String,\s*quality: Int, path: String, declaredBytes: Double/));
check('the file goes into place by rename, so no half file is ever visible', has(kt, /part\.renameTo\(target\)/));
check('a path outside the cache is refused', has(kt, /canonical\.path\.startsWith\(cache\.path \+ File\.separator\)/));
check('the bitmap is always recycled', has(kt, /finally \{[^}]*bitmap\?\.recycle\(\)/));
check('an OutOfMemoryError is a rejection, not a crash', has(kt, /catch \(e: Throwable\)/));
check('the typed array is only ever read(), never asked its length or kind', !has(ktCode, /pixels\.(length|byteLength|byteOffset|kind|toDirectBuffer)/));
check('a format other than png and jpeg is refused', has(kt, /"png" -> Bitmap\.CompressFormat\.PNG/) && has(kt, /"jpeg" -> Bitmap\.CompressFormat\.JPEG/) && has(kt, /else -> throw fail\("bad-format"/));
check('the module is registered for autolinking', JSON.parse(cfg).android.modules.includes('dev.bismark.twitwa.pixels.PixelsModule'));
check('the gradle namespace matches the package', has(gradle, /namespace "dev\.bismark\.twitwa\.pixels"/) && has(kt, /^package dev\.bismark\.twitwa\.pixels$/m));
check('the module is optional on the JS side', has(io, /Native != null/) && has(io, /if \(!Native\) throw/));
check('a rejection falls back to Skia instead of failing the export', has(pl, /catch \(e\) \{(?:\s*\/\/[^\n]*)*\s*fallback = `native-rejected:/));
check('a null or wrong-size readback falls back', has(pl, /read\.width !== plan\.width/) && has(pl, /'readback-null'/));
check('the file size reported is the one the encoder wrote', has(pl, /bytes: encoded\.bytes,/));
check('a requested colour space is what keeps a card on Skia', has(pl, /const wideGamut = Boolean\(colorSpace\)/));
check('the native path writes to the card file itself', has(pl, /quality: spec\.quality,\s*path: file\.uri,/));
check('an explicit Skia request is honoured', has(pl, /force: encoder === 'skia' \? 'skia' : undefined/));

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
