# wake.sh — defer queue runner

`examples/wake.sh` is the reference scheduler that fires bareagent's
deferred actions. It's not a library primitive — it's a small bash script
you copy into your project and adapt. Bareagent emits JSONL records via
the `defer` tool; wake.sh reads the queue and re-invokes bareagent with
the fired action.

## Installation

```bash
cp examples/wake.sh /usr/local/bin/bareagent-wake
chmod +x /usr/local/bin/bareagent-wake
```

## Cron entry (every minute)

```cron
* * * * *  /usr/local/bin/bareagent-wake
```

For project-scoped use, run from the project directory:

```cron
* * * * *  cd /path/to/your/project && /usr/local/bin/bareagent-wake
```

## Environment overrides

| Variable | Default | What it does |
|---|---|---|
| `BAREAGENT_DEFER_QUEUE` | `./bareagent-defers.jsonl` | Path to the JSONL defer queue (must match what the `defer` tool writes). |
| `ORCHESTRATOR_CONFIG` | `./orchestrator.json` | Bareagent config file the wake script invokes for fired actions. |
| `LOCKFILE` | `/tmp/bareagent-wake.lock` | Single-instance lock via `flock`. |
| `BAREAGENT_WAKE_LOG_DIR` | `/tmp/bareagent-wake` | Per-fired-action log directory. |

## Dependencies

- `jq` — JSONL fold + filter
- `flock` (Linux util-linux) — single-instance lock
- `bare-agent` on `$PATH` — `npm install -g bare-agent` or use the full path

## Behaviour

1. **Folds** the queue: `{id, status, ...}` records are append-only; the
   live status of each id is the *latest* line. jq does the fold.
2. **Filters** to `status === 'pending' AND when <= now()`.
3. For each due record: appends `{id, status: 'fired', ts}` (atomic JSONL
   append on POSIX), then invokes
   `bare-agent --config $ORCHESTRATOR_CONFIG` with the inner action as
   stdin input. Bareagent runs the action through bareguard's gate as a
   fresh action — full pipeline against the inner action, separate audit
   line.
4. After the fired invocation completes: appends `{id, status: 'done|failed', ts, exit_code?}`.

## Why bash and not Node

The wake script is OS-level glue — cron + filesystem + subprocess. Keeping
it as a shell script makes the dependency on bareagent (and only bareagent)
obvious, and avoids users thinking the script is a library to import.

## Customisation points

- **Different queue path:** set `BAREAGENT_DEFER_QUEUE` and pass the same
  to your `defer` tool config (or `BAREAGENT_DEFER_QUEUE` env on the
  bareagent process that emits).
- **Different orchestrator per action type:** parse `record.action.type`
  and pick a config file accordingly. ~5 lines added inside the per-record
  loop.
- **Different fire-time semantics:** instead of invoking bareagent CLI,
  shell out to a Node script that wires Loop differently. The defer queue
  schema doesn't constrain you.

## Log rotation

`logrotate(8)` is the standard answer. Example
`/etc/logrotate.d/bareagent-wake`:

```
/tmp/bareagent-wake/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}

/path/to/your/project/bareagent-defers.jsonl {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` matters for the queue: it preserves the file inode (which
the defer tool's `appendFile` depends on for atomic POSIX appends).
