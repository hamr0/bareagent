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
  HaltError,
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

  it('HaltError carries rule + decision', () => {
    const decision = { outcome: 'deny', severity: 'halt', rule: 'budget.maxCostUsd', reason: 'over' };
    const err = new HaltError('budget exhausted', { rule: 'budget.maxCostUsd', decision });
    assert.ok(err instanceof BareAgentError);
    assert.equal(err.code, 'HALT');
    assert.equal(err.retryable, false);
    assert.equal(err.rule, 'budget.maxCostUsd');
    assert.deepEqual(err.decision, decision);
  });
});

// A7: HaltError must be reachable through the public API so adopters whose
// policy shims throw it can be caught by Loop's instanceof check (which
// requires identity-equal class across module boundaries).
describe('Public API exports', () => {
  it('HaltError is re-exported from main entry', () => {
    const { HaltError: HaltFromMain } = require('../index');
    assert.equal(HaltFromMain, HaltError, 'main re-export must be the same class identity');
  });

  it('HaltError is reachable via the ./errors subpath', () => {
    const { HaltError: HaltFromSubpath } = require('../src/errors');
    assert.equal(HaltFromSubpath, HaltError);
    // Verify package.json exports declares the subpath (resolution from
    // outside the package goes through exports; from inside we read the file).
    const pkg = require('../package.json');
    assert.equal(pkg.exports['./errors'], './src/errors.js');
    assert.equal(pkg.exports['./package.json'], './package.json');
  });
});
