#!/usr/bin/env node
/**
 * BA-6 follow-up — the Gemini and Ollama stopReason maps were written from DOCUMENTATION, never
 * measured. Anthropic and OpenAI were probed live; these two were not (no key / daemon down), and a
 * mapping table copied from docs is exactly the kind of thing that is quietly wrong.
 *
 * The stakes are bounded but real: an unrecognized value falls through to `null`, which reproduces
 * pre-BA-6 behavior (a truncation reads as a clean finish again) — a silent regression to the bug we
 * just fixed, on those providers only. It cannot invent a FALSE truncation, but it can miss a true one.
 *
 * So: drive each provider's REAL generate() and force each state.
 *   - end_turn   : a trivial prompt the model finishes.
 *   - max_tokens : a long task at a 16-token cap. THE one that matters — this is the BA-6 defect.
 *   - tool_use   : a tool the model must call (Gemini only; qwen2.5:0.5b via Ollama is unreliable here).
 *
 * Asserts on the SHIPPED normalizer's output, not on a hand-copied table.
 *
 * Run:  GEMINI_API_KEY=... node poc/ba6-stop-reason-gemini-ollama.mjs
 *       (Ollama arm needs the daemon on :11434 — `podman start ollama`. Each arm skips if absent.)
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { GeminiProvider } = require('../src/provider-gemini.js');
const { OllamaProvider } = require('../src/provider-ollama.js');

let failures = 0;
let ran = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ran++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} stopReason=${JSON.stringify(got)}${ok ? '' : `  EXPECTED ${JSON.stringify(want)}`}`);
  if (!ok) failures++;
};

const LONG = 'Write a detailed 800-word essay on the history of the printing press. Do not stop early.';
const TOOL = [{
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}];

// ── GEMINI ────────────────────────────────────────────────────────────────────────────────────
console.log('\nGEMINI  (mapped from docs — never measured until now)\n');
const gkey = process.env.GEMINI_API_KEY;
if (!gkey) {
  console.log('  SKIP — no GEMINI_API_KEY. The map stays UNVERIFIED; it degrades to null (pre-BA-6) if wrong.\n');
} else {
  const g = new GeminiProvider({ apiKey: gkey, model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
  try {
    const stop = await g.generate([{ role: 'user', content: 'Reply with exactly: ok' }], []);
    check('STOP -> end_turn', stop.stopReason, 'end_turn');

    // THE decisive one: a real truncation must be visible, or BA-6 silently doesn't work on Gemini.
    const cut = await g.generate([{ role: 'user', content: LONG }], [], { maxTokens: 16 });
    check('MAX_TOKENS -> max_tokens  (the BA-6 case)', cut.stopReason, 'max_tokens');

    const tool = await g.generate([{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }], TOOL);
    check('tool call -> tool_use', tool.stopReason, 'tool_use');
    console.log(`        (${tool.toolCalls.length} tool call(s) returned)`);
  } catch (err) {
    console.log(`  ERROR  ${err.message.slice(0, 160)}`);
    failures++;
  }
}

// ── OLLAMA ────────────────────────────────────────────────────────────────────────────────────
console.log('\nOLLAMA  (mapped from docs — never measured until now)\n');
const up = await fetch('http://localhost:11434/api/tags').then((r) => r.ok).catch(() => false);
if (!up) {
  console.log('  SKIP — daemon not on :11434 (`podman start ollama`). Map stays UNVERIFIED.\n');
} else {
  const o = new OllamaProvider({ model: process.env.OLLAMA_MODEL || 'qwen2.5:0.5b' });
  try {
    const stop = await o.generate([{ role: 'user', content: 'Reply with exactly: ok' }], []);
    check('stop -> end_turn', stop.stopReason, 'end_turn');

    const cut = await o.generate([{ role: 'user', content: LONG }], [], { maxTokens: 16 });
    check('length -> max_tokens  (the BA-6 case)', cut.stopReason, 'max_tokens');
  } catch (err) {
    console.log(`  ERROR  ${err.message.slice(0, 160)}`);
    failures++;
  }
}

console.log(`\n${ran === 0 ? 'NOTHING RAN' : failures === 0 ? `ALL ${ran} CHECKS PASSED` : `${failures}/${ran} FAILED`}`);
console.log('A FAIL here means that provider silently degrades to pre-BA-6 behavior: a truncated');
console.log('round reads as a clean finish. It cannot invent a false truncation — only miss a true one.\n');
process.exit(failures === 0 && ran > 0 ? 0 : 1);
