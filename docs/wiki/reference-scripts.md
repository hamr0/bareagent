---
type: reference
title: "Reference Scripts: wake.sh & orchestrator"
status: stable
sources: ["docs/archive/prd.md"]
---

# Reference Scripts

Two reference implementations shipped alongside bareagent: the `examples/wake.sh` scheduler script and the `examples/orchestrator/` config pattern. The full original document is archived at `docs/archive/prd.md`.

## `examples/wake.sh`

This is a *reference*, not a primitive — users copy it into their project and modify it (prd.md:568-569). It ships verbatim in `examples/` of the bareagent repo, alongside an accompanying `examples/wake.md` documenting the cron entry and customization points (prd.md:569-571).

The script:
1. Reads the JSONL defer queue.
2. Filters records whose `when` <= now AND status == "pending".
3. For each due record: appends a "fired" status line, then invokes bareagent with the action as input.
4. Uses `flock` to prevent overlapping wake invocations.
(prd.md:585-590)

Customization points: `QUEUE` (path to the defer queue file), `ORCHESTRATOR_CONFIG` (path to the bareagent config that handles fired actions), and `LOCKFILE` (where to put the overlap-prevention lock) (prd.md:580-583).

### Full script (verbatim)

```bash
#!/usr/bin/env bash
# examples/wake.sh — reference scheduler for bareagent's defer queue.
#
# Cron entry (every minute):
#   * * * * * /path/to/wake.sh >> /var/log/bareagent-wake.log 2>&1
#
# Customize:
#   - QUEUE: path to your defer queue file
#   - ORCHESTRATOR_CONFIG: path to the bareagent config that handles fired actions
#   - LOCKFILE: where to put the overlap-prevention lock
#
# This script:
#   1. Reads the JSONL defer queue.
#   2. Filters records whose `when` <= now AND status == "pending".
#   3. For each due record: appends a "fired" status line, then invokes
#      bareagent with the action as input.
#   4. Uses flock to prevent overlapping wake invocations.

set -euo pipefail

QUEUE="${BAREAGENT_DEFER_QUEUE:-./bareagent-defers.jsonl}"
ORCHESTRATOR_CONFIG="${ORCHESTRATOR_CONFIG:-./orchestrator.json}"
LOCKFILE="${LOCKFILE:-/tmp/bareagent-wake.lock}"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Single-instance: bail if another wake is running.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[wake] another instance running, exiting" >&2
  exit 0
fi

# Reconstruct current status by folding all status lines per id.
# (jq one-liner: latest status wins per id)
PENDING=$(jq -c '
  reduce inputs as $r ({};
    .[$r.id] |= (. // {}) + $r
  )
  | to_entries
  | map(.value)
  | map(select(.status == "pending" and .when <= "'"$NOW"'"))
  | .[]
' < "$QUEUE")

echo "$PENDING" | while IFS= read -r record; do
  [ -z "$record" ] && continue

  ID=$(echo "$record" | jq -r '.id')
  ACTION=$(echo "$record" | jq -c '.action')

  # Append "fired" status (defer queue is append-only).
  echo "{\"id\":\"$ID\",\"status\":\"fired\",\"ts\":\"$NOW\"}" >> "$QUEUE"

  # Invoke bareagent with the deferred action as stdin input.
  # Run in background; the wake script doesn't wait for completion.
  ( echo "$ACTION" | bareagent --config "$ORCHESTRATOR_CONFIG" \
      >> "/var/log/bareagent-fired-$ID.log" 2>&1 ) &
done

wait
```
(prd.md:573-635)

### Why bash, not Node

The wake script is OS-level glue. Keeping it as a shell script makes the dependency on bareagent (and only bareagent) obvious, and avoids users thinking the script is a library to import (prd.md:637-639).

## `examples/orchestrator/`

Directory layout (prd.md:643-652):

```
examples/orchestrator/
├── README.md            # the pattern explained in 200 words
├── orchestrator.json    # bareagent config — system prompt: "you receive
│                        # jobs, decide which specialist handles them,
│                        # spawn specialists, collect results."
└── specialists/
    ├── summarizer.json
    └── researcher.json
```

The orchestrator's "intelligence" is its system prompt. The dispatching happens in the LLM's head when it picks which `spawn(config, input)` to call. There is no `class Orchestrator` and no `dispatch_to_specialist` function — roles are configs, not types (prd.md:654-657).
