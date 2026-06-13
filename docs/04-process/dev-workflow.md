# Development Workflow

## Principles

- **POC first.** Validate logic with a ~15min proof-of-concept before building. Cover happy path + common edges. POC works -> design properly -> build with tests. Never ship the POC.
- **Build incrementally.** Small independent modules. One piece at a time, each works alone before integrating.
- **Zero required deps.** Vanilla Node.js -> standard library -> external (only when stdlib can't do it in <100 lines).
- **Simple > clever.** Readable code a junior can follow beats elegant code that requires a PhD to debug.

## Stack

| What | Choice |
|---|---|
| Runtime | Node.js >= 18 |
| Language | Pure JS + JSDoc + `types.d.ts` (zero build step) |
| Test framework | `node:test` (built-in) |
| Source layout | `src/` flat, prefix naming (`provider-openai.js`, `store-sqlite.js`) |
| License | MIT |

## Running tests

```bash
# Unit tests (fast, no API keys)
node --test test/*.test.js

# Integration tests (requires OPENAI_API_KEY, ANTHROPIC_API_KEY, Ollama)
node --test test/integration*.test.js

# All tests
node --test test/**/*.test.js
```

Integration tests use env vars. Ollama runs via podman on this machine.

## POC workflow

1. Build throwaway POC validating the core idea
2. POC passes -> design the real interface
3. Build with tests (unit + integration)
4. Record what was built in `CHANGELOG.md` (and the PRD §22 decisions log if a design call was made)
