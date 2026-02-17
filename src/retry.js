'use strict';

/**
 * Backoff wrapper for async functions.
 *
 * Interface:
 *   call(fn, options)  → result
 *
 * Options:
 *   maxAttempts   — default: 3
 *   backoff       — 'exponential' | 'linear' | number (fixed ms). Default: 'exponential'
 *   timeout       — ms per attempt. Default: 60000
 *   retryOn       — (error) => boolean. Default: HTTP 429/5xx, network errors
 *
 * ~30 lines target.
 */
class Retry {
  constructor(options = {}) {
    // TODO: POC 1
    throw new Error('Not implemented — see POC 1');
  }

  async call(fn, options = {}) {
    throw new Error('Not implemented');
  }
}

module.exports = { Retry };
