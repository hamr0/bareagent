'use strict';

/**
 * Persistence + search across turns and sessions.
 * Thin wrapper that delegates to a swappable store.
 *
 * Interface:
 *   store(content, metadata)   → id
 *   search(query, options)     → [{ id, content, metadata, score }]
 *   get(id)                    → { content, metadata }
 *   delete(id)                 → void
 *
 * Stores (swappable):
 *   SQLite FTS5 — store-sqlite.js (peer dep: better-sqlite3)
 *   JSON file   — store-jsonfile.js (zero deps)
 *   Bring your own: implement { store, search, get, delete }
 */
/** @typedef {import('../types').Store} Store */

class Memory {
  /**
   * @param {{ store?: Store }} [options] - Store backend (must implement store/search/get/delete).
   * @throws {Error} `[Memory] requires options.store` — when options.store is missing.
   */
  constructor(options = {}) {
    if (!options.store) throw new Error('[Memory] requires options.store');
    /** @type {Store} */
    this._store = options.store;
  }

  /**
   * @param {any} content
   * @param {Record<string, any>} [metadata] - Stored alongside the content; persisted to the backend.
   * @param {Record<string, any>} [opts] - Transient call options (NOT persisted). If `opts.ctx` carries a
   *   Loop-lent `recordMemoryOp` hook, this write is counted against that run's `result.metrics.memory.stored`
   *   (§3.6, opt-in — the write-side mirror of search's `recalls`). `ctx` rides here, never in `metadata`,
   *   precisely because `metadata` is persisted. Memory stays Loop-agnostic: it only calls an optional hook.
   * @returns {any} id
   */
  store(content, metadata = {}, opts = {}) {
    const ctx = opts && opts.ctx;
    if (ctx && typeof ctx.recordMemoryOp === 'function') ctx.recordMemoryOp('stored');
    return this._store.store(content, metadata);
  }

  /**
   * @param {string} query
   * @param {Record<string, any>} [options] - Store search options. If `options.ctx` carries a Loop-lent
   *   `recordMemoryOp` hook, this recall is counted against that run's `result.metrics.memory.recalls`
   *   (§3.6, opt-in — the hook is absent unless the caller threads the run's ctx). Memory stays
   *   Loop-agnostic: it only calls an optional hook, and `ctx` is stripped, never forwarded to the store.
   * @returns {any}
   */
  search(query, options = {}) {
    const { ctx, ...storeOptions } = options || {};
    if (ctx && typeof ctx.recordMemoryOp === 'function') ctx.recordMemoryOp('recalls');
    return this._store.search(query, storeOptions);
  }

  /**
   * @param {any} id
   * @returns {any}
   */
  get(id) {
    return this._store.get(id);
  }

  /**
   * @param {any} id
   * @returns {any}
   */
  delete(id) {
    return this._store.delete(id);
  }
}

module.exports = { Memory };
