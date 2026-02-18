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
class Memory {
  constructor(options = {}) {
    if (!options.store) throw new Error('Memory requires options.store');
    this._store = options.store;
  }

  store(content, metadata = {}) {
    return this._store.store(content, metadata);
  }

  search(query, options = {}) {
    return this._store.search(query, options);
  }

  get(id) {
    return this._store.get(id);
  }

  delete(id) {
    return this._store.delete(id);
  }
}

module.exports = { Memory };
