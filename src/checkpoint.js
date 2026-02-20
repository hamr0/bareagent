'use strict';

class Checkpoint {
  constructor(options = {}) {
    this.tools = new Set(options.tools || []);
    this.send = options.send || null;
    this.waitForReply = options.waitForReply || null;
    this.shouldAskFn = options.shouldAsk || null; // custom predicate override
  }

  shouldAsk(toolName, args) {
    if (this.shouldAskFn) return this.shouldAskFn(toolName, args);
    return this.tools.has(toolName);
  }

  /**
   * Send a question and wait for a reply.
   * @param {string} question - The approval question to send.
   * @param {object} [context={}] - Context passed to send and waitForReply.
   * @returns {Promise<string|null>} The user's reply, or null.
   * @throws {Error} `[Checkpoint] send and waitForReply callbacks required` — when callbacks are missing.
   */
  async ask(question, context = {}) {
    if (!this.send || !this.waitForReply) {
      throw new Error('[Checkpoint] send and waitForReply callbacks required');
    }
    await this.send(question, context);
    const reply = await this.waitForReply(context);
    return reply ?? null;
  }
}

module.exports = { Checkpoint };
