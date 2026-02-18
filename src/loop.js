'use strict';

class Loop {
  constructor(options = {}) {
    if (!options.provider) throw new Error('Loop requires a provider');
    this.provider = options.provider;
    this.maxRounds = options.maxRounds || 5;
    this.system = options.system || null;
    this.checkpoint = options.checkpoint || null;
    this.retry = options.retry || null;
    this.stream = options.stream || null;
    this.onToolCall = options.onToolCall || null;
    this.onText = options.onText || null;
    this.onError = options.onError || null;
    this._stopped = false;
    this._history = []; // for chat() stateful mode
  }

  async run(messages, tools = [], options = {}) {
    this._stopped = false;
    const system = options.system || this.system;
    const msgs = system
      ? [{ role: 'system', content: system }, ...messages]
      : [...messages];
    const toolMap = new Map(tools.map(t => [t.name, t]));

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
          const errMsg = `Unknown tool: ${tc.name}`;
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
          const errMsg = `Tool error: ${err.message}`;
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          this.stream?.emit({ type: 'loop:tool_result', data: { tool: tc.name, error: errMsg } });
        }
      }
    }

    // maxRounds exceeded
    const warning = `Loop ended after ${this.maxRounds} rounds without final response`;
    this.stream?.emit({ type: 'loop:done', data: { text: '', warning } });
    return { text: '', toolCalls: [], usage: lastUsage, error: warning };
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
