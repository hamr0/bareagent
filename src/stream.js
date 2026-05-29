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

/**
 * @typedef {object} StreamEvent
 * @property {string} type - Event type identifier.
 * @property {string} [taskId] - Associated task identifier.
 * @property {*} [data] - Arbitrary event payload.
 * @property {string} [ts] - ISO timestamp; auto-filled on emit if absent.
 */

/**
 * @typedef {object} Transport
 * @property {(event: StreamEvent) => void} write - Sink for emitted events.
 */

/**
 * @typedef {object} StreamOptions
 * @property {Transport|null} [transport] - Optional transport sink for emitted events.
 */

class Stream {
  /**
   * @param {StreamOptions} [options={}]
   */
  constructor(options = {}) {
    /** @type {Transport|null} */
    this._transport = options.transport || null;
    /** @type {Array<(e: StreamEvent) => void>} */
    this._subscribers = [];
  }

  /**
   * @param {StreamEvent} event - Event to broadcast to subscribers and transport.
   * @returns {void}
   */
  emit(event) {
    const full = { ...event, ts: event.ts || new Date().toISOString() };
    for (const fn of this._subscribers) {
      try { fn(full); } catch {}
    }
    if (this._transport) {
      this._transport.write(full);
    }
  }

  /**
   * @param {(e: StreamEvent) => void} callback - Invoked with each emitted event.
   * @returns {() => void} Unsubscribe function.
   */
  subscribe(callback) {
    this._subscribers.push(callback);
    return () => {
      this._subscribers = this._subscribers.filter(fn => fn !== callback);
    };
  }
}

module.exports = { Stream };
