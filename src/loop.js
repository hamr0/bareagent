'use strict';

const { ToolError, MaxRoundsError } = require('./errors');

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
    this._stopped = false;
    this._history = []; // for chat() stateful mode
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

    this.stream?.emit({ type: 'loop:start', data: { messageCount: msgs.length } });

    let lastUsage = { inputTokens: 0, outputTokens: 0 };

    for (let round = 0; round < this.maxRounds; round++) {
      if (this._stopped) break;

      let result;
      try {
        const generate = () => this.provider.generate(msgs, tools, options);
        result = this.retry ? await this.retry.call(generate) : await generate();
      } catch (err) {
        this.stream?.emit({ type: 'loop:error', data: { error: err.message, round } });
        this.onError?.(err);
        if (this.throwOnError) throw err;
        return { text: '', toolCalls: [], usage: lastUsage, error: err.message };
      }

      lastUsage = result.usage || lastUsage;

      // No tool calls — LLM gave a final text response
      if (!result.toolCalls || result.toolCalls.length === 0) {
        this.stream?.emit({ type: 'loop:text', data: { text: result.text } });
        this.onText?.(result.text);
        this.stream?.emit({ type: 'loop:done', data: { text: result.text, usage: lastUsage } });
        return { text: result.text, toolCalls: [], usage: lastUsage, error: null };
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
          this.stream?.emit({ type: 'loop:tool_result', data: { tool: tc.name, error: errMsg } });
          continue;
        }

        // Checkpoint — ask for approval before executing
        if (this.checkpoint?.shouldAsk(tc.name, tc.arguments)) {
          this.stream?.emit({ type: 'checkpoint:ask', data: { tool: tc.name, args: tc.arguments } });
          const reply = await this.checkpoint.ask(
            `Approve ${tc.name}(${JSON.stringify(tc.arguments)})?`,
            { tool: tc.name, args: tc.arguments }
          );
          this.stream?.emit({ type: 'checkpoint:reply', data: { reply } });
          if (!reply || reply.toLowerCase() === 'no' || reply.toLowerCase() === 'n') {
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: 'User denied this action.' });
            continue;
          }
        }

        this.stream?.emit({ type: 'loop:tool_call', data: { tool: tc.name, args: tc.arguments } });
        this.onToolCall?.(tc.name, tc.arguments);

        try {
          const execute = () => tool.execute(tc.arguments);
          const toolResult = this.retry ? await this.retry.call(execute) : await execute();
          const content = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          msgs.push({ role: 'tool', tool_call_id: tc.id, content });
          this.stream?.emit({ type: 'loop:tool_result', data: { tool: tc.name, result: content } });
        } catch (err) {
          const toolErr = err instanceof ToolError ? err : new ToolError(err.message, { context: { tool: tc.name } });
          const errMsg = `[Loop] Tool error: ${toolErr.message}`;
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          this.stream?.emit({ type: 'loop:tool_result', data: { tool: tc.name, error: errMsg } });
        }
      }
    }

    // maxRounds exceeded
    const warning = `[Loop] ended after ${this.maxRounds} rounds without final response`;
    this.stream?.emit({ type: 'loop:done', data: { text: '', warning } });
    if (this.throwOnError) throw new MaxRoundsError(warning);
    return { text: '', toolCalls: [], usage: lastUsage, error: warning };
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
