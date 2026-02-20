# bare-agent

Lightweight, composable agent orchestration library. ~1500 lines, 0 required deps, MIT.
Node.js >= 18, pure JS + JSDoc, `node:test` for testing. Flat `src/` layout with prefix naming.

## Components

| Component | File | Purpose |
|-----------|------|---------|
| Loop | src/loop.js | Core think/act/observe cycle. Never throws, errors in result.error |
| Planner | src/planner.js | Goal -> step DAG via LLM structured output |
| StateMachine | src/state.js | Task lifecycle (pending/running/done/failed/waiting/cancelled) |
| Scheduler | src/scheduler.js | Time-triggered turns (cron + relative) |
| Checkpoint | src/checkpoint.js | Human-in-the-loop approval gate |
| Memory | src/memory.js | Thin wrapper delegating to swappable store |
| Stream | src/stream.js | Structured event emitter |
| Retry | src/retry.js | Backoff wrapper for async functions |

Providers: OpenAI (src/provider-openai.js), Anthropic (src/provider-anthropic.js), Ollama (src/provider-ollama.js)
Stores: SQLiteStore (src/store-sqlite.js, peer dep: better-sqlite3), JsonFileStore (src/store-jsonfile.js, zero deps)
Exports: `bare-agent` (components), `bare-agent/providers`, `bare-agent/stores`

## Commands

```bash
npm test                                    # Unit tests (fast, no keys)
node --test test/integration*.test.js       # Integration (needs API keys)
node --test test/e2e.test.js                # E2E composition tests
```

## Key Patterns

- Loop builds messages in OpenAI format internally; each provider normalizes
- All provider.generate() returns `{ text, toolCalls, usage }`; all stores implement `store/search/get/delete`
- Components are independent: Memory doesn't know Loop, Scheduler doesn't know Planner

## Dev Rules

**POC first.** Always validate logic with a ~15min proof-of-concept before building. Cover happy path + common edges. POC works -> design properly -> build with tests. Never ship the POC.

**Build incrementally.** Break work into small independent modules. One piece at a time, each must work on its own before integrating.

**Dependency hierarchy -- follow strictly:** vanilla language -> standard library -> external (only when stdlib can't do it in <100 lines). External deps must be maintained, lightweight, and widely adopted. Exception: always use vetted libraries for security-critical code (crypto, auth, sanitization).

**Lightweight over complex.** Fewer moving parts, fewer deps, less config. Simple > clever. Readable > elegant.

**Open-source only.** No vendor lock-in. Every line of code must have a purpose -- no speculative code, no premature abstractions.

For full development and testing standards, see `.claude/memory/AGENT_RULES.md`.
For detailed docs, see `docs/KNOWLEDGE_BASE.md`.
