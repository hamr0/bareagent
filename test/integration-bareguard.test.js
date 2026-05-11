'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { wireGate } = require('../src/bareguard-adapter');
const { HaltError } = require('../src/errors');

// Mock Gate matching bareguard's surface (.check, .record, .allows). Avoids a
// hard test-time dep on bareguard while pinning the adapter contract.
function mockGate({ checkImpl, recordImpl, allowsImpl } = {}) {
  const checkCalls = [];
  const recordCalls = [];
  const allowsCalls = [];
  return {
    async check(action) {
      checkCalls.push(action);
      return checkImpl ? checkImpl(action) : { outcome: 'allow', severity: 'action', rule: null, reason: null };
    },
    async record(action, result) {
      recordCalls.push({ action, result });
      if (recordImpl) recordImpl(action, result);
    },
    async allows(nameOrAction) {
      allowsCalls.push(nameOrAction);
      return allowsImpl ? allowsImpl(nameOrAction) : true;
    },
    _checkCalls: checkCalls,
    _recordCalls: recordCalls,
    _allowsCalls: allowsCalls,
  };
}

const weatherTool = {
  name: 'get_weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }) => ({ temp: 22, city, conditions: 'sunny' }),
};

function mockProvider(responses) {
  let i = 0;
  return {
    model: 'gpt-4o-mini',
    name: 'mock',
    async generate() {
      const r = responses[i++];
      if (!r) throw new Error('no more mock responses');
      return r;
    },
  };
}

describe('wireGate', () => {
  it('throws when gate is missing or malformed', () => {
    assert.throws(() => wireGate(null), { message: /expects a bareguard Gate instance/ });
    assert.throws(() => wireGate({}), { message: /expects a bareguard Gate instance/ });
    assert.throws(() => wireGate({ check: () => {} }), { message: /must have .check and .record/ });
  });

  it('returns the full BA-era return shape', () => {
    const wired = wireGate(mockGate());
    assert.equal(typeof wired.policy, 'function');
    assert.equal(typeof wired.onLlmResult, 'function');
    assert.equal(typeof wired.onToolResult, 'function');
    assert.equal(typeof wired.filterTools, 'function');
    // Legacy wrap* still exported as deprecation shims (BA1 transition).
    assert.equal(typeof wired.wrapTool, 'function');
    assert.equal(typeof wired.wrapTools, 'function');
  });

  it('policy maps allow decision to true', async () => {
    const gate = mockGate();
    const { policy } = wireGate(gate);
    const verdict = await policy('get_weather', { city: 'Berlin' }, { userId: 1 });
    assert.equal(verdict, true);
    assert.equal(gate._checkCalls.length, 1);
    assert.deepEqual(gate._checkCalls[0], {
      type: 'get_weather',
      args: { city: 'Berlin' },
      _ctx: { userId: 1 },
    });
  });

  it('policy maps deny to a tagged reason string', async () => {
    const gate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'action', rule: 'tools.denylist', reason: 'tool blocked' }),
    });
    const { policy } = wireGate(gate);
    const verdict = await policy('shell_run', { argv: ['rm'] });
    assert.match(verdict, /\[deny: tools\.denylist\]/);
    assert.match(verdict, /tool blocked/);
  });

  it('policy synthesises a default reason when gate omits one', async () => {
    const gate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'action', rule: 'fs.deny', reason: null }),
    });
    const { policy } = wireGate(gate);
    const verdict = await policy('shell_read', { path: '/etc/shadow' });
    assert.match(verdict, /\[deny: fs\.deny\] shell_read denied/);
  });

  // BA2: halt now throws HaltError instead of returning a string.
  it('policy throws HaltError on halt severity (BA2)', async () => {
    const gate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'halt', rule: 'budget.maxCostUsd', reason: 'over cap' }),
    });
    const { policy } = wireGate(gate);
    await assert.rejects(() => policy('any', {}), (err) => {
      assert.ok(err instanceof HaltError, 'expected HaltError');
      assert.equal(err.rule, 'budget.maxCostUsd');
      assert.equal(err.decision.severity, 'halt');
      return true;
    });
  });

  // BA4: formatDeny customises the deny string. Halt path bypasses it.
  it('formatDeny customises deny strings; halt bypasses (BA4)', async () => {
    const denyGate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'action', rule: 'tools.denylist', reason: 'nope' }),
    });
    const haltGate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'halt', rule: 'limits.maxTurns', reason: 'cap' }),
    });
    const formatDeny = (d) => `BLOCKED(${d.rule}): ${d.reason}`;
    const { policy: denyPolicy } = wireGate(denyGate, { formatDeny });
    const { policy: haltPolicy } = wireGate(haltGate, { formatDeny });

    const denyVerdict = await denyPolicy('shell_run', {});
    assert.equal(denyVerdict, 'BLOCKED(tools.denylist): nope');

    // Halt does NOT call formatDeny — it throws.
    await assert.rejects(() => haltPolicy('any', {}), HaltError);
  });

  it('formatDeny must be a function if provided', () => {
    assert.throws(() => wireGate(mockGate(), { formatDeny: 'not a fn' }),
      { message: /formatDeny must be a function/ });
  });

  // BA3: filterTools drops denied tools via gate.allows.
  it('filterTools drops tools denied by gate.allows (BA3)', async () => {
    const gate = mockGate({
      allowsImpl: (name) => name !== 'shell_run',
    });
    const { filterTools } = wireGate(gate);
    const tools = [
      { name: 'get_weather', execute: async () => 'ok' },
      { name: 'shell_run', execute: async () => 'ok' },
      { name: 'http_get', execute: async () => 'ok' },
    ];
    const filtered = await filterTools(tools);
    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered.map(t => t.name), ['get_weather', 'http_get']);
    // No audit/record — only gate.allows fires.
    assert.equal(gate._checkCalls.length, 0);
    assert.equal(gate._recordCalls.length, 0);
    assert.equal(gate._allowsCalls.length, 3);
  });

  it('filterTools throws if gate lacks .allows', async () => {
    const stripped = mockGate();
    delete stripped.allows;
    const { filterTools } = wireGate(stripped);
    await assert.rejects(() => filterTools([{ name: 'a', execute: () => {} }]),
      { message: /gate must have .allows/ });
  });

  // BA1: onToolResult forwards to gate.record with ctx in scope (fixes _ctx loss).
  it('onToolResult records success with ctx (BA1)', async () => {
    const gate = mockGate();
    const { onToolResult } = wireGate(gate);
    await onToolResult({
      name: 'get_weather',
      args: { city: 'Berlin' },
      result: { temp: 22 },
      durationMs: 42,
      ctx: { userId: 7 },
    });
    assert.equal(gate._recordCalls.length, 1);
    const [{ action, result }] = gate._recordCalls;
    assert.deepEqual(action, { type: 'get_weather', args: { city: 'Berlin' }, _ctx: { userId: 7 } });
    assert.equal(result.durationMs, 42);
    assert.ok(typeof result.result === 'string');
  });

  it('onToolResult records errors with ctx (BA1)', async () => {
    const gate = mockGate();
    const { onToolResult } = wireGate(gate);
    await onToolResult({
      name: 'shell_run',
      args: { argv: ['rm'] },
      error: new Error('boom'),
      durationMs: 5,
      ctx: { userId: 9 },
    });
    assert.equal(gate._recordCalls.length, 1);
    const [{ action, result }] = gate._recordCalls;
    assert.equal(action._ctx.userId, 9);
    assert.equal(result.error, 'boom');
  });

  // BA1: onLlmResult forwards LLM usage as a {type:'llm'} action so budget covers tokens.
  it('onLlmResult records LLM usage with ctx (BA1)', async () => {
    const gate = mockGate();
    const { onLlmResult } = wireGate(gate);
    await onLlmResult({
      model: 'gpt-4o-mini',
      provider: 'openai',
      usage: { inputTokens: 100, outputTokens: 50 },
      costUsd: 0.00045,
      durationMs: 1200,
      ctx: { userId: 1 },
    });
    assert.equal(gate._recordCalls.length, 1);
    const [{ action, result }] = gate._recordCalls;
    assert.equal(action.type, 'llm');
    assert.equal(action.args.model, 'gpt-4o-mini');
    assert.equal(action.args.provider, 'openai');
    assert.equal(action._ctx.userId, 1);
    assert.equal(result.costUsd, 0.00045);
    assert.equal(result.tokens, 150);
  });

  // Legacy shims still work (with a console.warn one-shot deprecation notice).
  it('wrapTool still works for backward compat (deprecated)', async () => {
    const gate = mockGate();
    const { wrapTool } = wireGate(gate);
    const origWarn = console.warn;
    let warned = '';
    console.warn = (m) => { warned += m; };
    try {
      const wrapped = wrapTool(weatherTool);
      const result = await wrapped.execute({ city: 'Berlin' });
      assert.deepEqual(result, { temp: 22, city: 'Berlin', conditions: 'sunny' });
      assert.equal(gate._recordCalls.length, 1);
      assert.match(warned, /deprecated/);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe('Loop + wireGate end-to-end (BA suite)', () => {
  it('records LLM cost and tool result on every round (BA1)', async () => {
    const gate = mockGate();
    const { policy, onLlmResult, onToolResult } = wireGate(gate);

    const provider = mockProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } }], usage: { inputTokens: 100, outputTokens: 50 } },
      { text: 'sunny', toolCalls: [], usage: { inputTokens: 200, outputTokens: 30 } },
    ]);

    const loop = new Loop({ provider, policy, onLlmResult, onToolResult });
    await loop.run([{ role: 'user', content: 'weather?' }], [weatherTool], { ctx: { userId: 42 } });

    // 2 LLM rounds + 1 tool call = 3 gate.record calls.
    assert.equal(gate._recordCalls.length, 3);

    // First record is LLM (round 1).
    assert.equal(gate._recordCalls[0].action.type, 'llm');
    assert.equal(gate._recordCalls[0].action._ctx.userId, 42);
    assert.equal(gate._recordCalls[0].result.tokens, 150);
    assert.ok(gate._recordCalls[0].result.costUsd > 0);

    // Then the tool call.
    assert.equal(gate._recordCalls[1].action.type, 'get_weather');
    assert.equal(gate._recordCalls[1].action._ctx.userId, 42);

    // Then the second LLM round.
    assert.equal(gate._recordCalls[2].action.type, 'llm');
    assert.equal(gate._recordCalls[2].result.tokens, 230);
  });

  it('Loop exits cleanly on HaltError — no [HALT:] reaches the LLM (BA2)', async () => {
    const gate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'halt', rule: 'limits.maxTurns', reason: 'turn cap' }),
    });
    const { policy } = wireGate(gate);

    // Provider would happily keep going if asked — but it shouldn't be asked again.
    let calls = 0;
    const provider = {
      model: 'gpt-4o-mini',
      name: 'mock',
      async generate() {
        calls++;
        return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const errEvents = [];
    const haltEvents = [];
    const stream = { emit: (ev) => {
      if (ev.type === 'loop:error') errEvents.push(ev);
      if (ev.type === 'loop:done' && ev.data?.halted) haltEvents.push(ev);
    } };

    let onErrorCalled = null;
    const loop = new Loop({
      provider,
      policy,
      stream,
      onError: (err, info) => { onErrorCalled = { err, info }; },
    });
    const result = await loop.run([{ role: 'user', content: 'go' }], [weatherTool]);

    // No [HALT:] tool message landed in msgs.
    const toolMsgs = result.msgs.filter(m => m.role === 'tool');
    for (const tm of toolMsgs) {
      assert.doesNotMatch(String(tm.content), /\[HALT:/);
    }
    // Single provider call — the loop exited before the next round.
    assert.equal(calls, 1);
    // Clean error code in return value.
    assert.equal(result.error, 'halt:limits.maxTurns');
    // loop:error{source:'halt'} fired.
    assert.equal(errEvents.length, 1);
    assert.equal(errEvents[0].data.source, 'halt');
    assert.equal(errEvents[0].data.rule, 'limits.maxTurns');
    // loop:done with halted:true.
    assert.equal(haltEvents.length, 1);
    // onError called with halt source.
    assert.ok(onErrorCalled);
    assert.equal(onErrorCalled.info.source, 'halt');
    assert.ok(onErrorCalled.err instanceof HaltError);
  });

  it('throwOnError:true does NOT throw on halt — halt is a clean exit (BA2)', async () => {
    const gate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'halt', rule: 'budget.maxCostUsd', reason: 'over' }),
    });
    const { policy } = wireGate(gate);
    const provider = mockProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const loop = new Loop({ provider, policy, throwOnError: true });
    const result = await loop.run([{ role: 'user', content: 'x' }], [weatherTool]);
    assert.equal(result.error, 'halt:budget.maxCostUsd');
  });

  it('plain deny still feeds the LLM a deny string (unchanged)', async () => {
    const gate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'action', rule: 'tools.denylist', reason: 'blocked' }),
    });
    const { policy } = wireGate(gate);
    let denyMsg = null;
    const provider = {
      model: 'gpt-4o-mini',
      name: 'mock',
      async generate(messages) {
        const haveTool = messages.some(m => m.role === 'tool');
        if (!haveTool) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
        }
        denyMsg = messages.find(m => m.role === 'tool')?.content;
        return { text: 'oh well', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const loop = new Loop({ provider, policy });
    const result = await loop.run([{ role: 'user', content: 'go' }], [weatherTool]);
    assert.equal(result.text, 'oh well');
    assert.match(denyMsg, /\[deny: tools\.denylist\]/);
  });

  it('ctx forwarded into both onLlmResult and onToolResult (BA1)', async () => {
    const gate = mockGate();
    const { policy, onLlmResult, onToolResult } = wireGate(gate);
    const provider = mockProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'X' } }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const loop = new Loop({ provider, policy, onLlmResult, onToolResult });
    await loop.run(
      [{ role: 'user', content: 'x' }],
      [weatherTool],
      { ctx: { userId: 99, role: 'admin' } },
    );
    // Every record carries the ctx.
    for (const call of gate._recordCalls) {
      assert.deepEqual(call.action._ctx, { userId: 99, role: 'admin' });
    }
  });

  it('onLlmResult/onToolResult errors are reported but do not kill the loop', async () => {
    const gate = mockGate();
    const { policy } = wireGate(gate);
    const provider = mockProvider([
      { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const errEvents = [];
    const stream = { emit: (ev) => { if (ev.type === 'loop:error') errEvents.push(ev); } };
    const loop = new Loop({
      provider,
      policy,
      stream,
      onLlmResult: async () => { throw new Error('record blew up'); },
    });
    const result = await loop.run([{ role: 'user', content: 'x' }], []);
    assert.equal(result.text, 'done');
    assert.equal(errEvents.length, 1);
    assert.equal(errEvents[0].data.source, 'onLlmResult');
  });
});
