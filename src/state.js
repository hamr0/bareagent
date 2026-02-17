'use strict';

/**
 * Task lifecycle state machine.
 *
 * Interface:
 *   transition(taskId, event)   → newStatus
 *   getStatus(taskId)           → { status, data, updatedAt, error }
 *   onTransition(callback)      → unsubscribe function
 *   getAll()                    → all tasks
 *
 * States:
 *   pending → running → done
 *                    → failed → retrying → running
 *                    → waiting_for_input → running
 *                    → cancelled
 *
 * Events: start, complete, fail, pause, resume, retry, cancel
 *
 * Persistence:
 *   Default: JSON file (tasks.json)
 *   Override: any object with get/set/list methods
 *
 * ~50 lines target.
 */
class StateMachine {
  constructor(options = {}) {
    // TODO: POC 2
    throw new Error('Not implemented — see POC 2');
  }

  transition(taskId, event) {
    throw new Error('Not implemented');
  }

  getStatus(taskId) {
    throw new Error('Not implemented');
  }

  onTransition(callback) {
    throw new Error('Not implemented');
  }

  getAll() {
    throw new Error('Not implemented');
  }
}

module.exports = { StateMachine };
