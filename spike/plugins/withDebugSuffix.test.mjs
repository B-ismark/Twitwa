// Tests for plugins/withDebugSuffix.js.
//
//   for b in $(node plugins/withDebugSuffix.test.mjs --list-mutants); do
//     BREAK=$b node plugins/withDebugSuffix.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. Same harness as withReleaseSigning.test.mjs and
// withAndroidSize.test.mjs, and for the same reason: each mutant is a textual
// edit to the REAL plugin source, loaded from a temp copy, never a stub
// written here. A stub proves the assertions redden against a different
// function.
//
// WHY THIS SUITE EXISTS. The plugin's failure modes are all quiet at build
// time and loud much later:
//
//   - no suffix at all: the debug APK takes the released app's id with a
//     different key, and the only symptom is INSTALL_FAILED_UPDATE_INCOMPATIBLE
//     at the moment you were trying to test something else;
//   - the suffix on the RELEASE build: a published APK under an id nobody can
//     upgrade from, discovered by the people who already installed 1.0.1;
//   - a suffix applied twice: two applicationIdSuffix lines, where Gradle takes
//     one and the id is not the one any script expects.
//
// None of those fail a build. So the checks below are about what the patched
// text says, not about whether patch() returned.
import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

const PLUGIN_SRC_PATH = 'plugins/withDebugSuffix.js';
const LIVE_GRADLE = 'android/app/build.gradle';

// --- the mutants -----------------------------------------------------------
const MUTANTS = {
  // The line the whole plugin is for never gets written.
  suffix_dropped: ["            applicationIdSuffix '.debug'\n", ''],
  // A suffix, but not the one every device script and every document names.
  wrong_suffix: ["applicationIdSuffix '.debug'", "applicationIdSuffix '.dev'"],
  // Applying the mod twice appends a second suffix instead of returning.
  idempotent_dead: [
    "if (contents.includes('applicationIdSuffix')) return contents;",
    "if (false && contents.includes('applicationIdSuffix')) return contents;",
  ],
  // A changed template is accepted in silence: the replace then does nothing.
  anchor_check_dead: ['if (!contents.includes(DEBUG_BLOCK)) {', 'if (false) {'],
  // The guard that keeps the suffix off the release buildType stops looking.
  release_guard_dead: ["if (release.includes('applicationIdSuffix')) {", 'if (false) {'],
  // The release slice starts at the debug block instead, so the guard sees the
  // debug suffix and refuses every correct patch.
  slice_from_debug: ["out.indexOf('        release {', types)", "out.indexOf('        debug {', types)"],
};

if (process.argv.includes('--list-mutants')) {
  console.log(Object.keys(MUTANTS).sort().join('\n'));
  process.exit(0);
}

const BREAK = process.env.BREAK || '';
const realSource = readFileSync(PLUGIN_SRC_PATH, 'utf8');
let plugin;

if (BREAK && MUTANTS[BREAK]) {
  const [find, replace] = MUTANTS[BREAK];
  if (!realSource.includes(find)) {
    console.log(`MUTATION ${BREAK} NO LONGER APPLIES: ${JSON.stringify(find.slice(0, 60))} is not in ${PLUGIN_SRC_PATH}.`);
    console.log('A mutation that cannot be applied tests nothing. Update it or delete it.');
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'twitwa-suffix-mutant-'));
  const f = join(dir, 'withDebugSuffix.js');
  writeFileSync(f, realSource.split(find).join(replace));
  plugin = require(f);
} else if (BREAK) {
  console.log(`unknown BREAK=${BREAK}. Known: ${Object.keys(MUTANTS).join(', ')}`);
  process.exit(1);
} else {
  plugin = require('./withDebugSuffix.js');
}

const { patch, strings } = plugin;

// Written down HERE, not read from `strings`. `wrong_suffix` edits the module,
// so an expectation read from the module is edited by the same mutation and
// passes. An expectation a mutation can move is not an expectation.
const EXPECTED_LINE = "applicationIdSuffix '.debug'";

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

/** patch(), with a throw turned into a value the checks can talk about. */
function tryPatch(contents) {
  try {
    return { ok: true, out: patch(contents) };
  } catch (e) {
    return { ok: false, message: String(e && e.message) };
  }
}

/**
 * The shape Expo SDK 57's template writes, reduced to the part this plugin
 * reads. A FUNCTION, not a constant, so no block can hand a mutated string to
 * the next one.
 */
function template() {
  return [
    'android {',
    '    buildTypes {',
    '        debug {',
    '            signingConfig signingConfigs.debug',
    '        }',
    '        release {',
    '            signingConfig signingConfigs.release',
    '            minifyEnabled enableMinifyInReleaseBuilds',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
}

/** The debug buildType's body, wherever it sits. */
function debugBody(text) {
  const at = text.indexOf('        debug {');
  if (at === -1) return '';
  const end = text.indexOf('\n        }', at);
  return text.slice(at, end === -1 ? undefined : end);
}

/** The release buildType's body. */
function releaseBody(text) {
  const at = text.indexOf('        release {');
  if (at === -1) return '';
  const end = text.indexOf('\n        }', at);
  return text.slice(at, end === -1 ? undefined : end);
}

console.log('\n=== withDebugSuffix ===');

// --- the patch lands, once, in the right block -----------------------------
{
  const r = tryPatch(template());
  check('patches the template without throwing', r.ok, r.message);
  const out = r.ok ? r.out : '';
  check('debug block gets the suffix', debugBody(out).includes(EXPECTED_LINE), JSON.stringify(debugBody(out)));
  check('release block does NOT', !releaseBody(out).includes('applicationIdSuffix'), JSON.stringify(releaseBody(out)));
  check(
    'exactly one suffix line in the whole file',
    out.split('applicationIdSuffix').length - 1 === 1,
    out.split('applicationIdSuffix').length - 1,
  );
  check(
    'the signingConfig line survives',
    debugBody(out).includes('signingConfig signingConfigs.debug'),
    JSON.stringify(debugBody(out)),
  );
  check(
    'nothing outside buildTypes moved',
    out.includes('minifyEnabled enableMinifyInReleaseBuilds'),
  );
}

// --- applying the mod twice is not applying it twice -----------------------
// Config plugins are re-run on every prebuild, and a non-clean prebuild can
// hand back a file this plugin already patched.
{
  const once = tryPatch(template());
  const twice = once.ok ? tryPatch(once.out) : { ok: false, message: 'first patch threw' };
  check('second application does not throw', twice.ok, twice.message);
  check('second application changes nothing', twice.ok && twice.out === once.out);
  check(
    'still exactly one suffix line after two applications',
    twice.ok && twice.out.split('applicationIdSuffix').length - 1 === 1,
    twice.ok ? twice.out.split('applicationIdSuffix').length - 1 : 'threw',
  );
}

// --- a changed template is refused, loudly ---------------------------------
{
  const drifted = template().replace(
    '            signingConfig signingConfigs.debug',
    '            signingConfig signingConfigs.debugKey',
  );
  const r = tryPatch(drifted);
  check('a template whose debug block changed is refused', !r.ok, r.ok ? 'returned without throwing' : undefined);
  check(
    'and the refusal names this plugin and the file to look at',
    !r.ok && r.message.includes('withDebugSuffix') && r.message.includes('build.gradle'),
    r.ok ? 'no message' : r.message,
  );
  check(
    'and it says the template changed, rather than blaming the caller',
    !r.ok && /template changed/i.test(r.message),
    r.ok ? 'no message' : r.message,
  );
}

// --- the suffix must never reach the release buildType ---------------------
// A constructed file whose RELEASE block carries the text the plugin anchors
// on. Pathological, and that is the point: it is the only way to exercise the
// guard, and the guard is the one whose failure ships.
{
  const inverted = [
    'android {',
    '    buildTypes {',
    '        release {',
    '            signingConfig signingConfigs.debug',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  // The debug anchor is 8 spaces + "debug {"; here it is absent, so build one
  // where the anchor text sits INSIDE release.
  const anchorInRelease = [
    'android {',
    '    buildTypes {',
    '        release {',
    '        debug {',
    '            signingConfig signingConfigs.debug',
    '        }',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  check(
    'a file with no debug block at all is refused',
    !tryPatch(inverted).ok,
  );
  const r = tryPatch(anchorInRelease);
  check(
    'a suffix that would land inside release is refused',
    !r.ok,
    r.ok ? JSON.stringify(releaseBody(r.out)) : undefined,
  );
  check(
    'and the refusal explains the upgrade consequence',
    !r.ok && /upgrade/i.test(r.message),
    r.ok ? 'no message' : r.message,
  );
}

// --- the anchor has not drifted from the generated project -----------------
// android/ is gitignored, so this SKIPs in a clone. Where it exists it is the
// only check that the recorded template is still the real one.
if (existsSync(LIVE_GRADLE)) {
  const live = readFileSync(LIVE_GRADLE, 'utf8').replace(/\r\n/g, '\n');
  const pristine = live.includes(strings.DEBUG_BLOCK);
  const patched = live.includes(strings.DEBUG_BLOCK_PATCHED);
  check(
    'the generated build.gradle matches the anchor, patched or pristine',
    pristine || patched,
    JSON.stringify(debugBody(live)),
  );
  if (patched) {
    check(
      'and the live file carries exactly one suffix line',
      live.split('applicationIdSuffix').length - 1 === 1,
      live.split('applicationIdSuffix').length - 1,
    );
    check(
      'and the live release buildType has none',
      !releaseBody(live).includes('applicationIdSuffix'),
    );
  } else {
    skip('live file suffix count', 'android/ has not been prebuilt since the plugin was added');
    skip('live release buildType', 'android/ has not been prebuilt since the plugin was added');
  }
} else {
  skip('the generated build.gradle matches the anchor', `${LIVE_GRADLE} does not exist (clone without a prebuild)`);
  skip('live file suffix count', `${LIVE_GRADLE} does not exist`);
  skip('live release buildType', `${LIVE_GRADLE} does not exist`);
}

console.log(`\n-> ${ran} check(s), ${fails} failing, ${skipped} skipped`);
process.exit(fails ? 1 : 0);
