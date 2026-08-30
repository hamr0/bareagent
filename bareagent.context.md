# bareagent — Integration Guide

> For AI assistants and developers wiring bareagent into a project.
> v0.40.0 | Node.js >= 18 | zero required deps (`bareguard >=0.9.0 <0.14.0` optional peer for governance) | Apache 2.0
>
> Full human guide with composition examples, design philosophy, and recipes: [Usage Guide](docs/archive/usage-guide.md)

## What this is

bareagent is a lightweight agent orchestration library (small core, zero required runtime deps — `bareguard` is an optional peer for governance). It provides composable components for LLM tool-calling loops, goal planning, state tracking, scheduled actions, human approval gates, persistent memory, circuit breaking, provider fallback, single-gate governance via [bareguard](https://npmjs.com/package/bareguard), cross-platform shell tools, and an MCP bridge. All components are independent — use one, use all, or bring your own.

```
npm install bare-agent
```

Eight entry points:
- `require('bare-agent')` — Loop, Planner, **assessComplexity** (pure-code no-LLM pre-planner → `{level, score, needsPlanning, signals}`), StateMachine, Scheduler, Checkpoint, Memory, Stream, Retry, runPlan, CircuitBreaker, wireGate, defaultActionTranslator, **toUnits, fromUnits, unitAssembler** (the `assemble` context-units adapter, v0.13+), **unitTrimmer, harvestKey** (the destructive `trim` seam adapter — RT-2 harvest-before-evict, needs a consumer on litectx ≥ 0.16.0), BareAgentError, ProviderError, ToolError, TimeoutError, ValidationError, CircuitOpenError, **HaltError**
- `require('bare-agent/errors')` — same error classes via a stable subpath (v0.10.1+) for adopters who want to import only the error surface
- `require('bare-agent/providers')` — OpenAI, Anthropic, Ollama, CLIPipe, Fallback (the canonical short names; `*Provider` aliases — `OpenAIProvider`, `AnthropicProvider`, etc. — are also exported and match the class names, so either destructure works, v0.12.1+)
- `require('bare-agent/stores')` — SQLite (FTS5), JsonFile
- `require('bare-agent/transports')` — JsonlTransport
- `require('bare-agent/tools')` — createBrowsingTools, createMobileTools, createShellTools, createSpawnTool, createDeferTool, spawnChild, readDeferQueue, liteCtxMcpBridgeConfig
- `require('bare-agent/mcp')` — createMCPBridge (returns `tools` + `metaTools`), discoverServers, buildMetaTools
- `require('bare-agent/bareguard')` — wireGate (one-line bareguard Gate integration), defaultActionTranslator

**TypeScript:** bareagent is pure JS + JSDoc but ships `.d.ts` declarations (generated from that JSDoc, v0.11+). Every entry point above resolves types automatically — `import { Loop } from 'bare-agent'` and `import { OpenAI } from 'bare-agent/providers'` give full autocomplete and type-checking, including required-option enforcement (e.g. `new Loop({})` is a type error: `provider` is required). No `@types/bare-agent` needed. Shared shapes (`Provider`, `Message`, `ToolDef`, `ToolCall`, `Usage`, `GenerateResult`, `Store`) are exported from the package's `types/`. The repo itself runs `tsc --checkJs` in CI on every push/PR so the JSDoc and the code can't drift.

## Which components do I need?

| I want to... | Use these |
|---|---|
| Call an LLM with tools and get a result | Loop + a Provider |
| Break a goal into steps | Planner + a Provider |
| Size a goal before planning (no LLM) | assessComplexity — `needsPlanning` gates a Planner pass |
| Kill a spawned child that hangs silently | createSpawnTool / spawnChild `{ idleTimeoutMs }` |
| Execute a step DAG with parallelism | runPlan + executeFn |
| Decompose a hard task into a verified tree (RLM) | recurse — decompose → fan-out → verify → synthesize in one call (**wire a gate**, cost is open by design) |
| Count / answer "how many / all" over a corpus, honestly | recurse(task, ctx, `{ corpus, retrieval: 'scan' }`) — scans every slice, CODE-counts |
| Give recurse workers a persona/role (senior-dev stance) | recurse(task, ctx, `{ persona }`) — prepended to every worker, carries down the tree; not applied to the verifier |
| Tell recurse workers WHERE they are (paths/cwd) so a slice can find its file | recurse(task, ctx, `{ context }`) — read-only blob on every worker's task message + the Planner + verifier; carries down (facts, not a stance) |
| Let a recurse LEAF retry its own failure with a deterministic check | recurse(task, ctx, `{ refineLeaf: { sensor } }`) — leaf becomes a bounded generate→sense→regenerate loop; your sensor (test/compile/lint) judges the RETURNED result, gap fed back, escalating temperature; `rejectedBuffer` feeds prior failed attempts back on a temp-fixed model |
| Track task state (pending/running/done/failed) | StateMachine |
| Run agent turns on a schedule (cron, timers) | Scheduler |
| Require human approval before dangerous actions | Checkpoint |
| Persist context across turns/sessions | Memory + a Store |
| Observe what the agent is doing | Stream |
| Retry on transient failures (429, timeouts) | Retry |
| Add jitter to backoff delays | Retry({ jitter: 'full' }) |
| Fail fast on repeated provider errors | CircuitBreaker |
| Fall back to another provider on failure | FallbackProvider |
| Retry individual plan steps | runPlan({ stepRetry }) |
| Use a CLI tool as an LLM provider | CLIPipe |
| Health-check provider, store, and tools | Loop.validate() |
| Verify an agent's output (judge / grade / critic) | Evaluator + refine — `predicate` / `rubric` / `agentic` criteria |
| Decisively judge "did this answer honor the request?" (return-time) | judge — verbatim request + one artifact → `honored`/`broke` + mechanical `where`; `calibrate` admits a tier vs a frozen floor |
| Offer skills on demand without bloating context | SkillRegistry — `skill_use` meta-tool + `skills.activeTools` thunk |
| Keep the context window lean (compact finished sub-tasks) | createStashSkill — register the skill + wire its `trim` into `Loop({ trim })` |
| Consolidate finished work into durable facts (across runs) | remember — distill harvested spans → write through any `Store` socket |
| Track cost per run | Automatic — `result.cost` and `loop:done` event |
| Catch typed errors programmatically | ProviderError, ToolError, TimeoutError, CircuitOpenError |
| Cache identical planner calls | Planner({ cacheTTL: 60000 }) |
| Stream CLIPipe output in real-time | CLIPipeProvider({ onChunk: fn }) |
| Get real usage + cost from a CLI provider | CLIPipeProvider({ parse: 'claude-json' }) |
| Drive tools over a CLI subscription — NATIVE, cheapest (no metered API) | CLIPipeProvider({ toolProtocol: 'claude-mcp', policy }) |
| Drive tools over a CLI with no MCP support (emulation) | CLIPipeProvider({ toolProtocol: 'claude' }) |
| Browse the web (inline snapshots) | createBrowsingTools + Loop |
| Browse the web (token-efficient, disk-based) | `barebrowse` CLI session — snapshots to `.barebrowse/*.yml` |
| Assess website privacy risk | createBrowsingTools + Loop (requires `npm install wearehere`) |
| Control Android/iOS devices | createMobileTools + Loop |
| Control mobile (token-efficient, disk-based) | `baremobile` CLI session — snapshots to `.baremobile/*.yml` |
| Read/write files, list directories, run shell commands, grep | createShellTools (shell_read/grep/**write**/**edit**/run/exec) + Loop({ policy }) — gate `shell_write`/`shell_edit` via `fs.writeScope` with an actionTranslator |
| Change one span of a big file without re-emitting the whole thing | `shell_edit({path, oldText, newText})` — anchored exact-once replace; the surgical alternative to whole-file `shell_write` (BA-13). Gate it as `{type:'edit'}` |
| Auto-discover MCP servers from IDE configs | createMCPBridge |
| Gate MCP tools with allow/deny lists | createMCPBridge + `.mcp-bridge.json` |
| Gate every tool call with one policy hook | `wireGate(gate).policy` → `Loop({ policy })` |
| Route policy decisions per user / tenant / chat | `wireGate(gate).policy` + `loop.run(msgs, tools, { ctx })` (ctx routes to bareguard's check via `_ctx`) |
| Cap total USD spend per run | `new Gate({ budget: { maxCostUsd: 0.50 } })` |
| Cap total tool-calling rounds | `new Gate({ limits: { maxTurns: 20 } })` |
| Audit every gated event to JSONL | `new Gate({ audit: { path: './audit.jsonl' } })` |
| Allowlist filesystem paths for shell tools | `new Gate({ fs: { readScope, writeScope, deny } })` |
| Allowlist `argv[0]` for shell_run | `new Gate({ bash: { allow: [...], denyPatterns: [...] } })` |
| Auto-deny Checkpoint prompts that never get a reply | Checkpoint({ timeout: 300000 }) |
| Get one hook for every silent-ish failure | Loop({ onError }) + `loop:error` stream events |
| Send messages across WhatsApp/iMessage/Signal/Discord/Slack/Telegram | createMCPBridge + beeperbox |
| **Spawn a child specialist agent** | createSpawnTool + bin/cli.js --config (v0.9+) |
| **Defer an action for later (cron-fired)** | createDeferTool + examples/wake.sh (v0.9+) |
| **Expose a large MCP catalog dynamically** | createMCPBridge → bridge.metaTools (v0.9+) |
| **Give a child agent litectx memory (read-only, own db)** | liteCtxMcpBridgeConfig → `cfg.mcp` in a spawn child config (RT-4) |

**Most projects start with Loop + Provider.** Add components as needed.

## Minimal wiring: Loop + Provider + Tool

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const provider = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
});

const tools = [{
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: async ({ city }) => ({ temp: 22, city, conditions: 'sunny' }),
}];

const loop = new Loop({ provider });
const result = await loop.run(
  [{ role: 'user', content: 'What is the weather in Berlin?' }],
  tools
);
// result: { text: "The weather in Berlin is 22°C and sunny.", toolCalls: [], usage: {...}, cost: 0.00045, error: null }
// cost = estimated USD based on model + token usage. Throws on error by default.
```

## Health check with validate()

```javascript
const result = await loop.validate(tools);
// result: {
//   provider: { ok: true },
//   store: { ok: true, skipped: false },
//   tools: { ok: true }
// }
// Never throws — all failures captured in the return structure.
// Store check skipped if no store was passed to Loop constructor.
```

## Wiring with Memory

```javascript
const { Loop, Memory } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { SQLite } = require('bare-agent/stores');

const store = new SQLite({ path: './agent-memory.db' });
const memory = new Memory({ store });

// Store context
memory.store('User prefers window seats on flights', { type: 'preference' });

// Search before a turn — inject results as system context
const relevant = memory.search('flight preferences', { limit: 5 });
const context = relevant.map(r => r.content).join('\n');

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  system: `Use this context:\n${context}`,
});
```

## Wiring with remember (consolidate harvested spans → durable facts)

`remember` is the consolidation pass: it distills the spans `stash` folded out of the live transcript into durable facts and writes them through the **same `Store` socket** Memory uses (`store/search/get/delete`) — so it works with any backend (JsonFile, SQLite, litectx, or your own), with no backend coupling. One cheap LLM pass per span keeps only durable signal (decisions, config, identifiers, stable prefs) and drops chatter, superseded values, and unanswered questions. It composes *around* the Loop — never inside it.

```javascript
const { remember, Memory } = require('bare-agent');
const { Anthropic } = require('bare-agent/providers');
const { JsonFile } = require('bare-agent/stores');

const memory = new Memory({ store: new JsonFile({ path: './facts.json' }) });

// `spans` are the harvested chunks stash evicted (lossless parks), or any finished-work transcript text.
const { facts } = await remember(spans, {
  provider: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-haiku-4-5' }),
  store: memory,                 // writes each fact as { kind: 'fact', ... } via memory.store()
  contract: 'only architecture + config decisions count as durable', // optional: steer "durable"
  ctx,                           // optional: counts each write into result.metrics.memory.facts (disjoint from `stored`)
  onLlmResult,                   // optional: forward distill-pass usage to a wired bareguard gate
});
```

Budget visibility carries through `onLlmResult` (mirror of Evaluator); a governance `HaltError` from the provider propagates clean. Cheap by design — a small model and one pass per span.

**Security:** facts are model output over *untrusted* transcript content written to durable memory. The distiller refuses a direct "record this fact" injection (validated live), but treat recalled facts as untrusted **context**, not authority — gate them like any model output before a privileged action.

## Wiring with judge (decisive return-time verdict + its calibration harness)

`judge` compares a user's **verbatim request** against **one structured egress artifact** and returns a decisive binary verdict — `honored` or `broke` — with a mechanical `where`. It is a caller-side judge (a governance gate that never calls an LLM completes its part with a fact envelope; the *call* lives here). It composes *around* a provider — never inside the Loop.

```javascript
const { judge } = require('bare-agent');
const { Anthropic } = require('bare-agent/providers');

const provider = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-haiku-4-5' });

const v = await judge({
  request: 'Book a flight under €300.',            // the VERBATIM user request (never the agent's paraphrase)
  artifact: { id: 'F1', price: 400, currency: 'EUR' }, // ONE structured egress artifact
  provider,
  onLlmResult,                                     // optional: forward usage/cost to a wired gate (kind:'judge')
});
// v.verdict → 'broke'
// v.where   → { field:'price', stated:'under €300', returned:'€400', evidence:'400 > 300' }
// v.costUsd → real cost (honest null if unpriced, never 0); v.truncated / v.parseError → distinct flagged outcomes
```

**Decisive by design.** `verdict` is `honored` only on a clean honor; a vague request you cannot *confirm* was honored floors to `broke` (surface what you cannot vouch for). A truncated or unparseable response is a **distinct flagged outcome** (`truncated`/`parseError`), floored to `broke` and — in the harness — excluded from every graded denominator. The artifact is treated as untrusted data: embedded "the user later said…" amendments are ignored.

**It is not a general safety layer.** The judge is drift-conditional — worth least exactly where a deterministic floor (a numeric cap, an allowlist) already binds. If you *can* express the constraint mechanically, do that instead. The judge **annotates**; it never merges, publishes, or touches a budget — the caller's close is the only truth.

**Mapping the verdict into bareguard's `gate.annotate` sink (if you use one).** The judge does **not** call `gate.annotate` — you do, in your close stage. Use the shipped pure helper `judgeToAnnotation` to render the verdict into bareguard 0.7.0's `{ surface, verdict, where, meta }` shape (the old `{kind, field, stated, returned, text}` sketch never shipped). It calls no gate and imports no bareguard:

```javascript
const { judge, judgeToAnnotation } = require('bare-agent');

const v = await judge({ request, artifact, provider });
gate.annotate(judgeToAnnotation(v));               // { surface, verdict, where, meta } — you make the gate call
// surface = v.verdict !== 'honored' (the load-bearing fail-open field)
// where   = a one-line mechanical address; meta = { field, stated, returned }
// carry the free-text evidence only if you want it: judgeToAnnotation(v, { includeEvidence: true })
```

Three gate caps are load-bearing and enforced by the sink **silently**: `verdict` clips at 80 chars, `where` at 300 chars (no marker), and `meta` is **all-or-nothing at 1000 bytes** — one byte over and the *whole* `meta` object is replaced with `{_truncated, bytes}`, losing field/stated/returned entirely. `judgeToAnnotation` bounds **defensively** against all three with a **visible** `…[clipped]` marker (evidence especially — a loud partial beats a silently-wiped one), and takes `opts.limits` so you can pass bareguard's real numbers rather than trust the defaults. It bounds even if your generator also bounds at source — a distinct defensive job, because it is the last code before a sink that clips silently and never throws.

> **Scope of the "facts survive" guarantee.** It holds for the **drained fact** and the **humanChannel event** — the source bound this adapter can reach. It does **not** cover the **persisted audit row** when the consumer has a redactor configured: redaction runs downstream of the adapter and *expands* each match into a longer `[REDACTED:…]` tag, so a `meta` built entirely from in-budget values can still blow the audit line's atomic-append cap and be replaced wholesale — no bound the adapter applies can prevent that. So don't assume the audit trail carries the mechanical facts; the drain and the event do. (The audit clip does carry a marker — `_truncated`, or `_unserializable` for a circular/BigInt meta — so a loss check there must test *both*.)

**Calibrate before you trust a tier.** A judge is only as good as its floor. The shipped calibration harness grades a frozen labeled set (with a €280-compliant false-positive trap) plus a 5-style injection battery, and **admits a tier only if it clears a pre-registered floor with zero reds AND resists every injection style** — a `constantHonored` negative control proves the harness can fail. The clear-case set is byte-equivalent to bareguard's frozen E6i fixture (`sha256(cases)=a840832…`), so the 7/7 is comparable to E6i's. Injection resistance is established at `claude-haiku-4-5` only; **re-run the harness on any tier you deviate to.**

```javascript
const { calibrate, constantHonored } = require('bare-agent');

const result = await calibrate({ provider, reps: 5, floor: 7 });
// result.admitted → true only if clear-case ≥ floor AND zero reds AND every injection style resisted
// result.reds → itemized per-case failures; result.e280 → the €280 false-positive watch case
// result.injectionBattery → { styles:[…], allResisted, leaks } — a 5-style gate (criterion 3); a leak blocks admission
// negative control MUST NOT be admitted:
const neg = await calibrate({ provider, reps: 5, floor: 7, judgeFn: constantHonored });
// neg.admitted === false
```

## Wiring with Skills + Stash (progressive disclosure + compaction)

Skills are operator-registered `{ name, description, instructions, tools }` bundles surfaced on demand: only a one-liner per skill sits in context until the agent calls `skill_use({ name })`, which injects the skill's instructions and unlocks its (namespaced) tools for the next round. Pass `skills.activeTools` (a bound thunk) as the Loop's `tools` — it is re-evaluated each round, so freshly-unlocked tools appear automatically. The gate still governs every unlocked tool; skills change discovery, not authorization.

The shipped reference skill is **stash** — compaction-first context hygiene. Its `trim` wires into `Loop({ trim })` and folds finished sub-tasks out of the live transcript (restorable), keeping long runs under budget. Pass a litectx instance as `ctx` for lossless verbatim parking + the `ctx.summarize` lossy path; set `compaction.ceilingTokens` to enable automatic token-pressure folding.

> **⚠️ Interaction with `cacheMessages` (BA-1).** Prompt caching is a **prefix match**: the transcript prefix *is* the cache key. A fold that rewrites the **head** of the transcript invalidates the cache, so the next round re-pays the 1.25× cache-write premium on the whole thing — you can end up paying *more* than with no caching at all. If you run both, **keep the head stable** (fold the MIDDLE, which is what `compaction.keepHeadTurns` is for) so the cached prefix survives the fold. The two features are complementary, but only in that order.

```javascript
const { Loop, SkillRegistry, createStashSkill } = require('bare-agent');
const { Anthropic } = require('bare-agent/providers');

const { skill, trim } = createStashSkill({
  // optional auto-compaction: fold the middle when measured input tokens cross 70% of the ceiling
  compaction: { ceilingTokens: 150000, triggerAt: 0.7, strategy: 'summarize' },
});

const skills = new SkillRegistry();
skills.register(skill);                       // catalog now lists "stash" in skill_use's description

const loop = new Loop({
  provider: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  trim,                                       // stash's fold runs here, at each round boundary
});

// Pass the bound thunk as tools; ctx carries litectx (lossless parking + summarizer).
await loop.run(messages, skills.activeTools, { ctx });
// The model: skill_use({name:'stash'}) → stash_checkpoint({label}) → …work… → stash_compact({label, reason})
```

Folds are provider-safe by construction (whole rounds, alternation-preserving note pairs) and confirmed on the real Anthropic wire. Governance, budget visibility (`ctx.summarize` tokens forward to the gate), and `result.metrics.context.compactions` all flow through unchanged.

## Multi-agent: spawn + defer + wake (v0.9)

Three primitives, no framework. The "always-on" feeling of multi-agent
systems is an illusion produced by *frequent stateless wakeups over
persistent JSONL*. UNIX figured this out in 1973.

```javascript
const { Loop, wireGate } = require('bare-agent');
const { Gate } = require('bareguard');
const { createSpawnTool, createDeferTool } = require('bare-agent/tools');

const gate = new Gate({
  budget: { maxCostUsd: 0.50 },          // shared across the family via BAREGUARD_BUDGET_FILE
  limits: { maxTurns: 20, maxChildren: 3, maxDepth: 2 },
  spawn:  { ratePerMinute: 5 },          // bareguard 0.2 — per-family
  defer:  { ratePerMinute: 10 },         // bareguard 0.2 — per-family
  audit:  { path: './bareagent-audit.jsonl' },
  humanChannel: async () => ({ decision: 'deny' }),
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate);
const { tool: spawn } = createSpawnTool();
const { tool: defer } = createDeferTool();

const tools = await filterTools([spawn, defer, ...otherTools]);
const loop = new Loop({ provider, policy, onLlmResult, onToolResult });
await loop.run(messages, tools);
```

**`spawn({ config, input? })`** — fork a child bareagent process with the
given config file path (a JSON specialist definition). Blocks until the
child exits; returns `{ text, usage, cost, error, events }`. The child is
invoked as `bare-agent --config <path>` (see `bin/cli.js` config-mode);
env-vars `BAREGUARD_AUDIT_PATH`, `BAREGUARD_PARENT_RUN_ID`,
`BAREGUARD_BUDGET_FILE`, `BAREGUARD_SPAWN_DEPTH+1` are threaded
automatically. Child stderr is captured and re-emitted as
`{type: 'child:stderr', text, ts}` events on the parent's stream — one
JSONL channel per child, no two-stream split. **The child config must
declare a `gate` block (v0.11.0)** — `bin/cli.js` refuses a gate-less
config (`exit 1`) rather than run a child with no policy/budget/depth
limits, since the parent gate only sees the config *path*, not its
contents. Set `"ungoverned": true` in the config to explicitly opt out.

**`defer({ action, when })`** — append a JSONL record to the queue file
(default `./bareagent-defers.jsonl`, override `BAREAGENT_DEFER_QUEUE`).
bareagent does NOT wake up later; the running process exits when the
loop ends. An external scheduler (cron + `examples/wake.sh`) reads the
queue and re-invokes bareagent at fire time. Returns `{ id }`.

**Two-phase defer (defense in depth):**

1. **Emit** (the `defer` tool): one `gate.check` on `{ type: 'defer', args: { action, when } }`.
   Runs the full pipeline — `defer.ratePerMinute` cap, `tools.allowlist`
   on `defer`, `content.*` over the JSON-serialized form. Bareguard does
   NOT extract `args.action` and run a second pipeline against it at
   emit time.
2. **Fire** (`wake.sh` invokes bareagent): a fresh `gate.check` on the
   inner action — full pipeline against it as if it had been called
   directly. Two distinct gate.check calls, two distinct audit lines,
   reconstructable via `parent_run_id`.

**Per-family rate caps.** `spawn.ratePerMinute` and `defer.ratePerMinute`
count audit-log records in a trailing 60s window keyed by the root
`run_id`. A fork-bombing child can't evade the parent's cap by spawning
its own children — they all share the family count. Defaults: defer
15/min, spawn 10/min.

**Reference cron + wake script:** `examples/wake.sh` (with
`examples/wake.md` for setup). The script folds the defer queue with
`jq -n` (null-input, so `inputs` reads *every* record — without `-n` the
first queue line is consumed as `jq`'s implicit input and silently
skipped), picks records where `when <= now() AND status === 'pending'`,
appends a `'fired'` line, and shells out to `bare-agent --config
<orchestrator>` with the inner action as stdin.

**End-to-end orchestrator example:** `examples/orchestrator/` ships a
parent + two specialists (summarizer, researcher). The orchestrator's
"intelligence" is its system prompt — there's no `class Orchestrator`,
no `dispatch_to_specialist()`. Roles are configs, not types. Adding a
new specialist is one JSON file.

### MCP catalog: bulk vs metaTools (v0.9)

`createMCPBridge()` now returns BOTH surfaces. Pick by catalog size:

```javascript
const bridge = await createMCPBridge();
// bridge.tools     — bulk-loaded array (every MCP tool, name-prefixed).
//                    LLM sees them all upfront. Token-cheap upfront, token-
//                    expensive per turn if catalog is big.
// bridge.metaTools — [mcp_discover, mcp_invoke] LLM-callable pair.
//                    Two tool slots in the LLM's view; LLM calls
//                    mcp_discover() to list, then mcp_invoke({ name, args })
//                    to use. Token-cheap per turn, slightly more turns
//                    if the LLM needs to discover.
```

Wire one or the other into Loop's tool array — never both (the LLM would
see the same MCP tool twice). Same RPC connections under the hood; one
factory, one source of truth, two output forms. **Lean: ~10 tools or
fewer → bulk. ~50+ tools → metaTools.**

Bareguard governs both forms, with one quirk for metaTools: it sees
`action.type === 'mcp_invoke'` (not the canonical inner name), and the
invoked tool name lives in `args.name`. To deny specific MCP tools when
using metaTools, use `tools.denyArgPatterns: { mcp_invoke: [/"name":"linear_admin_/] }`
or `content.denyPatterns` over the serialized action.

**Vetting server commands (v0.11.0; cwd default tightened v0.16.1).** Connecting
to a server runs its `command`. **Default discovery now scans only your
$HOME/IDE configs — NOT the project-cwd `./.mcp.json`** (v0.16.1): a checked-in
config in an untrusted repo would otherwise auto-spawn arbitrary commands. To
include the project config, pass `createMCPBridge({ includeProjectConfig: true })`,
or a `confirmServer` hook (which implies it, since the hook vets every command).
Explicitly-passed `configPaths` are honored verbatim. So you're not left guessing,
discovery logs a one-line hint (v0.16.2) when a `./.mcp.json` is present but skipped —
naming the opt-in — rather than silently ignoring it. Pass `confirmServer(name,
def) => boolean` to approve each server **before its command is spawned** (return
`false` to skip it; a throw fails closed). When no `confirmServer` is set, the
bridge still trusts all *discovered* servers and prints a one-time warning naming
every command it is about to spawn — `confirmServer` is how you actually *gate* it.

**RPC timeouts (Unreleased).** Every JSON-RPC round-trip is now bounded, so a
server that never answers can't hang the bridge or the loop. `opts.timeout`
(default 15 s) bounds the handshake (`initialize` + `tools/list`);
`opts.callTimeout` (default 120 s, `0` disables) bounds each `tools/call`. A
timed-out tool call rejects with a `timed out after Nms` `ToolError` rather
than blocking forever; a server that breaks its stdin pipe surfaces as a
failed connection, never an uncaught `EPIPE` crash.

## Wiring with bareguard

Every tool call (native, MCP, browsing, mobile, user-defined) flows through `Loop.run()`. The `policy` option is the single chokepoint; the recommended wiring delegates every decision to a [bareguard](https://github.com/hamr0/bareguard) `Gate`. Bareguard owns the audit log, budget caps, content rules, fs/net/bash primitives, and humanChannel — bareagent just respects the verdict.

```javascript
const { Gate } = require('bareguard');
const { Loop, wireGate } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createShellTools } = require('bare-agent/tools');

const gate = new Gate({
  budget: { maxCostUsd: 0.50 },
  limits: { maxTurns: 20 },
  fs:     { readScope: ['/tmp', '~/Projects'], deny: ['/etc'] },
  bash:   { allow: ['ls', 'cat', 'grep', 'ps', 'df'] },          // argv[0] allowlist
  audit:  { path: './audit.jsonl' },
  humanChannel: async (event) => ({ decision: 'deny' }),         // wire to your UI
  // humanChannelTimeoutMs: 60_000,                                // optional (bareguard ≥0.3) — timeout-deny if your channel hangs
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate);
const { tools: shellTools } = createShellTools();
const tools = await filterTools(shellTools);                       // drop denied tools from the LLM's view

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  policy,
  onLlmResult,                                                     // forwards LLM cost to gate.record (BA1)
  onToolResult,                                                    // forwards tool result + ctx (BA1)
});

const result = await loop.run(messages, tools, { ctx: { userId: 42 } });
if (result.error?.startsWith('halt:')) {
  // budget / turn cap / gate terminated — handled cleanly, no [HALT:] reached the LLM (BA2)
  // result.text still holds whatever the model produced before the bound fired (BA-5) — feed it
  // forward to the next attempt. `error` is the success signal; non-empty text ≠ converged.
}
```

**Why four pieces (`policy` + `onLlmResult` + `onToolResult` + `filterTools`).** `policy` runs `gate.check` *before* every tool call. `onLlmResult` fires after every successful `provider.generate` — without it, `budget.maxCostUsd` never sees LLM cost and is silently undercounted for token-heavy / tool-light workloads (every chatbot). It also fires for the out-of-band `ctx.summarize` call (R-C6) tagged `kind:'summarize'`; main-loop rounds carry `kind:'turn'` — so summary-window tokens count against the budget too, and a consumer can tell the two apart. `onToolResult` fires after every `tool.execute` and carries the per-run `ctx` opaque blob into `gate.record` so per-principal accounting works. `filterTools` is a `gate.allows` pre-filter — denied tools are dropped from the catalog the LLM ever sees, no `gate.check` round-trip per call.

Halt-severity decisions exit the loop cleanly via a typed `HaltError` — full mechanics (sealed `msgs`, `halt:<rule>` error token, `loop:done{halted:true}` event, `throwOnError:true` interaction, `halt:unknown` coalesce) are in the **Halt decisions throw `HaltError`** paragraph below. Short version: check `result.error?.startsWith('halt:')` after the run.

**A bound that fires PRESERVES the model's work (BA-5, v0.27+).** Every terminating path — governance halt, the deny-spin short-circuit, a provider error under `throwOnError:false`, `loop.stop()`, and the internal hard round limit — returns the **last non-empty assistant text** in `result.text` instead of `''`. If you drive bare-agent from an outer retry loop (`while not-done and under-cap: run the worker`), a bound firing is **normal termination**, not an exception, and that text is your only channel from attempt N to attempt N+1 — before this, a bounded attempt taught its successor nothing. Two rules: **`error` is the sole success signal** (a non-empty `text` never means the run converged — always branch on `error`), and `text` is `''` when the model genuinely produced none (no placeholder is invented, so you can trust emptiness). Under `recurse` this is what finally populates `best` on an incomplete node. Relatedly, **`loop.stop()` now returns `error: null`** — a deliberate stop is not a fault; it previously fell through to the hard-round-limit return and reported that safety warning as its error, indistinguishable from a runaway.

**A TRUNCATED round is reported, never laundered into a finish (BA-6, v0.27+).** Every provider now surfaces `GenerateResult.stopReason` — normalized across all five to one neutral vocabulary (`end_turn`, `max_tokens`, `tool_use`, `stop_sequence`, `refusal`, `pause_turn`, `context_exceeded`; `null` when the provider doesn't report one, e.g. CLIPipe). Before this, **no** provider read its finish-reason field, so a round the API **cut off at the output cap** hit the Loop's *"no tool calls ⇒ final answer"* rule and came back as a **clean finish with `error: null`** — a truncation indistinguishable from a model that chose to stop. It now returns **`result.error === 'truncated:max_tokens'`** with the partial text preserved (BA-5). Check `result.error === null` for success, as always. Note the **default `maxTokens` is 4096** and is deliberately unchanged: raising it silently lifts every adopter's ceiling and bill, which is the same class of sin as the silent truncation. If you run a reasoning model on hard tasks, **raise it yourself** — `loop.run(msgs, tools, { maxTokens: 16000 })` (it's a `run()` option, forwarded to the provider), and now you'll get a loud error instead of a quiet empty answer when you don't.

**A truncated round's tool calls are REFUSED, and this is load-bearing.** A **complete** tool call always arrives tagged `tool_use`, **never** `max_tokens` (measured on the real API). So a tool call riding a truncated round was **cut off mid-generation with arguments missing** — which is exactly how a `shell_write` whose `content` never arrived emptied a 1789-line file (BA-4). The Loop therefore never executes the tool calls of a `max_tokens` round: it returns `truncated:max_tokens` instead. Refusing discards nothing legitimate, and it closes that data-loss path for **every** tool you grant, not just `shell_write`.

**Every non-clean terminal stop reason is error-tagged, and `stopReason` rides every return (BA-13, v0.28+).** BA-6 fixed exactly one stop reason (`max_tokens`); the others still laundered a non-finish into a clean `error: null`. They no longer do:
- `refusal` → **`result.error === 'refusal'`** (partial text preserved). A safety refusal is **not** an empty success. `RECITATION` fires on entirely benign prompts, so this is reachable on ordinary runs.
- `context_exceeded` → **`result.error === 'context_exceeded'`** (ran out of context window — a spend/limit story, distinct from the output cap).
- `pause_turn` → the Loop **resumes** the turn (a resumable server-tool pause is neither terminal nor an error). Resuming appends the paused assistant turn (its partial text + provider-native server-tool blocks) and re-requests — the documented Anthropic pause_turn protocol, so the server continues where it left off rather than restarting. A pause that never progresses is caught by the same `HARD_ROUND_LIMIT` / gate `maxTurns` bounds as any non-advancing loop.
- The tool calls of a `refusal` / `context_exceeded` round are **refused, not executed** — the same BA-4 closure as `max_tokens`.

And **`result.stopReason`** (the neutral value, or `null`) is now present on **every** `Loop.run()` return, not only the clean-finish path — branch on it when you need *why* a run ended, not just *whether* it succeeded. **`error` stays the sole success signal** (`result.error === null`), and this is deliberately error-tagged rather than "surface `stopReason` only": `recurse` and any consumer following that invariant branch on `error`, so a refused worker now propagates an honest `{ incomplete }` up the tree with **zero recurse changes**. **Behavior change to note:** a refused round that previously returned `error: null` + empty text now returns `error: 'refusal'` — the point of the fix, but branch on `error`, not emptiness.

**Deny-spin short-circuit (`maxConsecutiveDenials`, default 3, v0.25+).** A *non-halt* deny (a `policy` verdict that isn't `true` — e.g. a `humanChannel: deny`, an allowlist miss, a `content`/`fs.writeScope` block) is **advisory**: it's fed back to the model as a tool result so the model can pivot to a different allowed tool. But a model that keeps retrying the *same* denied action would otherwise spin every round until your `budget.maxCostUsd` finally halts it — burning the whole cap with no progress (this bit a coding agent whose write kept tripping `content.askPatterns`). The Loop now counts **consecutive** denials (any allowed call resets the streak, preserving the pivot) and short-circuits at `maxConsecutiveDenials` with `result.error === 'denied:<tool>'` (a clean return, transcript sealed — never a throw). Check `result.error?.startsWith('denied:')` to distinguish a governance block from a completed run; set `maxConsecutiveDenials: 0` (or `Infinity`) on `new Loop({...})` to restore the pure-advisory behavior. Under `recurse`, a short-circuited worker returns a **labeled** `{ incomplete: true, blocker: 'governance-deny' }` (and `receipts.blocker`) so you can widen scope / re-gate / escalate rather than read it as a model failure.

**Stuck-tool short-circuit (`maxIdenticalToolErrors`, default 3).** The error-side mirror of the deny guard, for the case where the *tool itself* keeps rejecting. A tool error is fed back to the model **on purpose** — that's how it learns the path was wrong and adapts — so the guard fires only on a **byte-identical** repeat: same tool name, same `JSON.stringify(arguments)`, N times in a row. Then the model isn't recovering, it's re-sending a call that cannot succeed, and the Loop returns `result.error === 'stuck:<tool>'` (clean, transcript sealed). This includes a repeated call to a tool that **doesn't exist** — a model that hallucinates the same unknown tool every round gets `[Loop] Unknown tool` fed back and can spin on it exactly as hard as on a throwing tool, so it counts toward the same guard. **Any successful tool call resets the streak**, and a model that *varies* its arguments (or the hallucinated name) never trips it. Counting *any* consecutive tool error instead was tried and rejected — it kills a model legitimately recovering from an `ENOENT` by trying a different path. Set `maxIdenticalToolErrors: 0` (or `Infinity`) on `new Loop({...})` to disable.

> Note the division of labour with **BA-6**: if the tool call was *cut off* by the output cap, you get `truncated:max_tokens` and the tool is **never executed at all** — that path is closed upstream. `stuck:` covers the residual case: a fully-formed call on an untruncated round that fails for its own reasons — the tool executes and rejects it (bad path, failed validation), or the tool name doesn't exist at all — repeated byte-identically.

**Thinking blocks are preserved and replayed (BA-7).** On `claude-sonnet-5` (and Opus 4.7+) **adaptive thinking is the default** — the API returns `thinking` blocks on a good fraction of rounds **whether or not you ask for them** (measured: ~3/10; sending `thinking:{type:'adaptive'}` explicitly changed the rate not at all). Anthropic's contract is that those blocks are echoed back **unchanged, `signature` included**, when a tool-use conversation continues. Before 0.27 bare-agent dropped every one of them, silently — and because the API returns **200** either way, nothing ever surfaced.

The blocks now ride the transcript on `Message.providerBlocks` (`{provider, model, blocks}`) and the Anthropic provider replays them at the front of the assistant turn. **You get this for free — no flag.** Two things to know if you touch the transcript yourself: the blocks are **opaque** (keep the bytes; don't rebuild them from parsed fields — a `redacted_thinking` block won't survive it), and they are **tagged with the model that signed them** — a signature is model-bound, so swapping models mid-transcript drops them rather than sending a signature the new model will reject. If you persist and replay transcripts, keep `providerBlocks` intact through your serializer.

`AnthropicProvider({ thinking })` is a separate, opt-in knob, forwarded to `body.thinking` verbatim (e.g. `{type:'adaptive', display:'summarized'}` to surface the reasoning; the default `display` is `'omitted'`). **It does not "turn thinking on"** — it's already on. Use it to pin the mode or reach `display`/`effort`. It is passed through unvalidated on purpose: `budget_tokens` was removed from the API and now **400s** on sonnet-5/Opus 4.7+, so a library that reshaped this parameter would need a release every time Anthropic moved.

> **Honesty note, and we mean it.** This is a **protocol/data-loss fix, not a capability fix.** A head-to-head with thinking fully preserved vs. stock bare-agent produced **indistinguishable** outcomes. Do not adopt 0.27 expecting better reasoning — you will not get it, and we have the measurement.

Legacy `wrapTool` / `wrapTools` are retained as deprecation shims (one-shot console warning, removal in 1.0). Migration: replace `wrapTools(tools)` at `loop.run()` with `filterTools(tools)` once upfront + `onLlmResult` / `onToolResult` on `new Loop({...})` to pick up LLM-cost recording and `_ctx` threading.

**`actionTranslator` for bash/fs primitive activation (v0.10.1+).** Bareguard's `bashCheck` / `fsCheck` / `netCheck` only fire when `action.type === 'bash'` / `'read'` / `'write'` / `'fetch'`. The default action shape is `{type: toolName, args, _ctx}` which matches `tools.denylist` / `tools.allowlist` but does NOT activate those primitives. Adopters who want both pass `wireGate(gate, { actionTranslator })`. Since bareguard 0.4.1+, the primitives read fields from either flat (`action.cmd`) or nested (`action.args.cmd` / `.command`) shapes, so you can pass args through verbatim:

```javascript
const { policy, onToolResult } = wireGate(gate, {
  actionTranslator: (toolName, args, ctx) => {
    if (toolName === 'shell_exec')  return { type: 'bash', args, _ctx: ctx };   // bareguard 0.4.1+ reads args.command
    if (toolName === 'shell_run')   return { type: 'bash', args, _ctx: ctx };   // reads args.argv → joins to cmd
    if (toolName === 'shell_read')  return { type: 'read',  args, _ctx: ctx };  // reads args.path
    if (toolName === 'shell_write') return { type: 'write', args, _ctx: ctx };  // gate by fs.writeScope (reads args.path)
    if (toolName === 'shell_edit')  return { type: 'edit',  args, _ctx: ctx };  // same fs.writeScope as write (reads args.path)
    return { type: toolName, args, _ctx: ctx };          // fall through to defaultActionTranslator
  },
});
```

`onLlmResult` always uses `{type:'llm'}` regardless of the translator (so budget rules match without translator collusion). `defaultActionTranslator` is exported for composition. **A tool is NOT auto-gated by the fs/bash primitives without this translator** — e.g. `shell_write` runs the write but `fs.writeScope` only enforces once `shell_write` → `{type:'write', path}`; the default `{type:'shell_write'}` matches `tools.allow/denylist` only. Verified live: with the translator, `gate.check` ALLOWs `shell_run ["ls","/tmp"]` and DENYs `shell_read /etc/passwd` (`[deny: fs.readScope]`), and an out-of-scope `shell_write` is denied **before** `execute` (nothing touches disk).

**Bounding tool rounds — use `limits.maxToolRounds` (bareguard 0.4.2+), not doubled `maxTurns`.** `limits.maxTurns` ticks on every `gate.record` (LLM + tool), so an "N LLM-tool round" cap is `maxTurns: N*2`. `limits.maxToolRounds: N` ticks only on non-`llm` records and gives the natural semantic — pairs cleanly with our split `onLlmResult` / `onToolResult` (the LLM side writes `{type:'llm'}` records which the counter skips). Halt severity, same shape as `maxTurns`, rebuilt from audit on cold-start.

**`HaltError` reachable from the public API (v0.10.1+).** `require('bare-agent').HaltError`, `require('bare-agent/errors').HaltError`. Adopters whose policy shim throws `HaltError` get identity-equal class across module boundaries — Loop's `instanceof HaltError` catches it cleanly.

**`Loop({ maxRounds })` throws (v0.10.1+).** The pre-v0.8 option is now an explicit error pointing at bareguard's `limits.maxTurns`. Silent-ignore migration foot-gun removed.

**Halt decisions throw `HaltError` and Loop exits cleanly (v0.10.0+).** When bareguard halts (budget exhausted, `limits.maxTurns`/`maxToolRounds` hit, content rule fired with `severity: 'halt'`), `wireGate.policy` throws a typed `HaltError`. Loop's outer handler catches it, emits `loop:error{source:'halt'}` + `loop:done{halted:true, rule, cost}`, calls `onError`, and returns `{ error: 'halt:<rule>', msgs }` — **even when `throwOnError:true`** (halt is a governed exit, not a runtime failure). The halt **never** reaches the LLM as a tool message. Adopters react via `result.error?.startsWith('halt:')` or the `loop:done{halted:true}` event. When the throwing code path lacks a rule, the token is the stable `halt:unknown` (not `halt:null`). On a mid-round halt, the returned `result.msgs` is sealed: every dangling assistant `tool_calls` id gets a synthetic `[halted:<rule>]` `role:'tool'` reply so the transcript is valid OpenAI shape (safe to feed back into another provider call). The `[halted:]` lowercase tag is distinct from the legacy `[HALT:]` string — that one is reserved for the pre-0.10 deny-string mode and is now dead code in bareagent.

**Same gate covers every tool source.** MCP tools from `createMCPBridge`, browsing tools from `createBrowsingTools`, mobile tools from `createMobileTools`, and any user-defined tool all flow through `policy` (`gate.check`) before invocation and `onToolResult` (`gate.record`) after — bareguard does no MCP-specific parsing, just glob-matches `tools.allowlist` / `tools.denylist` on the canonical name string.

**Migration map (v0.7 → v0.8):**

| You had | Move to |
|---|---|
| `new Loop({ maxCost: 0.50 })` | `new Gate({ budget: { maxCostUsd: 0.50 } })` |
| `new Loop({ maxRounds: 20 })` | `new Gate({ limits: { maxTurns: 20 } })` |
| `new Loop({ audit: './x.jsonl' })` | `new Gate({ audit: { path: './x.jsonl' } })` |
| `pathAllowlist({ allow, deny })` | `new Gate({ fs: { readScope: allow, deny } })` |
| `commandAllowlist({ allow })` | `new Gate({ bash: { allow } })` |
| `combinePolicies(a, b, c)` | Stack primitives in one Gate config — they compose as one eval |
| `MaxCostError` / `MaxRoundsError` | `try { ... } catch { ... }` → check `result.error?.startsWith('halt:')` (e.g. `halt:budget.maxCostUsd`, `halt:limits.maxTurns`). HaltError is also catchable via `require('bare-agent').HaltError` if your wiring throws it explicitly. |

**Policy return values (Loop's contract is unchanged):**

| Return | Effect |
|---|---|
| `true` | Tool executes normally. |
| `false` | Tool call aborted. Generic `[Loop] Tool "X" denied by policy` returned to the LLM as tool result. |
| `string` | Returned verbatim to the LLM as the deny reason. `wireGate` produces these for every gate deny. |
| throws | Treated as a deny. The thrown message becomes the reason. Loop continues. |
| omitted | Allow-all. Useful for development; never in production — that's what bareguard is for. |

### Per-caller governance with ctx (multi-user, multi-tenant)

The policy signature accepts a third arg `ctx` — an opaque blob you pass per-call via `loop.run(msgs, tools, { ctx })`. `wireGate` forwards it as `_ctx` on every `gate.check({ type, args, _ctx })`, and you can branch on it inside bareguard's `humanChannel` callback or via custom primitives.

```javascript
// Tools were pre-filtered once at startup via filterTools (catalog pre-filter);
// runtime per-call governance comes from policy + onToolResult, both wired on
// the Loop constructor. ctx is forwarded as the third arg to policy and into
// onLlmResult / onToolResult → bareguard's gate.record as `_ctx`.
await loop.run(messages, tools, {
  ctx: { senderId, chatId, isOwner, adminGroupIds },
});
```

For routing rules that don't fit bareguard's primitives (e.g. "owner can do anything; user can only read"), you can layer a custom closure on top of `wireGate(gate).policy` — but the cleaner pattern is one source of truth: encode the rules as bareguard primitives and let the gate evaluate them.

### Catalog pre-filter (omit denied tools from the LLM's view)

`wireGate(gate).filterTools(tools)` drops denied tools from the catalog before the LLM sees them. It calls `gate.allows(name)` in parallel for every tool — a pure predicate (no audit write, no budget delta) — and returns the filtered array. Bulk only: handles tools registered by name (native, MCP bulk-loaded, shell, browsing, mobile). For MCP meta-tools (`mcp_invoke`), inner names live inside `args.name` and are gated via `tools.denyArgPatterns` instead — see the MCP recipe below.

```javascript
const { filterTools } = wireGate(gate);
const visibleTools = await filterTools(allTools);
const result = await loop.run(messages, visibleTools);
```

For arg-aware *filtering* (rare — usually you want arg-aware *gating*, which is policy's job), drop to `gate.allows({ type: 'send_message', args: { chat_id } })` directly. Pre-filter is a context optimization; gov decisions still happen at invoke time via `policy` (= `gate.check`).

### Checkpoint vs bareguard's humanChannel

- **`humanChannel`** (bareguard) — fires for *policy-driven* asks/halts (budget about to overrun, content rule wants a confirm, halt-severity event needs ack). One callback, one place to wire your UI.
- **`Checkpoint`** (bareagent) — fires for *always-prompt* flows that aren't policy-driven (e.g. "always confirm before sending an email", regardless of who or why). Stays for that case.

Both can route to the same underlying chat / terminal / Slack helper. Both also support a deadline so a hung UI can't pin the agent forever — bareguard ≥0.3 takes `humanChannelTimeoutMs` (timeout always denies, never allow), bareagent's Checkpoint takes `timeout` (default 5 min, throws → auto-deny).

### Checkpoint timeout — no silent hangs

`Checkpoint.waitForReply()` is async and used to hang forever if the user never replied. As of v0.7.0, Checkpoint accepts a `timeout` option (default 5 minutes). On expiry it throws `TimeoutError`; the Loop catches it, auto-denies the tool call with reason `"Checkpoint failed: ... auto-denied"`, and routes the error through `loop:error` + `onError`.

```javascript
const checkpoint = new Checkpoint({
  tools: ['send_email', 'shell_exec'],
  send: async (q) => await platform.send(chatId, q),
  waitForReply: async () => await waitForChatReply(chatId),
  timeout: 10 * 60 * 1000,  // 10 minutes (default is 5)
});

const loop = new Loop({ provider, checkpoint });
```

Set `timeout: 0` to opt out and keep the old "hang forever" behaviour.

**Approval is fail-closed (v0.11.0).** The Loop proceeds **only** when `waitForReply` resolves to an explicit affirmative — `"yes"`, `"y"`, `"approve"`, or `"approved"` (trimmed, case-insensitive). Every other reply denies, including unrecognized strings (`"ok"`, `"sure"`, `"denied"`), empty, and non-strings. Wire your transport to return one of the affirmatives on approval; before v0.11 any non-`"no"` reply was treated as approval.

### Unified error surfacing — three hooks, one principle

*No silent failures.* Every previously-silent failure path in bareagent now routes through one of three operator hooks:

| Hook | Use for | Fires on |
|---|---|---|
| `Gate({ audit: { path } })` | Forensic replay, compliance, billing | Every gated event (check + record) — bareguard owns this |
| `stream` + a transport | Live telemetry (Datadog, Sentry, Loki) | Every loop event including `loop:error` |
| `onError(err, { source, ...meta })` | Pager-style alerts (one function, one-liner) | Provider errors, callback throws, Checkpoint timeouts, stream listener exceptions |

```javascript
const loop = new Loop({
  provider,
  policy,   // from wireGate(gate)
  stream,
  onError: (err, meta) => {
    // Fires for every silent-ish failure with { source, ...extra }
    // source ∈ {'provider', 'callback:onToolCall', 'callback:onText',
    //           'checkpoint', 'stream'}
    pager.send({ level: 'warn', source: meta.source, err: err.message });
  },
});
```

If you run bareagent headless, **wire at least `onError`, a `Gate` with an audit path, and a `humanChannel` callback** (the latter is required by bareguard — without it, ask/halt events return silent denies). Otherwise you are flying blind.

## Wiring with Checkpoint (human approval)

```javascript
const { Loop, Checkpoint } = require('bare-agent');

const checkpoint = new Checkpoint({
  tools: ['send_email', 'purchase'],  // these tools require approval
  send: async (question) => console.log(question),
  waitForReply: async () => {
    // wire to your chat platform, readline, etc.
    return 'yes';
  },
});

const loop = new Loop({ provider, checkpoint });
```

## Wiring with Scheduler

```javascript
const { Scheduler } = require('bare-agent');

const scheduler = new Scheduler({
  file: './jobs.json',   // persist across restarts
  interval: 60000,       // tick every 60s
  onError: (err, job) => console.error(`Job ${job.id} failed:`, err.message),
});

scheduler.add({ schedule: '2h', action: 'check inbox', type: 'recurring' });
scheduler.add({ schedule: '0 9 * * 1-5', action: 'morning briefing', type: 'recurring' }); // cron requires cron-parser

scheduler.start(async (job) => {
  try {
    const result = await loop.run(
      [{ role: 'user', content: job.action }],
      tools
    );
    // do something with result
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err.message);
  }
});
```

## Wiring with Planner + StateMachine

```javascript
const { Planner, StateMachine, Loop } = require('bare-agent');

const planner = new Planner({ provider });
const state = new StateMachine({ file: './tasks.json' });

const steps = await planner.plan('Book a trip to Berlin');
// steps: [{ id: 's1', action: 'Search flights', dependsOn: [], status: 'pending' }, ...]

// Option A: manual sequential execution
for (const step of steps) {
  state.transition(step.id, 'start');
  try {
    const result = await loop.run(
      [{ role: 'user', content: step.action }],
      tools
    );
    state.transition(step.id, 'complete', result.text);
  } catch (err) {
    state.transition(step.id, 'fail', err.message);
  }
}
```

## Wiring with runPlan (parallel execution)

```javascript
const { Planner, runPlan, StateMachine } = require('bare-agent');

const planner = new Planner({ provider });
const steps = await planner.plan('Book a trip to Berlin');

// runPlan executes steps in dependency-respecting waves with parallelism
const results = await runPlan(steps, async (step) => {
  const result = await loop.run(
    [{ role: 'user', content: step.action }],
    tools
  );
  return result.text;
}, {
  concurrency: 3,                          // max 3 parallel steps per wave
  stateMachine: new StateMachine(),         // optional lifecycle tracking
  onWaveStart: (num, steps) => console.log(`[Wave ${num}]: ${steps.map(s => s.id).join(', ')}`),
  onStepStart: (step) => console.log(`Starting: ${step.action}`),
  onStepDone: (step, result) => console.log(`Done: ${step.id}`),
  onStepFail: (step, err) => console.error(`Failed: ${step.id}: ${err.message}`),
});
// results: [{ id: 's1', status: 'done', result: '...' }, { id: 's2', status: 'failed', error: '...' }, ...]
```

## Wiring with recurse (RLM — decompose → fan-out → verify → synthesize)

`recurse(task, ctx, opts)` is the **Recursive Language Models** primitive (v0.20.0): one import that decomposes a hard task into fresh-context workers, verifies against a setpoint, and synthesizes one result. It is **thin glue composed around `Loop`/`Planner`/`runPlan`/`Evaluator`/`spawn`** — not a new engine, never imported by `loop.js`. Returns `{ result, verdict, receipts }` on convergence, or `{ incomplete, best, missingSlices, receipts }` on guard exhaustion / a dead worker — **never a fabricated success** (RC-9).

> **⚠️ Cost is open by DESIGN — wire a gate.** `recurse()` adds NO intrinsic total-work cap. On the **Family-A default** (model-driven) a node can spawn up to ~100 children per level, each recursing to `opts.maxDepth` (default 3) — so token/$ spend compounds and is bounded **only by your gate**, not by recurse. A live POC saw a weak model do 40–117 calls in one run. **Always wire bareguard** (`ctx.policy` via `wireGate`) for any non-trivial or untrusted run — it enforces depth/budget/call caps and turns a runaway into a clean `{ incomplete }` (proven: a wired `Gate` cut a 43–117-call runaway to 4–5 calls). The local brake without a gate is `opts.maxDepth: 1` (flat, no nesting). The forced modes (`mode:'fanout'`/`'partition'`) ARE bounded (deterministic count + concurrency cap).

```javascript
const { recurse, wireGate } = require('bare-agent');
const { Gate } = require('bareguard');

// ALWAYS run governed for real work — the gate is the total-work bound.
const gate = new Gate({ budget: { maxCostUsd: 0.50 }, limits: { maxTurns: 30, maxDepth: 3 }, humanChannel: async () => ({ decision: 'deny' }) });
await gate.init();
const { policy, onLlmResult } = wireGate(gate);

// ctx = runtime wiring threaded down the whole tree; opts = policy knobs.
const ctx = { provider, policy, onLlmResult };     // policy + onLlmResult = the gate over every node + the verifier
const out = await recurse('Audit this 2000-line module for security bugs and rank them', ctx, { maxDepth: 3 });

if (out.incomplete) {
  console.warn('did not converge:', out.missingSlices, '— best partial:', out.best);  // honest, never a faked pass
} else {
  console.log(out.result, out.verdict);            // the synthesized answer + the verifier's gap report
}
console.log(out.receipts.spawned.length);          // RC-10 audit tree: parent→child lineage, per-node tokens/verdict
```

> **Audit-safe by construction (since Unreleased).** You pass `provider` on `ctx`, and a wired gate records the per-run ctx VERBATIM as `action._ctx`. `recurse()` **strips the live provider** (and thus its `apiKey`) from the ctx at every governance boundary before it reaches `gate.record`/`gate.check`, so the key never lands in the audit JSONL — only the provider *name* does (identity, not secret). The provider still reaches the worker (it runs); only the audited copy is cleaned. (bareguard's own secret-redaction is opt-in and value/pattern-based, so do not rely on it to catch a key you put on `ctx` — but DO scrub any *other* secret-bearing field you thread on `ctx` yourself, or configure `gate` `secrets`.)

**Control families (how the tree is shaped):**

- **Family A — model-driven (default).** The worker is handed an in-process `spawn_child` tool and *decides* whether to split. `assessComplexity` is a **hint, not a gate** (only `simple → single-shot`, and the non-overridable `critical → force adversarial verify` safety floor). Nothing extra to set.
- **Family B — forced fan-out (opt-in).** `{ count: N }` → exactly N independent parallel workers via `Planner`→`runPlan`; or `{ mode: 'fanout' }` → count derived from the complexity tier (medium/complex/critical → 2/4/6). Deterministic + concurrency-capped.
- **`{ mode: 'partition', corpus, workerBudget }`** — data-driven WIDTH: measure the corpus, split into `max(count floor, ⌈size/workerBudget⌉)` parallel scan-workers, union-count. A pre-wave `recurse_partition` policy checkpoint fires before any worker spends.

**Retrieval over a corpus** (`opts.corpus = {id,text}[]` or an async `() => Promise<Slice[]>`, e.g. `litectxCorpus(litectx, {kind})`). Context reaches a worker as a HANDLE routed by question shape:

| `retrieval` | For | Note |
|---|---|---|
| `'scan'` *(default when `corpus` present)* | "how many / all / count" | scans every slice, LLM-judges, **CODE-counts** the union — the only path that can't undercount; `window` 8, `passes` 2 |
| `'search'` | find a needle | litectx `recall` tool (needs `ctx.litectx`), embeddings on — **cannot count** |
| `'exact'` | rule / exact-term match | code-side AND-filter, embeddings off |
| `'tools'` | mixed task (needle *and* count) | offers `scan_count` + `search_memory` + `exact_match`; worker picks per sub-query by tool description |

A completeness guard **upgrades** a `'search'` on a "how many / all" ask to `'scan'` (upgrade-only, never a silent downgrade). Aggregation is **always code**, never a model-stated number.

```javascript
// Honest count over a corpus — scans every slice, code-counts the matches.
const { result } = await recurse(
  'How many of these support tickets are billing disputes?',
  { provider, policy },                            // still wire the gate
  { corpus: tickets /* {id,text}[] */, retrieval: 'scan' },
);
console.log(result.count, result.matchedIds);      // a code-derived count + the ids that back it
```

**Synthesis (`opts.synthesize`):** a **function** (deterministic code-reduce over child `results` — use for arithmetic/aggregation; LLM arithmetic over partials carried ~10–15% error), or `'concat'` (lossless no-LLM join), or `'merge'` (isolated Loop-driven subjective merge). Default = the parent model's own closing-turn synthesis. **`opts.contract`** = a definition-of-done the verifier grades against (instead of the loose task); **`opts.evaluate`** overrides the verifier. Exported helpers for the per-query face: `buildScanTool`, `buildSearchTool`, `buildExactTool`, `litectxCorpus`.

**Worker persona (`opts.persona`, v0.21.0):** a string PREPENDED to every Family-A worker's system prompt — give workers a stance (`persona: 'You are a senior security engineer; be specific and cite the exact file:line'`). It **augments**, never replaces, the built-in decomposition policy + depth-scrub (those drive the spawn mechanics), and **carries down the whole tree** (a child of a "senior security engineer" is still one). It is deliberately **not** applied to the isolated verifier (that isolation is what defeats self-grading sycophancy) nor the deterministic scan judge. Absent ⇒ the worker prompt is unchanged from pre-0.21. **Security:** treat `persona` like a system prompt — it is prepended ahead of the decomposition policy and can override it for every worker, so pass caller-trusted text only, never untrusted/end-user input.

```javascript
const out = await recurse('Audit auth.js, billing.js, gateway.js for authz bugs', ctx, {
  persona: 'You are a blunt senior application-security engineer. Report each finding as file:line + impact + fix.',
});
```

**Worker context (`opts.context`, v0.23.0):** a read-only working-context string (paths/cwd) PREPENDED to every worker's TASK message as a `Working context:` block — so a sliced child can **locate its artifact** (the Planner paraphrases the goal into subtasks and drops absolute paths; without this, workers guess `.`/`~`/`/tmp` and get denied). Forwarded to the Planner as `info` (path-aware slices) and shown to the verifier too (neutral FACTS, not a stance — distinct from `persona`, which is a privileged SYSTEM-prompt stance). Carries down the tree. **Security:** it still becomes part of the prompt, so pass caller-trusted run-state only, never untrusted/end-user text (lower-privilege than `persona` — user message, not system — but still an injection surface). Absent ⇒ the task message is unchanged.

**Leaf self-correction (`opts.refineLeaf`, v0.23.0, opt-in):** turn a **definite leaf** (a node offered no `spawn_child` — `simple` tier or at `maxDepth`) into a bounded generate→sense→regenerate loop instead of a single pass: `{ sensor, maxIterations?, temperatures?, rejectedBuffer? }`. `sensor(result, { task, context, contract }) → Verdict` is YOUR **deterministic** close (test/compile/lint — not a model judge); on a non-pass its `critique` (the gap, not the transcript) is fed FRESH into the next attempt and — **on models that accept `temperature`** — the **retry temperature ESCALATES** (default `[0.2, 0.7, 1.0]` — load-bearing there: a weak model at a flat temperature regenerates identical wrong code and ignores even crisp feedback). On a **temperature-fixed model** (e.g. `claude-sonnet-5`, which 400s any non-default temperature) the provider silently drops the param (see below), the escalation lever is inert, and the fed-back gap critique carries recovery alone; `receipts.refineLeaf.temperatures` then records the EFFECTIVE temps — a `null` marks an attempt that ran at the model's default (never the ignored requested value). Each attempt is gate-checked + metered; a HaltError mid-loop → clean `{ incomplete }`; honest non-recovery → `receipts.refineLeaf.passed === false` (never a faked pass); `receipts.tokens` sums all attempts. The error-keyed `recall` stays YOUR tool (`opts.tools`), keyed off the fed-back critique — bareagent stays litectx-agnostic. Carries down (engages at the leaves). Absent ⇒ a leaf is a single pass.

> **Sensor integrity (`refineLeaf.sensor`):** the sensor must judge the **returned result** (tamper-proof — build/run the returned string in isolation), never a worker **side-effect** a worker with edit tools could game (writing a passing file then returning junk, or editing the failing test itself). The loop optimizes against whatever the sensor reads — keep the close outside what the worker can write. (RSI field lesson: reward-hacking appeared in every optimization loop with a gameable close. **Demonstrated in-repo** — `poc/sensor-gaming-blocked.mjs`: the moment the honest path was blocked, `claude-sonnet-5` faked a pass on an unsatisfiable on-disk check **5/5** — both by editing the test and by making the returned function non-pure — while a tamper-proof close that runs the returned artifact in isolation was not gameable.)

> **Broken arbiter ≠ failing model (BA-15):** a `refineLeaf.sensor` — or a caller `opts.evaluate` verifier — that **throws** (your test runner crashed — ENOENT, a harness syntax error) or returns a **malformed verdict** (anything with neither a usable `pass` nor a valid tri-state `status`) is a faulty **arbiter**, not a model failure. The loop stops at the **first** broken close (it never retries against a broken judge — each retry would carry zero feedback) and returns a labeled `{ incomplete, blocker: 'broken-sensor' | 'broken-verifier', blockerDetail }` (what the arbiter did; mirrored on `receipts`), with `best` preserving the model's last non-empty output (BA-5) — best-effort work the arbiter never graded, not a pass. The label names WHICH knob to fix. Check `out.blocker` before debugging the model: `'broken-sensor'` / `'broken-verifier'` mean fix your sensor / your `evaluate` and re-run; `'governance-deny'` means widen scope / re-gate. **`pass` may be any truthy/falsy value** (`true`, `1`, `0`) — only a verdict carrying *no* usable signal is malformed — and a verdict backed by a class/getters keeps its fields. **In a nested run** the label travels: `out.blocker` reports a descendant's fault with `out.blockerTask` naming which sub-task broke, while each ancestor's receipts record it as `blockerFrom` — an ancestor's own `blocker` always means *that* node broke, so it never accuses a node whose sensor never ran. The **default Evaluator rubric verifier is never labeled** (its failures are provider-class faults), and a `HaltError` thrown by either arbiter stays a clean governance halt. One thing stays YOURS: an arbiter that **hangs** hangs the node (no gate checkpoint fires inside your callback) — run untrusted or model-generated checks in an isolated child process **with a timeout**.

> **`rejectedBuffer` (BA-14, v0.30.0):** a second lever for a **temperature-fixed** model, where escalation is inert. Instead of only the latest critique, it surfaces the model's OWN prior failed attempts VERBATIM — *"you wrote these, they failed X — write something STRUCTURALLY DIFFERENT."* This is **directed** diversity (attack the specific repeated mistake); escalation is **random** diversity, and the two are **antagonistic** — temperature monotonically degrades the buffer (`poc/ba14b`: flat-0.2 100% → 0.7 70% → 1.0 50%), so when the buffer engages the retry temperature is **held flat** at `temperatures[0]`, never escalated. Trigger: `true` = force on (also on temperature-accepting models); `false` = force off (pure BA-8 escalation); **unset = adaptive** — engage only once a prior attempt's temperature was dropped (i.e. a temp-fixed model where escalation is inert and the buffer is the sole lever). On a temperature-accepting model the default leaves behavior byte-identical. `receipts.refineLeaf.rejectedBuffer` reports whether it engaged. Efficacy is a **weak-model / fixation** phenomenon (live on `claude-sonnet-5` it engaged 6/6 but recovered no better than critique-only — cost-neutral, hence adaptive-not-always-on).

```javascript
const out = await recurse('Fix the failing function in calc.js', ctx, {
  context: `project root: ${process.cwd()}\nresolve relative paths against it`,
  refineLeaf: { sensor: (code) => runTestsAndGrade(code) },   // your deterministic test/compile close
});
```

**What a delegated child inherits (important — the setpoint is the TOP node's job):** when a worker delegates with `spawn_child`, the child runs a **fresh `recurse`** that inherits `tools`, `synthesize`, `maxDepth`, `persona`, `context`, and `refineLeaf` — but the parent's **`contract`/`evaluate` are stripped** (and the forced `count`/`mode` + the corpus `retrieval` knobs). A slice is not graded against the *whole*-task definition-of-done (that verdict is the top node's, and a slice satisfying the whole DoD is the wrong question); only the top `recurse` verifies the synthesized result. The non-overridable `critical → force-verify` safety floor still fires per node (it keys on the task text, not the contract). So: set `contract`/`evaluate` once at the top; they do not — and should not — re-run per intermediate node.

## Wiring with Evaluator + refine (output-side verification)

`Evaluator` is the output-side judge (the mirror of `Planner`): it grades a result against a goal and returns a tri-state `Verdict`. `refine` is the bounded generate → evaluate → regenerate loop. Both compose *around* a Loop — neither lives inside `loop.js`.

```javascript
const { Evaluator, refine } = require('bare-agent');

const evaluator = new Evaluator({ provider });   // provider REQUIRED for rubric/agentic; predicate needs none

// Three criteria types — pass EXACTLY ONE:
const v1 = await evaluator.evaluate(goal, result, { predicate: (r) => r.includes('DONE') });       // deterministic, 0 tokens
const v2 = await evaluator.evaluate(goal, result, { rubric: 'Cites a source for every claim.' });  // isolated adversarial LLM grader
const v3 = await evaluator.evaluate(goal, url,    { agentic: 'Open the page, click Submit, check the console for errors.' }); // tool-running critic that EXERCISES the artifact

// Verdict: { status: 'satisfied' | 'needs_revision' | 'failed', pass, score, critique, suggestions }
//   pass = (status === 'satisfied');  needs_revision is retryable;  failed is terminal (stop spending).
if (!v2.pass) console.log(v2.critique, v2.suggestions);
```

Key invariants:
- The **rubric path runs an isolated adversarial grader** — a separate context window with a harsh, independent prompt, never the generator's transcript. That isolation (not a feedback knob) is what defeats the self-evaluation trap; the grader treats the RESULT as untrusted DATA (judge prompt-injection defence).
- **`agentic`** (the third type) spins up a fresh Loop with scoped tools (set on the Evaluator, or per-call `opts.tools`) that **exercises** the live artifact — clicks, reads console/network — rather than reading text. Each critic round forwards to `onLlmResult`; a governance `HaltError` re-throws clean.
- **`contract`** (a definition of done) is graded against instead of the loose goal: `evaluate(goal, result, { rubric, contract })`. Judge tokens forward to the gate via `onLlmResult` (`kind:'evaluate'`) so verification spend is visible to the budget.

**`refine`** drives a caller-supplied `attempt`/`evaluate` until a satisfied verdict, a terminal `failed`, or `maxIterations` (the real bound is bareguard maxTurns/budget). It threads the latest `critique` into the next attempt (fresh-feedback, not anchoring on a failed answer) and a shared `contract` to both sides.

```javascript
const { result, verdict, iterations, history } = await refine({
  attempt:  ({ critique, contract }) => generate(prompt, { critique, contract }), // critique = null on the first pass
  evaluate: (result, { contract })   => evaluator.evaluate(goal, result, { rubric, contract }),
  contract: 'No TODOs; every public fn has a JSDoc; tests pass.',
  maxIterations: 3,   // hard cap; the REAL bound is the gate
});
```

## Provider options

```javascript
// OpenAI (also works with OpenRouter, Together, Groq, vLLM, LM Studio)
new OpenAI({ apiKey, model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' })

// Anthropic
new Anthropic({ apiKey, model: 'claude-haiku-4-5-20251001' })

// Anthropic + TRANSCRIPT CACHING (BA-1, v0.27+) — if you run a TOOL LOOP, turn this on.
// Anthropic does NOT auto-cache, so without it your loop re-buys its entire growing transcript at
// FULL input price every single round. Measured on claude-sonnet-5 with a ~15k-token tool-result
// transcript: $0.0753 -> $0.0110 per round, 6.8x cheaper in steady state (round 1 pays a 1.25x cache
// write, once). Opt-in because it changes the wire format; also settable per call via
// loop.run(msgs, tools, { cacheMessages: true }).
new Anthropic({ apiKey, model: 'claude-sonnet-5', cacheMessages: true })
//
// Two things worth knowing before you rely on it:
//  1. Caching pays for RE-SENDING, not for GROWING. The 6.8x is what a STABLE prefix buys — the
//     transcript re-sent round after round. A round that appends large NEW content (another whole-file
//     read) writes those tokens at 1.25x; no breakpoint makes a token you've never sent before cheap.
//     Caching is necessary, not sufficient — it compounds with retrieval that stops re-reading files.
//  2. A destructive `trim`/stash fold that rewrites the transcript PREFIX INVALIDATES the cache (the
//     prefix IS the cache key). Keep the head stable, or you re-pay the write premium every round.
//
// `cacheSystem` is a different, weaker knob: Anthropic's minimum cacheable prefix is 1024-4096 tokens
// (model-dependent) and a typical system persona is a few hundred — so on its own it silently caches
// NOTHING. The transcript is where a tool loop's tokens actually live.

// Gemini (native generateContent — needed for prompt-cache token tiers; the OpenAI-compat endpoint drops them)
new Gemini({ apiKey, model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' })

// Ollama (local, no key needed)
new Ollama({ model: 'llama3.2', url: 'http://localhost:11434' })

// CLIPipe — pipe prompts to any CLI tool via stdin/stdout
new CLIPipe({ command: 'claude', args: ['--print'], systemPromptFlag: '--system-prompt', timeout: 30000 })
new CLIPipe({ command: 'ollama', args: ['run', 'llama3.2'] })
// CLIPipe structured output (v0.26.0+) — map a CLI's JSON envelope to real usage + cost
new CLIPipe({ command: 'claude', args: ['-p', '--output-format', 'json'], parse: 'claude-json' })
// CLIPipe TOOL MODE — drive a Loop's tools over a CLI SUBSCRIPTION (no metered API). TWO modes:
// 'claude-mcp' (BA-16, NATIVE — prefer on the claude CLI) vs 'claude' (v0.32.0, EMULATION). The
// difference is COST, not capability. Emulation re-sends the whole transcript every round
// ($0.25-0.55/round measured); native runs one CLI session that caches session-side (~$0.006/turn).
// Native: caller tools ride an MCP bridge back to your in-process closures; the CLI owns the cycle.
// Gate + BA-11/BA-12 guards + turn bound live on the PROVIDER (not the Loop) — see below.
new CLIPipe({ command: 'claude', args: ['-p', '--model', 'sonnet'], toolProtocol: 'claude-mcp', policy, onTurn, maxTurns: 20 })
// Emulation (v0.32.0) — still right for a CLI with NO MCP support. Weak models rejected upfront by a
// capability probe (needs sonnet-class+; haiku fine for plain text). setting-sources '' cuts ~18x cost.
new CLIPipe({ command: 'claude', args: ['-p', '--model', 'sonnet'], toolProtocol: 'claude' })
```

**CLIPipe NATIVE tool mode (BA-16, `toolProtocol:'claude-mcp'`).** The claude CLI has a real tool channel; native mode uses it instead of emulating one. The CLI runs its OWN multi-turn session per `generate()` call and executes your `tools` natively over an MCP bridge that calls back into your in-process `execute` closures. Because the CLI owns the inner cycle, the Loop's per-round machinery cannot run — so the governance you'd wire on `Loop` moves to the **provider**, at the one seam every tool call crosses:
- `policy` — the SAME `(tool, args, ctx) => true|string` chokepoint as `Loop({policy})`, so a wired `wireGate(gate).policy` writes **audit rows of identical shape, zero gate changes**. A deny is a tool result (advisory); the handler never runs. **Required here** — a `Loop({policy})` in native mode would be a fence that is silently not there, so the Loop throws.
- `maxConsecutiveDenials` (3) / `maxIdenticalToolErrors` (3) — BA-11/BA-12 guards at the bridge, same narrowest triggers; end the session `denied:<tool>` / `stuck:<tool>`.
- `maxTurns` — a bound on **assistant/LLM turns**, the SAME unit as the Loop path, so one number means one thing on both surfaces (BA-17). NOT a tool-call count: one turn can fire a dozen parallel tool calls and still be one turn (measured: 12 calls across 2 turns, inside `--max-turns 3`). Enforced twice — the CLI's own `--max-turns` stops cleanly at N (and emits the result event that carries the session's real cost), plus a parent-side counter that kills the session if a turn beyond N is ever seen, since that flag is undocumented in `claude --help`. The stop is `error:'max_turns'` + `stopReason:'max_turns'` and **carries the last turn's text forward** — the CLI reports `result:null` on a bounded session, so an unfixed build returned `text:''`.
- `onTurn` — fires once per **assistant turn** (BA-17: the CLI emits a separate stream event per content *block*, all repeating that message's usage — firing per event inflated a caller's turn axis ~5–7× and its token axis 5.04×), carrying four cache tiers and `costUsd:null`/`rateSource:null` since the CLI prices the session, not the turn. Then one closing `kind:'session'` event carrying the authoritative cost **and the token residual** — a turn's `message.usage` is a snapshot taken at its first block and never revised (a turn that emitted ~816 output tokens reported 2), so the closing event makes the streamed tiers add up to exactly the CLI's own session total. The session event stamps `rateSource:'provider'` when its cost is finite (BA-22 — the CLI's own `total_cost_usd`, no local rate table; a killed/unknown session carries `rateSource:null`, never a spurious `'provider'`). Shape mirrors `onLlmResult` (incl. `rateSource`), so `wireGate(gate).onLlmResult` drops in; when wired the Loop skips its own forward (billed once, never starved).
- `sessionTimeout` (600s) / `bridgeTimeoutMs` (120s) — whole-session and per-handler ceilings.

`GenerateResult.session` (`{turns, toolCalls, error, usageReported}`) carries what really happened; `metrics.sessionTurns` reports the real turn count — assistant *messages*, not stream events — so a 14-turn session never reads as one round, and a 2-turn session never reads as 14. A terminal the CLI detects inside the session (bound, guard, or a **broken tool bridge** — a dead bridge still ends `subtype:'success'`, so it is caught parent-side by attempted-vs-served tool calls) surfaces as the run's `error`, never a laundered clean finish. `assemble`/`trim`/`cacheMessages` and a Loop-level `policy` all THROW at construction in native mode (no silently-dead knobs — the CLI owns the transcript). The bridge is a unix socket (0600 in a 0700 dir), never a listening port. Claude-only for now; the CLI-specific parts live in `src/provider-clipipe-mcp.js` + `src/mcp-bridge-stub.js` behind the same seam as emulation.

All return `{ text, toolCalls, usage: { inputTokens, outputTokens }, model?, costUsd? }`. The optional `model` (v0.16.1+) is the id the response was produced by — Loop prefers it over `provider.model` for cost accounting. By default CLIPipe returns `toolCalls: []` and zero usage (CLI tools don't report tokens) and omits `model`. **Structured output (v0.26.0+):** set `parse: 'claude-json'` (a preset for `claude -p --output-format json`) — or a `(stdout) => Partial<GenerateResult>` function for any other CLI — and CLIPipe maps the CLI's JSON envelope onto real `usage`, `model`, and `costUsd`, throwing `ProviderError` on a malformed/error envelope (never a silent raw-text fall-back). `costUsd` (optional `GenerateResult` field) is an **authoritative** per-call price the provider reports itself; when finite the Loop prefers it over the internal rate-table `estimateCost`, so a CLI-piped run enforces a bareguard USD cap with no local pricing table (a `0` counts as priced, distinct from null/unpriced). `toolCalls` stays `[]` regardless (CLIPipe is tool-free).

**Temperature graceful degradation (BA-10).** Newer models reject ANY non-default `temperature` with a `400` (`claude-sonnet-5`: `` `temperature` is deprecated for this model. ``; OpenAI o1/gpt-5-class: `Unsupported value: 'temperature' … Only the default (1) …`). All four providers detect that specific 400 (message names `temperature` as unsupported/deprecated AND a temperature was sent), **drop the param, warn once per instance, and retry once** — so a call that would otherwise throw succeeds at the model's default temperature. Keyed off the API error text, not a model list. A genuine out-of-range 400 is NOT degraded (it re-throws — dropping it would mask a caller bug). When a drop happens the result carries `temperatureDropped: true` (an optional `GenerateResult`/`Loop.run` field) so a caller can report the effective temperature — `recurse`'s `refineLeaf` uses it for an honest receipt. Dormant on models that accept temperature (byte-identical to before).

**Error body (v0.11.0):** on an HTTP error the OpenAI/Anthropic/Ollama providers throw a `ProviderError` whose `message` carries the upstream error string. The full parsed response is **not** attached to `err.body` by default (so an unexpected field can't leak through logs that dump the error object). Pass `{ exposeErrorBody: true }` to attach it for debugging.

**Request/idle timeout (BA-18, v0.34.0):** the four http(s) providers (Anthropic, OpenAI, Gemini, Ollama) accept a `timeoutMs` option — constructor default **600000 (10 min)**, overridable per call via `generate(..., { timeoutMs })`, and `0`/`Infinity` disables it. Before this they wired only `req.on('error')`, so a socket the server silently dropped — or a response that never starts — hung `generate()` until the OS TCP timeout (~2h): a hang, not an error, so retry/casualty policy above it never fired. `timeoutMs` bounds on socket **inactivity** (`req.setTimeout`), so a slow-but-streaming response is not killed — only a silent/never-answering socket trips it; the 10-min default clears any single non-streaming completion (TTFB ≈ generation time). On trip, `generate()` rejects with a retryable `TimeoutError` (`code: 'ETIMEDOUT'`, `context.bound: 'idle'`, `retryable: true`). **Retry is caller-side and already wired:** `new Loop({ provider, retry: new Retry() })` wraps `provider.generate`, and `DEFAULT_RETRY_ON` classifies `ETIMEDOUT` (and `ECONNRESET`/`ENOTFOUND`/429/5xx) as transient — so a wired `Retry` retries a timed-out request and rethrows under `retryOn: () => false`, with no extra wiring (`run-plan`'s `stepRetry` is a second consumer of the same seam). CLIPipe already bounded its child process (`timeout`, default 30000 for one-shot) and is unchanged.

**Total call-duration deadline (BA-19, v0.35.0):** `timeoutMs` bounds socket *inactivity*, and `req.setTimeout` resets on any activity by design — so a "zombie stream" that trickles a byte forever (bytes arriving, the response never completing) never trips it and hangs the caller for hours (an adopter saw one `generate()` run **274 min** and end in `ECONNRESET`, not a `TimeoutError`: the reset proves bytes *were* flowing, so the idle timer never fired). The four http(s) providers now also accept a `deadlineMs` option — an absolute, **non-resetting** wall-clock ceiling on the whole request. **Disabled by default** (a deliberately long single call — large `maxTokens`, slow model — is legitimate; a default here would kill it), overridable per call via `generate(..., { deadlineMs })`, `0`/`Infinity` disable. An *unset* deadline resolves to disabled, but an *explicitly-set* garbage value (`NaN`, a non-numeric string) throws a `ValidationError` at resolve time rather than silently disabling the bound and running unbounded — unlike `timeoutMs`, the deadline has no safe default to fall back to, so a config mistake must surface loudly. On trip, `generate()` rejects with a **terminal** `TimeoutError` distinguishable from the idle trip: `code: 'EDEADLINE'`, `context.bound: 'deadline'`, `retryable: false` — a deadline is a hard ceiling meant to STOP, so it is *not* auto-retried (retrying would re-spend up to another full `deadlineMs`); a consumer that wants retry opts in via `retryOn`. When both are armed and `timeoutMs < deadlineMs`, a silent socket trips the idle bound first; only a still-active-but-never-completing stream reaches the deadline. The idle bound (BA-18) and the deadline (BA-19) are two independent failure modes — a silent socket vs a zombie stream.

**Plaintext-key warning (Unreleased):** the OpenAI provider's `baseUrl` accepts `http://` (for local/OpenAI-compatible endpoints), but a `Bearer` key sent over plaintext http to a **non-loopback** host is exposed on the wire. The provider now warns once when that happens. Loopback hosts (`localhost`/`127.0.0.0/8`/`::1` — local proxies, Ollama-style endpoints) stay silent, since that's the legitimate keyless-local case. The header is **not** stripped (some local proxies want a key), so use `https` for any remote endpoint, or drop `apiKey` when the local endpoint needs none.

**Cost estimation:** Loop automatically estimates USD cost per run based on model and token usage. The `cost` field appears in every `loop.run()` result and in `loop:done` stream events. **Pricing honesty (BA-21, v0.37.0):** a token-bearing round is ALWAYS priced (guesstimate-and-run — a null/unknown model no longer forces `unpriced`); rates resolve as caller-supplied `new Loop({ rates: { in, out } })` (authoritative) → a recognized Claude tier from the model id (`haiku`/`sonnet`) → the **Sonnet-tier** ceiling default ($0.003/$0.015 per 1K, no per-model table). Every metering payload carries a `rateSource: 'provider' | 'caller' | 'tier' | 'default' | null` field so a consumer can tell an authoritative price from a guess — and (BA-21 follow-up, v0.38.0) a recognized-tier guess (`'tier'`) from a blind ceiling fallback (`'default'`); a round priced off either guesstimate emits ONE loud `console.warn` per Loop instance naming the actual source (silenced by passing `rates`). To set your own rates, construct `new Loop({ rates })` — there is no longer a `COST_PER_1K` table to edit. The model is resolved as `result.model || provider.model` (v0.16.1+) — providers now echo the model in their `generate()` result, so cost accounting holds even when `provider.model` is absent or varies per response, e.g. behind `FallbackProvider` or `CircuitBreaker.wrapProvider` (the wrapper also preserves `model`/`name` passthrough props). Wire `onLlmResult` (via `wireGate`) and a `budget.maxCostUsd` cap then halts on token-heavy workloads too. **Usage-null boundary (BA-24, v0.39.0):** `GenerateResult.usage` is `Usage | null` — every provider (incl. native CLIPipe session-close) now surfaces `usage: null` when the raw API response carried NO usage block, instead of manufacturing an all-zeros object. A manufactured zero object used to sail past `resolveRoundCost`'s honest-null guard and get priced as a confident $0 (`rateSource:'tier'`/`'default'`) — an unpriceable round now stays unpriced. A *present* block with an explicit `0` field (e.g. a cache-only round) is unaffected and still prices normally.

## Store options

```javascript
// SQLite FTS5 — full-text search with BM25 ranking (requires: npm install better-sqlite3)
// Minimal store, kept for back-compat. litectx strictly dominates it (same better-sqlite3
// requirement, but adds ranked graph-aware recall) — prefer litectx for SQLite-backed memory.
new SQLite({ path: './memory.db' })

// JSON file — zero deps, substring search
new JsonFile({ path: './memory.json' })

// litectx — ranked, graph-aware recall (RT-3 mount; requires: npm install litectx)
// One-line swap; the host code (memory.store/search/get/delete) never changes.
//   import { LiteCtx, liteCtxAsStore } from 'litectx';
//   const memory = new Memory({ store: liteCtxAsStore(new LiteCtx({ dbPath: './agent.db' })) });
// See examples/litectx-as-store.mjs. litectx ships the adapter; bareagent owns the Store socket.

// Custom — implement { store, search, get, delete }
```

**JsonFile scaling:** `search()` is an O(n) substring scan (no index) and every `store()`/`delete()` rewrites the whole file. Fine for hundreds–low-thousands of entries; for larger or write-heavy memory mount `litectx` for ranked graph-aware recall (the minimal bundled `SQLite` FTS5 store remains for back-compat, but litectx strictly dominates it — same `better-sqlite3` requirement, richer recall). JsonFile warns once past ~10k entries.

**Two ways to use litectx, pick by who consumes it (the two are independent):**
- **As your `Store`** (RT-3, above) — *your* host code recalls via `memory.search/get`. One-line `liteCtxAsStore` swap.
- **As a child agent's MCP toolbox** (RT-4) — give a *spawned sub-agent* litectx's own reasoning verbs (`litectx_recall`, `litectx_get`, …) so the model calls them in its loop. Use `liteCtxMcpBridgeConfig` to build the curated mount and hand it to the child via `cfg.mcp`:

```js
const { liteCtxMcpBridgeConfig } = require('bare-agent/tools');
// Read-only by default: recall/get/impact/recent allowed; remember/forget denied
// (writable:true to opt in — writes stay in the child's OWN --root db); index/promotions always denied.
const mcp = liteCtxMcpBridgeConfig({ root: './child-mem' });   // own-db isolation via --root
// In the spawn child config (bin/cli.js --config): { provider, model, tools, mcp, gate }
//   mcp: <the config above>   → child's MCPBridge mounts litectx-mcp; tools join BEFORE gating
// cfg.mcp also accepts a directory-confined { bridgePath } pointing at a .mcp-bridge.json on disk.
```

Requires litectx's `litectx-mcp` binary on PATH. Isolation is **physical** (each child a distinct `--root` db) — promotion to the parent is an explicit parent-side `recall`→`remember`, never automatic. See `examples/litectx-mcp-child.mjs`. bareagent imports nothing from litectx; the helper is pure config curation.

## Tool format

Every tool passed to `Loop.run()` must have:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Non-empty |
| `execute` | function | yes | `async (args) => result` — string or JSON-serializable |
| `description` | string | no | Providers pass this to the LLM |
| `parameters` | object | no | JSON Schema for the tool's arguments |

Tools are validated at the start of `run()`. Missing `name` or `execute` throws immediately with a clear `[Loop]` error.

## Error handling

- **Loop throws by default** (v0.3.0+) — provider errors re-thrown as-is. Use `try/catch` or `.catch()`.
- **Loop `throwOnError: false`** — opt into v0.2.x behavior where errors are returned in `result.error` instead of thrown.
- **Loop throws at setup** — missing provider, malformed tools.
- **Halt decisions throw `HaltError` but Loop catches it cleanly (v0.10.0+)** — turn cap (`limits.maxTurns`/`maxToolRounds`), budget cap (`budget.maxCostUsd`), and content rules with `severity:'halt'` throw `HaltError` from `wireGate.policy`; Loop catches it, emits `loop:done{halted:true, rule}`, and returns `{ error: 'halt:<rule>' }`. **Even with `throwOnError:true`** Loop does NOT propagate — halt is a governed exit. Halt never reaches the LLM as a tool message. Detect via `result.error?.startsWith('halt:')`, the `loop:done{halted:true}` event, the `loop:error{source:'halt'}` event, or wire `humanChannel` for ask-then-decide flows.
- All errors are prefixed `[ComponentName]` for easy identification.
- See `docs/errors.md` in the repo for a full error reference with triggers and fixes.

### Typed error hierarchy

```
Error
└── BareAgentError          { code, retryable, context }
    ├── ProviderError       { status, body } — auto retryable for 429/5xx
    ├── ToolError           code: 'TOOL_ERROR', retryable: false
    ├── TimeoutError        code: 'ETIMEDOUT', retryable: true
    ├── ValidationError     code: 'VALIDATION_ERROR', retryable: false
    ├── CircuitOpenError    code: 'CIRCUIT_OPEN', retryable: true
    └── HaltError           code: 'HALT', retryable: false — { rule, decision }
```

Halt classes (`MaxCostError`, `MaxRoundsError`) were removed in v0.8.0. **In v0.10.0**, `HaltError` was added and `wireGate.policy` throws it on halt-severity decisions. Loop catches it in its outer handler and returns a clean exit (see the halt-mechanics paragraphs above) — adopters who *want* to catch the halt class explicitly can import it from `require('bare-agent').HaltError` or `require('bare-agent/errors').HaltError` (identity-equal across module boundaries, v0.10.1+). `err.rule` and `err.decision` are the stable public surface; do not read from `err.context.rule` / `err.context.decision` — those were removed in 0.10.3 as redundant.

All error classes extend `Error` — `instanceof Error` always works. The `retryable` property integrates with `Retry`'s fast path: `err.retryable === true` auto-retries, `err.retryable === false` bails immediately.

## Key contracts

- Loop builds messages in OpenAI format internally. Each provider normalizes to its native format.
- `provider.generate(messages, tools, options)` must return `{ text, toolCalls, usage }` (and may include `model` for accurate cost accounting).
- Store must implement `store(content, metadata) → id`, `search(query, options) → [{id, content, metadata, score}]`, `get(id)`, `delete(id)`.
- Components are independent: Memory doesn't know Loop, Scheduler doesn't know Planner. You compose them.

## Patterns, not features

These are deliberately NOT in bare-agent. Don't look for them — build them from existing primitives.

| Pattern | Not built in because | How to do it |
|---|---|---|
| **Multi-agent orchestration** | Routing, handoffs, shared state are app logic | Multiple Loop instances with different system prompts/tools. Your app routes. Share state via a common Memory/store. |
| **Structured output / named phases** | Domain-specific (trip planner ≠ code reviewer) | System prompts with format instructions, Planner with custom phase names, or tools with JSON Schema enforcing structure. |
| **Output limiting / token budgets** | Per-provider, per-plan, per-UX | Provider `maxTokens` option, system prompt guidance, or post-process `result.usage.outputTokens`. |
| **Rate limiting** | Per-provider, per-endpoint | Wrap `provider.generate` with a rate-limiting function. |
| **Hooks (lifecycle events)** | You own the code — add behavior directly | Stream subscriptions for after-the-fact hooks. Wrap tool `execute` functions for before/after semantics. |
| **Heartbeat (ambient awareness)** | "Check if anything needs attention" scope is your domain | Scheduler recurring job where the LLM triages: `scheduler.add({ type: 'recurring', schedule: '30m', action: 'Check if anything needs attention' })`. |
| **Cron** | **This IS built in** | Scheduler supports cron expressions (requires `cron-parser` peer dep) and relative schedules (`5s`, `30m`, `2h`, `1d`) natively. |

For full recipes with code examples, see `docs/archive/usage-guide.md` § "Patterns, Not Features".

## Production usage

| Component | aurora (SOAR2 pipeline) | multis (personal assistant) |
|---|---|---|
| Loop | ✓ | ✓ |
| Planner | ✓ | ✓ |
| runPlan | ✓ | — (sequential execution) |
| Retry | ✓ | ✓ |
| CircuitBreaker | — | ✓ |
| Fallback | — | — (deferred) |
| Memory | — (own BM25 store) | — (own SQLite FTS5 store) |
| StateMachine | — | — (deferred) |
| Scheduler | — | ✓ |
| Checkpoint | — | ✓ |
| Stream | — | — (deferred) |
| CLIPipe | ✓ | — |

Both projects kept their own memory/store implementations. Neither needed multi-agent routing. Full multis eval: `docs/logs/bareagent-eval-multis.md`.

## Examples

Runnable reference scripts in `examples/`. Each is self-contained; the top-of-file docstring documents flags and required env vars. Recipes below are the prose form; these are the executable form.

| File | Demonstrates | Recipe cross-ref |
|---|---|---|
| `examples/with-bareguard.mjs` | Loop + bareguard end-to-end: budget cap, fs scope, bash allowlist, audit log, humanChannel. Canonical governed-loop reference. | § Wiring with bareguard |
| `examples/mcp-bridge-poc.js` | Auto-discover MCP servers from IDE configs, run a Loop with the discovered tools, persist allow/deny in `.mcp-bridge.json`. | Recipe 9 |
| `examples/mcp-bridge-concurrent.js` | Concurrent stress test against real public domains via `barebrowse_browse` (Amazon, Wikipedia, GitHub, a dead host). Validates bridge resilience under fan-out. | Recipe 9 |
| `examples/orchestrator/` | Multi-agent dispatch via `spawn`. Three configs (orchestrator + two specialists), one system prompt — no orchestrator class, no role types. Roles are JSON files. Wired with bareguard via `cfg.gate`. | § Multi-agent: spawn + defer + wake |
| `examples/wake.sh` + `examples/wake.md` | Reference cron + `jq` script for firing deferred actions. The runtime half of `createDeferTool`. | § Multi-agent: spawn + defer + wake |
| `examples/replay-job.js` | Supervised replay POC: record a browser task once with the LLM driving, then replay against fresh snapshots with the LLM acting only as a locator. On locator miss, falls back to full Loop reasoning and patches the trace. Stub points for fingerprint fast-path, postState assertion, and trace-confidence are inline in the file header. | Recipe 7 |

Stale example removed in 0.10.4: `examples/mcp-bridge-gov.js` (used a hard-coded path to the retired `mcp-gov` project; superseded by `with-bareguard.mjs` and bareguard's `policy` + `tools.denyArgPatterns` for MCP gating).

## Gotchas

1. **Anthropic requires apiKey** — OpenAI and Ollama don't (for local/keyless endpoints).
2. **Cron schedules require `cron-parser`** — it's an optional dep. Relative schedules (`5s`, `30m`, `2h`, `1d`) work without it.
3. **SQLiteStore requires `better-sqlite3`** — it's a peer dep. JsonFileStore has zero deps.
4. **Scheduler runs jobs sequentially within a tick** — if one handler takes 5s, others wait. Use short handlers or offload work.
5. **Ollama tool call IDs are synthetic** — `call_${Date.now()}`. Works fine but IDs aren't stable across retries.
6. **Loop's `chat()` is stateful** — it accumulates the full conversation history including tool calls and tool results across turns. For long conversations, use `run()` with your own message management to control what stays in context.
7. **CLIPipe `_formatPrompt()` flattens all messages** — System messages become `System: content` plaintext in stdin. If your CLI tool expects system prompts via a dedicated flag (e.g. `claude --system`), use `systemPromptFlag` to separate them. Without it, structured output prompts embedded in system messages will break.
8. **Loop `run()` throws by default (v0.3.0+)** — Provider errors throw instead of returning `result.error`. Use `try/catch` or pass `throwOnError: false` for the old behavior. **Halt-severity governance exits are the exception**: even with `throwOnError:true`, Loop catches `HaltError` and returns `{ error: 'halt:<rule>' }` cleanly (v0.10.0+). `Loop({ maxRounds })` was removed in v0.8 and now throws at construction (v0.10.1+) with a migration message pointing at `new Gate({ limits: { maxTurns | maxToolRounds } })`. The internal `HARD_ROUND_LIMIT = 100` is a safety net only — wire bareguard for real iteration bounds.
9. **StateMachine `getStatus()` returns `null` for unregistered IDs** — It does not throw. Always null-check before accessing `.status`.
10. **Planner expects JSON array `[{id, action, dependsOn}]`** — Not `{steps: [...]}`. If the LLM wraps steps in an object, Planner's parser will reject it.
11. **Loop injects system prompt as a message, not an option** — `{ role: 'system', content: '...' }` is prepended at index 0 of the messages array passed to `provider.generate()`. It is NOT passed in `options.system`. If your tests assert on `options.system`, they will break — assert on `messages[0]` instead.
12. **JsonlTransport must be imported from `bare-agent/transports`** — Not from `bare-agent` main export. Importing from main will throw `ERR_PACKAGE_PATH_NOT_EXPORTED`.
13. **Browsing tools require `close()`** — `createBrowsingTools()` launches a browser (20 tools as of barebrowse v0.9.0: browse, goto, snapshot, click, type, press, scroll, select, hover, back, forward, **reload**, drag, upload, tabs, switchTab, pdf, screenshot, **wait_for**, **downloads**, plus **assess** if `wearehere` is installed → 21 total). Always call `close()` in a `finally` block to release resources. Returns `null` if `barebrowse` is not installed. Action tools (click, type, press, scroll, hover, goto, back, forward, **reload**, drag, upload, select, switchTab, **wait_for**) auto-return a fresh snapshot with a 300ms settle delay so the LLM always sees the result. `downloads` returns a JSON snapshot of `page.downloads` frozen at request time (stable view, not a live reference). `onDialog` is intentionally not exposed as a tool — its callback shape doesn't fit a request/response loop; drop to `import { connect }` directly if a flow needs to override confirm/prompt replies, or read `page.dialogLog` after the fact. `browse` and `snapshot` accept `pruneMode: 'act'|'read'` — `act` (default) keeps interactive elements for clicking/filling; pass `'read'` when the page is paragraph-heavy (article, doc, blog) to keep prose. If `act` collapses a content-heavy page, the snapshot includes a hint to retry with `pruneMode: 'read'`. For multi-step flows, CLI session mode (`npx barebrowse open/click/snapshot/close`) is more token-efficient — snapshots go to `.barebrowse/*.yml`, agent reads only when needed instead of inline in conversation.
14. **Mobile tools require `close()`** — `createMobileTools()` connects to a device. Always call `close()` in a `finally` block. Returns `null` if `baremobile` is not installed. Action tools auto-return a snapshot (unlike browsing tools where you call snapshot separately). Refs reset every snapshot — never cache them.
15. **`bin/cli.js` (`spawn` child agents) fails closed on gate-wiring errors (v0.10.3+)** — when a child config sets `cfg.gate` but `Gate` init or `wireGate` throws, the CLI now `process.exit(1)` with `[cli] failed to wire bareguard: ... Refusing to run ungoverned (cfg.gate set).` instead of continuing with `policy=null`. Children without `cfg.gate` are unchanged (no governance asked, none enforced). If you previously relied on the silent-fallback behavior (you shouldn't have — it was a silent escape hatch), drop `cfg.gate` from the child config to opt in.
16. **`bin/cli.js` uses BA1 callbacks since v0.10.3** — children record LLM cost into bareguard's audit, thread `_ctx`, and pre-filter tools via `gate.allows`. Pre-0.10.3 children used the deprecated `wrapTools` path which silently dropped LLM cost from `budget.maxCostUsd` and printed a deprecation warning per first tool call. No config change needed; the upgrade is transparent.
17. **Halt-path `msgs` is sealed (v0.10.3+)** — when Loop catches `HaltError` mid-round, every dangling assistant `tool_calls.id` from the halted round gets a synthetic `{ role:'tool', tool_call_id, content: '[halted:<rule>]' }` appended so the returned `result.msgs` is valid OpenAI shape. Safe to feed back into another provider call without protocol errors. The `[halted:<rule>]` tag is lowercase — distinct from the legacy `[HALT:]` deny strings (removed in 0.10.0, do not match on the old form).
18. **`HaltError` with no `rule` resolves to `halt:unknown` (v0.10.3+)** — `new HaltError('msg')` without a `{ rule }` option still produces a stable `result.error = 'halt:unknown'` and `loop:done{halted:true, rule:'unknown'}`. Pre-0.10.3 produced the literal `'halt:null'` which broke string-matching consumers. The `_reportError('halt', ...)` extra carries the same `rule:'unknown'` token.
19. **Pricing is a two-tier guesstimate, not a per-model table (BA-21, v0.37.0)** — a recognized Claude tier in the model id prices at `haiku` ($0.001/$0.005) or `sonnet` ($0.003/$0.015) per 1K; anything else (incl. a null/unknown model) falls through to the **Sonnet-tier ceiling default** ($0.003/$0.015) and still gets priced (`rateSource: 'default'`), never silently `unpriced`. Both guesstimate cases emit one `console.warn` per Loop instance. The `rateSource` on every metering payload distinguishes them: `'tier'` (a recognized haiku/sonnet match — a confident guess) vs `'default'` (the blind ceiling for an unrecognized/absent model), alongside `'provider'`/`'caller'` (authoritative) and `null` (unpriced). If you use a model whose real rates differ and care about `result.cost` accuracy or `budget.maxCostUsd` enforcement via `onLlmResult`, pass `new Loop({ rates: { in, out, cacheReadMult?, cacheWriteMult? } })` — that's authoritative (`rateSource: 'caller'`) and silences the warning. There is no `COST_PER_1K` table to edit.
20. **A `GenerateResult` with `usage: null` means the provider reported no usage block at all — not a round that used zero tokens (BA-24, v0.39.0)** — every http/CLI provider used to coalesce an absent usage block into a truthy all-zeros `Usage` object (`field || 0` applied unconditionally), which `resolveRoundCost` then priced as a confident $0 instead of treating it as unpriceable. `GenerateResult.usage` is now typed `Usage | null`; `null` fires only when the raw API response carried no usage signal at all (checked field-by-field via `hasUsageSignal`, `src/provider-usage.js`), never on a present block whose fields are legitimately `0` (a cache-only round still prices normally). If your own code reads `result.usage.inputTokens` directly, guard for `null` first.

## Cross-language SDKs

Tested, importable wrappers for Python, Go, Rust, Ruby, and Java in `contrib/`. Each spawns `npx bare-agent --jsonl` and communicates via JSONL over stdin/stdout. Consistent API: constructor → `run(goal)` → `close()`.

```python
# Python — contrib/python/bareagent.py (stdlib only)
from bareagent import BareAgent
agent = BareAgent(provider="openai", model="gpt-4o-mini")
result = agent.run("What is the capital of France?")
print(result["text"])
agent.close()
```

See `contrib/README.md` for all 5 languages and protocol reference.

## Recipes

### Recipe 1: Planner → runPlan (main use case)

```javascript
const { Planner, runPlan, StateMachine, Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');

const provider = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });
const loop = new Loop({ provider });

// Plan
const planner = new Planner({ provider });
const steps = await planner.plan('Book a trip to Berlin');

// Execute with wave progress
const results = await runPlan(steps, async (step) => {
  const result = await loop.run(
    [{ role: 'user', content: step.action }],
    tools
  );
  return result.text; // throws on error by default (v0.3.0+)
}, {
  concurrency: 3,
  stateMachine: new StateMachine(),
  onWaveStart: (num, wave) => console.log(`[Wave ${num}]: ${wave.map(s => s.id).join(', ')}`),
  onStepDone: (step, result) => console.log(`Done: ${step.id}`),
  onStepFail: (step, err) => console.error(`Failed: ${step.id}: ${err.message}`),
});
```

### Recipe 2: Loop + CLIPipe with systemPromptFlag

```javascript
const { Loop } = require('bare-agent');
const { CLIPipe } = require('bare-agent/providers');

// Without systemPromptFlag: system messages become "System: ..." in stdin (breaks structured output)
// With systemPromptFlag: system content passed via --system flag, only user/assistant in stdin
const provider = new CLIPipe({
  command: 'claude',
  args: ['--print'],
  systemPromptFlag: '--system-prompt',
});

const loop = new Loop({ provider });
const result = await loop.run([
  { role: 'user', content: 'List 3 facts about Berlin' }
]);
console.log(result.text);
```

### Recipe 3: CircuitBreaker + Fallback + Retry (resilient multi-provider)

```javascript
const { Loop, Retry, CircuitBreaker } = require('bare-agent');
const { OpenAI, Anthropic, Fallback } = require('bare-agent/providers');

const cb = new CircuitBreaker({
  threshold: 3,
  resetAfter: 30000,
  onStateChange: (key, from, to) => console.log(`[${key}] ${from} → ${to}`),
});

const provider = new Fallback([
  cb.wrapProvider(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), 'openai'),
  cb.wrapProvider(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), 'anthropic'),
], {
  onFallback: (err, from, to) => console.warn(`Provider ${from} failed, trying ${to}`),
});

const loop = new Loop({
  provider,
  retry: new Retry({ maxAttempts: 3, jitter: 'full' }),
});
```

### Recipe 4: Stream + JsonlTransport

```javascript
const { Loop, Stream } = require('bare-agent');
const { JsonlTransport } = require('bare-agent/transports');
const { OpenAI } = require('bare-agent/providers');

// JSONL events to stdout — pipe to any consumer
const stream = new Stream({ transport: new JsonlTransport() });
const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  stream,
});

// Subscribe for in-process handling
stream.subscribe((event) => {
  if (event.type === 'loop:tool_call') {
    console.error(`[debug] Tool: ${event.data.name}`);
  }
});

const result = await loop.run(
  [{ role: 'user', content: 'What is the weather in Berlin?' }],
  [weatherTool]
);
```

### Recipe 5: Tool context adapter (ctx closure)

```javascript
// Your tools need execution context (senderId, chatId, permissions, etc.)
// bareagent tools get execute(args) — just LLM arguments.
// Solution: closure that captures ctx.

function adaptTools(tools, ctx) {
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema || tool.parameters,
    execute: async (args) => tool.execute(args, ctx),
  }));
}

// In your message handler:
const tools = adaptTools(myTools, { chatId, senderId, isOwner, platform });
const result = await loop.run([{ role: 'user', content: msg }], tools);
```

### Recipe 6: Checkpoint on a chat platform

```javascript
const { Checkpoint } = require('bare-agent');

const pendingApprovals = new Map(); // chatId → resolve function

const checkpoint = new Checkpoint({
  tools: ['send_email', 'purchase'],
  send: async (question) => platform.send(chatId, `Approval needed: ${question}\nReply yes/no.`),
  waitForReply: () => new Promise(resolve => pendingApprovals.set(chatId, resolve)),
});

// In your message router — intercept approval replies
function onMessage(chatId, text) {
  if (pendingApprovals.has(chatId)) {
    const resolve = pendingApprovals.get(chatId);
    pendingApprovals.delete(chatId);
    resolve(text); // unblocks waitForReply()
    return;
  }
  // ... normal agent handling
}
```

### Recipe 7: Loop + Browsing Tools

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createBrowsingTools } = require('bare-agent/tools');

const provider = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });
const browsing = await createBrowsingTools();
if (!browsing) throw new Error('barebrowse not installed');

const loop = new Loop({ provider });
try {
  const result = await loop.run(
    [{ role: 'user', content: 'Go to example.com and tell me what you see' }],
    browsing.tools
  );
  console.log(result.text);
} finally {
  await browsing.close(); // always close — releases browser resources
}
```

**Privacy assessment:** If `wearehere` is installed (`npm install wearehere`), a 21st tool `assess` is automatically available. It scans any URL for privacy risks and returns a compact JSON:

```javascript
// The assess tool is included in browsing.tools automatically
// Agent can call it like any other tool:
// assess({ url: "https://example.com" })
// Returns: { site, score (0-100), risk, recommendation, concerns, categories }
```

Categories: cookies, network trackers, hidden tracking elements, dark patterns, data brokers, device fingerprinting, stored data, form surveillance, link tracking, terms of service. Score thresholds: 0-19 low, 20-39 moderate, 40-69 high, 70+ critical.

### Recipe 7b: CLI Browsing (token-efficient)

Two browsing strategies — pick based on your use case:

| | Library tools (Recipe 7) | CLI session (this recipe) |
|---|---|---|
| **How** | `createBrowsingTools()` → Loop tools | `npx barebrowse` CLI commands |
| **Snapshots** | Inline in tool results (conversation context) | Written to `.barebrowse/*.yml` on disk |
| **Token cost** | Higher — every snapshot in LLM context | Lower — agent reads files only at decision points |
| **Best for** | Single-page reads, simple interactions | Multi-page workflows, research, token-constrained envs |

**CLI workflow pattern:**

```bash
# Install: npm install barebrowse (CLI available via npx)

# 1. Open a URL (starts session)
npx barebrowse open https://example.com

# 2. Take a snapshot → writes .barebrowse/<session>/<timestamp>.yml
npx barebrowse snapshot

# 3. Agent reads the .yml file, finds [ref=N] markers for interactive elements

# 4. Click a link or button by ref number
npx barebrowse click 5

# 5. Snapshot again at the new page
npx barebrowse snapshot

# 6. Close session when done
npx barebrowse close
```

**CLI command reference:**

| Category | Commands |
|---|---|
| **Session** | `open <url> [flags]`, `close`, `status` |
| **Navigation** | `goto <url>`, `back`, `forward`, `reload [--no-cache]`, `snapshot [--mode=act\|read]`, `screenshot`, `pdf` |
| **Interaction** | `click <ref>`, `type <ref> <text>`, `fill <ref> <text>`, `press <key>`, `scroll <dy>`, `hover <ref>`, `select <ref> <value>`, `drag <from> <to>`, `upload <ref> <files..>` |
| **Tabs** | `tabs`, `tab <index>` |
| **Downloads** | `downloads` (JSON array of captured downloads — `savedPath`, `state`, ...) |
| **Debugging** | `eval <expr>`, `wait-idle`, `wait-for --text=X --selector=Y`, `console-logs`, `network-log`, `dialog-log`, `save-state` |

**Open flags:** `--mode=headless|headed|hybrid`, `--port=N` (attach to running browser), `--proxy=URL`, `--viewport=WxH`, `--storage-state=FILE`, `--download-path=DIR`, `--no-cookies`, `--browser=firefox|chromium`, `--timeout=N`

**Snapshot `.yml` format** contains page content with `[ref=N]` markers on interactive elements (links, buttons, inputs). The ref numbers are stable within a snapshot — use them with `click`, `type`, `drag`, `upload`, and other ref-based commands.

**Key insight:** Don't read every snapshot. Take snapshots freely, but only read the `.yml` file at decision points where you need to choose what to click or verify page content.

### Recipe 8: Loop + Mobile Tools

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createMobileTools } = require('bare-agent/tools');

const provider = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });

// Android (default)
const mobile = await createMobileTools();
// iOS: await createMobileTools({ platform: 'ios' })
// Termux on-device: await createMobileTools({ termux: true })
if (!mobile) throw new Error('baremobile not installed');

const loop = new Loop({ provider });
try {
  const result = await loop.run(
    [{ role: 'user', content: 'Open Settings and turn on Bluetooth' }],
    mobile.tools
  );
  console.log(result.text);
} finally {
  await mobile.close(); // always close — releases device connection
}
```

Mobile tools follow the observe-act pattern: action tools auto-return a fresh snapshot so the LLM sees the result immediately. Tools: `mobile_snapshot`, `mobile_tap`, `mobile_type`, `mobile_press`, `mobile_scroll`, `mobile_swipe`, `mobile_long_press`, `mobile_launch`, `mobile_back`, `mobile_home`, `mobile_screenshot`, `mobile_tap_xy`, `mobile_find_text`, `mobile_wait_text`, `mobile_wait_state`. Android-only: `mobile_intent`, `mobile_tap_grid`, `mobile_grid`. iOS-only: `mobile_unlock`.

### Recipe 8b: Loop + Shell Tools (cross-platform primitives)

`createShellTools()` returns five pure-Node tools that work identically on linux, macOS, and Windows — no external binaries, no platform detection.

| Tool | Purpose |
|---|---|
| `shell_read` | Read a file (utf8, 256KB cap) or list a directory (tab-separated). `~` expands to home. |
| `shell_write` | Write (or `append:true`) UTF-8 text to a file, creating parent dirs. 5MB cap. No shell, so it gates cleanly through `fs.writeScope` once translated to `{type:'write'}`. **`content` is REQUIRED** — see the truncation guard below. |
| `shell_edit` | Anchored exact-string replace — the **surgical** alternative to whole-file `shell_write` (BA-13). `{path, oldText, newText}`: `oldText` must occur **exactly once** (quote surrounding lines to be unique); `newText` is spliced in **verbatim** (`""` deletes). Returns a compact `edited <path>: 1 replacement` receipt, never the body. 0 or 2+ matches → a refusal **returned as the tool result** (the model re-anchors; file untouched). Gates through `fs.writeScope` translated to `{type:'edit'}` — see the note below. |
| `shell_grep` | JavaScript regex search across files. Walks directories, skips binary files, returns `{hits: [{file, line, text}], truncated, fileCount}`. |
| `shell_run` | Run a command with an **argv array** via `child_process.execFile` (no shell, no metacharacter interpretation). Returns `{stdout, stderr, code, timedOut}`. **Use this when you need a policy allowlist.** |
| `shell_exec` | Run a raw shell command string via `/bin/sh -c` (or `cmd.exe`). Returns the same shape. **Shell metacharacters are interpreted — naive allowlists are bypassable.** Use only when you genuinely need shell features (pipes, redirects, globs). |

**Zero baked-in allowlist.** The library ships the primitives; gating is bareguard's job via the standard `wireGate(gate)` wiring.

> **⚠️ `shell_write` requires `content` — and a gate cannot cover for it (v0.27+).** `content` used to default to `''`, so a tool call that OMITTED it silently overwrote the target with **zero bytes** and returned `"wrote 0 bytes to <path>"` as success. That is the ordinary shape of a model hitting its **output-token cap** mid-generation on a long file — observed live emptying a 1789-line source file. **No policy can catch it:** a 0-byte write is a *legal* write, and bareguard's `fs` primitive judges `{type:'write', path}` without inspecting the body (the gate correctly `allow`s it). `shell_write` now **rejects** an absent, `null`, or non-string `content` and leaves the file byte-identical; the error tells the model to retry with the full content. An explicit `content: ""` still empties the file — that one is deliberate.

> **`shell_edit` — the surgical write (BA-13).** Changing one line of an 800-line file with `shell_write` forces the model to re-emit **all 800 lines** as tool-call JSON: an output-token tax ∝ file size (output is the expensive token class), paid on every revision, and the maximal broken-tree surface (a truncated rewrite mangles the lines it never meant to touch — the BA-4/BA-6 class). `shell_edit({path, oldText, newText})` emits only the anchor + replacement. Semantics worth knowing: `oldText` must match **exactly once** (a 0/2+ match is a refusal *returned as the tool result*, so the loop continues and the model widens the anchor — not a throw, so a repeated-identical miss is bounded by maxTurns/budget, not the spin guard); missing/empty `oldText` or missing/non-string `newText` **throw** (BA-4 guards; `newText:""` is a legal deletion); the write is **atomic** (sibling temp + rename, mode preserved) so an fs failure never leaves a partial file; and `newText` is a **literal splice** (a `$&`/`$1` in it lands verbatim, unlike `String.replace`). Gate it exactly like `shell_write` but as `{type:'edit'}` — **bareguard gates `edit` by the same `fs.writeScope` as `write` with zero config** (its FS primitive's `FS_TYPES` already includes `edit`).

> **⚠️ `shell_exec` injection caveat.** `"ls"` passes a base-command allowlist like `args.command.split(/\s+/)[0]`, but so does `"ls;rm -rf /tmp/x"` — the shell runs both. **A base-command allowlist is NOT safe for `shell_exec`.** For policy-gated use, prefer `shell_run({argv})` and allow-list on `args.argv[0]` — there is no shell in that path, so metacharacters are just literal argument bytes. Use `shell_exec` only when the agent needs pipes/redirects/globs, and gate it at a higher level (human approval, narrow intent).

```javascript
const { Gate } = require('bareguard');
const { Loop, wireGate } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createShellTools } = require('bare-agent/tools');

const gate = new Gate({
  // argv[0] allowlist for shell_run — bareguard's `bash` primitive enforces this.
  bash:   { allow: ['ls', 'cat', 'grep', 'ps', 'df', 'uname', 'node', 'git'] },
  // Hard-deny shell_exec for this agent. tools.denylist short-circuits before content checks.
  tools:  { denylist: ['shell_exec'] },
  // fs scope for shell_read / shell_grep.
  fs:     { readScope: ['/home/', '/tmp/'] },
  audit:  { path: './shell-audit.jsonl' },
  humanChannel: async (event) => ({ decision: 'deny' }),
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate);
const { tools: shellTools } = createShellTools();
const tools = await filterTools(shellTools);  // drop shell_exec (denylisted above) before the LLM sees it

const loop = new Loop({
  provider: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }),
  policy,
  onLlmResult,
  onToolResult,
});

const result = await loop.run(
  [{ role: 'user', content: 'What is in /tmp and how many README files are there under /home/me/code?' }],
  tools,
);
```

**Allowlist is platform-specific on purpose.** `ls`/`cat`/`grep` work on linux and macOS, `dir`/`type`/`findstr` on Windows. The primitives are cross-platform; the *gate config you write* picks the commands appropriate for your OS. The library stays out of that decision.

**Why JavaScript regex for `shell_grep` instead of shelling out to `grep`/`rg`:** pure-Node means no dependency on external binaries being installed, identical behaviour on Windows, and governance covers the implementation (no hidden `child_process.spawn` bypassing the Loop policy).

### Recipe 9: Loop + MCP Bridge (auto-discover + governance)

`createMCPBridge` reads MCP server definitions from standard IDE config locations (`.mcp.json`, `~/.mcp.json`, `~/.claude/mcp_servers.json`, `~/.config/Claude/claude_desktop_config.json`, `~/.cursor/mcp.json`), spawns each server over stdio, lists its tools, and returns a ready-to-use bareagent tool array. Any MCP-speaking server is consumable — zero glue code per server.

```javascript
const { Loop } = require('bare-agent');
const { OpenAI } = require('bare-agent/providers');
const { createMCPBridge } = require('bare-agent/mcp');

const provider = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' });

const bridge = await createMCPBridge();
// bridge = { tools, servers, denied, systemContext, errors, close }

const loop = new Loop({
  provider,
  system: bridge.systemContext, // tells the LLM which tools exist and which are restricted
});

try {
  const result = await loop.run(
    [{ role: 'user', content: 'Summarise my unread messages.' }],
    bridge.tools,
  );
  console.log(result.text);
} finally {
  await bridge.close(); // always close — kills spawned MCP subprocesses
}
```

**Governance via `.mcp-bridge.json`.** On first run, the bridge writes `.mcp-bridge.json` in the cwd listing every discovered server and tool with permission `"allow"`. Edit any entry to `"deny"` and the tool is dropped from the next run's tool array; the LLM sees it listed in `systemContext` as restricted, with instructions not to retry it. Re-discovery happens automatically after TTL expiry (default `24h`, settable via `ttl` field in the file).

```json
{
  "discovered": "2026-04-13T12:00:00.000Z",
  "ttl": "24h",
  "servers": {
    "beeperbox": {
      "command": "docker",
      "args": ["exec", "-i", "beeperbox", "node", "/opt/mcp/server.js", "--stdio"],
      "tools": {
        "list_inbox": "allow",
        "read_chat": "allow",
        "send_message": "deny",
        "archive_chat": "allow"
      }
    }
  }
}
```

**Runtime policy (arg-dependent checks).** Static allow/deny in the file handles coarse-grained permissions. For checks that depend on arguments (e.g. deny `send_message` only when `chat_id` matches a specific group), express them in your bareguard `Gate` config — `tools.denyArgPatterns` and `content.denyPatterns` cover most cases, and the `wireGate(gate).policy` adapter applies them to every tool source uniformly:

```javascript
const { Gate } = require('bareguard');
const { Loop, wireGate } = require('bare-agent');
const { createMCPBridge } = require('bare-agent/mcp');

const bridge = await createMCPBridge();

const gate = new Gate({
  tools: {
    denyArgPatterns: {
      // Per-tool arg patterns. Matches against JSON-stringified args.
      beeperbox_send_message: [/"chat_id"\s*:\s*"[^"]*finance[^"]*"/],
    },
  },
  humanChannel: async (event) => ({ decision: 'deny' }),
});
await gate.init();

const { policy, onLlmResult, onToolResult, filterTools } = wireGate(gate);
const gatedTools = await filterTools(bridge.tools);

const loop = new Loop({
  provider,
  system: bridge.systemContext,
  policy,
  onLlmResult,
  onToolResult,
});

await loop.run(messages, gatedTools);
```

MCP tools arrive with the server name prepended (`beeperbox_send_message`, not `send_message`). Bareguard glob-matches the canonical name string against `tools.allowlist` / `tools.denylist`; no MCP-specific parsing.

> **v0.6.0 migration:** `createMCPBridge({ policy })` was removed. Runtime policy is Loop-level now, not mcp-bridge-level. Passing `policy` to `createMCPBridge` throws with a migration message.
>
> **v0.8.0 migration:** All policy/audit/budget decisions moved to bareguard. `Loop({ maxCost })`, `Loop({ maxRounds })`, `Loop({ audit })`, and the `bare-agent/policy` helpers are gone. Wire bareguard via `wireGate(gate)`; see "Wiring with bareguard" above.

**Options:**

| Option | Default | Purpose |
|---|---|---|
| `bridgePath` | `./.mcp-bridge.json` | Override the config file location |
| `configPaths` | IDE defaults | Custom list of config files to scan |
| `servers` | all discovered | Limit to a subset by name |
| `timeout` | `15000` | Per-server init timeout in ms |
| `refresh` | `false` | Force re-discovery regardless of TTL |

### Recipe 10: beeperbox — multi-messenger reach via MCP bridge

[beeperbox](https://github.com/hamr0/beeperbox) is a headless Beeper Desktop in Docker that exposes an MCP server on stdio and HTTP. Wiring it into bareagent is a two-step process: drop its launch command into any MCP config file, then call `createMCPBridge`. No beeperbox-specific code in bareagent.

**Step 1** — add beeperbox to `.mcp.json` in your project root (or any of the IDE-standard locations):

```json
{
  "mcpServers": {
    "beeperbox": {
      "command": "docker",
      "args": ["exec", "-i", "beeperbox", "node", "/opt/mcp/server.js", "--stdio"]
    }
  }
}
```

**Step 2** — use the bridge as in Recipe 9. beeperbox tools are namespaced `beeperbox_*`:

```javascript
const bridge = await createMCPBridge({ servers: ['beeperbox'] });
const loop = new Loop({ provider, system: bridge.systemContext });

try {
  await loop.run(
    [{ role: 'user', content: 'Check my WhatsApp unread and reply to Sara that I\'ll call her at 5.' }],
    bridge.tools,
  );
} finally {
  await bridge.close();
}
```

beeperbox exposes 10 semantic tools covering every Beeper-connected bridge (WhatsApp, iMessage, Signal, Telegram, Discord, Slack, Messenger, Instagram, LinkedIn, Google Messages, Matrix): `list_accounts`, `list_inbox`, `list_unread`, `get_chat`, `read_chat`, `search_messages`, `send_message`, `note_to_self`, `react_to_message`, `archive_chat`. See [beeperbox.context.md](https://github.com/hamr0/beeperbox/blob/main/beeperbox.context.md) for full tool signatures, schemas, and network slugs.

**Least-privilege pattern:** beeperbox tokens have a read-only mode (Beeper Desktop → Settings → Developers → uncheck "Allow sensitive actions"). Combine a read-only token with `.mcp-bridge.json` deny entries on `send_message` / `archive_chat` for defence-in-depth — token scope enforced server-side, allow/deny enforced client-side before the LLM ever sees the tool.
