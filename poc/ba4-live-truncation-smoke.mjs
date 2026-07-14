// BA-4 live verify-shipped — the half that the offline suite structurally CANNOT prove.
//
// The offline tests prove the GUARD (a content-less call is rejected, disk untouched). They cannot prove the
// other half, which is model-facing: that a REAL model, having hit its output-token cap, reads the rejection
// string and RECOVERS — rather than spinning against the throw. A scripted mock retries because I wrote it to;
// a fixture authored to contain the result can only confirm it.
//
// Riskiest assumption, aimed at directly: does the ordinary output-cap truncation actually deliver a
// `shell_write` call with `content` ABSENT on the real Anthropic wire, and does the shipped guard convert that
// from silent data loss into a recoverable error the model can act on?
//
// Two arms over the SAME live truncated call — the negative control is what makes this falsifiable:
//   GUARDED   (shipped writeFile)  → expect: THROW, file byte-identical, model retries, full content lands.
//   UNGUARDED (pre-BA-4 writeFile) → expect: the 1789-line failure replayed — file EMPTIED, "wrote 0 bytes".
// If the unguarded arm does NOT empty the file, the guard is not load-bearing and this smoke says so.
//
// Run: ANTHROPIC_API_KEY=… node poc/ba4-live-truncation-smoke.mjs
import { writeFileSync, readFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Loop } = require('../src/loop.js');
const { AnthropicProvider } = require('../src/provider-anthropic.js');
const { _writeFile } = require('../tools/shell.js');

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(2); }

const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ['claude-haiku-4-5', 'claude-sonnet-5'];
const dir = mkdtempSync(join(tmpdir(), 'ba4-live-'));

// The victim: a real file with real content, exactly the shape bareloop lost (a source file being rewritten).
const ORIGINAL = Array.from({ length: 60 }, (_, i) => `export const sym${i} = ${i}; // load-bearing line ${i}`).join('\n');

// PRE-BA-4 writeFile, verbatim: path guarded, content defaulted. This is the code that emptied store.js.
async function legacyWriteFile({ path: p, content = '', append = false }) {
  if (typeof p !== 'string' || p.length === 0) throw new Error('shell_write requires a non-empty "path" string');
  const text = content == null ? '' : String(content);
  const bytes = Buffer.byteLength(text, 'utf8');
  writeFileSync(p, text, 'utf8');
  return `${append ? 'appended' : 'wrote'} ${bytes} bytes to ${p}`;
}

const writeToolDef = (impl, target, log) => ({
  name: 'shell_write',
  description: 'Write text to a file (overwriting it). Returns a "wrote N bytes" summary.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Target file path.' },
      content: { type: 'string', description: 'The full text to write (UTF-8).' },
    },
    required: ['path', 'content'],
  },
  execute: async (args) => {
    const hasContent = typeof args?.content === 'string';
    log.calls.push({ hasContent, len: hasContent ? args.content.length : null });
    try {
      const r = await impl({ path: target, content: args?.content });
      log.results.push(`OK: ${r}`);
      return r;
    } catch (err) {
      log.results.push(`THROW: ${err.message}`);
      throw err; // Loop turns this into a ToolError and feeds it back to the model
    }
  },
});

// A tool call that a truncated generation produces: the model is asked for a big file body but given far
// fewer output tokens than the body needs, so the tool_use block is cut off mid-input.
const TASK = 'Rewrite the file at the given path so every "load-bearing line N" comment instead reads '
  + '"verified line N". You MUST call shell_write exactly once with the COMPLETE new file body in `content`. '
  + 'Do not summarize, do not abbreviate — emit every one of the 60 lines in full.\n\nCurrent file:\n';

async function arm({ model, impl, maxTokens, label }) {
  const target = join(dir, `${label}-${model}.js`);
  writeFileSync(target, ORIGINAL, 'utf8');
  const before = statSync(target).size;
  const log = { calls: [], results: [] };
  const provider = new AnthropicProvider({ apiKey: KEY, model });
  const loop = new Loop({ provider, throwOnError: false, maxConsecutiveDenials: 0 });
  let error = null;
  try {
    await loop.run(
      [{ role: 'user', content: TASK + ORIGINAL }],
      [writeToolDef(impl, target, log)],
      { maxTokens },
    );
  } catch (err) { error = err.message; }
  const after = statSync(target).size;
  const body = readFileSync(target, 'utf8');
  return { model, label, before, after, body, log, error, target };
}

console.log(`\n=== BA-4 live verify-shipped — real Anthropic, real output-token truncation ===`);
console.log(`victim file: ${ORIGINAL.split('\n').length} lines / ${Buffer.byteLength(ORIGINAL)} bytes\n`);

let failures = 0;
for (const model of MODELS) {
  console.log(`\n──────── ${model} ────────`);

  // Arm 1 — NEGATIVE CONTROL: pre-BA-4 code, output cap far too small for the body. Must reproduce the bug.
  const unguarded = await arm({ model, impl: legacyWriteFile, maxTokens: 200, label: 'unguarded' });
  const truncated = unguarded.log.calls.some(c => !c.hasContent);
  console.log(`\n[negative control · pre-BA-4 writeFile · maxTokens=200]`);
  console.log(`  tool calls      : ${JSON.stringify(unguarded.log.calls)}`);
  console.log(`  tool results    : ${JSON.stringify(unguarded.log.results)}`);
  console.log(`  file ${unguarded.before} B -> ${unguarded.after} B`);
  if (!truncated) {
    console.log(`  ⚠️  the cap did NOT produce a content-less call — this arm proves nothing for this model`);
  } else if (unguarded.after === 0) {
    console.log(`  ✅ BUG REPRODUCED LIVE: the truncated call EMPTIED the file, reported as success`);
  } else {
    console.log(`  ❌ content-less call arrived but the file was not emptied — guard may not be load-bearing`);
    failures++;
  }

  // Arm 2 — SHIPPED: same truncation, then enough room to recover. Guard must reject, file survive, model retry.
  const guarded = await arm({ model, impl: _writeFile, maxTokens: 2048, label: 'guarded' });
  const rejected = guarded.log.results.some(r => r.startsWith('THROW'));
  const wroteFull = guarded.body.includes('verified line 59') && !guarded.body.includes('load-bearing line 59');
  const intactOrBetter = guarded.after > 0;
  console.log(`\n[shipped · guarded writeFile · maxTokens=2048]`);
  console.log(`  tool calls      : ${JSON.stringify(guarded.log.calls)}`);
  console.log(`  tool results    : ${JSON.stringify(guarded.log.results.map(r => r.slice(0, 90)))}`);
  console.log(`  file ${guarded.before} B -> ${guarded.after} B`);
  console.log(`  loop error      : ${guarded.error ?? 'none'}`);
  console.log(`  never 0 bytes   : ${intactOrBetter ? '✅' : '❌ FILE WAS EMPTIED'}`);
  console.log(`  content-less rejected: ${rejected ? '✅ (guard fired, model saw the error)' : '— (no truncation occurred this run)'}`);
  console.log(`  full body landed: ${wroteFull ? '✅' : '⚠️  no (model did not complete the rewrite)'}`);
  if (!intactOrBetter) failures++;
}

console.log(`\n=== VERDICT: ${failures === 0 ? 'PASS — the guard is load-bearing and the file is never emptied' : `FAIL (${failures})`} ===`);
console.log(`artifacts: ${dir}\n`);
process.exit(failures === 0 ? 0 : 1);
