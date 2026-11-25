// Tests for src/out.js and its contract with modules/twitwa-out.
//
//   for b in $(grep -o "BREAK [!=]== '[a-z_0-9]*'" src/out.test.mjs | cut -d"'" -f2 | sort -u); do
//     BREAK=$b node src/out.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// The native half cannot run here, and it replaced three libraries (Share,
// Save to Photos, Copy) in one go, so what CAN be checked from a desktop is the
// seam: the module and function names JS calls, the keys and error codes it
// reads, the provider authority the manifest and the Kotlin must agree on, the
// directories the paths file exposes against the ones the pipeline writes to,
// the permission line the manifest, the Kotlin and src/out.js each state, and
// that App.js no longer reaches for the three packages. All of that is read out
// of source text, which this repo usually calls the wrong instrument; the
// exception is named: the data lives in languages node cannot load, and every
// one of these drifting is silent. A renamed function means Share does
// nothing; a mismatched authority means Share crashes only on a phone; a
// permission line that drifted means a prompt nobody needs or a save that is
// refused with no prompt at all.
//
// The `kt_*`, `xml_*`, `man_*`, `io_*`, `app_*` and `pkg_*` mutants edit the
// real source text in memory, so they prove the contract checks can see a real
// drift, not only a mocked one.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as real from './out.js';
import { COPY } from './copy.js';
import { savedName } from './plan.js';
import { formatSpec } from './format.js';

const BREAK = process.env.BREAK || '';
let needsSavePermission = real.needsSavePermission;
let permissionGranted = real.permissionGranted;
let failure = real.failure;
let savedAnswer = real.savedAnswer;

if (BREAK === 'perm_line_30') {
  // expo-media-library's own line: Android 10 is asked for a permission the save does not use.
  needsSavePermission = (api) => api < 30;
} else if (BREAK === 'perm_line_28') {
  // One too low: Android 9 (API 28) saves with no permission and is refused.
  needsSavePermission = (api) => api < 28;
} else if (BREAK === 'perm_never') {
  needsSavePermission = () => false;
} else if (BREAK === 'perm_always') {
  needsSavePermission = () => true;
} else if (BREAK === 'perm_unknown_skips') {
  // An API level nobody can read means "no need to ask".
  needsSavePermission = (api) => (typeof api === 'number' && Number.isFinite(api) ? real.needsSavePermission(api) : false);
} else if (BREAK === 'perm_string_api') {
  // "33" read as a number by coercion; a string is not a level.
  needsSavePermission = (api) => Number(api) < 29;
} else if (BREAK === 'granted_truthy') {
  permissionGranted = (a) => Boolean(a && a.granted);
} else if (BREAK === 'granted_missing_is_yes') {
  permissionGranted = (a) => !(a && a.granted === false);
} else if (BREAK === 'failure_one_sentence') {
  failure = (kind, e) => ({ ...real.failure(kind, e), message: COPY.saveFailed });
} else if (BREAK === 'failure_reason_always_unknown') {
  failure = (kind, e) => ({ ...real.failure(kind, e), reason: 'unknown' });
} else if (BREAK === 'failure_missing_unlabelled') {
  // A build with no module logged as any other failure.
  failure = (kind, e) => (e && e.code === 'ERR_OUT_MODULE_MISSING' ? { ...real.failure(kind, e), reason: 'unknown' } : real.failure(kind, e));
} else if (BREAK === 'failure_any_code') {
  // Another library's code is logged as ours.
  failure = (kind, e) => (e && typeof e.code === 'string' ? { ...real.failure(kind, e), reason: e.code } : real.failure(kind, e));
} else if (BREAK === 'failure_unknown_kind_ok') {
  failure = (kind, e) => (['share', 'save', 'copy'].includes(kind) ? real.failure(kind, e) : { message: COPY.saveFailed, reason: 'unknown' });
} else if (BREAK === 'failure_throws_on_odd_error') {
  failure = (kind, e) => (e && e.code === undefined ? (() => { throw new Error('odd error'); })() : real.failure(kind, e));
} else if (BREAK === 'saved_view_unchecked') {
  // View opens whatever string the native side sent.
  savedAnswer = (a) => (a && typeof a.uri === 'string' ? { uri: a.uri, view: a.uri } : real.savedAnswer(a));
} else if (BREAK === 'saved_no_uri_throws') {
  savedAnswer = (a) => {
    if (!a || typeof a.uri !== 'string') throw new Error('no uri');
    return real.savedAnswer(a);
  };
} else if (BREAK === 'saved_uri_any_type') {
  savedAnswer = (a) => (a && a.uri != null ? { uri: a.uri, view: real.savedAnswer(a).view } : real.savedAnswer(a));
}

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

console.log('when Save has to ask first');
{
  check('API 24 asks', needsSavePermission(24) === true);
  check('API 28 (Android 9) asks', needsSavePermission(28) === true);
  check('API 29 (Android 10) does not', needsSavePermission(29) === false);
  check('API 30 does not', needsSavePermission(30) === false);
  check('API 37 does not', needsSavePermission(37) === false);
  check('the line is the one the Kotlin and the manifest use', real.LEGACY_BELOW_API === 29, real.LEGACY_BELOW_API);
  for (const [name, v] of [['undefined', undefined], ['null', null], ['NaN', NaN], ['a string', '33'], ['an object', {}]]) {
    check(`an API level that is ${name} asks`, needsSavePermission(v) === true);
  }
}

console.log('\nwhat the permission answer means');
{
  check('granted: true -> granted', permissionGranted({ granted: true }) === true);
  check('granted: false -> not', permissionGranted({ granted: false }) === false);
  check('no answer -> not', permissionGranted(undefined) === false && permissionGranted(null) === false);
  check('an answer without the key -> not', permissionGranted({}) === false);
  check('a truthy string is not a grant', permissionGranted({ granted: 'yes' }) === false);
  check('a bare true is not an answer', permissionGranted(true) === false);
}

console.log('\nwhat a failure says');
{
  const refused = failure('share', { code: 'ERR_OUT_NO_APP', message: 'x' });
  check('a share refusal -> the share sentence', refused.message === COPY.shareFailed, refused.message);
  check('...with the native code as its reason', refused.reason === 'ERR_OUT_NO_APP', refused.reason);
  check('a save refusal -> the save sentence', failure('save', { code: 'ERR_OUT_PERMISSION' }).message === COPY.saveFailed);
  check('a copy refusal -> the copy sentence', failure('copy', { code: 'ERR_OUT_NOT_PNG' }).message === COPY.copyFailed);
  const missing = failure('share', Object.assign(new Error('not linked'), { code: 'ERR_OUT_MODULE_MISSING' }));
  check('no module in this build -> the same sentence', missing.message === COPY.shareFailed, missing.message);
  check('...under its own reason, not a native refusal', missing.reason === 'module-missing', missing.reason);
  check('another library\'s code is not ours', failure('save', { code: 'ERR_SOMETHING_ELSE' }).reason === 'unknown');
  check('a lower-case or odd code is not ours', failure('save', { code: 'ERR_OUT_lower' }).reason === 'unknown' && failure('save', { code: 'ERR_OUT_' }).reason === 'unknown');
  for (const [name, e] of [['a plain Error', new Error('x')], ['a string', 'boom'], ['undefined', undefined], ['null', null], ['a number code', { code: 7 }]]) {
    const f = failure('copy', e);
    check(`${name} -> the copy sentence, reason unknown`, f.message === COPY.copyFailed && f.reason === 'unknown', JSON.stringify(f));
  }
  let threw = false;
  try { failure('constructor', {}); } catch { threw = true; }
  check('an unknown kind throws, even a name Object has', threw);
  const sentences = new Set(Object.values(COPY));
  check('every sentence is a real one from the deck', ['share', 'save', 'copy'].every((k) => sentences.has(failure(k, null).message)));
}

console.log('\nwhat a finished save tells the app');
{
  const uri = 'content://media/external/images/media/42';
  const ok = savedAnswer({ uri });
  check('the URI is kept for the log', ok.uri === uri, ok.uri);
  check('...and is what View opens', ok.view === uri, ok.view);
  const primary = savedAnswer({ uri: 'content://media/external_primary/images/media/7' });
  check('the Android 10 form opens too', primary.view === 'content://media/external_primary/images/media/7', primary.view);
  const odd = savedAnswer({ uri: 'content://com.android.providers.downloads/12' });
  check('another provider\'s URI is kept for the log but never opened', odd.uri !== null && odd.view === null, JSON.stringify(odd));
  for (const [name, a] of [['null', null], ['undefined', undefined], ['empty', {}], ['a number uri', { uri: 42 }], ['a string', 'content://media/external/images/media/1']]) {
    const r = savedAnswer(a);
    check(`${name}: still a save, with no URI and no View`, r.uri === null && r.view === null, JSON.stringify(r));
  }
}

console.log('\nthe contract with the Kotlin, the manifest and the app');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const mod = join(here, '../modules/twitwa-out/android');
  // Comments stripped first: the Kotlin's own comments quote these names, and
  // a name that survives only in a comment is a name the code stopped using.
  // Line comments go first so the header's "image/*"-style text cannot open a
  // block comment. Neither pass knows about string literals, which is safe
  // only while no Kotlin string contains "//" or "/*"; the last check holds that.
  const strip = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const stripXml = (src) => src.replace(/<!--[\s\S]*?-->/g, '');
  let kt = readFileSync(join(mod, 'src/main/java/dev/bismark/twitwa/out/OutModule.kt'), 'utf8');
  let man = readFileSync(join(mod, 'src/main/AndroidManifest.xml'), 'utf8');
  let xml = readFileSync(join(mod, 'src/main/res/xml/twitwa_out_paths.xml'), 'utf8');
  let cfg = readFileSync(join(here, '../modules/twitwa-out/expo-module.config.json'), 'utf8');
  const gradle = readFileSync(join(mod, 'build.gradle'), 'utf8');
  const provider = readFileSync(join(mod, 'src/main/java/dev/bismark/twitwa/out/TwitwaOutProvider.kt'), 'utf8');
  let io = readFileSync(join(here, 'out-io.js'), 'utf8');
  let app = readFileSync(join(here, '../App.js'), 'utf8');
  let pkg = readFileSync(join(here, '../package.json'), 'utf8');
  const appJson = readFileSync(join(here, '../app.json'), 'utf8');
  let pl = readFileSync(join(here, 'pipeline.js'), 'utf8');
  if (BREAK === 'kt_module_renamed') kt = kt.replace('Name("TwitwaOut")', 'Name("Out")');
  if (BREAK === 'kt_share_renamed') kt = kt.replace('AsyncFunction("share")', 'AsyncFunction("shareFile")');
  if (BREAK === 'kt_copy_renamed') kt = kt.replace('AsyncFunction("copyImage")', 'AsyncFunction("copy")');
  if (BREAK === 'kt_save_renamed') kt = kt.replace('AsyncFunction("save")', 'AsyncFunction("saveFile")');
  if (BREAK === 'kt_perm_renamed') kt = kt.replace('AsyncFunction("requestSavePermission")', 'AsyncFunction("askPermission")');
  if (BREAK === 'kt_uri_key_renamed') kt = kt.replace('mapOf("uri" to uri.toString())', 'mapOf("id" to uri.toString())');
  if (BREAK === 'kt_granted_key_renamed') kt = kt.split('"granted" to').join('"ok" to');
  if (BREAK === 'kt_save_arg_dropped') kt = kt.replace('{ path: String, mime: String, displayName: String ->', '{ path: String, mime: String ->');
  if (BREAK === 'kt_authority_renamed') kt = kt.replace('AUTHORITY_SUFFIX = "TwitwaOutProvider"', 'AUTHORITY_SUFFIX = "OutProvider"');
  if (BREAK === 'kt_cards_renamed') kt = kt.replace('CARDS = "cards"', 'CARDS = "card"');
  if (BREAK === 'kt_clipboard_renamed') kt = kt.replace('CLIPBOARD = "clipboard"', 'CLIPBOARD = "clip"');
  if (BREAK === 'kt_line_30') kt = kt.replace('LEGACY_BELOW_API = 29', 'LEGACY_BELOW_API = 30');
  if (BREAK === 'kt_no_containment') kt = kt.replace('!canonical.path.startsWith(root.path + File.separator)', 'false');
  if (BREAK === 'kt_non_canonical') kt = kt.replace('raw.canonicalFile', 'raw.absoluteFile');
  if (BREAK === 'kt_no_pending') kt = kt.replace('put(MediaStore.MediaColumns.IS_PENDING, 1)', '');
  if (BREAK === 'kt_pending_never_cleared') kt = kt.replace('put(MediaStore.MediaColumns.IS_PENDING, 0)', '');
  if (BREAK === 'kt_pictures_folder') kt = kt.replace('Environment.DIRECTORY_DCIM}/"', 'Environment.DIRECTORY_PICTURES}/"');
  if (BREAK === 'kt_legacy_not_dcim') kt = kt.replace('getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM)', 'getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES)');
  if (BREAK === 'kt_not_images') kt = kt.replace('resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI', 'resolver.insert(MediaStore.Files.getContentUri("external")');
  if (BREAK === 'kt_no_row_cleanup') kt = kt.replace('resolver.delete(uri, null, null)', 'resolver.query(uri, null, null, null, null)');
  if (BREAK === 'kt_no_file_cleanup') kt = kt.replace('part.delete()\n      dest.delete()\n      throw e', 'throw e');
  if (BREAK === 'kt_no_scan') kt = kt.replace('MediaScannerConnection.scanFile', 'MediaScannerConnection.hashCode');
  if (BREAK === 'kt_no_collision_retry') kt = kt.replace('insertCopyPublish(src, mime, uniqueName(name))', 'throw e');
  if (BREAK === 'kt_no_permission_check') kt = kt.replace('context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED', 'false');
  if (BREAK === 'kt_asks_on_new_android') kt = kt.replace('if (Build.VERSION.SDK_INT >= LEGACY_BELOW_API) {\n        // Nothing to ask', 'if (false) {\n        // Nothing to ask');
  if (BREAK === 'kt_no_chooser') kt = kt.replace('activity.startActivity(chooser)', 'activity.startActivity(send)');
  if (BREAK === 'kt_no_clipdata') kt = kt.replace('send.setClipData(ClipData.newRawUri(null, uri))', '');
  if (BREAK === 'kt_no_read_grant') kt = kt.replace('send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)', '');
  if (BREAK === 'kt_no_stream') kt = kt.replace('send.putExtra(Intent.EXTRA_STREAM, uri)', '');
  if (BREAK === 'kt_no_mime') kt = kt.replace('send.setType(mime)', '');
  if (BREAK === 'kt_not_send') kt = kt.replace('Intent(Intent.ACTION_SEND)', 'Intent(Intent.ACTION_VIEW)');
  if (BREAK === 'kt_fixed_clip_name') kt = kt.replace('"clip-${UUID.randomUUID()}.png"', '"card.png"');
  if (BREAK === 'kt_keeps_old_copies') kt = kt.replace('dir.listFiles()?.forEach { if (it.path != dest.path) it.delete() }', '');
  if (BREAK === 'kt_deletes_new_copy') kt = kt.replace('if (it.path != dest.path) it.delete()', 'it.delete()');
  if (BREAK === 'kt_clip_not_uri') kt = kt.replace('ClipData.newUri(context.contentResolver, "image", contentUri(context, dest))', 'ClipData.newPlainText("image", dest.path)');
  if (BREAK === 'kt_clip_points_at_card') kt = kt.replace('contentUri(context, dest))', 'contentUri(context, src))');
  if (BREAK === 'kt_no_png_check') kt = kt.replace('if (!isPng(src))', 'if (false)');
  if (BREAK === 'kt_no_mime_check') kt = kt.split('if (mime !in MIMES)').join('if (false)');
  if (BREAK === 'kt_jpeg_dropped') kt = kt.replace(', "image/jpeg" to ".jpg"', '');
  if (BREAK === 'kt_jpg_ext_changed') kt = kt.replace('"image/jpeg" to ".jpg"', '"image/jpeg" to ".jpeg"');
  if (BREAK === 'kt_name_regex_loose') kt = kt.replace('Regex("^[A-Za-z0-9._-]{1,100}$")', 'Regex("^.{1,100}$")');
  if (BREAK === 'kt_name_regex_tight') kt = kt.replace('Regex("^[A-Za-z0-9._-]{1,100}$")', 'Regex("^[A-Za-z]{1,100}$")');
  if (BREAK === 'kt_share_launch_off_main') kt = kt.replace('withContext(Dispatchers.Main) { launch(', 'withContext(Dispatchers.IO) { launch(');
  if (BREAK === 'kt_share_prep_on_main') kt = kt.replace('withContext(Dispatchers.IO) { chooserFor(', 'withContext(Dispatchers.Main) { chooserFor(');
  if (BREAK === 'kt_not_on_io') kt = kt.replace('withContext(Dispatchers.IO) { save(', 'withContext(Dispatchers.Main) { save(');
  if (BREAK === 'kt_no_coroutine') kt = kt.replace('AsyncFunction("save") Coroutine {', 'AsyncFunction("save") {');
  if (BREAK === 'kt_new_reason') kt = kt.replace('fail("not-png"', 'fail("not-a-png"');
  if (BREAK === 'kt_reason_only_in_comment') kt = kt.replace('fail("missing"', '/* fail("missing" */ fail("gone"');
  if (BREAK === 'kt_error_prefix') kt = kt.replace('"ERR_OUT_${', '"ERR_OUTPUT_${');
  if (BREAK === 'kt_denied_not_false') kt = kt.replace('?.status == PermissionsStatus.GRANTED', '?.status != PermissionsStatus.DENIED');
  if (BREAK === 'xml_extra_root') xml = xml.replace('</paths>', '  <root-path name="all" path="" />\n</paths>');
  if (BREAK === 'xml_whole_cache') xml = xml.replace('path="cards/"', 'path="."');
  if (BREAK === 'xml_cards_missing') xml = xml.replace('<cache-path name="twitwa_cards" path="cards/" />', '');
  if (BREAK === 'xml_clipboard_missing') xml = xml.replace('<cache-path name="twitwa_clipboard" path="clipboard/" />', '');
  if (BREAK === 'xml_files_path') xml = xml.replace('<cache-path name="twitwa_clipboard"', '<files-path name="twitwa_clipboard"');
  if (BREAK === 'man_authority_renamed') man = man.replace('${applicationId}.TwitwaOutProvider', '${applicationId}.OutProvider');
  if (BREAK === 'man_exported') man = man.replace('android:exported="false"', 'android:exported="true"');
  if (BREAK === 'man_no_grants') man = man.replace('android:grantUriPermissions="true"', 'android:grantUriPermissions="false"');
  if (BREAK === 'man_class_renamed') man = man.replace('android:name=".TwitwaOutProvider"', 'android:name=".OutProvider"');
  if (BREAK === 'man_xml_renamed') man = man.replace('@xml/twitwa_out_paths', '@xml/out_paths');
  if (BREAK === 'man_no_max_sdk') man = man.replace('\n      android:maxSdkVersion="28"', '');
  if (BREAK === 'man_max_sdk_29') man = man.replace('android:maxSdkVersion="28"', 'android:maxSdkVersion="29"');
  if (BREAK === 'man_read_storage') man = man.replace('</manifest>', '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" /></manifest>');
  if (BREAK === 'man_comment_only_authority') man = man.replace('android:authorities="${applicationId}.TwitwaOutProvider"', '<!-- android:authorities="${applicationId}.TwitwaOutProvider" -->');
  if (BREAK === 'cfg_class_renamed') cfg = cfg.replace('dev.bismark.twitwa.out.OutModule', 'dev.bismark.twitwa.out.Out');
  if (BREAK === 'cfg_not_android') cfg = cfg.replace('"android": {', '"ios": {');
  if (BREAK === 'io_module_renamed') io = io.replace("requireOptionalNativeModule('TwitwaOut')", "requireOptionalNativeModule('Out')");
  if (BREAK === 'io_required') io = io.replace("requireOptionalNativeModule('TwitwaOut')", "requireOptionalNativeModule('TwitwaOut') ?? (() => { throw new Error('x'); })()");
  if (BREAK === 'io_share_renamed') io = io.replace('native().share(', 'native().shareFile(');
  if (BREAK === 'io_copy_renamed') io = io.replace('native().copyImage(', 'native().copy(');
  if (BREAK === 'io_save_renamed') io = io.replace('native().save(', 'native().saveFile(');
  if (BREAK === 'io_perm_renamed') io = io.replace('native().requestSavePermission(', 'native().askPermission(');
  if (BREAK === 'io_save_arg_dropped') io = io.replace('.save(path, mime, displayName)', '.save(path, mime)');
  if (BREAK === 'io_missing_uncoded') io = io.replace("e.code = 'ERR_OUT_MODULE_MISSING';", '');
  if (BREAK === 'app_imports_sharing') app = app.replace("from './src/out-io'", "from './src/out-io';\nimport * as Sharing from 'expo-sharing'");
  if (BREAK === 'app_imports_clipboard') app = app.replace("from './src/out-io'", "from './src/out-io';\nimport * as Clipboard from 'expo-clipboard'");
  if (BREAK === 'app_imports_medialibrary') app = app.replace("from './src/out-io'", "from './src/out-io';\nimport { Asset } from 'expo-media-library'");
  if (BREAK === 'app_inline_line') app = app.replace('needsSavePermission(Platform.Version)', 'Platform.Version < 30');
  if (BREAK === 'app_no_fallback') app = app.replace('if (fallback) await share();', '');
  if (BREAK === 'app_permission_truthy') app = app.replace('!permissionGranted(perm)', '!perm.granted');
  if (BREAK === 'app_reads_base64') app = app.replace('await copyCardImage(out.path);', 'await copyCardImage(await new File(out.path).base64());');
  if (BREAK === 'app_display_name_differs') app = app.replace('await saveCard(out.path, spec.mime, name)', 'await saveCard(out.path, spec.mime, savedName(new Date(), spec.format))');
  if (BREAK === 'app_share_mime_dropped') app = app.replace('await shareCard(out.path, spec.mime)', 'await shareCard(out.path)');
  if (BREAK === 'app_share_asks_first') app = app.replace('const spec = formatFor(\'share\', format);', 'await shareCard(null, null);\n      const spec = formatFor(\'share\', format);');
  if (BREAK === 'app_problem_generic') app = app.replace('setProblem(f.message);\n    } finally {\n      if (exportCurrent(started, exportGen.current)) {\n        working.current = false;\n        setBusy(false);\n      }\n    }\n    if (fallback)', 'setProblem(COPY.saveFailed);\n    } finally {\n      if (exportCurrent(started, exportGen.current)) {\n        working.current = false;\n        setBusy(false);\n      }\n    }\n    if (fallback)');
  if (BREAK === 'app_id_not_uri') app = app.replace('id: saved.uri', 'id: saved.view');
  if (BREAK === 'app_view_not_checked') app = app.replace('const uri = saved.view;', 'const uri = saved.uri;');
  if (BREAK === 'pkg_sharing_back') pkg = pkg.replace('"expo-splash-screen"', '"expo-sharing": "~57.0.20",\n    "expo-splash-screen"');
  if (BREAK === 'pkg_clipboard_back') pkg = pkg.replace('"expo-splash-screen"', '"expo-clipboard": "~57.0.2",\n    "expo-splash-screen"');
  if (BREAK === 'pkg_medialibrary_back') pkg = pkg.replace('"expo-splash-screen"', '"expo-media-library": "~57.0.5",\n    "expo-splash-screen"');
  if (BREAK === 'pl_cards_renamed') pl = pl.replace("new Directory(Paths.cache, 'cards')", "new Directory(Paths.cache, 'out')");

  const ktRaw = kt;
  kt = strip(kt);
  man = stripXml(man);
  xml = stripXml(xml);
  check('comment stripping kept the code (share, copyImage, save, companion)',
    /AsyncFunction\("share"\)/.test(kt) && /private fun copyImage\(/.test(kt) && /private suspend fun save\(/.test(kt) && /companion object/.test(kt));

  console.log('\n  names');
  check('the Kotlin module is named TwitwaOut', /Name\("TwitwaOut"\)/.test(kt));
  check('...and that is the name the JS asks for', /requireOptionalNativeModule\('TwitwaOut'\)/.test(io));
  check('...and the module is optional, so a build without it does not crash on import', !/requireNativeModule\(/.test(io) && !/\?\?\s*\(\(\)/.test(io));
  const parsed = JSON.parse(cfg.replace(/^\s*$/gm, ''));
  check('the config lists the Kotlin class, for Android only', JSON.stringify(parsed.platforms) === '["android"]' && Array.isArray(parsed.android?.modules) && parsed.android.modules.includes('dev.bismark.twitwa.out.OutModule'), cfg);
  check('...and that class is OutModule in that package', /^package dev\.bismark\.twitwa\.out$/m.test(kt) && /class OutModule : Module\(\)/.test(kt));
  check('the Gradle namespace is the Kotlin package', /namespace "dev\.bismark\.twitwa\.out"/.test(gradle));
  for (const [kn, jn] of [['share', 'share'], ['copyImage', 'copyImage'], ['save', 'save'], ['requestSavePermission', 'requestSavePermission']]) {
    check(`the Kotlin declares ${kn}`, new RegExp(`AsyncFunction\\("${kn}"\\)`).test(kt));
    check(`...and the JS calls native().${jn}(`, io.includes(`native().${jn}(`));
  }
  check('save takes (path, mime, displayName), as the JS passes them',
    /AsyncFunction\("save"\) Coroutine \{ path: String, mime: String, displayName: String ->/.test(kt) && /\.save\(path, mime, displayName\)/.test(io));
  check('share takes (path, mime)', /AsyncFunction\("share"\) Coroutine \{ path: String, mime: String ->/.test(kt) && /\.share\(path, mime\)/.test(io));
  check('copyImage takes (path) and no base64', /AsyncFunction\("copyImage"\) Coroutine \{ path: String ->/.test(kt) && /\.copyImage\(path\)/.test(io));
  check('save answers with "uri", which src/out.js reads', /mapOf\("uri" to /.test(kt) && /answer\.uri/.test(readFileSync(join(here, 'out.js'), 'utf8')));
  check('the permission answer carries "granted", which src/out.js reads', (kt.match(/"granted" to /g) || []).length >= 3 && /answer\.granted/.test(readFileSync(join(here, 'out.js'), 'utf8')));
  check('a build without the module throws the code src/out.js recognises', /e\.code = 'ERR_OUT_MODULE_MISSING'/.test(io) && /ERR_OUT_MODULE_MISSING/.test(readFileSync(join(here, 'out.js'), 'utf8')));

  console.log('\n  the work happens off the JS thread');
  check('share prepares the file on Dispatchers.IO',
    /AsyncFunction\("share"\) Coroutine \{[^}]*withContext\(Dispatchers\.IO\) \{ chooserFor\(/.test(kt));
  check('...and opens the chooser on the main thread, where an activity is started',
    /AsyncFunction\("share"\) Coroutine \{(?:(?!AsyncFunction)[\s\S])*withContext\(Dispatchers\.Main\) \{ launch\(/.test(kt));
  check('copy and save run on Dispatchers.IO',
    /AsyncFunction\("copyImage"\) Coroutine \{[^}]*withContext\(Dispatchers\.IO\) \{ copyImage\(/.test(kt)
    && /AsyncFunction\("save"\) Coroutine \{[^}]*withContext\(Dispatchers\.IO\) \{ save\(/.test(kt));

  console.log('\n  the provider');
  const authority = (kt.match(/AUTHORITY_SUFFIX = "([A-Za-z]+)"/) || [])[1];
  check('the Kotlin names an authority suffix', typeof authority === 'string', authority);
  check('...and the manifest declares ${applicationId}.<that suffix>', man.includes(`android:authorities="\${applicationId}.${authority}"`), authority);
  const providerClass = (provider.match(/class (\w+) : FileProvider\(\)/) || [])[1];
  check('the provider class is a FileProvider subclass of its own', providerClass === 'TwitwaOutProvider', providerClass);
  check('...and the manifest names that class', man.includes(`android:name=".${providerClass}"`));
  check('the provider is not exported, and grants URI permissions', /android:exported="false"/.test(man) && /android:grantUriPermissions="true"/.test(man));
  check('the manifest points at the paths file by its real name', /android:resource="@xml\/twitwa_out_paths"/.test(man));
  check('...which is FILE_PROVIDER_PATHS meta-data', /android:name="android\.support\.FILE_PROVIDER_PATHS"/.test(man));
  const entries = [...xml.matchAll(/<([a-z-]+)\s+name="([^"]+)"\s+path="([^"]*)"/g)].map((m) => `${m[1]}:${m[3]}`).sort();
  const cards = (kt.match(/CARDS = "([a-z]+)"/) || [])[1];
  const clip = (kt.match(/CLIPBOARD = "([a-z]+)"/) || [])[1];
  check('the paths file exposes exactly cards/ and clipboard/ of the cache',
    JSON.stringify(entries) === JSON.stringify(['cache-path:cards/', 'cache-path:clipboard/']), entries.join(' '));
  check('...and those are the directories the Kotlin works in', entries.join(' ') === `cache-path:${cards}/ cache-path:${clip}/`.split(' ').sort().join(' '), `${cards} ${clip}`);
  check('...and cards/ is where the pipeline writes the card', pl.includes(`new Directory(Paths.cache, '${cards}')`), cards);
  check('the paths file has no root, files or external entry', !/<(root-path|files-path|external)/.test(xml));

  console.log('\n  the permission line');
  const line = (kt.match(/LEGACY_BELOW_API = (\d+)/) || [])[1];
  check('the Kotlin line is the one src/out.js states', Number(line) === real.LEGACY_BELOW_API, line);
  const max = (man.match(/WRITE_EXTERNAL_STORAGE"\s+android:maxSdkVersion="(\d+)"/) || [])[1];
  check('the manifest declares WRITE_EXTERNAL_STORAGE, with a maxSdkVersion', max !== undefined, max);
  check('...one below the line: the legacy route is for API 28 and under', Number(max) === real.LEGACY_BELOW_API - 1, max);
  check('the manifest asks for no other storage permission', !/READ_EXTERNAL_STORAGE|READ_MEDIA|MANAGE_EXTERNAL/.test(man));
  check('the legacy route checks the permission, and the request is skipped above the line',
    /checkSelfPermission\(Manifest\.permission\.WRITE_EXTERNAL_STORAGE\)/.test(kt) && /if \(Build\.VERSION\.SDK_INT >= LEGACY_BELOW_API\) \{\s*(?:\/\/[^\n]*\s*)?promise\.resolve\(mapOf\("granted" to true\)\)/.test(ktRaw));
  check('a denial is "granted": false, not an absent answer', /\?\.status == PermissionsStatus\.GRANTED/.test(kt));

  console.log('\n  where a save lands, and that it cleans up');
  check('into the images collection', /MediaStore\.Images\.Media\.EXTERNAL_CONTENT_URI/.test(kt));
  check('in the root of DCIM, as expo-media-library did', /RELATIVE_PATH, "\$\{Environment\.DIRECTORY_DCIM\}\/"/.test(kt) && /getExternalStoragePublicDirectory\(Environment\.DIRECTORY_DCIM\)/.test(kt));
  check('pending while written, then published', /IS_PENDING, 1\)/.test(kt) && /IS_PENDING, 0\)/.test(kt));
  check('a failed insert leaves no row', /resolver\.delete\(uri, null, null\)/.test(kt));
  check('a failed legacy write leaves no file', /part\.delete\(\)\s*dest\.delete\(\)\s*throw e/.test(kt));
  check('the legacy route has the scanner report the row', /MediaScannerConnection\.scanFile\(/.test(kt));
  check('a name clash is retried once under a name that cannot clash', /Failed to build unique file/.test(kt) && /insertCopyPublish\(src, mime, uniqueName\(name\)\)/.test(kt));
  const pairs = [...kt.matchAll(/"(image\/[a-z]+)" to "(\.[a-z]+)"/g)].map((m) => [m[1], m[2]]);
  for (const f of ['png', 'jpeg']) {
    const spec = formatSpec(f);
    check(`${f}: the Kotlin accepts ${spec.mime} and wants the extension .${spec.ext}`, pairs.some(([m, e]) => m === spec.mime && e === `.${spec.ext}`), JSON.stringify(pairs));
  }
  const nameRe = new RegExp((kt.match(/NAME = Regex\("([^"]+)"\)/) || [, '$^'])[1]);
  check('the Kotlin accepts the names src/plan.js makes', ['png', 'jpeg'].every((f) => nameRe.test(savedName(new Date(2026, 10, 25, 9, 5, 7), f))), nameRe.source);
  check('...and the pipeline\'s own card.png', nameRe.test('card.png'));
  check('...but not a path', !nameRe.test('../x.png') && !nameRe.test('a/b.png') && !nameRe.test(''));

  console.log('\n  share and copy');
  check('share opens the chooser', /Intent\.createChooser\(send, null\)/.test(kt) && /activity\.startActivity\(chooser\)/.test(kt));
  check('...an ACTION_SEND with the stream, the type, the ClipData and a read grant',
    /Intent\(Intent\.ACTION_SEND\)/.test(kt) && /EXTRA_STREAM, uri/.test(kt) && /send\.setType\(mime\)/.test(kt)
    && /setClipData\(ClipData\.newRawUri\(null, uri\)\)/.test(kt) && /FLAG_GRANT_READ_URI_PERMISSION/.test(kt));
  check('...and a refusal of every file outside cache/<dir>/', /!canonical\.path\.startsWith\(root\.path \+ File\.separator\)/.test(kt) && /raw\.canonicalFile/.test(kt));
  check('copy writes a name nothing else has', /"clip-\$\{UUID\.randomUUID\(\)\}\.png"/.test(kt));
  check('...deletes every older copy, never the new one', /dir\.listFiles\(\)\?\.forEach \{ if \(it\.path != dest\.path\) it\.delete\(\) \}/.test(kt));
  check('...puts a URI clip, of the copy and not of the card, on the clipboard', /ClipData\.newUri\(context\.contentResolver, "image", contentUri\(context, dest\)\)/.test(kt));
  check('...and refuses what is not a PNG', /if \(!isPng\(src\)\)/.test(kt) && /0x89\.toByte\(\), 0x50, 0x4e, 0x47/.test(kt));
  check('both refuse a type that is not one of ours', (kt.match(/if \(mime !in MIMES\)/g) || []).length === 2);

  console.log('\n  the reasons');
  // Listed here ON PURPOSE, as the one place a person decides what each new
  // refusal should be called: one added on the Kotlin side fails this until
  // someone has looked at it, rather than reaching a log as "unknown".
  const sent = [...new Set([...kt.matchAll(/fail\("([a-z-]+)"/g)].map((m) => m[1]))].sort();
  const decided = ['bad-mime', 'bad-name', 'bad-path', 'copy-failed', 'missing', 'no-activity', 'no-app', 'no-clipboard',
    'no-context', 'no-permissions', 'not-png', 'permission', 'permission-request', 'provider', 'save-failed', 'share-failed'];
  check('the Kotlin sends exactly the reasons decided here', sent.join(',') === decided.join(','), sent.join(','));
  check('every error code is ERR_OUT_ plus the reason, which is what src/out.js recognises',
    /"ERR_OUT_\$\{code\.uppercase\(\)\.replace\('-', '_'\)\}"/.test(kt)
    && decided.every((r) => failure('save', { code: `ERR_OUT_${r.toUpperCase().replace(/-/g, '_')}` }).reason === `ERR_OUT_${r.toUpperCase().replace(/-/g, '_')}`));

  console.log('\n  the app');
  const lib = ['expo-sharing', 'expo-clipboard', 'expo-media-library'];
  check('App.js imports none of the three libraries', lib.every((l) => !app.includes(`'${l}'`) && !app.includes(`"${l}"`)));
  check('...and package.json lists none of them', lib.every((l) => !pkg.includes(`"${l}"`)));
  check('...and app.json has no plugin for them', lib.every((l) => !appJson.includes(l)));
  check('App.js takes Share, Save and Copy from src/out-io', /from '\.\/src\/out-io'/.test(app) && ['shareCard', 'copyCardImage', 'saveCard', 'requestSavePermission'].every((n) => new RegExp(`\\b${n}\\b[^;]*from './src/out-io'`).test(app)));
  check('Save asks by src/out.js\'s rule, not an inline number', app.includes('needsSavePermission(Platform.Version)') && !/Platform\.Version < 3\d/.test(app.replace(/Platform\.Version < 33/g, '')));
  check('...a refusal reads through permissionGranted', app.includes('!permissionGranted(perm)'));
  check('...and falls back to the share sheet', app.includes('fallback = true;') && app.includes('if (fallback) await share();'));
  check('Save sends the name it exported under, as the display name', app.includes("const name = savedName(new Date(), spec.format);") && app.includes('exportCard(name, spec.format)') && app.includes('saveCard(out.path, spec.mime, name)'));
  check('Share sends the chosen type', app.includes('shareCard(out.path, spec.mime)'));
  check('...and asks nothing of the module before it (no availability question: the chooser is the answer)', (app.match(/shareCard\(/g) || []).length === 1);
  check('Copy sends the file and reads no base64', app.includes('copyCardImage(out.path)') && !/base64\(\)/.test(app));
  check('each failure gets its sentence from src/out.js', ['share', 'save', 'copy'].every((k) => app.includes(`failure('${k}', e)`)) && (app.match(/setProblem\(f\.message\)/g) || []).length === 3);
  check('the save event keeps its fields (id is now the URI)', app.includes('id: saved.uri') && /emit\('P5\.save', \{ ok: true, api: Platform\.Version/.test(app));
  check('View opens what src/out.js checked', app.includes('const uri = saved.view;'));
  check('no Kotlin string literal contains // or /* (the stripper would cut it)',
    !/"[^"\n]*(\/\/|\/\*)[^"\n]*"/.test(ktRaw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')));
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
