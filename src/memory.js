'use strict';

/**
 * Persistence + search across turns and sessions.
 *
 * Interface:
 *   store(content, metadata)   → id
 *   search(query, options)     → [{ id, content, metadata, score }]
 *   get(id)                    → { content, metadata }
 *   delete(id)                 → void
 *
 * Options for search:
 *   limit, types, minScore
 *
 * Stores (swappable):
 *   SQLite FTS5 — store-sqlite.js (peer dep: better-sqlite3)
 *   JSON file   — store-jsonfile.js (zero deps)
 *   Bring your own: implement { store, search, get, delete }
 *
 * ~30 lines target (interface + routing to store).
 */
class Memory {
  constructor(options = {}) {
    // TODO: POC 4
    throw new Error('Not implemented — see POC 4');
  }

  async store(content, metadata = {}) {
    throw new Error('Not implemented');
  }

  async search(query, options = {}) {
    throw new Error('Not implemented');
  }

  async get(id) {
    throw new Error('Not implemented');
  }

  async delete(id) {
    throw new Error('Not implemented');
  }
}

module.exports = { Memory };
