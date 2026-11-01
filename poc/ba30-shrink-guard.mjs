// BA-30 POC: shrink-guard trigger rule on real files. Exits non-zero on ANY wrong refuse/pass.
// Usage: node poc/ba30-shrink-guard.mjs [--rule]   (--rule = standalone rule copy; default = real createShellTools)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createShellTools } = require('../tools/shell.js');

const useRule = process.argv.includes('--rule');
const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ba30-'));
const ownFiles = new Set();
const fill = (n) => ('x'.repeat(79) + '\n').repeat(Math.ceil(n / 80)).slice(0, n);

// rule copy (step-1 only)
async function ruleWrite({ path: p, content, append }) {
  if (append || content === '') return 'ok';
  let st; try { st = fs.statSync(p); } catch { return 'ok'; }
  if (!st.isFile() || ownFiles.has(p)) return 'ok';
  const nb = Buffer.byteLength(content);
  if (st.size >= 2048 && nb < st.size * 0.5) throw new Error('refusing');
  return 'ok';
}
const tool = createShellTools({ shrinkGuard: { guardPath: (p) => !ownFiles.has(p) } }).tools.find((t) => t.name === 'shell_write');
const write = useRule ? ruleWrite : (a) => tool.execute(a);

const cases = [
  // [name, existingBytes|null, args, ownRewrite, expect]
  ['gate.js 132315->2221', 132315, { content: fill(2221) }, false, 'refuse'],
  ['gate.js 132315->519', 132315, { content: fill(519) }, false, 'refuse'],
  ['gate.js 132315->143', 132315, { content: fill(143) }, false, 'refuse'],
  ['audit.js 33957->41', 33957, { content: fill(41) }, false, 'refuse'],
  ['create.js 14817->59', 14817, { content: fill(59) }, false, 'refuse'],
  ['budget.js 25678->12830 (49.97%)', 25678, { content: fill(12830) }, false, 'refuse'],
  ['budget.js 25678->12839 (>=50%)', 25678, { content: fill(12839) }, false, 'pass'],
  ['rubric JSON own rewrite 6000->900', 6000, { content: fill(900) }, true, 'pass'],
  ['rubric JSON own rewrite 3000->300', 3000, { content: fill(300) }, true, 'pass'],
  ['rubric JSON own rewrite 12000->1000', 12000, { content: fill(1000) }, true, 'pass'],
  ['small file 2047->10', 2047, { content: fill(10) }, false, 'pass'],
  ['modest edit-sized shrink 10000->8000', 10000, { content: fill(8000) }, false, 'pass'],
  ['new file', null, { content: fill(10) }, false, 'pass'],
  ["content:'' on big file", 50000, { content: '' }, false, 'pass'],
  ['append:true on big file', 50000, { content: fill(10), append: true }, false, 'pass'],
];
let bad = 0;
const rows = [];
for (const [name, size, args, own, expect] of cases) {
  const p = path.join(dir, name.replace(/\W+/g, '_'));
  let orig = null;
  if (size !== null) { orig = fill(size); fs.writeFileSync(p, orig); }
  if (own) ownFiles.add(p);
  let got;
  try { await write({ path: p, ...args }); got = 'pass'; } catch (e) { got = /refusing/.test(e.message) ? 'refuse' : 'ERR:' + e.message; }
  let intact = true;
  if (got === 'refuse') intact = fs.readFileSync(p, 'utf8') === orig;
  const ok = got === expect && intact;
  if (!ok) bad++;
  rows.push(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(40)} expect=${expect.padEnd(6)} got=${got}${intact ? '' : ' FILE-CHANGED'}`);
}
console.log(`mode: ${useRule ? 'rule copy' : 'real createShellTools'}\n` + rows.join('\n'));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
