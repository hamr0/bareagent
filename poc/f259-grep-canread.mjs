// F259 POC: a root shell_grep bypasses bareguard fs.deny (gate sees only the root path).
// Default arm must LEAK (negative control); canRead arm must not. Exit non-zero otherwise.
// `--time`: median-of-5 timing on this repo root (includes node_modules).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { Gate } = require('bareguard');
const { createShellTools } = require('../tools/shell');

const real = fs.realpathSync(os.tmpdir());
async function mkGate(readScope, deny) {
  const gate = new Gate({
    fs: { readScope, writeScope: [], deny },
    budget: { maxCostUsd: 1 }, limits: { maxTurns: 50 },
    audit: { path: path.join(fs.mkdtempSync(path.join(real, 'f259-audit-')), 'a.jsonl') },
    humanChannel: async () => ({ decision: 'terminate' }),
  });
  await gate.init();
  return gate;
}
const grepTool = (opts) => createShellTools(opts).tools.find((t) => t.name === 'shell_grep');

if (process.argv.includes('--time')) {
  const repo = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const gate = await mkGate([repo], [path.join(repo, 'node_modules', '.cache')]);
  let calls = 0;
  const canRead = (p, { tool }) => { calls++; return gate.allows({ type: 'read', tool, path: p }); };
  const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const args = { pattern: 'F259_RARE_PATTERN_ZZZ', path: repo, timeout: 120000 };
  for (const [label, opts] of [['canRead unset', {}], ['canRead=gate.allows', { canRead }]]) {
    const t = grepTool(opts); const ms = []; let r; const c0 = calls;
    for (let i = 0; i < 5; i++) { const s = performance.now(); r = await t.execute(args); ms.push(performance.now() - s); }
    console.log(`${label}: median ${med(ms).toFixed(0)}ms  runs=[${ms.map((x) => x.toFixed(0))}]  files=${r.fileCount}  canRead calls/run=${(calls - c0) / 5}`);
  }
  process.exit(0);
}

const wd = fs.mkdtempSync(path.join(real, 'f259-'));
const put = (p, s) => { fs.mkdirSync(path.dirname(path.join(wd, p)), { recursive: true }); fs.writeFileSync(path.join(wd, p), s + '\n'); };
put('src/a.js', 'MARKER_SRC'); put('.smoke/spine.jsonl', 'MARKER_SPINE');
put('.litectx/x', 'MARKER_LITECTX'); put('gate-audit.jsonl', 'MARKER_AUDIT');
const gate = await mkGate([wd], ['.smoke', '.litectx', 'gate-audit.jsonl'].map((p) => path.join(wd, p)));

// Loop policy equivalent: gate the ROOT action only, then run the tool.
const rootDecision = await gate.check({ type: 'read', tool: 'shell_grep', path: wd });
console.log('root decision:', rootDecision.outcome);
const direct = await gate.check({ type: 'read', tool: 'shell_read', path: path.join(wd, '.smoke/spine.jsonl') });
console.log('direct read of .smoke:', direct.outcome);

const markers = async (opts) => (await grepTool(opts).execute({ pattern: 'MARKER_', path: wd })).hits.map((h) => h.text).sort();
const without = await markers({});
const withCR = await markers({ canRead: (p, { tool }) => gate.allows({ type: 'read', tool, path: p }) });
console.log('WITHOUT canRead:', without);
console.log('WITH canRead   :', withCR);
fs.rmSync(wd, { recursive: true, force: true });

const leaks = without.length === 4 && direct.outcome === 'deny' && rootDecision.outcome === 'allow';
const closed = withCR.length === 1 && withCR[0] === 'MARKER_SRC';
if (!leaks) { console.error('FAIL: negative control did not leak'); process.exit(1); }
if (!closed) { console.error('FAIL: canRead arm leaked'); process.exit(1); }
console.log('OK: leak reproduced without canRead, closed with it');
