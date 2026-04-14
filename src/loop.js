'use strict';

const fs = require('node:fs');
const { ToolError, MaxRoundsError, MaxCostError } = require('./errors');

// Average pricing per 1K tokens (USD). Adjust these to match your provider's rates.
// Last updated: 2026-03-18. Source: public provider pricing pages.
const COST_PER_1K = {
  // OpenAI
  'gpt-4o': { in: 0.0025, out: 0.01 },
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'gpt-4.1': { in: 0.002, out: 0.008 },
  'gpt-4.1-mini': { in: 0.0004, out: 0.0016 },
  'gpt-4.1-nano': { in: 0.0001, out: 0.0004 },
  'o3-mini': { in: 0.0011, out: 0.0044 },
  // Anthropic
  'claude-sonnet-4-20250514': { in: 0.003, out: 0.015 },
  'claude-haiku-4-5-20251001': { in: 0.0008, out: 0.004 },
  'claude-opus-4-20250514': { in: 0.015, out: 0.075 },
  // Fallback average across popular models (~$0.002 in, ~$0.008 out per 1K)
  '_default': { in: 0.002, out: 0.008 },
};

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
   * @param {object} options
   * @param {object} options.provider - LLM provider (must implement generate()).
   * @param {number} [options.maxRounds=5] - Maximum think/act/observe cycles.
   * @param {string} [options.system] - System prompt prepended to messages.
   * @param {object} [options.checkpoint] - Checkpoint instance for human-in-the-loop.
   * @param {object} [options.retry] - Retry instance for backoff on failures.
   * @param {object} [options.stream] - Stream instance for event emission.
   * @param {object} [options.store] - Store instance for validate() health check.
   * @param {Function} [options.policy] - Async (toolName, args) => true|false|string. Deny returns the string (or a generic message) to the LLM as tool result.
   * @param {string} [options.audit] - File path for JSONL audit log. Each tool call appends one line: {ts, tool, args, decision, result|reason|error, durationMs}.
   * @throws {Error} `[Loop] requires a provider` — when options.provider is missing.
   */
  constructor(options = {}) {
    if (!options.provider) throw new Error('[Loop] requires a provider');
    this.provider = options.provider;
    this.maxRounds = options.maxRounds || 5;
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
      throw new Error('[Loop] options.policy must be a function (toolName, args) => true | false | string');
    }
    this.policy = options.policy || null;
    this.audit = options.audit || null;
    this.maxCost = typeof options.maxCost === 'number' && options.maxCost > 0 ? options.maxCost : null;
    this._stopped = false;
    this._history = []; // for chat() stateful mode
    this._auditInFlight = new Set();
  }

  // Unified error emitter — every silent-ish failure path routes through here so
  // operators see audit writes, callback throws, checkpoint timeouts, stream listener
  // errors in one place: loop:error stream event + onError callback.
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
  _safeCall(name, fn, ...args) {
    if (!fn) return;
    try {
      fn(...args);
    } catch (err) {
      this._reportError(`callback:${name}`, err);
    }
  }

  // Append one JSONL record. Returns nothing (fire-and-forget for callers)
  // but tracks the in-flight promise so `flush()` and the end of `run()` can await it.
  _writeAudit(record) {
    if (!this.audit) return;
    let line;
    try {
      line = JSON.stringify(record) + '\n';
    } catch (err) {
      this._reportError('audit:serialize', err, { tool: record?.tool });
      return;
    }
    const p = fs.promises.appendFile(this.audit, line)
      .catch(err => this._reportError('audit:write', err, { tool: record?.tool }))
      .finally(() => this._auditInFlight.delete(p));
    this._auditInFlight.add(p);
  }

  // Await any in-flight audit writes. Safe to call multiple times; resolves immediately
  // when no writes are pending. Called automatically at the end of each `run()`.
  async flush() {
    if (this._auditInFlight.size === 0) return;
    await Promise.all([...this._auditInFlight]);
  }

  /**
   * Run the think/act/observe loop.
   * @param {Array<object>} messages - Conversation messages in OpenAI format.
   * @param {Array<object>} [tools=[]] - Tool definitions with name, execute, description, parameters.
   * @param {object} [options={}] - Per-run overrides (system, temperature, etc.).
   * @returns {Promise<{text: string, toolCalls: Array, usage: object, error: string|null}>}
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

    for (let round = 0; round < this.maxRounds; round++) {
      if (this._stopped) break;

      let result;
      try {
        const generate = () => this.provider.generate(msgs, tools, options);
        result = this.retry ? await this.retry.call(generate) : await generate();
      } catch (err) {
        this._reportError('provider', err, { round });
        await this.flush();
        if (this.throwOnError) throw err;
        return { text: '', toolCalls: [], usage: lastUsage, cost: totalCost, error: err.message };
      }

      lastUsage = result.usage || lastUsage;
      const model = this.provider.model || null;
      const roundCost = estimateCost(model, lastUsage);
      if (roundCost !== null) totalCost += roundCost;

      // Cost cap — fail fast before the next round costs more money.
      if (this.maxCost !== null && totalCost > this.maxCost) {
        const msg = `[Loop] cost ${totalCost.toFixed(4)} exceeded cap ${this.maxCost.toFixed(4)} after round ${round + 1}`;
        const err = new MaxCostError(msg, { context: { cost: totalCost, maxCost: this.maxCost, round } });
        this._reportError('cost-cap', err, { cost: totalCost, maxCost: this.maxCost });
        await this.flush();
        if (this.throwOnError) throw err;
        return { text: '', toolCalls: [], usage: lastUsage, cost: totalCost, error: msg };
      }

      // No tool calls — LLM gave a final text response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        this._safeEmit({ type: 'loop:text', data: { text: result.text } });
        this._safeCall('onText', this.onText, result.text);
        await this.flush();
        this._safeEmit({ type: 'loop:done', data: { text: result.text, usage: lastUsage, cost: totalCost } });
        return { text: result.text, toolCalls: [], usage: lastUsage, cost: totalCost, error: null };
      }

      // Execute tool calls
      msgs.push({
        role: 'assistant',
        content: result.text || null,
        tool_calls: result.toolCalls.map(tc => ({
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
          if (!reply || reply.toLowerCase() === 'no' || reply.toLowerCase() === 'n') {
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
        if (this.policy) {
          let verdict;
          try {
            verdict = await this.policy(tc.name, tc.arguments, ctx);
          } catch (err) {
            verdict = `[Loop] policy error: ${err.message}`;
          }
          if (verdict !== true) {
            const reason = typeof verdict === 'string'
              ? verdict
              : `[Loop] Tool "${tc.name}" denied by policy`;
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: reason });
            this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, denied: true, reason } });
            this._writeAudit({
              ts: new Date().toISOString(),
              tool: tc.name,
              args: tc.arguments,
              decision: 'deny',
              reason,
            });
            continue;
          }
        }

        const startedAt = Date.now();
        try {
          const execute = () => tool.execute(tc.arguments);
          const toolResult = this.retry ? await this.retry.call(execute) : await execute();
          const content = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          msgs.push({ role: 'tool', tool_call_id: tc.id, content });
          this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, result: content } });
          this._writeAudit({
            ts: new Date().toISOString(),
            tool: tc.name,
            args: tc.arguments,
            decision: 'allow',
            result: content,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          const toolErr = err instanceof ToolError ? err : new ToolError(err.message, { context: { tool: tc.name } });
          const errMsg = `[Loop] Tool error: ${toolErr.message}`;
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          this._safeEmit({ type: 'loop:tool_result', data: { tool: tc.name, error: errMsg } });
          this._writeAudit({
            ts: new Date().toISOString(),
            tool: tc.name,
            args: tc.arguments,
            decision: 'allow',
            error: toolErr.message,
            durationMs: Date.now() - startedAt,
          });
        }
      }
    }

    // maxRounds exceeded
    const warning = `[Loop] ended after ${this.maxRounds} rounds without final response`;
    await this.flush();
    this._safeEmit({ type: 'loop:done', data: { text: '', warning, cost: totalCost } });
    if (this.throwOnError) throw new MaxRoundsError(warning);
    return { text: '', toolCalls: [], usage: lastUsage, cost: totalCost, error: warning };
  }

  /**
   * Health check — validates provider, store, and tools without throwing.
   * @param {Array<object>} [tools=[]] - Tool definitions to validate.
   * @returns {Promise<{provider: {ok: boolean, error?: string}, store: {ok: boolean, error?: string, skipped: boolean}, tools: {ok: boolean, errors?: string[]}}>}
   * Never throws — all failures captured in return value.
   */
  async validate(tools = []) {
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

  async chat(text, tools = [], options = {}) {
    this._history.push({ role: 'user', content: text });
    const result = await this.run(this._history, tools, options);
    if (result.text) {
      this._history.push({ role: 'assistant', content: result.text });
    }
    return result;
  }

  stop() {
    this._stopped = true;
  }
}

module.exports = { Loop };
