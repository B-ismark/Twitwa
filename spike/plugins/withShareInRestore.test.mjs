// Tests for plugins/withShareInRestore.js.
//
//   for b in $(node plugins/withShareInRestore.test.mjs --list-mutants); do
//     BREAK=$b node plugins/withShareInRestore.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. Same harness as withDebugSuffix.test.mjs: each
// mutant is a textual edit to the REAL plugin source, loaded from a temp copy.
//
// WHY THIS SUITE EXISTS. Every way this plugin can be wrong builds, installs
// and runs, and shows up only after Android has killed Twitwa in the
// background -- which no one does on purpose:
//
//   - no call: the replay it exists to stop is back;
//   - the call AFTER `super.onCreate(null)`: that happens to work today, since
//     the local still holds the Bundle, but it contradicts the comment the
//     plugin writes above it, and the next reader trusts the comment;
//   - the call outside onCreate: `savedInstanceState` is not in scope and the
//     build fails, which is loud, but only at the end of a 15-minute build;
//   - two calls: harmless today, and the sign that idempotence is gone.
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

const PLUGIN_SRC_PATH = 'plugins/withShareInRestore.js';
const LIVE_ACTIVITY = 'android/app/src/main/java/dev/bismark/twitwa/MainActivity.kt';
const RESTORE_KT = 'modules/twitwa-share-in/android/src/main/java/dev/bismark/twitwa/sharein/ShareInRestore.kt';

// --- the mutants -----------------------------------------------------------
const MUTANTS = {
  // The line the whole plugin is for never gets written.
  call_dropped: ['  `    ${CALL}\\n`;', "  '';"],
  // Applying the mod twice inserts a second call instead of returning.
  idempotent_dead: ['if (text.includes(CALL)) return contents;', 'if (false) return contents;'],
  // A changed template is accepted in silence, and the slice lands anywhere.
  anchor_check_dead: ['if (at === -1 || text.indexOf(ANCHOR, at + 1) !== -1) {', 'if (false) {'],
  // A second `super.onCreate(null)` is no longer noticed.
  duplicate_anchor_blind: [' || text.indexOf(ANCHOR, at + 1) !== -1', ''],
  // The call goes in after the line that drops the state.
  inserted_after: ['text.slice(0, at) + INSERT + text.slice(at)', 'text.slice(0, at + ANCHOR.length) + INSERT + text.slice(at + ANCHOR.length)'],
  // The in-onCreate guard stops looking.
  scope_guard_dead: ["if (onCreate === -1 || text.slice(onCreate, at).includes('\\n  }')) {", 'if (false) {'],
  // The call passes null, which marks nothing, ever: the original bug again.
  passes_null: ['markIfRestored(this, savedInstanceState)', 'markIfRestored(this, null)'],
};

if (process.argv.includes('--list-mutants')) {
  console.log(Object.keys(MUTANTS).sort().join('\n'));
  process.exit(0);
}

const BREAK = process.env.BREAK || '';
// Normalised for the same reason as the other plugin suites: a CRLF checkout
// would make every multi-line mutant report NO LONGER APPLIES.
const realSource = readFileSync(PLUGIN_SRC_PATH, 'utf8').replace(/\r\n/g, '\n');
let plugin;

if (BREAK && MUTANTS[BREAK]) {
  const [find, replace] = MUTANTS[BREAK];
  if (!realSource.includes(find)) {
    console.log(`MUTATION ${BREAK} NO LONGER APPLIES: ${JSON.stringify(find.slice(0, 60))} is not in ${PLUGIN_SRC_PATH}.`);
    console.log('A mutation that cannot be applied tests nothing. Update it or delete it.');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'twitwa-restore-mutant-'));
  const f = join(dir, 'withShareInRestore.js');
  writeFileSync(f, realSource.split(find).join(replace));
  plugin = require(f);
} else if (BREAK) {
  console.log(`unknown BREAK=${BREAK}. Known: ${Object.keys(MUTANTS).join(', ')}`);
  process.exit(1);
} else {
  plugin = require('./withShareInRestore.js');
}

const { patch, strings } = plugin;

// Written down HERE, not read from `strings`: `passes_null` edits the module,
// and an expectation read from the module moves with it.
const EXPECTED_CALL = 'dev.bismark.twitwa.sharein.ShareInRestore.markIfRestored(this, savedInstanceState)';

let fails = 0;
let ran = 0;
let skipped = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}
function skip(name, why) { skipped++; console.log(`  SKIP  ${name}  -> ${why}`); }

function tryPatch(contents) {
  try {
    return { ok: true, out: patch(contents) };
  } catch (e) {
    return { ok: false, message: String(e && e.message) };
  }
}

/** Expo SDK 57's MainActivity, reduced to what this plugin reads. A function,
 *  so no block can hand a mutated string to the next. */
function template() {
  return [
    'package dev.bismark.twitwa',
    '',
    'import android.os.Bundle',
    '',
    'class MainActivity : ReactActivity() {',
    '  override fun onCreate(savedInstanceState: Bundle?) {',
    '    setTheme(R.style.AppTheme);',
    '    super.onCreate(null)',
    '  }',
    '',
    '  override fun getMainComponentName(): String = "main"',
    '}',
    '',
  ].join('\n');
}

/** onCreate's body, from its signature to its closing brace. */
function onCreateBody(text) {
  const at = text.indexOf('override fun onCreate(');
  if (at === -1) return '';
  const end = text.indexOf('\n  }', at);
  return text.slice(at, end === -1 ? undefined : end);
}

console.log('\n=== withShareInRestore ===');

// --- the call lands, once, above the line that drops the state -------------
{
  const r = tryPatch(template());
  check('patches the template without throwing', r.ok, r.message);
  const out = r.ok ? r.out : '';
  const body = onCreateBody(out);
  check('onCreate gets the call', body.includes(EXPECTED_CALL), JSON.stringify(body));
  check(
    'and it comes BEFORE super.onCreate(null)',
    body.indexOf(EXPECTED_CALL) !== -1 && body.indexOf(EXPECTED_CALL) < body.indexOf('super.onCreate(null)'),
    JSON.stringify(body),
  );
  check('exactly one call in the file', out.split('markIfRestored').length - 1 === 1, out.split('markIfRestored').length - 1);
  check('super.onCreate(null) itself survives', body.includes('    super.onCreate(null)'));
  check('setTheme still runs first', body.indexOf('setTheme') < body.indexOf('markIfRestored'));
  check('nothing outside onCreate moved', out.includes('override fun getMainComponentName(): String = "main"'));
}

// --- a CRLF MainActivity is patched too -------------------------------------
{
  const r = tryPatch(template().replace(/\n/g, '\r\n'));
  check('a CRLF file is patched, not refused', r.ok && onCreateBody(r.out).includes(EXPECTED_CALL), r.message);
}

// --- applying the mod twice is not applying it twice -----------------------
{
  const once = tryPatch(template());
  const twice = once.ok ? tryPatch(once.out) : { ok: false, message: 'first patch threw' };
  check('second application does not throw', twice.ok, twice.message);
  check('second application changes nothing', twice.ok && twice.out === once.out);
}

// --- a changed template is refused, loudly ---------------------------------
{
  const drifted = template().replace('super.onCreate(null)', 'super.onCreate(savedInstanceState)');
  const r = tryPatch(drifted);
  check('a template without super.onCreate(null) is refused', !r.ok, r.ok ? 'returned without throwing' : undefined);
  check(
    'and the refusal names this plugin, the file, and says the template changed',
    !r.ok && r.message.includes('withShareInRestore') && r.message.includes('MainActivity.kt') && /template changed/i.test(r.message),
    r.ok ? 'no message' : r.message,
  );

  const twoAnchors = template().replace('    super.onCreate(null)\n', '    super.onCreate(null)\n    super.onCreate(null)\n');
  check('two super.onCreate(null) lines are refused', !tryPatch(twoAnchors).ok);
}

// --- the anchor outside onCreate is refused --------------------------------
// Constructed: the anchor text in some other function. The call there would
// reference a `savedInstanceState` that is not in scope.
{
  const elsewhere = [
    'class MainActivity : ReactActivity() {',
    '  override fun onCreate(savedInstanceState: Bundle?) {',
    '    setTheme(R.style.AppTheme);',
    '  }',
    '',
    '  fun other() {',
    '    super.onCreate(null)',
    '  }',
    '}',
    '',
  ].join('\n');
  const r = tryPatch(elsewhere);
  check('an anchor outside onCreate is refused', !r.ok, r.ok ? JSON.stringify(r.out) : undefined);
  check('and the refusal says why', !r.ok && /not inside/.test(r.message), r.ok ? 'no message' : r.message);

  const noOnCreate = 'class MainActivity {\n    super.onCreate(null)\n}\n';
  check('an anchor with no onCreate at all is refused', !tryPatch(noOnCreate).ok);
}

// --- the call names a function that exists ---------------------------------
// Read as text because Kotlin does not run here. A rename in the module would
// otherwise be found only by a release build's compile step.
{
  const kt = readFileSync(RESTORE_KT, 'utf8');
  check('ShareInRestore.kt declares package dev.bismark.twitwa.sharein', /^package dev\.bismark\.twitwa\.sharein$/m.test(kt));
  check('...an object ShareInRestore', /^object ShareInRestore \{/m.test(kt));
  check(
    '...with a @JvmStatic markIfRestored(Activity, Bundle?)',
    /@JvmStatic\s+fun markIfRestored\(activity: Activity, savedInstanceState: Bundle\?\)/.test(kt),
  );
  check('...that marks only when the state is not null', /if \(savedInstanceState != null\) activity\.intent\?\.putExtra\(ShareInModule\.READ_MARK, true\)/.test(kt));
  check('the inserted call is the one written down here', strings.CALL === EXPECTED_CALL, strings.CALL);
}

// --- the plugin is registered ----------------------------------------------
{
  const app = JSON.parse(readFileSync('app.json', 'utf8'));
  check('app.json lists ./plugins/withShareInRestore', (app.expo.plugins || []).includes('./plugins/withShareInRestore'));
}

// --- the anchor has not drifted from the generated project -----------------
if (existsSync(LIVE_ACTIVITY)) {
  const live = readFileSync(LIVE_ACTIVITY, 'utf8').replace(/\r\n/g, '\n');
  const patched = onCreateBody(live).includes(EXPECTED_CALL);
  check('the generated MainActivity carries the anchor', live.includes(strings.ANCHOR));
  if (patched) {
    check('and the live onCreate has the call before the anchor', onCreateBody(live).indexOf(EXPECTED_CALL) < onCreateBody(live).indexOf('super.onCreate(null)'));
  } else {
    skip('live onCreate call', 'android/ has not been prebuilt since the plugin was added');
  }
} else {
  skip('the generated MainActivity carries the anchor', `${LIVE_ACTIVITY} does not exist (clone without a prebuild)`);
  skip('live onCreate call', `${LIVE_ACTIVITY} does not exist`);
}

console.log(`\n-> ${ran} check(s), ${fails} failing, ${skipped} skipped`);
process.exit(fails ? 1 : 0);
