---
type: reference
title: "What Was Extracted to bareguard"
status: stable
sources: ["docs/archive/prd.md"]
---

# Governance Extraction to bareguard

What moved out of bareagent into bareguard (v0.8.0, shipped 2026-04-30), and the resulting gate contract. The full original document is archived at `docs/archive/prd.md`.

## What moved

These primitives previously lived in bareagent and have moved out; each is now a primitive in bareguard. bareagent does not import bareguard directly — the `wireGate(gate)` adapter (`bare-agent/bareguard`) takes a user-constructed `Gate` and returns the policy closure + tool wrapper that integrate it (prd.md:183-188).

| Was in bareagent | Moved to bareguard | Notes |
| --- | --- | --- |
| Bash allowlist / denylist | `bareguard.bash` | Same logic was duplicated in `multis`; single chokepoint = no drift (prd.md:192). |
| Token / cost budget | `bareguard.budget` | Reusable by any runner; multi-agent needs shared budget across siblings (prd.md:193). |
| Per-tool allow/deny/ask logic ("gov layer") | `bareguard.tools` + `bareguard.content` | Identity check (tool name) is the `tools` primitive; word/pattern check is `content` (prd.md:194). |
| Max-turns counter | `bareguard.limits.maxTurns` | Already a guard, just relocating (prd.md:195). |
| Ad-hoc tool-call logging | `bareguard.audit` (JSONL) | Audit log is the spine of bareguard (prd.md:196). |

(prd.md:190-196)

## The gate contract

**No bareagent code makes a policy decision after this extraction.** Every tool call traverses `gate.check(action)`; every result hits `gate.record(action, result)`. That is the only contract bareagent has with bareguard (prd.md:198-201).

**Re-exports during transition.** bareagent v(next) re-exports the old guard function names from `bareagent/guards/*` as proxies to bareguard with `DeprecationWarning`, removed in v(next+2) (prd.md:203-205).

## Concrete removal list (§9.1)

bareguard v0.1.1 (published to npm 2026-04-30) ships everything needed. Pin `^0.1.1`, not `^0.1.0` — the patch addresses pre-publish review fixes: `gate.allows(string)` overload, `_truncated` audit boolean, missing-`humanChannel` WARN, removal of `Gate.fromConfig` (prd.md:207-213).

### `src/loop.js`

The bulk of the change happened here (prd.md:216):

| Was in `loop.js` (v0.7.0) | Done in v0.8.0 |
| --- | --- |
| Constructor option `maxRounds` (default 5) + the round-bound `for` loop + `MaxRoundsError` throw at line ~319 | **Removed.** Replaced with internal `HARD_ROUND_LIMIT = 100` safety net (not configurable, not a public option). Real iteration bounds now come from `new Gate({ limits: { maxTurns: N } })`, surfacing as `[HALT: limits.maxTurns]` deny strings via the policy adapter (prd.md:220). |
| Constructor option `maxCost` + the cost-cap block at line ~193 | **Removed.** Moves to `new Gate({ budget: { maxCostUsd: N } })`; halt surfaces as `[HALT: budget.maxCostUsd]` (prd.md:221). |
| Constructor option `audit` (file path) + `_writeAudit` / `_auditInFlight` / `flush()` methods (lines ~64–135) | **Removed.** bareguard owns the audit log entirely, via `new Gate({ audit: { path } })` or `BAREGUARD_AUDIT_PATH`. The audit shape changes from bareagent's flat `{ts, tool, args, decision, result, durationMs}` to bareguard's richer per-phase records carrying `severity`, `parent_run_id`, `spawn_depth`, `_truncated` — a strict superset, no breaking change to log consumers that ignore unknown fields (prd.md:222). |
| Constructor option `policy` + the policy invocation block at line ~263 | **Kept.** Same `(toolName, args, ctx) => true \| string` contract. Recommended wiring is `wireGate(gate).policy` from `bare-agent/bareguard`; the adapter closure body is a one-liner: `(await gate.check({ type: toolName, args, _ctx: ctx })).outcome === 'allow' ? true : '[deny: ...] reason'` (prd.md:223). |

(prd.md:218-223)

### `src/policy.js`

`pathAllowlist`, `commandAllowlist`, `combinePolicies` (prd.md:225):

| Symbol | Done in v0.8.0 |
| --- | --- |
| `pathAllowlist(...)` | **Deleted.** Express via `new Gate({ fs: { readScope, writeScope, deny } })` — bareguard's `fs` primitive does the home-expansion + path-normalization + deny-wins logic that was duplicated here (prd.md:229). |
| `commandAllowlist(...)` | **Deleted.** Express via `new Gate({ bash: { allow: [...], denyPatterns: [...] } })`. bareguard's `bash` primitive gates `argv[0]` for `shell_run` (injection-proof) and string-base for `shell_exec` (same documented caveat) (prd.md:230). |
| `combinePolicies(...)` | **Deleted.** One source of truth = bareguard; stack primitives in one Gate config and they compose as one eval (e.g. `tools.allowlist` AND `content.askPatterns` AND `bash.denyPatterns` all run together). A bareagent-side composer would invite layered policies and drift (prd.md:231). |

(prd.md:227-231)

### `src/errors.js`

`MaxCostError`, `MaxRoundsError` — **both deleted.** Halt decisions surface as deny strings (`[HALT: <rule>]`) from `wireGate(gate).policy`, not exceptions. The `bare-agent/errors` exports drop these two; downstream `instanceof MaxCostError` checks must move to string-matching the deny reason or wiring `humanChannel` to detect halts at source (prd.md:233-234).

### `bare-agent/policy` entry point

**Removed from `package.json` `exports` map**, replaced with `bare-agent/bareguard` exporting `wireGate` (prd.md:236-237).

### `tools/`

The bash/shell tools (`shell_run`, `shell_exec`) — no inline argv-allowlist check ever lived in `tools/shell.js` (preemptively clean); no change needed (prd.md:239-240).

### Source delta

~−250 LOC removed from `loop.js` + `policy.js`; added ~+95 LOC in `src/bareguard-adapter.js` and `examples/with-bareguard.mjs`. Net: ~−150 LOC, matching the original estimate (prd.md:242).

### Verification command

Run on bareagent v0.8.0 to confirm no policy decision remains in bareagent source:

```bash
grep -rn 'allowlist\|denylist\|maxCost\|maxRounds' src/ index.js
```

Returns zero hits in v0.8.0 source; any future hit indicates a regression (prd.md:244-251).

## §9.2 — `bareagent.context.md` update requirements

The integration guide is what AI assistants and consumers read. After the extraction, it must include a "Wiring with bareguard" section that (prd.md:253-256):

1. States bareguard is now the source of truth for `bash`, `budget`, `tools`, `content`, `limits.maxTurns`, `audit`, `fs`, `net`, `secrets`, referencing bareguard's unified PRD for design rationale, NO-GO list, and decisions log (the v0.5 amendments doc was folded into the unified PRD as v0.6 — a single doc going forward) (prd.md:258-262).
2. Shows the canonical wiring with **`new Gate(...)` only** — `Gate.fromConfig` was removed in 0.1.1. Build the `Gate` first, then pass an adapter closure to `Loop({ policy })` that calls `gate.check`; the end-to-end example lives in bareguard.context.md Recipe 8 (bareguard + bareagent + beeperbox, 50 messengers) (prd.md:263-266).
3. Documents the migration map: `Loop({ maxCost })` → `gate.budget.maxCostUsd`; `Loop({ maxRounds })` → `gate.limits.maxTurns`; `Loop({ audit })` → gate writes the file via `audit.path` or an env var. The bareguard repo carries the canonical version of this map; `bareagent.context.md` should reproduce it for offline LLM consumption (prd.md:267-271).
4. Clarifies the `Checkpoint` vs `humanChannel` relationship: `humanChannel` (bareguard) handles **policy-driven** asks/halts; `Checkpoint` (bareagent) stays for **always-prompt** flows that aren't policy-driven (e.g. "always confirm before sending an email"). Both can route to the same underlying UI helper (prd.md:272-276).
5. Updates the "Which components do I need?" table (prd.md:277-283):
   - "Gate every tool call with one policy hook" → still `Loop({ policy })`, but the recommended body is now the bareguard adapter.
   - "Cap total USD spend per run" → was `Loop({ maxCost: 0.50 })`; now `new Gate({ budget: { maxCostUsd: 0.50 } })`.
   - "Audit every tool call to JSONL" → was `Loop({ audit: './audit.jsonl' })`; now `new Gate({ audit: { path: './audit.jsonl' } })`.
6. Adds a catalog pre-filter for `mcp_discover` using the **string-form `gate.allows("toolName")` shorthand** added in 0.1.1, avoiding a synthetic action object per catalog tool:
   ```js
   const visible = catalog.filter(t => gate.allows(t.name));
   ```
   The object form (`gate.allows({ type, args })`) still works for arg-aware filtering (prd.md:284-291).

A copy-pasteable draft of the new section was prepared during the design discussion, covering minimal wiring, the migration map, Checkpoint vs humanChannel, ctx routing patterns, audit-file sharing, multi-process spawn, and a "see also" footer linking to the bareguard PRD + amendments + context doc. It was slated for insertion verbatim as a top-level section in `bareagent.context.md` during the migration commit (between "MCP Bridge" and "Recipes"); the end-to-end version lifted into `bareguard.context.md` Recipe 8 (bareguard + bareagent + beeperbox) is the starting point for the wiring shape (prd.md:293-301).
