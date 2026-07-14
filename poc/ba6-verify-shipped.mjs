/**
 * BA-6 verify-shipped — drive the SHIPPED Loop + AnthropicProvider against the real API.
 *
 * The offline suite (mutation-proven) proves the WIRING. It cannot prove the shipped primitive behaves
 * against a real model on a real wire — a scripted provider returns whatever stopReason the test author
 * typed. This drives src/ end to end and asserts on what actually comes back.
 *
 * Three arms, and the run FAILS (exit 1) if any is wrong:
 *
 *   1. POSITIVE   — real truncation on claude-sonnet-5 (maxTokens 1024, essay prompt).
 *                   Pre-BA-6 this returned error:null. Must now be error:'truncated:max_tokens',
 *                   with the partial text PRESERVED (BA-5).
 *   2. NEGATIVE   — a prompt that genuinely finishes. Must STILL be error:null.
 *                   Without this, a fix that errors on every round would "pass" arm 1 and break
 *                   every consumer's happy path.
 *   3. BA-4 ROOT  — the file-zeroing shape, live: give the model a write tool and a cap too small to
 *                   emit the body. If the round truncates, the shipped Loop must REFUSE to execute the
 *                   cut-off tool call. Asserted on DISK STATE, not on the return string: the file must
 *                   be byte-identical afterwards.
 */

import { Loop } from '../src/loop.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('need ANTHROPIC_API_KEY'); process.exit(1); }

const provider = new AnthropicProvider({ apiKey: KEY, model: 'claude-sonnet-5' });
let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// ── ARM 1: POSITIVE — a real truncation must not read as a finish ────────────────────────────────
console.log('\n[1] POSITIVE — real max_tokens truncation through the shipped Loop');
// NOTE: maxTokens is not a Loop ctor option — it is run()'s third arg, forwarded to provider.generate().
const r1 = await new Loop({ provider, throwOnError: true })
  .run([{ role: 'user', content: 'Write a detailed 2000-word essay on the history of the bicycle. Be exhaustive.' }], [], { maxTokens: 1024 });
console.log(`      error=${JSON.stringify(r1.error)}  text=${r1.text.length}B  rounds=${r1.metrics.turns}`);
check('error is truncated:max_tokens (was error:null pre-BA-6)', r1.error === 'truncated:max_tokens');
check('BA-5: the partial text is PRESERVED, not discarded', r1.text.length > 0, `${r1.text.length} bytes kept`);

// ── ARM 2: NEGATIVE CONTROL — a genuine finish must stay clean ───────────────────────────────────
console.log('\n[2] NEGATIVE CONTROL — a round that genuinely ends must still be a clean finish');
const r2 = await new Loop({ provider, throwOnError: true })
  .run([{ role: 'user', content: 'Reply with exactly one word: ok' }], [], { maxTokens: 1024 });
console.log(`      error=${JSON.stringify(r2.error)}  text=${JSON.stringify(r2.text.slice(0, 40))}`);
check('error is null — the fix reads the flag, not the weather', r2.error === null);
check('the answer survives', r2.text.trim().length > 0);

// ── ARM 3: BA-4 ROOT CAUSE — a truncated tool call must never reach the tool ─────────────────────
console.log('\n[3] BA-4 ROOT CAUSE — a cut-off write must not reach the filesystem');
const TARGET = '/tmp/ba6-verify-target.js';
const ORIGINAL = '// a real file with real content\n'.repeat(60);
writeFileSync(TARGET, ORIGINAL);
const before = readFileSync(TARGET, 'utf8');

let toolReached = false;
const writeTool = {
  name: 'shell_write',
  description: 'Write content to a file. Overwrites the whole file.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  execute: async ({ path, content }) => {
    toolReached = true;              // if the guard works, this NEVER runs on a truncated round
    writeFileSync(path, content ?? ''); // the pre-BA-4 behavior, on purpose: prove the guard is what saves us
    return `wrote ${(content ?? '').length} bytes`;
  },
};

// A cap far too small to emit a 60-line body — the model must truncate mid-tool-call.
const r3 = await new Loop({ provider, throwOnError: true }).run(
  [{ role: 'user', content: `Rewrite the file at ${TARGET}. It must contain 60 lines of detailed JavaScript. Use the shell_write tool and pass the FULL new file body in the content argument.` }],
  [writeTool],
  { maxTokens: 200 },
);
const after = readFileSync(TARGET, 'utf8');
console.log(`      error=${JSON.stringify(r3.error)}  toolReached=${toolReached}`);
console.log(`      file: ${before.length}B before → ${after.length}B after`);
if (r3.error === 'truncated:max_tokens') {
  check('the truncated tool call NEVER reached the tool', toolReached === false);
  check('DISK STATE: the file is byte-identical (not zeroed)', after === before, `${after.length}B`);
} else {
  console.log(`      (model did not truncate this round — error=${JSON.stringify(r3.error)}; arm inconclusive, not a failure)`);
  check('the file was not zeroed regardless', after.length > 0);
}
rmSync(TARGET, { force: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
