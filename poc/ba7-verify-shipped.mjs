#!/usr/bin/env node
/**
 * BA-7 VERIFY-SHIPPED — drive the SHIPPED Loop + AnthropicProvider against the REAL API and prove
 * round N+1's body carries round N's byte-identical thinking blocks.
 *
 * The offline suite proves the wiring. It cannot prove the wire: only a real round-trip shows that a
 * REAL signature (not a fixture string) is replayed and ACCEPTED. Criterion 1 of the ask is explicit —
 * "assert on the serialised body: the bug is that nothing reaches the wire" — so this runs a recording
 * PROXY between bare-agent and Anthropic and asserts on the actual bytes sent.
 *
 * Arms:
 *   1. POSITIVE       — shipped Loop, tools, thinking on. Round 2's body must contain round 1's exact
 *                       thinking block, signature included. And the API must accept it (no 400).
 *   2. NEG (guard off)— the SAME run with providerBlocks stripped from the transcript (i.e. pre-BA-7
 *                       behavior). The thinking block must be ABSENT from round 2's body, and the call
 *                       must still return 200 — reproducing the SILENT loss that made this a real bug
 *                       nobody noticed. A guard is only proven load-bearing by disabling it.
 *
 * Run:  ANTHROPIC_API_KEY=... node poc/ba7-verify-shipped.mjs
 */

import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Loop } = require('../src/loop.js');
const { AnthropicProvider } = require('../src/provider-anthropic.js');

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('need ANTHROPIC_API_KEY'); process.exit(2); }
const MODEL = 'claude-sonnet-5';

// ── a recording proxy: bare-agent -> here -> api.anthropic.com ────────────────────────────────
/** @type {any[]} */
let sent = [];
const proxy = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    sent.push(JSON.parse(body));
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body,
    });
    const text = await up.text();
    res.writeHead(up.status, { 'content-type': 'application/json' });
    res.end(text);
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${proxy.address().port}`;

const TOOL = {
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async () => 'schedule: "0 3 * * 2"\nretries: 0\nrebalance_timeout_ms: 40\n',
};
const TASK = 'CI fails intermittently, only on Tuesdays. Read /etc/ci/config.yml, then give me your leading hypothesis in one sentence.';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures++;
};
const thinkingIn = (msg) => (Array.isArray(msg?.content) ? msg.content.filter((b) => String(b.type).includes('thinking')) : []);

// ── ARM 1: POSITIVE ───────────────────────────────────────────────────────────────────────────
console.log('\nARM 1  POSITIVE — shipped Loop, thinking on, tool round-trip\n');
sent = [];
const provider = new AnthropicProvider({ apiKey: KEY, baseUrl, model: MODEL, thinking: { type: 'adaptive' } });
const result = await new Loop({ provider, throwOnError: true }).run([{ role: 'user', content: TASK }], [TOOL]);

console.log(`  rounds on the wire: ${sent.length}   loop error: ${JSON.stringify(result.error)}`);
check('the run completed (a replayed signature was ACCEPTED, not 400ed)', result.error === null, `error=${result.error}`);
check('the opt-in thinking param reached body.thinking (criterion 2)',
  sent[0] && JSON.stringify(sent[0].thinking) === '{"type":"adaptive"}', JSON.stringify(sent[0]?.thinking));

// Find the round-1 assistant turn as bare-agent stored it, and what it put on round 2's wire.
const stored = result.msgs.find((m) => m.role === 'assistant' && m.providerBlocks);
if (sent.length < 2) {
  check('the model made a tool call (needed to test a CONTINUATION)', false, 'only one round — rerun');
} else {
  const round2Assistant = sent[1].messages.find((m) => m.role === 'assistant');
  const onWire = thinkingIn(round2Assistant);
  console.log(`  round-2 assistant blocks: ${JSON.stringify((round2Assistant?.content || []).map((b) => b.type))}`);

  check('bare-agent CAPTURED thinking blocks onto the transcript (hole #3 closed)',
    !!stored && stored.providerBlocks.blocks.length > 0,
    stored ? `${stored.providerBlocks.blocks.length} block(s), model=${stored.providerBlocks.model}` : 'NO providerBlocks on any assistant msg');

  check('CRITERION 1: round 2 REPLAYS them, byte-identical, signature included',
    !!stored && JSON.stringify(onWire) === JSON.stringify(stored.providerBlocks.blocks),
    onWire.length === 0 ? 'NOTHING reached the wire' : `sig ${String(onWire[0]?.signature).slice(0, 24)}… (${onWire[0]?.signature?.length} chars)`);

  check('thinking LEADS the assistant content array (Anthropic requires it first)',
    String(round2Assistant?.content?.[0]?.type).includes('thinking'),
    `first block: ${round2Assistant?.content?.[0]?.type}`);
}

// ── ARM 2: NEGATIVE CONTROL — strip the blocks, i.e. behave like pre-BA-7 ──────────────────────
// A guard is only proven load-bearing by turning it OFF and watching the failure return.
console.log('\nARM 2  NEGATIVE CONTROL — same run, providerBlocks stripped (pre-BA-7 behavior)\n');
sent = [];
const blind = new AnthropicProvider({ apiKey: KEY, baseUrl, model: MODEL, thinking: { type: 'adaptive' } });
const realGen = blind.generate.bind(blind);
blind.generate = async (msgs, tools, opts) => {
  const r = await realGen(msgs, tools, opts);
  delete r.providerBlocks;           // exactly what 0.26.2 did: drop them on the floor
  return r;
};
const blindResult = await new Loop({ provider: blind, throwOnError: true }).run([{ role: 'user', content: TASK }], [TOOL]);

if (sent.length < 2) {
  console.log('  (single round — no continuation to inspect)');
} else {
  const a2 = sent[1].messages.find((m) => m.role === 'assistant');
  const lost = thinkingIn(a2);
  console.log(`  round-2 assistant blocks: ${JSON.stringify((a2?.content || []).map((b) => b.type))}`);
  check('NEG: with the fix off, NO thinking block reaches the wire (the bug reproduces)',
    lost.length === 0, `${lost.length} block(s) on the wire`);
  check('NEG: and the API still returns 200 — the loss is SILENT, which is why nobody caught it',
    blindResult.error === null, `error=${blindResult.error}`);
}

proxy.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
console.log('Reminder (measured, not rhetoric): this fixes a PROTOCOL violation and silent data loss.');
console.log('It is NOT a capability fix — the adopter\'s head-to-head found NO outcome difference.\n');
process.exit(failures === 0 ? 0 : 1);
