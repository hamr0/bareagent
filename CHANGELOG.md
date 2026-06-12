# Changelog

All notable changes to bare-agent are documented here. Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **`Loop({ assemble })` — a context-assembly chokepoint.** A new optional hook, `assemble(msgs, ctx) => msgs`, runs before each provider call and returns the message *view* to send that round — the seam a context-engineering library (e.g. litectx) plugs into to recall, compress, trim, or reorder the context window mid-loop. The canonical transcript (`result.msgs`) is never mutated, so it stays complete and correct. **Fail-open:** a thrown error degrades to sending the full context (a context-optimizer bug must not halt the agent); a thrown `HaltError` is a governance exit and propagates (same contract as `onLlmResult`). `ctx` is the per-run opaque blob (`run(msgs, tools, { ctx })`), the same object forwarded to `policy`; a CE consumer reads `ctx.task` and `ctx.budget`. Emits a `loop:assemble` stream event. Additive and **inert when unset** — existing behavior is byte-identical. This is RT-1 of the litectx-runtime seam set (`docs/01-product/litectx-runtime-prd.md`).
- **RT-3 litectx-as-Store mount — example + integration test.** `examples/litectx-as-store.mjs` shows the one-line swap from the zero-dep `JsonFileStore` to litectx's ranked, graph-aware recall (the host code never changes); `test/litectx-store.test.js` proves bareagent's `Memory` + the `Store` socket accommodate litectx's `liteCtxAsStore` adapter shape — async delegation, adapter-minted ids, and verbatim round-trip of arbitrary metadata (the drop-in promise) — without importing litectx. The `Store` socket and `Memory` wrapper are unchanged; this is the doc/example/test half bareagent owns for RT-3 (litectx ships the adapter).
- **`toUnits` / `fromUnits` / `unitAssembler` (`src/context-units.js`) — the msgs⇄units adapter for `assemble`.** Lets a consumer work over a neutral unit `{ id, role, content, kind, pinned, atomic, tokensApprox }` (the frozen litectx CE-PRD §8.2 socket) instead of raw provider messages. `unitAssembler(assemble(units, ctx) => units)` wraps a unit-level verb into the Loop's msgs-level seam. bareagent owns the grammar: each assistant tool-call + its result(s) becomes one **`atomic`** unit (drop a whole unit, never split a pair), `pinned` units (system prompt, first user/task turn) never drop or reorder, and a final **pairing seatbelt** guarantees a provider-valid sequence on the wire. The consumer owns content + relevance (SELECT / COMPRESS / fit-to-`ctx.budget`). Transcript-derived units carry `kind: null` (the memory-kind enum classifies nodes, not live turns).
- **RT-4 MCP mount — `liteCtxMcpBridgeConfig` + config-driven `cfg.mcp` for spawned children.** A new helper (`tools/litectx-mcp.js`, exported from `bare-agent/tools`) builds a curated `.mcp-bridge.json` that mounts litectx's `litectx-mcp` server **read-only on the child's own db**: `recall · get · impact · recent` allowed; `remember · forget` denied unless `{ writable: true }` (writes still land in the child's own `--root` db); `index · promotions` always denied. It encodes the agreed read-only default (PRD §4.2) so a parent composing a child's toolbox can't fat-finger a write verb into the allow-list. **It imports nothing from litectx** — pure config curation, the dependency direction stays one-way. `bin/cli.js` gained `cfg.mcp` so a spawned child (`bin/cli.js --config`) can mount MCP servers — an inline bridge config or a directory-confined `{ bridgePath }` — with the tools joining the set **before** gating, so MCP tools traverse the same `policy` as native ones; the bridge is closed on exit. Also wired the **`clipipe` provider** in the CLI (`cfg.provider: 'clipipe'` + `command`/`args`), enabling keyless children that pipe to any local LLM CLI. Validated end-to-end against the **real** `litectx-mcp` binary: read-only curation, own-db `recall` returning real hits from an indexed db, `{ writable: true }` `remember` persisting + recalling back, and two-root physical isolation (one child never sees another's writes) — all driven through the bridge (`test/litectx-mcp-mount.test.js`, gated on `litectx`/`litectx-mcp` being on PATH; `test/litectx-mcp-spawn.test.js` proves the real `spawnChild → cli.js` path). This is RT-4 of the litectx-runtime seam set; zero litectx code.

## [0.12.2] — 2026-06-01

### Fixed

- **`examples/` is now shipped in the npm tarball.** The directory was missing from the `files` array, so the runnable reference scripts never reached `node_modules/bare-agent/`. This left the same broken-reference gap 0.12.1 closed for the integration guide: `bareagent.context.md` (now shipped) points to `examples/wake.sh` as "the runtime half of `createDeferTool`" — a functional component of the defer feature, not just a demo — yet the script itself wasn't installed. Added `examples/` to `files` (~30 kB; `.mcp-bridge.json` is gitignored and never shipped).

### Added

- **`examples/README.md`** — a directory-level index mirroring the README example table, so the folder is self-describing when browsed in `node_modules/` or on GitHub.

## [0.12.1] — 2026-05-30

### Fixed

- **`bareagent.context.md` is now shipped in the npm tarball.** The file was missing from the `files` array in `package.json`, so it never reached `node_modules/bare-agent/` on install — even though the README quick-start and the integration story both instruct agents to read it from there. The advertised "point your agent at the context doc" onboarding was broken on a clean install (only `README.md` shipped). Added to `files`; `npm pack` now includes the 66.9 kB guide. (Thanks to the adopter who flagged it.)

### Added

- **Provider `*Provider` aliases.** `require('bare-agent/providers')` now exports both the canonical short names (`OpenAI`, `Anthropic`, `Ollama`, `CLIPipe`, `Fallback`) **and** matching class-name aliases (`OpenAIProvider`, `AnthropicProvider`, `OllamaProvider`, `CLIPipeProvider`, `FallbackProvider`). Previously only the short names were exported, so the natural `const { OpenAIProvider } = require('bare-agent/providers')` — reaching for the name shown in source and stack traces — silently returned `undefined` and failed at `new OpenAIProvider()` with "is not a constructor." Both destructures now resolve to the same class. Non-breaking.

### Changed
- **CI:** the publish workflow now polls the npm registry for ~2 min (was ~15s; `--prefer-online` skips npm's view cache) and accepts an `exit 0` publish even if the registry hasn't reflected it yet, so a successful-but-slow-to-reflect publish no longer reports a false failure.

### Tooling

- **`build:types` is now idempotent.** A new `prebuild:types` step (`scripts/clean-types.js`, pure Node, zero deps) removes previously-generated `.d.ts` under `src/`/`tools/`/`bin/` + the root `index.d.ts` before `tsc` re-emits them. Without it, a second local `build:types` (or a publish from a tree with stale declarations) failed with TS5055 ("would overwrite input file"), since `tsc` treats a co-located `.d.ts` as a declaration input. Hand-written `types/*.d.ts` are left untouched.

## [0.12.0] — 2026-05-29

### Added

- **TypeScript declarations (`.d.ts`) generated from JSDoc.** Consumers now get full type information and editor autocomplete. Types are emitted by `tsc` from the existing JSDoc (`npm run build:types`), shipped to npm via a `prepublishOnly` hook, and resolved through `types` conditions on every `exports` subpath (`.`, `./errors`, `./providers`, `./stores`, `./transports`, `./tools`, `./mcp`, `./bareguard`) plus a top-level `types` field. Generated `.d.ts` are git-ignored (built on publish); hand-written shared shapes live in `types/` and ship with the package.
- **`types/index.d.ts`** — shared cross-cutting type shapes (`Provider`, `Message`, `ToolDef`, `ToolCall`, `Usage`, `GenerateResult`, `Store`, `Ctx`) referenced from JSDoc across the codebase. **`types/shims.d.ts`** — ambient `any` module declarations for deps that ship no types (`bareguard`, `better-sqlite3`, `barebrowse`, `baremobile`, `cron-parser`), so the typecheck runs without installing native/optional modules.

### Tooling

- **`publish.yml` is now manual-only (`workflow_dispatch`) — npm OIDC trusted publishing with provenance, idempotent, and verifies the registry end-state.**
- **CI typecheck guardrail.** New `.github/workflows/ci.yml` runs `npm run typecheck` (`tsc --checkJs`) + the test suite on every push and PR — previously nothing ran on PRs. `publish.yml` gained the same typecheck step before tests, so a type error blocks publish. `tsc` runs `checkJs` with `strictNullChecks` (full `strict` was evaluated but relaxed to null-checks-only: it caught ~95% annotation-completeness noise and ~5% genuine null-safety, which `strictNullChecks` retains). All JSDoc across `src/`, `tools/`, and `bin/` was annotated to type-check clean (JSDoc-only; no runtime behavior change).
- **New scripts:** `typecheck` (`tsc --noEmit`), `build:types` (`tsc`), `prepublishOnly` (`npm run build:types`). New dev deps: `typescript`, `@types/node`.

### Fixed

- **`src/mcp-bridge.js` — a server that fails to connect no longer leaks its child process.** When `initialize` timed out (or `tools/list` failed), the error propagated out of `connectAndListTools` *before* the spawned child was returned to the caller, so `close()` never tracked it for teardown. The orphaned child kept its stdin pipe open and prevented the host process from exiting — most visibly, it hung `node --test`'s per-file wrapper *after every test had already passed* (the full unit run never terminated). The child is now killed on any connect failure before the error is re-thrown; the full unit suite (`node --test`, 324 tests) exits cleanly.
- **`examples/wake.sh` — the first record in the defer queue is no longer silently dropped.** The status-fold ran `jq -c 'reduce inputs …'` without `-n`, so `jq` consumed the first queue line as its implicit input and folded only lines 2+. With a single pending defer — the common case — `PENDING` came back empty and the action never fired. Now `jq -n -c …` reads every record via `inputs`. Reference scheduler only; the library's own `readQueue` in `tools/defer.js` uses a separate JS fold that was already correct.
- **`src/bareguard-adapter.js` — `filterTools` calls `gate.allows` through a `gate`-bound reference.** Type-annotation work flagged the unbound-method usage, so `gate.allows` is now bound to the Gate. Runtime behavior is unchanged: the prior `t => gate.allows(t.name)` was a *method* call that already preserved `this`, so it never crashed — this is a type-safety refactor, not a bug fix. (An earlier draft of this entry, and the commit message that introduced it, overstated it as a crash fix; corrected here after empirical re-test.)

## [0.11.0] — 2026-05-23

**Security hardening pass.** A `/security` audit + empirical stress-testing (each finding reproduced against the real code with mock providers, then re-verified after the fix) surfaced one governance-bypass plus a spread of fail-open defaults. All are now fail-closed. Three carry an intentional, consumer-visible behavior change — see **Changed** — each with an explicit opt-out. Full non-`src` regression suite green (324 tests).

### Security

- **`bin/cli.js` — config-mode is now fail-closed without a gate.** Previously a config with no `gate` block ran with `policy=null` — no allowlist, budget, depth, or rate limits — and the LLM-callable `spawn` tool only ever passes the parent gate a *path string*, so a gate-less child config silently escaped all governance (and recursive `spawn` was unbounded, since `maxDepth` is only enforced by a wired Gate). The CLI now refuses such a config (`exit 1`). The prior `cfg.gate`-set-but-wiring-failed fail-closed (0.10.3) only covered the case where a gate was *declared*; this closes the no-gate case it left open. Opt out with `"ungoverned": true`.
- **`bin/cli.js` — `gate.humanChannel` string is confined to the config directory.** A string `humanChannel` is `require()`d; the resolved path is now rejected if it escapes the config dir (e.g. `"../../evil.js"`), so a JSON config (data) can no longer load arbitrary code that would execute *outside* the gate.
- **`src/loop.js` — Checkpoint approval is fail-closed.** The human-approval gate previously denied only on empty / `"no"` / `"n"` and **approved every other reply** — including `"denied"`, `"wait"`, or a non-string (which threw `.toLowerCase()` out of `run()`). It now proceeds **only** on an explicit affirmative (`yes`/`y`/`approve`/`approved`, trimmed, case-insensitive); anything else denies.
- **`src/provider-*.js` — upstream error body no longer attached by default.** On HTTP errors providers attached the full parsed response to `err.body`, so an unexpected field could leak through logs that dump the error object. `err.body` is now `undefined` by default (the API's error message still rides on `err.message`). Re-enable for debugging with `new XProvider({ exposeErrorBody: true })`.
- **`tools/shell.js` — `shell_grep` rejects catastrophic-backtracking patterns.** JS `RegExp` has no execution timeout and grep runs the pattern over file content on the main thread, so a nested-unbounded-quantifier pattern (e.g. `(a+)+`) would block the whole event loop. Such patterns are now rejected before compilation (escaped literals like `(\+)+` are correctly exempted).
- **`src/mcp-bridge.js` — opt-in `confirmServer` vetting.** Connecting to an MCP server runs its `command`, and discovery reads configs from the cwd (a `.mcp.json` in an untrusted repo) as well as home/IDE configs. Pass `confirmServer(name, def) => boolean` to vet each server **before its command is spawned**; a throw fails closed. Default is unchanged (all discovered servers trusted) — flipping it would break the bridge's core discover-and-connect behavior.

### Changed

- **CLI config-mode requires a `gate`.** A config with no `gate` is refused; set `"ungoverned": true` to explicitly run without governance (warns on stderr). Existing configs that already declare a gate (e.g. `examples/orchestrator/`) are unaffected.
- **Checkpoint approves only on an explicit affirmative.** Transports whose `waitForReply` returned a non-`yes` affirmative (e.g. `"ok"`, `"sure"`) now read as a deny — return `"yes"`/`"y"`/`"approve"`.
- **Provider `err.body` is omitted by default** — pass `exposeErrorBody: true` to restore the pre-0.11 behavior.

### Added

- **`createMCPBridge({ confirmServer })`** — see Security above.
- **Provider `{ exposeErrorBody }` option** (OpenAI / Anthropic / Ollama).
- **CLI `"ungoverned": true`** config flag — explicit opt-out of the new fail-closed gate requirement.

### Documentation

- **`src/store-jsonfile.js`** — documented the scaling ceiling (O(n) substring scan + whole-file rewrite per write) in the class JSDoc, pointing write-heavy / large-memory users at `SQLiteStore`; added a one-time runtime warning past 10k entries.
- **PRD §17 "Future / Deferred Features" + §17.1 "Lightweight inter-agent message signing (signed A2A)."** (previously unreleased) Parks zero-infra Ed25519 sign/verify of the canonical A2A request body as a *deferred — YAGNI until bare-agent talks to external peers* feature. Borrows only the `X-DID-Signature` slice of [bindu](https://github.com/GetBindu/bindu)'s mTLS + OAuth2 + DID stack (rejecting the infra): peer authentication + message integrity for A2A over §5.3's transport — explicitly **not** confidentiality/TLS, **not** authorization (that stays in bareguard, which authorizes the action not the actor), **not** app/user auth (§9 unchanged). Cross-references bareguard's `docs/identity-and-the-gate.md`.
- **`bareagent.context.md`** — documented the fail-closed Checkpoint approval, CLI gate requirement, `exposeErrorBody`, and `confirmServer`.

## [0.10.4] — 2026-05-19

**Examples audit + new replay-job POC.** No code change to `src/` — examples directory cleaned up post the v0.8 → v0.10 governance migration (mcp-gov retired, bareguard owns gating). One new POC added to demonstrate supervised replay as a composition pattern on top of barebrowse + Loop + Memory; not promoted to a core component.

### Added

- **`examples/replay-job.js`** — supervised-replay POC for repeatable browser jobs. Record once with the LLM driving (free reasoning, captures `{intent, tool, args}` per step into `.jobs/<name>.json`), then replay against fresh snapshots with the LLM acting only as a locator (one structured-output call per ref-bearing step: "map this intent to a ref in this snapshot, or return null"). On locator miss, falls back to full Loop reasoning from that point and splices the new sub-trace into the saved trace — that's the self-healing path. The example header inlines the named next-steps (fingerprint fast-path, postState assertion, trace-confidence, Scheduler hookup) so the optimization path is legible without bloating the file. Composes only existing primitives (Loop, Memory-style JSON store, barebrowse tools) — no new `src/` surface.
- **README "Examples" section** — six-row table between Recipes and Cross-language usage. One-line-per-example with what it demonstrates. Earns examples a first-class entry on the npm landing page, not just a `tree` listing.
- **`bareagent.context.md` "Examples" subsection** (between Production usage and Gotchas) — named pointers with recipe cross-refs so an LLM reading the codebase to answer "how do I demonstrate X" lands on the right file.
- **`.gitignore`** — added `.jobs/` (replay-job's trace store, written at record time, sibling of `.barebrowse/` and `.mcp-bridge.json`).

### Removed

- **`examples/mcp-bridge-gov.js`** — superseded and unrunnable. Used a hard-coded absolute path (`/home/hamr/PycharmProjects/mcp-gov/...`) to a retired project, so it never ran on anyone else's machine. The concept it demonstrated (per-server, per-operation MCP gating) is now expressed natively via `wireGate(gate).policy` + `tools.denyArgPatterns: { mcp_invoke: [...] }` — see `examples/with-bareguard.mjs` (canonical bareguard wiring) and `bareagent.context.md` § "MCP catalog: bulk vs metaTools" for the bulk-vs-metaTools governance asymmetry.

### Documentation

- **Examples audit** (verdict, not just the diff): of the six surviving entries, all pull weight — `with-bareguard.mjs` is the gov reference, `mcp-bridge-poc.js` is the bridge entry-point, `mcp-bridge-concurrent.js` is the soak test, `orchestrator/` is the multi-agent reference (its own README already documents the `cfg.gate` wiring), `wake.sh` + `wake.md` are Defer's runtime companion, `replay-job.js` is the new composition POC. No further deletions warranted.
- **PRD (`docs/01-product/prd.md`) intentionally not updated** — it's a design doc covering components, providers, consumption modes, data formats, and package structure. It has no `examples/` references today and adding one is out of scope; runnable scripts are documented in README + context.md where adopters actually look.

## [0.10.3] — 2026-05-18

**0.10.3 hardening pass.** Code-review surfaced one critical regression in `bin/cli.js` (still on the deprecated `wrapTools` path → every spawned child agent lost LLM-cost recording AND printed the deprecation warning AND silently ran ungoverned when bareguard wiring failed) plus a clutch of loose ends: `HaltError` mid-round left dangling `tool_calls` in the returned `msgs` (OpenAI protocol violation if reused), `halt:null` for adopters who throw `HaltError` without a `rule`, `JSON.stringify` of circular tool results crashed `onToolResult`, current Claude 4.x model IDs missing from the cost table, `filterTools` serialized on large MCP catalogs, JSDoc drift, `HaltError` storing `rule`/`decision` in two places. All addressed without API breakage.

### Fixed

- **`bin/cli.js` — child agents now use the BA1 seam.** Migrated off deprecated `wrapTools` to `policy + onLlmResult + onToolResult + filterTools` on `new Loop({...})`. Every `spawn`-ed child now records LLM cost into bareguard's audit (was silently dropped), threads `ctx` to `gate.record`, and stops printing the wrap deprecation warning on every first tool call.
- **`bin/cli.js` — fail-closed on bareguard wiring failure.** When `cfg.gate` is set but `Gate` init throws, the CLI now `process.exit(1)` with a `Refusing to run ungoverned` stderr line instead of continuing with `policy=null`. Closes a silent-escape hatch where a misconfigured gate produced an unmitigated child agent.
- **`src/loop.js` — halt no longer leaves dangling `tool_calls` in `msgs`.** New `sealDanglingToolCalls()` walks the last assistant `tool_calls` array and appends a synthetic `[halted:<rule>]` `role:'tool'` reply for every id without a matching tool result. The returned `result.msgs` is now a valid OpenAI transcript safe to feed back into another provider call — even when halt fires mid-way through a multi-tool round. `[HALT:]` still never reaches the LLM (the existing contract is unchanged; synthetic replies use `[halted:]` lowercase to keep that signal distinct).
- **`src/loop.js` — `halt:null` → `halt:unknown`.** When adopters throw `new HaltError('msg')` without a `rule`, the returned `error` string is now the stable `halt:unknown` instead of the literal `halt:null`. Same change in the `loop:done{rule}` event and `_reportError('halt', ..., {rule})` extra.
- **`src/bareguard-adapter.js` — `safeStringify` in `onToolResult` (and `wrapTool` shim).** Replaces raw `JSON.stringify(result)` which threw on circular tool results and returned `undefined` for function/bigint results — the throw then surfaced as a `loop:error{source:'onToolResult'}` for what was really a serialization quirk. Falls back to `String(value)` on `JSON.stringify` throw or `undefined` result.
- **`src/errors.js` — `HaltError` no longer stores `rule`/`decision` twice.** Previously written to both `this.decision`/`this.rule` AND `this.context.decision`/`this.context.rule`. Public surface is unchanged (`err.rule`, `err.decision`); `err.context` is now the adopter-supplied context only.

### Changed

- **`src/loop.js` — `COST_PER_1K` table refreshed for Claude 4.x current generation.** Added `claude-opus-4-7` ($0.015/$0.075), `claude-sonnet-4-6` ($0.003/$0.015), `claude-haiku-4-5` alias (already had the dated `claude-haiku-4-5-20251001`). Without this, every Claude call in the field flowed through `_default` rates and `onLlmResult` reported inaccurate `costUsd` into bareguard's budget. Last-updated comment bumped to 2026-05-18.
- **`src/bareguard-adapter.js` — `filterTools` is now parallel.** Replaced sequential `for (await gate.allows(...))` with a `Promise.all` map. Noticeable startup-time win for large MCP catalogs (50+ tools); identical semantics since `gate.allows` is config-driven and pure.
- **`src/bareguard-adapter.js` — `warnedWrap` hoisted to module scope.** Was per-`wireGate`-call, so each spawned subprocess re-armed the deprecation warning. Now one warning per process across all `wireGate` calls. (Moot for `bin/cli.js` after the migration above, but still right.)

### Added

- **`test/integration-bareguard.test.js` — three new cases.**
  - **`policy deny does not fire onToolResult`** — locks in the no-double-record contract (gate.check already saw the attempt; bareguard records denies internally).
  - **`halt seals dangling tool_calls with synthetic [halted] replies`** — uses a policy that halts on the second tool of a multi-tool round, asserts c1 has its real reply, c2 has a `[halted:<rule>]` synthetic, every assistant `tool_call.id` is covered.
  - **`HaltError without a rule yields error: "halt:unknown"`** — bareguard decision with `severity:'halt'` and no `rule` resolves to the `halt:unknown` token rather than `halt:null`.

### Documentation

- **`bareagent.context.md`** updated for barebrowse v0.9.0 (no code change — `tools/browse.js` is a pass-through to `barebrowse/bareagent`). Gotcha #13 bumped from 17 to 20 core browsing tools (21 with `assess`); added `reload`, `wait_for`, `downloads`; noted `reload`/`wait_for` join the action-tool set that auto-returns a snapshot with the 300ms settle delay; noted `downloads` returns a frozen JSON snapshot of `page.downloads` (stable view, not a live reference); explained that `onDialog` is intentionally not exposed as a tool — its callback shape doesn't fit a request/response loop, so adopters drop to `import { connect }` directly or read `page.dialogLog` after the fact. Recipe 7 privacy paragraph ("18th tool" → "21st tool"). Recipe 7b CLI reference picks up `reload [--no-cache]`, a new Downloads row, and `--port=N` / `--download-path=DIR` open flags. Behavioral note (not surfaced — `[ref=N]` format unchanged): refs are now flat across all frames in the merged tree, routed to the right CDP session automatically.
- **`bareagent.context.md`** Gotcha #13 also documents `pruneMode: 'act'|'read'` on `browse` / `snapshot` — `act` (default) keeps interactive elements; pass `'read'` for paragraph-heavy pages (articles, docs, blogs). Notes the auto-hint when `act` collapses a content-heavy page.
- **`bareagent.context.md` halt-mechanics paragraphs corrected.** Two stale notes (§ "Halt decisions surface as deny strings", §error-mapping table) still claimed halts were fed to the LLM as `[HALT:]` deny strings — the v0.10.0 BA2 change made halts throw `HaltError` and Loop catches it cleanly. Both paragraphs now match the post-0.10.0 behavior. The halt-detection recipe also documents the new `halt:unknown` token and the synthetic `[halted:<rule>]` tool replies on `result.msgs`.
- **`src/loop.js`** — `Loop.run()` `@returns` JSDoc now documents `cost`, `msgs`, the `halt:<rule>` error contract, and the post-halt msgs-sealing guarantee.
- **`src/bareguard-adapter.js`** — `formatDeny` JSDoc corrected to `(decision, toolName) => string` (implementation was already passing both; doc claimed `(decision)` only). `filterTools` JSDoc cross-references the `mcp_invoke` meta-tool asymmetry: `filterTools` is bulk-only, MCP inner names must be gated via bareguard's `tools.denyArgPatterns: { mcp_invoke: [/"name":"…"/] }` (the gov surface that `src/mcp-bridge.js` already documents).

## [0.10.2] — 2026-05-12

**Bareguard 0.4.2 alignment.** Bareguard shipped both items called out in 0.10.1's known-limitations note: `limits.maxToolRounds` (sibling primitive that ticks only on non-`llm` records, no more `maxTurns: N*2` workaround) and field-shape fallback on `bashCheck` / `fsCheck` / `netCheck` (read either flat `action.cmd` or nested `action.args.cmd`/`.command`). Bareagent's `actionTranslator` snippets simplified accordingly.

### Changed

- **`bareguard` pin** — `^0.2.0 → ^0.4.2`. No bareagent code change; the new primitives are additive. 0.4.2 carries `limits.maxToolRounds`; 0.4.1 carries the field-shape fallback. Recommended: use `maxToolRounds` instead of `maxTurns * 2` for capping LLM-tool rounds.
- **README + `bareagent.context.md`** — `actionTranslator` snippets now show the verbatim `args` passthrough form (`{type:'bash', args, _ctx}`) since bareguard reads `args.command` / `args.path` directly. The pre-0.4.1 manual-hoist form (`{type:'bash', cmd: args.command}`) still works but is now optional. Wire-up example uses `limits.maxToolRounds: 20` instead of `limits.maxTurns: 20`.

### Added

- **Real-bareguard tests** for the two new primitives — `limits.maxToolRounds` halts after N tool calls (proves the counter skips `{type:'llm'}` records) and `bashCheck` activates against nested `args.command` (proves the field-shape fallback works through `actionTranslator` without re-hoisting).

## [0.10.1] — 2026-05-12

**Multis feedback patch (A7 + ergonomics).** Three seam issues surfaced during multis' bareguard-0.4 adoption: `HaltError` was unreachable from the public API, `wireGate`'s action shape didn't compose with bareguard's `bash`/`fs` primitives, and `Loop({maxRounds: N})` (removed in v0.8) was silently ignored instead of erroring.

### Added

- **`HaltError` exported from `bare-agent`** and reachable via `require('bare-agent/errors')`. Adopters whose policy shim throws `HaltError` (so Loop's `instanceof HaltError` catches it cross-module) no longer need to `require(path.join(path.dirname(require.resolve('bare-agent')), 'src', 'errors.js'))`. Identity-equal class across module boundaries is now guaranteed.
- **`./errors` and `./package.json` subpath exports** in `package.json` — `require('bare-agent/errors')` and `require('bare-agent/package.json')` work from outside the package.
- **`wireGate(gate, { actionTranslator })`** (`src/bareguard-adapter.js`) — `(toolName, args, ctx) => action` lets adopters reshape the action passed to `gate.check` and `gate.record`. Critical for bareguard's `bash` / `fs` / `net` primitives which require specific shapes (`{type:'bash', cmd:...}`, `{type:'read', path:...}`) at the top of the action, not nested under `args`. Default unchanged — adopters using only `tools.denylist` / `tools.allowlist` (which read `action.type`) need no change.
- **`defaultActionTranslator`** exported from main and `bare-agent/bareguard` — adopters can compose custom translators on top of the default (`{type: toolName, args, _ctx: ctx ?? null}`).

### Changed

- **`Loop({ maxRounds })` throws** with a migration message pointing at bareguard's `limits.maxTurns`. `maxRounds` was removed in v0.8 when single-gate governance landed and has been silently ignored since — multis flagged the silent-ignore as a wasted migration cycle.

### Documentation

- README and `bareagent.context.md` get a note about the `actionTranslator` extension point and when adopters need it (any rule that uses `bash` / `fs` / `net` primitives).

### Known limitations surfaced (bareguard-side, not bareagent)

- **`limits.maxTurns` semantics**: bareguard ticks on every `gate.record` (LLM + tool), so 1 LLM-tool round counts as 2 turns. Multis worked around it by doubling the cap. Worth a sibling `limits.maxToolRounds` (counts only tool records) or a README clarification on bareguard's side — not bareagent's fix.
- **bash/fs primitive activation**: bareguard's `bashCheck` and `fsCheck` only fire when `action.type === 'bash'` / `'read'` / `'write'`. Bareagent's default `{type: toolName}` shape disables both. Either layer could move — bareagent shipped the `actionTranslator` escape hatch this release; bareguard could optionally widen primitives to also read `action.args.cmd` / `action.args.path`.

## [0.10.0] — 2026-05-12

**Governance seam reshaped (BA1–BA5).** `wireGate` now exposes callbacks Loop calls inline (`onLlmResult`, `onToolResult`) instead of wrapping tools post-hoc, so `gate.record` finally sees both LLM cost *and* `ctx`. Halt-severity decisions throw a typed `HaltError` and Loop exits cleanly — they never leak as `[HALT: ...]` strings to the LLM. Old `wrapTool` / `wrapTools` retained as deprecation shims with a one-shot warning; removal target 1.0.

### Added

- **`Loop({ onLlmResult, onToolResult })`** (`src/loop.js`) — two new constructor callbacks. `onLlmResult({model, provider, usage, costUsd, durationMs, ctx})` fires after every successful `provider.generate`; `onToolResult({name, args, result, error, durationMs, ctx})` fires after every `tool.execute` (success and failure). Callback errors route through `_reportError` (loop:error + onError) but never kill the loop. Both receive the per-run `ctx` opaque blob so per-principal accounting reaches `gate.record`.
- **`HaltError` in `src/errors.js`** — extends `BareAgentError` with `{ rule, decision }`. Signals a clean governance exit. Loop's outer handler catches it, emits `loop:error{source:'halt'}` + `loop:done{halted:true, rule, cost}`, calls `onError`, and returns `{ error: 'halt:<rule>' }` — **even with `throwOnError:true`** (halt is a governed exit, not an exception).
- **`wireGate(gate, { formatDeny })`** (`src/bareguard-adapter.js`) — adopters customise the deny string fed to the LLM (localize, strip the bracketed prefix). Halt bypasses this (uses `HaltError`).
- **`wireGate(gate).filterTools(tools)`** — async catalog pre-filter via `gate.allows`. Drops denied tools so the LLM never sees them. No audit, no record.
- **`wireGate(gate).onLlmResult` / `.onToolResult`** — forwards to `gate.record` with action shapes `{type:'llm', args:{model, provider}, _ctx}` and `{type:<name>, args, _ctx}` respectively. **Fixes silent budget undercount** for token-heavy / tool-light workloads (every chatbot): pre-BA1, `budget.maxCostUsd` only saw tool cost and was effectively a lie for LLM-only loops.
- **`test/integration-bareguard-real.test.js`** — 4-test smoke suite against a real bareguard 0.2 `Gate` (not the mock contract). Asserts LLM cost lands in the audit JSONL as `{type:'llm'}` with positive `costUsd` and `tokens=2000` (the pre-BA1 silent bug), halt fires cleanly across multi-round runs, no `[HALT:]` strings ever appear in tool messages, `filterTools` honors `tools.denylist`.

### Changed

- **`wireGate(gate)` return shape** — now `{ policy, onLlmResult, onToolResult, filterTools, wrapTool, wrapTools }`. Existing adopters using `wrapTool` / `wrapTools` keep working with a one-shot console deprecation warning. Migration: replace `wrapTools(tools)` at `loop.run()` with `onToolResult` / `onLlmResult` in `new Loop({...})` to pick up LLM-cost recording and `_ctx` threading.
- **`wireGate` policy halt path** — now throws `HaltError` instead of returning `[HALT: <rule>] <reason>`. Old behavior leaked the halt string to the LLM as a tool message; the LLM would try to recover, burning more tokens past the cap that just tripped. Loop's outer handler catches the typed error and exits cleanly.
- **`bareagent.context.md`** — wireGate section, examples, and entry-points list updated to reflect the new return shape; the wrapTool examples replaced with `onLlmResult` / `onToolResult` wiring.
- **`README.md`** — new "Recipes" section: wire-up, owner/role bypass with audit/budget caveat, custom deny strings via `formatDeny`, halt detection in app code.
- **`CLAUDE.md`** — bareguard adapter table row updated to the BA-era shape; Errors row mentions `HaltError`.

### Fixed (test flakes)

- **`test/mcp-bridge.test.js`** — two tests flaked under parallel-test load when the mock MCP server failed to respond to `initialize` in time, leaving `freshTools.size === 0` so the bridge file never wrote; subsequent `readFileSync` ENOENTed. Added a `freshBridge()` retry helper (3 attempts) for cold-discovery tests.
- **`test/integration-mcp-bridge.test.js`** — first-run test had the same failure mode against a real `barebrowse`. Skip path widened to `bridge.tools.length === 0 || !existsSync(bridgePath)`, matching the existing "not configured" graceful-skip intent.
- **`test/scheduler.test.js`** — `overlap prevention skips job still running on next tick` raced when the wait window (120 ms) was barely longer than the handler (100 ms); a tick landing just after the handler finished could fire it again and bump `callCount` to 2. Adjusted to 100 ms wait / 300 ms handler so the assertion always runs while the handler is still in-flight. Suite stable across 30 consecutive runs.

### Compatible with bareguard 0.3.0

- **bareguard ≥0.3 adds `humanChannelTimeoutMs`** — passed through unchanged via the existing `cfg.gate` spread in `bin/cli.js` and `wireGate`'s Gate config. No bareagent code change required; users opt in by setting it on the gate config. Context doc + Checkpoint vs humanChannel section updated to mention the new option.

### Fixed

- **`Loop.chat()` dropped tool-call context between turns** (`src/loop.js`) — `run()` accumulated tool messages in a local `msgs` array that wasn't propagated back to `_history`. On the next `chat()` call the LLM received no record of which tools were called or what they returned. `run()` now returns `msgs` in its result; `chat()` syncs `_history` from `result.msgs` (stripping the leading system message when one is present) so every tool call, result, and assistant reply survives to the next turn.
- **MCP bridge wiped config on failed TTL refresh** (`src/mcp-bridge.js`) — if `discoverServers()` returned an empty map during a TTL refresh (IDE config temporarily unavailable, network mount, moved file), `mergeBridgeConfig` received an empty map and wrote `{ servers: {} }` to disk, destroying all server definitions and user-curated allow/deny settings. The bridge now only calls `mergeBridgeConfig` + `writeBridgeConfig` when at least one server connected successfully (`freshTools.size > 0`); on a fully-empty discovery the existing config is retained.
- **Scheduler job permanently locked when `onError` throws** (`src/scheduler.js`) — `_running.delete(job.id)` was not in a `finally` block. If the `onError` callback itself threw, the job was stuck in `_running` forever and never fired again until process restart. Fixed with `try/finally`; `onError` is also now wrapped in its own try/catch so a throwing callback can't escape.
- **`Retry` silently ignored `0` for `maxAttempts` and `timeout`** (`src/retry.js`) — falsy `||` checks coerced `0` to the default, making it impossible to disable retries or the per-call timeout explicitly. Both constructor and per-call options now use `!== undefined` checks, consistent with `Checkpoint`'s existing behavior.
- **`Planner` cache key collided across goals containing `|`** (`src/planner.js`) — key was `goal + '|' + context.info`, so a goal of `"buy milk"` with `context.info = "extra info"` produced the same key as `"buy milk|extra info"` with no context. Key is now `JSON.stringify({ goal, info })`, which is unambiguous.
- **MCP bridge server-name extraction truncated underscore names** (`src/mcp-bridge.js`) — `buildSystemContext` used `split('_')[0]` to recover the server name from a prefixed tool name, silently truncating names like `github_actions` to `github`. Fixed to use `indexOf('_')` (same approach as `buildMetaTools`).
- **`Math.max(...spread)` crash on large job/store files** (`src/scheduler.js`, `src/store-jsonfile.js`) — spreading a large array as `Math.max` arguments throws `RangeError: Maximum call stack size exceeded` above ~65k entries. Both files now use `reduce` to find the max id.
- **`CLIPipeProvider` JSDoc said `extraArgs` were "prepended"** (`src/provider-clipipe.js`) — the code appended them after `this.args`. Corrected the JSDoc to "appended" to match the actual (and tested) behavior.

## [0.9.0] — 2026-04-30

**Multi-agent primitives.** Three new tools — `spawn`, `defer`, and the `mcp_discover` / `mcp_invoke` meta-tool pair — paired with bareguard 0.2.0's per-family rate-cap primitives (`spawn.ratePerMinute`, `defer.ratePerMinute`, `limits.maxDepth`) so a fleet of cooperating agents stitches into one audit log, one budget, and one set of rate caps. No public API breaks; bareguard pin bumped from `^0.1.1` to `^0.2.0`.

### Added

- **`tools/spawn.js`** — `createSpawnTool({cliPath, timeoutMs, stream})` returns `{tool, spawnChild}`. The LLM-callable `tool` blocks until the child exits and returns `{text, usage, cost, error, events, exitCode, signal}`; the library `spawnChild()` form returns a handle with `wait()`, `onLine(fn)`, `kill(sig)`, and `pid` for fire-and-forget / streaming use cases. Spawns the child as `process.execPath bin/cli.js --config <path>`, threads `BAREGUARD_AUDIT_PATH` / `BAREGUARD_PARENT_RUN_ID` (inherits from `BAREGUARD_RUN_ID`) / `BAREGUARD_BUDGET_FILE` / `BAREGUARD_SPAWN_DEPTH` (incremented), and runs one JSONL channel per child — stderr is captured and re-emitted as `{type: 'child:stderr', text, ts}` events on the parent stream rather than splitting into a second channel. Default 10-min timeout with `SIGTERM → 5s grace → SIGKILL`.
- **`tools/defer.js`** — `createDeferTool({queuePath})` returns `{tool}`. Appends one `{id, ts_emitted, when, action, parent_run_id, status: 'pending'}` record per call to a JSONL queue (POSIX `O_APPEND` atomic for <PIPE_BUF). IDs are sortable: `def_<base36-9char-ts>_<hex-20char-rand>`. Validates `when` is ISO 8601 and not >60s in the past. Path resolution: `option.queuePath > BAREAGENT_DEFER_QUEUE env > ./bareagent-defers.jsonl`. Threads `parent_run_id` from `BAREGUARD_RUN_ID || BAREGUARD_PARENT_RUN_ID`. Helper exports: `readQueue` (folds latest-status-wins by id), `generateId`, `resolveQueuePath`. Two-phase governance: emit-time `gate.check` on the `defer` action; fire-time `gate.check` on the inner action when an external waker re-invokes via `bin/cli.js --config`.
- **`mcp_discover` + `mcp_invoke` meta-tools** — `createMCPBridge()` now returns `{tools, metaTools, servers, denied, systemContext, errors, close}`. Both surfaces are populated; pick one. Bulk `tools` is the existing surface (~10s of tools loaded into the LLM context). `metaTools` is a 2-tool wrapper for token-thrifty access to large catalogs: `mcp_discover({server?})` returns descriptors `[{name, description, schema, server, tool}]` (parsed from `<server>_<tool>` underscore naming); `mcp_invoke({name, args})` dispatches by name. `mcp_invoke` throws `ToolError` with `context.knownNames` on unknown names so the LLM can self-correct. New export: `buildMetaTools(tools, discoveredAt)` from `bare-agent/mcp`.
- **`bin/cli.js --config <path>` mode** — reads a JSON config (`{systemPrompt, provider, model, tools[], gate}`), wires Provider + tool registry (resolves `shell_read`, `shell_grep`, `shell_run`, `shell_exec`, `shell_*`, `spawn`, `defer` by name) + bareguard `Gate` via `wireGate`, reads stdin (one JSON line or string), runs `Loop`, emits structured JSONL events on stdout, and exits clean. Headless `humanChannel` defaults to "stderr WARN once + auto-deny". This is the surface a parent process invokes when spawning a child or firing a deferred record. Legacy stdio JSONL mode (`--provider`/`--model`) is preserved.
- **`examples/wake.sh` + `examples/wake.md`** — bash + jq + flock waker. Reads `BAREAGENT_DEFER_QUEUE`, folds status updates, fires due records via `bare-agent --config $ORCHESTRATOR_CONFIG`, appends `done` / `failed` status. Documented cron entry, env overrides table, dependencies, and a `copytruncate`-friendly log-rotation note.
- **`examples/orchestrator/`** — `orchestrator.json` + `specialists/{summarizer,researcher}.json` reference layout. Orchestrator routes via `spawn` to specialists scoped per-config (`gate.limits`, `gate.fs.readScope`, `gate.tools.allow`, `gate.audit.path`). Demonstrates the canonical "fan out via spawn, collect results, recurse via defer for long-running follow-ups" pattern.
- **Tests** — `test/spawn.test.js` (8 tests), `test/defer.test.js` (11 tests), `test/mcp-meta-tools.test.js` (10 tests). 29 new tests, all passing.

### Changed

- **`bareguard` pin** — `^0.1.1 → ^0.2.0`. New rate-cap config keys live at step 3 of bareguard's eval order: `spawn.ratePerMinute` (default 10/min, family-wide via root run_id), `defer.ratePerMinute` (default 15/min), `limits.maxDepth` (caps `BAREGUARD_SPAWN_DEPTH`). Audit log is the source of truth — no separate counter file. No public API breaks in bareguard 0.2.
- **`bareagent.context.md`** — version bumped to v0.9.0; new "Multi-agent: spawn + defer + wake" top-level section before "Wiring with bareguard"; new "MCP catalog: bulk vs metaTools" subsection; entry-points list and Which-components table refreshed.
- **`README.md`** — LOC tagline `~2.4K → ~2.7K`, MCP Bridge row updated, two new rows for **Spawn** and **Defer**, deps note updated to `bareguard ^0.2.0`.
- **`CLAUDE.md`** — same LOC + dep-pin refresh; added Spawn and Defer rows; tools entry expanded with `createSpawnTool, spawnChild, createDeferTool, readDeferQueue`; mcp entry expanded with `buildMetaTools`.

### Decisions log (cross-aligned with bareguard 0.2)

- Args wrapped uniformly: every gov'd action is `{type, args}`. Spawn/defer follow this; bareguard scans `JSON.stringify(args)` for content rules.
- Two-phase defer: emit-time check is on the outer `defer`; fire-time check is on the inner action. Both are normal `gate.check` calls — no special path.
- Per-family scope = root run_id. Children inherit `BAREGUARD_PARENT_RUN_ID`; rate windows count per-family, not per-process.
- Audit log is the source of truth for rate windows. Fixed-minute window (not rolling). No counter file = no drift, no cleanup.
- One JSONL channel per child. Stderr captured by parent, re-emitted as `child:stderr` events on stdout. Wake.sh redirects child stdout alone.
- cwd-only defer queue (resolved from option > env > `./bareagent-defers.jsonl`). No global queue, no per-user state dir.
- MCP "Path A" governance: gate runs at invocation (`mcp_invoke` action.type is the literal string), not at catalog list. Use `denyArgPatterns` to scope.
- LLM blocks on `spawn` tool. Library callers can use `spawnChild` for handle-based / fire-and-forget. LLMs don't manage handles across tool calls.
- No deprecation shims for the bareguard 0.2 pin bump — pre-1.0, clean cut.

---

## [0.8.0] — 2026-04-30

**Single-gate governance via bareguard.** All policy, audit, and budget decisions move out of Loop and into the sibling [bareguard](https://npmjs.com/package/bareguard) library. Loop becomes a pure runner that respects whatever verdict bareguard returns. Net source delta: ~−250 LOC; no deprecation shims (pre-1.0, clean cut).

### Added

- **`bare-agent/bareguard` entry point** — new `wireGate(gate)` helper returns `{ policy, wrapTool, wrapTools }`. One-line integration: pass `policy` to `new Loop({ policy })`, run tools through `wrapTools(tools)`, and every tool call traverses `gate.check` pre-execute and `gate.record` post-execute. Halt-severity decisions (budget exhausted, `limits.maxTurns` hit, etc.) flow back as `[HALT: <rule>]` deny strings the LLM sees as tool results.
- **`bareguard` as a hard dependency** (pinned `^0.1.1`). Reflects that single-gate governance is now load-bearing for the library; opt-out costs nothing if you don't pass `policy`, but the recommended wiring is built in.
- **Apache 2.0 license** — switched from MIT. `LICENSE` and `NOTICE` files added; `package.json` `license` field updated to `Apache-2.0`.
- **`examples/with-bareguard.mjs`** — end-to-end smoke wiring: `Gate` with budget cap, fs scope, bash allowlist, audit path, and `humanChannel` callback, plumbed into a real `Loop` with shell tools.
- **`test/integration-bareguard.test.js`** — 13 tests pinning the adapter contract: decision shape mapping, halt prefixing, ctx forwarding, `wrapTool` record/error behaviour, end-to-end Loop + Gate wiring.

### Removed (breaking)

- **`Loop({ maxCost })`** — moved to `new Gate({ budget: { maxCostUsd } })`. `MaxCostError` class deleted.
- **`Loop({ maxRounds })`** — moved to `new Gate({ limits: { maxTurns } })`. `MaxRoundsError` class deleted. Loop has an internal `HARD_ROUND_LIMIT = 100` safety net only — not configurable, not part of the public API.
- **`Loop({ audit })`** — moved to `new Gate({ audit: { path } })`. Loop's internal `_writeAudit` / `_auditInFlight` / `flush()` removed; bareguard owns audit I/O end-to-end.
- **`bare-agent/policy` entry point** — `pathAllowlist`, `commandAllowlist`, `combinePolicies` deleted. Express the same intent in bareguard config primitives (`fs.readScope` / `fs.writeScope` / `fs.deny`, `bash.allow` / `bash.denyPatterns`, layered `tools` + `content` rules). One source of truth = no drift.
- **`source: 'cost-cap'`** value from the `onError` `meta.source` enumeration. Cost halt comes from bareguard now and surfaces as a deny string + `loop:tool_result` event with `denied: true`.

### Changed

- **`Loop({ policy })` JSDoc** — recommended wiring is now `wireGate(gate).policy`. The contract is unchanged: `(toolName, args, ctx) => true | string`. Existing custom closures keep working without modification.
- **`bareagent.context.md`** — version bumped to v0.8.0; new "Wiring with bareguard" top-level section between MCP Bridge and Recipes; "Wiring with governance (policy + audit)" section rewritten around bareguard; "Cost caps with maxCost" + "Policy helpers" sections deleted; error hierarchy + entry points + Which-components table refreshed.
- **`README.md`** — Loop row, Errors row, dependencies note, license footer updated.

### Migration from v0.7.x

Drop-in if you don't use `policy`, `maxCost`, `maxRounds`, `audit`, or the `bare-agent/policy` helpers — Loop's default behaviour is unchanged.

| You had | Move to |
| --- | --- |
| `new Loop({ maxCost: 0.50 })` | `new Gate({ budget: { maxCostUsd: 0.50 } })` |
| `new Loop({ maxRounds: 20 })` | `new Gate({ limits: { maxTurns: 20 } })` |
| `new Loop({ audit: './x.jsonl' })` | `new Gate({ audit: { path: './x.jsonl' } })` |
| `pathAllowlist({ allow, deny })` | `new Gate({ fs: { readScope: allow, deny } })` (or `writeScope`) |
| `commandAllowlist({ allow })` | `new Gate({ bash: { allow } })` |
| `combinePolicies(a, b, c)` | Stack primitives in one Gate config — they compose as one eval |
| `policy: yourClosure` | Same closure works. Wrap with bareguard via `wireGate(gate).policy` for the recommended wiring. |
| `catch (err) { if (err instanceof MaxCostError) ... }` | Watch for `[HALT: budget.maxCostUsd]` in the deny string, or wire `humanChannel` to detect halts at source |
| `catch (err) { if (err instanceof MaxRoundsError) ... }` | Same — `[HALT: limits.maxTurns]` |

End-to-end example: `examples/with-bareguard.mjs`.

### Tests

- Removed: `test/policy-helpers.test.js` (entire file — symbols deleted), `MaxRoundsError` test in `test/errors.test.js`, `maxRounds` / `maxCost` / `audit` describe blocks in `test/loop.test.js`.
- Added: `test/integration-bareguard.test.js` (13 tests covering the wireGate contract end-to-end).
- All other tests pass against v0.8.0 unchanged; the option drops were silent (`maxRounds: 5` etc. are now ignored, not erroring).

### Deps

- `dependencies` — added `bareguard ^0.1.1`.
- `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta` — unchanged.
- `exports` map — added `./bareguard`, removed `./policy`.

---

## [0.7.0] — 2026-04-14

Foundations for autonomous agents: per-caller policy routing, cost caps, Checkpoint safety, composable policy helpers, and a discipline pass eliminating silent failures.

### Added

- **Per-caller policy ctx.** `policy(toolName, args, ctx)` — the third arg is an opaque blob forwarded from `loop.run(messages, tools, { ctx })`. Consumers define the shape (`{ userId, isOwner, tenantId, ... }`); bareagent just forwards. Lets one policy closure route per-user without rebuilding the Loop per request. Multi-tenant agents are now a one-liner.
- **`Loop({ maxCost })` + `MaxCostError`.** Accumulated cost cap enforced after every round. Throws (or returns `error`) as soon as the cap is exceeded. Primary safety rail against runaway loops — kicks in before budget damage rather than after. `MaxCostError` exported from both `bare-agent` and `bare-agent/errors`.
- **`Checkpoint({ timeout })`.** Default 5 minutes. If `waitForReply` doesn't resolve within the timeout, Checkpoint throws `TimeoutError` instead of hanging forever. The Loop catches it, auto-denies the tool call with reason `"Checkpoint failed: ... auto-denied"`, and routes the error through `loop:error` + `onError`. Set `timeout: 0` to disable.
- **`bare-agent/policy` entry point** — new exports: `pathAllowlist`, `commandAllowlist`, `combinePolicies`. Composable predicates matching the policy contract. Lift 60+ lines of boilerplate out of every consumer. Path helper expands `~`, normalizes paths, rejects under denied roots, enforces allowlist prefixes, optional per-tool gating. Command helper inspects `argv[0]` for `shell_run` (injection-proof) or `command.split(/\s+/)[0]` for `shell_exec` (with documented caveat). Combinator short-circuits on first non-true verdict and forwards `ctx` down the chain.

### Changed

- **Unified error surfacing — discipline pass.** Every previously silent failure now routes through one hook:
  - Audit write / serialize failures → `loop:error` stream event + `onError(err, { source: 'audit:write' })`
  - `onToolCall` / `onText` / user callback throws → `loop:error` + `onError(err, { source: 'callback:<name>' })`, loop continues
  - Stream listener throws → caught, logged via `onError(err, { source: 'stream', eventType })`, loop continues
  - Checkpoint timeout / transport failure → caught, tool auto-denied with reason, `loop:error` + `onError(err, { source: 'checkpoint' })`
  - Provider errors → already routed through `loop:error`; now also fire `onError` with `{ source: 'provider', round }`
- **`Loop._safeEmit`, `_safeCall`, `_reportError`** — three internal helpers wrap every emit/callback site. No more bare `this.stream?.emit(...)` or `this.onError?.(err)` — all go through the helpers, which guarantee no silent swallows.
- **Checkpoint.ask** — now races `waitForReply` against a timer. Clears timer on resolution. Rejects with `TimeoutError` on expiry.

### Philosophy

- **Three observability hooks, one principle.** Every failure now lands in exactly one of three places and the library has no other silent paths:
  - `audit` JSONL for forensic replay (every tool decision, durable)
  - `stream` for live telemetry (`loop:error`, `loop:tool_call`, etc. — wire JsonlTransport or your own)
  - `onError` for pager-style alerts (one function, fires on every silent-ish failure)
- **Per-caller ctx is the default case.** Multi-user autonomous agents are the norm, not an exception. The third arg makes that foundational instead of a closure hack.
- **Cost caps are the primary runaway catch.** Rate limiters were considered and rejected — they fight legitimate long-running loop agents. A cost cap catches the same failure mode with a metric users actually care about.

### Tests

- 110/110 passing (48 loop + 22 shell-tools + 17 policy-helpers + 23 checkpoint).
- New: `test/policy-helpers.test.js` (23 tests) covering pathAllowlist, commandAllowlist, combinePolicies including short-circuit semantics, ctx forwarding, `~` expansion, deny-wins, relative path resolution, argv vs shell-string gating.
- New: 4 describe blocks in `test/loop.test.js`:
  - `policy ctx` — forwards ctx, branches on it for owner vs user routing
  - `maxCost` — throws MaxCostError over cap, respects throwOnError, no false positives under cap
  - `unified error surfacing` — callback throws fire onError without breaking loop, stream listener throws isolated
  - `Checkpoint timeout` — ask rejects with TimeoutError, Loop catches and auto-denies, timeout=0 disables

### Docs

- `bareagent.context.md` — new "Per-caller governance with ctx" section, "Cost caps with maxCost" section, "Checkpoint timeout" note, `bare-agent/policy` recipe.
- `README.md` — Loop row updated for ctx+maxCost, Errors row adds MaxCostError.
- `CLAUDE.md` — Loop row, new Policy helpers row, bare-agent/policy entry point.
- `CHANGELOG.md` — this entry.

### Migration from v0.6.x

- **Zero-config upgrade** if you don't use `policy`, `maxCost`, or `Checkpoint({ timeout })`. Existing behaviour preserved.
- **Policy closures** can now accept a third `ctx` arg but are not required to — old `(toolName, args)` signatures work unchanged.
- **Checkpoint** gains a 5-minute default timeout. If you rely on `waitForReply` hanging indefinitely, set `timeout: 0` explicitly.

---

## [0.6.2] — 2026-04-14

Post-review patch fixing correctness, security, and migration findings from the v0.6.0 + v0.6.1 code review. No API additions beyond `shell_run` and `loop.flush()`; behaviour tightened across the board.

### Added

- **`shell_run({argv, cwd?, timeout?, maxBuffer?, env?})`** in `tools/shell.js` — new fourth shell tool using `child_process.execFile` with `shell: false`. Takes an argv array, not a command string, so shell metacharacters are passed as literal argument bytes and cannot inject commands. This is the policy-friendly primitive: a naive `args.argv[0]` allowlist is actually safe, unlike a naive `shell_exec` allowlist. Returns `{stdout, stderr, code, timedOut}` identical to `shell_exec`. Returns `{code: null, stderr: "command not found: X"}` on `ENOENT`.
- **`Loop.flush()`** — awaits any in-flight audit writes. Called automatically at every `Loop.run()` exit path (final text, maxRounds, provider error). Short-lived agents no longer lose trailing audit lines.

### Changed

- **Policy verdict is now strictly fail-safe (`src/loop.js`).** Previously `verdict !== true && verdict !== undefined` allowed — meaning a policy that forgot `return true` on a branch silently allowed the tool. Now only `verdict === true` allows; anything else (including `undefined`, `false`, objects, strings) denies. A string verdict is used verbatim as the deny reason; all other non-`true` returns use a generic message.
- **Loop constructor now rejects non-function `policy`** with a clear error instead of crashing mid-tool-call with a TypeError.
- **Audit writes are now tracked per-Loop** via an in-flight `Set` of promises (`src/loop.js`). `fs.promises.appendFile` replaces the callback form. `_writeAudit` adds each promise to the Set and removes it in `.finally()`; `flush()` awaits `Promise.all([...set])`.
- **BREAKING: `createMCPBridge({ policy })` now throws** with a migration message pointing at `new Loop({ policy })`. Previously the option was silently ignored (worst-case for a security feature). Existing users hitting the throw should move their closure to the Loop constructor — the signature shrinks from `(server, tool, args)` to `(toolName, args)` where `toolName` is the prefixed bareagent name (e.g. `beeperbox_send_message`).
- **`shell_exec` description rewritten** to flag shell-injection risk verbatim in the LLM-visible tool description. Context docs now recommend `shell_run` for policy-gated use cases and explicitly call out that `command.split(/\s+/)[0]` is bypassable.
- **`shell_grep` splits lines on `/\r?\n/`** — CRLF files no longer leave a trailing `\r` in hit text.

### Fixed

- I1 (review): audit writes lost on short-lived process exit.
- I2 (review): policy `undefined` return silently allowed instead of denying.
- I3 (review): no safe primitive for policy-gated command execution; docs showed a bypassable allowlist example.
- M5 (review): CRLF artefact in grep output.
- M8 (review): non-function `policy` option crashed mid-run.
- M9 (review): `createMCPBridge({ policy })` silently no-op — security feature removal without warning.
- Recipe 9 doc drift in `bareagent.context.md` — the page documented `createMCPBridge({ policy })` as a runtime option after v0.6.0 had already moved it to Loop level.

### Tests

- `test/loop.test.js` — 2 new tests: policy-returns-undefined denies, non-function policy rejected in constructor. Audit tests dropped the `await flush()` sleep-based workaround (Loop.run awaits it now).
- `test/shell-tools.test.js` — 5 new tests for `shell_run`: argv happy path, no-shell-injection proof, non-zero exit, empty/missing argv rejection, ENOENT handling. Shape test updated from 3 → 4 tools.
- `test/mcp-bridge.test.js` — legacy-policy test now asserts the throw + migration message.
- 48 loop tests + 22 shell-tools tests passing in isolation after the changes.

---

## [0.6.1] — 2026-04-14

### Added

- **Cross-platform shell tools** (`tools/shell.js`) — new `createShellTools()` factory returning three pure-Node primitives that work identically on linux, macOS, and Windows. No external binaries, no platform detection, no baked-in allowlist.
  - `shell_read({path, maxBytes?})` — read a file (utf8, default 256KB cap with truncation notice) or list a directory as tab-separated `kind\tname` lines. `~` expands to home.
  - `shell_grep({pattern, path, recursive?, maxMatches?, flags?})` — JavaScript regex search across files using `fs` walk + `RegExp`. Skips binary files via NUL-byte probe. Returns `{hits: [{file, line, text}], truncated, fileCount}`. No dependency on `grep`/`rg`/`findstr`.
  - `shell_exec({command, cwd?, timeout?, maxBuffer?, env?})` — `child_process.exec` with 30s default timeout and 1MB default buffer. Returns `{stdout, stderr, code, timedOut}`. `windowsHide: true`.
- Exported via `require('bare-agent/tools').createShellTools`.

### Philosophy

- Gating is the caller's responsibility. Wire shell tools through `new Loop({ policy })` with an allowlist appropriate for your OS — `ls`/`cat`/`grep` on linux and macOS, `dir`/`type`/`findstr` on Windows. The library ships the primitives, not the opinion.

### Tests

- 17 new tests in `test/shell-tools.test.js`: tool shape, file read, directory list, truncation, missing path error, single-file grep, recursive grep, recursive:false, binary-file skip, maxMatches cap, invalid regex, exec stdout/code, non-zero exit, timeout, cwd, Loop-policy deny integration, Loop-audit integration.

---

## [0.6.0] — 2026-04-13

### Added

- **Loop-level governance middleware** (`src/loop.js`) — Every tool call (native, MCP, browsing, mobile, user-defined) now flows through one policy hook and one audit stream.
  - `new Loop({ policy })` — async `(toolName, args) => true | false | string`. Return `true` to allow, `false` for a generic deny, a string for a specific reason fed verbatim to the LLM as the tool result. Denies never throw — the LLM sees the refusal and can reason around it. A thrown policy becomes a deny with the error as reason.
  - `new Loop({ audit: './audit.jsonl' })` — one JSON object per tool call: `{ts, tool, args, decision, result|reason|error, durationMs}`. Append-only, async, best-effort. Audit failure logs a warning and never aborts the tool call.
  - Omitting both options preserves v0.5.x behaviour exactly.

### Changed

- **BREAKING (internal):** `createMCPBridge({ policy })` runtime option removed. Runtime arg-dependent policy moved entirely to `new Loop({ policy })`, which gates MCP tools identically to native tools. The static `.mcp-bridge.json` allow/deny file is unchanged — it still decides which MCP tools are exposed to the Loop in the first place. Users who relied on the mcp-bridge `policy` option should move the same closure to the Loop constructor. No user-visible change in behaviour for tools gated via `.mcp-bridge.json`.

### Tests

- 8 new unit tests in `test/loop.test.js`: allow, deny-string, deny-false, policy-throws, no-policy backwards compat, audit allow record, audit deny record, audit tool-error record.
- `test/mcp-bridge.test.js`: `policy blocks at execute time` rewritten to verify mcp-bridge no longer wraps policy.

### Docs

- `docs/01-product/bare-suite-plan.md` — decision record for governance middleware, shell tool plan, RAG split, and multis refactor strategy.
- `bareagent.context.md` — new "Wiring with governance (policy + audit)" section with policy return-value table, audit JSONL format, and unified-coverage note.

---

## [0.5.0] — 2026-04-08

### Added

- **MCP Bridge** (`src/mcp-bridge.js`) — Auto-discover MCP servers from IDE configs (Claude Code, Cursor, Claude Desktop), connect via stdio JSON-RPC, and expose their tools as standard bareagent tools. Zero deps.
  - First run discovers servers, writes `.mcp-bridge.json` with all tools set to `"allow"`. Edit the file to `"deny"` individual tools. Changes survive refresh.
  - TTL-based refresh (default 24h) re-discovers servers, adds new tools as `"allow"`, preserves existing deny entries.
  - `policy` option for runtime arg-dependent checks (e.g., block writes to `/etc` but allow `/tmp`).
  - `systemContext` string for LLM awareness — tells the agent what tools are available and what's restricted.
  - Concurrent tool call routing via JSON-RPC ID matching. Tested with real servers under load.
  - Escalating process cleanup (SIGTERM → SIGKILL) prevents zombie processes.
- New export: `bare-agent/mcp` → `createMCPBridge`, `discoverServers`.

### Tests

- 20 new unit tests (`test/mcp-bridge.test.js`): discovery, file-based governance, deny preservation on refresh, tool shape, concurrent routing, crash recovery, init timeout, malformed output, policy, systemContext.
- 5 new integration tests (`test/integration-mcp-bridge.test.js`): real barebrowse connection, tool execution, concurrent calls, deny filtering.
- Mock MCP server (`test/fixtures/mock-mcp-server.js`) for deterministic testing.

---

## [0.4.3] — 2026-03-18

### Added

- **Cost estimation** — Loop now returns `cost` (estimated USD) in every result and in `loop:done` stream events. Pricing map covers OpenAI (gpt-4o, gpt-4o-mini, gpt-4.1 family, o3-mini) and Anthropic (Sonnet, Haiku, Opus). Unknown models use a sensible default (~$0.002/$0.008 per 1K in/out). Cost accumulates across rounds. Adjust rates in `COST_PER_1K` at the top of `src/loop.js`.

### Tests

- 5 new unit tests: cost estimation (known model, unknown model, multi-round accumulation, stream event, no-model fallback).
- Total: 224 tests.

---

## [0.4.2] — 2026-03-11

### Changed

- **`barebrowse` optional dep** bumped from `^0.2.0` to `^0.5.0` — picks up 17 browsing tools (was 13): added hover, tabs, switchTab, pdf, plus optional assess (privacy scan via `wearehere`).

### Docs

- `bareagent.context.md` — Gotcha #13 updated with full 17-tool list, version bumped to v0.4.2.
- `docs/00-context/blueprint.md` — Browsing Tools section updated with complete tool list and auto-snapshot behavior.

---

## [0.4.1] — 2026-02-27

### Added

- **`mobile_find_text` tool** — wraps `page.findByText(text)` from baremobile v0.7.5. Searches the refMap from the last snapshot (no device call). Returns ref number or null.
- **Unit test** (`test/mobile-tools.test.js`) — 12 tests: null return when baremobile not installed, tool shape validation, tool count per platform, platform gating verification.

### Fixed

- **`mobile_tap_xy` now available on iOS** — was incorrectly gated behind `platform !== 'ios'`. iOS page object has `tapXY()` since baremobile v0.7.0. Moved to shared tools (both platforms).

### Docs

- `bareagent.context.md` — Added createMobileTools to entry points, "Which components" table rows for mobile, Recipe 8 (Loop + Mobile Tools), Gotcha #14 (mobile tools require close). Bumped version to v0.4.0.
- `CLAUDE.md` — Added MobileTools to components, createMobileTools to exports table.
- `README.md` — Added Mobile row to component table, updated ecosystem table for iOS support, updated Tools and Deps descriptions.
- `docs/00-context/blueprint.md` — Added `tools/mobile.js` to file table, added "Mobile Tools" subsection (library tools + CLI session strategies).
- `docs/KNOWLEDGE_BASE.md` — Added mobile tools to blueprint description.

---

## [0.4.0] — 2026-02-27

### Added

- **MobileTools** (`tools/mobile.js`) — 17 tools for Android + iOS device control via baremobile. Snapshot/tap/type/scroll/swipe/launch/press/back/home/screenshot + Android-only intent/tapXY/tapGrid/grid + iOS-only unlock + cross-platform waitForText/waitForState. Dual platform via `platform` option. Auto-snapshot after actions. Exported via `bare-agent/tools`.

---

## [0.3.6] — 2026-02-23

Docs-only release. No code changes.

### Docs

- `bareagent.context.md` — Gotcha #13 updated with full barebrowse tool list (13 tools); Recipe 7b expanded with complete CLI command reference (session, navigation, interaction, tabs, debugging), open flags, and ref-based command details.

---

## [0.3.5] — 2026-02-23

Docs-only release. No code changes.

### Changed

- **Renamed** `docs/00-context/system-state.md` → `docs/00-context/blueprint.md`.

### Docs

- `bareagent.context.md` — Browsing component table split into library tools vs CLI session rows; gotcha #13 expanded with CLI session advice; added Recipe 7b (CLI browsing strategy comparison, workflow, command reference).
- `docs/00-context/blueprint.md` — System diagram shows both browsing modes; added "Browsing Tools" subsection documenting library vs CLI strategies.
- `README.md` — Browsing table row and Tools description mention both library tools and CLI session mode.
- `CLAUDE.md` — Tools line mentions both browsing strategies.
- `docs/KNOWLEDGE_BASE.md` — Expanded blueprint entry with browsing strategy docs.
- Updated all `system-state.md` references to `blueprint.md` across `docs/README.md`, `docs/02-features/development.md`, `docs/04-process/dev-workflow.md`, `CHANGELOG.md`.

---

## [0.3.3] — 2026-02-21

### Added

- **Cross-language SDK wrappers** (`contrib/`) — Tested, importable subprocess wrappers for Python, Go, Rust, Ruby, and Java. Each spawns `npx bare-agent --jsonl` and communicates via JSONL over stdin/stdout. Consistent API across all 5 languages: constructor → `run(goal)` → `close()`. stdlib only where possible (Rust needs `serde_json`). See `contrib/README.md`.

### Docs

- `bareagent.context.md` — Added "Cross-language SDKs" section pointing to `contrib/`.
- `docs/02-features/usage-guide.md` — Updated subprocess section to reference `contrib/` wrappers.
- `docs/00-context/blueprint.md` — Added cross-language wrappers to blueprint.
- `README.md` — Updated "Cross-language" bullet to mention `contrib/`.

---

## [0.3.2] — 2026-02-21

Docs and integration improvements from multis eval. No code changes.

### Fixed

- **`better-sqlite3` peer dep** — Widened from `^12.6.2` to `>=9.0.0`. Projects using v11 no longer need `--legacy-peer-deps`.

### Docs

- **"Patterns, Not Features"** section in usage guide — Recipes for multi-agent orchestration, structured output, output limiting, rate limiting, hooks, heartbeat, cron. Each explains why it's not a framework feature and how to do it with existing primitives.
- **Tool context adapter recipe** — Closure pattern for tools needing execution context (senderId, chatId, permissions).
- **Checkpoint chat-platform recipe** — Pending approvals Map + reply interception for wiring Checkpoint to Telegram/Slack/Discord.
- **Gotcha #11** — Loop injects system prompt as `{ role: 'system' }` message at index 0, not in options.
- **Linked README → usage guide** and **context file → usage guide** for discoverability.
- **Compatibility matrix** — Which components aurora and multis actually use.
- **Provider diagnostic script** (`bin/test-provider.js`) — Quick pass/fail check for API key + provider connectivity.

---

## [0.3.0] — 2026-02-20

**BREAKING:** Loop.run() now throws on error by default. Callers relying on `result.error` must pass `throwOnError: false`.

### Added

- **Loop `throwOnError` option** — Default `true`. When enabled, provider errors are re-thrown as-is and maxRounds exhaustion throws `MaxRoundsError`. Pass `throwOnError: false` for v0.2.x backward-compatible `result.error` behavior.
- **`MaxRoundsError`** (`src/errors.js`) — Typed error for Loop maxRounds exhaustion. `code: 'MAX_ROUNDS'`, `retryable: false`.
- **Planner `cacheTTL` option** — `new Planner({ provider, cacheTTL: 60000 })` caches plan results by goal + context.info for the specified TTL (ms). `clearCache()` method to invalidate manually.
- **CLIPipe `onChunk` callback** — `new CLIPipeProvider({ command, onChunk: (chunk) => {} })` streams stdout chunks as strings during `_spawn()`, eliminating buffering silence during long LLM calls.

### Changed

- Loop.run() throws by default on provider errors and maxRounds (was: silently returned `{ error }`).
- `bare-agent` main export now includes `MaxRoundsError`.

### Tests

- 14 new tests: loop throwOnError (6), planner caching (5), CLIPipe onChunk (2), MaxRoundsError (1).
- Total: 207 tests.

---

## [0.2.2] — 2026-02-20

Multi-agent resilience: typed errors, circuit breaker, fallback provider, jitter, step retry.

### Added

- **Typed error hierarchy** (`src/errors.js`) — `BareAgentError` base class with `code`, `retryable`, `context`. Subclasses: `ProviderError` (auto-retryable for 429/5xx), `ToolError`, `TimeoutError`, `ValidationError`, `CircuitOpenError`.
- **CircuitBreaker** (`src/circuit-breaker.js`) — Per-key circuit breaker with configurable threshold and reset timer. States: closed → open → half-open. `wrapProvider()` for transparent provider wrapping. `onStateChange` callback.
- **FallbackProvider** (`src/provider-fallback.js`) — Tries providers in order. Throws `AggregateError` when all fail. `shouldFallback` and `onFallback` callbacks. Composes with CircuitBreaker via `cb.wrapProvider()`.
- **Retry jitter** — `new Retry({ jitter: 'full'|'equal'|number(0-1) })` adds randomized backoff spread to prevent thundering herd.
- **Retry `retryable` fast path** — Errors with `err.retryable === true` are automatically retried; `err.retryable === false` bail immediately. Falls through to existing status/code checks when `retryable` is undefined.
- **`runPlan` `stepRetry` option** — Wraps each step's executeFn with a Retry instance for transient failure recovery.

### Changed

- All providers now throw `ProviderError` instead of plain `Error` on HTTP failures. Backward compatible (`instanceof Error` still works, `.status`/`.body` still accessible).
- Loop wraps tool execution errors in `ToolError`.
- Retry timeout throws `TimeoutError` instead of plain `Error`.
- `bare-agent` main export now includes `CircuitBreaker` and all error classes.
- `bare-agent/providers` now includes `Fallback`.

### Tests

- 33 new unit tests: errors (9), retry jitter + retryable (6), circuit breaker (9), fallback provider (6), runPlan stepRetry (3).
- Total: 193 tests.

### Docs

- README — Added CircuitBreaker, Fallback, Errors to architecture tables. Added resilient agent example.
- CLAUDE.md — Updated component table with CircuitBreaker, Errors, Fallback.
- bareagent.context.md — Added error hierarchy and circuit breaker + fallback recipes.
- docs/errors.md — Added typed error hierarchy, CircuitBreaker, FallbackProvider sections.
- docs/04-process/testing.md — Updated test tables and pyramid counts.

---

## [0.2.1] — 2026-02-20

Feedback fixes from Aurora's SOAR2 pipeline integration.

### Added

- **CLIPipeProvider `systemPromptFlag`** — New constructor option to separate system messages from stdin and pass them as a CLI flag (e.g. `--system`). Fixes structured output breaking when `_formatPrompt()` flattens system messages into plaintext.
- **`runPlan` `onWaveStart` callback** — `onWaveStart(waveNumber, steps)` fires before each wave executes, enabling consumer-side wave progress display (e.g. `[Wave 1: s1, s2]`).
- **`bare-agent/transports` export** — New entry point exporting `{ JsonlTransport }`. Fixes `ERR_PACKAGE_PATH_NOT_EXPORTED` when importing JsonlTransport directly.

### Changed

- `CLIPipeProvider._spawn()` accepts optional `extraArgs` parameter, appended after `this.args`.
- `package.json` exports map updated with `./transports` entry.

### Tests

- 5 new unit tests: CLIPipeProvider systemPromptFlag (4), runPlan onWaveStart (1).
- Total: 160 tests (142 unit + 14 integration + 4 E2E).

### Docs

- `bareagent.context.md` — Added Gotchas section and Recipes section.
- `docs/errors.md` — Updated CLIPipeProvider section with systemPromptFlag behavior.
- `docs/04-process/testing.md` — Updated test counts and added new test descriptions.
- `README.md` — Updated line count, status section, added Aurora production validation.

---

## [0.2.0] — 2026-02-20

Three new features filling gaps identified in the aurora evaluation.

### Added

- **CLIPipeProvider** (`src/provider-clipipe.js`) — Pipe prompts to any CLI tool via stdin/stdout. Constructor takes `{ command, args, cwd, env, timeout }`. Returns `{ text, toolCalls: [], usage }` like all providers. Handles spawn errors, non-zero exit, timeout (SIGTERM + SIGKILL grace), and empty output.
- **`Loop.validate(tools?)`** (`src/loop.js`) — Health check method that never throws. Returns `{ provider: { ok, error? }, store: { ok, error?, skipped }, tools: { ok, errors? } }`. Tests provider connectivity, store write/read/delete cycle, and tool definition validity.
- **`runPlan(steps, executeFn, options?)`** (`src/run-plan.js`) — Wave-based parallel executor for Planner step DAGs. Eager input validation (duplicates, unknown deps). Dependency failure propagation, configurable concurrency limit, callbacks (`onStepStart/onStepDone/onStepFail`), and optional StateMachine integration. Returns results in original step order.

### Changed

- `Loop` constructor accepts optional `store` for `validate()` health check.
- `CLIPipe` added to `bare-agent/providers` exports.
- `runPlan` added to `bare-agent` main exports.

### Tests

- 33 new unit tests: CLIPipeProvider (9), Loop.validate (9), runPlan (11 + 4 input validation).
- Total: 155 tests (137 unit + 14 integration + 4 E2E).

### Docs

- `docs/errors.md` — Added CLIPipeProvider, runPlan, and Loop.validate() sections.
- `docs/04-process/testing.md` — Added test tables for new files, updated pyramid counts.

---

## [0.1.0] — 2026-02-20

First tagged release. Core library is built, tested, and hardened. Post-POC, pre-consumer.

### Components

- **Loop** — Core think/act/observe cycle with tool calling, retry, checkpoint integration, and stream events. Never throws; errors returned in `result.error`.
- **Planner** — Goal decomposition into step DAG via LLM structured output.
- **StateMachine** — Task lifecycle (pending/running/done/failed/waiting/cancelled) with file persistence and event emission.
- **Scheduler** — Time-triggered agent turns with cron + relative scheduling, overlap prevention, file persistence, and `onError` callback.
- **Checkpoint** — Human-in-the-loop approval gate with configurable tool filtering.
- **Memory** — Thin wrapper delegating to swappable store backends.
- **Stream** — Structured event emitter with optional JSONL transport.
- **Retry** — Backoff wrapper for async functions (exponential/linear/fixed) with per-attempt timeout.

### Providers

- **OpenAIProvider** — GPT models via OpenAI-compatible API. Configurable `baseUrl` for proxies/local servers.
- **AnthropicProvider** — Claude models via Anthropic API. Auto-converts OpenAI message format.
- **OllamaProvider** — Local models via Ollama. Synthesizes tool call IDs.

All providers return `{ text, toolCalls, usage }`.

### Stores

- **SQLiteStore** — FTS5 full-text search with BM25 ranking. Peer dep: `better-sqlite3`.
- **JsonFileStore** — Zero-dep JSON file store with case-insensitive substring search.

Both implement `store/search/get/delete`.

### Infrastructure

- CLI (`bin/cli.js`) for JSONL-over-stdio agent interaction.
- 122 unit tests (`node:test`, no API keys needed).
- 6 POC integration tests (OpenAI, Anthropic, Ollama).
- 4 E2E composition scenarios (full stack, memory+checkpoint, scheduler+memory, CLI subprocess).

### Hardening (Phase 1)

- All 22 error sites across 12 files use `[ComponentName]` prefix format.
- Tool validation at `Loop.run()` entry — catches missing name, missing execute, wrong types before the loop starts.
- Scheduler surfaces handler errors via `onError(err, job)` callback instead of swallowing them.
- `@throws` JSDoc on every method that can throw/reject.
- `docs/errors.md` — standalone error reference with triggers and fixes for every error.
