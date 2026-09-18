// Fails when our source reads a `StyleSheet.<member>` that the installed
// React Native does not define.
//
//   cd spike && node tools/check-style-members.mjs
//
//   for b in $(node tools/check-style-members.mjs --list-mutants); do
//     BREAK=$b node tools/check-style-members.mjs >/dev/null 2>&1; echo "$b -> $?"
//   done
//
// Every one must print 1.
//
// WHY THIS EXISTS. `StyleSheet.absoluteFillObject` was removed in React Native
// 0.86; the surviving export is `absoluteFill`. Two styles in this app spread
// the missing one:
//
//   empty: { ...StyleSheet.absoluteFillObject, alignItems: 'center', ... }
//   sheet: { ...StyleSheet.absoluteFillObject, paddingTop: ..., ... }
//
// Spreading `undefined` is legal JavaScript and contributes nothing. There is
// no warning, no red box, and no failing test: the styles simply lost their
// positioning. On the device the empty-state message sat at the top of the
// stage instead of its middle, and the developer panel laid out in flow below
// the controls instead of covering the screen. Both read as flexbox mistakes,
// and both were found by eye on a phone, which is the expensive way.
//
// WHAT IT READS. The member list is DERIVED from
// node_modules/react-native/Libraries/StyleSheet/StyleSheetExports.js, never
// typed here. A hand-written list would be a second copy of React Native's
// API: correct on the day it was written, and silently wrong after the next
// upgrade, which is the exact defect this gate is for. Same reasoning as
// tools/check-fs-sync.mjs, which takes its trap names from expo-file-system's
// own Kotlin module.
//
// WHY A REGEX AND NOT AN IMPORT. `import 'react-native'` in node fails: the
// module reaches for native modules that only exist inside an app. So this
// parses the library's source, which is reading a transcript of the data
// rather than the data, and this repository has been bitten by that before.
// Two consequences are deliberate:
//   - the extractor is brace-depth aware rather than line-shaped, so a nested
//     object inside the export cannot contribute a false member;
//   - it REFUSES when it finds implausibly few members, because a parse that
//     silently returns nothing would let every call site through.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EXPORTS_FILE = 'node_modules/react-native/Libraries/StyleSheet/StyleSheetExports.js';
const SOURCE_DIRS = ['.', 'src', 'tools'];

// A parse this small is suspicious below this many members. React Native's
// StyleSheet has had at least create/flatten/compose/hairlineWidth/absoluteFill
// for a decade, so 5 is a floor no plausible version crosses.
const MIN_MEMBERS = 5;

const MUTANTS = {
  // The gate stops comparing, and every unknown member passes.
  compare_blind: 'compare_blind',
  // The floor stops firing, so a parse that found nothing reads as a pass.
  floor_blind: 'floor_blind',
  // Members nested inside the export's own object literals are counted as
  // top-level, which would make `StyleSheet.position` look valid.
  depth_blind: 'depth_blind',
  // The scanner stops finding call sites, so there is nothing to check.
  callsite_blind: 'callsite_blind',
  // Comments count as code again, so the prose explaining the removed member
  // fails the gate -- a false alarm on every file that documents the bug.
  comment_blind: 'comment_blind',
};

if (process.argv.includes('--list-mutants')) {
  console.log(Object.keys(MUTANTS).sort().join('\n'));
  process.exit(0);
}
const BREAK = process.env.BREAK || '';
if (BREAK && !MUTANTS[BREAK]) {
  console.log(`unknown BREAK: ${BREAK}. Known: ${Object.keys(MUTANTS).join(', ')}`);
  process.exit(2);
}
const blind = (which) => BREAK === which;

let fails = 0;
let ran = 0;
function check(name, cond, detail) {
  ran++;
  if (cond) { console.log(`  pass  ${name}`); return; }
  fails++;
  console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${detail}`}`);
}

// These helpers are NOT exported. They are used only by the checks below in
// this same file, and check-dead.mjs correctly reports an export nothing
// outside the module refers to -- a gate's internals are not an API.
/**
 * The top-level keys of the object a module `export default`s.
 *
 * Brace-depth aware: only keys at depth 1 of that object count, so the
 * `position`/`left`/`right` inside a nested style literal are not members of
 * StyleSheet. Strings and comments are skipped so a brace inside either
 * cannot move the depth.
 */
function defaultExportKeys(src) {
  const at = src.indexOf('export default {');
  if (at === -1) return [];
  let i = at + 'export default '.length;
  let depth = 0;
  const keys = [];
  let line = '';
  // A key is read off the text since the last separator, at the moment the
  // separator arrives: a newline ends `absoluteFill,`, and a `{` ends both
  // `nested: {` and `create<+S>(obj: S): Readonly<S> {`. Doing it at the
  // separator rather than line by line is what lets a method and a nested
  // object be seen without their bodies leaking members.
  const KEY = /^\s*(?:get\s+|set\s+|async\s+)?([A-Za-z_$][\w$]*)\s*(?::|,|\(|<)/;
  const take = () => {
    const want = blind('depth_blind') ? depth >= 1 : depth === 1;
    if (!want) return;
    const m = line.match(KEY);
    if (m) keys.push(m[1]);
  };
  for (; i < src.length; i++) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; line = ''; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i); i = end === -1 ? src.length : end + 1; line = ''; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '{') { take(); depth++; line = ''; continue; }
    if (c === '}') { depth--; line = ''; if (depth === 0) break; continue; }
    if (c === '\n') { take(); line = ''; continue; }
    line += c;
  }
  return [...new Set(keys)];
}

/**
 * Source with comments removed, so a member named in prose is not a call site.
 *
 * This file's own header names `StyleSheet.absoluteFillObject` repeatedly, and
 * so do the comments in App.js and DevPanel.js that explain why it is gone. A
 * gate that reads those as usage fails on the explanation of the bug it was
 * written for, which is how the first run of this file went.
 */
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '//') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (two === '/*') { const end = text.indexOf('*/', i); i = end === -1 ? text.length : end + 1; continue; }
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < text.length && text[i] !== quote) { out += text[i]; i += text[i] === '\\' ? 2 : 1; }
      out += quote;
      continue;
    }
    out += c;
  }
  return out;
}

/** Every `StyleSheet.<member>` written in one file. */
function callSites(text) {
  if (blind('callsite_blind')) return [];
  const code = blind('comment_blind') ? text : stripComments(text);
  return [...code.matchAll(/\bStyleSheet\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}

/**
 * Whether a parse found so few members that it cannot be believed.
 *
 * A named function with fixtures below rather than an inline comparison. As an
 * inline `if`, its mutant exited 0: the live file parses eight members, so
 * removing the floor changed nothing and the mutation proved only that today's
 * React Native is fine. The floor exists for the day the parse breaks, and a
 * check for that day has to be asked about that day.
 */
function belowFloor(count) {
  if (blind('floor_blind')) return false;
  return count < MIN_MEMBERS;
}

/** Members used but not defined. */
function unknownMembers(used, defined) {
  if (blind('compare_blind')) return [];
  return used.filter((m) => !defined.includes(m));
}

console.log('\n=== StyleSheet members ===');

// --- the extractor, against fixtures it cannot get right by accident -------
{
  const fixture = [
    'const x = 1;',
    'export default {',
    '  hairlineWidth,',
    '  absoluteFill,',
    '  compose: composeStyles,',
    '  // a comment naming notAMember,',
    '  nested: {',
    '    position: "absolute",',
    '    left: 0,',
    '  },',
    '  create<+S>(obj: S): Readonly<S> {',
    '    return obj;',
    '  },',
    '};',
    '',
  ].join('\n');
  const keys = defaultExportKeys(fixture);
  check('fixture: finds the plain members', keys.includes('hairlineWidth') && keys.includes('absoluteFill'), keys.join(','));
  check('fixture: finds a keyed member', keys.includes('compose'), keys.join(','));
  check('fixture: finds a method', keys.includes('create'), keys.join(','));
  check('fixture: finds the nested object itself', keys.includes('nested'), keys.join(','));
  check('fixture: does NOT take keys from inside it', !keys.includes('position') && !keys.includes('left'), keys.join(','));
  check('fixture: does NOT take a word out of a comment', !keys.includes('notAMember'), keys.join(','));
  check('fixture: five members, no more', keys.length === 5, `${keys.length}: ${keys.join(',')}`);
}

// --- the call-site scanner --------------------------------------------------
{
  const text = 'a = StyleSheet.create({}); b = StyleSheet.absoluteFillObject; c = notStyleSheet.create;';
  const used = callSites(text);
  check('call sites: finds both members', used.includes('create') && used.includes('absoluteFillObject'), used.join(','));
  check('call sites: two of them', used.length === 2, `${used.length}: ${used.join(',')}`);

  const commented = [
    '// StyleSheet.absoluteFillObject is gone in 0.86.',
    '/* and StyleSheet.alsoNotReal was never real */',
    'const s = StyleSheet.create({});',
    'const msg = "StyleSheet.inAString";',
  ].join('\n');
  const fromCode = callSites(commented);
  check('call sites: a member named in a comment is not a call site', !fromCode.includes('absoluteFillObject') && !fromCode.includes('alsoNotReal'), fromCode.join(','));
  check('call sites: the real one beside it still counts', fromCode.includes('create'), fromCode.join(','));
  check('call sites: a string is left alone', fromCode.includes('inAString'), fromCode.join(','));
}

// --- the comparison ---------------------------------------------------------
{
  check(
    'comparison: an undefined member is reported',
    unknownMembers(['create', 'absoluteFillObject'], ['create', 'absoluteFill']).join() === 'absoluteFillObject',
  );
  check(
    'comparison: a defined member is not',
    unknownMembers(['create'], ['create', 'absoluteFill']).length === 0,
  );
}

// --- the floor, asked about the day the parse breaks ------------------------
{
  check('floor: a parse that found nothing is refused', belowFloor(0) === true);
  check('floor: one member short is refused', belowFloor(MIN_MEMBERS - 1) === true);
  check('floor: exactly the floor is accepted', belowFloor(MIN_MEMBERS) === false);
  check('floor: a full parse is accepted', belowFloor(MIN_MEMBERS + 20) === false);
}

// --- the installed React Native --------------------------------------------
if (!existsSync(EXPORTS_FILE)) {
  console.log(`\nREFUSING: ${EXPORTS_FILE} is not here, so there is nothing to check against.`);
  console.log('This gate reads the installed React Native; run npm install first.');
  process.exit(1);
}

const defined = defaultExportKeys(readFileSync(EXPORTS_FILE, 'utf8'));
if (belowFloor(defined.length)) {
  console.log(`\nREFUSING: parsed only ${defined.length} member(s) out of ${EXPORTS_FILE}.`);
  console.log('React Native changed the shape of that file. Read it and fix the extractor;');
  console.log('do not loosen this until it matches something, because a parse that finds');
  console.log('nothing lets every call site through.');
  process.exit(1);
}
check(`read ${defined.length} members from the installed React Native`, defined.length >= MIN_MEMBERS, defined.join(','));
check('and `absoluteFill` is one of them', defined.includes('absoluteFill'), defined.join(','));
check('and `absoluteFillObject` is NOT (0.86 removed it)', !defined.includes('absoluteFillObject'), defined.join(','));

// --- our own source ---------------------------------------------------------
const files = [];
for (const dir of SOURCE_DIRS) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    if (name.endsWith('.test.mjs')) continue;
    if (name === 'check-style-members.mjs') continue; // it names the removed member on purpose
    files.push(dir === '.' ? name : join(dir, name));
  }
}
check('found source files to scan', files.length > 0, files.length);

let bad = 0;
for (const f of files) {
  const used = [...new Set(callSites(readFileSync(f, 'utf8')))];
  if (!used.length) continue;
  const unknown = unknownMembers(used, defined);
  if (unknown.length) {
    bad++;
    console.log(`  FAIL  ${f}: StyleSheet.${unknown.join(', StyleSheet.')} — not defined by this React Native`);
  } else {
    console.log(`  pass  ${f}: ${used.map((u) => `StyleSheet.${u}`).join(', ')}`);
  }
}
ran += files.length;
fails += bad;

console.log(`\n-> ${ran} check(s), ${fails} failing`);
process.exit(fails ? 1 : 0);
