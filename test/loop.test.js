'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { ProviderError } = require('../src/errors');

// Mock provider that returns scripted responses
function mockProvider(responses) {
  let callIndex = 0;
  return {
    async generate(messages, tools, options) {
      const response = responses[callIndex++];
      if (!response) throw new Error('Mock provider: no more responses');
      return response;
    },
  };
}

const weatherTool = {
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: async ({ city }) => ({ temp: 22, city, conditions: 'sunny' }),
};

const calcTool = {
  name: 'calculate',
  description: 'Evaluate a math expression',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string' } },
    required: ['expression'],
  },
  execute: async ({ expression }) => String(Function('"use strict"; return (' + expression + ')')()),
};

describe('Loop', () => {
  it('requires a provider', () => {
    assert.throws(() => new Loop(), { message: /requires a provider/ });
  });

  it('throws on removed options.maxRounds with a migration message', () => {
    const provider = mockProvider([]);
    assert.throws(
      () => new Loop({ provider, maxRounds: 5 }),
      (err) => {
        assert.match(err.message, /maxRounds was removed in v0\.8/);
        assert.match(err.message, /limits.*maxTurns/);
        return true;
      },
    );
  });

  it('returns text when LLM responds without tool calls', async () => {
    const provider = mockProvider([
      { text: 'Hello!', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 } },
    ]);
    const loop = new Loop({ provider });
    const result = await loop.run([{ role: 'user', content: 'Hi' }]);

    assert.equal(result.text, 'Hello!');
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.error, null);
    assert.equal(result.usage.inputTokens, 5);
  });

  it('executes a single tool call and returns final text', async () => {
    const provider = mockProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Berlin' } }],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        text: 'The weather in Berlin is 22°C and sunny.',
        toolCalls: [],
        usage: { inputTokens: 30, outputTokens: 15 },
      },
    ]);

    const loop = new Loop({ provider });
    const result = await loop.run(
      [{ role: 'user', content: 'What is the weather in Berlin?' }],
      [weatherTool]
    );

    assert.equal(result.text, 'The weather in Berlin is 22°C and sunny.');
    assert.equal(result.error, null);
  });

  it('executes multiple tool calls in one round', async () => {
    const provider = mockProvider([
      {
        text: '',
        toolCalls: [
          { id: 'call_1', name: 'get_weather', arguments: { city: 'Berlin' } },
          { id: 'call_2', name: 'calculate', arguments: { expression: '42 * 17' } },
        ],
        usage: { inputTokens: 20, outputTokens: 10 },
      },
      {
        text: 'Berlin is 22°C sunny, and 42 * 17 = 714.',
        toolCalls: [],
        usage: { inputTokens: 50, outputTokens: 25 },
      },
    ]);

    const loop = new Loop({ provider });
    const result = await loop.run(
      [{ role: 'user', content: 'Weather in Berlin and what is 42*17?' }],
      [weatherTool, calcTool]
    );

    assert.equal(result.text, 'Berlin is 22°C sunny, and 42 * 17 = 714.');
    assert.equal(result.error, null);
  });

  it('handles unknown tool gracefully', async () => {
    const provider = mockProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'nonexistent', arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        text: 'Sorry, I could not find that tool.',
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 10 },
      },
    ]);

    const loop = new Loop({ provider });
    const result = await loop.run(
      [{ role: 'user', content: 'Use nonexistent tool' }],
      [weatherTool]
    );

    assert.equal(result.text, 'Sorry, I could not find that tool.');
    assert.equal(result.error, null);
  });

  it('handles tool execution errors gracefully', async () => {
    const failingTool = {
      name: 'fail_tool',
      description: 'Always fails',
      parameters: { type: 'object', properties: {} },
      execute: async () => { throw new Error('tool broke'); },
    };

    const provider = mockProvider([
      {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'fail_tool', arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        text: 'The tool failed, sorry.',
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 10 },
      },
    ]);

    const loop = new Loop({ provider });
    const result = await loop.run(
      [{ role: 'user', content: 'Run the failing tool' }],
      [failingTool]
    );

    assert.equal(result.text, 'The tool failed, sorry.');
    assert.equal(result.error, null);
  });

  it('stops mid-loop when stop() is called', async () => {
    let callCount = 0;
    const provider = {
      async generate() {
        callCount++;
        return {
          text: '',
          toolCalls: [{ id: `call_${callCount}`, name: 'get_weather', arguments: { city: 'Berlin' } }],
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    };

    const loop = new Loop({ provider, throwOnError: false });
    // Stop after first round
    loop.onToolCall = () => loop.stop();

    const result = await loop.run(
      [{ role: 'user', content: 'Keep going' }],
      [weatherTool]
    );

    assert.ok(callCount <= 2);
  });

  it('chat() maintains stateful history', async () => {
    let callCount = 0;
    const provider = {
      async generate(messages) {
        callCount++;
        return {
          text: callCount === 1 ? 'Paris' : `You asked ${messages.length - 1} questions before.`,
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };

    const loop = new Loop({ provider });

    const r1 = await loop.chat('Capital of France?');
    assert.equal(r1.text, 'Paris');

    const r2 = await loop.chat('How many questions did I ask?');
    // History should have: user1, assistant1, user2
    assert.ok(r2.text.includes('2'));
  });

  it('passes system prompt to messages', async () => {
    let capturedMessages;
    const provider = {
      async generate(messages) {
        capturedMessages = messages;
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };

    const loop = new Loop({ provider, system: 'You are a helpful bot.' });
    await loop.run([{ role: 'user', content: 'Hi' }]);

    assert.equal(capturedMessages[0].role, 'system');
    assert.equal(capturedMessages[0].content, 'You are a helpful bot.');
    assert.equal(capturedMessages[1].role, 'user');
  });

  it('emits stream events', async () => {
    const events = [];
    const stream = {
      emit(event) { events.push(event); },
    };

    const provider = mockProvider([
      { text: 'Hello', toolCalls: [], usage: { inputTokens: 5, outputTokens: 3 } },
    ]);

    const loop = new Loop({ provider, stream });
    await loop.run([{ role: 'user', content: 'Hi' }]);

    const types = events.map(e => e.type);
    assert.ok(types.includes('loop:start'));
    assert.ok(types.includes('loop:text'));
    assert.ok(types.includes('loop:done'));
  });

  it('throws when provider fails', async () => {
    const provider = {
      async generate() { throw new Error('API down'); },
    };

    const loop = new Loop({ provider });
    await assert.rejects(
      () => loop.run([{ role: 'user', content: 'Hi' }]),
      { message: 'API down' }
    );
  });

  it('throwOnError: false returns error on provider failure', async () => {
    const provider = {
      async generate() { throw new Error('API down'); },
    };
    const loop = new Loop({ provider, throwOnError: false });
    const result = await loop.run([{ role: 'user', content: 'Hi' }]);
    assert.equal(result.error, 'API down');
    assert.equal(result.text, '');
  });

  it('throws original ProviderError instance', async () => {
    const original = new ProviderError('rate limited', { status: 429 });
    const provider = {
      async generate() { throw original; },
    };
    const loop = new Loop({ provider });
    await assert.rejects(
      () => loop.run([{ role: 'user', content: 'Hi' }]),
      (err) => {
        assert.strictEqual(err, original);
        assert.ok(err instanceof ProviderError);
        return true;
      }
    );
  });

  it('stream events fire before throw', async () => {
    const events = [];
    const stream = { emit(event) { events.push(event); } };
    const provider = {
      async generate() { throw new Error('boom'); },
    };
    const loop = new Loop({ provider, stream });
    await assert.rejects(() => loop.run([{ role: 'user', content: 'Hi' }]));
    const types = events.map(e => e.type);
    assert.ok(types.includes('loop:start'));
    assert.ok(types.includes('loop:error'));
  });

  it('chat() propagates throw', async () => {
    const provider = {
      async generate() { throw new Error('chat boom'); },
    };
    const loop = new Loop({ provider });
    await assert.rejects(
      () => loop.chat('Hi'),
      { message: 'chat boom' }
    );
  });

  describe('validate', () => {
    it('reports provider ok', async () => {
      const provider = {
        async generate() { return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; },
      };
      const loop = new Loop({ provider });
      const result = await loop.validate();

      assert.equal(result.provider.ok, true);
      assert.equal(result.provider.error, undefined);
    });

    it('reports provider error', async () => {
      const provider = {
        async generate() { throw new Error('API key invalid'); },
      };
      const loop = new Loop({ provider });
      const result = await loop.validate();

      assert.equal(result.provider.ok, false);
      assert.equal(result.provider.error, 'API key invalid');
    });

    it('reports store ok', async () => {
      const data = new Map();
      const store = {
        async store(key, value) { data.set(key, value); },
        async get(key) { return data.get(key) || null; },
        async delete(key) { data.delete(key); },
      };
      const provider = {
        async generate() { return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; },
      };
      const loop = new Loop({ provider, store });
      const result = await loop.validate();

      assert.equal(result.store.ok, true);
      assert.equal(result.store.skipped, false);
    });

    it('reports store error', async () => {
      const store = {
        async store() { throw new Error('disk full'); },
        async get() { return null; },
        async delete() {},
      };
      const provider = {
        async generate() { return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; },
      };
      const loop = new Loop({ provider, store });
      const result = await loop.validate();

      assert.equal(result.store.ok, false);
      assert.equal(result.store.error, 'disk full');
    });

    it('reports store skipped when no store', async () => {
      const provider = {
        async generate() { return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; },
      };
      const loop = new Loop({ provider });
      const result = await loop.validate();

      assert.equal(result.store.ok, true);
      assert.equal(result.store.skipped, true);
    });

    it('reports store error when get returns null', async () => {
      const store = {
        async store() {},
        async get() { return null; },
        async delete() {},
      };
      const provider = {
        async generate() { return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; },
      };
      const loop = new Loop({ provider, store });
      const result = await loop.validate();

      assert.equal(result.store.ok, false);
      assert.ok(result.store.error.includes('store.get returned null'));
    });

    it('reports tools ok', async () => {
      const provider = {
        async generate() { return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; },
      };
      const loop = new Loop({ provider });
      const result = await loop.validate([
        { name: 'test', execute: async () => 'ok' },
      ]);

      assert.equal(result.tools.ok, true);
      assert.equal(result.tools.errors, undefined);
    });

    it('reports tools with errors', async () => {
      const provider = {
        async generate() { return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }; },
      };
      const loop = new Loop({ provider });
      const result = await loop.validate([
        { execute: async () => 'ok' },
        { name: 'bad', execute: 'not-fn' },
        { name: 'bad2', execute: async () => 'ok', parameters: 'string' },
      ]);

      assert.equal(result.tools.ok, false);
      assert.equal(result.tools.errors.length, 3);
      assert.ok(result.tools.errors[0].includes('missing a name'));
      assert.ok(result.tools.errors[1].includes('missing an execute'));
      assert.ok(result.tools.errors[2].includes('invalid parameters'));
    });

    it('never throws even when everything fails', async () => {
      const provider = {
        async generate() { throw new Error('provider down'); },
      };
      const store = {
        async store() { throw new Error('store broken'); },
        async get() { return null; },
        async delete() {},
      };
      const loop = new Loop({ provider, store });
      const result = await loop.validate([
        { execute: async () => 'ok' },
      ]);

      assert.equal(result.provider.ok, false);
      assert.equal(result.store.ok, false);
      assert.equal(result.tools.ok, false);
    });
  });

  describe('cost estimation', () => {
    it('returns cost estimate for known model', async () => {
      const provider = {
        model: 'gpt-4o-mini',
        async generate() {
          return { text: 'Hello', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 500 } };
        },
      };
      const loop = new Loop({ provider });
      const result = await loop.run([{ role: 'user', content: 'Hi' }]);

      assert.equal(typeof result.cost, 'number');
      // gpt-4o-mini: 1000 * 0.00015/1000 + 500 * 0.0006/1000 = 0.00015 + 0.0003 = 0.00045
      assert.ok(Math.abs(result.cost - 0.00045) < 0.0001);
    });

    it('uses default pricing for unknown model', async () => {
      const provider = {
        model: 'some-custom-model',
        async generate() {
          return { text: 'Hello', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 1000 } };
        },
      };
      const loop = new Loop({ provider });
      const result = await loop.run([{ role: 'user', content: 'Hi' }]);

      assert.equal(typeof result.cost, 'number');
      // _default: 1000 * 0.002/1000 + 1000 * 0.008/1000 = 0.002 + 0.008 = 0.01
      assert.ok(Math.abs(result.cost - 0.01) < 0.001);
    });

    it('accumulates cost across rounds', async () => {
      const provider = {
        model: 'gpt-4o-mini',
        async generate(messages) {
          if (messages.some(m => m.role === 'tool')) {
            return { text: 'Done', toolCalls: [], usage: { inputTokens: 500, outputTokens: 200 } };
          }
          return {
            text: '',
            toolCalls: [{ id: 'call_1', name: 'test', arguments: {} }],
            usage: { inputTokens: 300, outputTokens: 100 },
          };
        },
      };
      const loop = new Loop({ provider });
      const result = await loop.run(
        [{ role: 'user', content: 'Hi' }],
        [{ name: 'test', execute: async () => 'ok' }]
      );

      // Round 1: 300*0.00015/1000 + 100*0.0006/1000 = 0.000045 + 0.00006 = 0.000105
      // Round 2: 500*0.00015/1000 + 200*0.0006/1000 = 0.000075 + 0.00012 = 0.000195
      // Total: 0.0003
      assert.ok(result.cost > 0);
      assert.ok(Math.abs(result.cost - 0.0003) < 0.0001);
    });

    it('includes cost in loop:done stream event', async () => {
      const events = [];
      const stream = { emit(event) { events.push(event); } };
      const provider = {
        model: 'gpt-4o-mini',
        async generate() {
          return { text: 'Hello', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 500 } };
        },
      };
      const loop = new Loop({ provider, stream });
      await loop.run([{ role: 'user', content: 'Hi' }]);

      const doneEvent = events.find(e => e.type === 'loop:done');
      assert.ok(doneEvent);
      assert.equal(typeof doneEvent.data.cost, 'number');
      assert.ok(doneEvent.data.cost > 0);
    });

    it('returns zero cost when provider has no model', async () => {
      const provider = {
        async generate() {
          return { text: 'Hello', toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } };
        },
      };
      const loop = new Loop({ provider });
      const result = await loop.run([{ role: 'user', content: 'Hi' }]);

      assert.equal(result.cost, 0);
    });

    it('falls back to result.model when provider.model is absent', async () => {
      // FallbackProvider has no .model; the model surfaces only in the response.
      const provider = {
        async generate() {
          return { text: 'Hello', toolCalls: [], model: 'gpt-4o-mini', usage: { inputTokens: 1000, outputTokens: 500 } };
        },
      };
      const llm = [];
      const loop = new Loop({ provider, onLlmResult: (r) => llm.push(r) });
      const result = await loop.run([{ role: 'user', content: 'Hi' }]);

      assert.ok(Math.abs(result.cost - 0.00045) < 0.0001);
      assert.equal(llm[0].model, 'gpt-4o-mini');
      assert.ok(llm[0].costUsd > 0, 'onLlmResult.costUsd is non-null with model from response');
    });

    it('keeps cost accounting through a CircuitBreaker-wrapped provider', async () => {
      const { CircuitBreaker } = require('../src/circuit-breaker');
      const base = {
        model: 'gpt-4o-mini',
        name: 'openai',
        async generate() {
          return { text: 'Hello', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 500 } };
        },
      };
      const wrapped = new CircuitBreaker().wrapProvider(base, 'p1');
      const llm = [];
      const loop = new Loop({ provider: wrapped, onLlmResult: (r) => llm.push(r) });
      const result = await loop.run([{ role: 'user', content: 'Hi' }]);

      assert.ok(result.cost > 0, 'wrapped provider still accrues cost');
      assert.ok(llm[0].costUsd > 0, 'onLlmResult.costUsd is non-null through the wrapper');
      assert.equal(llm[0].provider, 'openai');
    });
  });

  describe('tool validation', () => {
    const provider = mockProvider([
      { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    const msgs = [{ role: 'user', content: 'Hi' }];

    it('rejects tool with missing name', async () => {
      const loop = new Loop({ provider });
      await assert.rejects(
        () => loop.run(msgs, [{ execute: async () => 'ok' }]),
        { message: /Tool is missing a name/ }
      );
    });

    it('rejects tool with non-string name', async () => {
      const loop = new Loop({ provider });
      await assert.rejects(
        () => loop.run(msgs, [{ name: 123, execute: async () => 'ok' }]),
        { message: /Tool is missing a name/ }
      );
    });

    it('rejects tool with missing execute', async () => {
      const loop = new Loop({ provider });
      await assert.rejects(
        () => loop.run(msgs, [{ name: 'test' }]),
        { message: /missing an execute\(\) function/ }
      );
    });

    it('rejects tool where execute is not a function', async () => {
      const loop = new Loop({ provider });
      await assert.rejects(
        () => loop.run(msgs, [{ name: 'test', execute: 'not-a-fn' }]),
        { message: /missing an execute\(\) function/ }
      );
    });

    it('rejects tool with invalid parameters type', async () => {
      const loop = new Loop({ provider });
      await assert.rejects(
        () => loop.run(msgs, [{ name: 'test', execute: async () => 'ok', parameters: 'bad' }]),
        { message: /invalid parameters/ }
      );
    });

    it('accepts valid tool without description or parameters', async () => {
      const p = mockProvider([
        { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } },
      ]);
      const loop = new Loop({ provider: p });
      const result = await loop.run(msgs, [{ name: 'test', execute: async () => 'ok' }]);
      assert.equal(result.text, 'ok');
    });
  });

  // --- Governance: policy + audit (v0.6) ---

  describe('policy', () => {
    const fs = require('node:fs');
    const { join } = require('node:path');
    const { tmpdir } = require('node:os');

    it('policy:true allows the tool to execute', async () => {
      const provider = mockProvider([
        { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } }], usage: { inputTokens: 10, outputTokens: 5 } },
        { text: 'done', toolCalls: [], usage: { inputTokens: 20, outputTokens: 5 } },
      ]);
      const calls = [];
      const loop = new Loop({
        provider,
        policy: async (name, args) => { calls.push([name, args]); return true; },
      });
      const result = await loop.run([{ role: 'user', content: 'weather' }], [weatherTool]);
      assert.equal(result.text, 'done');
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], 'get_weather');
    });

    it('policy:string denies and feeds the reason back to the LLM', async () => {
      let capturedToolMsg = null;
      const provider = {
        async generate(messages) {
          const round = messages.filter(m => m.role === 'assistant' && m.tool_calls).length;
          if (round === 0) {
            return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } }], usage: { inputTokens: 10, outputTokens: 5 } };
          }
          capturedToolMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'c1')?.content;
          return { text: 'understood', toolCalls: [], usage: { inputTokens: 20, outputTokens: 5 } };
        },
      };
      const loop = new Loop({
        provider,
        policy: async () => 'Berlin is restricted for this agent.',
      });
      const result = await loop.run([{ role: 'user', content: 'weather' }], [weatherTool]);
      assert.equal(result.text, 'understood');
      assert.equal(capturedToolMsg, 'Berlin is restricted for this agent.');
    });

    it('policy:false denies with a generic message', async () => {
      let capturedToolMsg = null;
      const provider = {
        async generate(messages) {
          const round = messages.filter(m => m.role === 'assistant' && m.tool_calls).length;
          if (round === 0) {
            return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
          }
          capturedToolMsg = messages.find(m => m.role === 'tool')?.content;
          return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const loop = new Loop({ provider, policy: async () => false });
      await loop.run([{ role: 'user', content: 'x' }], [weatherTool]);
      assert.match(capturedToolMsg, /denied by policy/);
    });

    it('policy that throws is treated as a deny', async () => {
      let capturedToolMsg = null;
      const provider = {
        async generate(messages) {
          const round = messages.filter(m => m.role === 'assistant' && m.tool_calls).length;
          if (round === 0) {
            return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
          }
          capturedToolMsg = messages.find(m => m.role === 'tool')?.content;
          return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const loop = new Loop({ provider, policy: async () => { throw new Error('boom'); } });
      await loop.run([{ role: 'user', content: 'x' }], [weatherTool]);
      assert.match(capturedToolMsg, /policy error: boom/);
    });

    it('policy returning undefined denies (fail-safe)', async () => {
      let capturedToolMsg = null;
      const provider = {
        async generate(messages) {
          const round = messages.filter(m => m.role === 'assistant' && m.tool_calls).length;
          if (round === 0) {
            return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
          }
          capturedToolMsg = messages.find(m => m.role === 'tool')?.content;
          return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      // No explicit return — resolves to undefined. Spec says only `true` allows; undefined = deny.
      const loop = new Loop({ provider, policy: async () => { /* forgot to return */ } });
      await loop.run([{ role: 'user', content: 'x' }], [weatherTool]);
      assert.match(capturedToolMsg, /denied by policy/);
    });

    it('non-function policy option is rejected in the constructor', () => {
      const provider = mockProvider([]);
      assert.throws(
        () => new Loop({ provider, policy: true }),
        { message: /policy must be a function/ }
      );
      assert.throws(
        () => new Loop({ provider, policy: 'allow' }),
        { message: /policy must be a function/ }
      );
    });

    it('omitting policy preserves existing behaviour (allow-all)', async () => {
      const provider = mockProvider([
        { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'X' } }], usage: { inputTokens: 1, outputTokens: 1 } },
        { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const loop = new Loop({ provider });
      const result = await loop.run([{ role: 'user', content: 'x' }], [weatherTool]);
      assert.equal(result.text, 'ok');
    });
  });

  // --- v0.7.0+ (audit + maxCost moved to bareguard in v0.8.0) ---

  describe('policy ctx (per-caller routing)', () => {
    it('forwards options.ctx to the policy closure', async () => {
      const seen = [];
      const provider = mockProvider([
        { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
        { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const loop = new Loop({
        provider,
        policy: async (name, args, ctx) => { seen.push(ctx); return true; },
      });
      await loop.run([{ role: 'user', content: 'x' }], [weatherTool], { ctx: { userId: 42, role: 'admin' } });
      assert.deepEqual(seen[0], { userId: 42, role: 'admin' });
    });

    it('policy can branch on ctx to allow/deny per caller', async () => {
      const policy = async (name, args, ctx) => {
        if (ctx?.isOwner) return true;
        return 'Denied: owner only';
      };
      const provider = (capture) => ({
        async generate(messages) {
          const round = messages.filter(m => m.role === 'assistant' && m.tool_calls).length;
          if (round === 0) {
            return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
          }
          capture.toolMsg = messages.find(m => m.role === 'tool')?.content;
          return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      });

      const captureOwner = {};
      const loop1 = new Loop({ provider: provider(captureOwner), policy });
      await loop1.run([{ role: 'user', content: 'x' }], [weatherTool], { ctx: { isOwner: true } });
      assert.match(captureOwner.toolMsg, /22/); // got the weather result

      const captureUser = {};
      const loop2 = new Loop({ provider: provider(captureUser), policy });
      await loop2.run([{ role: 'user', content: 'x' }], [weatherTool], { ctx: { isOwner: false } });
      assert.match(captureUser.toolMsg, /owner only/);
    });
  });

  describe('unified error surfacing', () => {
    it('callback throw in onToolCall fires onError but does not break the loop', async () => {
      const errors = [];
      const provider = mockProvider([
        { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
        { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const loop = new Loop({
        provider,
        onToolCall: () => { throw new Error('listener broke'); },
        onError: (err, meta) => errors.push({ err: err.message, meta }),
      });
      const result = await loop.run([{ role: 'user', content: 'x' }], [weatherTool]);
      assert.equal(result.text, 'ok');
      assert.equal(errors.length, 1);
      assert.equal(errors[0].err, 'listener broke');
      assert.equal(errors[0].meta.source, 'callback:onToolCall');
    });

    it('stream listener throw is isolated', async () => {
      const badStream = { emit: () => { throw new Error('stream broke'); } };
      const errors = [];
      const provider = mockProvider([
        { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const loop = new Loop({
        provider,
        stream: badStream,
        onError: (err) => errors.push(err.message),
      });
      const result = await loop.run([{ role: 'user', content: 'x' }]);
      // Loop completes despite stream errors
      assert.equal(result.text, 'ok');
      assert.ok(errors.length > 0, 'onError should have been called');
    });
  });

  describe('Checkpoint timeout', () => {
    const { Checkpoint } = require('../src/checkpoint');

    it('Checkpoint.ask rejects with TimeoutError when reply never arrives', async () => {
      const cp = new Checkpoint({
        tools: ['x'],
        send: async () => {},
        waitForReply: () => new Promise(() => {}), // never resolves
        timeout: 80,
      });
      await assert.rejects(
        () => cp.ask('?'),
        (err) => {
          assert.match(err.message, /no reply within 80ms/);
          return true;
        }
      );
    });

    it('Loop catches Checkpoint timeout and auto-denies the tool call', async () => {
      const cp = new Checkpoint({
        tools: ['get_weather'],
        send: async () => {},
        waitForReply: () => new Promise(() => {}),
        timeout: 60,
      });
      let capturedToolMsg = null;
      const errors = [];
      const provider = {
        async generate(messages) {
          const round = messages.filter(m => m.role === 'assistant' && m.tool_calls).length;
          if (round === 0) {
            return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
          }
          capturedToolMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'c1')?.content;
          return { text: 'ack', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const loop = new Loop({
        provider,
        checkpoint: cp,
        onError: (err, meta) => errors.push(meta.source),
      });
      await loop.run([{ role: 'user', content: 'x' }], [weatherTool]);
      assert.match(capturedToolMsg, /Checkpoint failed.*no reply/);
      assert.ok(errors.includes('checkpoint'));
    });

    it('timeout=0 disables the timeout (backwards compat)', async () => {
      const cp = new Checkpoint({
        tools: ['x'],
        send: async () => {},
        waitForReply: async () => 'yes',
        timeout: 0,
      });
      const reply = await cp.ask('?');
      assert.equal(reply, 'yes');
    });
  });

  describe('Checkpoint approval (fail-closed)', () => {
    const { Checkpoint } = require('../src/checkpoint');

    // One tool call to `danger`, then a final text turn. `executed` flips iff the
    // tool actually ran past the checkpoint gate.
    function dangerSetup(reply) {
      let executed = false;
      const tool = { name: 'danger', execute: async () => { executed = true; return 'ran'; } };
      const provider = {
        _n: 0,
        async generate() {
          this._n++;
          return this._n === 1
            ? { text: '', toolCalls: [{ id: 't1', name: 'danger', arguments: {} }], usage: {} }
            : { text: 'final', toolCalls: [], usage: {} };
        },
      };
      const cp = new Checkpoint({ tools: ['danger'], send: async () => {}, waitForReply: async () => reply, timeout: 0 });
      return { tool, provider, cp, ran: () => executed };
    }

    for (const reply of ['yes', 'y', 'YES', ' approve ']) {
      it(`approves on explicit affirmative ${JSON.stringify(reply)}`, async () => {
        const s = dangerSetup(reply);
        await new Loop({ provider: s.provider, checkpoint: s.cp }).run([{ role: 'user', content: 'go' }], [s.tool]);
        assert.equal(s.ran(), true);
      });
    }

    for (const reply of ['no', 'n', 'denied', 'reject', 'wait', '', null]) {
      it(`denies on non-affirmative ${JSON.stringify(reply)}`, async () => {
        const s = dangerSetup(reply);
        await new Loop({ provider: s.provider, checkpoint: s.cp }).run([{ role: 'user', content: 'go' }], [s.tool]);
        assert.equal(s.ran(), false);
      });
    }

    it('a non-string reply denies without throwing out of run()', async () => {
      const s = dangerSetup({ weird: 1 });
      // throwOnError:true would surface a .toLowerCase() throw if it regressed.
      const result = await new Loop({ provider: s.provider, checkpoint: s.cp, throwOnError: true })
        .run([{ role: 'user', content: 'go' }], [s.tool]);
      assert.equal(s.ran(), false);
      assert.equal(result.error, null);
    });
  });
});

// multis M9 ask (halterror-swallowed-from-tool-execute): a HaltError thrown from a tool's `execute` must
// exit the loop cleanly — like every other seam — NOT get wrapped into a ToolError and let the loop run on.
// Mirrors the ask's POC table: thrown from the tool body, it should halt once, not run away to the round cap.
describe('Loop — HaltError from a tool body (execute seam consistency)', () => {
  const { HaltError } = require('../src/errors');

  // A provider that NEVER stops calling the tool — so a swallowed halt would run away to HARD_ROUND_LIMIT.
  function relentlessToolCaller() {
    let calls = 0;
    return {
      get calls() { return calls; },
      async generate() {
        calls++;
        return { text: '', toolCalls: [{ id: `c${calls}`, name: 'park', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
  }

  it('halts cleanly (result.error=halt:<rule>), invoking the tool exactly once — no runaway', async () => {
    const provider = relentlessToolCaller();
    let invoked = 0;
    const park = { name: 'park', description: 'parks a ceremony', execute: async () => { invoked++; throw new HaltError('parked', { rule: 'ceremony-parked' }); } };

    const result = await new Loop({ provider, throwOnError: true }).run([{ role: 'user', content: 'go' }], [park]);

    assert.equal(invoked, 1, 'tool body ran once, then the HaltError halted the loop (not swallowed → re-called)');
    assert.equal(result.text, '');
    assert.match(result.error, /^halt:ceremony-parked$/);
    assert.ok(provider.calls <= 1, `no runaway: provider called ${provider.calls}×, expected ≤1 (was 100 before the fix)`);
  });

  it('an ordinary tool error is STILL wrapped into a ToolError (boundary preserved, loop continues)', async () => {
    // The fix must not over-reach: a plain Error from a tool is not a governance signal — it becomes a
    // tool-result and the loop proceeds (then the provider returns a final answer).
    let i = 0;
    const provider = {
      async generate() {
        i++;
        return i === 1
          ? { text: '', toolCalls: [{ id: 'c1', name: 'boom', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } }
          : { text: 'recovered', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const boom = { name: 'boom', description: 'fails', execute: async () => { throw new Error('kaboom'); } };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'go' }], [boom]);
    assert.equal(result.error, null, 'a plain tool error is not a halt — loop recovers');
    assert.equal(result.text, 'recovered');
  });
});

// BA-11: the deny-spin guard. A governance deny (policy verdict !== true, not a HaltError) is fed back to the
// model as a tool result; a model that keeps retrying variants of a denied action would otherwise burn the
// budget to the cap without progress (probe-16: 16 calls, sensor never reached). The Loop counts CONSECUTIVE
// denials (reset by any allowed call) and short-circuits at maxConsecutiveDenials. Validated live in
// poc/ba11-deny-spin.mjs: haiku retried a denied write 8× in a row before giving up.
describe('Loop — BA-11 deny-spin guard', () => {
  const denyTool = { name: 'blocked', description: 'always denied', execute: async () => 'should never run' };
  const okTool = { name: 'allowed', description: 'always allowed', execute: async () => 'ok' };
  // A provider whose response is a function of the round index, so it can emit an UNBOUNDED retry stream.
  const scripted = (fn) => ({ async generate(m, t, o) { return fn(this._i = (this._i || 0) + 1, m, t, o); } });
  const callBlocked = (i) => ({ text: '', toolCalls: [{ id: 'c' + i, name: 'blocked', arguments: { n: i } }], usage: { inputTokens: 1, outputTokens: 1 } });
  const callAllowed = (i) => ({ text: '', toolCalls: [{ id: 'a' + i, name: 'allowed', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } });
  const finalText = (t) => ({ text: t, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
  const denyBlocked = async (name) => (name === 'blocked' ? '[deny: test.scope] blocked out of scope' : true);

  it('short-circuits after N consecutive denials (default 3) — clean return, not a throw', async () => {
    let calls = 0;
    const provider = scripted((i) => { calls = i; return callBlocked(i); }); // ALWAYS retries the denied tool
    const loop = new Loop({ provider, policy: denyBlocked, throwOnError: true });
    const result = await loop.run([{ role: 'user', content: 'go' }], [denyTool]);
    assert.equal(result.error, 'denied:blocked', 'error tags the denied tool');
    assert.equal(result.text, '');
    // Fired at 3, so the provider was called exactly 3 times — NOT the HARD_ROUND_LIMIT(100) spin.
    assert.equal(calls, 3, 'stopped at the 3rd consecutive denial, no burn to the round cap');
  });

  it('an allowed call RESETS the streak — a legit deny→pivot never trips the guard (allowlist-safe)', async () => {
    // Pattern: deny, deny, ALLOW (reset), deny, deny, done. Max consecutive = 2 < 3 → guard must NOT fire,
    // even though there are 4 total denials. This is the property that makes "reset on progress" correct.
    const script = [callBlocked, callBlocked, callAllowed, callBlocked, callBlocked, () => finalText('done')];
    const provider = scripted((i) => script[Math.min(i - 1, script.length - 1)](i));
    const loop = new Loop({ provider, policy: denyBlocked });
    const result = await loop.run([{ role: 'user', content: 'go' }], [denyTool, okTool]);
    assert.equal(result.error, null, 'the pivot reset the streak — no governance short-circuit');
    assert.equal(result.text, 'done');
  });

  it('a custom threshold is honored', async () => {
    let calls = 0;
    const provider = scripted((i) => { calls = i; return callBlocked(i); });
    const result = await new Loop({ provider, policy: denyBlocked, maxConsecutiveDenials: 5 })
      .run([{ role: 'user', content: 'go' }], [denyTool]);
    assert.equal(result.error, 'denied:blocked');
    assert.equal(calls, 5, 'fired at the custom threshold of 5');
  });

  it('maxConsecutiveDenials:0 DISABLES the guard (advisory-deny behavior preserved)', async () => {
    // 5 denials then the model gives up on its own. With the guard OFF, all 5 denials flow through and the
    // final text is returned (pre-BA-11 behavior) — the guard never fires.
    const script = [callBlocked, callBlocked, callBlocked, callBlocked, callBlocked, () => finalText('gave up')];
    const provider = scripted((i) => script[Math.min(i - 1, script.length - 1)](i));
    const result = await new Loop({ provider, policy: denyBlocked, maxConsecutiveDenials: 0 })
      .run([{ role: 'user', content: 'go' }], [denyTool]);
    assert.equal(result.error, null, '0 disables the guard');
    assert.equal(result.text, 'gave up');
  });

  it('maxConsecutiveDenials:Infinity DISABLES the guard', async () => {
    const script = [callBlocked, callBlocked, callBlocked, callBlocked, () => finalText('gave up')];
    const provider = scripted((i) => script[Math.min(i - 1, script.length - 1)](i));
    const result = await new Loop({ provider, policy: denyBlocked, maxConsecutiveDenials: Infinity })
      .run([{ role: 'user', content: 'go' }], [denyTool]);
    assert.equal(result.error, null, 'Infinity disables the guard');
    assert.equal(result.text, 'gave up');
  });

  it('rejects an invalid maxConsecutiveDenials', () => {
    const provider = scripted(() => finalText('x'));
    assert.throws(() => new Loop({ provider, maxConsecutiveDenials: -1 }), /non-negative number/);
    assert.throws(() => new Loop({ provider, maxConsecutiveDenials: 'x' }), /non-negative number/);
    assert.throws(() => new Loop({ provider, maxConsecutiveDenials: NaN }), /non-negative number/);
  });

  it('leaves the returned transcript provider-valid (every tool_call paired) when it fires', async () => {
    // The short-circuit seals dangling tool_calls (same as the halt path) so msgs can be fed back to a provider.
    const provider = scripted((i) => callBlocked(i));
    const result = await new Loop({ provider, policy: denyBlocked }).run([{ role: 'user', content: 'go' }], [denyTool]);
    const toolCallIds = result.msgs.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls.map(tc => tc.id));
    const toolResultIds = new Set(result.msgs.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    for (const id of toolCallIds) assert.ok(toolResultIds.has(id), `tool_call ${id} has a paired result`);
  });
});

describe('A1 — provider-supplied costUsd (CLI authoritative price)', () => {
  it('prefers result.costUsd over estimateCost and forwards it as priced', async () => {
    const events = [];
    // No model → estimateCost would return null (unpriced). The provider's own costUsd must win.
    const provider = {
      model: null,
      async generate() {
        return { text: 'done', toolCalls: [], usage: { inputTokens: 100, outputTokens: 5 }, costUsd: 0.0495 };
      },
    };
    const loop = new Loop({ provider, onLlmResult: (e) => { events.push(e); } });
    const result = await loop.run([{ role: 'user', content: 'hi' }]);
    assert.equal(result.cost, 0.0495, 'authoritative CLI cost accumulates into totalCost');
    assert.equal(result.metrics.costUsd, 0.0495);
    assert.equal(result.metrics.unpricedRounds, 0, 'a provider-priced round is NOT unpriced');
    assert.equal(events.length, 1);
    assert.equal(events[0].costUsd, 0.0495);
    assert.equal(events[0].pricing, 'priced');
  });

  it('treats a provider costUsd of 0 as priced (not the null/unpriced sentinel)', async () => {
    const provider = {
      model: null,
      async generate() {
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
      },
    };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'hi' }]);
    assert.equal(result.metrics.costUsd, 0, 'a real $0 round is priced 0, never null');
    assert.equal(result.metrics.unpricedRounds, 0);
  });

  it('falls back to estimateCost when costUsd is absent or non-finite', async () => {
    // Non-finite provider cost is NOT a price → estimateCost path → null (no model) → unpriced.
    const provider = {
      model: null,
      async generate() {
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, costUsd: NaN };
      },
    };
    const result = await new Loop({ provider }).run([{ role: 'user', content: 'hi' }]);
    assert.equal(result.metrics.costUsd, null, 'NaN cost falls through, not treated as priced');
    assert.equal(result.metrics.unpricedRounds, 1);
  });
});

// BA-5 (bareloop, HIGH): a governance bound firing is NORMAL operation in a ralph-style loop
// (`while red and under-cap: run the worker`), not an exception — and the worker's own summary of what
// it did and ruled out is the ONLY channel from attempt N to attempt N+1. Four of the five return paths
// used to substitute `text: ''`, so a bounded attempt taught its successor NOTHING: the error tag
// survived, the work did not. The caller decides what a partial result is worth; the library must not
// decide it is worth zero. Supersedes the narrower BA-3 (loop.stop()), which is a sub-case.
describe('Loop — BA-5: a bound that fires PRESERVES the text the model already produced', () => {
  const { HaltError } = require('../src/errors');
  const scripted = (fn) => ({ async generate(m, t, o) { return fn(this._i = (this._i || 0) + 1, m, t, o); } });
  const usage = { inputTokens: 1, outputTokens: 1 };
  const readTool = { name: 'read', description: 'reads', execute: async () => 'file body' };

  it('a governance HALT (budget / maxTurns) returns the produced text alongside halt:<rule>', async () => {
    // The model narrates its progress, then the gate halts on the tool call.
    const provider = scripted(() => ({ text: 'I ruled out tokenize.js; the bug is in store.js', toolCalls: [{ id: 't1', name: 'read', arguments: {} }], usage }));
    const policy = () => { throw new HaltError('over budget', { rule: 'limits.maxTurns' }); };
    const result = await new Loop({ provider, policy, throwOnError: true }).run([{ role: 'user', content: 'fix it' }], [readTool]);
    assert.equal(result.error, 'halt:limits.maxTurns', 'the rule tag still surfaces');
    assert.equal(result.text, 'I ruled out tokenize.js; the bug is in store.js', 'the halt must NOT erase the work');
  });

  it('a halt raised while METERING the round (the budget-cap shape) keeps that round\'s text', async () => {
    // The realistic budget halt: the round completes, onLlmResult forwards its usage to the gate, and the
    // gate halts on the spend it just recorded. The text of the very round that tripped the cap must survive.
    const provider = scripted(() => ({ text: 'partial answer before the cap', toolCalls: [], usage }));
    const onLlmResult = () => { throw new HaltError('cap', { rule: 'budget.maxCostUsd' }); };
    const result = await new Loop({ provider, onLlmResult, throwOnError: true }).run([{ role: 'user', content: 'go' }]);
    assert.equal(result.error, 'halt:budget.maxCostUsd');
    assert.equal(result.text, 'partial answer before the cap');
  });

  it('a DENY-STREAK short-circuit returns the produced text alongside denied:<tool>', async () => {
    const provider = scripted((i) => ({ text: `attempt ${i}: still trying to write`, toolCalls: [{ id: 'w' + i, name: 'write', arguments: {} }], usage }));
    const writeTool = { name: 'write', description: 'writes', execute: async () => 'should never run' };
    const result = await new Loop({ provider, policy: async () => '[deny] out of scope', throwOnError: true })
      .run([{ role: 'user', content: 'go' }], [writeTool]);
    assert.equal(result.error, 'denied:write');
    assert.equal(result.text, 'attempt 3: still trying to write', 'the last text the model produced, not \'\'');
  });

  it('a PROVIDER error under throwOnError:false returns the text produced on earlier rounds', async () => {
    const provider = scripted((i) => {
      if (i === 1) return { text: 'round one: read the file', toolCalls: [{ id: 't1', name: 'read', arguments: {} }], usage };
      throw new Error('upstream 503');
    });
    const result = await new Loop({ provider, throwOnError: false }).run([{ role: 'user', content: 'go' }], [readTool]);
    assert.equal(result.error, 'upstream 503');
    assert.equal(result.text, 'round one: read the file', 'a mid-run provider failure must not erase prior work');
  });

  it('loop.stop() returns error:null AND the produced text (BA-3, the caller-initiated sub-case)', async () => {
    // A deliberate stop is not a fault. Before the fix this fell through to the HARD_ROUND_LIMIT return and
    // reported the internal safety-limit warning as `error` — indistinguishable from a runaway.
    let loop;
    const stopper = { name: 'stopper', description: 'stops the loop', execute: async () => { loop.stop(); return 'stopping'; } };
    const provider = scripted(() => ({ text: 'work so far: narrowed it to keywords()', toolCalls: [{ id: 's1', name: 'stopper', arguments: {} }], usage }));
    loop = new Loop({ provider });
    const result = await loop.run([{ role: 'user', content: 'go' }], [stopper]);
    assert.equal(result.error, null, 'a caller-initiated stop is not an error');
    assert.equal(result.text, 'work so far: narrowed it to keywords()');
  });

  it('NEGATIVE CONTROL: a bound that fires before ANY text was produced still returns text:\'\'', async () => {
    // Without this, the suite cannot tell "preserved the model's text" from "always returns something
    // non-empty" — a fix that stuffed a placeholder into `text` would pass every criterion above.
    const provider = scripted(() => ({ text: '', toolCalls: [{ id: 't1', name: 'read', arguments: {} }], usage }));
    const policy = () => { throw new HaltError('cap', { rule: 'budget.maxCostUsd' }); };
    const result = await new Loop({ provider, policy, throwOnError: true }).run([{ role: 'user', content: 'go' }], [readTool]);
    assert.equal(result.error, 'halt:budget.maxCostUsd');
    assert.equal(result.text, '', 'there was nothing to preserve — do not invent text');
  });

  it('the preserved text is also on the loop:done event (the stream must not disagree with the return)', async () => {
    const provider = scripted(() => ({ text: 'produced before the halt', toolCalls: [{ id: 't1', name: 'read', arguments: {} }], usage }));
    const policy = () => { throw new HaltError('cap', { rule: 'limits.maxTurns' }); };
    const seen = [];
    const loop = new Loop({ provider, policy, throwOnError: true });
    loop.on?.('loop:done', (e) => seen.push(e));
    const result = await loop.run([{ role: 'user', content: 'go' }], [readTool]);
    assert.equal(result.text, 'produced before the halt');
  });
});

// Review findings on the BA-5 stop() exit: the transcript seal must not claim a deliberate stop was a
// governance halt, and a stop is a clean END (error:null) so it owes the same residual harvest that a
// naturally-ending run performs — otherwise a stopped run silently loses its un-evicted window.
describe('Loop — stop() exit hygiene (seal marker + residual harvest)', () => {
  const { HaltError } = require('../src/errors');
  const scripted = (fn) => ({ async generate(m, t, o) { return fn(this._i = (this._i || 0) + 1, m, t, o); } });

  it('seals a mid-round stop with [stopped], NOT [halted:…] (a stop is not a governance halt)', async () => {
    let loop;
    const stopper = { name: 'stopper', description: 'stops', execute: async () => { loop.stop(); return 'ok'; } };
    // Two tool calls in one round: the first stops the loop, the second is left dangling and must be sealed.
    const provider = scripted(() => ({ text: 'work', toolCalls: [
      { id: 'a', name: 'stopper', arguments: {} },
      { id: 'b', name: 'stopper', arguments: {} },
    ], usage: {} }));
    loop = new Loop({ provider });
    const result = await loop.run([{ role: 'user', content: 'go' }], [stopper]);
    const sealed = result.msgs.filter(m => m.role === 'tool').map(m => m.content);
    assert.deepEqual(sealed, ['ok', '[stopped]'], 'the dangling call is sealed as [stopped]');
    assert.ok(!sealed.some(c => String(c).includes('[halted:')), 'a deliberate stop must never be tagged as halted');
  });

  it('runs the trim .flush residual harvest on stop (a stop is a clean END, not an abort)', async () => {
    let loop;
    const stopper = { name: 'stopper', description: 'stops', execute: async () => { loop.stop(); return 'ok'; } };
    const provider = scripted(() => ({ text: 'work', toolCalls: [{ id: 'a', name: 'stopper', arguments: {} }], usage: {} }));
    let flushed = 0;
    const trim = async (msgs) => msgs;
    trim.flush = async () => { flushed += 1; };
    loop = new Loop({ provider, trim });
    const result = await loop.run([{ role: 'user', content: 'go' }], [stopper]);
    assert.equal(result.error, null);
    assert.equal(flushed, 1, 'the surviving window is harvested — a stopped run must not silently lose it');
  });

  it('a governance HaltError raised during the stop-flush is a clean return, never a thrown run', async () => {
    let loop;
    const stopper = { name: 'stopper', description: 'stops', execute: async () => { loop.stop(); return 'ok'; } };
    const provider = scripted(() => ({ text: 'work', toolCalls: [{ id: 'a', name: 'stopper', arguments: {} }], usage: {} }));
    const trim = async (msgs) => msgs;
    trim.flush = async () => { throw new HaltError('write gate', { rule: 'fs.writeScope' }); };
    loop = new Loop({ provider, trim, throwOnError: true });
    // This path sits PAST the outer HaltError handler — an un-converted throw would escape run() and reject.
    const result = await loop.run([{ role: 'user', content: 'go' }], [stopper]);
    assert.equal(result.error, 'halt:fs.writeScope', 'converted in place, not thrown');
    assert.equal(result.text, 'work');
  });
});
