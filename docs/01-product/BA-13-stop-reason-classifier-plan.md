# BA-13 — Stop-Reason Classifier: honest terminal signals for every non-clean stop

**Status:** ✅ **BUILT & GREEN (2026-07-15)** — signed off on all three §7 decisions (bare tags, behavior change ships flagged, existing bounds for pause_turn). Landed in `src/provider-stop-reason.js` (`classifyStopReason`) + `src/loop.js` (classifier gate + `stopReason` on every return) + tests (`test/stop-reason.test.js`, `test/loop.test.js`, `test/recurse.test.js`, mutation-checked) + docs (CHANGELOG, `bareagent.context.md`, `docs/02-features/errors.md`, `CLAUDE.md`, README). 843 pass / 0 fail, typecheck clean. **Remaining: version bump + release (§4 step 7) — the manual OIDC flow, awaiting go.**
**Origin:** self-audit of the "under-modeled boundary rounds toward success" class (the BA-4/5/6/7 family), triggered by the question "we fixed the primitives one report at a time — where else does this class live?"
**Owner note:** do NOT touch `src/loop.js` until the error vocabulary below is signed off — `recurse` and the bareloop adopter both consume `Loop.run().error`, so the contract must freeze first.

---

## 1. The class being hunted

Every prior fix (BA-4/5/6/7) was the same bug in different clothes: **at a normalization/representation boundary, the external side reports something the neutral shape can't represent (or the Loop doesn't act on), and the code rounds the gap toward "success/done/empty/no-cap."** The rounding is *monotonically optimistic*, which is why these survive to an adopter: a pessimistic error is a false alarm someone investigates in an hour; an optimistic one looks exactly like success and nobody debugs a success.

The audit question, applied seam by seam:
> *"What can the real API say here that our neutral shape has no slot for — or that the Loop surfaces but never acts on — and when that happens, which way does it round?"*

Scope was deliberately the **representation boundaries**, not every primitive. Retry/CircuitBreaker/Scheduler/StateMachine are not boundaries of this kind and were out of scope. (A broader "re-validate everything" pass is a separate, larger effort.)

---

## 2. Audit scorecard (all four legs complete)

| # | Seam | Verdict | Evidence |
|---|---|---|---|
| 1 | usage normalization (OpenAI/Anthropic/Gemini) | ✅ **proven clean** | `poc/audit-usage-tiers.mjs` (live) |
| 2 | non-truncation stop reasons in `loop.js` | 🔴 **CONFIRMED FAULT** | `poc/audit-refusal-laundering.mjs` (deterministic) |
| 3 | tool required-args | 🟡 **no active fault** (+ optional hardening) | source sweep + existing `shell-tools.test.js` |
| 4 | recurse terminal exits | 🟠 **honest by construction, but INHERITS #2** | `poc/audit-recurse-refusal-inherit.mjs` (deterministic) |

**Net: one real fault (#2), blast radius reaching #4 (recurse) and the bareloop adopter.** #3 is clean with an optional companion hardening.

### 2.1 Finding #1 — usage: clean

Live probe wrapped each provider's `_request` to capture the RAW API `usage` beside our neutral `Usage` from the **same** response, then flagged any token-bearing raw field not mapped or a known subtotal. Verdict is **reconciliation to the provider's own total** (neutral sum < provider total ⇒ real undercount).

- Anthropic (haiku): every token field mapped; no total field → unmapped-key check clean.
- OpenAI (gpt-4o-mini): neutral `5123` == `total_tokens 5123`; cache-read tier exercised (4992) and correctly subtracted from the inclusive `prompt_tokens`.
- Gemini (gemini-2.5-flash): neutral `5123` == `totalTokenCount 5123`. A raw-heuristic scare (`promptTokensDetails[0].tokenCount=5110`) was a **detector false positive** — a modality itemization of already-counted prompt tokens — caught by the exact total reconciliation. The probe now makes reconciliation the verdict and has a self-test proving the detector both catches a planted tier and vindicates the Gemini breakdown.
- Residual (low): `cacheCreation` tier never came back non-zero on any run; it's a direct 1:1 field copy (proven by inspection), and OpenAI's `cacheRead` path was exercised end-to-end at 4992.

**The budget-cap-defeat class does not manifest in usage normalization.** A proven negative.

### 2.2 Finding #2 — the fault (loop.js:748–792)

`loop.js` short-circuits **only** `max_tokens` (BA-6, line 762 `isTruncated`). Every other non-clean stop reason falls through the "no tool calls ⇒ final answer" rule (line 775) and returns `error:null` with `text: result.text`. The clean-finish return at **line 791** carries `{text, toolCalls, usage, cost, error:null, msgs, metrics}` — **no `stopReason`** — so a caller has nothing to branch on.

Laundered stop reasons (all normalized correctly by the provider layer per BA-6, then ignored by the Loop):
- **`refusal`** — OpenAI `content_filter`, Gemini `SAFETY`/`RECITATION`/`BLOCKLIST`/`PROHIBITED_CONTENT`/`SPII`, Anthropic `refusal`. Returns as a *successful empty answer*. `RECITATION` fires on **benign** prompts ("recite the lyrics to…") → reachable on ordinary, non-adversarial runs.
- **`context_exceeded`** — ran out of context window → reads as a clean finish.
- **`pause_turn`** — resumable server-tool pause → terminates as clean-empty instead of resuming (different remedy — see §3).

Proof: `poc/audit-refusal-laundering.mjs` runs a stub provider (feeding stop-reason values the providers *provably* emit — their normalization is already live-verified by BA-6) through the REAL Loop. Result: refusal/context_exceeded/pause_turn all → `error=null, text="", stopReason=(field absent)`. Controls prove the harness is honest: `max_tokens` → `error="truncated:max_tokens"` (caught); genuine `end_turn` with text → clean (not flagged). A deterministic stub is the correct tool here, not a live safety-block (repo rule: don't assert a fragile/non-deterministic property via a live test; RECITATION documents the real-world benign trigger).

### 2.3 Finding #3 — tool required-args: no active fault

The Loop does NOT validate runtime args against the tool schema (`loop.js:914` passes `tc.arguments` straight to `tool.execute`), so each tool self-defends. Sweep:
- `shell_write` — throws on missing `path`/`content` (the original BA-4 fix; regression-tested in `shell-tools.test.js`, "BA-4" comment at ~line 306).
- `shell_run`/`shell_grep`/`spawn`/`defer` — all validate required args and **throw** → loud failure, model adapts.
- `mobile_*` / `browse_*` — **delegate** arg-validation to the `baremobile`/`barebrowse` primitives (`browse.js` is a 20-line delegator). A missing UI-action arg fails *loud* downstream, not a silent destructive no-op.
- No silent-default (`|| ''`, `?? {}`) on any required **input** — the `|| ''` hits are all on *output* (`stdout || ''`, legitimately empty).

**Latent risk (not a fault):** no central required-arg gate → a *future* tool author who forgets the guard reintroduces the BA-4 hole. See §5 for the optional hardening.

### 2.4 Finding #4 — recurse: honest, but inherits #2

recurse's worker path (`recurse.js:513–534`) keys on `out.error`:
```
if (out.error startsWith 'halt:')   → { incomplete, best: out.text||null }
if (out.error startsWith 'denied:') → { incomplete, best, blocker:'governance-deny' }
if (out.error)                      → { incomplete, best: out.text||null }   // catch-all, :527
else result = out.text                                                       // success path, :534
```
It **never reads `out.stopReason`.** Consequences (both proven by `poc/audit-recurse-refusal-inherit.mjs`, driving REAL `recurse()` with the stub):
- **Today:** refusal → `out.error=null` → catch-all skipped → recurse returns `{result:"", verdict:null}` — a safety-refused sub-task scored **converged** up an agent tree.
- **Post-fix preview:** `max_tokens` (which the Loop already errors on) → `{incomplete:true, best:"partial"}`. So once #2 sets `error:'refusal'`, the **same `:527` catch-all** turns it into honest `{incomplete}` with **zero recurse changes**.

This is the decisive argument that the fix must **error-tag, not merely surface `stopReason`**: recurse consumes `error`, not `stopReason`. Surfacing `stopReason` alone would leave recurse (and bareloop's `error===null` check) still laundering the refusal.

---

## 3. The fix — one table-driven classifier (frozen design)

Replace the single `isTruncated` short-circuit with **one terminal-classification gate over the normalized stop-reason vocabulary**, placed where `isTruncated` sits today (`loop.js` ~762, AFTER metering, BEFORE tool execution). Rationale for one classifier vs N more `if`s: BA-6 added one leg, #2 adds two more, and the *next* new stop reason re-breeds the bug. A table with an **explicit pass-through default** is the BA-7 "don't parse-key on a closed set" lesson applied here.

| Normalized `stopReason` | Classification | Loop behavior |
|---|---|---|
| `tool_use` | execute | existing tool-execution path |
| `end_turn` / `stop_sequence` (+ no tool calls) | genuine final | `error:null` + text *(existing)* |
| `max_tokens` | truncated | `error:'truncated:max_tokens'` + partial text *(existing — keep verbatim)* |
| **`refusal`** | blocked (safety) | **`error:'refusal'`** + partial text (BA-5 preserved) |
| **`context_exceeded`** | out of context window | **`error:'context_exceeded'`** + partial text |
| **`pause_turn`** | resumable | **continue the loop (bounded by HARD_ROUND_LIMIT / gate)** — NOT terminal, NOT an error |
| `null` / unrecognized passthrough | **default = pass-through-as-today** | no-tool-calls ⇒ final answer (status quo) |

**Plus the load-bearing change: surface `stopReason` on EVERY `Loop.run()` return** (all return sites, not just the clean-finish path). It is absent at `:791` today.

### 3.1 Why error-tag (not just stopReason) — three independent reasons
1. **Invariant:** 0.27.0's BA-6 adopter note promises "error is the sole success signal — check `result.error === null`." `error:null + stopReason:'refusal'` re-breeds BA-6 for these legs. Erroring keeps the invariant true.
2. **recurse:** its `:527` catch-all consumes `out.error`, not `out.stopReason` (proven §2.4).
3. **bareloop:** its `ask()`/`interpret.js` branches on the Loop's `error`.

### 3.2 pause_turn is the tell
`pause_turn` must **continue/resume**, never error — proof that #2 needs a *classifier*, not another short-circuit. (Confirm the resume path terminates: bounded by the existing round loop + gate; a stuck server-tool pause is caught by `HARD_ROUND_LIMIT`/`maxTurns`.)

### 3.3 Truncation invariants to preserve
- Do NOT execute tool calls on `refusal`/`context_exceeded` either (same as `max_tokens`): a non-final round's tool calls must not run. (In practice these rounds rarely carry calls, but the classifier should refuse them uniformly — the BA-4 protocol-layer closure.)
- Transcript-sealing rules from the `max_tokens` branch (lines 764–769: push partial text only if non-empty; never push an unpaired `tool_call`) apply to the new terminal legs too.

---

## 4. Build plan (after sign-off)

Order, incremental, each step self-contained:

1. **`src/provider-stop-reason.js`** — add a `classifyStopReason(neutral, {hasToolCalls})` (or a small terminal-map) exporting the §3 table. Keep `isTruncated` as a thin wrapper for back-compat, or inline. Default = pass-through.
2. **`src/loop.js`** —
   - Replace the `isTruncated` short-circuit (~762) with the classifier gate.
   - Add `refusal` / `context_exceeded` terminal returns (mirror the `max_tokens` return at 771: partial text sealed, `error:'<tag>'`, metrics finalized, `temperatureDropped` spread).
   - `pause_turn` → `continue` the round loop.
   - Add `stopReason` to EVERY return object (grep the return sites: 466, 694, 771, 791, 900, 974, 1004, 1010, 1017 + the stop/halt paths). Thread the last round's normalized `stopReason`.
   - Update the JSDoc return typedef (`@returns` at 349/1090) to include `stopReason`.
3. **Tests (graduate the probes to `test/`)** —
   - `test/loop.test.js` (or a new `test/loop-stop-reason.test.js`): the `poc/audit-refusal-laundering.mjs` matrix as mutation-checked units — assert `error:'refusal'`/`'context_exceeded'` + partial text + surfaced `stopReason`; `pause_turn` resumes (a 2-call stub: pause then end_turn → one clean final); `max_tokens`/`end_turn` controls unchanged. Mutation: revert a leg → test reds.
   - `test/recurse.test.js`: add the `poc/audit-recurse-refusal-inherit.mjs` case — refusal stub → `{incomplete}` (was `{result:''}`), proving the catch-all now fires. Lock the "no recurse change needed" claim.
4. **Types** — `npm run typecheck` (the return typedef change touches `.d.ts` generation).
5. **Docs (same commit — ship docs WITH code):**
   - `CHANGELOG.md` — BA-13 entry (mirror BA-6's framing: "reading stop_reason is the load-bearing change").
   - The **BA-6 adopter note** (context.md / README wherever it lives) — extend the terminal-signal list: `refusal`/`context_exceeded` now error-tagged; `stopReason` now on every return; `pause_turn` resumes.
   - The stop-reason **feature-reference table** in `docs/02-features/*` (grep it — easy to miss per the docs-sync lesson).
   - `CLAUDE.md` — only if a component ROLE/CONTRACT changed (the Loop's terminal contract did → a short edit to the Loop row is warranted; keep it MAP-not-LOG).
6. **Verify-shipped** — a live smoke is NOT required (the fault + fix are deterministic and provider-agnostic; BA-6 already live-verified the stop-reason *values*). The graduated deterministic units are the proof. Optionally, a live RECITATION attempt as a bonus reachability demo — but do not gate on it (non-deterministic).
7. **Release** — full manual OIDC flow (CHANGELOG cut → version bump in 3 spots → full test → merge to main → tag → gh release → manual `workflow_dispatch` publish). Verify all four surfaces agree.

---

## 5. Optional companion — #3 central required-arg gate (separate, lower priority, NOT part of BA-13)

A shared `required`-arg check in the Loop before `tool.execute` (`loop.js:914`): if the tool's `parameters.required[]` names a key absent from `tc.arguments`, reject with a tool error fed back to the model (allowlist-safe — the model can retry with the arg). Closes the class for ALL tools including future/delegated ones, same "one gate" philosophy as BA-13. File as its own item; do not bundle.

---

## 6. Downstream / consumer follow-ups (bareloop "OUR SIDE" — the adopter's repo, not this one)

Freeze the upstream `error` vocabulary FIRST, then build the bareloop branch against the stable contract. Mapping the adopter must add (do NOT build until upstream ships):
- `error:'refusal'` → **gate-red** (governance-adjacent, like a fence deny) — NOT the `truncated:` provider-reinterpret path (a safety refusal is not a broken middle).
- `error:'context_exceeded'` → **cap-halt-adjacent** (ran out of room — a spend/limit story).
- `error:'truncated:max_tokens'` → provider-reinterpret (existing).
- Ship the upstream fix and the bareloop branch together.

---

## 7. Open decisions needing sign-off (before any source change)

1. **The `error` vocabulary** — confirm `error:'refusal'` and `error:'context_exceeded'` as the exact tags (vs. e.g. `'refusal:<subreason>'` carrying the provider's specific reason). Recommendation: bare tags for the first cut (symmetry with `truncated:max_tokens`); a sub-reason suffix can follow if adopters need it.
2. **`error:null → 'refusal'` shift is a behavior change** for anyone currently treating a refused round as an empty success. It's the point of the fix, but it's the one thing that changes existing return values — call it out in the CHANGELOG as a (correct) behavior change.
3. **pause_turn resume bound** — confirm relying on `HARD_ROUND_LIMIT`/gate `maxTurns` is sufficient (no dedicated pause counter). Recommendation: yes — a stuck pause is just a non-progressing loop the existing bounds already catch.

---

## 8. Evidence artifacts (kept — living regression probes, not throwaway POCs)

- `poc/audit-usage-tiers.mjs` — #1, live, reconciliation verdict + offline self-test (`--selftest-only`).
- `poc/audit-refusal-laundering.mjs` — #2, deterministic, real Loop + controls.
- `poc/audit-recurse-refusal-inherit.mjs` — #4, deterministic, real recurse, refusal-vs-max_tokens matched pair.

All three exit 1 on the fault and are safe to re-run any time. They graduate to `test/` in step 3.
