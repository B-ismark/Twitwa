// Tests for plugins/withConfigChanges.js.
//
//   for b in $(node plugins/withConfigChanges.test.mjs --list-mutants); do
//     BREAK=$b node plugins/withConfigChanges.test.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1. Same harness as the other plugin suites: each mutant
// is a textual edit to the REAL plugin source, loaded from a temp copy.
//
// Every defect here is quiet: a missing value builds fine and the picker dies
// on the next Font size change, and a removed value does the same for the
// change that was absorbed before. So the checks read the attribute back.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const PLUGIN_SRC_PATH = 'plugins/withConfigChanges.js';

const MUTANTS = {
  // The point of the plugin: fontScale never gets added.
  font_missing: ["const WANTED = ['fontScale', 'density',", "const WANTED = ['density',"],
  density_missing: ["const WANTED = ['fontScale', 'density',", "const WANTED = ['fontScale',"],
  locale_missing: ["'uiMode', 'locale', 'layoutDirection'", "'uiMode', 'layoutDirection'"],
  layout_missing: ["'locale', 'layoutDirection']", "'locale']"],
  // Existing values are replaced instead of extended.
  overwrites: ['const out = have.slice();', 'const out = [];'],
  // Values added without checking, so a second run lists each twice.
  duplicates: ['if (!out.includes(v)) out.push(v);', 'out.push(v);'],
  // Added values go first, reordering what the template wrote.
  wrong_order: ['out.push(v);', 'out.unshift(v);'],
  // A manifest with no activity is accepted in silence.
  no_throw: ['if (!activity || !activity.$) {', 'if (false) {'],
  // Written to the wrong attribute.
  wrong_key: ["const KEY = 'android:configChanges';", "const KEY = 'android:configChange';"],
};

if (process.argv.includes('--list-mutants')) {
  console.log(Object.keys(MUTANTS).sort().join('\n'));
  process.exit(0);
}

const BREAK = process.env.BREAK || '';
// Normalised for CRLF clones, as in the other plugin suites.
const realSource = readFileSync(PLUGIN_SRC_PATH, 'utf8').replace(/\r\n/g, '\n');
let plugin;
if (BREAK && MUTANTS[BREAK]) {
  const [find, replace] = MUTANTS[BREAK];
  if (!realSource.includes(find)) {
    console.log(`MUTATION ${BREAK} NO LONGER APPLIES: ${JSON.stringify(find.slice(0, 60))} is not in ${PLUGIN_SRC_PATH}.`);
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), 'twitwa-config-mutant-'));
  const f = join(dir, 'withConfigChanges.js');
  writeFileSync(f, realSource.split(find).join(replace));
  plugin = require(f);
} else if (BREAK) {
  console.log(`unknown BREAK=${BREAK}. Known: ${Object.keys(MUTANTS).join(', ')}`);
  process.exit(1);
} else {
  plugin = require('./withConfigChanges.js');
}
const { apply } = plugin;

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// The values written HERE, not read from the plugin: a mutant that edits the
// plugin's list would otherwise edit the expectation with it.
const NEEDED = ['fontScale', 'density', 'uiMode', 'locale', 'layoutDirection'];
// The Expo SDK 57 template's value, as the code comment in src/recover.js records it.
const TEMPLATE = 'keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize|assetsPaths';
const activity = (v) => ({ $: { 'android:name': '.MainActivity', ...(v === undefined ? {} : { 'android:configChanges': v }) } });
const read = (a) => (a.$['android:configChanges'] || '').split('|');

console.log('every value the app needs is declared');
{
  const out = read(apply(activity(TEMPLATE)));
  for (const v of NEEDED) check(`${v} is present`, out.includes(v), out.join('|'));
}

console.log('nothing the template had is lost, and its order is kept');
{
  const had = TEMPLATE.split('|');
  const out = read(apply(activity(TEMPLATE)));
  check('every original value survives', had.every((v) => out.includes(v)), out.join('|'));
  check('the originals come first, in their order', out.slice(0, had.length).join('|') === TEMPLATE, out.join('|'));
  const odd = read(apply(activity('orientation|someFutureValue')));
  check('a value this plugin does not know is kept too', odd.includes('someFutureValue') && odd.includes('orientation'), odd.join('|'));
}

console.log('idempotent');
{
  const once = apply(activity(TEMPLATE));
  const first = once.$['android:configChanges'];
  const twice = apply(once).$['android:configChanges'];
  check('a second run changes nothing', first === twice, twice);
  const out = read(once);
  check('no value is listed twice', new Set(out).size === out.length, out.join('|'));
}

console.log('an activity with no attribute at all');
{
  const out = read(apply(activity()));
  check('gets exactly the needed set', NEEDED.every((v) => out.includes(v)) && out.length === NEEDED.length, out.join('|'));
  check('with no empty entry from the missing value', !out.includes(''), JSON.stringify(out));
}

console.log('a manifest it cannot read is refused, not skipped');
{
  let msg = '';
  try { apply({}); } catch (e) { msg = String(e.message); }
  check('no attributes throws our own message, not a TypeError', msg.startsWith('withConfigChanges:'), msg);
}

console.log('written under the right attribute');
{
  const a = apply(activity(TEMPLATE));
  check('android:configChanges is where it lands', typeof a.$['android:configChanges'] === 'string' && a.$['android:configChanges'].includes('fontScale'));
  check('and no stray attribute appeared', Object.keys(a.$).sort().join() === 'android:configChanges,android:name', Object.keys(a.$).join());
}

console.log(`\n${ran - fails}/${ran} checks passed${BREAK ? `  (BREAK=${BREAK})` : ''}`);
process.exit(fails ? 1 : 0);
