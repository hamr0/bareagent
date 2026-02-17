'use strict';

/**
 * Goal → step DAG via LLM structured output.
 *
 * Interface:
 *   plan(goal, context)  → [{ id, action, dependsOn: [], status: 'pending' }]
 *
 * The LLM does the planning. This component is the prompt + JSON parsing.
 *
 * Options:
 *   provider  — LLM provider instance (required)
 *   prompt    — override the default planning prompt
 *
 * ~60 lines target.
 */
class Planner {
  constructor(options = {}) {
    // TODO: POC 2
    throw new Error('Not implemented — see POC 2');
  }

  async plan(goal, context = {}) {
    throw new Error('Not implemented');
  }
}

module.exports = { Planner };
