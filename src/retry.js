'use strict';

const { TimeoutError } = require('./errors');

const DEFAULT_RETRY_ON = (err) => {
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  const status = err.status || err.statusCode;
  if (status === 429 || (status >= 500 && status <= 504)) return true;
  const code = err.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true;
  return false;
};

class Retry {
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts || 3;
    this.backoff = options.backoff || 'exponential';
    this.timeout = options.timeout || 60000;
    this.retryOn = options.retryOn || DEFAULT_RETRY_ON;
    this.jitter = options.jitter !== undefined ? options.jitter : false;
  }

  /**
   * Call a function with retry logic.
   * @param {() => Promise<*>} fn - Async function to execute.
   * @param {object} [options={}] - Per-call overrides for maxAttempts, retryOn, timeout.
   * @returns {Promise<*>} The result of fn().
   * @throws {TimeoutError} When an individual attempt exceeds the timeout.
   * @throws {Error} Rethrows the last error when maxAttempts is exhausted or error is not retryable.
   */
  async call(fn, options = {}) {
    const max = options.maxAttempts || this.maxAttempts;
    const retryOn = options.retryOn || this.retryOn;
    const timeout = options.timeout || this.timeout;

    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        const result = await (timeout
          ? Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new TimeoutError('[Retry] Timeout')), timeout))])
          : fn());
        return result;
      } catch (err) {
        if (attempt === max || !retryOn(err)) throw err;
        const delay = this._delay(attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  _delay(attempt) {
    let base;
    if (typeof this.backoff === 'number') {
      base = this.backoff;
    } else if (this.backoff === 'linear') {
      base = attempt * 1000;
    } else {
      base = Math.min(2 ** (attempt - 1) * 1000, 30000); // exponential, cap 30s
    }
    return this._applyJitter(base);
  }

  _applyJitter(base) {
    if (this.jitter === false || this.jitter === 0) return base;
    if (this.jitter === 'full') {
      return Math.floor(Math.random() * base);
    }
    if (this.jitter === 'equal') {
      return Math.floor(base / 2 + Math.random() * (base / 2));
    }
    if (typeof this.jitter === 'number') {
      const spread = base * this.jitter;
      return Math.floor(base - spread + Math.random() * spread);
    }
    return base;
  }
}

module.exports = { Retry };
