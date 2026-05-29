'use strict';

/** @typedef {import('../types').Provider} Provider */
/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').GenerateResult} GenerateResult */

/**
 * @typedef {object} FallbackOptions
 * @property {(error: any, index: number) => boolean} [shouldFallback] - Return false to stop.
 * @property {(error: any, fromIndex: number, toIndex: number) => void} [onFallback] - Callback.
 */

class FallbackProvider {
  /**
   * Provider that tries multiple providers in order.
   * @param {Provider[]} providers - Ordered list of providers with generate().
   * @param {FallbackOptions} [options={}]
   * @throws {Error} `[FallbackProvider] requires at least one provider` — when providers is empty.
   */
  constructor(providers, options = {}) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error('[FallbackProvider] requires at least one provider');
    }
    this.providers = providers;
    this.shouldFallback = options.shouldFallback || (() => true);
    this.onFallback = options.onFallback || null;
  }

  /**
   * Generate using first available provider.
   * @param {Message[]} messages
   * @param {ToolDef[]} [tools=[]]
   * @param {Record<string, any>} [options={}]
   * @returns {Promise<GenerateResult>}
   * @throws {AggregateError} When all providers fail.
   */
  async generate(messages, tools = [], options = {}) {
    /** @type {any[]} */
    const errors = [];

    for (let i = 0; i < this.providers.length; i++) {
      try {
        return await this.providers[i].generate(messages, tools, options);
      } catch (err) {
        errors.push(err);
        if (i < this.providers.length - 1) {
          if (!this.shouldFallback(err, i)) throw err;
          this.onFallback?.(err, i, i + 1);
        }
      }
    }

    throw new AggregateError(errors, '[FallbackProvider] all providers failed');
  }
}

module.exports = { FallbackProvider };
