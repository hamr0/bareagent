'use strict';

/**
 * JSON file memory store. Zero deps, substring search.
 *
 * Interface (implements Memory store contract):
 *   store(content, metadata)   → id
 *   search(query, options)     → [{ id, content, metadata, score }]
 *   get(id)                    → { content, metadata }
 *   delete(id)                 → void
 *
 * Data format: JSON array in a single file.
 * Search: case-insensitive substring matching (no ranking).
 *
 * Options:
 *   path  — path to JSON file
 *
 * ~40 lines target.
 */
class JsonFileStore {
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

module.exports = { JsonFileStore };
