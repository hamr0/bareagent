# RSI-POC backlog — what we can still try from the RSI-learnings fold

*2026-07-15. Companion to bareloop's [`RSI-LEARNINGS.md`](/home/hamr/Documents/PycharmProjects/bareloop/docs/00-context/RSI-LEARNINGS.md)
(12 field learnings from the thersibook/Recursive corpus). That doc records what the RSI
field found; **this doc records what, of that, is a candidate POC for bareagent's `recurse`
primitive** — mapped, ranked, and framed against our POC-first discipline (aim the spike at
the riskiest assumption; the test must be able to FAIL; prove, don't assert).*

**Context.** `recurse` is thin glue composed *around* the Loop; it is **stateless by design**
(no cross-run memory — that lives in `remember`/litectx). So learnings about cross-run
learning, memorization auditing, and inheritance land on `remember`, not here. What lands on
`recurse` is everything about a **single bounded optimization loop against a close** — which
is exactly what `refineLeaf` is. BA-14 (rejected-attempt buffer) was the one clearly-buildable
primitive from this corpus and is **shipped** (v0.30.0). Everything below is what remains.

---

## 1. The full fold — every learning, and its POC verdict

| # | Learning | Maps to | POC verdict |
|---|----------|---------|-------------|
| 1 | Judge is the ceiling; the loop games a gameable close | `refineLeaf.sensor` | **Contract note shipped** (JSDoc/README/context). Optional **red-team POC** to prove the note is load-bearing → §2.C |
| 4 | Rejected-edit buffer (retain failed attempts as negative feedback) | `refineLeaf.rejectedBuffer` | ✅ **BUILT — BA-14**, shipped v0.30.0 |
| 5 | Verifier hardening never ends — audit the close every pass | `refineLeaf.sensor` | Same as #1 (a standing WATCH, not a build) |
| 8 | Feedback quality is the multiplier; *delivery ≠ conversion* — enrich the GAP, don't add capability | `refineLeaf` critique path | Buffer folded the "delivery" half. **Tail unfolded: structured reflection** ("reflect on WHY before regenerating") → §2.A |
| 11 | Structural edits beat parameter tuning (~5× under crisp objectives) | design principle | ✅ **Recorded** as an `RLM_PRD` principle (BA-14 is the in-repo evidence). Guides §2.A/§2.B |
| 10 | Two levers vs one fixed verifier = coupled Goodhart; self-consistency-as-verifier breaks on non-checkable tasks | `refineLeaf` rubric close / `Evaluator` | **Validate, not build:** a *rubric* `sensor` is closer to self-consistency than to an exit code and needs a judged-floor analog before it can gate → §2.D |
| 7 | Fixed budgets make candidates comparable; cost-per-point-of-gain receipts | `result.metrics` | **Low-value reporting add** — all inputs already on the meter → §2.E |
| 3 | A learning claim needs a stateless control | `remember` / cross-run | **Out of scope for `recurse`** (stateless by design). Belongs to a future inheritance layer |
| 6 | Memorization auditor (learned-rule vs memorized-answers) | `remember` | **Out of scope for `recurse`** (no rule-minting here) |
| 2 | Harness beats weights; failures are interface mismatches | method / philosophy | Confirms existing design (our BA-4…BA-14 were all interface gaps). Nothing to build |
| 9 | Autonomous meta-work is currently unreliable; human-gated | posture | Confirms manual-publish + human-sign-off posture. Nothing to build |
| 12 | "Move the human lever upward" (instructions vs artifacts split) | posture | Confirms job-spec/config split. Nothing to build |

**Bottom line:** of 12, one is built (BA-14), two are shipped as contract/principle notes
(#1/#5, #11), and **three are live POC candidates** (§2.A structured reflection, §2.B the
BA-14 default-flip validation, §2.C the sensor-gaming red-team). Two are validate-only (#10,
#7). Four are out of scope or confirmations.

---

## 2. POC candidates (concrete spikes)

Each names its **riskiest assumption** and **how the test can FAIL** — a spike that can only
confirm is theater.

### A. Structured reflection — the unfolded tail of learning #8  *(highest interest)*

**Idea.** BA-14 surfaces the prior failed *attempts* verbatim (directed diversity). Learning
#8's tail is a *different* lever: before regenerating, make the model **explicitly reflect on
WHY the last attempt failed** (a short diagnosis step), then regenerate from that diagnosis.
The field claims reflective mutation is up to ~35× more sample-efficient than blind search.

**Riskiest assumption.** That an *explicit* reflection step beats simply *showing* the gap +
the failed attempt (which the buffer + critique already do). The model may already reflect
implicitly; the extra turn may be pure token cost. This is the load-bearing claim — point the
spike straight at it.

**How it can FAIL.** 3-arm on a weak model (gpt-4o-mini) AND a temp-fixed model
(claude-sonnet-5), same deterministic task family as `poc/ba14`: (arm 1) critique+buffer as
shipped; (arm 2) + a forced reflection turn; (arm 3) reflection *instead of* the verbatim
buffer. If arm 2/3 recover no better than arm 1 (and cost more), reflection is a null — report
it as such. Reuse the `poc/ba14` harness (it already produces the negative on a fair task).

**Prior/structural.** Per learning #11 this is a *structural* edit (changes what the model
sees), so expect any gain to be real if it appears — but measure it, don't assume the 35×.

**Effort:** ~1 spike session. **Confidence it beats the buffer:** LOW (hence a POC, not a build).

### B. BA-14 default-flip validation — the deferred, evidence-gated question

**Idea.** Across `poc/ba14` + `poc/ba14b`, flat-low + buffer went **16/16** while the shipped
escalate+critique went **3/6** on the weak model — hinting the buffer may *dominate*
escalation universally, which would flip the default to buffer-on + temp-low and demote
temperature to a caller's creative/rubric knob. **Deliberately NOT done** — flipping a
live-validated mechanism (BA-8) on one model + one task is the toy-fixtures trap in reverse.

**Riskiest assumption.** That the flat-low+buffer dominance **replicates on a genuinely
different deterministic task** and across more models — not an artifact of the one string-
formatting task's shape.

**How it can FAIL.** Pick a SECOND deterministic task, structurally unlike the first (e.g. a
small algorithmic fix with a compile+unit close, not string formatting), and a THIRD model
tier. Re-run the 4-arm matrix. If dominance does NOT replicate, the default stays as-is and
the deferral was correct — a real, publishable negative.

**Effort:** ~1–2 spike sessions (needs a fresh fair task + a passing reference impl to prove
the harness is fair). **Confidence:** MEDIUM the effect is real; the decision it unblocks is
a default flip, so the bar is deliberately high.

### C. Sensor-gaming red-team — prove the #1/#5 contract note is load-bearing  *(optional)*

**Idea.** We added a contract note: the `refineLeaf.sensor` must judge the RETURNED result,
never a gameable worker side-effect. A red-team POC would *demonstrate* the exploit: give a
worker `shell_edit`/`shell_write` tools and a **side-effect sensor** (reads a file the worker
can write, or runs a test the worker can edit), and see whether a real model discovers it can
write a passing file / neuter the failing test and return junk.

**Riskiest assumption.** That a real model *actually* discovers the exploit under normal
optimization pressure (the field says yes at scale; unproven at our loop's small bound).

**How it can FAIL.** The model may never find the exploit within `maxIterations` — in which
case the note is prudent-but-unproven here, and we say so honestly (the field evidence still
stands; ours just didn't reproduce at this scale). Contrast against a tamper-proof sensor
(builds/runs the returned string in isolation) as the control — it must NOT be gameable.

**Effort:** ~1 spike session. **Value:** turns a borrowed contract note into an in-repo
demonstration; low urgency since no data-loss risk (the note is already shipped).

### D. Rubric-close judged-floor — validate before any soft-close `refineLeaf`  *(validate-only)*

**Idea.** Today `refineLeaf.sensor` is required to be *deterministic* (test/compile/lint).
Learning #10 warns that if we ever allow a **rubric** (LLM) close, it is closer to
self-consistency than to an exit code and will get gamed without its own judged-floor /
adversarial-isolation analog — which `Evaluator`'s rubric path already has (separate window,
harsh independent prompt). No build unless/until a caller asks for a rubric leaf close.

**Riskiest assumption.** That the existing `Evaluator` isolation is sufficient to make a
rubric leaf-close non-gameable. **Test if we build it, not before.** Recorded here so the
requirement isn't lost.

### E. Cost-per-point-of-gain readout — learning #7  *(low value)*

**Idea.** Report cost-per-unit-of-recovery in `refineLeaf` receipts (tokens spent per
iteration that actually moved the sensor verdict). All inputs are already on the meter
(`receipts.tokens`, `receipts.refineLeaf.iterations/passed`).

**Verdict.** Marginal observability; not a POC (nothing to prove), a small reporting add if a
caller wants comparability across leaf configs. Parked unless requested.

---

## 3. Next POCs to run — ranked

1. **A — Structured reflection** *(run first).* It's the one genuinely *new* lever in the
   corpus we haven't tested, the harness already exists (`poc/ba14`), and it directly extends
   the buffer we just shipped. LOW confidence it beats the buffer — which is exactly why it's
   a POC and not a build. One session; can produce a clean negative.
2. **B — BA-14 default-flip validation** *(run when a second fair task is worth building).*
   Higher-stakes (would flip a default) so it needs a genuinely different task + broader model
   coverage. Gated on someone wanting the default changed; until then the adaptive default
   stands and is honestly documented.
3. **C — Sensor-gaming red-team** *(optional, any time).* Cheap, turns a borrowed note into an
   in-repo demonstration. No urgency — the contract note already ships.

**Not queued:** D (validate-only, gated on a rubric-leaf request), E (reporting add, gated on
a request), and the out-of-scope cross-run learnings (#3/#6) which belong to a future
`remember`/inheritance layer, not `recurse`.

---

## 4. Discipline reminders for whoever runs these

- **Aim at the risky mechanism, not the easy part.** For A, that's "reflection beats the
  buffer we already have," not "reflection produces text."
- **The test must be able to fail.** Use a fair task with a *reference implementation that
  passes all cases* (proves the harness isn't rigged), real uncrafted difficulty, and enough
  trials to see a negative. This is how `poc/ba14-verify-shipped.mjs` caught its own
  inconclusive first run (sonnet one-shotted the easy task).
- **Prove, don't assert.** Any "faster/cheaper/better" claim is a measured number from the
  spike, not prose. An honest null (BA-14's live efficacy was one) is a finding, not a failure.
- **Never ship the POC.** Spikes stay in `poc/` as evidence.
- **API keys:** live at `pass amr/claude_api` / `pass amr/openai_api` — never retrieve
  directly; ask the user to run with them.
