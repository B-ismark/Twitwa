// Which file a card becomes, and which exits get to choose.
//
// Pure: no Skia, no react-native, so the whole decision loads in node and has a
// test. pipeline.js maps `format` onto Skia's ImageFormat enum (which cannot
// be imported here) and App.js reads the extension and MIME type from the same
// spec, so the name on disk, the type the share sheet is told and the bytes in
// the file are one answer rather than three places that each say "png".
//
// WHY JPEG AT ALL. Some chat apps recompress a PNG screenshot-sized card into
// something worse than a quality-92 JPEG of it, and a tall card is several
// times the bytes. It is an option, not a default: PNG is lossless and stays
// the product. Quality 92 is the knee the plan chose; below it text edges in a
// screenshot start to ring.
//
// WHY COPY IS NOT ON THE LIST. The clipboard path copies the card's PNG bytes
// onto the clipboard (modules/twitwa-out refuses a file that is not a PNG), so
// the receiving app gets a PNG whatever the person chose for Share and Save.

const FORMATS = ['png', 'jpeg'];
export const DEFAULT_FORMAT = 'png';
export const JPEG_QUALITY = 92;

// `quality` for PNG is 100 because that is the literal the encoder was called
// with before this table existed; the PNG path must stay byte-identical, and
// Skia ignores a PNG quality, so keeping the old value costs nothing.
const SPEC = {
  png: { format: 'png', ext: 'png', mime: 'image/png', uti: 'public.png', quality: 100 },
  jpeg: { format: 'jpeg', ext: 'jpg', mime: 'image/jpeg', uti: 'public.jpeg', quality: JPEG_QUALITY },
};

/** The exits a card can leave by, and whether the person's choice applies. */
const CHOOSABLE = { share: true, save: true, copy: false };

/** Is `format` one we know? Prefs and the toggle both ask. */
export const isFormat = (format) => FORMATS.includes(format);

/**
 * The spec for a format, as a copy. An unknown name throws: this feeds a file
 * name and an encoder, and "png unless it looks wrong" would write a file whose
 * extension and bytes disagree.
 */
export function formatSpec(format) {
  if (!isFormat(format)) throw new Error(`format: unknown format: ${String(format)}. Known: ${FORMATS.join(', ')}`);
  return { ...SPEC[format] };
}

/**
 * The spec an exit uses, given what the person chose. Share and Save follow the
 * choice; Copy is always PNG, whatever was chosen.
 */
export function formatFor(output, chosen = DEFAULT_FORMAT) {
  if (!Object.prototype.hasOwnProperty.call(CHOOSABLE, output)) {
    throw new Error(`format: unknown output: ${String(output)}. Known: ${Object.keys(CHOOSABLE).join(', ')}`);
  }
  return formatSpec(CHOOSABLE[output] ? chosen : DEFAULT_FORMAT);
}
