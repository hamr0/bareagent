# Implementation Log

What was built, in what order, and what was learned.

---

## POC 1: Loop + Providers (2026-02-17)

Built `loop.js`, `retry.js`, `provider-openai.js`, `provider-anthropic.js`, `provider-ollama.js`. Validated with real API calls against all three providers. Multi-round tool calling works. Loop never throws — all errors returned in `result.error`.

Key learnings:
- Anthropic requires strict message alternation (user/assistant/user/assistant) — provider normalizes this internally
- Tool call format normalization between OpenAI and Anthropic is the hardest part
- `chat()` stateful mode is ~15 lines on top of `run()`

## POC 2: Planner + StateMachine (2026-02-17)

Built `planner.js` and `state.js`. Planner uses structured output prompting to get JSON step DAGs from the LLM. StateMachine is a Map + transition table + EventEmitter.

Key learnings:
- LLM produces valid plans with clear dependency chains
- Topological sort needed to execute steps in dependency order

## POC 3: Checkpoint (2026-02-17)

Built `checkpoint.js`. Human-in-the-loop via CLI readline. Loop checks `shouldAsk()` before each tool call, pauses if needed.

Key learnings:
- Simple callback pattern works well — `send` + `waitForReply`
- "no" response aborts the tool call, loop continues without crashing

## POC 4: Memory + Stores (2026-02-18)

Built `memory.js`, `store-sqlite.js`, `store-jsonfile.js`. SQLite FTS5 with BM25 ranking. JSON file store with substring matching as zero-dep fallback.

## POC 5: Stream + CLI (2026-02-18)

Built `stream.js`, `transport-jsonl.js`, `bin/cli.js`. JSONL events on stdout, one JSON object per line.

## POC 6: Scheduler (2026-02-18)

Built `scheduler.js`. Cron expressions via `cron-parser`, relative times (`2h`, `30m`), persisted jobs to JSON file. Re-entry guard prevents overlapping job runs.
