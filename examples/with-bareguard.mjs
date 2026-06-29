// examples/with-bareguard.mjs
//
// End-to-end: bareagent Loop + bareguard Gate.
// Runs a small LLM loop with budget cap, fs scope, audit log, and humanChannel.
//
// Run:  OPENAI_API_KEY=... node examples/with-bareguard.mjs
//
// What this demonstrates:
//   - Single-gate governance: every tool call traverses gate.check (policy); every
//     result reaches gate.record (via onToolResult + onLlmResult — wrapTools is deprecated).
//   - Primitive enforcement: a shell→primitive actionTranslator makes bash.allow + fs.readScope
//     actually fire (the default translator leaves them dead — relayfact F7/BA-3).
//   - Budget halt: if accumulated cost exceeds maxCostUsd, gate halts the loop (a HaltError,
//     caught by the Loop as a clean exit — distinct from a per-action deny; see humanChannel below).
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
  // a Telegram/Slack/terminal prompt and return a decision.
  //   • { decision: 'deny' }  → denies THIS ONE action only; the loop keeps running and the
  //     model may try something else. deny does NOT stop the loop (relayfact F11/BA-6) — under a
  //     retry wrapper like `refine` a denied-but-not-stopped loop can keep spending.
  //   • { decision: 'terminate' } → the clean-halt path: surfaces as a HaltError the Loop catches
  //     and exits on. Use this (or a budget/turn cap) when you mean "stop", not "skip this action".
  humanChannel: async (event) => {
    console.warn(`[humanChannel] ${event.kind}: ${event.rule} — auto-denying (this action only)`);
    return { decision: 'deny' };
  },
});
await gate.init();

// 2. Wire the gate. The DEFAULT translator emits `{ type: <toolName> }` — which matches bareguard's
//    `tools.allowlist`/`tools.denylist` (they read `action.type`) but does NOT activate the `bash`/`fs`/`net`
//    primitives: those fire only on `action.type ∈ {bash, read, write, edit}` and read `action.cmd`/`action.path`.
//    So to make the `bash.allow` + `fs.readScope` config above actually enforce, we MUST translate the shell
//    tools into those primitive shapes — otherwise the caps are silently dead (relayfact F7/BA-3).
const actionTranslator = (toolName, args, ctx) => {
  switch (toolName) {
    // shell_run is argv (no shell); bareguard's bash.allow matches `cmd.startsWith(prefix)`, so join argv[0..].
    case 'shell_run':  return { type: 'bash', cmd: (args?.argv || []).join(' '), args, _ctx: ctx ?? null };
    case 'shell_exec': return { type: 'bash', cmd: args?.command, args, _ctx: ctx ?? null };
    // shell_read / shell_grep are reads — gate them through fs.readScope.
    case 'shell_read':
    case 'shell_grep': return { type: 'read', path: args?.path, args, _ctx: ctx ?? null };
    // shell_write is a write — gate it through fs.writeScope (add writeScope to the Gate config to enforce).
    case 'shell_write': return { type: 'write', path: args?.path, args, _ctx: ctx ?? null };
    default:           return { type: toolName, args, _ctx: ctx ?? null };
  }
};
// onToolResult + onLlmResult are the current wiring (wrapTools is deprecated — it loses _ctx and never sees
// LLM cost, so the budget cap can't cover token-only rounds). policy gates pre-call; the result hooks record.
const { policy, onToolResult, onLlmResult } = wireGate(gate, { actionTranslator });

// 3. Standard bareagent setup.
const provider = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
});
const { tools } = createShellTools();

const loop = new Loop({
  provider,
  policy,
  onToolResult,  // every tool result → gate.record (with _ctx in scope)
  onLlmResult,   // every LLM round → gate.record so budget.maxCostUsd covers token-only spend
  onError: (err, meta) => console.error(`[onError ${meta.source}]`, err.message),
});

// 4. Run. Pass the tools as-is — gating is via policy/onToolResult, not by wrapping execute().
const result = await loop.run(
  [{ role: 'user', content: 'List the contents of /tmp using shell_run with argv ["ls", "/tmp"].' }],
  tools,
);

console.log('---');
console.log('text:', result.text);
// Loop returns the meter under result.metrics (result.cost was removed); costUsd is null when unpriced.
console.log('cost:', result.metrics?.costUsd != null ? result.metrics.costUsd.toFixed(6) : 'n/a (unpriced)');
console.log('audit log → ./bareagent-audit.jsonl');
