'use strict';

const { readFileSync, writeFileSync } = require('fs');
const { EventEmitter } = require('events');

const TRANSITIONS = {
  pending:            { start: 'running', cancel: 'cancelled' },
  running:            { complete: 'done', fail: 'failed', pause: 'waiting_for_input', cancel: 'cancelled' },
  failed:             { retry: 'running', cancel: 'cancelled' },
  waiting_for_input:  { resume: 'running', cancel: 'cancelled' },
  // done and cancelled are terminal
};

class StateMachine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.file = options.file || null;
    this.tasks = new Map();
    if (this.file) this._load();
  }

  /**
   * Transition a task to a new state.
   * @param {string} taskId - Task identifier.
   * @param {string} event - Transition event (start, complete, fail, pause, resume, cancel, retry).
   * @param {*} [data] - Optional data to attach to the task.
   * @returns {string} The new status.
   * @throws {Error} `[StateMachine] Invalid transition` — when the event is not valid for the current state.
   */
  transition(taskId, event, data) {
    let task = this.tasks.get(taskId);
    if (!task) {
      task = { status: 'pending', data: null, error: null, updatedAt: new Date().toISOString() };
      this.tasks.set(taskId, task);
    }

    const allowed = TRANSITIONS[task.status];
    if (!allowed || !allowed[event]) {
      throw new Error(`[StateMachine] Invalid transition: ${task.status} + ${event} (task: ${taskId})`);
    }

    const prev = task.status;
    task.status = allowed[event];
    task.updatedAt = new Date().toISOString();
    if (data !== undefined) task.data = data;
    if (event === 'fail') task.error = data || null;
    if (event === 'complete') task.error = null;

    this.emit('transition', { taskId, from: prev, to: task.status, event, data });
    if (this.file) this._save();
    return task.status;
  }

  getStatus(taskId) {
    return this.tasks.get(taskId) || null;
  }

  onTransition(callback) {
    this.on('transition', callback);
    return () => this.off('transition', callback);
  }

  getAll() {
    const result = {};
    for (const [id, task] of this.tasks) result[id] = { ...task };
    return result;
  }

  _load() {
    try {
      const raw = readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      for (const [id, task] of Object.entries(data)) this.tasks.set(id, task);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  _save() {
    const obj = {};
    for (const [id, task] of this.tasks) obj[id] = task;
    writeFileSync(this.file, JSON.stringify(obj, null, 2) + '\n');
  }
}

module.exports = { StateMachine };
