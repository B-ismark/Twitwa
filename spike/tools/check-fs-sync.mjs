// Catches one defect shape, because it cost a device run to find and it left
// no trace at all when it happened.
//
// expo-file-system's File exposes several members twice: `text()` and
// `textSync()`, `bytes()` and `bytesSync()`, `base64()` and `base64Sync()`,
// `copy()` and `copySync()`, `move()` and `moveSync()`. The plain name is the
// ASYNCHRONOUS one. Calling it without `await` returns a promise, and every
// use of that promise as a value fails in a way that reads as something else:
//
//   JSON.parse(f.text())     -> throws, and a surrounding try/catch turns a
//                               programming error into a legitimate-looking
//                               "no data" answer
//   f.text(); f.delete()     -> the delete races the read and the rejection is
//                               unhandled, so it never reaches the try/catch
//
// Both of those happened in this repo. The second was found, fixed, and
// written into a comment in App.js; the first was then written into
// src/update-io.js afterwards, by someone who had read that comment. A
// comment did not stop it happening again, so this is a gate.
//
// The async member names are DERIVED from expo-file-system's own Kotlin
// module, not typed here. A hand-maintained list would drift from the library
// on the next upgrade, which is the same defect one level up, and the drift
// would be silent in exactly the same way.
//
// This scans source text rather than importing anything, which the repo's own
// rules call out as usually the wrong instrument. The exception is named: these
// modules import Skia and expo-file-system, so they cannot be loaded in node at
// all, and the fault is invisible at runtime by construction.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE = join(HERE, '..');
const KOTLIN = join(
  SPIKE,
  'node_modules/expo-file-system/android/src/main/java/expo/modules/filesystem/FileSystemModule.kt',
);

/** Names expo-file-system declares with AsyncFunction, read out of its source. */
function asyncNames(kotlin) {
  const names = new Set();
  for (const m of kotlin.matchAll(/AsyncFunction\(\s*"([A-Za-z0-9_]+)"\s*\)/g)) names.add(m[1]);
  return names;
}

/** Names it declares with the synchronous Function(...) form. */
function syncNames(kotlin) {
  const names = new Set();
  for (const m of kotlin.matchAll(/(?<!Async)Function\(\s*"([A-Za-z0-9_]+)"\s*\)/g)) names.add(m[1]);
  return names;
}

/**
 * Every call of `.name(` in `source` that is NOT preceded by `await` and NOT
 * immediately handed to `.then(`, for names in `risky`. Returns {name, line}.
 *
 * Deliberately crude: a false positive costs someone thirty seconds of reading,
 * and a false negative costs a silent throttle that nobody notices for a month.
 */
/**
 * Whether the receiver ending just before `dot` is awaited: walk back over the
 * whole member chain -- names, dots, and balanced (...) and [...] -- and a
 * leading `new`, then look for `await` in front of what is left.
 *
 * This replaced a regex that allowed exactly ONE character between `await`
 * and the dot. Its self-checks all used a receiver called `f`, so they passed,
 * while `await png.base64()` was reported as unawaited: a gate whose tests
 * shared its blind spot. Found on 2026-09-22 by the first multi-letter
 * receiver anyone awaited.
 */
function isAwaited(line, dot) {
  let j = dot - 1;
  while (j >= 0) {
    const c = line[j];
    if (c === ')' || c === ']') {
      const open = c === ')' ? '(' : '[';
      let depth = 0;
      for (; j >= 0; j -= 1) {
        if (line[j] === c) depth += 1;
        else if (line[j] === open) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      j -= 1;
      continue;
    }
    if (/[A-Za-z0-9_$.]/.test(c)) {
      j -= 1;
      continue;
    }
    break;
  }
  const before = line.slice(0, j + 1).replace(/\bnew\s+$/, '');
  return /\bawait\s*$/.test(before);
}

/**
 * Source lines with every leading-dot continuation joined onto the line it
 * continues, each tagged with the number of its first line.
 *
 * Without the join, `file\n  .text()` has no receiver on the line holding the
 * call, so the regex below finds nothing there -- a miss, and in exactly the
 * shape Prettier gives a long `new File(...)` chain. Found in review on
 * 2026-09-22. Split on CRLF too: a `\r` left on the receiver's line would sit
 * between the name and the dot and hide the call the same way.
 */
function logicalLines(source) {
  const out = [];
  for (const [i, raw] of source.split(/\r?\n/).entries()) {
    if (/^\s*\./.test(raw) && out.length) out[out.length - 1].text += raw.trim();
    else out.push({ text: raw, line: i + 1 });
  }
  return out;
}

function unawaitedCalls(source, risky) {
  const out = [];
  const lines = logicalLines(source);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].text;
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    for (const name of risky) {
      // One fresh regex per line, and matchAll only. An earlier version called
      // re.exec() first as a cheap guard, which advanced lastIndex on the /g
      // regex; matchAll copies lastIndex, so it then started past the only
      // match and found nothing. The self-check below caught it immediately,
      // which is the entire reason those self-checks are here.
      const re = new RegExp(`[A-Za-z0-9_\\]\\)]\\.${name}\\s*\\(`, 'g');
      for (const m of line.matchAll(re)) {
        if (isAwaited(line, m.index + 1)) continue;
        const after = line.slice(m.index + m[0].length);
        if (/^\s*\)?\s*\.\s*then\b/.test(after)) continue;
        out.push({ name, line: lines[i].line, text: line.trim() });
      }
    }
  }
  return out;
}

function jsFiles() {
  const out = [];
  const src = join(SPIKE, 'src');
  for (const f of readdirSync(src)) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) out.push(join(src, f));
  }
  const app = join(SPIKE, 'App.js');
  if (existsSync(app)) out.push(app);
  return out;
}

function main() {
  if (!existsSync(KOTLIN)) {
    console.log(
      `REFUSING: expo-file-system's native module is not at\n  ${KOTLIN}\n`
      + 'so the async member names cannot be derived and this check would pass'
      + ' while verifying nothing. Run it from spike/ with node_modules installed.',
    );
    process.exit(1);
  }
  const kotlin = readFileSync(KOTLIN, 'utf8');
  const asyncs = asyncNames(kotlin);
  const syncs = syncNames(kotlin);

  // Only the names that exist in BOTH forms are traps: those are the ones where
  // the shorter, more obvious spelling is the asynchronous one.
  const risky = [...asyncs].filter((n) => syncs.has(`${n}Sync`)).sort();

  const files = jsFiles();
  let checked = 0;
  const problems = [];
  for (const f of files) {
    const source = readFileSync(f, 'utf8');
    if (!/expo-file-system/.test(source)) continue;
    checked += 1;
    for (const hit of unawaitedCalls(source, risky)) {
      problems.push(`  ${f.replace(SPIKE + '\\', '').replace(SPIKE + '/', '')}:${hit.line}`
        + `  .${hit.name}() is async in expo-file-system; use .${hit.name}Sync() or await it`
        + `\n      ${hit.text}`);
    }
  }

  // Self-checks on the rule itself, because every part of it can be wrong in a
  // direction that makes this gate green forever.
  let self = 0;
  const expect = (cond, what) => {
    if (!cond) {
      console.log(`SELF-CHECK FAILED: ${what}`);
      process.exit(1);
    }
    self += 1;
  };
  expect(asyncs.has('text'), 'text is derived as async');
  expect(syncs.has('textSync'), 'textSync is derived as sync');
  expect(!asyncs.has('textSync'), 'textSync is not also derived as async');
  expect(syncs.has('write'), 'write is derived as sync, so it must not be flagged');
  expect(!risky.includes('write'), 'write has no writeSync twin, so it is not risky');
  expect(risky.length >= 3, `at least three trap names derived (got ${risky.length})`);
  expect(unawaitedCalls('const v = f.text();', ['text']).length === 1, 'a bare .text() is caught');
  expect(unawaitedCalls('const v = await f.text();', ['text']).length === 0, 'an awaited .text() is not');
  expect(unawaitedCalls('f.text().then(g);', ['text']).length === 0, 'a .then() chain is not');
  // Receivers longer than one character, which the first version got wrong in
  // the false-alarm direction and no check here noticed.
  expect(unawaitedCalls('const v = await file.text();', ['text']).length === 0, 'an awaited multi-letter receiver is not');
  expect(unawaitedCalls('const v = await this.state.file.text();', ['text']).length === 0, 'an awaited member chain is not');
  expect(unawaitedCalls('const v = await new File(dir, name).text();', ['text']).length === 0, 'an awaited new File(...) is not');
  expect(unawaitedCalls('const v = new File(dir, name).text();', ['text']).length === 1, 'an unawaited new File(...) is caught');
  expect(unawaitedCalls('const v = file.text();', ['text']).length === 1, 'an unawaited multi-letter receiver is caught');
  expect(unawaitedCalls('await g(); const v = file.text();', ['text']).length === 1, 'an await earlier on the line does not excuse a later call');
  // A chain broken before the dot, as Prettier breaks long ones.
  expect(unawaitedCalls('const v = file\n  .text();', ['text']).length === 1, 'an unawaited call on its own line is caught');
  expect(unawaitedCalls('const v = await file\n  .text();', ['text']).length === 0, 'an awaited one on its own line is not');
  expect(unawaitedCalls('const v = file\r\n  .text();', ['text']).length === 1, 'and it is caught in a CRLF file too');
  // A join BEFORE the call, so a count of joined lines and a count of real
  // ones disagree: the call is on line 3, and it is the second logical line.
  expect((unawaitedCalls('const a = x\n  .y;\nconst v = f.text();', ['text'])[0] || {}).line === 3, 'reported at its real line number after a join');
  expect(unawaitedCalls('const v = f.textSync();', ['text']).length === 0, 'textSync is not caught');
  expect(unawaitedCalls('// const v = f.text();', ['text']).length === 0, 'a commented call is not');

  if (files.length === 0 || checked === 0 || risky.length === 0) {
    console.log(
      `\nREFUSING: ${files.length} file(s), ${checked} using expo-file-system,`
      + ` ${risky.length} trap name(s). Nothing was verified, so this is not a pass.`,
    );
    process.exit(1);
  }

  console.log(`  traps derived from expo-file-system: ${risky.join(', ')}`);
  if (problems.length) {
    console.log(`\n${problems.length} async-used-as-sync call(s):`);
    for (const p of problems) console.log(p);
    process.exit(1);
  }
  console.log(
    `\n${checked} file(s) using expo-file-system carry no async-as-sync call`
    + ` (plus ${self} self-checks on the rule itself)`,
  );
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('check-fs-sync.mjs')) main();
