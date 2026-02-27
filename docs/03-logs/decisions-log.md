# Decisions Log

Significant design decisions and their rationale.

---

## 2026-02-17: Package name — `bareagent`

Checked alternatives (`microagent`, `agent-core`, `agentloop` — all taken or bloated). `bareagent` communicates the philosophy: bare metal, no bloat. Reserved on npm as `bareagent@0.1.0`.

## 2026-02-17: Cut Router and Tool.define from v0.1

Router is 40 lines most users don't need (single-agent setups skip it). Tool.define is premature sugar — the OpenAI function calling format is already the standard. Both can be added in v0.2 if demand appears.

## 2026-02-17: Cut JSON-RPC transport from v0.1

JSONL on stdin/stdout covers the cross-language story. JSON-RPC adds HTTP server complexity for a use case nobody will hit in v0.1.

## 2026-02-17: Flat directory structure

All source in `src/` with prefix naming (`provider-openai.js`, `store-sqlite.js`) instead of nested `providers/`, `stores/` directories. For a library this small, flat is clearer.

## 2026-02-17: Pure JS + JSDoc, no TypeScript

Zero build step. Ship `.js` files directly. JSDoc + `types.d.ts` gives IDE support without compilation.

## 2026-02-17: Two stores, not three

SQLite (real store) + JSON file (zero-dep fallback). In-memory Map is only useful for tests, and tests can use JSON file.
