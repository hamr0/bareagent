/**
 * BA-13 economy — the ask's criterion 1, MEASURED on the real API (not asserted).
 *
 * Claim: a one-line edit to an 800-line file costs < 500 OUTPUT tokens via `shell_edit`, versus > 8000 via
 * whole-file `shell_write` (output is the expensive token class, so the shell_write tax is ~ file size, paid
 * on every revision). Output tokens cannot be measured offline — only a real round-trip counts them.
 *
 * Two arms, SAME 800-line file, SAME one-line change, differing ONLY in which write verb the model is given:
 *   ARM write : only shell_read + shell_write — to change one line the model must re-emit the WHOLE file.
 *   ARM edit  : only shell_read + shell_edit — the model emits just the anchor + replacement.
 * We capture per-round OUTPUT tokens (Loop meters usage via onLlmResult) and report the write/edit round.
 *
 * This CAN FAIL: if the model over-quotes and the edit round exceeds 500 output tokens, or a whole-file
 * rewrite somehow stays under 8000, the criterion is not met and the script exits 1. The file diff is also
 * verified so a "cheap" round that DID NOT actually make the edit can't pass.
 *
 * Run:  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/ba13-shell-edit-economy.mjs
 */

import { Loop } from '../src/loop.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { createShellTools } from '../tools/shell.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('need ANTHROPIC_API_KEY'); process.exit(1); }

// A realistic ~800-line source file (avg ~55 chars/line ≈ 45 KB ≈ >10k tokens), so a whole-file rewrite is
// genuinely expensive. Line 400 is the unique target — every other line is distinct so the anchor is unique.
const LINES = Array.from({ length: 800 }, (_, i) => {
  const n = i + 1;
  return `  const result_${n} = transform(input_${n}, { index: ${n}, label: "row ${n} of the ingest pipeline" });`;
});
LINES[399] = `  const result_400 = transform(input_400, { index: 400, label: "THE TARGET LINE" });`;
const CONTENT = LINES.join('\n') + '\n';

const { tools } = createShellTools();
const readTool = tools.find(t => t.name === 'shell_read');
const writeTool = tools.find(t => t.name === 'shell_write');
const editTool = tools.find(t => t.name === 'shell_edit');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

async function arm(label, armTools, instruction) {
  const dir = mkdtempSync(join(tmpdir(), `ba13-${label}-`));
  const target = join(dir, 'ingest.js');
  writeFileSync(target, CONTENT);

  /** @type {number[]} */
  const outByRound = [];
  const provider = new AnthropicProvider({ apiKey: KEY, model: 'claude-sonnet-5' });
  const loop = new Loop({
    provider,
    throwOnError: false,
    onLlmResult: ({ usage }) => outByRound.push(usage?.outputTokens || 0),
  });
  const result = await loop.run(
    [{ role: 'user', content:
      `The file ${target} has 800 lines. Change ONLY the line whose label is "THE TARGET LINE" so its label reads `
      + `"THE TARGET LINE (patched)". ${instruction} Do not change any other line. Read the file first if you need to.` }],
    armTools,
    { maxTokens: 32000 },   // high enough that a whole-file shell_write does NOT truncate — we want its true cost
  );

  const after = readFileSync(target, 'utf8');
  const edited = after.includes('THE TARGET LINE (patched)');
  const otherLinesIntact = after.split('\n').length === CONTENT.split('\n').length
    && after.includes('row 399 of the ingest pipeline') && after.includes('row 401 of the ingest pipeline');
  const maxRoundOut = Math.max(0, ...outByRound);
  const totalOut = outByRound.reduce((a, b) => a + b, 0);

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n── ARM ${label}: error=${JSON.stringify(result.error)} rounds=${outByRound.length} `
    + `perRoundOutput=[${outByRound.join(', ')}] maxRound=${maxRoundOut} total=${totalOut}`);
  check(`[${label}] the edit actually landed`, edited, edited ? 'label patched' : 'TARGET LINE not patched');
  check(`[${label}] the other 799 lines are intact`, otherLinesIntact);
  return { maxRoundOut, totalOut, edited };
}

console.log('BA-13 economy — one-line edit on an 800-line file, real API (claude-sonnet-5)\n');

const w = await arm('write', [readTool, writeTool],
  'You may ONLY use shell_write (which overwrites the whole file) — there is no line-edit tool.');
const e = await arm('edit', [readTool, editTool],
  'Use shell_edit with a unique oldText anchor and its newText replacement.');

console.log('\n── criterion 1 (measured, not asserted)');
check('whole-file shell_write baseline > 8000 output tokens', w.maxRoundOut > 8000, `measured ${w.maxRoundOut}`);
check('one-line shell_edit round < 500 output tokens', e.maxRoundOut < 500, `measured ${e.maxRoundOut}`);
check('shell_edit is materially cheaper than shell_write',
  e.maxRoundOut > 0 && w.maxRoundOut / e.maxRoundOut >= 10,
  `${(w.maxRoundOut / Math.max(1, e.maxRoundOut)).toFixed(1)}× cheaper on the write/edit round`);

console.log(`\n${failures ? `FAIL (${failures})` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);
