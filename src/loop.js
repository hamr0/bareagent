'use strict';

/**
 * Core agent loop: think → act → observe → repeat.
 *
 * Interface:
 *   run(messages, tools, options)  → { text, toolCalls, usage, error }
 *   chat(text, tools)             → { text, toolCalls, usage, error }  (stateful)
 *   runGoal(goal, tools)          → { text, steps, error }  (with planner)
 *   stop()                        → abort mid-loop
 *
 * Options:
 *   provider      — LLM provider instance (required)
 *   maxRounds     — max tool-calling iterations (default: 5)
 *   system        — system prompt string
 *   checkpoint    — Checkpoint instance (optional)
 *   retry         — Retry instance (optional)
 *   stream        — Stream instance (optional)
 *   planner       — Planner instance (optional, for runGoal)
 *   state         — StateMachine instance (optional, for runGoal)
 *   memory        — Memory instance (optional)
 *   onToolCall    — callback before each tool execution
 *   onText        — callback when LLM emits text
 *   onError       — callback on failure
 *
 * ~90 lines target.
 */
class Loop {
  constructor(options = {}) {
    // TODO: POC 1
    throw new Error('Not implemented — see POC 1');
  }

  async run(messages, tools, options = {}) {
    throw new Error('Not implemented');
  }

  async chat(text, tools, options = {}) {
    throw new Error('Not implemented');
  }

  async runGoal(goal, tools, options = {}) {
    throw new Error('Not implemented');
  }

  stop() {
    throw new Error('Not implemented');
  }
}

module.exports = { Loop };
