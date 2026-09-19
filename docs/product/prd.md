---
type: reference
title: "bareagent — Core One-Shot-Runner Spec"
status: stable
sources: ["docs/archive/prd.md"]
---

# bareagent Core Spec

The core one-shot-runner spec: what bareagent is and isn't, its positioning against
framework-shaped alternatives, the loop architecture, the NO-GO list, language/runtime
rules, the migration plan, v1.0.0 success criteria, and open POC questions. The full
original document is archived at `docs/archive/prd.md`.

## Summary

`bareagent` is a zero-dep, one-shot LLM agent loop runner for Node.js (prd.md:23).
You hand it a config (system prompt, tool registry, model, gate config); it runs an
LLM tool-use loop where every tool call traverses a single gate provided by
`bareguard`, and exits cleanly when the loop ends. State lives entirely in JSONL
files on disk — no daemon, no scheduler, no class hierarchy for agent roles, no
message bus, no plugin framework (prd.md:27-31).

Multi-agent orchestration is an agent calling the built-in `spawn` tool to fork a
child bareagent process; deferred work is an agent calling the built-in `defer`
tool to emit a JSONL record an external scheduler (cron + reference `wake.sh`, or
a future `barejob` library) picks up. MCP integration is two built-in tools:
`mcp_discover` (caches a catalog of MCP-exposed tools for 30 days) and `mcp_invoke`
(calls them) (prd.md:33-38).

## What bareagent IS

- A **one-shot process**: start → loop → exit, no persistence, no daemon, no
  resident state (prd.md:42-43).
- A **runner, not a framework** — it executes the loop and routes tool calls,
  imposing no patterns ("planner"/"executor"/"critic"); those are the user's
  prompts and configs (prd.md:44-46).
- The **caller of `bareguard`** — every action through `gate.check()`, every
  result through `gate.record()`; bareagent owns no policy (prd.md:47-48).
- Both a **CLI** (`bareagent --config foo.json [< input.json]`) and a **library**
  (`import { Agent } from "bareagent"`), same code (prd.md:49-50).
- A **producer of JSONL** on three channels: the audit log (via bareguard), child
  stdout (when spawned by a parent), and the defer queue file (prd.md:51-53).

Two companion suites compose onto the Loop without it imposing them, documented
in their own specs rather than here: an opt-in assistive suite (`Evaluator`+
`refine`, `SkillRegistry`+`createStashSkill`, the `result.metrics` run meter,
`isCritical`) in `eval-assist-prd.md` (delivered 2026-06-24, prd.md:55-64); and
`recurse()`, the RLM decompose→fan-out→verify→synthesize primitive, in
`RLM_PRD.md` (delivered 2026-06-28, prd.md:66-72).

## What bareagent is NOT

- **NOT a scheduler or daemon** — no future-time wakeups (that's cron +
  `wake.sh` or a future `barejob`) and no staying running between invocations
  (prd.md:76-80).
- **NOT a multi-agent framework** — no role types, registry, orchestrator class,
  DAG runner, or debate/swarm/group-chat patterns; multi-agent is a parent calling
  `spawn(config, input)` to fork a child process (prd.md:81-84).
- **NOT a memory system** — the audit log and files agents explicitly write are
  the only "memory"; no vector store, no episodic memory primitive, no automatic
  summarization (prd.md:85-87).
- **NOT a policy enforcer** — every gate decision delegates to bareguard; bareagent
  never decides "is this allowed?", it only asks (prd.md:88-89).
- **NOT an MCP server, registry, or proxy** — it's a *consumer* of MCP servers
  (prd.md:90-91).
- **NOT a code execution sandbox** — `bash` runs commands on the host (gated);
  containment (Docker, gVisor) is a separate layer (prd.md:92-94).
- **NOT a chat UI** — it's a process; UI is the caller's problem (prd.md:95).

## Problem statement & positioning

Indie devs/small teams need a runner that (1) runs an LLM tool-use loop without a
framework, (2) lets agents spawn/defer without becoming a daemon/orchestrator/
scheduler, (3) discovers/invokes MCP tools without coupling MCP into the policy
layer, and (4) delegates all policy to a separate, reusable library (prd.md:99-107).
Today's options (LangChain, CrewAI, AutoGen, LangGraph) are framework-shaped,
opinionated about topology, heavyweight, and couple policy to the runner; bareagent
is the zero-framework alternative (prd.md:109-111).

| | LangChain / CrewAI / AutoGen | bareagent |
| --- | --- | --- |
| Shape | Framework + abstractions | Runner + tools |
| Multi-agent | Class hierarchies, role types | `spawn` tool + JSONL stdio |
| Deferred work | Built-in scheduler, queues | `defer` tool emits JSONL; external runs it |
| Policy | Coupled, partial, varies by class | External (`bareguard`), single gate |
| MCP | Adapter classes per server | Two tools (`mcp_discover`, `mcp_invoke`) |
| Lifecycle / Deps / LOC | Long-running; many deps; ~10K–100K | One-shot, exits clean; zero core deps; ≤800 LOC ex. tests/adapters |

(prd.md:115-124)

## Core thesis

**One-shot loop runner. Everything else is composition.** The "always-on" feeling
of multi-agent systems is an illusion produced by *frequent stateless wakeups over
persistent JSONL* — a pattern UNIX figured out in 1973. bareagent participates in
it correctly: spawning a child = subprocess + JSONL stdio; deferring work = emit a
JSONL record to a queue file; policy = `bareguard.gate(action)` before every tool
call; communication = stdout/stdin JSONL between parent and child; memory = the
audit log + explicit files agents write. Adding a class hierarchy, a registry, a
daemon mode, a message bus, a memory abstraction, or a scheduler means you are not
implementing bareagent (prd.md:128-143).

## Architecture: the loop

```
while not done:
  msg = await llm.next(history, tools)
  if msg.is_tool_call:
    action      = msg.tool_call
    cleanAction = gate.redact(action)            // secrets
    decision    = await gate.check(cleanAction)
    if decision.outcome == "allow":
      result = await tools[cleanAction.name](cleanAction.args)
    else if decision.outcome == "askHuman":
      result = await approval(cleanAction, decision.prompt)
    else:  // deny
      result = { error: decision.reason }
    await gate.record(cleanAction, result)       // audit + budget
    history.push(result)
  else:
    done = msg.is_final
exit(0)   // one-shot. no persistence. no daemon.
```
(prd.md:147-172)

**Hard rules** (prd.md:175-181): one gate before every tool call, no bypass
paths, tools never self-check; tools are pure "do the thing" — if a tool was
called, the gate said yes; the process exits when the loop ends, state is on
disk not in memory; every spawn is a subprocess (no shared memory between
agents); every defer is a JSONL append (no internal queue).

## NO-GO list

Recorded so future contributors don't re-litigate (prd.md:661):

| Out | Why |
| --- | --- |
| Scheduler / daemon mode, internal scheduler primitive | One-shot; use cron + `wake.sh`; becomes `barejob` if friction emerges |
| Class hierarchies for agent roles, agent registry | Roles are configs not types (CrewAI is the warning); parent knows children's configs by path |
| Cross-agent message bus | stdout/stdin + JSONL |
| Persistent memory subsystem, vector store/embeddings | Audit log + files on disk; caller's problem above that; not the runner's job |
| Graph-based DAG runner | LangGraph exists; not bare |
| Plugin system / hooks framework | Tools are the extension point |
| Built-in retry / circuit breaker | Prompt + gate deny + caller's outer loop handle this |
| Telemetry, hosted/SaaS version | Bare suite philosophy — no phone-home, ever |
| Web UI for the audit log | JSONL is grep-able |
| Built-in "agent debate" patterns | Prompting pattern, not infrastructure |
| Long-running parent supervising children | Parent spawns, reads child JSONL, exits |
| MCP server registry/aggregator, MCP gov logic in bareagent | bareagent is a *consumer*; all gov decisions go through bareguard |
| CodeMode-style code-block tool execution | Weakens single-gate guarantee (see §22 decision log) |
| Code execution sandbox | Different layer (Docker, gVisor) |
| Multi-language SDK in v1 | Node-first; port later if there's pull |

(prd.md:663-684)

## Language & runtime

**Node.js 20 LTS+, ESM only** (prd.md:690).

- Stdlib only, ideally: `child_process`, `fs/promises`, `readline`, `path`,
  `crypto`, `process`, `events`, built-in `fetch` (prd.md:692-693).
- Optional peer deps (caller installs): `@anthropic-ai/sdk`, `openai`, or any
  other LLM SDK — bareagent ships thin adapters and lazy-imports the SDK the user
  picked (prd.md:694-696).
- Optional dep `js-yaml` for YAML config (JSON works without it); no
  `commander`/`yargs` (30 lines of inline arg parsing) (prd.md:697-699).
- **Production deps in bareagent core: 0** — a hard target; deviation during
  POC requires explicit PRD justification (prd.md:701-703).

**Types & typecheck (v0.11+):** source stays pure JS + JSDoc — no `.ts` source, no
runtime build step. TypeScript is dev-only: `tsc` emits `.d.ts` from JSDoc
(`emitDeclarationOnly`) on publish (`prepublishOnly` → `build:types`), git-ignored,
resolved via `types` conditions per `exports` subpath (shared shapes in `types/`);
`npm run typecheck` (`tsc --checkJs`, `strictNullChecks`) gates CI and publish —
full `strict` was trialled and relaxed to null-checks-only after surfacing ~95%
annotation-completeness noise vs. ~5% genuine null-safety value; `typescript`/
`@types/node` stay `devDependencies` (prd.md:707-723).

## Migration plan

Order matters; each step is independently shippable (prd.md:727). **bareguard
0.1.1** (shipped 2026-04-30): shared budget file, halt severity, `humanChannel`,
single-file audit via `O_APPEND`, `gate.allows()`, `tools.denyArgPatterns`,
`parent_run_id`/`spawn_depth`, `content` primitive; rate limits deferred to 0.2
(prd.md:729-734). **bareagent v(next)** depends on `bareguard ^0.1.1` — all
policy code removed from the runner, every call traverses `gate.check()`/
`gate.record()`, old guard exports re-route with `DeprecationWarning`, use
`new Gate(...)` only (`Gate.fromConfig` removed) (prd.md:735-739). **bareguard
0.2** (shipped 2026-04-30) adds `defer-rate`/`spawn-rate` (fixed-minute window,
audit-log source of truth, defer 15/min, spawn 10/min default); pin
`^0.2.0`; `**` glob stayed deferred (prd.md:740-745). **bareagent v0.9** depends
on `bareguard ^0.2.0` — adds `spawn`, `defer`, `mcp_discover`, `mcp_invoke`
tools, documents JSONL conventions, ships `examples/wake.sh`/`wake.md`/
`orchestrator/` (prd.md:746-750). **v(next+2)** removes deprecated guard
re-exports (prd.md:751). Then a **real-use phase** (build an orchestrator +
specialist project, live in it two weeks, note what hurts) (prd.md:752-753),
followed by a **post-real-use** decision on whether `barejob` earns existence
from felt friction, or `wake.sh` stays the answer (prd.md:754-756).

## Success criteria for v1.0.0

Source ≤800 LOC excluding tests/adapters; zero policy code (grep-verified — no
`if action.allowed`, no allowlist arrays); every tool call through
`gate.check`/`gate.record` (one JSONL audit line per call); `spawn`/`defer`
working end-to-end with bareguard 0.2 enforcing limits (3-level tree tripping
`maxDepth`); reference `wake.sh` reliable for 24h; an orchestrator + specialist
example in `examples/`; `mcp_discover` caching 30 days, `mcp_invoke` traversing
the gate; `parent_run_id` threaded through a 3-deep spawn tree; one real
project built on the above; the NO-GO list (§17) verbatim in
`docs/non-roadmap.md`; published to npm, cross-linked from bareguard's README
(prd.md:760-776).

## Open questions to resolve during POC

Config format (JSON-only vs +optional YAML — lean JSON-first, YAML behind an
optional dep); LLM adapters (bundle Anthropic+OpenAI lazy-loaded vs
one-adapter-per-package plugin model — lean bundled/lazy); spawn blocking
(parent blocks per child vs explicit `await handle.wait()` — lean explicit
wait, never auto-block); defer queue path (`./bareagent-defers.jsonl` vs
`$XDG_STATE_HOME/...` — lean XDG with cwd fallback); spawn stream callback
(`{ onLine: fn }` opt-in vs collect-on-wait default — lean collect-on-wait);
child stderr (separate-capture vs merged vs pass-through — lean separate so
debug noise doesn't pollute JSONL); MCP cache invalidation (on config change vs
TTL-only — lean TTL-only, force-refresh via `mcp_discover({ refresh: true })`)
(prd.md:780-796).

## Primitives manifest (`primitives.json`)

**Purpose.** So an agent or developer can `npm`-fetch a package and know, without
reading the ~1,500-line context doc, what primitives it offers and how to call
them. It is an **author-time selection aid**, not a runtime tool surface — a
menu you assemble a runner from, read once *before* the loop exists. This is the
`baresuite` answer to "agentic automation is converging on LLM-with-tool-calling,
so how does a model pick up a library's primitives without eating prose?" An
`llms.txt`-shaped answer is explicitly rejected: that tells a human what packages
exist; this tells a model what it can *call*.

**Scope.** bareagent first — it is the hardest case (`recurse` opts, `Loop`,
HaltError semantics, null-vs-zero contracts), so a schema that survives it
survives the rest. Once proven here the same shape is adopted by the other
build-with repos (bareguard, bareloop, fwdloop). The runtime-callable packages —
barebrowse, baremobile, litectx — are **out of scope**: they are already MCP
servers, the correct shape for tools a model calls at runtime. A model does not
"call" a budget gate or a loop; it builds with them and gets caged by them. That
split (author-time manifest vs runtime MCP) is deliberate.

**Inclusion rule.** Anything an agent *or* developer can construct or call to
build/run automation is a primitive — the "author" may itself be an agent
spawning a child, so resilience knobs it must attach (`Retry`, `CircuitBreaker`,
`Stream`, `JsonlTransport`) count too. The only exclusion is bare error classes:
you catch them, you don't construct them as a capability, so they fold into the
`fails` line of whatever throws them rather than getting their own entry. Net for
bareagent: the whole components table + providers + stores + tools. They are
called **primitives** — not "functions" (many are classes) and not "tools" (that
collides with the runtime tool-calling surface).

**Schema.** One file, fixed name `primitives.json` at package root. The repo name
is a field, not part of the filename, so the discovery path stays predictable.
There is **no `version` field**: `package.json` sits beside the manifest in the
same tarball with the authoritative version, so duplicating it here would only add
a pin that goes silently stale on every release. Leaving it out makes the manifest
pure content — its diff changes only when primitives change. Suite-wide convention
(bareagent, bareguard, litectx all ship `{package, primitives}`):

```json
{
  "package": "bare-agent",
  "primitives": [
    {
      "name": "recurse",
      "category": "orchestration",
      "when": "a task is too big for one model pass and you want it split, fanned out, verified, and merged — with total cost capped by a gate",
      "import": "import { recurse } from 'bare-agent'",
      "signature": "recurse(task: string, ctx: object, opts?: object) => Promise<{result, verdict, receipts} | {incomplete, best, receipts}>",
      "fails": "returns {incomplete, best} on guard exhaustion or a dead worker (never a faked pass); a gate HaltError exits clean. Cost is open by design — run under a budget gate.",
      "example": "const ctx = wireGate(gate);\nconst { result, incomplete } = await recurse('audit 400 logs', ctx, { provider, corpus });\nif (incomplete) retryOrEscalate(result);"
    }
  ]
}
```

Per-entry fields: `name`, `when`, `category`, `import`, `signature`, `fails`
(required — one plain line on what happens when it fails or refuses), `example`
(a fresh ~3-line canonical call, copy-paste ready). `when` is the load-bearing
field, not `what`: this is the bareloop selection finding one layer out —
capability without a trigger is inert (litectx was drafted 1.4% of the time vs
`read` 99.3% despite zero zero-hit recalls). A description tells the model what a
primitive does; `when` is what gets it picked.

**Authoring.** `when` and `fails` are the only hand-written fields — authored as
JSDoc tags (`@when`, `@fails`) on the source symbol, so they travel with it, die
with it, and show up in the same diff as any code change (they cannot drift out
of sync — same discipline as never hand-editing a `.d.ts`). `name`, `import` and
`signature` generate from JSDoc + the existing `.d.ts` pipeline. `example` is a
hand-written snippet per entry, validated (see below).

**Generation.** A generator runs alongside `build:types`, parses JSDoc, and emits
`primitives.json`. Never hand-written — a hand-written manifest drifts the moment
source moves, for the same reason a `.d.ts` is generated.

**Discovery.** Fixed filename `primitives.json` at package root → pointed at from
`package.json` (`"primitives": "./primitives.json"`) → reachable at
`unpkg.com/<pkg>/primitives.json` **without install**, so a model can fetch-to-
decide-then-`npm`. Plus a ≤10-line suite index that names only the *packages* and
their manifest paths, never the primitives (naming primitives centrally = drift;
each repo owns its own truth). The `package.json` key + fixed filename *is* the
discovery contract, documented once and conformed to by all build-with repos.

**Validation (CI gate, publish-blocking).** Mirrors bareloop's export-contract
check: every manifested name is actually exported; every entry carries
`when`/`fails`/`example`. A lying or stale manifest fails the build — a manifest
a model trusts for `import`/`signature` is worse than none if it can drift.
**As shipped in v1** (`check:primitives` + `test/primitives-completeness.test.js`),
the gate covers exports-map presence, required-field non-emptiness, and the
completeness/allow-list pair — checking that `signature` matches the emitted
`.d.ts` and that every `example` typechecks are NOT yet built; both stay
deferred validation, tracked here rather than silently assumed.

**Known real work (not free).** `signature`/`import` generate from what JSDoc
already carries. `when`/`fails`/`example` are net-new hand authoring across the
full inclusion list — the bulk of v1. `fails` in particular cannot be scraped:
failure behavior is documented in prose today (`@throws` is sparse — ~94 tags,
concentrated in providers; `recurse` has one), so a `@fails` convention is added
and authored per primitive.

**As built (bareagent reference, v0.44.0).** 49 primitives. The generator
(`scripts/gen-primitives.mjs`) scans `src/` and `tools/`; three tags beyond the
core design earned their place under contact with the real surface: `@name`
(overrides an aliased export — `readQueue`→`readDeferQueue`, `SQLiteStore`→
`SQLite`), `@category` (overrides the file-inferred category), `@signature` (pins
an exact literal signature when the derived one would leak a private/test-only
seam), and a `category:
"integration"` for the litectx *connectors* (`litectxCorpus`, `buildSearchTool`,
`liteCtxMcpBridgeConfig`) — bareagent-owned glue into litectx, kept in bareagent's
manifest because they are bareagent exports (litectx's own verbs stay in litectx's
manifest; zero overlap). Completeness is a CI test (`test/primitives-completeness.js`)
that owns the deliberate-exclusion allow-list (error classes, provider aliases,
calibration helpers, unit converters) and fails if any other public export is
unmanifested — so a new export cannot silently miss the manifest.

## Appendix A: relationship to other bare suite components

bareagent (the agent loop runner, this doc) depends on bareguard (policy +
audit, sibling spec); `barejob` (a hypothetical future scheduler daemon) would
sit as a sibling of bareagent at the same layer, not a dependency
(prd.md:2468-2479).

## Appendix B: the test for any new built-in tool

Before adding anything to bareagent's built-in tool set, answer (prd.md:2483):
is it an **action against the world** (else it's a runner feature, not a
tool)? Can it be **≤100 LOC** as a thin stdlib/sibling-library wrapper (else
ship it separately, user-wired)? Does it make sense for **every agent** (else
it's domain-specific — `examples/` or a sibling repo)? Does bareguard need a
corresponding **guard primitive** (add the guard first)? Four yeses or it
doesn't ship in core (prd.md:2485-2496).

## Appendix C: file layout for the repo

Suggested (not mandatory) top-level shape: `package.json`, `README.md`,
`docs/` (`non-roadmap.md`=§17 NO-GO verbatim, `decisions-log.md`=§22 verbatim);
`src/index.js` (exports `Agent`, CLI entrypoint), `src/agent.js` (the loop),
`src/tools/` (`bash.js`, `fs.js` read/write/edit, `fetch.js`, `spawn.js`,
`defer.js`, `mcp.js` for discover/invoke/cache), `src/adapters/`
(`anthropic.js`, `openai.js`), `src/cli.js`; `test/` (loop/spawn/defer/mcp +
`integration.test.js` for audit-log + budget verification); `examples/`
(`wake.sh`=§15 verbatim, `wake.md` cron notes, `orchestrator/` with a README,
`orchestrator.json`, `specialists/{summarizer,researcher}.json`).
Implementation can move files around, but tests and examples should be
preserved as listed (prd.md:2500-2540).
