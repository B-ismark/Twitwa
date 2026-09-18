// Tests for tools/chunks.mjs — the PNG chunk reader whose output is the evidence
// for closing Q4.
//
//   for b in sbit_is_colour trunc_iccp_ok no_primaries name_identifies loose_tol \
//            icc_trunc_ok icc_short_ok icc_sig_any icc_size_ok icc_bounds_ok; do
//     BREAK=$b node tools/chunks.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// The first two exist because a review found both: the tool reported `tagged`
// for a file whose only colour chunk was `sBIT` (which describes significant
// bits, not a colour space) and for a truncated `iCCP` carrying no profile at
// all. Both are constructed here rather than described, because a verdict that
// over-reports is worse than no verdict — it would have been used to close a
// question it cannot answer.
import { deflateSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';

import * as real from './chunks.mjs';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'sbit_is_colour') {
  // The original bug: sBIT counted as a colour chunk.
  F.colourVerdict = (chunks) => {
    const r = real.colourVerdict(chunks);
    if (chunks.some((c) => c.type === 'sBIT')) {
      return { ...r, sound: [...r.sound, 'sBIT'], present: [...r.present, 'sBIT'], tagged: true };
    }
    return r;
  };
} else if (BREAK === 'trunc_iccp_ok') {
  // The other original bug: presence treated as validity.
  F.colourVerdict = (chunks) => {
    const present = ['cICP', 'iCCP', 'sRGB', 'cHRM', 'gAMA'].filter((t) => chunks.some((c) => c.type === t));
    return { present, invalid: [], sound: present, tagged: present.length > 0 };
  };
} else if (BREAK === 'no_primaries') {
  // Stop reading the colorant tags, so an embedded profile is unidentifiable.
  F.iccHeader = (p) => {
    const r = real.iccHeader(p);
    return { ...r, red: undefined, green: undefined, blue: undefined };
  };
  F.listChunks = (buf) => real.listChunks(buf).map((c) => (c.type === 'iCCP' && c.profile
    ? { ...c, ...F.iccHeader(c.profile) } : c));
} else if (BREAK === 'name_identifies') {
  // Identify the space by the profile's NAME, which is what a reader is tempted
  // to do and which cannot work: Skia names both its profiles "Skia".
  F.identifySpace = (icc) => (icc && icc.profileName === 'Skia' ? 'sRGB' : real.identifySpace(icc));
} else if (BREAK === 'loose_tol') {
  // A tolerance wide enough to call sRGB and P3 the same space.
  F.identifySpace = (icc) => real.identifySpace(icc, 0.1);
}

// The five below each drop ONE failure flag on its way to the verdict, which is
// the failure mode `colourProblem` was extracted to prevent: the verdict tested
// `invalid` while the parser could set four flags, so three malformed shapes
// reported `tagged`. Dropping them one at a time is the point — a single
// mutation covering all four would still pass if only one flag were wired up.
const strip = (pred) => (buf) => real.listChunks(buf).map((c) => {
  const d = { ...c };
  pred(d);
  return d;
});
if (BREAK === 'icc_trunc_ok') {
  F.listChunks = strip((d) => { delete d.truncated; });
} else if (BREAK === 'icc_short_ok') {
  F.listChunks = strip((d) => { if (/too short/.test(d.iccInvalid || '')) delete d.iccInvalid; });
} else if (BREAK === 'icc_sig_any') {
  F.listChunks = strip((d) => { if (/signature/.test(d.iccInvalid || '')) delete d.iccInvalid; });
} else if (BREAK === 'icc_bounds_ok') {
  F.listChunks = strip((d) => { if (/colorant/.test(d.iccInvalid || '')) delete d.iccInvalid; });
} else if (BREAK === 'icc_size_ok') {
  F.listChunks = strip((d) => { delete d.iccSizeMismatch; });
}

let ran = 0;
let fails = 0;
function check(label, ok, detail) {
  ran++;
  if (!ok) {
    fails++;
    console.log(`  FAIL  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  } else {
    console.log(`  pass  ${label}`);
  }
}

// --- PNG construction, so the probes are files and not descriptions ----------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const o = Buffer.alloc(12 + data.length);
  o.writeUInt32BE(data.length, 0);
  o.write(type, 4, 'ascii');
  data.copy(o, 8);
  o.writeUInt32BE(CRC(o.subarray(4, 8 + data.length)), 8 + data.length);
  return o;
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(extra) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(4, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = chunk('IDAT', deflateSync(Buffer.alloc((4 * 3 + 1) * 4)));
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...extra, idat, chunk('IEND', Buffer.alloc(0))]);
}

console.log('a file with no colour chunk is UNTAGGED');
{
  const v = F.colourVerdict(F.listChunks(png([])));
  check('not tagged', v.tagged === false, JSON.stringify(v));
  check('nothing reported present', v.present.length === 0);
}

console.log('sBIT alone is NOT a colour space');
{
  // sBIT says how many bits per channel are significant. A viewer reading this
  // file has no colour information and will assume sRGB.
  const v = F.colourVerdict(F.listChunks(png([chunk('sBIT', Buffer.from([8, 8, 8]))])));
  check('sBIT does not make a file tagged', v.tagged === false, JSON.stringify(v));
}

console.log('a truncated iCCP is reported broken, not tagged');
{
  // Name, NUL, compression method — and then the chunk ends. No profile.
  const trunc = chunk('iCCP', Buffer.concat([Buffer.from('Skia', 'latin1'), Buffer.from([0, 0])]));
  const chunks = F.listChunks(png([trunc]));
  const icc = chunks.find((c) => c.type === 'iCCP');
  check('the chunk is flagged invalid', !!icc.invalid, JSON.stringify(icc));
  const v = F.colourVerdict(chunks);
  check('and the file is not tagged', v.tagged === false, JSON.stringify(v));
  check('the reason is reported', v.invalid.length === 1, JSON.stringify(v.invalid));
  // Without this the case above would also pass if nothing were present at all.
  check('while the chunk IS present', v.present.includes('iCCP'), JSON.stringify(v.present));
}

console.log('an sRGB chunk is a colour tag');
{
  const v = F.colourVerdict(F.listChunks(png([chunk('sRGB', Buffer.from([0]))])));
  check('tagged', v.tagged === true, JSON.stringify(v));
  check('by sRGB', v.sound.includes('sRGB'));
}

// fixtures/screenshots/ is gitignored: the captures are screenshots of real
// posts by identifiable people and are deliberately not published. So these two
// blocks CANNOT run in a clone, and until a review pointed it out this file
// died there on an unhandled ENOENT -- taking down 44 checks that need no
// fixture at all, including the only test of the Q4 Display-P3 answer.
//
// Skipped and counted now, never silently. tools/make-fixture.mjs is NOT a
// substitute: it writes IHDR/IDAT/IEND only, so it cannot produce the embedded
// ICC profile these blocks inspect.
const REAL_CAPTURE = 'fixtures/screenshots/ig-handwriting-dark.png';
const HAVE_CAPTURE = existsSync(REAL_CAPTURE);
let skipped = 0;
function skipBlock(names, why) {
  for (const nm of names) { skipped++; console.log(`  SKIP  ${nm}  -> ${why}`); }
}

console.log('a real capture: the profile is identified by its primaries, not its name');
if (!HAVE_CAPTURE) {
  skipBlock([
    'the profile inflates', 'its name is "Skia"', 'the colorants were read',
    'and it is Display P3', 'the name does not carry the answer',
  ], `${REAL_CAPTURE} is not published`);
} else {
  const chunks = F.listChunks(readFileSync(REAL_CAPTURE));
  const icc = chunks.find((c) => c.type === 'iCCP');
  check('the profile inflates', !!icc.profile && icc.profile.length > 128, icc.profile && icc.profile.length);
  check('its name is "Skia"', icc.profileName === 'Skia', icc.profileName);
  check('the colorants were read', !!icc.red, JSON.stringify(icc.red));
  check('and it is Display P3', F.identifySpace(icc) === 'displayP3', F.identifySpace(icc));
  // The discriminating assertion: the NAME is common to both spaces Skia writes,
  // so anything identifying by name cannot be right even when it agrees here.
  check('the name does not carry the answer',
    icc.profileName === 'Skia' && F.identifySpace(icc) !== 'sRGB', F.identifySpace(icc));
}

console.log('the two spaces are told apart, and unknown primaries are not guessed at');
{
  const P3 = real.REFERENCE_PRIMARIES.displayP3;
  const S = real.REFERENCE_PRIMARIES.sRGB;
  check('sRGB primaries identify as sRGB', F.identifySpace({ ...S }) === 'sRGB');
  check('P3 primaries identify as P3', F.identifySpace({ ...P3 }) === 'displayP3');
  // The pair must not be within tolerance of each other, or the test above is
  // passing for the wrong reason.
  const gap = Math.max(...['red', 'green', 'blue'].map((k) =>
    Math.max(...S[k].map((v, i) => Math.abs(v - P3[k][i])))));
  check('and the two are genuinely far apart', gap > 0.05, gap.toFixed(4));
  check('something else is unrecognised, not assigned',
    F.identifySpace({ red: [0.1, 0.2, 0.3], green: [0.1, 0.2, 0.3], blue: [0.1, 0.2, 0.3] }) === 'unrecognised');
  check('no colorants means no answer at all', F.identifySpace({}) === null);
}

// --- ICC construction, so a malformed profile is a file and not a description -
//
// The existing truncated-iCCP case builds a COMPLETE chunk with an empty
// payload. That is one shape. The shapes below are the ones that used to slip
// past the verdict, and not one of them is reachable by shortening a payload.
function iccProfile({ signature = 'acsp', size, tags = {}, length = 300 } = {}) {
  const p = Buffer.alloc(length);
  p.write('mntr', 12, 'ascii');
  p.write('RGB ', 16, 'ascii');
  p.write('XYZ ', 20, 'ascii');
  p.write(signature, 36, 'ascii');
  const names = Object.keys(tags);
  p.writeUInt32BE(names.length, 128);
  names.forEach((t, i) => {
    const at = 132 + i * 12;
    p.write(t, at, 'ascii');
    p.writeUInt32BE(tags[t].off, at + 4);
    p.writeUInt32BE(tags[t].size, at + 8);
  });
  p.writeUInt32BE(size === undefined ? length : size, 0);
  return p;
}

// A conforming profile carrying real primaries. This is the positive control:
// without it every assertion below would also pass if the stricter checks
// rejected everything, the card this project writes included.
function profileWithPrimaries(prim) {
  const tags = { rXYZ: { off: 200, size: 20 }, gXYZ: { off: 224, size: 20 }, bXYZ: { off: 248, size: 20 } };
  const p = iccProfile({ tags });
  for (const [tag, key] of [['rXYZ', 'red'], ['gXYZ', 'green'], ['bXYZ', 'blue']]) {
    prim[key].forEach((v, k) => p.writeInt32BE(Math.round(v * 65536), tags[tag].off + 8 + k * 4));
  }
  return p;
}

const iccp = (profile, name = 'Skia') =>
  chunk('iCCP', Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from([0, 0]), deflateSync(profile)]));

// A chunk header claiming more bytes than the file holds. `chunk()` cannot build
// this, because it derives the length from the data it is handed — which is why
// the physically truncated case went uncovered while the tests claimed it.
function overlongHeader(type, declared) {
  const o = Buffer.alloc(8);
  o.writeUInt32BE(declared, 0);
  o.write(type, 4, 'ascii');
  return o;
}

console.log('malformed ICC data is reported broken, never as a colour tag');
{
  const cases = [
    ['a chunk declaring bytes the file does not contain',
      overlongHeader('iCCP', 1000000), /not present in the file/],
    ['a payload that inflates to 18 bytes',
      iccp(Buffer.alloc(18)), /too short/],
    ['a 300-byte payload that is not a profile at all',
      iccp(iccProfile({ signature: 'junk' })), /signature/],
    ['a header that lies about its own length',
      iccp(iccProfile({ size: 999 })), /header says 999/],
    ['a colorant tag pointing outside the profile',
      iccp(iccProfile({ tags: { rXYZ: { off: 9000, size: 20 } } })), /colorant/],
  ];
  for (const [label, extra, reason] of cases) {
    const chunks = F.listChunks(png([extra]));
    const v = F.colourVerdict(chunks);
    check(`${label}: not tagged`, v.tagged === false, JSON.stringify(v));
    check(`${label}: iCCP still reported present`, v.present.includes('iCCP'), JSON.stringify(v.present));
    check(`${label}: exactly one reason given`, v.invalid.length === 1, JSON.stringify(v.invalid));
    check(`${label}: and the reason names the failure`,
      reason.test(v.invalid[0] || ''), JSON.stringify(v.invalid[0]));
    check(`${label}: nothing is sound`, v.sound.length === 0, JSON.stringify(v.sound));
  }
}

console.log('a conforming hand-built profile IS accepted, so the above is not blanket rejection');
{
  const chunks = F.listChunks(png([iccp(profileWithPrimaries(real.REFERENCE_PRIMARIES.displayP3))]));
  const v = F.colourVerdict(chunks);
  const icc = chunks.find((c) => c.type === 'iCCP');
  check('tagged', v.tagged === true, JSON.stringify(v));
  check('no reasons reported', v.invalid.length === 0, JSON.stringify(v.invalid));
  check('the signature was read as acsp', icc.iccSignature === 'acsp', icc.iccSignature);
  check('and its primaries identify it', F.identifySpace(icc) === 'displayP3', F.identifySpace(icc));
  // The same builder with the other space's numbers, so the line above is
  // reading primaries rather than accepting anything hand-built as P3.
  const s2 = F.listChunks(png([iccp(profileWithPrimaries(real.REFERENCE_PRIMARIES.sRGB))]));
  check('the same builder with sRGB primaries identifies as sRGB',
    F.identifySpace(s2.find((c) => c.type === 'iCCP')) === 'sRGB');
}

console.log('the real capture still passes the stricter checks');
if (!HAVE_CAPTURE) {
  skipBlock([
    'Skia writes a conforming signature', 'and no problem is found with it',
  ], `${REAL_CAPTURE} is not published`);
} else {
  const icc = F.listChunks(readFileSync(REAL_CAPTURE))
    .find((c) => c.type === 'iCCP');
  check('Skia writes a conforming signature', icc.iccSignature === 'acsp', icc.iccSignature);
  check('and no problem is found with it', real.colourProblem(icc) === null, real.colourProblem(icc));
}

const tail = skipped ? `, ${skipped} SKIPPED (the real captures are not published)` : '';
console.log(`\n${ran - fails}/${ran} checks passed${tail}${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
