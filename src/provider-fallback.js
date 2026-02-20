'use strict';

class FallbackProvider {
  /**
   * Provider that tries multiple providers in order.
   * @param {Array<object>} providers - Ordered list of providers with generate().
   * @param {object} [options={}]
   * @param {function} [options.shouldFallback] - (error, index) => boolean. Return false to stop.
   * @param {function} [options.onFallback] - (error, fromIndex, toIndex) callback.
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
   * @param {Array<object>} messages
   * @param {Array<object>} [tools=[]]
   * @param {object} [options={}]
   * @returns {Promise<{text: string, toolCalls: Array, usage: object}>}
   * @throws {AggregateError} When all providers fail.
   */
  async generate(messages, tools = [], options = {}) {
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
