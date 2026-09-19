#!/usr/bin/env node
// Generate primitives.json from JSDoc. A primitive is any exported symbol whose
// JSDoc carries an @when tag. Signature/import are derived; @when/@fails are the
// only hand-authored fields. Run in any bare-suite repo (reads its package.json).
//
//   node scripts/gen-primitives.mjs           # write ./primitives.json
//   node scripts/gen-primitives.mjs --check    # CI gate: verify the file is current + valid, write nothing
//
// See docs/product/prd.md § "Primitives manifest".
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve, basename } from 'node:path';

const CWD = process.cwd();
const CHECK = process.argv.includes('--check');
const pkg = JSON.parse(readFileSync(join(CWD, 'package.json'), 'utf8'));

// --- JSDoc extraction ---------------------------------------------------------
const strip = (l) => l.replace(/^\s*\*\s?/, '');
function braced(s) {
  const start = s.indexOf('{'); if (start === -1) return null;
  let d = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') d++;
    else if (s[i] === '}' && --d === 0) return { inner: s.slice(start + 1, i), rest: s.slice(i + 1) };
  }
  return null;
}
function parseBlock(block) {
  const inner = block.replace(/^\/\*\*/, '').replace(/\*\/\s*$/, '');
  const params = []; let returns = null, when = null, fails = null, category = null, primName = null;
  const example = []; let mode = null;
  for (const raw of inner.split('\n').map(strip)) {
    const tag = raw.trimEnd().match(/^@(\w+)\s*(.*)$/);
    if (tag) {
      mode = null; const [, name, rest] = tag;
      if (name === 'param') {
        const b = braced(rest); const nm = b && b.rest.match(/^\s*(\[?)([\w.$]+)/);
        if (b && nm && !nm[2].includes('.')) params.push({ name: nm[2], type: b.inner, optional: nm[1] === '[' });
      } else if (name === 'returns') { const b = braced(rest); returns = b ? b.inner : null; }
      else if (name === 'when') when = rest.trim();
      else if (name === 'fails') fails = rest.trim();
      else if (name === 'category') category = rest.trim();
      else if (name === 'name') primName = rest.trim(); // override when the export name differs from the declaration (alias)
      else if (name === 'example') mode = 'example';
      continue;
    }
    if (mode === 'example') example.push(raw.replace(/^\s{0,3}/, ''));
  }
  while (example.length && !example[0].trim()) example.shift();
  while (example.length && !example[example.length - 1].trim()) example.pop();
  return { params, returns, when, fails, category, primName, example: example.join('\n') };
}
function symbolAfter(src, afterIdx) {
  const tail = src.slice(afterIdx);
  const decl = tail.match(/^\s*(?:export\s+)?(?:async\s+)?(function|class)\s+([A-Za-z0-9_$]+)/);
  if (decl) return { name: decl[2], kind: decl[1] === 'class' ? 'class' : 'function' };
  if (/^\s*(?:async\s+)?constructor\s*\(/.test(tail)) {
    const cm = [...src.slice(0, afterIdx).matchAll(/class\s+([A-Za-z0-9_$]+)/g)].pop();
    if (cm) return { name: cm[1], kind: 'class' };
  }
  const cst = tail.match(/^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=/);
  if (cst) return { name: cst[1], kind: 'function' };
  return null;
}
function signature(sym, p) {
  const args = p.params.map(a => `${a.name}${a.optional ? '?' : ''}: ${a.type}`).join(', ');
  return sym.kind === 'class' ? `new ${sym.name}(${args})` : `${sym.name}(${args})${p.returns ? ` => ${p.returns}` : ''}`;
}

// --- category inference (filename -> category; @category overrides) -----------
function inferCategory(file) {
  if (file.startsWith('tools/') || file.startsWith('tools\\')) return 'tools';
  const b = basename(file, '.js');
  if (b === 'loop') return 'loop';
  if (/^transport-/.test(b)) return 'transports';
  if (b === 'recurse-retrieval') return 'retrieval';
  if (/^recurse/.test(b) || b === 'planner' || b === 'run-plan') return 'orchestration';
  if (['evaluator', 'refine', 'remember'].includes(b) || /^judge/.test(b)) return 'evaluation';
  if (b === 'complexity') return 'routing';
  if (b === 'skills' || b === 'stash') return 'skills';
  if (b === 'bareguard-adapter') return 'governance';
  if (/^provider-/.test(b)) return 'providers';
  if (/^store-/.test(b)) return 'stores';
  if (b === 'memory') return 'memory';
  if (b === 'retry' || b === 'circuit-breaker') return 'resilience';
  if (b === 'stream') return 'observability';
  if (b === 'scheduler') return 'scheduling';
  if (b === 'state') return 'state';
  if (b === 'checkpoint') return 'hitl';
  if (/^mcp/.test(b)) return 'mcp';
  if (b === 'context-units') return 'context';
  return 'core';
}

// --- import-path resolution from the exports map ------------------------------
async function exportIndex() {
  const map = new Map(); // symbol -> subpath specifier (prefers main '.')
  const exp = pkg.exports || { '.': { default: pkg.main || './index.js' } };
  for (const [sub, entry] of Object.entries(exp)) {
    const file = typeof entry === 'string' ? entry : entry.default || entry.import || entry.require;
    if (!file) continue;
    const abs = resolve(CWD, file);
    if (!existsSync(abs)) continue;
    let names = [];
    try { names = Object.keys(await import(pathToFileURL(abs).href)).filter(n => n !== 'default'); }
    catch { continue; }
    const spec = sub === '.' ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, '')}`;
    for (const n of names) {
      // prefer the main barrel when a symbol is re-exported from several
      if (!map.has(n) || sub === '.') map.set(n, spec);
    }
  }
  return map;
}

// --- scan --------------------------------------------------------------------
// Scan every shipped source root that exists (src/ always; tools/ when present).
// bareguard/litectx have only src/ and are unaffected.
const ROOTS = ['src', 'tools'].filter(d => existsSync(join(CWD, d)));
const imports = await exportIndex();
const out = [], problems = [];
const jsFiles = ROOTS.flatMap(d => readdirSync(join(CWD, d)).filter(f => f.endsWith('.js')).map(f => join(d, f)));
for (const rel of jsFiles) {
  const f = basename(rel);
  const src = readFileSync(join(CWD, rel), 'utf8');
  const re = /\/\*\*[\s\S]*?\*\//g; let m;
  while ((m = re.exec(src))) {
    if (!/@when\b/.test(m[0])) continue;
    const sym = symbolAfter(src, m.index + m[0].length);
    if (!sym) { problems.push(`${f}: @when block has no resolvable symbol`); continue; }
    const p = parseBlock(m[0]);
    const name = p.primName || sym.name; // @name overrides an aliased export
    for (const req of ['when', 'fails', 'example']) if (!p[req]) problems.push(`${name}: missing @${req}`);
    const spec = imports.get(name);
    if (!spec) problems.push(`${name}: not found in any exports barrel (is it exported?)`);
    out.push({
      name,
      category: p.category || inferCategory(rel),
      when: p.when,
      import: `import { ${name} } from '${spec || pkg.name}'`,
      signature: signature({ ...sym, name }, p),
      fails: p.fails,
      example: p.example,
    });
  }
}
out.sort((a, b) => a.name.localeCompare(b.name));
const manifest = { package: pkg.name, version: pkg.version, primitives: out };
const json = JSON.stringify(manifest, null, 2) + '\n';
const target = join(CWD, 'primitives.json');

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
} else {
  writeFileSync(target, json);
  console.error(`✓ wrote primitives.json — ${out.length} primitive(s): ${out.map(e => e.name).join(', ')}`);
}
