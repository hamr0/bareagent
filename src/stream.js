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
 * Transport:
 *   Object with write(event) method — e.g. JsonlTransport
 *   null — disabled (subscribers only)
 */
class Stream {
  constructor(options = {}) {
    this._transport = options.transport || null;
    this._subscribers = [];
  }

  emit(event) {
    const full = { ...event, ts: event.ts || new Date().toISOString() };
    for (const fn of this._subscribers) {
      try { fn(full); } catch {}
    }
    if (this._transport) {
      this._transport.write(full);
    }
  }

  subscribe(callback) {
    this._subscribers.push(callback);
    return () => {
      this._subscribers = this._subscribers.filter(fn => fn !== callback);
    };
  }
}

module.exports = { Stream };
