// examples/with-bareguard.mjs
//
// End-to-end: bareagent Loop + bareguard Gate.
// Runs a small LLM loop with budget cap, fs scope, audit log, and humanChannel.
//
// Run:  OPENAI_API_KEY=... node examples/with-bareguard.mjs
//
// What this demonstrates:
//   - Single-gate governance: every tool call traverses gate.check; every
//     result reaches gate.record (via wrapTools).
//   - Budget halt: if accumulated cost exceeds maxCostUsd, gate halts the loop.
//   - Audit log: one JSONL line per gated event at ./bareagent-audit.jsonl.
//   - humanChannel: required by bareguard. Here we auto-deny asks; in real use
//     wire it to a chat platform, terminal prompt, etc.

import { Gate } from 'bareguard';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Loop, wireGate } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createShellTools } = require('bare-agent/tools');

// 1. Build the gate. Every primitive is optional with sensible defaults.
const gate = new Gate({
  budget: { maxCostUsd: 0.10 },           // hard USD cap
  limits: { maxTurns: 20 },                // safety net on think/act cycles
  fs:     { readScope: ['/tmp', '~/'] },   // shell_read / shell_grep allowed roots
  bash:   { allow: ['ls', 'cat', 'echo', 'pwd'] },  // argv[0] allowlist for shell_run
  audit:  { path: './bareagent-audit.jsonl' },
  // Required by bareguard: any ask/halt event flows through here.
  // Auto-deny is the safest default for headless use; in real apps, wire to
  // a Telegram/Slack/terminal prompt and return { decision: 'allow' | 'deny' }.
  humanChannel: async (event) => {
    console.warn(`[humanChannel] ${event.kind}: ${event.rule} — auto-denying`);
    return { decision: 'deny' };
  },
});
await gate.init();

// 2. Wire the gate into Loop's policy slot and wrap tools so gate.record fires.
const { policy, wrapTools } = wireGate(gate);

// 3. Standard bareagent setup.
const provider = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
});
const { tools } = createShellTools();

const loop = new Loop({
  provider,
  policy,
  onError: (err, meta) => console.error(`[onError ${meta.source}]`, err.message),
});

// 4. Run.
const result = await loop.run(
  [{ role: 'user', content: 'List the contents of /tmp using shell_run with argv ["ls", "/tmp"].' }],
  wrapTools(tools),
);

console.log('---');
console.log('text:', result.text);
console.log('cost:', result.cost?.toFixed(6) ?? 'n/a');
console.log('audit log → ./bareagent-audit.jsonl');
