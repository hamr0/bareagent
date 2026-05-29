#!/usr/bin/env bash
# examples/wake.sh — reference scheduler for bareagent's defer queue.
#
# This is a *reference*, not a primitive. Copy into your project and modify.
# See examples/wake.md for the cron entry and customization points.
#
# What this script does:
#   1. Reads the JSONL defer queue file.
#   2. Folds status-update lines per id (latest wins) using jq.
#   3. For each pending record whose `when` <= now: appends a "fired" status
#      line to the queue (atomic JSONL append), then invokes
#      `bareagent --config <orchestrator>` with the inner action as stdin.
#   4. Uses flock(1) to prevent overlapping wake invocations.
#
# The fired action goes through bareguard's gate AGAIN at fire time — full
# pipeline against the inner action, separate from the emit-time check.
# (Two gate.check calls, two distinct audit lines, reconstructable via
# parent_run_id.)

set -euo pipefail

QUEUE="${BAREAGENT_DEFER_QUEUE:-./bareagent-defers.jsonl}"
ORCHESTRATOR_CONFIG="${ORCHESTRATOR_CONFIG:-./orchestrator.json}"
LOCKFILE="${LOCKFILE:-/tmp/bareagent-wake.lock}"
LOG_DIR="${BAREAGENT_WAKE_LOG_DIR:-/tmp/bareagent-wake}"

mkdir -p "$LOG_DIR"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Single-instance: bail if another wake is running.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[wake $NOW] another instance running, exiting" >&2
  exit 0
fi

# No queue file = nothing to do.
if [ ! -f "$QUEUE" ]; then
  exit 0
fi

# Reconstruct status by folding all lines per id (latest wins) and filter
# to records whose `when` <= now AND status == "pending". One JSON object
# per output line.
PENDING=$(jq -n -c '
  reduce inputs as $r ({};
    .[$r.id] |= (. // {}) + $r
  )
  | to_entries
  | map(.value)
  | map(select(.status == "pending" and .when <= "'"$NOW"'"))
  | .[]
' < "$QUEUE")

if [ -z "$PENDING" ]; then
  exit 0
fi

echo "$PENDING" | while IFS= read -r record; do
  [ -z "$record" ] && continue

  ID=$(echo "$record" | jq -r '.id')
  ACTION=$(echo "$record" | jq -c '.action')

  # Append "fired" status line first (defer queue is append-only).
  printf '{"id":"%s","status":"fired","ts":"%s"}\n' "$ID" "$NOW" >> "$QUEUE"

  # Invoke bareagent with the deferred action as stdin input.
  # Run in background — wake script doesn't wait for completion.
  ( echo "$ACTION" | bare-agent --config "$ORCHESTRATOR_CONFIG" \
      >> "$LOG_DIR/fired-$ID.log" 2>&1
    rc=$?
    if [ $rc -ne 0 ]; then
      printf '{"id":"%s","status":"failed","ts":"%s","exit_code":%d}\n' \
        "$ID" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$rc" >> "$QUEUE"
    else
      printf '{"id":"%s","status":"done","ts":"%s"}\n' \
        "$ID" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> "$QUEUE"
    fi
  ) &
done

wait
