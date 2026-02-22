# bare-agent

Lightweight, composable agent orchestration library. ~1800 lines, 0 required deps, MIT.
Node.js >= 18, pure JS + JSDoc, `node:test` for testing. Flat `src/` layout with prefix naming.

## Components

| Component | File | Purpose |
|-----------|------|---------|
| Loop | src/loop.js | Core think/act/observe cycle (throwOnError: true by default) |
| Planner | src/planner.js | Goal -> step DAG via LLM structured output |
| runPlan | src/run-plan.js | Execute step DAG with wave-based parallelism |
| StateMachine | src/state.js | Task lifecycle (pending/running/done/failed/waiting/cancelled) |
| Scheduler | src/scheduler.js | Time-triggered turns (cron + relative) |
| Checkpoint | src/checkpoint.js | Human-in-the-loop approval gate |
| Memory | src/memory.js | Thin wrapper delegating to swappable store |
| Stream | src/stream.js | Structured event emitter |
| Retry | src/retry.js | Backoff with jitter for async functions |
| CircuitBreaker | src/circuit-breaker.js | Per-key circuit breaker (closed/open/half-open) |
| JsonlTransport | src/transport-jsonl.js | JSONL output to writable stream (pipe-friendly) |
| Errors | src/errors.js | BareAgentError, ProviderError, ToolError, TimeoutError, ValidationError, CircuitOpenError, MaxRoundsError |

Providers: OpenAI, Anthropic, Ollama, CLIPipe, Fallback -- each in `src/provider-*.js`
Stores: SQLiteStore (peer dep: better-sqlite3), JsonFileStore (zero deps) -- each in `src/store-*.js`
Tools: BrowsingTools (tools/browse.js, optional dep: barebrowse)

## Exports

| Entry point | Contents |
|-------------|----------|
| `bare-agent` | Components + error classes + CircuitBreaker |
| `bare-agent/providers` | All providers including Fallback |
| `bare-agent/stores` | SQLite + JsonFile |
| `bare-agent/transports` | JsonlTransport |
| `bare-agent/tools` | createBrowsingTools |

## Commands

```bash
npm test                                    # All tests (unit + integration + e2e)
node --test test/integration*.test.js       # Integration only (needs API keys)
node --test test/e2e.test.js                # E2E composition tests
```

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
