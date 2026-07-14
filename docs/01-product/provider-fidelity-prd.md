# bareagent — Provider Fidelity & Honest Termination PRD

**Status:** PROPOSED (2026-07-14) — awaiting sign-off. Two items SHIPPED, four open.
**Owner:** hamr0
**Source:** bareloop's round-4 isolation study (`/home/hamr/Documents/PycharmProjects/bareloop/docs/UPSTREAM-FIXES.md`) + this repo's own live verify-shipped runs.
**Language:** Node.js (JS + JSDoc), CJS surface. No new deps.

> **What this PRD is.** A single theme runs through every open item: **bare-agent is lying to its caller about what happened on the wire.** A truncated round is reported as a finished answer. A model's reasoning is silently dropped from the protocol. A bound firing erases the work (fixed). A zero-content write is reported as a successful one (fixed). Each is the same defect class — *the library decides, on the caller's behalf, that something didn't happen* — and each was found by an adopter running real models against a real repo, not by our tests.
>
> **What this PRD is NOT.** A performance program. The one item here that *looks* like it should make agents smarter (BA-7, thinking blocks) **demonstrably did not** — see §0. It is filed because the protocol is wrong, and for no other reason.

---

## 0. The finding that governs how these are framed

bareloop ran the decisive isolation test before we built anything, and it came back **negative for the appealing hypothesis**:

> Head-to-head, same model, same task, same tools: raw Anthropic SDK with thinking fully preserved (24000 max_tokens, clean 40-line loop, no governance) vs. stock bare-agent. **Four runs. Both arms never touched the target file. Zero writes. Same wrong hypothesis, in the same order.** The raw arm genuinely had the variable on — 5/12 and 8/12 rounds carried preserved reasoning — and made more tool calls than any other run. **Still never opened the file.**

And the harness-free probe that settled it ($0.14, no tools, no loop): given the failing tests plus a file whose *first line* is `import { ftsMatch, keywords } from './tokenize.js'`, and asked which file to open next, the model twice answered `index.js` — reading the import, declaring the store correct, and going **up** the abstraction stack into the facade rather than **down** into the helper it imports.

**Conclusion: the agent's aim ceiling is the model's debugging strategy, not our library.** Therefore:

- **BA-7 is filed as a PROTOCOL bug, never as a performance fix.** Fixing it moved no outcome in bareloop's n=2. Any PR, CHANGELOG line, or docs note that implies otherwise is wrong and must be corrected. We fix it because we are misusing an API contract, full stop.
- We do not get to claim a fix "improves agent reasoning" unless something measures that. Nothing here does.

This section exists so that a future contributor cannot quietly re-sell BA-7 as a capability win.

---

## 1. Scope

| # | Item | Severity | Status |
|---|------|----------|--------|
| **BA-4** | `shell_write` zeroes a file when `content` is missing | CRITICAL | ✅ **SHIPPED** (this branch) |
| **BA-5** | Bounds discard the model's text (+ BA-3 `stop()` sub-case) | HIGH | ✅ **SHIPPED** (this branch) |
| **BA-6** | A truncated round reads as a clean finish | **CRITICAL** | ✅ **SHIPPED** (this branch) — and it closes BA-4's ROOT cause: a truncated round's tool calls are now refused, never executed |
| **BA-7** | Thinking blocks neither requested nor preserved | HIGH (protocol) | 🔴 OPEN — F2 |
| **BA-12** | A repeated tool ERROR spins unbounded | MEDIUM | 🔴 OPEN — F3 (found by our own smoke) |
| **BA-1** | Anthropic transcript is re-bought every round (no cache breakpoint) | HIGH ($) | 🔴 OPEN — F4 |

**Not filed / closed:** bareloop's "BA-8" (`loop.stop()` returns a false 100-round-limit error) is **BA-3**, already folded into BA-5 and shipped. Independent rediscovery — good confirmation, no new work. S3 (summarizer fold) and S4 (tool-result history) were investigated and **KILLED**: a default Loop wires neither `assemble` nor `trim` (`loop.js:253,262`), the full transcript is replayed every round (`toSend = msgs`, `loop.js:621`), and there are **zero** truncation/slice calls in `loop.js`. bare-agent is exonerated on both.

---

# F1 — BA-6: a truncated round must never read as a completed one

## 1.1 The defect

`src/provider-anthropic.js` **never reads `stop_reason`** — zero occurrences in the file. The response parser (`:108-113`) walks `data.content` and collects only `text` and `tool_use` blocks. So when a generation is cut off at `max_tokens`, the provider returns `{text: <partial or ''>, toolCalls: []}`, and `loop.js:670` — whose rule is *"no tool calls ⇒ the LLM gave its final answer"* — **ends the run cleanly with `error: null`**.

Compounding it: `max_tokens` defaults to **4096** (`:82`), which is low for a model that thinks by default. `claude-sonnet-5` runs adaptive thinking and can spend the entire budget inside `thinking` blocks, returning **no text and no tool_use at all**.

**A silently truncated round is indistinguishable from a model that chose to stop.** The attempt ends, `error: null`, empty result — and the caller has no way to know the difference.

## 1.2 Evidence (measured live, this repo, `claude-sonnet-5`)

Raw wire, `max_tokens: 1024`, a reasoning-heavy prompt with a tool available:

```
stop_reason   : max_tokens
content blocks: ["thinking","text"]
output_tokens : 1024          ← the cap, exactly
tool_use count: 0
```

The **same call through bare-agent**:

```
result.error  : null          ← reported as a clean, completed run
tool calls    : 0
rounds        : 1
```

bareloop measured the harsher variant independently: `max_tokens=4096 → stop_reason=max_tokens, out=4096, content=[thinking], TEXT=0B` — a completely empty "successful" answer.

## 1.3 The fix

1. **Provider surfaces the truth.** `GenerateResult` gains `stopReason` (normalized, provider-neutral: `'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | string`). Every provider maps its native field (`stop_reason` / `finish_reason` / `finishReason`); absent ⇒ `null`. Additive, back-compatible.
2. **The Loop refuses to call a truncation a completion.** A round with `stopReason === 'max_tokens'` and no tool calls MUST NOT take the clean-completion return. It ends the run with a distinct, honest error token — **`error: 'truncated:max_tokens'`** — preserving the partial text (BA-5's contract already does the preserving). It is a *bound*, and it reports like one.
3. **Raise the default.** `max_tokens` default `4096` → a documented, model-aware default. **Open decision (D1)** — see §5.

**Why an error token and not a retry.** The library must not silently re-issue a bigger call: that doubles spend on a budget the gate is enforcing, and the right recovery (raise the cap? shorten the task? split it?) is the caller's call. We *report*; they *decide*. This is the same reasoning as BA-5.

## 1.4 Acceptance criteria (must be able to fail)

1. `stopReason` is on `GenerateResult` for all four providers; a fixture response with `stop_reason: 'max_tokens'` surfaces `'max_tokens'`.
2. A scripted Loop whose provider returns `{text: 'partial', toolCalls: [], stopReason: 'max_tokens'}` returns **`error: 'truncated:max_tokens'`** and `text: 'partial'` — **NOT** `error: null`.
3. **Negative control:** the same response with `stopReason: 'end_turn'` returns `error: null` — proving the check reads the flag, not the weather.
4. **Negative control 2:** a provider that reports no `stopReason` at all (`null`) behaves exactly as today — no false truncation errors for OpenAI-compatible or CLI providers that omit it.
5. ~~A `max_tokens` truncation that *does* carry tool calls still executes them — we do not drop work that arrived intact.~~ **INVERTED by measurement (`poc/ba6-stop-reason-mapping.mjs`), and this is the most important thing the POC bought.** The premise was false: **a complete tool call is *always* tagged `tool_use`, never `max_tokens`.** Anthropic returned a complete `tool_use` even at a 1024-token cap; OpenAI 400s rather than emit a call it cannot finish. So no work "arrives intact" on a truncated round — a tool call riding one was **cut off mid-generation, with arguments missing keys**, which is *precisely* how BA-4's worker emptied a 1789-line file (`shell_write` with no `content`). **Corrected criterion: the Loop MUST NOT execute the tool calls of a `max_tokens` round.** Refusing costs nothing legitimate and closes BA-4's root cause at the protocol layer, for every tool. *(Lesson: the spec was written from a source-read; the wire disproved it. bareloop's own BA-4 report contained the disproof and neither of us saw it.)*
6. **Live, on `claude-sonnet-5`:** the §1.2 reproduction (`max_tokens: 1024`, reasoning-heavy prompt) now returns `error: 'truncated:max_tokens'` instead of `error: null`.
7. **Deliberately NOT truncations:** `pause_turn` (a *resumable* server-side-tool state), `refusal`, `stop_sequence`, `context_exceeded`. Erroring on `pause_turn` would break server-tool flows that are working as designed.

---

# F2 — BA-7: thinking blocks are neither requested nor preserved

> **⚠️ READ §0 FIRST. This is a PROTOCOL bug. bareloop's head-to-head showed that fixing it moved NO outcome (n=2, both arms failed the task identically). Do not describe this fix as improving reasoning, aim, or agent quality — it does not, and we have the measurement. It is filed because we are violating an API contract.**

## 2.1 The defect

Three distinct gaps, all confirmed by source read + live wire:

1. **Never requested.** The request body (`provider-anthropic.js:80-93`) has no `thinking` parameter. Extended thinking is never enabled by bare-agent.
2. **Discarded at parse.** The block loop (`:108-113`) handles `text` and `tool_use` only. A `thinking` block is silently dropped on the floor.
3. **Cannot survive replay even if kept.** `_toAnthropicMessage` (`:142-171`) *rebuilds* assistant messages from the OpenAI shape (`content` string + `tool_calls`). There is **no field on the message that could carry a thinking block or its signature.**

**Sonnet thinks by default.** Live, with no thinking requested: `content blocks: ["thinking","text","tool_use"]`. So every multi-round Anthropic run bare-agent has ever done has thrown the model's reasoning away each round. Anthropic's API requires thinking blocks be passed back **unmodified** (signature intact) when continuing an extended-thinking conversation that uses tools — we do not.

## 2.2 The fix

Carry provider-native content through the transcript instead of flattening it:

- `GenerateResult` gains `raw` (the provider's own content blocks, opaque to the Loop).
- The Loop stores that blob on the assistant message it pushes (an opaque passthrough field — the Loop MUST NOT interpret it).
- `_toAnthropicMessage` replays those blocks **verbatim, signature intact**, ahead of the reconstructed `text`/`tool_use` blocks.
- `AnthropicProvider` gains an opt-in `thinking` option — mirroring `cacheSystem`'s opt-in shape.

> **⚠️ CORRECTION (2026-07-14).** An earlier draft of this line specified `thinking: {type: 'enabled', budget_tokens: N}`. **That shape is REJECTED with a 400** on `claude-sonnet-5` and Opus 4.7/4.8 — `budget_tokens` was removed from the API. The correct opt-in is **`thinking: {type: 'adaptive'}`**, with depth controlled by `output_config.effort` (`low`…`max`), and `display: 'summarized'` if the reasoning is to be surfaced (the default is `'omitted'`, which returns thinking blocks with **empty text**). bareloop's original ask had this right; the error was introduced when this PRD rewrote it. Whoever builds BA-7 must verify against the live API before coding — a recalled schema is not a source.

**Provider-agnostic by construction:** `raw` is an opaque passthrough. No other provider reads it; the Loop never inspects it. This is the only shape that doesn't leak Anthropic into the core.

## 2.3 Acceptance criteria (must be able to fail)

1. A multi-round Anthropic tool-loop replays the assistant's `thinking` blocks byte-identically, **signature preserved**, in round N+1's message array (assert against the outbound request body, not the response).
2. **Negative control:** with thinking absent from the response, the outbound body is byte-identical to today — no empty/synthetic blocks injected.
3. A thinking block whose signature is missing or malformed is **dropped, not sent** — a rejected request is worse than a lost block.
4. Non-Anthropic providers are untouched: `raw` is ignored, transcripts unchanged.
5. Opt-in `thinking` produces `thinking` blocks; unset produces today's behaviour.
6. **The honesty criterion:** the CHANGELOG entry, JSDoc, and any docs state that this **did not change task outcomes** in the adopter's head-to-head. A PR that omits this fails review.

---

# F3 — BA-12: a repeated tool ERROR spins unbounded

## 3.1 The defect (found by our own BA-4 verify-shipped run — not filed by an adopter)

`maxConsecutiveDenials` (BA-11) bounds a model that keeps retrying a **policy-denied** action. It counts *denials*. It does **not** count **tool errors** — so a model that keeps re-issuing a call whose `execute` throws spins until the budget cap, with no progress.

This is not hypothetical: it is the direct consequence of shipping BA-4's guard.

## 3.2 Evidence (live, this repo)

BA-4's guard converts a truncated `shell_write` into a thrown `ToolError`. Under a 200-token cap (where the body is *physically* unemittable, so recovery is impossible):

| model | behaviour under the shipped guard |
|---|---|
| `claude-haiku-4-5` | 1 rejected call, then **stopped and asked a question** — safe |
| `claude-sonnet-5` | **spun: 8/8 consecutive rejected calls**, halted only by a stand-in gate |

**No data loss in either case** (file byte-identical, 2909 B → 2909 B — the guard is load-bearing). But sonnet made zero progress and would have burned to the budget cap without a gate.

## 3.3 The proposed fix — **needs a decision (D2, §5)**

Generalize BA-11 from "consecutive denials" to "consecutive **fruitless** tool calls" — a counter incremented by a policy deny **or** a tool error, reset by any tool call that returns successfully. Same default (3), same clean `error` return, same disable switch.

**The argument against** (and why this is a decision, not a build): a tool error is *sometimes* legitimately recoverable — a model that gets `ENOENT`, fixes the path, and succeeds is exactly the pivot we want to preserve, and consecutive-counting already allows it (the streak resets on success). But a **transient** error (a flaky network tool) retried 3× would now kill the run where today it recovers on the 4th. That is a real regression risk and the reason this is not a slam dunk.

**Options:** (a) count tool errors into the existing streak; (b) a separate, higher threshold for tool errors; (c) count only *identical repeated* calls (same tool + same args hash) — narrowest, targets the spin precisely; (d) do nothing, document that a gate is mandatory. **Recommendation: (c)** — it targets the observed failure (byte-identical retry of an impossible call) without penalising a model that varies its input in response to an error.

## 3.4 Acceptance criteria (must be able to fail)

1. A Loop whose tool throws identically N times short-circuits with a distinct error token, transcript sealed.
2. **Negative control:** a tool that errors once then succeeds runs to completion — the guard must not fire on recoverable errors.
3. **Negative control 2 (the regression risk):** a tool that errors with *varying* args (a model genuinely adapting) does not trip the guard under option (c).
4. The existing BA-11 denial behaviour is unchanged.

---

# F4 — BA-1: the Anthropic transcript is re-bought every round

## 4.1 The defect (bareloop's, unmodified)

`cache_control` can only be placed on `system` (`cacheSystem`), never on `messages`. In a tool loop the transcript *is* the tool results and it always **ends** on one, so no caller-side seam can reach it — `assemble` included, since `_toAnthropicMessage` rebuilds `role:'tool'` messages into fresh `tool_result` blocks and discards anything attached. The loop re-sends its entire growing transcript as fresh, full-price input every round.

## 4.2 Evidence (bareloop's, measured on the real API, one knob apart)

| | round 1 | round 2 | round 3 | round 4 |
|---|---|---|---|---|
| today (no breakpoint) | $0.1524 | $0.1525 | $0.1525 | $0.1526 |
| with breakpoint | $0.1903 *(writes cache)* | **$0.0162** | **$0.0162** | **$0.0163** |

**9.4× cheaper per round in steady state.** The flat first row is the bug — the same 50,484 tokens, re-bought forever. End-to-end on their job, the same $1.50 bought ~4× the context throughput.

## 4.3 The fix

A rolling `cache_control: {type:'ephemeral'}` breakpoint on the last content block of the last message, rolled forward each round. **Open decision (D3): default ON or opt-in `cacheMessages`?** bareloop asks for default-ON, arguing the failure mode of *not* caching is a silent 5–10× bill with no error and no signal.

**Interaction to respect:** destructively editing the *prefix* (a `trim`/stash fold) invalidates the cache — folds must keep the head stable, or the cache write is paid repeatedly for nothing. This must be documented alongside the stash skill, not just here.

## 4.4 Acceptance criteria (must be able to fail)

1. Two-round integration test on the real API: round 2's `cache_read_input_tokens > 0`. **Without the fix this is 0** — that is the failing test.
2. Round 1 reports `cache_creation_input_tokens > 0`.
3. **Negative control:** with the flag off (if opt-in), both tiers are 0.
4. A transcript **below** the cache minimum still succeeds (Anthropic silently doesn't cache — must not error).
5. Tool-result-terminated transcripts are covered — that is the shape that matters, and the one `_toAnthropicMessage` rebuilds.
6. A `trim` fold that rewrites the prefix does not silently pay the cache-write premium every round (measure it; document the interaction).

---

## 5. Decisions — SIGNED OFF (hamr, 2026-07-14)

All four resolved to the recommended option. **D1:** keep `max_tokens` at 4096; make truncation loud (shipped in BA-6) and document raising it — a silent cost increase is the same class of sin as a silent truncation. **D2:** identical-repeated-call detection for the BA-12 spin guard (narrowest; won't break a model legitimately recovering from an error). **D3:** BA-1 message caching ships **opt-in** (`cacheMessages`) for one minor, then flips to default-ON once we have our own measurement — default-ON changes every adopter's wire format on the strength of one upstream report. **D4:** build order **BA-6 → BA-1 → BA-12 → BA-7**.

*Original table retained below for the reasoning.*

## 5a. Open decisions (as put to sign-off)

| # | Decision | Recommendation |
|---|---|---|
| **D1** | BA-6: what should `max_tokens` default to? 4096 is too low for a thinking model, but a large default silently raises everyone's ceiling (and a runaway's cost). | **Keep 4096 as the default, but make truncation LOUD (F1) and document raising it for thinking models.** A silent cost increase is the same class of sin as a silent truncation. Reject "just raise it" as the whole fix. |
| **D2** | BA-12: which spin-guard shape? (a) count tool errors, (b) separate threshold, (c) identical-call detection, (d) nothing. | **(c)** — targets the observed spin without breaking legitimate error-recovery. |
| **D3** | BA-1: message caching default-ON or opt-in? | **Opt-in (`cacheMessages`) for one minor, then flip to default-ON** once we have our own measurement. Default-ON changes every adopter's wire format and cache-write bill on a single upstream report; I want our own number first. |
| **D4** | Build order. | **BA-6 → BA-1 → BA-12 → BA-7.** BA-6 is critical and cheap. BA-1 is the biggest $ win and independent. BA-12 is a consequence of code we just shipped. BA-7 is the largest change and — per §0 — the one with **no measured benefit**, so it goes last despite being intellectually the most interesting. |

## 6. Non-goals

- **Making the agent debug better.** §0 settles that this is a model-strategy ceiling. bareloop's cheap harness-free probe ($0.14, n=20 for ~$3) is the right instrument for that question, and it lives in *their* repo, not ours.
- **A retry-on-truncation policy.** We report; the caller decides (§1.3).
- **Interpreting `raw` content blocks in the Loop.** It is an opaque passthrough or it is provider lock-in.
