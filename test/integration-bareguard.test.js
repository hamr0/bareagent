'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Loop } = require('../src/loop');
const { wireGate } = require('../src/bareguard-adapter');

// Mock Gate matching bareguard's surface (.check, .record). Avoids a hard
// test-time dep on bareguard while pinning the adapter contract.
function mockGate({ checkImpl, recordImpl } = {}) {
  const checkCalls = [];
  const recordCalls = [];
  return {
    async check(action) {
      checkCalls.push(action);
      return checkImpl ? checkImpl(action) : { outcome: 'allow', severity: 'action', rule: null, reason: null };
    },
    async record(action, result) {
      recordCalls.push({ action, result });
      if (recordImpl) recordImpl(action, result);
    },
    _checkCalls: checkCalls,
    _recordCalls: recordCalls,
  };
}

const weatherTool = {
  name: 'get_weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async ({ city }) => ({ temp: 22, city, conditions: 'sunny' }),
};

describe('wireGate', () => {
  it('throws when gate is missing or malformed', () => {
    assert.throws(() => wireGate(null), { message: /expects a bareguard Gate instance/ });
    assert.throws(() => wireGate({}), { message: /expects a bareguard Gate instance/ });
    assert.throws(() => wireGate({ check: () => {} }), { message: /must have .check and .record/ });
  });

  it('returns policy + wrapTool + wrapTools', () => {
    const wired = wireGate(mockGate());
    assert.equal(typeof wired.policy, 'function');
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

  it('policy maps halt severity with HALT prefix', async () => {
    const gate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'halt', rule: 'budget.maxCostUsd', reason: 'over cap' }),
    });
    const { policy } = wireGate(gate);
    const verdict = await policy('any', {});
    assert.match(verdict, /\[HALT: budget\.maxCostUsd\]/);
    assert.match(verdict, /over cap/);
  });

  it('policy synthesises a default reason when gate omits one', async () => {
    const gate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'action', rule: 'fs.deny', reason: null }),
    });
    const { policy } = wireGate(gate);
    const verdict = await policy('shell_read', { path: '/etc/shadow' });
    assert.match(verdict, /\[deny: fs\.deny\] shell_read denied/);
  });

  it('wrapTool calls gate.record with result + duration on success', async () => {
    const gate = mockGate();
    const { wrapTool } = wireGate(gate);
    const wrapped = wrapTool(weatherTool);
    const result = await wrapped.execute({ city: 'Berlin' });
    assert.deepEqual(result, { temp: 22, city: 'Berlin', conditions: 'sunny' });
    assert.equal(gate._recordCalls.length, 1);
    const [{ action, result: rec }] = gate._recordCalls;
    assert.deepEqual(action, { type: 'get_weather', args: { city: 'Berlin' } });
    assert.ok(typeof rec.result === 'string');
    assert.equal(typeof rec.durationMs, 'number');
  });

  it('wrapTool calls gate.record with error and re-throws', async () => {
    const gate = mockGate();
    const { wrapTool } = wireGate(gate);
    const failingTool = {
      name: 'fail',
      execute: async () => { throw new Error('boom'); },
    };
    const wrapped = wrapTool(failingTool);
    await assert.rejects(() => wrapped.execute({}), { message: 'boom' });
    assert.equal(gate._recordCalls.length, 1);
    assert.equal(gate._recordCalls[0].result.error, 'boom');
  });

  it('wrapTool preserves description and parameters', () => {
    const { wrapTool } = wireGate(mockGate());
    const wrapped = wrapTool(weatherTool);
    assert.equal(wrapped.name, weatherTool.name);
    assert.equal(wrapped.description, weatherTool.description);
    assert.deepEqual(wrapped.parameters, weatherTool.parameters);
  });

  it('wrapTools applies wrapTool across an array', async () => {
    const gate = mockGate();
    const { wrapTools } = wireGate(gate);
    const a = { name: 'a', execute: async () => 'a-out' };
    const b = { name: 'b', execute: async () => 'b-out' };
    const [wa, wb] = wrapTools([a, b]);
    await wa.execute({});
    await wb.execute({});
    assert.equal(gate._recordCalls.length, 2);
    assert.equal(gate._recordCalls[0].action.type, 'a');
    assert.equal(gate._recordCalls[1].action.type, 'b');
  });
});

describe('Loop + wireGate end-to-end', () => {
  function mockProvider(responses) {
    let i = 0;
    return {
      model: 'gpt-4o-mini',
      async generate() {
        const r = responses[i++];
        if (!r) throw new Error('no more mock responses');
        return r;
      },
    };
  }

  it('gate.check fires for each tool call; gate.record fires after execute', async () => {
    const gate = mockGate();
    const { policy, wrapTools } = wireGate(gate);

    const provider = mockProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } }], usage: { inputTokens: 10, outputTokens: 5 } },
      { text: 'sunny', toolCalls: [], usage: { inputTokens: 20, outputTokens: 5 } },
    ]);

    const loop = new Loop({ provider, policy });
    const result = await loop.run(
      [{ role: 'user', content: 'weather?' }],
      wrapTools([weatherTool]),
    );

    assert.equal(result.text, 'sunny');
    assert.equal(gate._checkCalls.length, 1);
    assert.equal(gate._checkCalls[0].type, 'get_weather');
    assert.equal(gate._recordCalls.length, 1);
    assert.equal(gate._recordCalls[0].action.type, 'get_weather');
  });

  it('halt-severity decision flows through to the LLM as a deny string', async () => {
    let capturedDenyMsg = null;
    const gate = mockGate({
      checkImpl: () => ({ outcome: 'deny', severity: 'halt', rule: 'limits.maxTurns', reason: 'turn cap' }),
    });
    const { policy, wrapTools } = wireGate(gate);

    const provider = {
      model: 'gpt-4o-mini',
      async generate(messages) {
        const haveTool = messages.some(m => m.role === 'tool');
        if (!haveTool) {
          return { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
        }
        capturedDenyMsg = messages.find(m => m.role === 'tool')?.content;
        return { text: 'giving up', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const loop = new Loop({ provider, policy });
    const result = await loop.run(
      [{ role: 'user', content: 'go' }],
      wrapTools([weatherTool]),
    );

    assert.equal(result.text, 'giving up');
    assert.match(capturedDenyMsg, /\[HALT: limits\.maxTurns\]/);
    // Tool was denied, so execute never ran — gate.record is not called.
    assert.equal(gate._recordCalls.length, 0);
  });

  it('ctx is forwarded into gate.check via _ctx', async () => {
    const gate = mockGate();
    const { policy, wrapTools } = wireGate(gate);
    const provider = mockProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'X' } }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const loop = new Loop({ provider, policy });
    await loop.run(
      [{ role: 'user', content: 'x' }],
      wrapTools([weatherTool]),
      { ctx: { userId: 99, role: 'admin' } },
    );
    assert.deepEqual(gate._checkCalls[0]._ctx, { userId: 99, role: 'admin' });
  });
});
