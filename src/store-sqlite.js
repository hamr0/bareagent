'use strict';

/**
 * SQLite FTS5 memory store. Full-text search with BM25 ranking.
 *
 * Interface (implements Memory store contract):
 *   store(content, metadata)   → id
 *   search(query, options)     → [{ id, content, metadata, score }]
 *   get(id)                    → { content, metadata }
 *   delete(id)                 → void
 *
 * Requires peer dep: better-sqlite3
 *
 * Options:
 *   path  — path to SQLite database file
 *
 * ~100 lines target.
 */
class SQLiteStore {
  constructor(options = {}) {
    // TODO: POC 4
    throw new Error('Not implemented — see POC 4');
  }

  store(content, metadata = {}) {
    throw new Error('Not implemented');
  }

  search(query, options = {}) {
    throw new Error('Not implemented');
  }

  get(id) {
    throw new Error('Not implemented');
  }

  delete(id) {
    throw new Error('Not implemented');
  }
}

module.exports = { SQLiteStore };
