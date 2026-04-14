'use strict';

const { TimeoutError } = require('./errors');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class Checkpoint {
  /**
   * @param {object} options
   * @param {Array<string>} [options.tools] - Tool names that require approval (exact match).
   * @param {Function} [options.shouldAsk] - Custom predicate `(toolName, args) => bool` — overrides tools list if set.
   * @param {Function} options.send - Async `(question, context) => void` to deliver the question.
   * @param {Function} options.waitForReply - Async `(context) => string` that resolves with the user's reply.
   * @param {number} [options.timeout=300000] - Ms to wait before auto-denying. 0 disables.
   */
  constructor(options = {}) {
    this.tools = new Set(options.tools || []);
    this.send = options.send || null;
    this.waitForReply = options.waitForReply || null;
    this.shouldAskFn = options.shouldAsk || null;
    this.timeout = options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT_MS;
  }

  shouldAsk(toolName, args) {
    if (this.shouldAskFn) return this.shouldAskFn(toolName, args);
    return this.tools.has(toolName);
  }

  /**
   * Send a question and wait for a reply. Rejects with TimeoutError if `timeout` ms elapse
   * without a reply — the Loop catches this, auto-denies the tool call, and routes the
   * error through loop:error + onError. No silent hangs.
   * @param {string} question - The approval question to send.
   * @param {object} [context={}] - Context passed to send and waitForReply.
   * @returns {Promise<string|null>} The user's reply, or null.
   * @throws {Error} `[Checkpoint] send and waitForReply callbacks required` — when callbacks are missing.
   * @throws {TimeoutError} When no reply arrives within `timeout` ms.
   */
  async ask(question, context = {}) {
    if (!this.send || !this.waitForReply) {
      throw new Error('[Checkpoint] send and waitForReply callbacks required');
    }
    await this.send(question, context);
    const waitPromise = Promise.resolve(this.waitForReply(context));
    if (!this.timeout || this.timeout <= 0) {
      const reply = await waitPromise;
      return reply ?? null;
    }
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`[Checkpoint] no reply within ${this.timeout}ms — auto-denied`, {
          context: { tool: context?.tool, timeout: this.timeout },
        })),
        this.timeout,
      );
    });
    try {
      const reply = await Promise.race([waitPromise, timeoutPromise]);
      return reply ?? null;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { Checkpoint };
