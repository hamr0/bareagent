// Shared primitives.json generator core — VENDORED byte-identically into every
// bare-suite repo (bare-agent, bareguard, litectx). The canonical copy lives
// here (bare-agent); each other repo keeps an exact copy at the same path plus
// its own tiny `primitives.config.mjs` (repo-specific bits: source roots,
// category inference, method-receiver names). A per-repo pin test
// (test/primitives-core.test.js, also vendored) hashes this file against a
// pinned SHA-256 and fails loudly if the bytes drift — so a fix or feature
// lands ONCE, here, and is deliberately re-vendored everywhere rather than
// silently diverging again. See docs/product/prd.md § "Primitives manifest".
//
// A primitive is any exported symbol — or any documented method of an
// exported class — whose JSDoc carries an `@when` tag. `@when`/`@fails` are
// the only hand-authored catalog fields; import/signature are derived.
//
// Union of every rule the three repos' drifted copies relied on (nothing any
// repo needs is dropped — see the PRD decision log for the full audit):
//   * JSDoc-correct tag parsing: a tag's body is every line up to the next
//     tag or the end of the comment (RULE A) — not shape-by-shape guessing
//     about what a "continuation" looks like (blank line, whitespace-only
//     star line, a line that itself starts with @word all used to need their
//     own case in the three drifted copies; this one rule covers all of them).
//   * `@when`/`@fails`/`@category`/`@name`/`@signature` must be single-line —
//     a body spanning more than one non-empty line fails loudly (RULE B).
//   * An unknown `@tag` inside a `@when` block fails, with an alias hint
//     (return/arg/argument/exception/prop) (RULE C).
//   * `@example` MUST be the LAST tag in a block (RULE D, strict). Once open,
//     a KNOWN_TAGS line is a HARD ERROR — non-zero exit, nothing written,
//     naming the offending tag and telling the author to move `@example` to
//     the end of the block (or prefix the line inside the example, e.g.
//     `// @type`, if it's meant as content). Anything else (a decorator, a
//     typo, any other `@word`-shaped line in a code sample) is unambiguous
//     example CONTENT, kept verbatim. No outcome is ever silent: a real tag
//     is never swallowed into an example (that would silently corrupt a
//     derived `signature`/`fails` with zero warning — see bareguard's
//     `addToGates`, which has `@param`/`@returns`/`@throws` genuinely AFTER
//     `@example` in its actual source and would otherwise degrade to a
//     garbage signature with exit 0), and an example is never silently
//     truncated either. RULE D closes two DISTINCT, separately-verified holes
//     in the three repos' pre-shared copies: litectx's `mode`-based parser
//     closed `@example` on ANY `@word` line, including a non-tag decorator
//     (bareguard did NOT have this one — verified by running bareguard's own
//     pre-shared generator against a decorator fixture); and ALL THREE
//     (including bare-agent's own pre-core copy) closed `@example` on a
//     KNOWN_TAGS line and silently re-applied it as a real tag, truncating
//     the example with zero warning (verified by running all three repos'
//     old generators against a fixture with a known tag inside `@example`).
//   * Class methods (litectx's LiteCtx/ScopedView verbs, bareguard's
//     Gate#add/#rwxTools/#readAudit) are a resolvable symbol kind: the
//     enclosing class is found via a LINE-ANCHORED class-declaration scan (a
//     loose `/class\s+\w+/` can match prose — litectx's source has "first-
//     class" — so anchoring to `^\s*(?:export )?(?:default )?class Name`
//     matters). An explicit `@name Class#method` override (bareguard's style)
//     always wins for the catalog `name`; without one the method is still
//     resolvable (litectx's style — no @name needed) and its plain signature
//     renders as `receiver.method(args)` using a small, config-overridable
//     receiver-name map (default: lowercase-first-letter of the class name).
//     `@signature` always overrides both (bareguard's Gate methods use it).
//   * A non-callable exported `const` (an array/object/frozen table) is a
//     VALUE, not a phantom call — `NAME: Type`, never `NAME()`.
//   * Source scan is RECURSIVE (bareguard's primitives live in
//     src/primitives/*.js) and Windows-safe: symlinks are skipped, `readdir`
//     is walked by hand (not `{recursive:true}`, which only landed in Node
//     18.17 — the suite's floor is bare Node 18), files are visited in a
//     SORTED order for deterministic output/error ordering, and every
//     relative path handed to `config.inferCategory` is POSIX-normalized
//     (`\` -> `/`) so a category rule never has to special-case a checkout's
//     platform.
//   * The exports-map barrel index skips non-JS subpaths (a `.json` data
//     export) before attempting to `import()` them, and a barrel that FAILS
//     to import is a distinct, loud, fail-fast error — not silently treated
//     as "this barrel exports nothing" (which would misreport every one of
//     its primitives as "not found in barrel", burying the real cause).
//   * No `version` field: package.json ships in the same tarball and is the
//     single authority; a version stamped here is a pin that only ever goes
//     stale (settled across all three repos).
//
// Repo-specific bits are NOT here: `config.inferCategory(posixRelPath)`
// (required), `config.sourceRoots` (default `['src', 'tools']`), and
// `config.receivers` (default `{}`, method-signature receiver names) all live
// in each repo's own `primitives.config.mjs`.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve, basename, relative, sep } from 'node:path';

// --- JSDoc extraction ---------------------------------------------------------
const strip = (l) => l.replace(/^\s*\*\s?/, '');
// A JSDoc type is written for tsc, which resolves `import("./x").T` relative to
// the SOURCE file. Read out of node_modules that path means nothing, so strip the
// import() wrapper and keep the bare type name for the manifest's human reader.
const cleanType = (t) => (t || '').replace(/import\((["'])[^"')]+\1\)\./g, '');
function braced(s) {
  const start = s.indexOf('{'); if (start === -1) return null;
  let d = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}' && --d === 0) return { inner: s.slice(start + 1, i), rest: s.slice(i + 1) };
  }
  return null;
}
// Tags parseBlock understands — the UNION of every tag any of the three
// repos' @when blocks actually use alongside them (param/returns/type/
// signature/when/fails/category/name/example are common to all three;
// property/typedef come from bare-agent's inline object-shape docs; throws
// from bareguard/litectx; template from bareguard's generic `redact<T>`).
// This is a FIXED, hand-maintained list, not auto-computed: adding a new tag
// to a @when block means adding it here by hand, and the check fails loudly
// (unknown tag) until you do. Only a block carrying @when is parsed at all,
// so an unrecognized tag there is exactly the trap this set exists to catch:
// a generator that silently ignores a tag it doesn't handle (see RULE A/D).
const KNOWN_TAGS = new Set([
  'param', 'returns', 'type', 'signature', 'when', 'fails', 'category',
  'name', 'example', 'property', 'throws', 'typedef', 'template',
]);
// Common JSDoc aliases for tags in KNOWN_TAGS — surfaced as a hint when an
// unknown tag matches one, so a typo'd/aliased tag doesn't need a source dig.
const ALIASES = { return: 'returns', arg: 'param', argument: 'param', exception: 'throws', prop: 'property' };
// Hand-authored tags whose value the manifest reads from only the FIRST line
// of the tag's body — the same truncation trap @when/@fails had: a wrapped
// second line silently vanishes instead of being flagged. @param/@returns/
// @type/@example are exempt: @param/@returns/@type read their value out of a
// `{...}` brace on the tag line itself (a later body line is unused prose,
// not a silently-dropped value), and @example's whole BODY is the value by
// design (see the loop below).
const ONE_LINE_TAGS = new Set(['when', 'fails', 'category', 'name', 'signature']);
function spanMessage(tag) {
  // @when/@fails keep their original joint wording (both are the catalog's
  // one-line fields); the others name themselves.
  const keep = tag === 'when' || tag === 'fails' ? '@when/@fails' : `@${tag}`;
  return `@${tag} spans more than one line — keep ${keep} on one line (the manifest reads only the first)`;
}
function parseBlock(block) {
  const inner = block.replace(/^\/\*\*/, '').replace(/\*\/\s*$/, '');
  // Parse the way JSDoc itself does (RULE A): a tag's BODY is every line from
  // the tag line up to the next tag-boundary line or the end of the comment —
  // no shape-by-shape guessing about what counts as a "continuation" (a blank
  // line, a whitespace-only star line, and a line that itself starts with
  // @word all used to need their own case; this one rule covers all of them).
  //
  // The one deliberate exception is @example (RULE D, strict): @example must
  // be the LAST tag in a block. Once its body is open, NOTHING closes it —
  // a line that merely LOOKS like a tag (a decorator, a typo, any other
  // `@word`-shaped line in a code sample) is unambiguous example CONTENT. A
  // line that IS a real KNOWN_TAGS tag is a HARD ERROR instead of silently
  // reopening as a tag (which would corrupt a derived field with zero
  // warning) or silently becoming content (which would silently swallow a
  // real, intended tag — e.g. bareguard's `addToGates`, whose real
  // `@param`/`@returns`/`@throws` genuinely follow `@example` in source and
  // must therefore error, not vanish). Recorded in `problems` below, once per
  // occurrence; the block is rejected either way, so the swallowed content
  // itself is discarded, never written.
  const segments = [];
  const problems = [];
  for (const raw of inner.split('\n').map(strip)) {
    const tag = raw.trimEnd().match(/^@(\w+)\s*(.*)$/);
    const openExample = segments.length && segments[segments.length - 1].tag === 'example';
    if (openExample) {
      if (tag && KNOWN_TAGS.has(tag[1])) {
        problems.push(`@${tag[1]} appears after @example — @example must be the last tag: move @example to the end of the block (or prefix the line inside the example, e.g. "// @${tag[1]}")`);
      }
      segments[segments.length - 1].body.push(raw);
      continue;
    }
    if (tag) {
      segments.push({ tag: tag[1], rest: tag[2], body: [] });
    } else if (segments.length) {
      segments[segments.length - 1].body.push(raw);
    }
  }
  const params = []; let returns = null, when = null, fails = null, category = null, primName = null;
  let type = null, sigOverride = null;
  const example = [];
  for (const { tag: name, rest, body } of segments) {
    if (name === 'param') {
      const b = braced(rest); const nm = b && b.rest.match(/^\s*(\[?)([\w.$]+)/);
      if (b && nm && !nm[2].includes('.')) params.push({ name: nm[2], type: cleanType(b.inner), optional: nm[1] === '[' });
    } else if (name === 'returns') { const b = braced(rest); returns = b ? cleanType(b.inner) : null; }
    else if (name === 'type') { const b = braced(rest); type = b ? cleanType(b.inner) : null; }
    else if (name === 'signature') sigOverride = rest.trim(); // exact literal, overrides the derived signature
    else if (name === 'when') when = rest.trim();
    else if (name === 'fails') fails = rest.trim();
    else if (name === 'category') category = rest.trim();
    else if (name === 'name') primName = rest.trim(); // override when the export name differs from the declaration (alias/method)
    else if (name === 'example') example.push(...body);
    if (ONE_LINE_TAGS.has(name) && body.some(l => l.trim())) problems.push(spanMessage(name));
    if (!KNOWN_TAGS.has(name)) {
      const hint = ALIASES[name] ? ` (did you mean @${ALIASES[name]}?)` : '';
      problems.push(`unknown tag @${name}${hint} — if this is a wrapped @when/@fails line, keep them on one line; otherwise add the tag to KNOWN_TAGS`);
    }
  }
  while (example.length && !example[0].trim()) example.shift();
  while (example.length && !example[example.length - 1].trim()) example.pop();
  // Dedent by the COMMON leading-whitespace prefix so nested literals/blocks keep
  // their RELATIVE indentation (a fixed 0-3 char cut flattened multi-line examples).
  const indents = example.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length);
  const pad = indents.length ? Math.min(...indents) : 0;
  if (pad) for (let i = 0; i < example.length; i++) example[i] = example[i].slice(pad);
  return { params, returns, type, sigOverride, when, fails, category, primName, example: example.join('\n'), problems };
}

// JS keywords / control-flow words a method-shaped line could start with — a
// `@when` only ever sits above a real method, but this is cheap insurance
// against a control-flow line (`if (`, `for (`, …) reading as one.
const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'constructor',
  'function', 'async', 'await', 'new', 'typeof', 'throw', 'do', 'else',
]);
// The enclosing class: the nearest class DECLARATION before `idx`, matched
// LINE-ANCHORED (`^\s*(export )?(default )?class Name`) so prose that merely
// contains the word "class" (litectx's source has "first-class") can never
// be mistaken for a declaration.
function enclosingClass(src, idx) {
  const cm = [...src.slice(0, idx).matchAll(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)/gm)].pop();
  return cm ? cm[1] : null;
}
function symbolAfter(src, afterIdx) {
  const tail = src.slice(afterIdx);
  const decl = tail.match(/^\s*(?:export\s+)?(?:async\s+)?(function|class)\s+([A-Za-z0-9_$]+)/);
  if (decl) return { name: decl[2], kind: decl[1] === 'class' ? 'class' : 'function' };
  if (/^\s*(?:async\s+)?constructor\s*\(/.test(tail)) {
    const cls = enclosingClass(src, afterIdx);
    if (cls) return { name: cls, kind: 'class' };
  }
  // A const bound to a function/arrow is a callable; a const bound to DATA is a
  // value — rendering the latter as `X()` invents an API that does not exist.
  const cst = tail.match(/^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*([\s\S]{0,40})/);
  if (cst) {
    const callable = /^(?:async\s+)?(?:function\b|<[^>]*>\s*\(|\((?:[^()]|\([^()]*\))*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/.test(cst[2]);
    return { name: cst[1], kind: callable ? 'function' : 'value' };
  }
  // LAST: a CLASS METHOD (e.g. `async add(entries) {` inside `export class
  // Gate`, or litectx's `recall(query, opts) {` inside `class LiteCtx`).
  // Handles static/async/get/set/generator prefixes. Requires an enclosing
  // class (the same backscan the constructor branch uses) so a top-level
  // bare `foo()` expression can't read as a method, and excludes a leading
  // `_` (private-by-convention) the same way NOT_A_METHOD excludes keywords.
  const meth = tail.match(/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+|\*\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (meth && !NOT_A_METHOD.has(meth[1]) && !meth[1].startsWith('_')) {
    const isStatic = /^\s*static\b/.test(tail);
    const cls = enclosingClass(src, afterIdx);
    if (cls) return { name: meth[1], kind: 'method', className: cls, static: isStatic };
  }
  return null;
}
function signature(sym, p, receivers) {
  if (p.sigOverride) return p.sigOverride;
  if (sym.kind === 'value') return `${sym.name}: ${cleanType(p.type) || 'unknown'}`;
  const args = p.params.map(a => `${a.name}${a.optional ? '?' : ''}: ${cleanType(a.type)}`).join(', ');
  const ret = p.returns ? ` => ${cleanType(p.returns)}` : '';
  if (sym.kind === 'class') return `new ${sym.name}(${args})`;
  if (sym.kind === 'method') {
    // An explicit @name override (bareguard's "Gate#add" style) already IS
    // the display name by the time `sym.name` reaches here — render it as a
    // plain call, matching bareguard's shipped output. Without an override
    // (litectx's style), render `receiver.method(args)` using the
    // config-supplied receiver map (falls back to lowercase-first-letter).
    if (p.primName) return `${sym.name}(${args})${ret}`;
    const recv = sym.static ? sym.className : (receivers[sym.className] || (sym.className[0].toLowerCase() + sym.className.slice(1)));
    return `${recv}.${sym.name}(${args})${ret}`;
  }
  return `${sym.name}(${args})${ret}`;
}

// --- import-path resolution from the exports map ------------------------------
async function exportIndex(cwd, pkg) {
  const map = new Map(); // symbol -> subpath specifier (prefers main '.')
  const importErrors = []; // a barrel that FAILS to import is a distinct, loud failure...
  const exp = pkg.exports || { '.': { default: pkg.main || './index.js' } };
  for (const [sub, entry] of Object.entries(exp)) {
    const file = typeof entry === 'string' ? entry : entry.default || entry.import || entry.require;
    if (!file) continue;
    const target = typeof file === 'string' ? file : file.default;
    // Only JS barrels export symbols. Skip a data subpath (e.g. "./primitives.json"
    // itself) before even attempting to import() it — importing one would throw
    // ("needs an import attribute of type: json") and, since a barrel-import
    // failure is fatal by design below, would abort the whole generation.
    if (typeof target !== 'string' || !/\.(js|mjs|cjs)$/.test(target)) continue;
    const abs = resolve(cwd, target);
    if (!existsSync(abs)) continue;
    let names = [];
    // Runtime import (not a static scan) so `export { X } from './y'` re-exports
    // resolve to their real names. The cost: importing the barrel loads its
    // runtime deps. If that throws (unbuilt native binding, ABI mismatch, a
    // genuine syntax error), record it as its OWN error — swallowing it would
    // leave the map empty and mislabel every primitive "not found in barrel",
    // hiding the real cause.
    try { names = Object.keys(await import(pathToFileURL(abs).href)).filter(n => n !== 'default'); }
    catch (e) { importErrors.push(`could not import exports barrel "${file}": ${e.message}`); continue; }
    const spec = sub === '.' ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, '')}`;
    for (const n of names) {
      // prefer the main barrel when a symbol is re-exported from several
      if (!map.has(n) || sub === '.') map.set(n, spec);
    }
  }
  return { map, importErrors };
}

// --- scan --------------------------------------------------------------------
// A hand-rolled recursive walker (not readdirSync's `recursive` option, which
// only landed in Node 18.17 — the suite's floor is bare Node 18) so nested
// layouts like bareguard's src/primitives/*.js are seen; skips symlinks.
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) return [];
    return e.isDirectory() ? walk(join(dir, e.name))
      : e.name.endsWith('.js') ? [join(dir, e.name)] : [];
  });
}
const toPosix = (p) => p.split(sep).join('/');

/**
 * Run the shared generator against `cwd`, using `config` for the repo-specific
 * bits. Mirrors every one of the three drifted generators' CLI behavior
 * exactly: writes `primitives.json` (or, under `--check`, verifies it is
 * current) and exits 1 with every problem printed on a single bad run —
 * nothing is ever written on failure.
 * @param {object} config
 * @param {(posixRelPath: string) => string} config.inferCategory required —
 *   maps a source file's POSIX-normalized path (relative to `cwd`) to a
 *   category; `@category` on the JSDoc block always overrides it.
 * @param {string[]} [config.sourceRoots] source dirs to scan, relative to
 *   `cwd`; only the ones that exist are scanned. Default `['src', 'tools']`.
 * @param {Object<string,string>} [config.receivers] class name -> receiver
 *   variable name for an auto-derived (no explicit @name) method signature,
 *   e.g. `{LiteCtx: 'liteCtx'}` -> `liteCtx.recall(...)`. Default `{}`
 *   (falls back to lowercase-first-letter of the class name).
 * @param {string[]} [config.argv] defaults to `process.argv`; pass `[node,
 *   script, '--check']`-shaped array to control the `--check` flag in tests.
 * @param {string} [config.cwd] defaults to `process.cwd()`.
 * @returns {Promise<never>} never returns — calls `process.exit()`, matching
 *   every prior generator's CLI contract (tests drive this over a child
 *   process, never by import).
 */
export async function run(config) {
  const cwd = config.cwd || process.cwd();
  const argv = config.argv || process.argv;
  const CHECK = argv.includes('--check');
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const receivers = config.receivers || {};
  const roots = (config.sourceRoots || ['src', 'tools']).filter(d => existsSync(join(cwd, d)));

  const { map: imports, importErrors } = await exportIndex(cwd, pkg);
  // A barrel that failed to load resolves NOTHING — bail with the real cause
  // rather than proceed to flag every primitive "not found in barrel" (which
  // would bury this behind noise).
  if (importErrors.length) {
    console.error(`✗ could not build the exports index — fix this before generating:\n  ` + importErrors.join('\n  '));
    process.exit(1);
  }

  const out = [], problems = [];
  const jsFiles = roots.flatMap(d => walk(join(cwd, d)).map(abs => toPosix(relative(cwd, abs)))).sort();
  for (const rel of jsFiles) {
    const f = basename(rel);
    const src = readFileSync(join(cwd, rel), 'utf8');
    const re = /\/\*\*[\s\S]*?\*\//g; let m;
    while ((m = re.exec(src))) {
      if (!/@when\b/.test(m[0])) continue;
      const sym = symbolAfter(src, m.index + m[0].length);
      if (!sym) { problems.push(`${f}: @when block has no resolvable symbol`); continue; }
      const p = parseBlock(m[0]);
      // @name overrides an aliased export, or names/labels a method
      // (bareguard's "Gate#add" style); without one a method still resolves
      // via its bare method name (litectx's style — no @name required).
      const name = p.primName || sym.name;
      for (const req of ['when', 'fails', 'example']) if (!p[req]) problems.push(`${name}: missing @${req}`);
      for (const msg of p.problems) problems.push(`${name}: ${msg}`);
      // A method is never itself exported — its ENCLOSING CLASS is what a
      // caller imports; the method is reached off an instance/class ref.
      const specKey = sym.kind === 'method' ? sym.className : name;
      const spec = imports.get(specKey);
      if (!spec) problems.push(`${name}: not found in any exports barrel (is ${specKey} exported?)`);
      out.push({
        name,
        category: p.category || config.inferCategory(rel),
        when: p.when,
        import: `import { ${specKey} } from '${spec || pkg.name}'`,
        signature: signature({ ...sym, name }, p, receivers),
        fails: p.fails,
        example: p.example,
      });
    }
  }
  // Two @when blocks resolving to the same catalog `name` (e.g. two classes
  // each with an unnamed `add` method) is a HARD ERROR, not a silent
  // last-write-wins collision — two catalog entries sharing one `name` is an
  // ambiguous manifest a consumer's `import { add }` can't disambiguate.
  // Checked over every entry (not just methods): the same trap applies to a
  // manual `@name` collision. Reported once per duplicated name, listing the
  // count, so a fix is a single glance away.
  const nameCounts = new Map();
  for (const o of out) nameCounts.set(o.name, (nameCounts.get(o.name) || 0) + 1);
  for (const [dupName, count] of nameCounts) {
    if (count > 1) problems.push(`duplicate primitive name "${dupName}" (${count} occurrences) — give each a distinct @name (e.g. "@name Class#method")`);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  // No `version` field by design: package.json sits beside the manifest in the
  // same tarball with the authoritative version, so a copy here would only be a
  // pin that goes silently stale on every release. The manifest is pure content.
  const manifest = { package: pkg.name, primitives: out };
  const json = JSON.stringify(manifest, null, 2) + '\n';
  const target = join(cwd, 'primitives.json');

  if (problems.length) {
    console.error(`✗ ${problems.length} problem(s):\n  ` + problems.join('\n  '));
    process.exit(1);
  }
  if (CHECK) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current !== json) {
      console.error('✗ primitives.json is stale — run `npm run build:primitives` and commit the result.');
      process.exit(1);
    }
    console.error(`✓ primitives.json current — ${out.length} primitive(s).`);
    process.exit(0);
  } else {
    writeFileSync(target, json);
    console.error(`✓ wrote primitives.json — ${out.length} primitive(s): ${out.map(e => e.name).join(', ')}`);
    process.exit(0);
  }
}
