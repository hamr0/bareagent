'use strict';

/**
 * tools/defer.js — emit a deferred-action record to a JSONL queue.
 *
 * LLM-callable form: `defer({ action, when })` appends ONE JSONL record
 * to the defer queue file and returns `{ id }`. bareagent does NOT wake
 * up later — the running process exits when the loop ends. An external
 * scheduler (cron + `examples/wake.sh`) reads the queue and fires due
 * actions by re-invoking bareagent.
 *
 * Two-phase gate semantics (per bareagent PRD §10.7 + bareguard PRD §14):
 *   - At emit (this tool): one gate.check on `{ type: 'defer', args: { action, when }, _ctx }`
 *     runs the full pipeline (defer.ratePerMinute, tools.allowlist on `defer`,
 *     content.* over the JSON-serialized form). Bareguard does NOT extract
 *     args.action and run a second pipeline against it at emit time.
 *   - At fire (wake.sh invokes bareagent with the inner action): a separate
 *     gate.check runs the full pipeline against the inner action as a fresh
 *     action. Two distinct gate.check calls, two distinct audit lines,
 *     reconstructable via parent_run_id.
 *
 * Queue file format — one JSON record per line, append-only:
 *   { id, ts_emitted, when, action, parent_run_id, status }
 * Status updates are appends, not edits: wake.sh appends
 *   { id, status: 'fired', ts }
 * Reconstruction folds by `id` (latest wins).
 *
 * Default queue path: ./bareagent-defers.jsonl (cwd-only, project-scoped).
 * Override via BAREAGENT_DEFER_QUEUE env var or createDeferTool({queuePath}).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_QUEUE_PATH = './bareagent-defers.jsonl';
const ID_PREFIX = 'def_';

/**
 * Generate a sortable, unique id. 9-char base36 timestamp + 20-char hex
 * random. Lexicographically sortable by emit time; unique enough for any
 * realistic defer rate. Same shape as the PRD's `def_01J...` sketch.
 */
function generateId() {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(10).toString('hex');
  return `${ID_PREFIX}${ts}_${rand}`;
}

/**
 * Resolve the active queue path. Precedence:
 *   1. Caller-supplied option (createDeferTool({ queuePath: '...' }))
 *   2. BAREAGENT_DEFER_QUEUE env var
 *   3. ./bareagent-defers.jsonl
 */
function resolveQueuePath(option) {
  return option
    || process.env.BAREAGENT_DEFER_QUEUE
    || DEFAULT_QUEUE_PATH;
}

/**
 * Validate a `when` field. Accepts an ISO 8601 timestamp string. Rejects
 * past timestamps loosely (more than 60s in the past) — the wake script
 * would fire them immediately, which is almost always not what the agent
 * meant. Future timestamps within reason are accepted as-is.
 *
 * Returns { ok: true, iso } on success, { ok: false, error } on failure.
 */
function validateWhen(when) {
  if (typeof when !== 'string' || !when) {
    return { ok: false, error: 'when must be an ISO 8601 timestamp string' };
  }
  const t = Date.parse(when);
  if (Number.isNaN(t)) {
    return { ok: false, error: `when is not a valid ISO 8601 timestamp: ${when}` };
  }
  const driftMs = Date.now() - t;
  if (driftMs > 60_000) {
    return { ok: false, error: `when is more than 60s in the past (drift=${driftMs}ms) — would fire immediately` };
  }
  return { ok: true, iso: new Date(t).toISOString() };
}

/**
 * Validate an `action` field. Must be an object with a string `type`.
 * Anything else is the LLM either confused or trying to defer something
 * meaningless.
 */
function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return { ok: false, error: 'action must be an object' };
  }
  if (typeof action.type !== 'string' || !action.type) {
    return { ok: false, error: 'action.type must be a non-empty string' };
  }
  return { ok: true };
}

/**
 * Append one JSONL record to the queue file. fs.promises.appendFile is
 * atomic for writes < PIPE_BUF on POSIX (4KB on Linux); a JSON record
 * with a small action is well under that.
 */
async function appendRecord(queuePath, record) {
  const dir = path.dirname(path.resolve(queuePath));
  // Best-effort dir creation; ignore "already exists".
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* fine */ }
  const line = JSON.stringify(record) + '\n';
  if (line.length > 4000) {
    // Soft guard — if the action payload is huge, the audit-and-fire chain
    // will still work but POSIX atomicity guarantee is gone. Warn.
    process.stderr.write(`[defer] record is ${line.length}B (> ~4KB POSIX_PIPE_BUF) — atomicity not guaranteed\n`);
  }
  await fsp.appendFile(queuePath, line);
}

/**
 * Read the queue and reconstruct the live status of each id by folding
 * append-only status lines (latest wins). Exposed for tests + library
 * users; the wake script does its own jq-based fold.
 */
async function readQueue(queuePath) {
  const path = resolveQueuePath(queuePath);
  try {
    const text = await fsp.readFile(path, 'utf8');
    const records = {};
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r.id) continue;
      records[r.id] = { ...records[r.id], ...r };
    }
    return Object.values(records);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.queuePath] - Override queue file path.
 * @returns {{tool: object, readQueue: Function}}
 */
function createDeferTool(options = {}) {
  const queuePath = resolveQueuePath(options.queuePath);

  const tool = {
    name: 'defer',
    description:
      'Append a deferred action to the queue. The action will be fired at or after `when` by the external wake script (cron + examples/wake.sh). bareagent does NOT wake up — the queue is project-scoped JSONL on disk. Returns { id }. Use sparingly: defer.ratePerMinute caps emits per agent family (default 15/min in bareguard 0.2).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'object',
          description: 'The action to fire. Must have a string `type` field naming a tool the wake-time agent can invoke (e.g. `{ type: "spawn", args: { config: "specialists/check-ci.json" } }`).',
        },
        when: {
          type: 'string',
          description: 'ISO 8601 timestamp for when to fire (e.g. "2026-04-30T18:00:00Z"). Must not be more than 60s in the past.',
        },
      },
      required: ['action', 'when'],
    },
    execute: async ({ action, when }) => {
      const a = validateAction(action);
      if (!a.ok) throw new Error(`[defer] ${a.error}`);
      const w = validateWhen(when);
      if (!w.ok) throw new Error(`[defer] ${w.error}`);

      const record = {
        id: generateId(),
        ts_emitted: new Date().toISOString(),
        when: w.iso,
        action,
        parent_run_id:
          process.env.BAREGUARD_RUN_ID
          || process.env.BAREGUARD_PARENT_RUN_ID
          || null,
        status: 'pending',
      };
      await appendRecord(queuePath, record);
      return { id: record.id };
    },
  };

  return {
    tool,
    readQueue: () => readQueue(queuePath),
    queuePath,
  };
}

module.exports = {
  createDeferTool,
  readQueue,
  generateId,        // exported for tests
  resolveQueuePath,  // exported for tests
};
