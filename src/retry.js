'use strict';

const DEFAULT_RETRY_ON = (err) => {
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
  }

  async call(fn, options = {}) {
    const max = options.maxAttempts || this.maxAttempts;
    const retryOn = options.retryOn || this.retryOn;
    const timeout = options.timeout || this.timeout;

    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        const result = await (timeout
          ? Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' })), timeout))])
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
    if (typeof this.backoff === 'number') return this.backoff;
    if (this.backoff === 'linear') return attempt * 1000;
    return Math.min(2 ** (attempt - 1) * 1000, 30000); // exponential, cap 30s
  }
}

module.exports = { Retry };
