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

  async ask(question, context = {}) {
    if (!this.send || !this.waitForReply) {
      throw new Error('Checkpoint: send and waitForReply callbacks required');
    }
    await this.send(question, context);
    const reply = await this.waitForReply(context);
    return reply ?? null;
  }
}

module.exports = { Checkpoint };
