'use strict';

/**
 * BA-16 — CLIPipe NATIVE tool mode (`toolProtocol:'claude-mcp'`).
 *
 * ── Why this exists beside the 0.32.0 envelope emulation ─────────────────────────────────────────
 *
 * The emulation treats the CLI as a plain turn-provider: one spawn per round, the whole transcript
 * re-rendered and re-sent every time. That is the right instrument for a CLI with no tool channel,
 * and the WRONG one for the claude CLI, which has a native one. The cost is the argument, and it is
 * measured, not asserted: re-sending the full prefix every turn pays fresh `cache_creation` on all
 * of it, which the adopter measured at **$0.25–0.55/round** on a real ~40-round job transcript —
 * against **$0.0055–0.0074/turn** for a native session (independently reproduced here and by the
 * adopter). A session has session-incremental caching that the emulation structurally cannot have.
 *
 * NOT CLAIMED: an output-quality improvement. There is n=2 suggestive evidence that the emulation's
 * JSON-questionnaire framing makes a model act less, and it is NOT minted — do not sell it. Cost is
 * the claim. (The BA-7 precedent: a protocol fix ships labeled honestly or not at all.)
 *
 * ── What changes, and what that costs ────────────────────────────────────────────────────────────
 *
 * The CLI owns the inner cycle. That is a real trade and it is stated plainly rather than papered
 * over: the Loop's PER-ROUND machinery cannot run, because there are no rounds to run it on. What
 * the Loop was buying is bought back HERE, at the `tools/call` bridge — which sees every call, so it
 * is a strictly sufficient seam for the guards that matter:
 *
 *   - authorization    the SAME `policy(tool, args, ctx)` chokepoint the Loop uses, so a wired gate
 *                      writes AUDIT ROWS OF IDENTICAL SHAPE with zero gate changes (adopters read
 *                      that file as an instrument; a shape change would blind them silently)
 *   - deny streak      BA-11, same default (3), same reset-on-any-allowed-call semantics
 *   - identical-error  BA-12, same default (3), same NARROWEST trigger (name + JSON args, byte-equal)
 *   - turn bound       `--max-turns`, whose stop is NAMED (`error_max_turns`), never a silent success
 *
 * What is genuinely LOST and cannot be bought back here: the per-round context seams (`assemble`,
 * `trim`, stash compaction) and `cacheMessages` — the CLI owns the transcript, so no caller seam can
 * reach it. Those options THROW at construction rather than sit silently dead.
 *
 * ── The failure mode this module exists to not have ──────────────────────────────────────────────
 *
 * A dead bridge does NOT make the CLI report failure. Measured before building: with the bridge
 * killed mid-call, every tool call failed and the session still ended `subtype:'success'` — the
 * model wrote a tidy final answer explaining that its tools were broken. Mapping that subtype
 * straight onto `error:null` would report a run in which NOTHING WORKED as converged: the exact
 * BA-4/5/6/13 "under-modeled boundary rounds optimistically toward success" class this repo keeps
 * paying for. So bridge health is tracked PARENT-SIDE and error-tags the session regardless of what
 * the CLI's own subtype says. The CLI's subtype is not a sufficient success signal.
 */

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ProviderError, HaltError } = require('./errors');

/** Path to the stdio stub the CLI spawns. Resolved once — it ships inside the package. */
const STUB_PATH = path.join(__dirname, 'mcp-bridge-stub.js');

/** Mirrors the Loop's own BA-11 / BA-12 defaults so native mode is not quietly laxer. */
const DEFAULT_MAX_CONSECUTIVE_DENIALS = 3;
const DEFAULT_MAX_IDENTICAL_TOOL_ERRORS = 3;

/** The MCP server name the CLI sees; tool names reach the model as `mcp__bareagent__<tool>`. */
const SERVER_NAME = 'bareagent';

/**
 * Stable key for BA-12's identical-tool-error guard. NARROWEST trigger by design: only a
 * BYTE-IDENTICAL repeat counts. Counting any consecutive failure was measured to punish the
 * recovery it exists to protect (a model varying args while working through an ENOENT).
 * @param {string} name
 * @param {any} args
 * @returns {string}
 */
function toolErrorKey(name, args) {
  let serialized;
  try { serialized = JSON.stringify(args ?? {}); } catch (_) { serialized = '<unserializable>'; }
  return `${name}:${serialized}`;
}

/**
 * Clamp a diagnostic built from a thrown value of unknown shape before it can ride into a
 * `receipts`/audit string. A non-Error throw serialized wholesale has previously pushed a secret
 * into a plaintext audit log (the F16/BA-1 capture class), and an append-only log that captures a
 * key captures it forever. Conventional fields only, hard length cap, never the whole object.
 * @param {any} err
 * @returns {string}
 */
function safeErrorText(err) {
  let msg;
  if (err instanceof Error) msg = `${err.constructor.name}: ${err.message}`;
  else if (typeof err === 'string') msg = err;
  else if (err && typeof err === 'object' && typeof err.message === 'string') msg = err.message;
  else msg = `non-Error throw (${typeof err})`;
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

/**
 * The parent-side bridge: a unix-socket server backed by the caller's in-process tool closures,
 * with the gate and both spin guards wired at the one seam that sees every call.
 *
 * Unix socket, not loopback TCP: a library must not open a listening network port as a side effect
 * of running a tool loop. The socket lives in a 0700 directory and is itself chmod 0600.
 *
 * @param {object} opts
 * @param {import('../types').ToolDef[]} opts.tools - the caller's tools (with live `execute` closures).
 * @param {Function|null} [opts.policy] - the SAME contract as `Loop({policy})`: only `true` allows;
 *   a string is the deny reason fed back verbatim.
 * @param {any} [opts.ctx] - opaque governance ctx, forwarded to `policy` unchanged.
 * @param {number} [opts.maxConsecutiveDenials]
 * @param {number} [opts.maxIdenticalToolErrors]
 * @returns {Promise<{sockPath: string, state: any, close: () => void}>}
 */
async function createBridge({ tools, policy = null, ctx = undefined, maxConsecutiveDenials, maxIdenticalToolErrors }) {
  const denyCap = Number.isFinite(maxConsecutiveDenials) ? Number(maxConsecutiveDenials) : DEFAULT_MAX_CONSECUTIVE_DENIALS;
  const errCap = Number.isFinite(maxIdenticalToolErrors) ? Number(maxIdenticalToolErrors) : DEFAULT_MAX_IDENTICAL_TOOL_ERRORS;

  const byName = new Map(tools.map((t) => [t.name, t]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bareagent-bridge-'));
  fs.chmodSync(dir, 0o700);
  const sockPath = path.join(dir, 'bridge.sock');

  const state = {
    toolCalls: 0,
    consecutiveDenials: 0,
    /** @type {{key: string, count: number}} */ lastError: { key: '', count: 0 },
    /** @type {string|null} A guard tripped — the session must END, not merely refuse this call. */
    terminal: null,
    /** @type {Error|null} A HaltError raised by the gate inside a tool call — re-thrown by the caller. */
    halt: null,
    /** Parent-side bridge health. A dead bridge must not be able to read as a clean session. */
    bridgeDown: false,
  };

  /**
   * Handle one `tools/call`. Every outcome is a RESULT the model can act on; the only thing that
   * ends the session is a guard tripping, which is reported through `state.terminal`.
   *
   * The CLI can fire PARALLEL tool calls (multiple `tool_use` blocks in one turn), so two of these
   * can be in flight across their `await` points. That is safe here: `state.toolCalls++` is a
   * synchronous atomic bump, and the two guard counters are ADVISORY bounds whose precondition — a
   * SEQUENTIAL retry spin — does not apply to calls the model issued simultaneously. The worst case
   * (an early `stuck:` on genuinely-identical parallel failures) is benign and gate-bounded, so no
   * per-call lock is warranted.
   */
  async function handleCall(name, args) {
    state.toolCalls++;
    const tool = byName.get(name);

    // An unknown/hallucinated tool name feeds the SAME spin counter as a thrown error — BA-12 had to
    // count both paths, since a model looping on a name that does not exist spins just as hard.
    if (!tool) return recordFailure(name, args, `unknown tool '${name}'`);

    if (policy) {
      let verdict;
      try {
        verdict = await policy(name, args, ctx);
      } catch (err) {
        // A governance halt is a clean exit, not a tool error — stash it and end the session.
        if (err instanceof HaltError) { state.halt = err; state.terminal = `halt:${err.message}`; return { isError: true, text: 'session halted by governance' }; }
        throw err;
      }
      if (verdict !== true) {
        state.consecutiveDenials++;
        const reason = typeof verdict === 'string' ? verdict : `denied by policy: ${name}`;
        // BA-11: a single deny stays ADVISORY so the model can pivot to an allowed tool
        // (allowlist-safe). Only a STREAK with no allowed call in between ends the session.
        if (denyCap > 0 && Number.isFinite(denyCap) && state.consecutiveDenials >= denyCap) {
          state.terminal = `denied:${name}`;
          return { isError: true, text: `${reason} — ${state.consecutiveDenials} consecutive denials; ending session` };
        }
        return { text: reason };
      }
      state.consecutiveDenials = 0; // any allowed call resets the streak
    }

    try {
      const out = await tool.execute(args || {});
      state.lastError = { key: '', count: 0 }; // success resets the identical-error streak
      return { text: typeof out === 'string' ? out : JSON.stringify(out) };
    } catch (err) {
      if (err instanceof HaltError) { state.halt = err; state.terminal = `halt:${err.message}`; return { isError: true, text: 'session halted by governance' }; }
      return recordFailure(name, args, safeErrorText(err));
    }
  }

  /** BA-12: count a byte-identical repeat; N in a row ends the session, anything else is feedback. */
  function recordFailure(name, args, text) {
    const key = toolErrorKey(name, args);
    state.lastError = key === state.lastError.key
      ? { key, count: state.lastError.count + 1 }
      : { key, count: 1 };
    if (errCap > 0 && Number.isFinite(errCap) && state.lastError.count >= errCap) {
      state.terminal = `stuck:${name}`;
      return { isError: true, text: `${text} — repeated ${state.lastError.count}× identically; ending session` };
    }
    return { isError: true, text };
  }

  const manifest = tools.map((t) => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.parameters || { type: 'object', properties: {} },
  }));

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', async (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch (_) { return conn.end(); }
      buf = '';
      try {
        if (req.op === 'list') return conn.write(JSON.stringify({ tools: manifest }) + '\n');
        if (req.op === 'call') {
          const res = await handleCall(req.name, req.args);
          return conn.write(JSON.stringify(res) + '\n');
        }
      } catch (err) {
        // Never let a handler fault kill the bridge — it becomes a result the model reads.
        try { conn.write(JSON.stringify({ isError: true, text: safeErrorText(err) }) + '\n'); } catch (_) { /* peer gone */ }
      }
    });
    conn.on('error', () => { /* peer vanished mid-call; the stub turns that into a tool result */ });
  });

  // Parent-side health: if our own listener dies while a session is live, every subsequent tool
  // call silently fails on the CLI side and the session can still end 'success'. Record it.
  server.on('error', () => { state.bridgeDown = true; });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => { try { fs.chmodSync(sockPath, 0o600); } catch (_) { /* best effort */ } resolve(undefined); });
  });

  return {
    sockPath,
    state,
    close() {
      try { server.close(); } catch (_) { /* already closed */ }
      try { fs.rmSync(path.dirname(sockPath), { recursive: true, force: true }); } catch (_) { /* best effort */ }
    },
  };
}

/**
 * Map the CLI's session `subtype` onto (neutral stop reason, session error).
 *
 * Own-property lookup only: `subtype` is provider-supplied, so a value like `toString` would
 * otherwise resolve to an inherited `Object.prototype` function and be mistaken for a mapping —
 * the proto-key footgun this repo has now fixed three times.
 */
const SUBTYPE_MAP = {
  success: { stopReason: 'end_turn', error: null },
  error_max_turns: { stopReason: 'max_turns', error: 'max_turns' },
  error_during_execution: { stopReason: null, error: 'session_error' },
};

/**
 * Terminals WE impose that ARE stop reasons in the neutral vocabulary. A guard terminal
 * (`denied:`/`stuck:`) is deliberately absent — those are faults, not stop reasons.
 * @type {Record<string, string>}
 */
const TERMINAL_STOP = { max_turns: 'max_turns' };

/**
 * @param {string|null|undefined} subtype
 * @returns {{stopReason: string|null, error: string|null}}
 */
function classifySubtype(subtype) {
  if (typeof subtype !== 'string' || subtype === '') {
    // No result event at all — the session died without reporting. NOT a success.
    return { stopReason: null, error: 'session_incomplete' };
  }
  if (Object.prototype.hasOwnProperty.call(SUBTYPE_MAP, subtype)) return SUBTYPE_MAP[subtype];
  // An unrecognized subtype is surfaced verbatim and ERROR-TAGGED, never passed through as clean:
  // the whole BA-13 lesson is that a terminal the consumer branches on must be tagged, not just seen.
  return { stopReason: subtype, error: `session:${subtype}` };
}

/**
 * Decide the session's terminal tag. Pure, so the precedence is testable without a live CLI.
 *
 * The ordering is the whole point:
 *   1. `terminal`   — a guard tripped and WE killed the session; most specific, and it explains why
 *                     the CLI's own subtype is missing or odd.
 *   2. bridge broken — a tool call the CLI ATTEMPTED but the bridge never SERVED never reached the
 *                     caller's closure. This must outrank a reported `success`, because a session
 *                     whose tools were all broken still ends `subtype:'success'` — the model writes
 *                     a tidy final answer explaining that its tools failed, and mapping that onto
 *                     `error:null` reports a run in which nothing worked as converged.
 *   3. `timedOut`   — we killed it on the wall clock.
 *   4. the subtype  — what the CLI itself said.
 *
 * @param {{terminal: string|null, bridgeDown: boolean, attempted: number, served: number, timedOut: boolean, subtype: string|null|undefined}} facts
 * @returns {{stopReason: string|null, error: string|null}}
 */
function resolveSessionError(facts) {
  const fromSubtype = classifySubtype(facts.subtype);
  if (facts.terminal) {
    // A terminal WE imposed kills the session before its `result` event, so there is no subtype to
    // read a stop reason from. Where the terminal IS a stop reason in the neutral vocabulary, say so
    // — a consumer branching on `stopReason` must not see `null` for a bound it asked for.
    // Own-property only: same proto-key footgun as SUBTYPE_MAP.
    const named = Object.prototype.hasOwnProperty.call(TERMINAL_STOP, facts.terminal)
      ? TERMINAL_STOP[facts.terminal] : null;
    return { stopReason: named || fromSubtype.stopReason, error: facts.terminal };
  }
  const bridgeBroken = facts.bridgeDown
    || (Number.isFinite(facts.attempted) && Number.isFinite(facts.served) && facts.attempted > facts.served);
  if (bridgeBroken) return { stopReason: fromSubtype.stopReason, error: 'bridge-failed' };
  if (facts.timedOut) return { stopReason: fromSubtype.stopReason, error: 'session_timeout' };
  return fromSubtype;
}

/**
 * Line-oriented processor for the CLI's `stream-json` stdout.
 *
 * ONE TURN IS ONE ASSISTANT MESSAGE, NOT ONE EVENT (BA-17). Measured on the real wire: the CLI
 * emits a SEPARATE `assistant` event per content BLOCK of the same message, and every one of them
 * repeats that message's `usage` verbatim — one 13-block message arrived as 13 events carrying the
 * same numbers. Treating each event as a turn is wrong on both axes a caller meters:
 *   - the TURN axis  — a caller whose attempt bound is an LLM-turn count sees 14 "turns" for 2 real
 *                      ones (measured 7×; 4.4× on the adopter's failing run), so its net guillotines
 *                      the session at a fraction of the allowance it advertised;
 *   - the TOKEN axis — the same message's usage is added once per block (measured 5.04× inflated
 *                      against the CLI's own session total), so a budget cap fires early on tokens
 *                      that were never spent.
 * So a RUN of consecutive events sharing `message.id` is ONE turn: usage is recorded once and one
 * `onTurn` fires. Adjacent-run dedup, not a Set — an id that somehow recurred later must still count
 * as a new turn (dropping a real turn is the failure that matters). An event with NO id degrades to
 * one-turn-per-event: the pre-BA-17 behaviour, never a collapse of the whole session into one turn.
 *
 * FRAMING IS SYNCHRONOUS. The obvious shape — an `async` stdout handler that `await`s `onTurn`
 * inside its parse loop — has a data-corruption bug: while the `await` is suspended, the next
 * `'data'` event re-enters the handler and mutates the SHARED line buffer, so the suspended parse
 * resumes against a buffer that moved under it (dropped/duplicated/mangled lines). It is invisible
 * with a synchronous `onTurn` (the await resolves on the microtask queue before the next macrotask
 * `'data'` event) and REACHABLE the moment `onTurn` does real async work — e.g. a wired gate's
 * `gate.record`, which is exactly the intended consumer. So framing never awaits: it parses lines
 * synchronously and pushes per-turn forwards onto a queue that a SERIAL async drainer empties in
 * arrival order. Extracted from `runSession` so this can be unit-tested without spawning the CLI.
 *
 * @param {object} o
 * @param {Function|null} o.onTurn
 * @param {any} o.ctx
 * @param {number} o.startedAt
 * @param {(err: Error) => void} o.onHalt - called if a forwarded `onTurn` throws a HaltError.
 * @param {number|null} [o.turnCap] - BA-17 backstop: fires `onLimit` the moment a turn BEYOND this
 *   many is observed. Deliberately not `>=`: `--max-turns` is passed to the CLI too, and when it
 *   works (measured: it does, and it counts assistant turns) the CLI ends the session ITSELF at the
 *   cap and emits its `result` event — which is the only place the authoritative session cost
 *   arrives. Killing the session at exactly N would throw that figure away on every bounded run. So
 *   this fires ONLY on an overrun, i.e. only if the flag ever stops working — it is undocumented in
 *   `claude --help`, so the guarantee cannot rest on it alone.
 * @param {(() => void)} [o.onLimit] - called once when `turnCap` is exceeded.
 */
function createSessionStream({ onTurn, ctx, startedAt, onHalt, turnCap = null, onLimit = () => {} }) {
  let buf = '';
  let attempted = 0;
  let final = null;
  /** Adjacent-run dedup key: the `message.id` of the turn currently being emitted. */
  let turnId = /** @type {string|null} */ (null);
  /** Has the CURRENT turn already contributed its usage? Blocks of one message repeat it. */
  let turnMetered = false;
  let turnCount = 0;
  let limitFired = false;
  /** Text of the current turn, and the last turn that produced any — BA-5 work preservation. */
  let curText = '';
  let lastText = '';
  /** @type {import('../types').Usage[]} */ const turns = [];
  /** @type {any[]} */ const queue = [];
  /** @type {Promise<void>|null} */ let draining = null;

  async function drain() {
    if (!onTurn) return;
    while (queue.length) {
      const payload = queue.shift();
      try {
        await onTurn(payload);
      } catch (err) {
        // A governance HaltError from the gate ends the session; anything else is surfaced, not fatal.
        if (err instanceof HaltError) { queue.length = 0; onHalt(/** @type {Error} */ (err)); return; }
      }
    }
  }
  function pump() {
    if (!onTurn || draining) return;
    draining = drain().finally(() => { draining = null; if (queue.length) pump(); });
  }

  return {
    /** Feed a stdout chunk. Pure synchronous framing — never awaits. */
    feed(/** @type {Buffer|string} */ chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_) { continue; }

        // Count tool calls the CLI ATTEMPTED against our server. Compared later with what the bridge
        // actually SERVED, this is the only precise parent-side detector of a broken bridge: if the
        // stub cannot reach the socket our server never sees the connection, so a server-side flag
        // stays clean while every tool call fails — and the session still ends `subtype:'success'`
        // (measured). Attempted > served is the honest signal.
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (block && block.type === 'tool_use' && typeof block.name === 'string'
                && block.name.startsWith(`mcp__${SERVER_NAME}__`)) attempted++;
          }
        }

        if (ev.type === 'assistant' && ev.message) {
          // Is this event the start of a NEW assistant turn, or another block of the current one?
          // No id at all ⇒ its own turn (degrade to the pre-BA-17 shape, never collapse into one).
          const id = (typeof ev.message.id === 'string' && ev.message.id) ? ev.message.id : null;
          if (id === null || id !== turnId) {
            turnId = id;
            turnMetered = false;
            curText = '';
            turnCount++;
            // The overrun backstop. `>` not `>=`, so a CLI that honours --max-turns keeps its clean
            // exit (and with it the only report of the session's real cost).
            if (!limitFired && Number.isFinite(turnCap) && Number(turnCap) > 0 && turnCount > Number(turnCap)) {
              limitFired = true;
              onLimit();
            }
          }

          // BA-5: keep the turn's own words, so a bound/guard stop still returns the work done. The
          // CLI reports `result: null` on a bounded session — measured — so this is the ONLY source.
          for (const block of (ev.message.content || [])) {
            if (block && block.type === 'text' && typeof block.text === 'string' && block.text) {
              curText += block.text;
              lastText = curText;
            }
          }

          // Usage rides on EVERY block-event of the message; count it once per turn. Read on any
          // event of the turn (not just the first) — the first block need not be the one carrying it.
          if (ev.message.usage && !turnMetered) {
            turnMetered = true;
            const u = ev.message.usage;
            /** @type {import('../types').Usage} */
            const usage = {
              inputTokens: Number(u.input_tokens) || 0,
              outputTokens: Number(u.output_tokens) || 0,
            };
            // Omit an absent tier rather than emit a synthetic 0 (per the Usage contract).
            if (Number.isFinite(u.cache_read_input_tokens)) usage.cacheReadTokens = u.cache_read_input_tokens;
            if (Number.isFinite(u.cache_creation_input_tokens)) usage.cacheCreationTokens = u.cache_creation_input_tokens;
            turns.push(usage);
            // Stream it: a session that dies mid-run must already have surfaced every completed turn's
            // spend, or the gate loses it. Queued (not awaited here) so framing cannot race the buffer.
            if (onTurn) queue.push({
              model: ev.message.model || null,
              provider: 'clipipe',
              usage,
              costUsd: null, // the CLI prices the SESSION, not the turn — explicitly unpriced, never a synthetic 0.
              pricing: 'unpriced',
              durationMs: Date.now() - startedAt,
              ctx, // what a wired gate records spend against — same as the Loop's onLlmResult.
              kind: 'turn',
            });
          }
        }

        if (ev.type === 'result') final = ev;
      }
      pump();
    },
    /** Await every queued per-turn forward — call before resolving the session. */
    async flush() { if (draining) await draining; await drain(); },
    get turns() { return turns; },
    /** Assistant TURNS observed — including any that carried no usage. */
    get turnCount() { return turnCount; },
    /** The last turn's text. The work a bounded/guard-stopped session still did (BA-5). */
    get lastText() { return lastText; },
    get attempted() { return attempted; },
    get final() { return final; },
  };
}

/**
 * Run ONE native CLI session to completion, streaming per-turn usage as it arrives.
 *
 * @param {object} opts
 * @returns {Promise<any>}
 */
function runSession(opts) {
  const {
    command, baseArgs = [], systemPrompt, task, sockPath, maxTurns, timeoutMs,
    onTurn = null, ctx, cwd, env, bridgeTimeoutMs,
  } = opts;

  const mcpConfig = JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: {
        command: process.execPath,
        args: [STUB_PATH],
        env: {
          BAREAGENT_BRIDGE_SOCK: sockPath,
          ...(bridgeTimeoutMs ? { BAREAGENT_BRIDGE_TIMEOUT_MS: String(bridgeTimeoutMs) } : {}),
        },
      },
    },
  });

  // The fence is set BY THE MODE, never left to the caller: `--tools ''` + `--strict-mcp-config`
  // strip the CLI's own tool surface (so a granted-verb fence cannot be widened by the CLI's
  // built-ins), and `--setting-sources ''` suppresses cwd CLAUDE.md/memory auto-discovery — a
  // measured ~18× input-token cut, and also a confidentiality boundary (the CLI would otherwise
  // read the host repo's memory into every turn).
  const args = [
    ...baseArgs,
    '-p',
    '--mcp-config', mcpConfig,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--allowedTools', `mcp__${SERVER_NAME}__*`,
    '--system-prompt', systemPrompt,
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (Number.isFinite(maxTurns) && maxTurns > 0) args.push('--max-turns', String(maxTurns));

  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', settled = false;
    /** @type {Error|null} */ let turnHalt = null;
    /** @type {string|null} A terminal WE imposed from the stream (today: the BA-17 turn backstop). */
    let terminal = null;
    const started = Date.now();

    /** Kill the session now — a guard tripped or governance halted mid-flight. */
    const abort = () => { try { child.kill('SIGTERM'); } catch (_) { /* already gone */ } };
    const stream = createSessionStream({
      onTurn, ctx, startedAt: started,
      onHalt: (err) => { turnHalt = err; abort(); },
      turnCap: Number.isFinite(maxTurns) ? maxTurns : null,
      onLimit: () => { terminal = 'max_turns'; abort(); },
    });

    const done = async (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Flush queued per-turn forwards before resolving — a session that ends while a forward is
      // pending must still surface that turn's spend to the gate (F12/F18).
      try { await stream.flush(); } catch (_) { /* onTurn failures are surfaced in-drain, never fatal */ }
      resolve({
        turns: stream.turns, turnCount: stream.turnCount, lastText: stream.lastText,
        final: stream.final, stderr, ms: Date.now() - started, turnHalt, terminal,
        attempted: stream.attempted, ...extra,
      });
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      done({ timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => stream.feed(d));
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => done({ spawnError: err }));
    child.on('close', () => done());
    child.stdin.end(task);
  });
}

module.exports = {
  STUB_PATH,
  SERVER_NAME,
  DEFAULT_MAX_CONSECUTIVE_DENIALS,
  DEFAULT_MAX_IDENTICAL_TOOL_ERRORS,
  toolErrorKey,
  safeErrorText,
  createBridge,
  classifySubtype,
  resolveSessionError,
  createSessionStream,
  runSession,
};
