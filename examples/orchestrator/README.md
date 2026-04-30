# orchestrator/

Reference pattern for multi-agent dispatch. **Three configs and a system
prompt — no orchestrator class, no role types, no DAG runner.** The LLM
itself is the dispatcher; the only primitive is `spawn(config, input)`.

```
orchestrator/
├── orchestrator.json     # the parent agent — picks a specialist per job
└── specialists/
    ├── summarizer.json   # specialist: summarise text given as input
    └── researcher.json   # specialist: shell_grep + shell_read across cwd
```

## Run it

```bash
cd examples/orchestrator
OPENAI_API_KEY=... echo '{"content":"Summarise the README in this repo."}' \
  | bare-agent --config orchestrator.json
```

The orchestrator's system prompt tells the model:

> You receive a job. Decide which specialist handles it (summarizer or
> researcher), `spawn` that specialist with the relevant input, and return
> the specialist's result.

The model picks `spawn(config: 'specialists/researcher.json', input: ...)`,
the researcher reads the README via `shell_read`, returns its summary, the
orchestrator returns that to stdout.

## What's gated

Both `orchestrator.json` and `specialists/*.json` declare a `gate` block
that wires bareguard. Defaults:

- `budget.maxCostUsd: 0.50` — hard cap on the *family* (parent + children
  share via `BAREGUARD_BUDGET_FILE`).
- `limits.maxTurns: 20`, `limits.maxChildren: 3`, `limits.maxDepth: 2` —
  spawn-tree shape bounds.
- `spawn.ratePerMinute: 5`, `defer.ratePerMinute: 10` — bareguard 0.2 rate
  caps.
- `bash.allow` and `fs.readScope` scoped per specialist.

## Why this isn't a framework

There's no `class Orchestrator`, no `dispatch_to_specialist()`, no shared
state object. Roles are *configs*, not types. Adding a new specialist is
adding one JSON file — no code change to bareagent or the orchestrator.

The "intelligence" is the orchestrator's system prompt. Substitute a
better-written prompt and the same primitives handle a 5-specialist team.
