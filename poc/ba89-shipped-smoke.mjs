// VERIFY-SHIPPED-vs-POC (the step-8 discipline): exercise the SHIPPED recurse() — not a bespoke harness — with
// the new BA-9 (opts.context) and BA-8 (opts.refineLeaf) seams against a real model, to catch any integration/
// prompt surprise that offline scripted tests structurally cannot. maxDepth:0 forces each top node to be a LEAF
// (no spawn offered) so both seams engage at depth 0.
//
//   BA-9 arm: an unguessable temp-dir artifact + a read_file handle tool (opts.tools). With opts.context naming
//             the project root, the shipped Family-A leaf must locate + read it and report the secret token.
//   BA-8 arm: the toMinutes task + a deterministic sensor (opts.refineLeaf). The shipped leaf must run the
//             refine loop (receipts.refineLeaf present) and recover at least once across a couple of trials.
//
// Run:  OPENAI_API_KEY=$(pass amr/openai_api) node poc/ba89-shipped-smoke.mjs

import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
const require = createRequire(import.meta.url);
const { recurse } = require('../index.js');
const { AnthropicProvider } = require('../src/provider-anthropic.js');
const { OpenAIProvider } = require('../src/provider-openai.js');

let provider, providerName;
if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else { console.error('needs OPENAI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1); }

let fail = 0;

// ---- BA-9 shipped: context threads through recurse() so a leaf locates its file ----
const root = mkdtempSync(join(tmpdir(), 'ba89-'));
writeFileSync(join(root, 'ma.js'), 'function frobnicate(a,b){ return a*b + 7; }\nmodule.exports = { frobnicate };\n');
const readFile = {
  name: 'read_file',
  description: 'Read a file by path. Returns contents, or an error if out of scope / missing.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async ({ path: p }) => {
    const abs = resolve(typeof p === 'string' ? p : '');
    if (abs !== root && !abs.startsWith(root + sep)) return `[denied] out of scope: ${abs}`;
    if (!existsSync(abs)) return `[error] ENOENT: ${abs}`;
    return readFileSync(abs, 'utf8');
  },
};
const ba9 = await recurse(
  'Open the file ma.js, then report the exact name of the function it defines. You MUST read the file first.',
  { provider },
  { context: `project root: ${root}\nresolve relative paths against it`, tools: [readFile], maxDepth: 0 },
);
const ba9ok = /frobnicate/.test(String(ba9.result || ba9.best || ''));
console.log(`[BA-9 shipped] ${ba9ok ? 'PASS' : 'FAIL'} — leaf ${ba9ok ? 'located+read the file via threaded context' : 'did NOT find it'}; result=${JSON.stringify(String(ba9.result || ba9.best || '').slice(0, 60))}`);
if (!ba9ok) fail++;
rmSync(root, { recursive: true, force: true });

// ---- BA-8 shipped: refineLeaf runs the refine loop inside recurse() and recovers ----
const CASES = [['2h15m', 135], ['1h', 60], ['90m', 90], ['0m', 0], ['abc', null], ['', null], ['1x', null]];
function buildFn(text) {
  let s = String(text || '').replace(/```[a-zA-Z]*\n?/g, '').trim();
  const t = (src) => { try { const fn = new Function(`${src}\n; return toMinutes;`)(); return typeof fn === 'function' ? fn : null; } catch { return null; } };
  const C = [s]; const d = s.search(/(function\s+toMinutes|(?:const|let|var)\s+toMinutes\s*=)/);
  if (d >= 0) { const fd = s.slice(d); C.push(fd); const L = fd.split('\n'); for (let n = L.length; n > 0; n--) C.push(L.slice(0, n).join('\n')); }
  for (const c of C) { const fn = t(c); if (fn) return fn; } return null;
}
const sensor = (result) => {
  const fn = buildFn(result);
  if (!fn) return { status: 'needs_revision', pass: false, score: 0, critique: 'Output must be a single function toMinutes(s){...} with no prose.', suggestions: [] };
  const fails = [];
  for (const [i, e] of CASES) { let g; try { g = fn(i); } catch (x) { g = `threw ${x.message}`; } if (g !== e) fails.push(`toMinutes(${JSON.stringify(i)}) expected ${JSON.stringify(e)} but got ${JSON.stringify(g)}`); }
  return fails.length ? { status: 'needs_revision', pass: false, score: 1 - fails.length / CASES.length, critique: 'Failing cases:\n- ' + fails.join('\n- '), suggestions: [] }
    : { status: 'satisfied', pass: true, score: 1, critique: '', suggestions: [] };
};
const GOAL = 'Write a JavaScript function `toMinutes(s)` converting a duration like "2h15m","1h","90m","0m" to total minutes; return null for any invalid input (e.g. "abc","","1x"). Return ONLY the function source, no prose.';
let recovered = 0, ranRefine = 0;
for (let t = 0; t < 2; t++) {
  const out = await recurse(GOAL, { provider }, { refineLeaf: { sensor }, maxDepth: 0 });
  const rl = out.receipts && out.receipts.refineLeaf;
  if (rl) ranRefine++;
  if (rl && rl.passed) recovered++;
  console.log(`[BA-8 shipped] trial ${t}: refineLeaf=${rl ? `{iters:${rl.iterations}, passed:${rl.passed}, temps:${JSON.stringify(rl.temperatures)}}` : 'ABSENT'}`);
}
const ba8ok = ranRefine === 2 && recovered >= 1; // the loop ran both trials; recovered at least once
console.log(`[BA-8 shipped] ${ba8ok ? 'PASS' : 'FAIL'} — refine ran ${ranRefine}/2, recovered ${recovered}/2`);
if (!ba8ok) fail++;

console.log(`\n[VERDICT] shipped recurse() with BA-8 + BA-9 on ${providerName}: ${fail === 0 ? 'BOTH SOUND' : fail + ' arm(s) FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
