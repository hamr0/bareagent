# bare-agent

Lightweight, composable agent orchestration library for autonomous agents. ~2.7K lines core, one required dep (`bareguard ^0.4.2`), Apache 2.0.
Node.js >= 18, pure JS + JSDoc, `node:test` for testing. Flat `src/` layout with prefix naming.

## Components

| Component | File | Purpose |
|-----------|------|---------|
| Loop | src/loop.js | Core think/act/observe cycle (throwOnError: true, cost estimation, `policy(tool, args, ctx)` chokepoint for bareguard adapter, `assemble(msgs, ctx)` context-assembly chokepoint for a CE library [RT-1: returns a view, transcript untouched, fail-open, HaltError propagates; `src/context-units.js` `unitAssembler` adapts it to the neutral-unit verb `assemble(units, ctx)`], `trim(msgs, ctx)` DESTRUCTIVE transcript-bound chokepoint [RT-2: runs before assemble, evicts old turns AFTER harvest, mutates canonical msgs, fail-open, HaltError propagates; `unitTrimmer`/`harvestKey` wrap litectx's `trim` verb (≥0.16.0) for harvest-before-evict + F2 residual `.flush`], fail-safe verdict, unified `loop:error`+`onError` for every silent-ish failure). Internal `HARD_ROUND_LIMIT = 100` safety net only — real bounds come from bareguard `limits.maxTurns` |
| Planner | src/planner.js | Goal -> step DAG via LLM structured output |
| assessComplexity | src/complexity.js | Pure-code (no-LLM) pre-planner: classifies a goal simple/medium/complex/critical from text alone via tiered keyword scoring + a critical safety override (security/production/compliance/financial). Returns `{level, score, needsPlanning, signals}` — `needsPlanning` gates whether to invoke Planner; `critical` flags work for extra scrutiny. Concept-port of Aurora's SOAR keyword assessor (~89% on its corpus). **FROZEN** (eval-assist F4): don't extend the keyword lists. `isCritical(goal)` exports the durable critical-safety floor standalone (gates adversarial verification without the scorer) |
| runPlan | src/run-plan.js | Execute step DAG with wave-based parallelism |
| StateMachine | src/state.js | Task lifecycle (pending/running/done/failed/waiting/cancelled) |
| Scheduler | src/scheduler.js | Time-triggered turns (cron + relative) |
| Checkpoint | src/checkpoint.js | Human-in-the-loop approval gate (always-prompt; complementary to bareguard's policy-driven humanChannel) |
| Memory | src/memory.js | Thin wrapper delegating to swappable store |
| Stream | src/stream.js | Structured event emitter |
| Retry | src/retry.js | Backoff with jitter for async functions |
| CircuitBreaker | src/circuit-breaker.js | Per-key circuit breaker (closed/open/half-open) |
| JsonlTransport | src/transport-jsonl.js | JSONL output to writable stream (pipe-friendly) |
| Errors | src/errors.js | BareAgentError, ProviderError, ToolError, TimeoutError, ValidationError, CircuitOpenError, HaltError. Halt decisions (turn cap, budget cap, content rules) come from bareguard — HaltError signals a clean governance exit (caught by Loop, not propagated as an exception even with throwOnError:true) |
| bareguard adapter | src/bareguard-adapter.js | `wireGate(gate, {formatDeny?})` -> `{ policy, onLlmResult, onToolResult, filterTools, wrapTool, wrapTools }`. One-line wiring: `policy` maps gate.check decisions; `onLlmResult`/`onToolResult` forward to gate.record with `ctx` in scope (BA1 — fixes budget undercount on token-only flows); `filterTools` drops denied tools via `gate.allows` (BA3); halt throws `HaltError` and Loop exits cleanly (BA2); `formatDeny` customises deny strings (BA4). `wrapTool`/`wrapTools` retained as deprecation shims |
| MCPBridge | src/mcp-bridge.js | Auto-discover MCP servers, expose as bareagent tools. Static allow/deny via .mcp-bridge.json. Runtime policy lives in `Loop({ policy })` (v0.6.0+) — wire bareguard for unified MCP + native gating (v0.8.0+). Returns `{tools, metaTools, ...}` — bulk vs `mcp_discover`+`mcp_invoke` (v0.9.0+) |
| Spawn | tools/spawn.js | Fork child bareagent (`bin/cli.js --config`). LLM-callable blocks; library `spawnChild` returns handle. One JSONL channel per child (stderr re-emitted as `child:stderr`). Threads BAREGUARD env vars; bareguard 0.2+ caps per-family via `spawn.ratePerMinute` + `limits.maxDepth`. `timeoutMs` = wall-clock ceiling; opt-in `idleTimeoutMs` = heartbeat watchdog (kills a child silent on both stdio for N ms; resets per line, so slow-but-working children survive — result carries `idleKilled`) |
| Defer | tools/defer.js | Append `{id, action, when}` to JSONL queue for an external waker (cron + `examples/wake.sh`) to fire later. Two-phase gov: emit-time gate.check on `defer` action; fire-time gate.check on inner action. bareguard 0.2+ caps via `defer.ratePerMinute` |

Providers: OpenAI, Anthropic, Gemini, Ollama, CLIPipe, Fallback -- each in `src/provider-*.js`. All normalize `usage` to one neutral shape incl. prompt-cache tiers (`cacheReadTokens`/`cacheCreationTokens`; `inputTokens` = uncached remainder). Gemini is native `generateContent` (its OpenAI-compat endpoint drops the cache tier). Anthropic has opt-in `cacheSystem` (cache_control) + `baseUrl`. Loop returns `result.metrics` (the meter: cumulative 4-tier tokens, byTool, costUsd null-not-zero, unpricedRounds) — `estimateCost` prices the 4 tiers separately
Stores: SQLiteStore (peer dep: better-sqlite3), JsonFileStore (zero deps) -- each in `src/store-*.js`
Tools: BrowsingTools (tools/browse.js, optional dep: barebrowse) — library tools for inline snapshots, CLI session (`npx barebrowse`) for token-efficient disk-based browsing
Tools: MobileTools (tools/mobile.js, optional dep: baremobile) — Android + iOS device control via snapshot/tap/type pattern
Tools: ShellTools (tools/shell.js, zero deps) — shell_read, shell_grep, shell_run (execFile argv), shell_exec (raw shell). Cross-platform pure Node, no external binaries

## Exports

| Entry point | Contents |
|-------------|----------|
| `bare-agent` | Components (incl. `assessComplexity`, `isCritical`) + error classes + CircuitBreaker + wireGate |
| `bare-agent/providers` | All providers including Fallback |
| `bare-agent/stores` | SQLite + JsonFile |
| `bare-agent/transports` | JsonlTransport |
| `bare-agent/tools` | createBrowsingTools, createMobileTools, createShellTools, createSpawnTool, spawnChild, createDeferTool, readDeferQueue |
| `bare-agent/bareguard` | wireGate (returns `{ policy, wrapTool, wrapTools }`) |
| `bare-agent/mcp` | createMCPBridge (returns `{tools, metaTools, ...}`), discoverServers, buildMetaTools |

## Commands

```bash
npm test                                    # All tests (unit + integration + e2e)
node --test test/integration*.test.js       # Integration only (needs API keys)
node --test test/e2e.test.js                # E2E composition tests
npm run typecheck                           # tsc --checkJs (strictNullChecks) over JSDoc — runs in CI
npm run build:types                         # emit .d.ts from JSDoc (auto-runs on prepublishOnly)
```

Source is pure JS + JSDoc; `.d.ts` are generated (git-ignored, shipped on publish). Keep JSDoc accurate — CI runs `npm run typecheck` on every push/PR and gates publish. Shared type shapes live in `types/`.

## Key Patterns

- Loop builds messages in OpenAI format; each provider normalizes to its own API
- provider.generate() returns `{ text, toolCalls, usage }`; stores implement `store/search/get/delete`
- Components are independent: Memory doesn't know Loop, Scheduler doesn't know Planner

## Dev Rules

**POC first.** Always validate logic with a ~15min proof-of-concept before building. Cover happy path + common edges. POC works -> design properly -> build with tests. Never ship the POC.

**Build incrementally.** Break work into small independent modules. One piece at a time, each must work on its own before integrating.

**Dependency hierarchy -- follow strictly:** vanilla language -> standard library -> external (only when stdlib can't do it in <100 lines). External deps must be maintained, lightweight, and widely adopted. Exception: always use vetted libraries for security-critical code (crypto, auth, sanitization).

**Lightweight over complex.** Fewer moving parts, fewer deps, less config. Simple > clever. Readable > elegant.

**Open-source only.** No vendor lock-in. Every line of code must have a purpose -- no speculative code, no premature abstractions.

For full development and testing standards, see `.claude/memory/AGENT_RULES.md`.
For detailed docs, see `docs/KNOWLEDGE_BASE.md`.
