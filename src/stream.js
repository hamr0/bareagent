'use strict';

/**
 * Structured event streaming for observability and cross-process communication.
 *
 * Interface:
 *   emit(event)            → void
 *   subscribe(callback)    → unsubscribe function
 *
 * Event shape:
 *   { type, taskId, data, ts }
 *
 * Event types:
 *   loop:start, loop:tool_call, loop:tool_result, loop:text, loop:done, loop:error
 *   plan:created, plan:step_start, plan:step_done
 *   task:transition
 *   schedule:job_run, schedule:job_done
 *   checkpoint:ask, checkpoint:reply
 *
 * Transport:
 *   'jsonl'   — one JSON object per line to stdout (default)
 *   'memory'  — in-memory EventEmitter
 *   null      — disabled
 *
 * ~50 lines target.
 */
class Stream {
  constructor(options = {}) {
    // TODO: POC 5
    throw new Error('Not implemented — see POC 5');
  }

  emit(event) {
    throw new Error('Not implemented');
  }

  subscribe(callback) {
    throw new Error('Not implemented');
  }
}

module.exports = { Stream };
