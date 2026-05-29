'use strict';

const { ToolError, HaltError } = require('./errors');

/** @typedef {import('../types').Provider} Provider */
/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').ToolCall} ToolCall */
/** @typedef {import('../types').Usage} Usage */
/** @typedef {import('../types').GenerateResult} GenerateResult */
/** @typedef {import('../types').Store} Store */
/** @typedef {import('./checkpoint').Checkpoint} Checkpoint */
/** @typedef {import('./retry').Retry} Retry */
/** @typedef {import('./stream').Stream} Stream */

/**
 * @typedef {object} LoopOptions
 * @property {Provider} provider
 * @property {string} [system]
 * @property {Checkpoint} [checkpoint]
 * @property {Retry} [retry]
 * @property {Stream} [stream]
 * @property {Store} [store]
 * @property {Function} [onToolCall]
 * @property {Function} [onText]
 * @property {Function} [onError]
 * @property {boolean} [throwOnError]
 * @property {Function} [policy]
 * @property {Function} [onLlmResult]
 * @property {Function} [onToolResult]
 * @property {number} [maxRounds] - Removed in v0.8; presence throws a migration error.
 */

// Average pricing per 1K tokens (USD). Adjust these to match your provider's rates.
// Last updated: 2026-05-18. Source: public provider pricing pages.
/** @type {Record<string, {in: number, out: number}>} */
const COST_PER_1K = {
  // OpenAI
  'gpt-4o': { in: 0.0025, out: 0.01 },
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4.1': { in: 0.002, out: 0.008 },
  'gpt-4.1-mini': { in: 0.0004, out: 0.0016 },
  'gpt-4.1-nano': { in: 0.0001, out: 0.0004 },
  'o3-mini': { in: 0.0011, out: 0.0044 },
  // Anthropic — Claude 4.x current generation (2026-05)
  'claude-opus-4-7': { in: 0.015, out: 0.075 },
  'claude-sonnet-4-6': { in: 0.003, out: 0.015 },
  'claude-haiku-4-5-20251001': { in: 0.0008, out: 0.004 },
  'claude-haiku-4-5': { in: 0.0008, out: 0.004 },
  // Anthropic — earlier 4.x snapshots
  'claude-sonnet-4-20250514': { in: 0.003, out: 0.015 },
  'claude-opus-4-20250514': { in: 0.015, out: 0.075 },
  // Fallback average across popular models (~$0.002 in, ~$0.008 out per 1K)
  '_default': { in: 0.002, out: 0.008 },
};

// Internal safety net only — real iteration bounds come from a wired bareguard
// Gate via `limits.maxTurns`. If you hit this without bareguard wired, you have
// no governance and the LLM loop is unbounded by design — wire bareguard.
const HARD_ROUND_LIMIT = 100;

// Walk the assistant tool_calls in the last assistant message and append a
// synthetic `role:'tool'` reply for every tool_call_id that has no matching
// reply. Halt-path only — keeps msgs a valid OpenAI transcript when the loop
// exits between pushing assistant.tool_calls and finishing the per-tool loop.
/**
 * @param {Message[]} msgs
 * @param {string} rule
 */
function sealDanglingToolCalls(msgs, rule) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    const seen = new Set();
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role === 'tool' && msgs[j].tool_call_id) seen.add(msgs[j].tool_call_id);
    }
    for (const tc of m.tool_calls) {
      if (!seen.has(tc.id)) {
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: `[halted:${rule}]` });
      }
    }
    return;
  }
}

/**
 * @param {string|null} model
 * @param {Usage|null} usage
 * @returns {number|null}
 */
function estimateCost(model, usage) {
  if (!usage || !model) return null;
  const rates = COST_PER_1K[model] || COST_PER_1K['_default'];
  return (
    ((usage.inputTokens || 0) * rates.in +
      (usage.outputTokens || 0) * rates.out) / 1000
  );
}

class Loop {
  /**
   * `policy` is async `(toolName, args, ctx) => true | string`. Recommended wiring: a closure
   * that delegates to a bareguard Gate (`require('bare-agent/bareguard').wireGate(gate).policy`).
   * Anything other than `true` denies; a string is fed to the LLM verbatim as the deny reason.
   * A throw of `HaltError` exits the loop cleanly. `onLlmResult`/`onToolResult` forward usage and
   * tool outcomes to `gate.record` (via wireGate) and never kill the loop on error.
   * @param {LoopOptions} options
   * @throws {Error} `[Loop] requires a provider` — when options.provider is missing.
   */
  constructor(options = /** @type {LoopOptions} */ ({})) {
    if (!options.provider) throw new Error('[Loop] requires a provider');
    if (options.maxRounds !== undefined) {
      throw new Error(
        '[Loop] options.maxRounds was removed in v0.8 when single-gate governance landed. ' +
        'Bound iteration via bareguard `new Gate({ limits: { maxTurns: N } })` and wire it with ' +
        '`new Loop({ policy: wireGate(gate).policy })`. Loop\'s internal HARD_ROUND_LIMIT (100) is ' +
        'a safety net only and not configurable.',
      );
    }
    this.provider = options.provider;
    this.system = options.system || null;
    this.checkpoint = options.checkpoint || null;
    this.retry = options.retry || null;
    this.stream = options.stream || null;
    this.onToolCall = options.onToolCall || null;
    this.onText = options.onText || null;
    this.onError = options.onError || null;
    this.throwOnError = options.throwOnError !== undefined ? options.throwOnError : true;
    this.store = options.store || null;
    if (options.policy != null && typeof options.policy !== 'function') {
      throw new Error('[Loop] options.policy must be a function (toolName, args, ctx) => true | string');
    }
    this.policy = options.policy || null;
    if (options.onLlmResult != null && typeof options.onLlmResult !== 'function') {
      throw new Error('[Loop] options.onLlmResult must be a function');
    }
    if (options.onToolResult != null && typeof options.onToolResult !== 'function') {
      throw new Error('[Loop] options.onToolResult must be a function');
    }
    this.onLlmResult = options.onLlmResult || null;
    this.onToolResult = options.onToolResult || null;
    this._stopped = false;
    /** @type {Message[]} */
    this._history = []; // for chat() stateful mode
  }

  // Unified error emitter — every silent-ish failure path routes through here so
  // operators see callback throws, checkpoint timeouts, stream listener errors
  // in one place: loop:error stream event + onError callback.
  /**
   * @param {string} source
   * @param {any} err
   * @param {Record<string, any>} [extra]
   */
  _reportError(source, err, extra = {}) {
    const message = err?.message || String(err);
    this._safeEmit({ type: 'loop:error', data: { source, error: message, ...extra } });
    if (this.onError) {
      try {
        this.onError(err, { source, ...extra });
      } catch (cbErr) {
        console.warn(`[Loop] onError callback threw: ${cbErr.message}`);
      }
    }
  }

  // Swallow-proof stream emit: a throwing listener must not corrupt Loop state.
  /** @param {{type: string, data?: any, ts?: string}} event */
  _safeEmit(event) {
    if (!this.stream) return;
    try {
      this.stream.emit(event);
    } catch (err) {
      console.warn(`[Loop] stream listener threw on ${event.type}: ${err.message}`);
      if (this.onError && event.type !== 'loop:error') {
        try { this.onError(err, { source: 'stream', eventType: event.type }); } catch { /* swallow */ }
      }
    }
  }

  // Fire a user callback without letting its throw kill the loop.
  /**
   * @param {string} name
   * @param {Function|null} fn
   * @param {...any} args
   */
  _safeCall(name, fn, ...args) {
    if (!fn) return;
    try {
      fn(...args);
    } catch (err) {
      this._reportError(`callback:${name}`, err);
    }
  }

  /**
   * Run the think/act/observe loop.
   * @param {Message[]} messages - Conversation messages in OpenAI format.
   * @param {ToolDef[]} [tools=[]] - Tool definitions with name, execute, description, parameters.
   * @param {Record<string, any>} [options={}] - Per-run overrides (system, temperature, ctx, etc.).
   * @returns {Promise<{text: string, toolCalls: ToolCall[], usage: Usage, cost: number, error: string|null, msgs: Message[]}>}
   *   On halt the returned `error` is `halt:<rule>` (or `halt:unknown` if the
   *   thrown HaltError carried no `rule`), and `msgs` is sanitized so any
   *   dangling assistant `tool_calls` from the halted round are paired with
   *   synthetic `[halted]` tool replies — safe to feed back into another
   *   provider call without violating OpenAI's tool-call/tool-result pairing.
   * @throws {Error} `[Loop] Tool is missing a name` — when a tool has no name or a non-string name.
   * @throws {Error} `[Loop] Tool "X" is missing an execute() function` — when execute is not a function.
   * @throws {Error} `[Loop] Tool "X" has invalid parameters` — when parameters is not an object.
   */
  async run(messages, tools = [], options = {}) {
    this._stopped = false;
    const system = options.system || this.system;
    const ctx = options.ctx || null; // per-run opaque blob forwarded to policy
    const msgs = system
      ? [{ role: 'system', content: system }, ...messages]
      : [...messages];
    const toolMap = new Map(tools.map(t => [t.name, t]));

    // Validate tools at wire time
    for (const tool of tools) {
      if (typeof tool.name !== 'string' || !tool.name) {
        throw new Error(`[Loop] Tool is missing a name (got ${JSON.stringify(tool.name)}). Every tool must have a non-empty string name.`);
      }
      if (typeof tool.execute !== 'function') {
        throw new Error(`[Loop] Tool "${tool.name}" is missing an execute() function.`);
      }
      if (tool.description !== undefined && typeof tool.description !== 'string') {
        console.warn(`[Loop] Tool "${tool.name}" has a non-string description — providers may ignore it.`);
      }
      if (tool.parameters !== undefined && (typeof tool.parameters !== 'object' || tool.parameters === null)) {
        throw new Error(`[Loop] Tool "${tool.name}" has invalid parameters — expected an object, got ${typeof tool.parameters}.`);
      }
    }

    this._safeEmit({ type: 'loop:start', data: { messageCount: msgs.length } });

    let lastUsage = { inputTokens: 0, outputTokens: 0 };
    let totalCost = 0;

    try {
    for (let round = 0; round < HARD_ROUND_LIMIT; round++) {
      if (this._stopped) break;

      let result;
      const llmStartedAt = Date.now();
      try {
        const generate = () => this.provider.generate(msgs, tools, options);
        result = this.retry ? await this.retry.call(generate) : await generate();
      } catch (err) {
        this._reportError('provider', err, { round });
        if (this.throwOnError) throw err;
        return { text: '', toolCalls: [], usage: lastUsage, cost: totalCost, error: err.message, msgs };
      }

      lastUsage = result.usage || lastUsage;
      const model = this.provider.model || null;
      const roundCost = estimateCost(model, lastUsage);
      if (roundCost !== null) totalCost += roundCost;

      // BA1: forward LLM usage to gate.record (via wireGate) so budget.maxCostUsd
      // covers token-heavy / tool-light workloads. Callback errors route through
      // _reportError but never kill the loop — governance failure ≠ run failure.
      if (this.onLlmResult) {
        try {
          await this.onLlmResult({
            model,
            provider: this.provider.name || null,
            usage: result.usage || null,
            costUsd: roundCost,
            durationMs: Date.now() - llmStartedAt,
            ctx,
          });
        } catch (err) {
          if (err instanceof HaltError) throw err;
          this._reportError('onLlmResult', err, { round });
        }
      }

      // No tool calls — LLM gave a final text response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        this._safeEmit({ type: 'loop:text', data: { text: result.text } });
        this._safeCall('onText', this.onText, result.text);
        this._safeEmit({ type: 'loop:done', data: { text: result.text, usage: lastUsage, cost: totalCost } });
        msgs.push({ role: 'assistant', content: result.text });
        return { text: result.text, toolCalls: [], usage: lastUsage, cost: totalCost, error: null, msgs };
      }

      // Execute tool calls
      msgs.push({
        role: 'assistant',
        content: result.text || null,
        tool_calls: result.toolCalls.map((/** @type {ToolCall} */ tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });

      for (const tc of result.toolCalls) {
        if (this._stopped) break;

        const tool = toolMap.get(tc.name);
        if (!tool) {
          const errMsg = `[Loop] Unknown tool: ${tc.name}`;
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, error: errMsg } });
          continue;
        }

        // Checkpoint — ask for approval before executing
        if (this.checkpoint?.shouldAsk(tc.name, tc.arguments)) {
          this._safeEmit({ type: 'checkpoint:ask', data: { tool: tc.name, args: tc.arguments } });
          let reply;
          try {
            reply = await this.checkpoint.ask(
              `Approve ${tc.name}(${JSON.stringify(tc.arguments)})?`,
              { tool: tc.name, args: tc.arguments }
            );
          } catch (err) {
            // Checkpoint errors (e.g. timeout, transport failure) auto-deny and
            // get reported via loop:error + onError. The loop never hangs silently.
            this._reportError('checkpoint', err, { tool: tc.name });
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: `[Loop] Checkpoint failed: ${err.message}. Action auto-denied.` });
            continue;
          }
          this._safeEmit({ type: 'checkpoint:reply', data: { reply } });
          // Fail-closed: approve ONLY on an explicit affirmative. Any other reply —
          // an unrecognized string ("denied", "wait"), empty, or a non-string — denies.
          // A human approval gate must never approve on ambiguous input, and reading
          // .toLowerCase() off a non-string here used to throw out of run().
          const approved = typeof reply === 'string'
            && ['yes', 'y', 'approve', 'approved'].includes(reply.trim().toLowerCase());
          if (!approved) {
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: 'User denied this action.' });
            continue;
          }
        }

        this._safeEmit({ type: 'loop:tool_call', data: { tool: tc.name, args: tc.arguments } });
        this._safeCall('onToolCall', this.onToolCall, tc.name, tc.arguments);

        // Policy check — runs before execute. Fail-safe: only verdict === true allows;
        // anything else (false, string, undefined, object, throw) denies. A string verdict
        // is used verbatim as the deny reason. `ctx` (opaque blob passed via
        // loop.run(msgs, tools, { ctx })) is forwarded as the third arg for per-caller gating.
        // Recommended wiring: bareguard's Gate via `wireGate(gate).policy` — bareguard
        // owns budget, audit, and halt decisions; Loop just respects the verdict.
        if (this.policy) {
          let verdict;
          try {
            verdict = await this.policy(tc.name, tc.arguments, ctx);
          } catch (err) {
            // BA2: HaltError bubbles past the per-tool try/catch to the outer
            // handler so halt exits cleanly without ever reaching the LLM.
            if (err instanceof HaltError) throw err;
            verdict = `[Loop] policy error: ${err.message}`;
          }
          if (verdict !== true) {
            const reason = typeof verdict === 'string'
              ? verdict
              : `[Loop] Tool "${tc.name}" denied by policy`;
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: reason });
            this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, denied: true, reason } });
            continue;
          }
        }

        const toolStartedAt = Date.now();
        let toolResult;
        let toolError;
        try {
          const execute = () => tool.execute(tc.arguments);
          toolResult = this.retry ? await this.retry.call(execute) : await execute();
          const content = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          msgs.push({ role: 'tool', tool_call_id: tc.id, content });
          this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, result: content } });
        } catch (err) {
          toolError = err instanceof ToolError ? err : new ToolError(err.message, { context: { tool: tc.name } });
          const errMsg = `[Loop] Tool error: ${toolError.message}`;
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, error: errMsg } });
        }

        // BA1: forward tool result/error to gate.record (via wireGate) with ctx in
        // scope — fixes the lost-_ctx issue that wrapTool can't solve.
        if (this.onToolResult) {
          try {
            await this.onToolResult({
              name: tc.name,
              args: tc.arguments,
              result: toolResult,
              error: toolError || null,
              durationMs: Date.now() - toolStartedAt,
              ctx,
            });
          } catch (err) {
            if (err instanceof HaltError) throw err;
            this._reportError('onToolResult', err, { tool: tc.name });
          }
        }
      }
    }
    } catch (err) {
      // BA2: HaltError is a clean governance exit, not a runtime failure.
      // No throw even when throwOnError:true — the gate halted us deliberately.
      if (err instanceof HaltError) {
        const rule = err.rule || 'unknown';
        // Pair any dangling assistant.tool_calls (from the halted round) with
        // synthetic `[halted]` replies so the returned msgs is a valid
        // OpenAI-shaped transcript — consumers can feed it back into another
        // provider call without tripping the tool-call/tool-result pairing.
        sealDanglingToolCalls(msgs, rule);
        this._reportError('halt', err, { rule, reason: err.decision?.reason ?? null });
        this._safeEmit({ type: 'loop:done', data: { text: '', halted: true, rule, cost: totalCost } });
        return { text: '', toolCalls: [], usage: lastUsage, cost: totalCost, error: `halt:${rule}`, msgs };
      }
      throw err;
    }

    // Hard safety limit — should never fire under normal usage; bareguard's
    // limits.maxTurns (or the LLM's natural completion) ends the loop first.
    const warning = `[Loop] hit internal safety limit of ${HARD_ROUND_LIMIT} rounds. Wire bareguard for proper governance — see bare-agent/bareguard.`;
    this._safeEmit({ type: 'loop:done', data: { text: '', warning, cost: totalCost } });
    return { text: '', toolCalls: [], usage: lastUsage, cost: totalCost, error: warning, msgs };
  }

  /**
   * Health check — validates provider, store, and tools without throwing.
   * @param {ToolDef[]} [tools=[]] - Tool definitions to validate.
   * @returns {Promise<{provider: {ok: boolean, error?: string}, store: {ok: boolean, error?: string, skipped: boolean}, tools: {ok: boolean, errors?: string[]}}>}
   * Never throws — all failures captured in return value.
   */
  async validate(tools = []) {
    /** @type {{provider: {ok: boolean, error?: string}, store: {ok: boolean, error?: string, skipped: boolean}, tools: {ok: boolean, errors?: string[]}}} */
    const result = {
      provider: { ok: false },
      store: { ok: false, skipped: false },
      tools: { ok: true },
    };

    // Provider check
    try {
      await this.provider.generate([{ role: 'user', content: 'respond with ok' }], [], {});
      result.provider.ok = true;
    } catch (err) {
      result.provider.error = err.message;
    }

    // Store check
    if (!this.store) {
      result.store.ok = true;
      result.store.skipped = true;
    } else {
      try {
        const testKey = `__validate_${Date.now()}`;
        await this.store.store(testKey, { test: true });
        const got = await this.store.get(testKey);
        if (got === null || got === undefined) {
          result.store.error = 'store.get returned null for test key';
        } else {
          await this.store.delete(testKey);
          result.store.ok = true;
        }
      } catch (err) {
        result.store.error = err.message;
      }
    }

    // Tools check
    /** @type {string[]} */
    const toolErrors = [];
    for (const tool of tools) {
      if (typeof tool.name !== 'string' || !tool.name) {
        toolErrors.push(`Tool is missing a name (got ${JSON.stringify(tool.name)})`);
        continue;
      }
      if (typeof tool.execute !== 'function') {
        toolErrors.push(`Tool "${tool.name}" is missing an execute() function`);
      }
      if (tool.parameters !== undefined && (typeof tool.parameters !== 'object' || tool.parameters === null)) {
        toolErrors.push(`Tool "${tool.name}" has invalid parameters — expected an object, got ${typeof tool.parameters}`);
      }
    }
    if (toolErrors.length > 0) {
      result.tools.ok = false;
      result.tools.errors = toolErrors;
    }

    return result;
  }

  /**
   * Stateful single-turn chat that maintains conversation history across calls.
   * @param {string} text - User message.
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Per-run overrides.
   * @returns {Promise<{text: string, toolCalls: ToolCall[], usage: Usage, cost: number, error: string|null, msgs: Message[]}>}
   */
  async chat(text, tools = [], options = {}) {
    this._history.push({ role: 'user', content: text });
    const result = await this.run(this._history, tools, options);
    // Sync _history from the full msgs run() built (tool-call messages, tool results,
    // and final assistant text). Strip the leading system message if one was prepended.
    const effectiveSystem = options.system || this.system;
    this._history = effectiveSystem ? result.msgs.slice(1) : result.msgs.slice();
    return result;
  }

  stop() {
    this._stopped = true;
  }
}

module.exports = { Loop };
