// Verify every call to one of our own imported functions passes a legal
// number of arguments.
//
//   node tools/check-call-arity.mjs
//   for b in $(node tools/check-call-arity.mjs --list-mutants); do
//     BREAK=$b node tools/check-call-arity.mjs > /dev/null && echo "SURVIVED $b"
//   done
//
// WHY THIS FILE EXISTS. `check-imports.mjs` proves that an imported name
// RESOLVES. It says nothing about how the name is then called, and `npx expo
// export` bundles arity-blind. On 2026-09-18 App.js called the three-argument
// `readSubRect(img, box, colour)` with two arguments. Every import crashed,
// Phase 4.5's central claim had never once been true, and 1359 checks,
// check-imports and a clean export were all green throughout. That is the
// class of defect this gate closes, and it is the class App.js accumulates
// because nothing in the suites loads App.js at all.
//
// STATIC ON BOTH SIDES. The consumer is parsed and so is the module it imports
// from, rather than importing the module and reading `fn.length`. Two reasons,
// and the first is the load-bearing one:
//
//   1. The modules most worth checking are the ones that cannot be loaded in
//      node. src/skia.js imports @shopify/react-native-skia; src/pipeline.js
//      exists precisely to hold the Skia calls. An import-based check would
//      skip exactly the files whose call sites are least tested.
//   2. `fn.length` stops counting at the first default or rest parameter, so
//      it cannot tell "three required" from "one required and two optional".
//      The parameter list can.
//
// WHAT IT DOES NOT SEE, said out loud rather than left to be discovered:
//   - namespace imports (`import * as crop`) and member calls on them
//   - re-exported bindings (`export { TOUCH } from './theme'`) -- the
//     signature is not in the file that names the export
//   - a call whose arguments include a spread, where the count is unknown
//   - a name the consumer shadows locally; those are reported as skipped, not
//     silently dropped, because a shadow is also how a false green would hide
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from '@babel/parser';

const SRC = 'src';

const MUTANTS = {
  // The gate stops comparing, and every call passes whatever it likes.
  arity_blind: 'arity_blind',
  // Every parameter reads as optional, so a call missing a required argument
  // passes. This is the readSubRect bug put back.
  min_blind: 'min_blind',
  // The maximum reads as unbounded, so a call with extra arguments passes.
  max_blind: 'max_blind',
  // A rest parameter stops meaning variadic, so every variadic call is a
  // false alarm -- the failure mode where a gate is turned off for noise.
  rest_blind: 'rest_blind',
  // The import scan finds nothing, so there are no calls to check and the
  // gate is green having done no work.
  imports_blind: 'imports_blind',
  // A module that cannot be parsed is skipped instead of refused, so a broken
  // module silently stops being checked.
  parse_blind: 'parse_blind',
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

// --- the machinery, factored so the self-tests run the REAL path ------------
//
// NOT exported, following check-style-members.mjs: these are used only by the
// checks below in this same file, and check-dead.mjs is right to call an
// export nothing outside the module refers to dead. A gate's internals are
// not an API.
//
// Everything below takes its sources as an argument. The self-checks at the
// bottom hand it synthetic files, so a mutant is observed against the same
// functions the repo scan uses. A new mutant on a gate can otherwise stay
// green purely because the real tree happens to pass.

function toAst(text) {
  return parse(text, {
    sourceType: 'module',
    plugins: ['jsx'],
    errorRecovery: false,
  });
}

/** Visit every node in an AST, depth first. */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    walk(node[key], visit);
  }
}

/**
 * The legal argument counts for a parameter list.
 *
 * `min` is the number of parameters before the first one that may be omitted;
 * `max` is Infinity when a rest parameter is present. A default or a rest is
 * what makes a parameter optional -- a plain destructured parameter is NOT
 * optional, because destructuring `undefined` throws, and that is the shape
 * of the bug that started this file.
 */
function arityOf(params) {
  let min = 0;
  let max = 0;
  let seenOptional = false;
  for (const p of params) {
    const isRest = p.type === 'RestElement' && !blind('rest_blind');
    if (isRest) return { min, max: Infinity };
    const isOptional = p.type === 'AssignmentPattern';
    if (isOptional) seenOptional = true;
    if (!seenOptional) min += 1;
    max += 1;
  }
  return { min, max };
}

/** The exported functions of one module source, by name. */
function signatures(text) {
  const out = new Map();
  const ast = toAst(text);
  const record = (name, params) => {
    if (name) out.set(name, arityOf(params));
  };
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' || !node.declaration) continue;
    const d = node.declaration;
    if (d.type === 'FunctionDeclaration') {
      record(d.id && d.id.name, d.params);
    } else if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations) {
        if (!v.init || v.id.type !== 'Identifier') continue;
        if (v.init.type === 'ArrowFunctionExpression' || v.init.type === 'FunctionExpression') {
          record(v.id.name, v.init.params);
        }
      }
    }
  }
  return out;
}

/** Every name the file binds itself, so a shadowed import is not miscounted. */
function localNames(ast) {
  const names = new Set();
  walk(ast.program, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') names.add(n.id.name);
    if (n.type === 'FunctionDeclaration' && n.id) names.add(n.id.name);
    if (
      (n.type === 'FunctionDeclaration'
        || n.type === 'FunctionExpression'
        || n.type === 'ArrowFunctionExpression')
      && n.params
    ) {
      for (const p of n.params) if (p.type === 'Identifier') names.add(p.name);
    }
  });
  return names;
}

/**
 * Scan a set of files against a set of modules.
 *
 * @param files   Map of consumer path -> source text
 * @param modules Map of module key (the import specifier's basename) -> source
 * @returns {calls, bad, skipped, refuse}
 */
function arityReport(files, modules) {
  const calls = [];
  const bad = [];
  const skipped = [];
  const refuse = [];

  const sigCache = new Map();
  const sigsFor = (key) => {
    if (sigCache.has(key)) return sigCache.get(key);
    const text = modules.get(key);
    let sigs = null;
    if (text !== undefined) {
      try {
        sigs = signatures(text);
      } catch (e) {
        // A module that will not parse is a refusal, not an absence. Skipping
        // it reads as "nothing to check here" on exactly the file most likely
        // to be broken.
        if (!blind('parse_blind')) refuse.push(`${key}: ${e.message}`);
        sigs = null;
      }
    }
    sigCache.set(key, sigs);
    return sigs;
  };

  for (const [path, text] of files) {
    let ast;
    try {
      ast = toAst(text);
    } catch (e) {
      if (!blind('parse_blind')) refuse.push(`${path}: ${e.message}`);
      continue;
    }

    // local name -> {key, exported}
    const imported = new Map();
    if (!blind('imports_blind')) {
      for (const node of ast.program.body) {
        if (node.type !== 'ImportDeclaration') continue;
        const from = node.source.value;
        if (!from.startsWith('.')) continue;
        const key = from.replace(/^.*\//, '').replace(/\.js$/, '');
        for (const s of node.specifiers) {
          if (s.type !== 'ImportSpecifier') continue;
          const exported = s.imported.name || s.imported.value;
          imported.set(s.local.name, { key, exported });
        }
      }
    }
    if (imported.size === 0) continue;

    const shadowed = localNames(ast);

    walk(ast.program, (n) => {
      if (n.type !== 'CallExpression' && n.type !== 'OptionalCallExpression') return;
      if (!n.callee || n.callee.type !== 'Identifier') return;
      const hit = imported.get(n.callee.name);
      if (!hit) return;
      const where = `${path}:${n.loc ? n.loc.start.line : '?'} ${n.callee.name}`;
      if (shadowed.has(n.callee.name)) { skipped.push(`${where} (shadowed locally)`); return; }
      const sigs = sigsFor(hit.key);
      if (!sigs) { skipped.push(`${where} (no signature for ${hit.key})`); return; }
      const sig = sigs.get(hit.exported);
      // Not a function export, or a re-export whose signature lives elsewhere.
      if (!sig) { skipped.push(`${where} (${hit.key}.${hit.exported} is not a local function)`); return; }
      if (n.arguments.some((a) => a.type === 'SpreadElement')) {
        skipped.push(`${where} (spread argument)`);
        return;
      }
      const got = n.arguments.length;
      calls.push(where);
      const min = blind('min_blind') ? 0 : sig.min;
      const max = blind('max_blind') ? Infinity : sig.max;
      if (blind('arity_blind')) return;
      if (got < min || got > max) {
        const want = max === Infinity ? `${min} or more` : (min === max ? `${min}` : `${min}-${max}`);
        bad.push(`${where}(...) takes ${want} argument(s), called with ${got}`);
      }
    });
  }

  return { calls, bad, skipped, refuse };
}

// --- self-tests, on synthetic sources --------------------------------------

const FAKE_MODULE = [
  'export function needsThree(a, b, c) { return a + b + c; }',
  'export const hasDefault = (a, b = 2) => a + b;',
  'export function variadic(a, ...rest) { return rest.length + a; }',
  'export const NOT_A_FUNCTION = 7;',
].join('\n');

const FAKE_CONSUMER = [
  "import { needsThree, hasDefault, variadic, NOT_A_FUNCTION } from './fake';",
  'needsThree(1, 2);',
  'needsThree(1, 2, 3);',
  'needsThree(1, 2, 3, 4);',
  'hasDefault(1);',
  'hasDefault(1, 2);',
  'variadic(1, 2, 3, 4, 5);',
  'const n = NOT_A_FUNCTION;',
].join('\n');

console.log('the gate against a known-bad pair');
{
  const r = arityReport(
    new Map([['fake-consumer.js', FAKE_CONSUMER]]),
    new Map([['fake', FAKE_MODULE]]),
  );
  const says = (s) => r.bad.some((b) => b.includes(s));
  check('a call missing a required argument is caught',
    says('called with 2'), r.bad.join(' | ') || '(nothing reported)');
  check('a call with one argument too many is caught',
    says('called with 4'), r.bad.join(' | ') || '(nothing reported)');
  check('a defaulted parameter may be omitted',
    !r.bad.some((b) => b.includes('hasDefault')), r.bad.join(' | '));
  check('a rest parameter accepts any number',
    !r.bad.some((b) => b.includes('variadic')), r.bad.join(' | '));
  check('and nothing else is reported',
    r.bad.length === 2, `${r.bad.length} finding(s): ${r.bad.join(' | ')}`);
  check('a non-function export is skipped rather than checked',
    r.skipped.some((s) => s.includes('NOT_A_FUNCTION')) || !says('NOT_A_FUNCTION'),
    r.skipped.join(' | '));
}

console.log('the gate against a module it cannot read');
{
  const r = arityReport(
    new Map([['fake-consumer.js', "import { f } from './broken';\nf(1);"]]),
    new Map([['broken', 'export function f( {']]),
  );
  check('a module that will not parse is refused, not skipped',
    r.refuse.length === 1, `${r.refuse.length} refusal(s); skipped: ${r.skipped.join(' | ')}`);
}

console.log('the gate against a shadowed name');
{
  const src = [
    "import { needsThree } from './fake';",
    'function outer() { const needsThree = (x) => x; return needsThree(1); }',
  ].join('\n');
  const r = arityReport(new Map([['s.js', src]]), new Map([['fake', FAKE_MODULE]]));
  check('a locally shadowed import is skipped, and says so',
    r.bad.length === 0 && r.skipped.some((s) => s.includes('shadowed')),
    `bad: ${r.bad.join(' | ')}; skipped: ${r.skipped.join(' | ')}`);
}

// --- the real scan ----------------------------------------------------------
//
// DERIVED, not typed. A hand-kept file list is the hole check-imports.mjs has
// had four times.

const modules = new Map();
for (const f of readdirSync(SRC)) {
  if (!f.endsWith('.js')) continue;
  modules.set(f.replace(/\.js$/, ''), readFileSync(join(SRC, f), 'utf8'));
}

const files = new Map([['App.js', readFileSync('App.js', 'utf8')]]);
for (const [key, text] of modules) files.set(join(SRC, `${key}.js`), text);

console.log(`\nscanning ${files.size} files against ${modules.size} modules`);
const real = arityReport(files, modules);

check('the scan found modules to check against', modules.size > 5, `${modules.size} module(s)`);
check('the scan found calls to check', real.calls.length > 20, `${real.calls.length} call(s)`);
check('every module parsed', real.refuse.length === 0, real.refuse.join(' | '));
check('every call passes a legal number of arguments',
  real.bad.length === 0, `\n    ${real.bad.join('\n    ')}`);

// The synthetic fixtures above prove the comparison works. This proves it
// works on THIS tree: the same App.js, the same modules, with one extra call
// that is one argument short. Without it, a green here would also be what you
// see if the real scan silently matched nothing -- which is how the original
// bug survived check-imports and a clean export.
//
// The victim is DERIVED: the first name App.js already imports that needs at
// least one argument. Naming one would rot the moment it was renamed.
{
  const appText = files.get('App.js');
  const appImports = [...toAst(appText).program.body]
    .filter((n) => n.type === 'ImportDeclaration' && n.source.value.startsWith('.'))
    .flatMap((n) => n.specifiers
      .filter((s) => s.type === 'ImportSpecifier')
      .map((s) => ({
        local: s.local.name,
        key: n.source.value.replace(/^.*\//, '').replace(/\.js$/, ''),
        exported: s.imported.name || s.imported.value,
      })));
  let victim = null;
  for (const i of appImports) {
    const sig = (modules.has(i.key) ? signatures(modules.get(i.key)) : new Map()).get(i.exported);
    if (sig && sig.min >= 1) { victim = { ...i, sig }; break; }
  }
  check('App.js imports a function with a required argument to test against',
    victim !== null, `${appImports.length} import(s) scanned`);
  if (victim) {
    const short = new Array(victim.sig.min - 1).fill('0').join(', ');
    const hurt = new Map(files);
    hurt.set('App.js', `${appText}\n${victim.local}(${short});\n`);
    const r = arityReport(hurt, modules);
    check(`a real call one argument short is caught (${victim.local}, needs ${victim.sig.min})`,
      r.bad.length === 1 && r.bad[0].includes(victim.local),
      `${r.bad.length} finding(s): ${r.bad.join(' | ')}`);
  }
}

if (real.skipped.length) {
  console.log(`\n  ${real.skipped.length} call(s) not checked:`);
  for (const s of real.skipped) console.log(`    - ${s}`);
}

console.log(`\n${ran} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
