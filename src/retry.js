'use strict';

const { TimeoutError } = require('./errors');

/**
 * @typedef {object} RetryOptions
 * @property {number} [maxAttempts=3] - Maximum number of attempts.
 * @property {number|'linear'|'exponential'} [backoff='exponential'] - Backoff strategy or fixed ms.
 * @property {number} [timeout=60000] - Per-attempt timeout in ms (0 to disable).
 * @property {(err: any) => boolean} [retryOn] - Predicate deciding whether to retry an error.
 * @property {boolean|number|'full'|'equal'} [jitter=false] - Jitter strategy.
 */

/** @param {any} err */
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
  /** @param {RetryOptions} [options={}] */
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts !== undefined ? options.maxAttempts : 3;
    this.backoff = options.backoff || 'exponential';
    this.timeout = options.timeout !== undefined ? options.timeout : 60000;
    this.retryOn = options.retryOn || DEFAULT_RETRY_ON;
    this.jitter = options.jitter !== undefined ? options.jitter : false;
  }

  /**
   * Call a function with retry logic.
   * @param {() => Promise<*>} fn - Async function to execute.
   * @param {RetryOptions} [options={}] - Per-call overrides for maxAttempts, retryOn, timeout.
   * @returns {Promise<*>} The result of fn().
   * @throws {TimeoutError} When an individual attempt exceeds the timeout.
   * @throws {Error} Rethrows the last error when maxAttempts is exhausted or error is not retryable.
   */
  async call(fn, options = {}) {
    const max = options.maxAttempts !== undefined ? options.maxAttempts : this.maxAttempts;
    const retryOn = options.retryOn || this.retryOn;
    const timeout = options.timeout !== undefined ? options.timeout : this.timeout;

    for (let attempt = 1; attempt <= max; attempt++) {
      /** @type {NodeJS.Timeout|undefined} */
      let timeoutId;
      try {
        const result = await (timeout
          ? Promise.race([
              fn(),
              new Promise((_, rej) => {
                timeoutId = setTimeout(() => rej(new TimeoutError('[Retry] Timeout')), timeout);
              }),
            ])
          : fn());
        return result;
      } catch (err) {
        if (attempt === max || !retryOn(err)) throw err;
        const delay = this._delay(attempt);
        await new Promise(r => setTimeout(r, delay));
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
  }

  /** @param {number} attempt */
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

  /** @param {number} base */
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
