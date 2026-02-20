'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  BareAgentError,
  ProviderError,
  ToolError,
  TimeoutError,
  ValidationError,
  CircuitOpenError,
  MaxRoundsError,
} = require('../src/errors');

describe('Errors', () => {
  it('BareAgentError extends Error with defaults', () => {
    const err = new BareAgentError('test');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof BareAgentError);
    assert.equal(err.name, 'BareAgentError');
    assert.equal(err.message, 'test');
    assert.equal(err.retryable, false);
    assert.deepEqual(err.context, {});
  });

  it('BareAgentError accepts code, retryable, context', () => {
    const err = new BareAgentError('test', { code: 'MY_CODE', retryable: true, context: { key: 'val' } });
    assert.equal(err.code, 'MY_CODE');
    assert.equal(err.retryable, true);
    assert.deepEqual(err.context, { key: 'val' });
  });

  it('ProviderError auto-retryable for 429', () => {
    const err = new ProviderError('rate limited', { status: 429, body: { error: 'slow down' } });
    assert.ok(err instanceof BareAgentError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ProviderError');
    assert.equal(err.status, 429);
    assert.deepEqual(err.body, { error: 'slow down' });
    assert.equal(err.retryable, true);
    assert.equal(err.code, 'PROVIDER_ERROR');
  });

  it('ProviderError auto-retryable for 5xx', () => {
    for (const status of [500, 502, 503, 504]) {
      const err = new ProviderError(`HTTP ${status}`, { status });
      assert.equal(err.retryable, true, `expected retryable for ${status}`);
    }
  });

  it('ProviderError not retryable for 4xx (non-429)', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const err = new ProviderError(`HTTP ${status}`, { status });
      assert.equal(err.retryable, false, `expected non-retryable for ${status}`);
    }
  });

  it('ToolError has correct defaults', () => {
    const err = new ToolError('tool broke');
    assert.ok(err instanceof BareAgentError);
    assert.equal(err.code, 'TOOL_ERROR');
    assert.equal(err.retryable, false);
  });

  it('TimeoutError has correct defaults', () => {
    const err = new TimeoutError();
    assert.ok(err instanceof BareAgentError);
    assert.equal(err.code, 'ETIMEDOUT');
    assert.equal(err.retryable, true);
    assert.equal(err.message, 'Operation timed out');
  });

  it('ValidationError has correct defaults', () => {
    const err = new ValidationError('bad input');
    assert.ok(err instanceof BareAgentError);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.equal(err.retryable, false);
  });

  it('CircuitOpenError has correct defaults', () => {
    const err = new CircuitOpenError();
    assert.ok(err instanceof BareAgentError);
    assert.equal(err.code, 'CIRCUIT_OPEN');
    assert.equal(err.retryable, true);
    assert.equal(err.message, 'Circuit breaker is open');
  });

  it('MaxRoundsError has correct defaults', () => {
    const err = new MaxRoundsError();
    assert.ok(err instanceof BareAgentError);
    assert.equal(err.code, 'MAX_ROUNDS');
    assert.equal(err.retryable, false);
    assert.equal(err.message, 'Loop exceeded maximum rounds');
  });
});
