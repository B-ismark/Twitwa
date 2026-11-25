// Keep the Fresco exclusion safe: nothing in our code may reach Fresco.
//
//   node tools/check-fresco.mjs
//
// WHY. plugins/withAndroidSize.js removes two of Fresco's native libraries
// from the APK: libstatic-webp.so (expo.webp.enabled=false) and
// libnative-imagetranscoder.so (a packaging exclude), 431,740 bytes on 1.0.6.
// Fresco is React Native's image pipeline. It is still linked and initialised,
// but it only runs those libraries when something asks it for an image: an
// <Image> or <ImageBackground> from react-native, Image.getSize/prefetch, an
// <Image> inside react-native-svg (its Android ImageView loads through Fresco),
// or a blurRadius (Fresco's native blur filter). A missing .so does not fail the
// build. It fails as an UnsatisfiedLinkError the first time someone's picture
// takes that path, on their phone.
//
// THE AUDIT this gate keeps true, done 2026-11-25: the app draws every picture
// through Skia and every icon as react-native-svg shapes (G, Line, Path, Rect).
// No react-native Image, no svg Image, no blurRadius, no bundled image asset
// rendered by React Native. Of the libraries in package.json, only
// react-native-svg imports Fresco natively, and only for its <Image> element.
// libimagepipeline and libnative-filters stay in: the first is loaded by
// Fresco's memory pools at start-up, and the second is too small to be worth a
// crash.
//
// If this goes red, either draw the picture through Skia, or remove the two
// exclusions from withAndroidSize.js and accept the ~430 KB.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Mutations for the self-test below. A gate with no way to go red is the thing
// this file exists to stop being.
const BREAK = process.env.BREAK || '';

/** Every file of ours that reaches the bundle. */
function sources() {
  const files = ['App.js', 'index.js'];
  for (const f of readdirSync('src')) {
    if (f.endsWith('.js')) files.push(join('src', f));
  }
  return files;
}

/** Names imported from `module` by `text`, as written before any `as`. */
function namedImports(text, module) {
  const out = [];
  const re = /import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    if (m[2] !== module) continue;
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) out.push(name);
    }
  }
  return out;
}

/** Namespace or default bindings for `module`: `import * as RN` / `import RN`. */
function wholeImports(text, module) {
  const out = [];
  const re = /import\s+(?:\*\s*as\s+)?([\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) if (m[2] === module) out.push(m[1]);
  return out;
}

const RN_IMAGES = ['Image', 'ImageBackground'];

/** What in `text` would send a picture through Fresco. Empty means clean. */
function frescoUses(text) {
  const found = [];
  for (const name of namedImports(text, 'react-native')) {
    if (RN_IMAGES.includes(name) && BREAK !== 'skip_rn_named') found.push(`${name} from react-native`);
  }
  for (const ns of wholeImports(text, 'react-native')) {
    for (const name of RN_IMAGES) {
      if (BREAK === 'skip_rn_namespace') continue;
      if (new RegExp(`\\b${ns}\\.${name}\\b`).test(text)) found.push(`${ns}.${name}`);
    }
  }
  if (BREAK !== 'skip_require' && /require\(\s*['"]react-native['"]\s*\)\s*\.\s*Image/.test(text)) {
    found.push('require(react-native).Image');
  }
  const destructured = /\{([^}]*)\}\s*=\s*require\(\s*['"]react-native['"]\s*\)/.exec(text);
  if (BREAK !== 'skip_require_destructure' && destructured &&
      destructured[1].split(',').some((p) => RN_IMAGES.includes(p.trim().split(':')[0].trim()))) {
    found.push('Image destructured from require(react-native)');
  }
  if (BREAK !== 'skip_svg') {
    for (const name of namedImports(text, 'react-native-svg')) {
      if (name === 'Image') found.push('Image from react-native-svg');
    }
  }
  if (BREAK !== 'skip_blur' && /\bblurRadius\b/.test(text)) found.push('blurRadius');
  return found;
}

// The detector is tested on every run, before the real scan, so a rule that
// stops matching goes red here rather than passing the real files by accident.
const SELF = [
  ["import { View, Image } from 'react-native';", true],
  ["import { Image as RNImage } from 'react-native';", true],
  ["import {\n  ImageBackground,\n  Text,\n} from 'react-native';", true],
  ["import * as RN from 'react-native';\nconst x = <RN.Image />;", true],
  ["const img = require('react-native').Image;", true],
  ["const { View, Image: Pic } = require('react-native');", true],
  ["import Svg, { G, Image } from 'react-native-svg';", true],
  ['<View blurRadius={4} />', true],
  // Clean: the app's own shapes, Skia's Image, and names that merely contain "Image".
  ["import Svg, { G, Line, Path, Rect as SvgRect } from 'react-native-svg';", false],
  ["import { Image, Canvas } from '@shopify/react-native-skia';", false],
  ["import { View, Text } from 'react-native';\nconst decodeImage = 1;", false],
  ["import * as ImagePicker from 'expo-image-picker';", false],
];

let failed = 0;
let checks = 0;
for (const [text, dirty] of SELF) {
  checks += 1;
  const got = frescoUses(text).length > 0;
  if (got !== dirty) {
    failed += 1;
    console.log(`SELF-TEST FAIL: expected ${dirty ? 'a finding' : 'none'} in: ${JSON.stringify(text)}`);
  }
}

// `inject` proves the real scan reads the files it names: one forbidden line
// added to App.js's text must turn the gate red.
for (const file of sources()) {
  checks += 1;
  let text = readFileSync(file, 'utf8');
  if (BREAK === 'inject' && file === 'App.js') text += "\nimport { Image } from 'react-native';\n";
  const found = frescoUses(text);
  if (found.length) {
    failed += 1;
    console.log(`${file}: ${found.join(', ')} -- this reaches Fresco, whose JPEG transcoder and WebP library are excluded (see the header)`);
  }
}

console.log(`${checks - failed}/${checks} checks passed`);
process.exit(failed ? 1 : 0);
