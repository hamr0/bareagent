'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CircuitBreaker } = require('../src/circuit-breaker');
const { CircuitOpenError } = require('../src/errors');

describe('CircuitBreaker', () => {
  it('stays closed under threshold', async () => {
    const cb = new CircuitBreaker({ threshold: 3 });
    for (let i = 0; i < 2; i++) {
      try { await cb.call(() => { throw new Error('fail'); }); } catch {}
    }
    assert.equal(cb.getState(), 'closed');
  });

  it('opens after threshold failures', async () => {
    const cb = new CircuitBreaker({ threshold: 3 });
    for (let i = 0; i < 3; i++) {
      try { await cb.call(() => { throw new Error('fail'); }); } catch {}
    }
    assert.equal(cb.getState(), 'open');
  });

  it('rejects when open with CircuitOpenError', async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetAfter: 60000 });
    try { await cb.call(() => { throw new Error('fail'); }); } catch {}
    await assert.rejects(
      () => cb.call(() => 'ok'),
      (err) => {
        assert.ok(err instanceof CircuitOpenError);
        assert.equal(err.retryable, true);
        return true;
      }
    );
  });

  it('transitions to half-open after resetAfter', async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetAfter: 10 });
    try { await cb.call(() => { throw new Error('fail'); }); } catch {}
    assert.equal(cb.getState(), 'open');
    await new Promise(r => setTimeout(r, 15));
    // Next call triggers half-open transition
    const result = await cb.call(() => 'recovered');
    assert.equal(result, 'recovered');
    assert.equal(cb.getState(), 'closed');
  });

  it('half-open failure reopens circuit', async () => {
    const cb = new CircuitBreaker({ threshold: 1, resetAfter: 10 });
    try { await cb.call(() => { throw new Error('fail'); }); } catch {}
    await new Promise(r => setTimeout(r, 15));
    try { await cb.call(() => { throw new Error('fail again'); }); } catch {}
    assert.equal(cb.getState(), 'open');
  });

  it('reset() forces closed', async () => {
    const cb = new CircuitBreaker({ threshold: 1 });
    try { await cb.call(() => { throw new Error('fail'); }); } catch {}
    assert.equal(cb.getState(), 'open');
    cb.reset();
    assert.equal(cb.getState(), 'closed');
  });

  it('per-key isolation', async () => {
    const cb = new CircuitBreaker({ threshold: 1 });
    try { await cb.call(() => { throw new Error('fail'); }, 'keyA'); } catch {}
    assert.equal(cb.getState('keyA'), 'open');
    assert.equal(cb.getState('keyB'), 'closed');
    const result = await cb.call(() => 'ok', 'keyB');
    assert.equal(result, 'ok');
  });

  it('onStateChange fires', async () => {
    const changes = [];
    const cb = new CircuitBreaker({
      threshold: 1,
      onStateChange: (key, from, to) => changes.push({ key, from, to }),
    });
    try { await cb.call(() => { throw new Error('fail'); }, 'x'); } catch {}
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0], { key: 'x', from: 'closed', to: 'open' });
  });

  it('wrapProvider wraps generate()', async () => {
    const cb = new CircuitBreaker({ threshold: 2 });
    const provider = { generate: async () => ({ text: 'hi', toolCalls: [], usage: {} }) };
    const wrapped = cb.wrapProvider(provider, 'p1');
    const result = await wrapped.generate([], []);
    assert.equal(result.text, 'hi');
  });

  it('wrapProvider preserves passthrough props (model, name) for cost accounting', async () => {
    const cb = new CircuitBreaker({ threshold: 2 });
    const provider = {
      model: 'gpt-4o',
      name: 'openai',
      generate: async () => ({ text: 'hi', toolCalls: [], usage: {} }),
    };
    const wrapped = cb.wrapProvider(provider, 'p1');
    // Loop reads provider.model to derive cost — the wrapper must not drop it.
    assert.equal(wrapped.model, 'gpt-4o');
    assert.equal(wrapped.name, 'openai');
  });
});
