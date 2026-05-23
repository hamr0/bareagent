'use strict';

const { readFileSync, writeFileSync, existsSync } = require('node:fs');

// Past this many entries, the O(n) scan + whole-file rewrite per write becomes a
// real latency/availability concern. Warn once (per instance) and point at SQLiteStore.
const LARGE_STORE_THRESHOLD = 10000;

/**
 * JSON file memory store. Zero deps, case-insensitive substring search.
 *
 * SCALING: intended for small memory sets. `search()` is an O(n) substring scan
 * (no index), and every `store()`/`delete()` re-serializes and rewrites the entire
 * file synchronously. Fine for hundreds–low-thousands of entries; for larger or
 * write-heavy memory use SQLiteStore (FTS5 index, parameterized, incremental writes).
 *
 * Interface (implements Memory store contract):
 *   store(content, metadata)   → id
 *   search(query, options)     → [{ id, content, metadata, score }]
 *   get(id)                    → { content, metadata }
 *   delete(id)                 → void
 */
class JsonFileStore {
  /**
   * @param {object} options
   * @param {string} options.path - Path to JSON file (required).
   * @throws {Error} `[JsonFileStore] requires options.path` — when path is missing.
   */
  constructor(options = {}) {
    if (!options.path) throw new Error('[JsonFileStore] requires options.path');
    this._path = options.path;
    this._data = existsSync(this._path)
      ? JSON.parse(readFileSync(this._path, 'utf8'))
      : [];
    this._nextId = this._data.length
      ? this._data.reduce((max, d) => Math.max(max, d.id), 0) + 1
      : 1;
    this._warnedLarge = false;
  }

  _save() {
    writeFileSync(this._path, JSON.stringify(this._data, null, 2));
  }

  store(content, metadata = {}) {
    const id = this._nextId++;
    this._data.push({ id, content, metadata, createdAt: new Date().toISOString() });
    this._save();
    if (!this._warnedLarge && this._data.length > LARGE_STORE_THRESHOLD) {
      this._warnedLarge = true;
      console.warn(
        `[JsonFileStore] ${this._data.length} entries — search is O(n) and every write rewrites ` +
        `the whole file. Switch to SQLiteStore for memory this size.`,
      );
    }
    return id;
  }

  search(query, options = {}) {
    const limit = options.limit || 10;
    const q = (query || '').toLowerCase();
    if (!q) return this._data.slice(0, limit).map(d => ({ ...d, score: 1 }));
    return this._data
      .filter(d => d.content.toLowerCase().includes(q))
      .slice(0, limit)
      .map(d => ({ ...d, score: 1 }));
  }

  get(id) {
    const item = this._data.find(d => d.id === id);
    return item ? { id: item.id, content: item.content, metadata: item.metadata } : null;
  }

  delete(id) {
    this._data = this._data.filter(d => d.id !== id);
    this._save();
  }
}

module.exports = { JsonFileStore };
