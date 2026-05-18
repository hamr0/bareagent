'use strict';

class BareAgentError extends Error {
  constructor(message, { code, retryable = false, context = {} } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || undefined;
    this.retryable = retryable;
    this.context = context;
  }
}

class ProviderError extends BareAgentError {
  constructor(message, { status, body, context = {} } = {}) {
    const retryable = status === 429 || (status >= 500 && status <= 504);
    super(message, { code: 'PROVIDER_ERROR', retryable, context });
    this.status = status;
    this.body = body;
  }
}

class ToolError extends BareAgentError {
  constructor(message, opts = {}) {
    super(message, { code: 'TOOL_ERROR', retryable: false, ...opts });
  }
}

class TimeoutError extends BareAgentError {
  constructor(message, opts = {}) {
    super(message || 'Operation timed out', { code: 'ETIMEDOUT', retryable: true, ...opts });
  }
}

class ValidationError extends BareAgentError {
  constructor(message, opts = {}) {
    super(message, { code: 'VALIDATION_ERROR', retryable: false, ...opts });
  }
}

class CircuitOpenError extends BareAgentError {
  constructor(message, opts = {}) {
    super(message || 'Circuit breaker is open', { code: 'CIRCUIT_OPEN', retryable: true, ...opts });
  }
}

// Signals a halt-severity governance decision (budget exhausted, turn cap hit,
// gate terminated, etc.). Thrown by wireGate's policy closure and caught by
// Loop's outer handler — does NOT propagate to the LLM as a tool result.
// Loop exits cleanly: emits loop:error{source:'halt'} + loop:done, calls onError.
class HaltError extends BareAgentError {
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
