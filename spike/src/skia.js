// The one place a Skia image becomes a buffer of RGBA bytes.
//
// WHY THIS FILE EXISTS. `readSubRect(img, box, colour)` takes the colour shape
// as an argument so that src/read.js needs no Skia import and can be tested in
// node. That is the right design and it has a cost: the third argument is
// invisible at a call site that forgets it, and `colour.colorType` then throws
// `Cannot read property 'colorType' of undefined` — an error that names
// read.js and blames nothing.
//
// That is not hypothetical. On 2026-09-18 App.js called
// `readSubRect(img, {x: 0, y: 0, w: width, h: height})` with two arguments.
// Every import crashed, the editor never opened once, and the whole of Phase
// 4.5's premise — that the editor opens on a proposed crop — had never run on
// a device. Nothing caught it: the suites all call `readSubRect` correctly,
// `check-imports` verifies that a name resolves and not how it is called, and
// `expo export` bundles arity-blind.
//
// So the colour is bound here, once, and `readRect` is what everything else
// calls. Both pipeline.js and measure.js had already written this same adapter
// and this same constant privately — two copies of each, which is the same
// smell one step earlier. A two-argument function cannot be called with two
// arguments wrongly.
import { ColorType, AlphaType } from '@shopify/react-native-skia';

import { readSubRect } from './read';

/**
 * The colour shape every pixel read in this app uses.
 *
 * Unpremultiplied RGBA, because pixels.js's statistics are over straight
 * colour channels: premultiplied bytes would make a translucent pixel read as
 * a darker opaque one and quietly bias every ink profile and every sample.
 */
export const RGBA = { colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul };

/**
 * Read one sub-rect of a Skia image as RGBA bytes.
 *
 * @returns `{buf, rowBytes, width, height, rect, bytes}`, or null when the box
 * misses the image entirely or Skia's own read fails. Callers must handle the
 * null: see src/read.js, where `readPixels` returning null rather than throwing
 * is what makes an unchecked caller fail one layer away from the cause.
 */
export const readRect = (img, box) => readSubRect(img, box, RGBA);
