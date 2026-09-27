```
                         ╭─────────────────────────────────╮
                         │  ╔╗ ╔═╗╦═╗╔═╗ ╔═╗╔═╗╔═╗╔╗╔╔╦╗   │
                         │  ╠╩╗╠═╣╠╦╝╠╣  ╠═╣║ ╦╠╣ ║║║ ║    │
                         │  ╚═╝╩ ╩╩╚═╚═╝ ╩ ╩╚═╝╚═╝╝╚╝ ╩    │
                         │   think ──→ act ──→ observe     │
                         │     ↑                  │        │
                         │     └──────────────────┘        │
                         ╰──╮──────────────────────────────╯
                            ╰── the brain, without the bloat

```

<p align="center">
  <a href="https://github.com/hamr0/bareagent/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/hamr0/bareagent/ci.yml?label=CI" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/bareagent?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**Lightweight agent primitives. Zero required deps — optional [bareguard](https://npmjs.com/package/bareguard) peer for one-gate governance.**

bare-agent started as primitives for building agents by hand: your code is the deterministic body, an LLM call sits in wherever you need judgment — the LangChain / CrewAI / AutoGen job, provider-agnostic, without a framework.

LLMs got good at wiring things themselves, so the same primitives are now offered as tool calls too: the model wires them up, bare-agent runs the loop, retries, budgets, and governance underneath. It's what [bareloop](https://github.com/hamr0/bareloop) and [fwdloop](https://github.com/hamr0/fwdloop) run on.

Some things an LLM can't judge about its own work. Building a harness or an external arbiter? Every primitive is listed in `primitives.json` — when to use it, import, signature, failure modes, a runnable example — plus a decisive return-time `judge` and the Jev gut-check tier.

## Start here

- **Building by hand** → `npm install bare-agent`, then hand your assistant `bareagent.context.md` (ships in the package — the complete contract).
- **AI agent / tool-calling** → read `primitives.json` first (`unpkg.com/bare-agent/primitives.json` before you install, or `require('bare-agent/primitives.json')`); generated from source, never drifts.
- **Harness / judge builder** → `primitives.json` + `judge` + Jev + wire bareguard.

## Fast gut check — Jev

An LLM call is slow, deliberate thinking (System 2). Jev, from TypeSafe, is the fast gut check (System 1): a classifier that returns a typed decision with a calibrated probability — roughly 200× faster and 400× cheaper than an LLM, per TypeSafe. bare-agent's `JevProvider` covers all three shapes — **yes/no**, **pick-one**, **score** — so your automation calls it like any other step: act when it's confident, escalate when it isn't. Injection-hardened by default; also usable as the `jev` check in the Evaluator.

## What's inside

Every piece works alone — take what you need, ignore the rest. No required deps — the core imports nothing.

| Area | Component | What it does |
|---|---|---|
| Act | Loop | think → act → observe until done, any provider, opt-in policy/assemble/trim seams |
| Act | Planner + runPlan | break a goal into a step DAG, run steps in parallel waves |
| Act | assessComplexity | rate a goal from its text alone, no LLM — gates whether to plan |
| Act | recurse | decompose → fan-out → verify → synthesize in one call; cost is open by design — run it under a budget cap / bareguard, or set `maxDepth: 1` |
| Act | Memory | persist and recall across sessions — JSON, SQLite, or litectx in a one-line swap |
| Act | StateMachine | task lifecycle: pending → running → done / failed / waiting / cancelled |
| Act | Scheduler | cron or relative triggers, survives restarts |
| Act | Checkpoint | human approval gate, bring your own transport |
| Act | Spawn | fork a child agent, sharing one audit log and budget |
| Act | Defer | queue an action for a waker to fire later, governed on emit and on fire |
| Act | Retry · CircuitBreaker · Fallback | backoff with jitter, fail-fast, provider failover |
| Act | Stream · Errors | structured JSONL events, typed error hierarchy |
| Verify | Evaluator + refine | judge output by predicate, rubric, an agentic critic, or the Jev tier; refine loops generate → evaluate → regenerate |
| Verify | judge | a decisive return-time check of the result against the original request |
| Verify | remember | distill durable facts out of a finished run |
| Verify | SkillRegistry | surface extra tools on demand instead of loading them all upfront |
| Verify | stash | compact finished work out of the live context window, restorable |
| Verify | JevProvider | fast, cheap, calibrated yes/no · pick-one · score decisions — the System-1 gate (see above) |
| Govern | wireGate → bareguard | one policy, one audit log, one budget cap over every call; stops the spin on repeated denials or a stuck call |
| Hands | Browsing · Mobile · Shell · MCP Bridge | barebrowse, baremobile, cross-platform shell, and auto-discovered MCP servers — all as tools |
| Providers | OpenAI-compatible, Anthropic, Gemini, Ollama, CLIPipe, Fallback | swap freely, or bring your own with one `generate` method; CLIPipe runs the loop over a CLI subscription instead of the metered API |

## It tells you the truth

- A cut-off, refused, or over-context answer is an error, not a success — and its half-written tool calls never run.
- A cost it can't price is `null`, never a silent `$0`.
- A dead worker or broken check returns `incomplete`, never a faked pass — and counts are done by code, not by the model.
- Stuck loops stop: repeated denials or the same failing call end the run cleanly instead of burning the budget.

## The bare ecosystem

Local-first, composable agent infrastructure. Same API patterns throughout —
mix and match, each module works standalone.

**Core** — the brain, the gate, the memory.

- **[bareagent](https://npmjs.com/package/bare-agent)** — the think→act→observe loop. *Goal in → coordinated actions out.* Replaces LangChain, CrewAI, AutoGen.
- **[bareguard](https://npmjs.com/package/bareguard)** — the single gate every action passes through. *Action in → allow / deny / ask-a-human out.* Replaces hand-rolled allowlists and scattered policy code.
- **[litectx](https://npmjs.com/package/litectx)** — tree-sitter code + memory graph with activation decay, plus lightweight context engineering (write · select · compress · isolate). *Query in → ranked context out.*

**Optional reach** — give the agent hands.

- **[barebrowse](https://npmjs.com/package/barebrowse)** — a real browser for agents. *URL in → pruned snapshot out.* Replaces Playwright, Selenium, Puppeteer.
- **[baremobile](https://npmjs.com/package/baremobile)** — Android + iOS device control. *Screen in → pruned snapshot out.* Replaces Appium, Espresso, XCUITest.
- **[beeperbox](https://github.com/hamr0/beeperbox)** — 50+ messaging networks via one MCP server (headless Beeper Desktop in Docker). *Chat in → unified message stream out.* Replaces Twilio, per-platform bot APIs.

**What you can build:**

- **Headless automation** — scrape sites, fill forms, extract data, monitor pages on a schedule
- **QA & testing** — automated test suites for web and Android apps without heavyweight frameworks
- **Personal AI assistants** — chatbots that browse the web or control your phone on your behalf
- **Remote device control** — manage Android devices over WiFi, including on-device via Termux
- **Agentic workflows** — multi-step tasks where an AI plans, browses, and acts across web and mobile

**Why this exists:** Most automation stacks ship 200MB of opinions before you write a line of code. These don't. Install, import, go.

## Docs

- **Integration Guide** (`bareagent.context.md`) — the complete contract: every option, the full API, wiring recipes. Ships in the package.
- **Primitives manifest** (`primitives.json`) — every primitive as machine-readable JSON. Ships in the package, generated from source.
- **[Error Guide](docs/product/errors.md)** — what each error means and how to react to it.
- **[CHANGELOG](CHANGELOG.md)** — release history. Not on Node? See [`contrib/`](contrib/README.md) for wrappers in Python, Go, Rust, Ruby, and Java.

## License

Apache License, Version 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
