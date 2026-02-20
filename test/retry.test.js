'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Retry } = require('../src/retry');
const { TimeoutError } = require('../src/errors');

describe('Retry', () => {
  it('returns result on first success', async () => {
    const retry = new Retry();
    const result = await retry.call(() => Promise.resolve('ok'));
    assert.equal(result, 'ok');
  });

  it('retries on failure and succeeds', async () => {
    const retry = new Retry({ maxAttempts: 3, backoff: 10 });
    let attempts = 0;
    const result = await retry.call(() => {
      attempts++;
      if (attempts < 3) {
        const err = new Error('fail');
        err.status = 500;
        throw err;
      }
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(attempts, 3);
  });

  it('throws after maxAttempts exhausted', async () => {
    const retry = new Retry({ maxAttempts: 2, backoff: 10 });
    await assert.rejects(
      () => retry.call(() => { const e = new Error('fail'); e.status = 500; throw e; }),
      { message: 'fail' }
    );
  });

  it('does not retry non-retryable errors', async () => {
    const retry = new Retry({ maxAttempts: 3, backoff: 10 });
    let attempts = 0;
    await assert.rejects(
      () => retry.call(() => { attempts++; throw new Error('bad request'); }),
      { message: 'bad request' }
    );
    assert.equal(attempts, 1);
  });

  it('respects custom retryOn', async () => {
    const retry = new Retry({
      maxAttempts: 3,
      backoff: 10,
      retryOn: (err) => err.message === 'retry-me',
    });
    let attempts = 0;
    const result = await retry.call(() => {
      attempts++;
      if (attempts < 2) throw new Error('retry-me');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(attempts, 2);
  });

  it('times out per attempt with TimeoutError', async () => {
    const retry = new Retry({ maxAttempts: 1, timeout: 50 });
    await assert.rejects(
      () => retry.call(() => new Promise(r => setTimeout(() => r('late'), 200))),
      (err) => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.retryable, true);
        return true;
      }
    );
  });

  describe('retryable fast path', () => {
    it('retries when err.retryable === true', async () => {
      const retry = new Retry({ maxAttempts: 3, backoff: 10 });
      let attempts = 0;
      const result = await retry.call(() => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('retryable');
          err.retryable = true;
          throw err;
        }
        return 'ok';
      });
      assert.equal(result, 'ok');
      assert.equal(attempts, 2);
    });

    it('bails when err.retryable === false', async () => {
      const retry = new Retry({ maxAttempts: 3, backoff: 10 });
      let attempts = 0;
      await assert.rejects(
        () => retry.call(() => {
          attempts++;
          const err = new Error('no retry');
          err.retryable = false;
          throw err;
        }),
        { message: 'no retry' }
      );
      assert.equal(attempts, 1);
    });
  });

  describe('jitter', () => {
    it('jitter: "full" produces delay in [0, base)', () => {
      const retry = new Retry({ jitter: 'full', backoff: 1000 });
      const delays = Array.from({ length: 50 }, () => retry._delay(1));
      for (const d of delays) {
        assert.ok(d >= 0, `delay ${d} should be >= 0`);
        assert.ok(d < 1000, `delay ${d} should be < 1000`);
      }
    });

    it('jitter: "equal" produces delay in [base/2, base)', () => {
      const retry = new Retry({ jitter: 'equal', backoff: 1000 });
      const delays = Array.from({ length: 50 }, () => retry._delay(1));
      for (const d of delays) {
        assert.ok(d >= 500, `delay ${d} should be >= 500`);
        assert.ok(d < 1000, `delay ${d} should be < 1000`);
      }
    });

    it('numeric jitter applies proportional spread', () => {
      const retry = new Retry({ jitter: 0.5, backoff: 1000 });
      const delays = Array.from({ length: 50 }, () => retry._delay(1));
      for (const d of delays) {
        assert.ok(d >= 500, `delay ${d} should be >= 500`);
        assert.ok(d < 1000, `delay ${d} should be < 1000`);
      }
    });

    it('jitter: false (default) returns exact base delay', () => {
      const retry = new Retry({ backoff: 'exponential' });
      assert.equal(retry._delay(1), 1000);
      assert.equal(retry._delay(2), 2000);
      assert.equal(retry._delay(3), 4000);
    });
  });
});
