'use strict';

/**
 * @typedef {object} BareAgentErrorOptions
 * @property {string} [code] - Stable error code (e.g. 'PROVIDER_ERROR').
 * @property {boolean} [retryable] - Whether the operation may be safely retried.
 * @property {Record<string, any>} [context] - Arbitrary structured context.
 */

/**
 * @typedef {object} ProviderErrorOptions
 * @property {number} [status] - HTTP status from the provider.
 * @property {any} [body] - Raw response body.
 * @property {Record<string, any>} [context] - Arbitrary structured context.
 */

/**
 * @typedef {object} HaltErrorOptions
 * @property {string} [rule] - The bareguard rule that triggered the halt.
 * @property {any} [decision] - The full bareguard decision object.
 * @property {Record<string, any>} [context] - Arbitrary structured context.
 */

class BareAgentError extends Error {
  /**
   * @param {string} message
   * @param {BareAgentErrorOptions} [options]
   */
  constructor(message, { code, retryable = false, context = {} } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || undefined;
    this.retryable = retryable;
    this.context = context;
  }
}

class ProviderError extends BareAgentError {
  /**
   * @param {string} message
   * @param {ProviderErrorOptions} [options]
   */
  constructor(message, { status, body, context = {} } = {}) {
    const retryable = status === 429 || (status != null && status >= 500 && status <= 504);
    super(message, { code: 'PROVIDER_ERROR', retryable, context });
    this.status = status;
    this.body = body;
  }
}

class ToolError extends BareAgentError {
  /**
   * @param {string} message
   * @param {BareAgentErrorOptions} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { code: 'TOOL_ERROR', retryable: false, ...opts });
  }
}

class TimeoutError extends BareAgentError {
  /**
   * @param {string} [message]
   * @param {BareAgentErrorOptions} [opts]
   */
  constructor(message, opts = {}) {
    super(message || 'Operation timed out', { code: 'ETIMEDOUT', retryable: true, ...opts });
  }
}

class ValidationError extends BareAgentError {
  /**
   * @param {string} message
   * @param {BareAgentErrorOptions} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { code: 'VALIDATION_ERROR', retryable: false, ...opts });
  }
}

class CircuitOpenError extends BareAgentError {
  /**
   * @param {string} [message]
   * @param {BareAgentErrorOptions} [opts]
   */
  constructor(message, opts = {}) {
    super(message || 'Circuit breaker is open', { code: 'CIRCUIT_OPEN', retryable: true, ...opts });
  }
}

// Signals a halt-severity governance decision (budget exhausted, turn cap hit,
// gate terminated, etc.). Thrown by wireGate's policy closure and caught by
// Loop's outer handler — does NOT propagate to the LLM as a tool result.
// Loop exits cleanly: emits loop:error{source:'halt'} + loop:done, calls onError.
class HaltError extends BareAgentError {
  /**
   * @param {string} [message]
   * @param {HaltErrorOptions} [options]
   */
  constructor(message, { rule, decision, context = {} } = {}) {
    super(message || `[HALT: ${rule || 'unknown'}]`, {
      code: 'HALT',
      retryable: false,
      context,
    });
    // Public, stable surface — read `err.rule` / `err.decision` (not `err.context`).
    this.rule = rule || null;
    this.decision = decision || null;
  }
}

module.exports = {
  BareAgentError,
  ProviderError,
  ToolError,
  TimeoutError,
  ValidationError,
  CircuitOpenError,
  HaltError,
};
