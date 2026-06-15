'use strict';

/**
 * tools/spawn.js — fork a child bareagent process.
 *
 * LLM-callable form: `spawn({ config, input? })` blocks until the child
 * exits and returns the child's final result. Per the PRD: LLMs don't
 * manage handles across tool calls, so blocking is the only sane LLM
 * surface. Library callers can use the lower-level `spawnChild()` export
 * for fire-and-forget / handle-based use.
 *
 * The child is bareagent itself, invoked as:
 *   <node> <bin/cli.js> --config <config-path>
 *
 * Env-var threading (per bareguard 0.1.1+ stitching contract):
 *   - BAREGUARD_AUDIT_PATH    — single audit file across the family
 *   - BAREGUARD_BUDGET_FILE   — shared budget ledger
 *   - BAREGUARD_PARENT_RUN_ID — parent's run_id becomes child's parent
 *   - BAREGUARD_SPAWN_DEPTH   — incremented; bareguard.limits.maxDepth caps it
 *
 * Stream model (per v0.9 §10.6 decision):
 *   ONE JSONL channel per child. Child stdout is the structured event
 *   stream. Child stderr is captured here and re-emitted as
 *   `{type: 'child:stderr', text, ts}` events on the parent's stream
 *   (if any). No two-channel split.
 *
 * Action shape sent to gate.check (when wired through wireGate):
 *   { type: 'spawn', args: { config, input }, _ctx }
 *   Bareguard treats `args` as opaque — content patterns scan the
 *   JSON-serialized form. spawn.ratePerMinute (bareguard 0.2+) caps emits
 *   per-family.
 */

/** @typedef {import('../src/stream').Stream} Stream */

const { spawn: cpSpawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — children should finish or be killed

/**
 * Resolve the bareagent CLI path. Prefers the local repo's bin/cli.js so
 * the test suite + dev runs use the in-tree CLI; falls back to npx.
 */
function resolveCliPath() {
  // tools/spawn.js → ../bin/cli.js (works in dev tree and when installed via npm)
  return path.resolve(__dirname, '..', 'bin', 'cli.js');
}

/**
 * Library-level: spawn a child and return a handle.
 *
 * Returns: {
 *   wait()      — Promise<{ text, usage, cost, error, events }>
 *   onLine(fn)  — subscribe to every JSONL event from child stdout
 *   kill(sig?)  — terminate the child
 *   pid         — child process id
 * }
 *
 * Use this from library code; the LLM-callable tool below wraps it with blocking semantics.
 *
 * @typedef {Record<string, any> & {type?: string, text?: string, ts?: string, data?: any}} ChildEvent
 *
 * @typedef {object} SpawnChildOptions
 * @property {string} [config] - Path to a bareagent config JSON file.
 * @property {*} [input] - Optional JSON input passed to the child on stdin.
 * @property {string} [cliPath] - Override the bareagent CLI path.
 * @property {number} [timeoutMs] - Force-kill child after this many ms (wall-clock hard ceiling).
 * @property {number} [idleTimeoutMs] - Force-kill child after this many ms with NO output on either
 *   stdout or stderr (heartbeat/liveness watchdog). The clock arms at spawn and resets on every JSONL
 *   line, so a child doing real work is never killed, but one that hangs silently is. Opt-in
 *   (0/undefined disables); independent of `timeoutMs`, which remains the absolute ceiling.
 * @property {Stream} [stream] - bareagent Stream — child:stderr events get re-emitted here.
 *
 * @param {SpawnChildOptions} [opts]
 */
function spawnChild({ config, input, cliPath, timeoutMs, idleTimeoutMs, stream } = {}) {
  if (typeof config !== 'string' || !config) {
    throw new Error('[spawn] requires { config: <path> }');
  }
  const cli = cliPath || resolveCliPath();
  const child = cpSpawn(process.execPath, [cli, '--config', config], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BAREGUARD_AUDIT_PATH:    process.env.BAREGUARD_AUDIT_PATH || '',
      BAREGUARD_BUDGET_FILE:   process.env.BAREGUARD_BUDGET_FILE || '',
      BAREGUARD_PARENT_RUN_ID: process.env.BAREGUARD_RUN_ID
        || process.env.BAREGUARD_PARENT_RUN_ID
        || '',
      BAREGUARD_SPAWN_DEPTH:   String((Number(process.env.BAREGUARD_SPAWN_DEPTH) || 0) + 1),
    },
  });

  if (input !== undefined) {
    child.stdin.write(JSON.stringify(input) + '\n');
  }
  child.stdin.end();

  /** @type {ChildEvent[]} */
  const events = [];
  /** @type {((event: ChildEvent) => void)[]} */
  const lineSubscribers = [];
  /** @param {(event: ChildEvent) => void} fn */
  const onLine = (fn) => { lineSubscribers.push(fn); return () => {
    const i = lineSubscribers.indexOf(fn);
    if (i >= 0) lineSubscribers.splice(i, 1);
  }; };

  // Idle watchdog: kill the child after `idleTimeoutMs` of silence on BOTH stdio streams.
  // Distinct from `timeoutMs` (wall-clock ceiling): this catches a child that is alive but stuck
  // producing nothing — the "no activity in stderr" hang — without punishing one doing slow work,
  // since `armIdle()` resets on every line. Armed at spawn so a child that never emits is caught too.
  let idleTimer = null;
  let idleKilled = false;
  const armIdle = () => {
    if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleKilled = true;
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000).unref();
    }, idleTimeoutMs);
    idleTimer.unref();
  };
  armIdle();

  // stdout — JSONL events from the child loop
  const outRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  outRl.on('line', (line) => {
    if (!line) return;
    armIdle();
    let event;
    try { event = JSON.parse(line); }
    catch {
      // Not JSON — treat as raw text on the child's stdout (rare; surface as event)
      event = { type: 'child:stdout_raw', text: line, ts: new Date().toISOString() };
    }
    events.push(event);
    for (const fn of lineSubscribers) {
      try { fn(event); } catch (/** @type {any} */ err) {
        // never let a subscriber kill the read loop
        process.stderr.write(`[spawn] onLine subscriber threw: ${err.message}\n`);
      }
    }
  });

  // stderr — re-emit as child:stderr events on the same JSONL channel.
  // Per the v0.9 decision: one stream per child. Wake.sh captures everything
  // (events + debug) by redirecting child stdout alone; stderr was the
  // *parent's* problem to consolidate into the JSONL stream.
  const errRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
  errRl.on('line', (line) => {
    if (!line) return;
    armIdle();
    const event = { type: 'child:stderr', text: line, ts: new Date().toISOString() };
    events.push(event);
    if (stream) {
      try { stream.emit(event); } catch { /* swallow */ }
    }
  });

  // Pre-register close-event promises NOW (not lazily inside child.on('exit')).
  // The close event can fire before the exit handler runs; attaching .once()
  // after the fact would hang forever.
  const outClosePromise = new Promise(r => outRl.once('close', r));
  const errClosePromise = new Promise(r => errRl.once('close', r));

  // Timeout: kill child if it overruns. The grace period after SIGTERM is 5s
  // before SIGKILL — enough for the child to flush its final JSONL line.
  let killTimer = null;
  if (timeoutMs && timeoutMs > 0) {
    killTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 5000).unref();
    }, timeoutMs);
    killTimer.unref();
  }

  const exitPromise = new Promise((resolve) => {
    child.on('exit', async (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (idleTimer) clearTimeout(idleTimer);
      // Drain stdio readlines before resolving — last line may still be in buffer.
      await Promise.all([outClosePromise, errClosePromise]);
      resolve({ code, signal, idleKilled });
    });
    child.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      if (idleTimer) clearTimeout(idleTimer);
      resolve({ code: null, signal: null, spawnError: err });
    });
  });

  async function wait() {
    const { code, signal, spawnError, idleKilled: idle } = await exitPromise;
    if (spawnError) {
      return {
        text: '',
        usage: { inputTokens: 0, outputTokens: 0 },
        cost: 0,
        error: `[spawn] failed to spawn child: ${spawnError.message}`,
        events,
        exitCode: null,
        signal: null,
        idleKilled: false,
      };
    }
    // Pluck the final loop:done event — that's the canonical child result.
    // `findLast` is es2023; the lib target may not declare it, so reach it via
    // `any` while keeping the runtime fallback for older Node versions.
    const done = /** @type {any} */ (events).findLast?.((/** @type {ChildEvent} */ e) => e.type === 'loop:done')
      || [...events].reverse().find(e => e.type === 'loop:done');
    if (done) {
      return {
        text: done.data?.text || '',
        usage: done.data?.usage || { inputTokens: 0, outputTokens: 0 },
        cost: done.data?.cost ?? 0,
        error: done.data?.warning || null,
        events,
        exitCode: code,
        signal,
        idleKilled: !!idle,
      };
    }
    // No loop:done — child exited abnormally or never reached the LLM.
    const errEvent = events.find(e => e.type === 'loop:error' || e.type === 'error');
    const idleNote = idle ? `[spawn] child killed after idle timeout (no output; signal=${signal})` : null;
    return {
      text: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      cost: 0,
      error: idleNote || errEvent?.data?.error || `[spawn] child exited (code=${code}, signal=${signal}) without loop:done`,
      events,
      exitCode: code,
      signal,
      idleKilled: !!idle,
    };
  }

  /** @param {NodeJS.Signals} [sig] */
  function kill(sig = 'SIGTERM') {
    try { child.kill(sig); } catch { /* already dead */ }
  }

  return { wait, onLine, kill, pid: child.pid };
}

/**
 * LLM-callable spawn tool. Blocks; returns the child's final result.
 *
 * @param {object} [options]
 * @param {string} [options.cliPath] - Override the bareagent CLI path (default: ./bin/cli.js relative to this file).
 * @param {number} [options.timeoutMs] - Force-kill child after this many ms (default 10 min, wall-clock ceiling).
 * @param {number} [options.idleTimeoutMs] - Force-kill child after this many ms of no stdout/stderr output
 *   (heartbeat watchdog; default off). Resets on every line, so slow-but-working children survive.
 * @param {Stream} [options.stream] - bareagent Stream instance — child:stderr events get re-emitted here.
 * @returns {{tool: import('../types').ToolDef, spawnChild: typeof spawnChild}}
 */
function createSpawnTool(options = {}) {
  const tool = {
    name: 'spawn',
    description:
      'Fork a child bareagent process with the given config file and optional JSON input. Blocks until the child finishes; returns its final {text, usage, cost, error, events}. Use this to delegate work to a specialist agent. Per-family limits (maxChildren, maxDepth, spawn.ratePerMinute) are enforced by bareguard.',
    parameters: {
      type: 'object',
      properties: {
        config: {
          type: 'string',
          description: 'Path to a bareagent config JSON file (specialist definition). Resolved relative to the parent process cwd.',
        },
        input: {
          description: 'Optional JSON input passed to the child on stdin (any shape; the child config decides how to interpret it).',
        },
      },
      required: ['config'],
    },
    execute: async (/** @type {{config: string, input?: *}} */ { config, input }) => {
      const handle = spawnChild({
        config,
        input,
        cliPath: options.cliPath,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        idleTimeoutMs: options.idleTimeoutMs,
        stream: options.stream,
      });
      return await handle.wait();
    },
  };
  return { tool, spawnChild };
}

module.exports = { createSpawnTool, spawnChild };
