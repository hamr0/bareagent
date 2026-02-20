'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FallbackProvider } = require('../src/provider-fallback');

const ok = (text = 'ok') => ({ generate: async () => ({ text, toolCalls: [], usage: {} }) });
const fail = (msg = 'down') => ({ generate: async () => { throw new Error(msg); } });

describe('FallbackProvider', () => {
  it('returns result from first provider on success', async () => {
    const fb = new FallbackProvider([ok('first'), ok('second')]);
    const result = await fb.generate([]);
    assert.equal(result.text, 'first');
  });

  it('falls back when first fails', async () => {
    const fb = new FallbackProvider([fail('p1 down'), ok('p2')]);
    const result = await fb.generate([]);
    assert.equal(result.text, 'p2');
  });

  it('throws AggregateError when all fail', async () => {
    const fb = new FallbackProvider([fail('a'), fail('b')]);
    await assert.rejects(
      () => fb.generate([]),
      (err) => {
        assert.ok(err instanceof AggregateError);
        assert.equal(err.errors.length, 2);
        assert.equal(err.errors[0].message, 'a');
        assert.equal(err.errors[1].message, 'b');
        return true;
      }
    );
  });

  it('shouldFallback=false stops fallback', async () => {
    const fb = new FallbackProvider([fail('auth'), ok('p2')], {
      shouldFallback: () => false,
    });
    await assert.rejects(
      () => fb.generate([]),
      { message: 'auth' }
    );
  });

  it('onFallback fires with indices', async () => {
    const calls = [];
    const fb = new FallbackProvider([fail('err'), ok('ok')], {
      onFallback: (err, from, to) => calls.push({ msg: err.message, from, to }),
    });
    await fb.generate([]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { msg: 'err', from: 0, to: 1 });
  });

  it('rejects empty providers array', () => {
    assert.throws(() => new FallbackProvider([]), /requires at least one provider/);
  });
});
