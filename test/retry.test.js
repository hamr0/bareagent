'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Retry } = require('../src/retry');

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

  it('times out per attempt', async () => {
    const retry = new Retry({ maxAttempts: 1, timeout: 50 });
    await assert.rejects(
      () => retry.call(() => new Promise(r => setTimeout(() => r('late'), 200))),
      { code: 'ETIMEDOUT' }
    );
  });
});
