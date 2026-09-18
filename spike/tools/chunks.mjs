// List a PNG's chunks, and say what it claims about colour.
//
//   node tools/chunks.mjs card.png [more.png ...]
//
// Q4 measured the encode/decode round trip as lossless — maxDelta 0 over 120,000
// samples, sRGB and Display P3 alike. That proves no gamut mapping happened. It
// says nothing about whether the P3 TAG survives into the file, and a file whose
// pixels are P3 but which carries no colour chunk is displayed as sRGB: a silent
// shift, and exactly the failure the question was asked about.
//
// Only the bytes can answer it, which is why this could not be settled from the
// spike — the spike never wrote a file. src/pipeline.js does.
//
// Deliberately not a decoder. It walks the chunk table and reports; it does not
// inflate IDAT, so it costs nothing on a 20000px card and cannot fail on a
// colour type png.mjs does not support.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The chunks that decide how a viewer interprets the pixels. Order matters to a
// reader: iCCP wins over sRGB, which wins over cHRM+gAMA.
//
// sBIT is NOT in this list, and was, which made the verdict wrong: it declares
// how many bits per channel are significant, nothing about a colour space. A
// file carrying only sBIT was reported as "tagged" when a viewer will read it as
// sRGB — the precise failure the verdict exists to detect.
const COLOUR = ['cICP', 'iCCP', 'sRGB', 'cHRM', 'gAMA'];

const RENDERING_INTENT = ['Perceptual', 'Relative colorimetric', 'Saturation', 'Absolute colorimetric'];

export function listChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error('not a PNG: signature mismatch');
  }
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataAt = off + 8;
    if (dataAt + len + 4 > buf.length) {
      chunks.push({ type, length: len, truncated: true });
      break;
    }
    const c = { type, length: len, at: off };
    if (type === 'IHDR') {
      c.width = buf.readUInt32BE(dataAt);
      c.height = buf.readUInt32BE(dataAt + 4);
      c.depth = buf[dataAt + 8];
      c.colorType = buf[dataAt + 9];
      c.interlace = buf[dataAt + 12];
    }
    if (type === 'sRGB') c.intent = RENDERING_INTENT[buf[dataAt]] || `unknown (${buf[dataAt]})`;
    if (type === 'iCCP') {
      // Presence is not validity. An iCCP is name, NUL, compression method, then
      // the deflated profile; a truncated one has a name and no profile, and
      // counting that as a colour tag is how this reported "tagged" for a file
      // that carries no profile at all.
      const end = dataAt + len;
      const nul = buf.indexOf(0, dataAt);
      if (nul < 0 || nul >= end) {
        c.invalid = 'no NUL terminator: the profile name does not end inside the chunk';
      } else {
        c.profileName = buf.toString('latin1', dataAt, nul);
        c.compression = buf[nul + 1];
        const payload = buf.subarray(nul + 2, end);
        if (payload.length === 0) {
          c.invalid = 'the chunk ends after the profile name: no profile data';
        } else if (c.compression !== 0) {
          c.invalid = `unknown compression method ${c.compression}`;
        } else {
          try {
            c.profile = inflateSync(payload);
            Object.assign(c, iccHeader(c.profile));
          } catch (e) {
            c.invalid = `the profile does not inflate: ${e.message}`;
          }
        }
      }
    }
    if (type === 'gAMA') c.gamma = buf.readUInt32BE(dataAt) / 100000;
    chunks.push(c);
    off = dataAt + len + 4; // data + CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

/**
 * Read the fields of an ICC profile that identify a colour space.
 *
 * A profile's NAME does not identify it. Skia names both its sRGB and its
 * Display P3 profiles "Skia", so the name says which library wrote the file and
 * nothing about the space. The red/green/blue colorant tags do identify it: P3's
 * primaries differ from sRGB's, and that is a number, not a label.
 */
export function iccHeader(p) {
  if (p.length < 132) return { iccInvalid: `profile is ${p.length} bytes, too short for a header` };
  const out = {
    iccSize: p.readUInt32BE(0),
    iccClass: p.toString('ascii', 12, 16).trim(),
    iccSpace: p.toString('ascii', 16, 20).trim(),
    iccPCS: p.toString('ascii', 20, 24).trim(),
    iccIntent: p.readUInt32BE(64),
  };
  if (out.iccSize !== p.length) out.iccSizeMismatch = `header says ${out.iccSize}, inflated to ${p.length}`;

  // Bytes 36..39 are the profile file signature and are always `acsp`. This is
  // the only field that says "these bytes are an ICC profile" rather than some
  // other 132 bytes that happened to inflate, so it is checked before anything
  // is read out of the header.
  //
  // Note for anyone reaching for `ICC_PROFILE`: that string is the APP2 marker
  // identifier JPEG uses to package a profile. It does not appear in the profile
  // itself, so it is not what a PNG's inflated iCCP payload starts with.
  out.iccSignature = p.toString('ascii', 36, 40);
  if (out.iccSignature !== 'acsp') {
    return { ...out, iccInvalid: `not an ICC profile: signature ${JSON.stringify(out.iccSignature)}, expected "acsp"` };
  }

  // Tag table: count, then 12 bytes per tag (signature, offset, size).
  const count = p.readUInt32BE(128);
  if (128 + 4 + count * 12 > p.length) return { ...out, iccInvalid: `tag count ${count} does not fit` };
  const tags = {};
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12;
    tags[p.toString('ascii', at, at + 4)] = { off: p.readUInt32BE(at + 4), size: p.readUInt32BE(at + 8) };
  }
  out.iccTags = Object.keys(tags);
  // XYZ colorants, as s15Fixed16. These are the identification.
  //
  // A tag that is ABSENT and a tag that points outside the profile are different
  // failures, and skipping both silently is how a profile with a corrupt tag
  // table read as merely unidentifiable. Absent stays quiet; out-of-bounds is a
  // malformed profile and says so.
  const outOfBounds = [];
  for (const [tag, name] of [['rXYZ', 'red'], ['gXYZ', 'green'], ['bXYZ', 'blue']]) {
    const t = tags[tag];
    if (!t) continue;
    if (t.size < 20 || t.off + 20 > p.length) {
      outOfBounds.push(`${tag} at ${t.off}+${t.size}`);
      continue;
    }
    out[name] = [0, 1, 2].map((k) => +(p.readInt32BE(t.off + 8 + k * 4) / 65536).toFixed(4));
  }
  if (outOfBounds.length) {
    out.iccInvalid = `colorant tags fall outside the ${p.length}-byte profile: ${outOfBounds.join(', ')}`;
  }
  return out;
}

// ICC D50-adapted red/green/blue colorants for the two spaces this project can
// produce. These are the published values, and they are the only thing that
// distinguishes the two files Skia writes: it names both profiles "Skia".
export const REFERENCE_PRIMARIES = {
  sRGB: { red: [0.436, 0.2225, 0.0139], green: [0.3851, 0.7169, 0.0971], blue: [0.1431, 0.0606, 0.7141] },
  displayP3: { red: [0.5151, 0.2412, -0.0011], green: [0.292, 0.6922, 0.0419], blue: [0.1571, 0.0666, 0.7841] },
};

/** Name the colour space by its primaries, or say it is unrecognised. */
export function identifySpace(icc, tol = 0.002) {
  if (!icc || !icc.red) return null;
  for (const [name, ref] of Object.entries(REFERENCE_PRIMARIES)) {
    if (['red', 'green', 'blue'].every((k) => icc[k] && icc[k].every((v, i) => Math.abs(v - ref[k][i]) <= tol))) {
      return name;
    }
  }
  return 'unrecognised';
}

/**
 * What the file says about colour.
 *
 * Three distinct states, because they were one and it hid two failures: a chunk
 * can be ABSENT, PRESENT BUT MALFORMED, or present and structurally sound. Only
 * the third is a colour tag, and even then "sound" is not "Display P3" — that
 * needs the primaries, which is what `iccHeader` reads.
 */
export function colourVerdict(chunks) {
  const present = COLOUR.filter((t) => chunks.some((c) => c.type === t));
  const problems = [];
  for (const c of chunks) {
    if (!COLOUR.includes(c.type)) continue;
    const why = colourProblem(c);
    if (why) problems.push({ type: c.type, why });
  }
  const sound = present.filter((t) => !problems.some((q) => q.type === t));
  return {
    present,
    invalid: problems.map((q) => `${q.type}: ${q.why}`),
    sound,
    tagged: sound.length > 0,
  };
}

/**
 * The single place a colour chunk is judged sound or not.
 *
 * It exists because the verdict used to test one flag, `invalid`, while the
 * parser could set four. A file whose iCCP was physically truncated, or whose
 * profile inflated to eighteen bytes, or whose header lied about its own length,
 * was reported `sound: ["iCCP"], tagged: true` — a gate that answers "fine" to
 * malformed input, which is worse than no gate because its green gets quoted.
 *
 * So: every failure flag `listChunks` and `iccHeader` can set is listed here,
 * and nothing else reads them. Adding a flag without adding it here is the bug
 * this function was extracted to make impossible, which is why the tests pin
 * each one separately rather than pinning the verdict once.
 */
export function colourProblem(c) {
  if (c.truncated) return `declares ${c.length} bytes that are not present in the file`;
  if (c.invalid) return c.invalid;
  if (c.iccInvalid) return c.iccInvalid;
  if (c.iccSizeMismatch) return c.iccSizeMismatch;
  return null;
}

// Only run the CLI when invoked directly. Without this the module exits(2) on
// import, so nothing could test it — and a tool making a claim about a file's
// colour needs tests more than most: its output is the evidence for closing Q4.
const DIRECT = import.meta.url === pathToFileURL(process.argv[1] || '').href;
const args = process.argv.slice(2);
if (DIRECT && !args.length) {
  console.log('Usage: node tools/chunks.mjs <file.png> [more.png ...]');
  process.exit(2);
}

let bad = 0;
for (const path of DIRECT ? args : []) {
  let chunks;
  try {
    chunks = listChunks(readFileSync(path));
  } catch (e) {
    console.log(`${path}\n  ERROR  ${e.message}`);
    bad++;
    continue;
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  const v = colourVerdict(chunks);
  const counts = new Map();
  for (const c of chunks) counts.set(c.type, (counts.get(c.type) || 0) + 1);
  console.log(path);
  console.log(
    `  IHDR    ${ihdr ? `${ihdr.width}x${ihdr.height}  depth ${ihdr.depth}  colorType ${ihdr.colorType}` +
      `${ihdr.interlace ? '  INTERLACED' : ''}` : 'missing'}`,
  );
  console.log(
    '  chunks  ' +
      [...counts].map(([t, n]) => (n > 1 ? `${t}x${n}` : t)).join(' '),
  );
  for (const c of chunks) {
    if (c.truncated) console.log(`  ${c.type.padEnd(7)} TRUNCATED: declares ${c.length} bytes that are not in the file`);
    if (c.type === 'sRGB') console.log(`  sRGB    intent: ${c.intent}`);
    if (c.type === 'iCCP') {
      console.log(
        `  iCCP    name "${c.profileName ?? '?'}", chunk ${c.length}B` +
          (c.profile ? `, profile ${c.profile.length}B` : '') +
          (c.invalid ? `  INVALID: ${c.invalid}` : '') +
          (c.iccInvalid ? `  INVALID: ${c.iccInvalid}` : ''),
      );
      if (c.iccSpace) {
        console.log(`          ICC ${c.iccClass} ${c.iccSpace}->${c.iccPCS} intent ${c.iccIntent}` +
          (c.iccSizeMismatch ? `  SIZE MISMATCH: ${c.iccSizeMismatch}` : ''));
      }
      // The name says who wrote it; the primaries say what it is.
      if (c.red) {
        console.log(`          primaries R ${c.red} G ${c.green} B ${c.blue}`);
        console.log(`          space by primaries: ${identifySpace(c)}`);
      }
    }
    if (c.type === 'gAMA') console.log(`  gAMA    ${c.gamma}`);
    if (c.type === 'cICP') console.log(`  cICP    ${c.length} bytes`);
  }
  for (const bad of v.invalid) console.log(`  BROKEN  ${bad}`);
  console.log(
    `  colour  ${
      v.tagged
        ? `tagged: ${v.sound.join(' ')}`
        : v.invalid.length
          ? 'UNTAGGED — the only colour chunk present is malformed, so a viewer will assume sRGB'
          : 'UNTAGGED — a viewer will assume sRGB'
    }`,
  );
  if (v.tagged && v.sound.includes('iCCP')) {
    const icc = chunks.find((c) => c.type === 'iCCP');
    if (!icc.red) {
      console.log('  note    an ICC profile is embedded but its primaries could not be read, so which space it describes is UNKNOWN');
    }
  }
}
if (DIRECT) process.exit(bad ? 1 : 0);
