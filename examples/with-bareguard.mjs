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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { Loop, wireGate } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createShellTools } = require('bare-agent/tools');

// 1. Build the gate. Every primitive is optional with sensible defaults.
//    fs.readScope/fs.writeScope are both set: on bareguard >=0.19 (bareagent's peerDependency
//    floor), a shell file action denies by default when its scope is unset (fs.readScope.unset /
//    fs.writeScope.unset) — leaving writeScope out here would silently deny every shell_write /
//    shell_edit call, not leave the primitive dead like on older bareguard.
//    Scope roots are realpath'd: bareguard >=0.19.2 throws at `new Gate` on a root that is or
//    contains a symlink (macOS /tmp and os.tmpdir() are symlinks), so list real paths.
//    readScope is deliberately WIDER than writeScope here — read is fine anywhere under the tmp root,
//    but writes are narrowed to one demo subdir, to show the two scopes are independent (a
//    folder listed only in readScope is NOT writable, and vice versa). The demo dir is created
//    below since fs.writeScope doesn't need the path to pre-exist, but the example's own
//    shell_write call does.
const TMP = fs.realpathSync(os.tmpdir());
const writeDir = path.join(TMP, 'bare-agent-demo');
fs.mkdirSync(writeDir, { recursive: true });
const gate = new Gate({
  budget: { maxCostUsd: 0.10 },           // hard USD cap
  limits: { maxTurns: 20 },                // safety net on think/act cycles
  fs:     { readScope: [TMP], writeScope: [writeDir] },  // read: anywhere under the tmp root; write: one narrower demo dir
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

// 2. Wire the gate. As of bareguard >=0.19 (bareagent's peerDependency floor), the DEFAULT
//    actionTranslator already maps the six `createShellTools` primitives into bareguard's `fs`/`bash`
//    shapes (shell_read/shell_grep → {type:'read',...}, shell_write → {type:'write',...}, shell_edit →
//    {type:'edit',...}, shell_run/shell_exec → {type:'bash',...}), canonicalizing the path with
//    `resolveToolPath` itself — so the `bash.allow` + `fs.readScope`/`fs.writeScope` config above just
//    works with no custom actionTranslator (this used to be a required hand-written override — the "C2"
//    gap, relayfact F7/BA-3 — see src/bareguard-adapter.js for the exact shape and bareguard-version note).
// onToolResult + onLlmResult are the current wiring (wrapTools is deprecated — it loses _ctx and never sees
// LLM cost, so the budget cap can't cover token-only rounds). policy gates pre-call; the result hooks record.
const { policy, onToolResult, onLlmResult } = wireGate(gate);

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
  [{ role: 'user', content: `List the contents of ${TMP} using shell_run with argv ["ls", "${TMP}"].` }],
  tools,
);

console.log('---');
console.log('text:', result.text);
// Loop returns the meter under result.metrics (result.cost was removed); costUsd is null when unpriced.
console.log('cost:', result.metrics?.costUsd != null ? result.metrics.costUsd.toFixed(6) : 'n/a (unpriced)');
console.log('audit log → ./bareagent-audit.jsonl');
