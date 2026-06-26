# RLM_EXPLAINED — Recursive Language Models, Coding Agents & the Loop

> Session capture (2026-06-26). A grounded walkthrough of Recursive Language
> Models (RLM), recursive coding agents, the two orchestration families, how the
> "LLM-from-code" loop actually works, where Markdown specs (`prose.md` /
> `AGENT_RULES`) fit, and what — if anything — this means for litectx and
> bareagent. Sources listed at the bottom; every claim here traces to one of them.

---

## 0. TL;DR

- **RLM's one idea:** stop stuffing data into the context window as *tokens*. Keep
  it *external* and let the model **query it through handles** (grep a file, or
  `recall()` a store). The model reasons over small slices, never the whole blob.
- **Recursion = the model (or the harness) re-invoking the same loop on a
  sub-problem**, each child in a **fresh context window**, bounded by hard guards.
  It's map-reduce where "map" is an LLM call and the base case is a depth limit.
- **A loop is a rigid shell wrapped around an adaptive filling.** The loop code
  never changes; the *context* you assemble each turn changes; the **Markdown
  spec is the constant setpoint** injected every turn. Thermostat, exactly.
- **Two families:** (A) *model-driven* runtime recursion — the model decides when
  to recurse (`unix-rlm`, `ypi`); (B) *author-driven* deterministic orchestration —
  the structure is pre-written, an engine runs it (`CodeMachine`, OpenProse,
  Claude dynamic workflows). The mature design is **B-shell with an A-tool**.
- **Self-evaluation is a trap** (sycophancy / reward-hacking). Fix: deterministic
  checks wherever possible; model judgment only for the residue; and that judge
  must live in a **separate context** from the generator. (This is litectx's R-S8
  finding restated.)
- **Capability is rarely the bottleneck — composition/trust is** (MGH + OpenProse,
  §10). The loop is how you *utilize* a strong model, not crutch a weak one. And
  Family B buys *predictability + inspectability, not determinism* — only the
  control flow is deterministic, never the outcome.
- **You often don't need recursion.** Depth-1 **fan-out-with-handles** already
  delivers the context-discipline win; recursion only earns its keep when a single
  subgoal overflows one window (§11, the aurora SOAR case study). Fan-out *is*
  depth-1 recursion — the same `spawn` primitive, one depth knob (§12). The RLM
  paper confirms it: **depth=0 (REPL handle, no sub-calls) already beats most
  baselines**; recursion only helps *information-dense* tasks (§10F).
- **litectx never becomes a loop.** It is the *handle layer* (`recall`/`get`/
  `impact`/`assemble`/`scoped`) that a recursive harness in **bareagent** queries.
  No LLM inside litectx — that's the moat.

---

## 1. The core idea: context as a handle, not as tokens

Normal LLM use: put everything in the prompt, get one answer. The window is finite
and degrades as it fills ("context rot" / "context anxiety").

**Recursive Language Models** flip it. The context is **not** in the prompt — it's
a *variable in an environment the model can poke at*. The root model gets a small
prompt: *"your data is in `$CONTEXT` (a file / a REPL variable); you have tools;
investigate it and emit `RETURN <value>` when you know the answer."*

So instead of *reading* a 500k-token document, the model runs `grep`, `head`,
`wc -l`, slices out the relevant 2k tokens, and reasons over **that**. The full
data never enters the window. `ypi` states it plainly: *data lives in files, not
just tokens; agents manipulate via grep/sed/cat for precision.*

**Why this is litectx-shaped:** `unix-rlm`'s handles are raw bash. litectx is the
**structured, code-aware** version of the same handle — `recall()` (ranked search),
`impact()` (blast-radius), `assemble()` (budget-fit), `scoped()` (tenant fence).
RLM is the *consumer pattern*; litectx is *the substrate it queries.*

---

## 2. Simplest example — the flow, no jargon

Task: **"average word count of the 10,000 files in `/logs`"** — too big to read.

A plain LLM can't. An RLM-style loop never reads the logs — it *measures* them:

```
Turn 1  model emits:  ```repl
                       find /logs -type f | wc -l
                       ```            → harness runs it → "10000"  (fed back)
Turn 2  model emits:  ```repl
                       cat /logs/* | wc -w
                       ```            → "4200000"                  (fed back)
Turn 3  model emits:  RETURN 420      → harness prints 420, exits.
```

Three turns. The window held ~50 tokens of numbers — never the 4M words. The model
reasoned over **handles** to the data, not the data.

**Where recursion enters** — if the task were *"summarize the themes across all
10k logs"* (no `wc` can do that):

```
Turn 1  model: "too big — split and recurse"
        ```repl
        for chunk in /logs/batch_*; do
          rlm "summarize the themes in $chunk" >> /tmp/partials.txt
        done
        ```
        → each `rlm` call = a FRESH model + FRESH window on 1/100th of the data
Turn 2  ```repl
        cat /tmp/partials.txt   # 100 short summaries — now this FITS
        ```
Turn 3  RETURN "<combined themes>"
```

Map-reduce, where "map" is the model recursively calling its own harness, and the
**depth limit is the base case.** The root never saw the raw logs — only 100 child
summaries, each child also small-context.

---

## 3. The mental model that unlocks everything: rigid shell + adaptive filling

A loop is **three layers**. "Rigid" and "adaptive" aren't in tension — they're
*different layers*:

```
┌─ RIGID (code, written once, never changes at runtime) ──────────┐
│  the loop:   while not done:                                    │
│                window = assemble(SYSTEM_MD, goal, history)      │
│                action = LLM(window)          ← the ONE call out │
│                result = dispatch(action)     ← run what it said │
│                history.append(result)                           │
│                done   = check_stop(result)                      │
│  the guards: depth<3, budget>0, calls<N, timeout                │
└─────────────────────────────────────────────────────────────────┘
        ▲                          │
        │ injected every turn      │ the model's free choice
┌───────┴───────────┐     ┌────────▼─────────────────────────────┐
│ CONSTANT (the md):│     │ ADAPTIVE (the LLM output):           │
│ SYSTEM_PROMPT /   │     │ "recall('auth')" then               │
│ prose.md /        │     │ "spawn_child('refactor X')" then    │
│ AGENT_RULES       │     │ "RETURN done"                       │
│ = the setpoint    │     │ = changes every run                 │
└───────────────────┘     └──────────────────────────────────────┘
```

- **The loop is rigid and dumb.** `assemble → call model → run result → check
  stop`. Identical for every task, forever. It "knows" nothing.
- **The adaptive part is the LLM's output each turn** — adaptive *because the
  `window` you assemble changes every iteration* (history grows, tool results
  arrive). Same dumb loop, different context in → different action out.
- **The Markdown is the constant injected into `window` every turn** — the
  standing instruction, never changing during the run.

### The thermostat (the correct analogy)

| Thermostat | The loop |
|---|---|
| setpoint (target temp) | the Markdown spec / `### Ensures` / AGENT_RULES outcomes |
| furnace | the generator LLM (does work toward the setpoint) |
| sensor | the **verifier** / stop-check (compares output to setpoint) |
| clock | the loop (keeps firing until the sensor says "reached") |
| max-run timer | the iteration guard (`loop ≤ 10`) — stop & report, never fake done |

The loop is the clock, the LLM is the furnace, the Markdown is the temperature you
dialed in. A thermostat **with no sensor** (a raw loop that declares done by vibes)
is the failure mode — the verifier is what makes it honest.

---

## 4. What gets passed into the loop each turn? (context engineering)

The window each turn = **constant setpoint** (`SYSTEM_MD`) + **constant goal** +
**a budget-bounded slice of history** + **freshly fetched handles**. The open
question is what "history" means. Three strategies — *choosing among them is CE*:

1. **Full history (naive):** append the whole transcript every turn. Simple; works
   until it overflows the window. Fine for short loops, fails at scale.
2. **Auto-summarize (compaction):** when history is big, replace old turns with an
   LLM summary. Bounded but **lossy** — dangerous for code, because the exact
   tokens dropped (a signature, an import) are often the ones the next turn needs.
   (Claude Code's auto-compaction fallback.)
3. **Externalize + re-fetch by handle (the RLM answer):** don't keep it in the
   window. State lives in files / a store; pass only the small working set +
   handles; re-fetch on demand. **This is litectx** — `recall`/`get` is the
   re-fetch; `compress`/`assemble` is the fit-to-budget.

**The load-bearing insight:** what you actually feed turn N+1 is **not the full log
— it's the gap to the setpoint.** The thermostat sends "you're 3° off," not the
room's whole history. So turn N+1's history is really:

- *what was tried* (a pointer/summary, re-fetchable via a handle), plus
- **the verifier's verdict: the specific ways the output missed the setpoint.**

That delta is what lets the next turn improve; everything bulky is re-fetchable.

### Worked example (the py→js refac)

```
Goal (constant):      "refac repo py→js, no deps, simpler, use stdlib"
Setpoint (constant):  AGENT_RULES   ← the prose.md / thermostat target

Turn 1  window = AGENT_RULES + goal + <repo file listing>
        model refactors file A → diff
        SENSOR checks diff vs setpoint:
          ✓ match → exit
          ✗ miss  → loop, feeding back the GAP

Turn 2  window = AGENT_RULES + goal + {tried: <diff ptr>, gap: "still imports
                 requests; file B not converted"}
        ... repeat up to loop=10 ...
        hit 10 without match → STOP and report "incomplete" (never fake done)
```

**Why this example is the *safe* kind:** its sensor is mostly **deterministic** —
"no deps" = `grep` deps / clean `npm install`; "py→js" = no `.py` left, runs under
`node`; "tests pass" = run them. Only "is it *simpler*?" needs model judgment. So
the stop-check is ~80% checks + 20% judgment — the safe ladder (see §6).

**Recursion bounds context growth:** a child sent to refac `src/db` gets a *fresh*
window (just that subtask), so history never accumulates across the whole tree.

---

## 5. The two families (and the three trigger mechanisms)

The biggest source of confusion: "recursive coding agent" names **two opposite
paradigms.**

| | Who decides the structure | Self-similar or specialized | Examples |
|---|---|---|---|
| **Family A** | the **model**, at runtime, by recursing | self-similar (every node = same agent) | `unix-rlm`, `ypi` |
| **Family B** | the **author** (or Claude, once, up front); an engine runs it | either | `CodeMachine`, OpenProse, Claude dynamic workflows, Ralph loop |

- **Family A** = *flexible, can wander.* The model writes the code turn-by-turn and
  *chooses* whether to recurse. Bounded only by guards.
- **Family B** = *guaranteed structure.* The loop is real code, so it *provably*
  fires the verifier on every item and *provably* terminates. The model only fills
  in the work inside each node.

### How recursion gets triggered — three mechanisms

1. **Forced by code (pure B):** the loop literally contains
   `for sub in split(task): spawn_child(sub)`. The model is never asked; it only
   does leaf work. *Field-tested corollary:* an **LLM always takes the higher bound
   of any limit** — ask it "how many subgoals?" and it maxes out. So hard-code the
   count from a cheap classifier (e.g. complexity tier → 2/4/6 subgoals); the
   **code** owns the count, not the model (§11).
2. **Offered as a tool (hybrid — the clean answer):** the model's tool list
   includes `spawn_child(subtask)`. It *chooses* to call it, like any tool. The
   code provides the **capability**; the model provides the **decision**. (This is
   `ypi`'s `rlm_query` native tool.)
3. **Model writes shell that re-invokes the CLI (pure A):** the model emits a bash
   block containing `rlm "..."`. No formal tool — just a command that calls the
   harness binary. (`unix-rlm`.)

**"How does the model know what to try?"** Two inputs: (a) the **tool description**
(*what* the tool does) and (b) the **Markdown spec / system prompt** (*when* to
reach for it — "decompose when 3+ independent parts; at depth ≥ 2 prefer direct
action"). The model isn't guessing — it follows the standing instructions against
the live context.

**Should we allow Family A if we build B?** Yes — **not as two systems, but as
B-shell with an A-tool.** Pure A wanders; pure B can't adapt to a sub-problem shape
you didn't foresee; the hybrid runs the *known* structure deterministically and
hands the model a depth-capped `spawn_child` tool at the *unpredictable* steps.
`ypi` is exactly this. **A is safe only as a bounded capability inside B's guarded
frame, never an unbounded top-level loop** — the guards convert "scary recursion"
into "a tool that provably terminates."

---

## 6. The self-evaluation trap & the deterministic-vs-judgment ladder

From the Weitekamp talk: models are sycophantic and **terrible at grading their own
output** (reward-hacking — "it looks syntactically fine, ship it"). The fix is a
GAN-style split: a **Generator** writes, a separate **Evaluator** (different context
window, harsher prompt, its own tools) grades against a **shared Markdown contract**
negotiated *before* any code is written.

The subtlety (the thing that confused us): *"it's code that triggers the
recursion, so isn't the eval deterministic?"* — pull two things apart:

- **Control eval — "should I recurse / stop?"** *Is* deterministic: `depth < 3?`,
  `budget > 0?`, `RETURN emitted?`. Pure `if` statements. This is why recursion is
  safe and terminates.
- **Quality eval — "is the output actually good/correct?"** *Not* the same kind of
  question. The recursion trigger being deterministic tells you **nothing** about
  whether the work is good. The control flow can run perfectly and the content be
  garbage. Mechanism ≠ correctness.

So the rule is a **ladder**, cheapest-and-hardest-to-fool first:

```
1. Deterministic checks   → use for EVERYTHING you can.
   compiles? tests pass? types check? lint clean? no forbidden import?
   → unfoolable, free, instant. A model can't sweet-talk a failing test.
2. Model judgment         → ONLY for what (1) can't express
   (taste, architecture, "did it answer the real intent?")
   → BUT a model grading its OWN output rationalizes it (sycophancy)
   → so the judge must be a SEPARATE context window, different prompt.
3. Generator grades itself → NEVER.
```

One line: **deterministic where you can, separate-context model where you can't,
generator-grades-itself never.**

This is litectx's **R-S8** finding restated: there is no usable self-confidence
threshold inside a single model (AUC 0.92 aggregate, no usable per-query cut). The
fix isn't "trigger the eval from code" — it's "the eval lives in a different head."
It's also why litectx must **not** grow an LLM grader or rubric verb: the no-LLM-
inside moat *is* the structural guarantee that the judge stays separate.

---

## 7. The cast — what each project actually is

- **`unix-rlm`** (openprose) — the minimal honest engine. One self-contained
  `bin/rlm`. Sandbox = a real Linux box; bash is the shell. Loop: query → LLM emits
  ` ```repl ` blocks → execute in the real env → capture output → check `RETURN` →
  loop. Recursion = the model writing `rlm "..."` in a repl block. Guards:
  `RLM_MAX_DEPTH=3`, `RLM_MAX_ITERATIONS=15`. *Family A, Trigger 3.*

- **`ypi`** ("Y-combinator Pi" — the fixed-point combinator that lets a function
  call itself) — the same idea wrapped around a real coding agent (Pi). Three
  parts: `SYSTEM_PROMPT.md` (decomposition policy), `$CONTEXT` + bash (data/REPL),
  `extensions/recursive.ts` (native `rlm_query` tool that spawns a child Pi with
  identical capability). Self-similar (every depth = same prompt/tools); deeper
  agents are scrubbed and told to be conservative. **Five guards**: budget,
  timeout, max-calls, max-depth, capability-scrub. Optional `jj` workspace
  isolation. *Family A, Trigger 2 — the hybrid done right.*

- **OpenProse / `prose.md`** — Family B taken to its end: **the harness becomes a
  readable Markdown artifact and the LLM is the VM that runs it.** A `.prose.md`
  file is a *declarative contract*: `### Requires` (inputs), `### Ensures` (output
  guarantees — the contract), `### Tools`, `### Strategies`. The VM: spawns one
  isolated session per service (*"receives only its own service definition, never
  the global manifest"* → context isolation built in), runs them in DAG order,
  and **verifies `### Ensures` after each** by *intelligent judgment* ("read the
  output and the contract clause, determine if the commitment was met"). Sub-tasks
  via `Delegate:` (parallel fan-out supported). **Static recursion is prohibited**
  ("composition through wired subscriptions, never self-referential delegation") —
  RLM-style recursion is layered on top as *bounded delegation* (see `proseRlm`,
  "RLM implementation using OpenProse"). `prose.md` is the GAN talk's "shared
  contract" made into the program itself.

- **`CodeMachine-CLI`** (moazbuilds) — Family B orchestrator: "AI coding agents
  into **repeatable**, long-running workflows… control what each agent sees at each
  step." Structure pre-written; the engine runs it; the model never chooses to
  recurse. *Not* the unix-rlm paradigm — the opposite one.

- **Ralph (Wiggum) loop** — Family B at its most primitive:
  `while true; do cat PROMPT.md | agent; done`. `PROMPT.md` = setpoint, `while` =
  clock, agent = furnace; re-run until convergence. Same axis as OpenProse, zero
  sophistication. Danger: a thermostat with no sensor spins or fakes done — add a
  verifier.

- **Claude Code dynamic workflows** — Family B, native to this harness. Claude
  **writes a JS orchestration script up front** (`agent()`, `parallel()`,
  `pipeline()`, loops, conditionals); a deterministic engine runs it. Patterns:
  fan-out-and-synthesize, **adversarial verification**, tournament, loop-until-done
  — the GAN talk's ideas as composable functions. Separate subagents (independent
  context windows) structurally prevent laziness / self-preferential bias / goal
  drift.

---

## 8. The bareagent primitive — `recurse()` (design note)

**Decision: a parallel primitive in bareagent, not a replacement for the main
loop, and NOT inside litectx.** Build it **B-shell with an A-tool**.

**Port or build fresh?** *Borrow, don't port* (the aurora rule). The loop core
genuinely is ~50–100 lines (`unix-rlm`'s `bin/rlm` is self-contained; `ypi`'s
recursion is one extension) — your "the core is simple to copy" instinct is right.
But **"we always miss stuff" — and the stuff missed is never the loop; it's the
guards and the prompt calibration.** So: read `unix-rlm`/`ypi`, transcribe the
*guard list* and *return protocol* in spirit, write clean in bareagent's idiom.
**Don't `git clone`** — they're runtime-welded (`unix-rlm` → OpenRouter+bash,
`ypi` → Pi); forking drags the coupling in.

### The irreducible core to copy (the checklist of "stuff you'd miss")

1. **The five termination guards** (from `ypi` — highest-value copy): depth cap,
   dollar budget, wall-clock timeout, max-call count, **and capability-scrub at
   depth** (deeper nodes get fewer powers, told to prefer direct action). People
   forget #5 and get runaway fan-out.
2. **The return/sentinel protocol** — how a child signals "done, here's the value"
   (`unix-rlm`'s `RETURN`; OpenProse's `### Ensures` + `__error.md`).
3. **Context isolation per child** — fresh window; child sees only its sub-task,
   never the parent's full history. This is what *makes* it RLM.
4. **The decomposition-policy prompt** — the calibrated text teaching *when* to
   split. Read theirs; adapt, don't reinvent.

### Skeleton (~80 lines, language-agnostic)

```js
// bareagent: recurse() — parallel primitive to the main loop, not a replacement.
async function recurse(task, ctx, depth = 0) {
  // ── GUARDS (copy these — the part people forget) ──────────────────
  if (depth > MAX_DEPTH) return directAnswer(task);   // base case
  if (budget.spent() > MAX_BUDGET) throw new BudgetError();
  const start = ctx.now();

  const history = [];                                 // THIS node's transcript
  for (let i = 0; i < MAX_ITERS; i++) {               // the clock
    if (ctx.now() - start > MAX_WALL) break;          // timeout guard
    if (ctx.calls > MAX_CALLS) break;                 // call-count guard

    // ── ASSEMBLE: setpoint + goal + bounded history + handles ──────
    const window = assemble({
      system: SYSTEM_MD,             // constant setpoint (AGENT_RULES/prose.md)
      goal:   task,                  // constant goal
      history: fit(history, BUDGET), // bounded; summarize/drop oldest if over
      tools:  [recall, get, impact, assemble,        // ← litectx handle tools
               spawn_child(depth)],                  // ← A-tool, depth-aware
    });

    // ── CALL: the one adaptive step ────────────────────────────────
    const action = await LLM(window);

    // ── DISPATCH ───────────────────────────────────────────────────
    if (action.final) {
      const verdict = await verify(action.result, SYSTEM_MD); // SEPARATE context
      if (verdict.meetsContract) return action.result;        // setpoint reached
      history.push({ tried: action.result, gap: verdict.gap });// feed the GAP back
      continue;
    }
    if (action.tool === 'spawn_child') {
      // capability-scrub: deeper nodes get fewer powers + a conservative prompt
      const child = await recurse(action.subtask, ctx, depth + 1);
      history.push({ child: action.subtask, result: child });
    } else {
      history.push({ tool: action.tool, result: await dispatch(action) });
    }
  }
  return { incomplete: true, best: history };  // honest: never vibe-declare done
}
```

Note the load-bearing details: `verify(...)` runs in a **separate context** (§6);
history feeds back the **gap**, not the full transcript (§4); `spawn_child` is an
**offered tool** the model chooses (§5, Trigger 2); the five guards bound it.

### Boundary

**bareagent owns**: the loop, the five guards, the Markdown policy, `spawn_child`,
the verifier. **litectx supplies**: the handle tools the loop offers the model
alongside `spawn_child` — `recall`, `get`, `impact`, `assemble`, `scoped`. The
recursive agent **queries** the codebase/memory through litectx instead of swallowing
it. That is the RLM "context-as-handle" premise, and it is the *only* role litectx
plays.

---

## 9. What this means for litectx (settled)

**litectx never becomes a loop, never imports `unix-rlm`/`ypi`, never grows an LLM
grader.** Per doctrine: *litectx = pure library (no LLM, no loop, no server);
orchestration → bareagent.* Every recursive harness here is a loop that calls an
LLM — the moment that lives in litectx, it stops being a deterministic library.

What the RLM framing *does* give litectx (positioning, not code): a clean, honest
way to describe `recall`/`get`/`assemble` — **"the handle layer for recursive
agents: query your codebase and memory instead of stuffing them into context."**
That's literally what those verbs do, with no token-saving overclaim on the decay
engine. This mirrors the already-settled **Flue** and **bareagent generator/
evaluator** verdicts: a recursive coding agent is *another candidate adopter* of
litectx's handle layer, living in bareagent — not something litectx becomes.

---

## 10. Updates from the literature (the RLM paper, MGH + OpenProse)

The canonical RLM paper grounds everything below (§10F); MGH + OpenProse sharpen it:

**A. Capability is rarely the bottleneck — composition/trust is.**
- **MGH** ("Mismanaged Geniuses Hypothesis", Alex Zhang): *"existing frontier
  language models are severely underutilized due to sub-optimal use of individual
  language model calls"*; learning the *operator that composes* LM calls is a more
  efficient route to hard tasks than scaling the model. The loop is how you
  *utilize* a genius, not crutch a weakling.
- **OpenProse** (Weitekamp): *"the rate-limiting factor… is not a model capability
  issue – it is a trust issue."*
- → Matches litectx's settled finding: strong models don't need recall to
  *execute*; the win is *finding* + context-discipline, not raw smarts.

**B. Decomposition generalizes length.** The headline length-generalization result,
grounded in the RLM paper (§10F), not the blog gloss: an RL-trained (RLVR)
**RLM-Qwen3-4B**, trained on **MRCRv2 at 64k context / 2 needles**, generalizes to
**1M context / 8 needles** — approaching a 1M-context frontier model (Gemini 3.1
Pro) *without ever training at that length.* (MGH's "~100%" gloss was looser; the
paper reports a score curve, so cite the paper, not the gloss.) The thesis holds —
decomposition is learnable and *generalizes length*, the exact failure mode (context
rot) the approach targets — but state it at the paper's numbers, not the blog's.

**C. Family B is NOT deterministic in outcome (honest caveat).** OpenProse, in its
own words: *"The LLM is still non-deterministic"*; *"A bad Prose program will
faithfully and repeatably do the wrong thing."* It buys **predictability +
inspectability, not determinism.** Correction to any earlier phrasing here: only
the **control flow** is deterministic (which node runs when); the **outcome** is
not. Outcome-trust comes from the §6 ladder + receipts (below), never the loop.

**D. "Done" must carry evidence (receipts).** OpenProse's `Ensures` carries
*evidence*, and every run writes timestamped receipts under `runs/{id}/` so *"Done
is inspectable, not a subjective claim."* This is litectx's validate-what-you-
deliver / honest-thermostat in other words: the verifier should emit a **gap report
with evidence**, not a boolean — and persist it. Fold into `recurse()`'s
`verify()`: return + store the evidence, don't just return `meetsContract`.

**E. Two smaller borrowables.** *ProseScript* — an imperative sublayer (explicit
sequencing / conditionals / retries + real deterministic tools like `jq`/MCP): the
escape hatch when you need true determinism *inside* a declarative flow. *Skill
declaration* — services declare needed capabilities up front rather than hoping the
agent discovers them (addresses "needed capability goes unused").

**F. The canonical RLM paper — hard grounding** (Zhang, Kraska, Khattab, MIT CSAIL;
arXiv 2512.24601). The primary source for everything in this doc. It formalizes RLM
as an **inference-time scaffold** around a base model `M` (max context `K`) that
loads the prompt `P` as a **variable in a REPL environment** and hands `M` a
**"symbolic handle"** to `P` — query/decompose it via code, optionally invoking
sub-LM / sub-RLM calls, until a `Final` variable is set. (Confirms §1: "context as a
handle" is the paper's *symbolic handle*; "swallow as tokens" is what it avoids.)

- **Algorithm 1 vs Algorithm 2 — what actually separates RLM from naive
  sub-agents.** The paper contrasts a real RLM (Alg 1) against a "deceptively
  similar" poor scaffold (Alg 2) with three flaws, which pin down the essence:
  (1) **don't put `P` in the model's own context** (`hist`) — keep it a variable, or
  you inherit `M`'s window limit; (2) **don't route output through a `Finish` action**
  capped at the window — let *code* build the result (unbounded output); (3) the model
  must write **programs that loop over Ω(|P|) slices**, not just delegate a few
  *verbalized* sub-tasks (symbolic recursion). This sharpens §7's "cast."

- **Headline results (Table 1; four long-context tasks; GPT-5 / Qwen3-Coder-480B).**
  RLM(GPT-5) beats GPT-5 by a **median 26% vs compaction, 130% vs CodeAct-with-
  sub-calls, 13% vs Claude Code**, at **comparable cost**, scaling past **10M tokens**.
  On the information-dense **OOLONG-Pairs**, base models score **≤0.1% F1** while
  RLM(depth=1) reaches **58% (GPT-5) / 23% (Qwen3)**. Post-trained **RLM-Qwen3-8B**
  beats base by a **median 28%** on just **1,000 samples from unrelated domains**.

- **The depth finding — the most relevant to us (Observation 2).** **RLM(depth=0)** —
  REPL + handle but *no sub-calls at all* — already outperforms most baselines on
  most tasks (on CodeQA it beats every deeper variant). **Recursive sub-calling earns
  its keep specifically on information-dense tasks** (OOLONG-Pairs: depth 0→3 climbs
  44%→76%); elsewhere extra depth is neutral-or-worse. → the academic, *stronger*
  form of §11/§12: **the handle/REPL is the main lever; recursion is a task-dependent
  add-on, not the default. Tune depth to task complexity.**

- **Decomposition is sensitive and steerable (Figure 4).** In-context decomposition
  examples in the system prompt measurably improve both accuracy and the
  first-decomposition-correct rate; syntax/format errors are a real failure mode. →
  grounds the decomposition-policy-prompt requirement (RC-3 calibration): *few-shot
  the decomposition.*

- **Beyond long-context (Table 2, LongCoT-mini).** RLM(depth=1) + **decomposition
  hints** lifts GPT-5.2 from 38.7 → **65.6 overall (+69.5%)** by traversing the
  reasoning graph via sub-calls (CHESS 37→99, LOGIC 54→99). → recursion helps
  *reasoning* decomposition, not just *context* length.

---

## 11. Case study: the aurora SOAR loop — fan-out, not recursion

A real loop (aurora, "aur soar", SOAR-style) that worked well with little
whole-repo context. Stage by stage, mapped to this framework:

| aurora stage | framework name | why it worked |
|---|---|---|
| regex complexity → simple/med/complex | **classify-and-act router** | cheap deterministic triage sets the budget |
| fetch code via litectx memory | **context-as-handle** (§1) | workers got *slices*, never the whole repo |
| complexity → 2/4/6 subgoals, hard-coded | **deterministic control eval** (§6) | *"LLM always takes the higher bound"* → the **code** owns the count |
| match subagent capability ↔ fetched code | **skill declaration** (§10E) | right worker for the slice; no wasted capability |
| chunk + docstring as the unit | **litectx chunker granularity** | enough to act, not enough to drown |
| orchestrator fans out → collects → one answer | **fan-out-and-synthesize** (Family B) | depth-1, no nesting |

**Is it recursive? No — and that's a feature.** It's depth-1
**fan-out-and-synthesize**, not self-similar recursion:
- *recursion* = a node spawns children of the *same kind*, depth > 1, base case —
  needed **only when a single subgoal is itself too big for one window**.
- *fan-out* = orchestrator → N workers → synthesize; depth fixed at 1.

**The lesson:** you don't need recursion to get the RLM benefit. The benefit is
*context discipline* (small relevant slices per worker), and depth-1 fan-out
already delivers it. This loop "solved problems with little context about the whole
repo" precisely because the handle-fetch + capability-matched chunk+docstring handed
each worker a tight slice. **Recursion only earns its keep when a worker reports its
own subgoal still overflows** — the one place to escalate fan-out → `spawn_child`
(the A-tool inside the B-shell, §5/§8).

**Borrow into `recurse()`:**
1. complexity-tier → fixed subgoal count (2/4/6) — the higher-bound-defeating count;
2. capability-matching of workers to fetched slices (skill declaration);
3. chunk+docstring as the per-worker context unit (litectx already produces it);
4. **default to depth-1 fan-out; escalate to recursion only on a worker's overflow
   signal.**

**Learn, honestly:** this is a real instance of litectx-as-substrate working — the
orchestrator did the *executing*, litectx did the *finding* (the "recall helps
FINDING not EXECUTING" rule). But per prove-don't-assert: *"worked surprisingly well
/ solved some problems"* is **promising signal, not a benched result** — a
hypothesis to A/B (fan-out-with-handles vs flat-context), not a proven win.

---

## 12. Is parallel fan-out a third type of RLM? (taxonomy)

Short answer: **No — it's not a new family and not a new primitive. It's a
*topology* of the machinery you already have: the same `spawn` primitive, capped at
depth 1.** Separate the three claims:

**(a) "A parallel example, all primitives present" — yes.** Aurora's fan-out uses
the identical primitives as `recurse()`: classify → fetch-by-handle → deterministic
split → spawn workers → synthesize. Nothing new is introduced. It's an *instance* —
specifically **Family B (author-driven) + flat topology**.

**(b) "Its own primitive" — no.** Fan-out isn't a primitive; it's a *call pattern*
over one primitive:

```
spawn(subtasks[]) → results[]      // run N children in parallel, collect
```

- **fan-out** = call `spawn` once, depth-1, workers may NOT re-spawn.
- **recursion** = call `spawn`, and workers ARE allowed to call `spawn` again
  (bounded by depth).

So **recursion is just fan-out allowed to nest.** Fan-out is the depth-1 special
case of the very same primitive — which is exactly why "all the primitives are
there": they *are* the same primitive.

**(c) "A third type of RLM, but parallel" — no, because A/B is the wrong axis for
it.** A-vs-B is the **control** axis (who decides the structure). Parallel-vs-nested
is a *different, orthogonal* axis: **topology** (the shape of the decomposition).
Mixing the two is the confusion. The real picture is a grid of two axes:

| topology ↓ \ control → | model-driven (A) | author-driven (B) |
|---|---|---|
| **fan-out** (depth-1, parallel) | model fans out via a tool | **aurora SOAR loop** |
| **pipeline** (sequential) | model chains steps | OpenProse DAG |
| **recursion** (depth-N, nested) | unix-rlm / ypi | proseRlm |

Fan-out, pipeline, and recursion are **shapes**, each available under either control
family. Aurora SOAR = author-driven + fan-out. unix-rlm = model-driven + recursion.
Different *cells in the same grid*, not different grids — and not a third value on
the A/B axis.

**Practical upshot (the rule that falls out):** fan-out and recursion aren't
competitors — pick by **whether a subgoal fits one window**:

- subgoal fits → **fan-out** (depth-1): cheaper, fully parallel, no nesting to
  reason about. **The default for code tasks** — why aurora worked.
- a worker's subgoal still overflows → let *that* worker fan out again = recursion,
  bounded by depth.

So the bareagent primitive needs **no separate "parallel mode."** `recurse()` with
`MAX_DEPTH = 1` **is** the aurora fan-out; `MAX_DEPTH = 3` lets it nest when a slice
overflows. **One primitive, one knob** — build fan-out; recursion is the same code
with the depth cap lifted.

---

## Sources

- **[Recursive Language Models — Zhang, Kraska, Khattab, MIT CSAIL](https://arxiv.org/abs/2512.24601)** — the canonical paper: REPL/symbolic-handle formalism, Algorithm 1 vs 2, Table 1 results, the depth=0 finding · [code](https://github.com/alexzhang13/rlm)
- [unix-rlm](https://github.com/openprose/unix-rlm) — minimal RLM, Linux sandbox
- [ypi](https://github.com/rawwerks/ypi) — recursive Pi coding agent (5 guards, `rlm_query`)
- [Recursive Coding Agents — Raymond Weitekamp](https://recursivecodingagents.com/) · [talk (YouTube)](https://www.youtube.com/watch?v=3hXJI2q0Jz8)
- [The Mismanaged Geniuses Hypothesis (MGH) — Alex Zhang](https://alexzhang13.github.io/blog/2026/mgh/) — composition > scaling; 4B RLM length-generalization result
- [OpenProse / prose.md](https://prose.md/) and the [prose.md VM spec](https://github.com/openprose/prose/blob/main/skills/open-prose/prose.md)
- [proseRlm](https://github.com/maxtheman/proseRlm) — RLM implemented in OpenProse
- [OpenProse overview (Turing Post)](https://www.turingpost.com/p/openprose-a-language-for-reliable-agents)
- [CodeMachine-CLI](https://github.com/moazbuilds/CodeMachine-CLI) — Family-B orchestrator
- [Anthropic: A harness for every task — dynamic workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)

> Cross-refs in this repo: R-S8 self-eval falsification and the no-LLM-inside moat
> (`.claude/memory/MEMORY.md`); the bareagent generator/evaluator carrier brief and
> Flue competitive analysis (same); litectx CE verbs (`docs/01-product/litectx-prd.md`, Part 2).
