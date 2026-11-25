// Tests for src/format.js.
//
//   for b in jpeg_quality_100 png_quality_92 jpeg_ext_jpeg copy_follows_choice \
//            share_ignores_choice save_ignores_choice mime_swapped unknown_png \
//            output_unchecked; do
//     BREAK=$b node src/format.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
import * as real from './format.js';

const BREAK = process.env.BREAK || '';
const F = { ...real };

if (BREAK === 'jpeg_quality_100') F.formatSpec = (f) => ({ ...real.formatSpec(f), quality: 100 });
else if (BREAK === 'png_quality_92') F.formatSpec = (f) => ({ ...real.formatSpec(f), quality: 92 });
else if (BREAK === 'jpeg_ext_jpeg') F.formatSpec = (f) => { const s = real.formatSpec(f); return f === 'jpeg' ? { ...s, ext: 'jpeg' } : s; };
else if (BREAK === 'mime_swapped') F.formatSpec = (f) => { const s = real.formatSpec(f); return { ...s, mime: f === 'jpeg' ? 'image/png' : 'image/jpeg' }; };
else if (BREAK === 'copy_follows_choice') F.formatFor = (o, c) => real.formatSpec(c);
else if (BREAK === 'share_ignores_choice') F.formatFor = (o, c) => real.formatFor(o === 'share' ? 'copy' : o, c);
else if (BREAK === 'save_ignores_choice') F.formatFor = (o, c) => real.formatFor(o === 'save' ? 'copy' : o, c);
else if (BREAK === 'unknown_png') F.formatSpec = (f) => real.formatSpec(real.isFormat(f) ? f : 'png');
else if (BREAK === 'output_unchecked') F.formatFor = (o, c) => { try { return real.formatFor(o, c); } catch { return real.formatSpec(c); } };

let ran = 0;
let fails = 0;
function check(name, ok, detail) {
  ran += 1;
  if (!ok) { fails += 1; console.log(`FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`); } else console.log(`ok    ${name}`);
}

console.log('the two formats');
{
  const png = F.formatSpec('png');
  const jpg = F.formatSpec('jpeg');
  check('PNG: .png, image/png, public.png', png.ext === 'png' && png.mime === 'image/png' && png.uti === 'public.png', JSON.stringify(png));
  check('PNG quality stays the 100 the encoder was always called with', png.quality === 100, String(png.quality));
  check('JPEG: .jpg, image/jpeg, public.jpeg', jpg.ext === 'jpg' && jpg.mime === 'image/jpeg' && jpg.uti === 'public.jpeg', JSON.stringify(jpg));
  check('JPEG quality is 92', jpg.quality === 92 && real.JPEG_QUALITY === 92, String(jpg.quality));
  check('the default is PNG', real.DEFAULT_FORMAT === 'png');
  check('a spec is a copy', (() => { const s = F.formatSpec('png'); s.ext = 'x'; return F.formatSpec('png').ext === 'png'; })());
  let threw = false;
  try { F.formatSpec('webp'); } catch { threw = true; }
  check('an unknown format throws, not PNG', threw);
}

console.log('which outputs use the choice');
{
  check('Share follows a JPEG choice', F.formatFor('share', 'jpeg').format === 'jpeg');
  check('Save follows a JPEG choice', F.formatFor('save', 'jpeg').format === 'jpeg');
  check('Share and Save follow a PNG choice', F.formatFor('share', 'png').format === 'png' && F.formatFor('save', 'png').format === 'png');
  check('Copy is PNG even when JPEG is chosen', F.formatFor('copy', 'jpeg').format === 'png' && F.formatFor('copy', 'jpeg').mime === 'image/png');
  let threw = false;
  try { F.formatFor('print', 'png'); } catch { threw = true; }
  check('an unknown output throws', threw);
  threw = false;
  try { F.formatFor('toString', 'png'); } catch { threw = true; }
  check('an inherited property name is not an output', threw);
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
