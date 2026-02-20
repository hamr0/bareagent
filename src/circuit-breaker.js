'use strict';

const { CircuitOpenError } = require('./errors');

class CircuitBreaker {
  /**
   * @param {object} [options={}]
   * @param {number} [options.threshold=5] - Failures before opening.
   * @param {number} [options.resetAfter=60000] - Ms before half-open probe.
   * @param {function} [options.onStateChange] - Callback(key, from, to).
   */
  constructor(options = {}) {
    this.threshold = options.threshold || 5;
    this.resetAfter = options.resetAfter || 60000;
    this.onStateChange = options.onStateChange || null;
    this._keys = new Map();
  }

  _getEntry(key) {
    if (!this._keys.has(key)) {
      this._keys.set(key, { state: 'closed', failures: 0, openedAt: 0, generation: 0 });
    }
    return this._keys.get(key);
  }

  _setState(entry, key, newState) {
    const from = entry.state;
    if (from === newState) return;
    entry.state = newState;
    this.onStateChange?.(key, from, newState);
  }

  /**
   * Execute fn through the circuit breaker.
   * @param {function} fn - Async function to call.
   * @param {string} [key='default'] - Circuit key for per-key isolation.
   * @returns {Promise<*>}
   * @throws {CircuitOpenError} When circuit is open.
   */
  async call(fn, key = 'default') {
    const entry = this._getEntry(key);

    if (entry.state === 'open') {
      if (Date.now() - entry.openedAt >= this.resetAfter) {
        this._setState(entry, key, 'half-open');
        entry.generation++;
      } else {
        throw new CircuitOpenError(`Circuit "${key}" is open`);
      }
    }

    const gen = entry.generation;

    try {
      const result = await fn();
      // Only close if still same generation (prevents stale half-open races)
      if (entry.generation === gen) {
        entry.failures = 0;
        if (entry.state === 'half-open') {
          this._setState(entry, key, 'closed');
        }
      }
      return result;
    } catch (err) {
      if (entry.generation === gen) {
        entry.failures++;
        if (entry.state === 'half-open') {
          entry.openedAt = Date.now();
          this._setState(entry, key, 'open');
        } else if (entry.failures >= this.threshold) {
          entry.openedAt = Date.now();
          this._setState(entry, key, 'open');
        }
      }
      throw err;
    }
  }

  /**
   * Get current state for a key.
   * @param {string} [key='default']
   * @returns {'closed'|'open'|'half-open'}
   */
  getState(key = 'default') {
    return this._getEntry(key).state;
  }

  /**
   * Force reset a key to closed.
   * @param {string} [key='default']
   */
  reset(key = 'default') {
    const entry = this._getEntry(key);
    entry.failures = 0;
    entry.openedAt = 0;
    this._setState(entry, key, 'closed');
  }

  /**
   * Wrap a provider so generate() goes through the circuit breaker.
   * @param {object} provider - Provider with generate().
   * @param {string} [key] - Circuit key.
   * @returns {object} Wrapped provider with generate().
   */
  wrapProvider(provider, key) {
    return {
      generate: (...args) => this.call(() => provider.generate(...args), key),
    };
  }
}

module.exports = { CircuitBreaker };
