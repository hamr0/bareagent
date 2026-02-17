'use strict';

/**
 * Human-in-the-loop: pause execution for approval before irreversible actions.
 *
 * Interface:
 *   shouldAsk(toolName, args)    → boolean
 *   ask(question, context)       → user's reply (string), null = abort
 *
 * Options:
 *   tools         — array of tool names that need approval
 *   send          — (text) => void, how to ask the human
 *   waitForReply  — () => Promise<string>, how to get their answer
 *
 * ~40 lines target.
 */
class Checkpoint {
  constructor(options = {}) {
    // TODO: POC 3
    throw new Error('Not implemented — see POC 3');
  }

  shouldAsk(toolName, args) {
    throw new Error('Not implemented');
  }

  async ask(question, context = {}) {
    throw new Error('Not implemented');
  }
}

module.exports = { Checkpoint };
