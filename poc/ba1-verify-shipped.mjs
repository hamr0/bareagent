/**
 * BA-1 verify-shipped — drive the SHIPPED Loop + AnthropicProvider (cacheMessages) against the real API.
 *
 * The offline tests prove the breakpoint REACHES THE WIRE. They cannot prove Anthropic HONOURS it: a
 * mock server accepts any body. Only a live round-trip shows a real `cache_read_input_tokens > 0`.
 *
 * Two arms, one knob apart, both driving a REAL tool loop through src/ (a shell_read tool that returns a
 * big file, so the transcript ends on a tool_result — the shape that matters and the one no caller-side
 * seam can reach). Exits 1 if any check fails.
 *
 *   ARM A (cacheMessages OFF — NEGATIVE CONTROL): cache tiers must be ZERO on every round.
 *      If they aren't, Anthropic is caching without our flag and the flag isn't what does the work.
 *   ARM B (cacheMessages ON): round 1 writes the cache; round 2+ must READ it.
 *      If cache_read stays 0, the transcript is under the model's minimum and silently didn't cache.
 */

import { Loop } from '../src/loop.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { readFileSync } from 'node:fs';

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('need ANTHROPIC_API_KEY'); process.exit(1); }

// A real file — this is what a tool loop actually drags through context, round after round.
const FILE = readFileSync(new URL('../src/loop.js', import.meta.url), 'utf8').slice(0, 60000);

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const readTool = {
  name: 'shell_read',
  description: 'Read a file from disk. Returns its full contents.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async () => FILE,
};

async function arm(label, cacheMessages) {
  console.log(`\n── ${label}`);
  const provider = new AnthropicProvider({ apiKey: KEY, model: 'claude-sonnet-5', cacheMessages });
  const rounds = [];
  // Capture the per-round cache tiers as the Loop meters them.
  const loop = new Loop({
    provider,
    throwOnError: true,
    onLlmResult: ({ usage }) => rounds.push(usage),
  });
  const result = await loop.run(
    [{ role: 'user', content: `Read src/loop.js with shell_read. Then, in separate short replies, tell me: (1) what the trim seam does, (2) what the assemble seam does. Keep going until you have answered both.` }],
    [readTool],
    { maxTokens: 512 },
  );
  console.log(`  error=${JSON.stringify(result.error)}  rounds=${rounds.length}`);
  console.log('  round │ uncached │ cache_write │ cache_read');
  rounds.forEach((u, i) => {
    console.log(`      ${i + 1} │ ${String(u.inputTokens).padStart(8)} │ ${String(u.cacheCreationTokens || 0).padStart(11)} │ ${String(u.cacheReadTokens || 0).padStart(10)}`);
  });
  return rounds;
}

// ── ARM A: NEGATIVE CONTROL ──────────────────────────────────────────────────────────────────────
const off = await arm('ARM A: cacheMessages OFF (today) — NEGATIVE CONTROL', false);
const offCached = off.reduce((n, u) => n + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0), 0);
check('OFF: cache tiers are ZERO on every round (the flag is what does the work)', offCached === 0, `${offCached} cached tokens`);

// ── ARM B: THE FIX ───────────────────────────────────────────────────────────────────────────────
const on = await arm('ARM B: cacheMessages ON (the BA-1 fix)', true);
const wrote = on.reduce((n, u) => n + (u.cacheCreationTokens || 0), 0);
const read = on.reduce((n, u) => n + (u.cacheReadTokens || 0), 0);
check('ON: the cache is WRITTEN (round 1 pays the 1.25x premium, once)', wrote > 0, `${wrote} tokens written`);
if (on.length > 1) {
  check('ON: the cache is READ back on a later round — Anthropic HONOURS the breakpoint', read > 0, `${read} tokens read`);
  const uncachedOn = on.reduce((n, u) => n + u.inputTokens, 0);
  const uncachedOff = off.reduce((n, u) => n + u.inputTokens, 0);
  check('ON: full-price input tokens collapse vs OFF', uncachedOn < uncachedOff, `${uncachedOff} -> ${uncachedOn} full-price tokens`);
} else {
  console.log('  (only one round — the model answered without a follow-up; cache READ not exercised)');
  check('the write still landed', wrote > 0);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
