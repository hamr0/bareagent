'use strict';

const { readFileSync, writeFileSync, existsSync } = require('node:fs');

/**
 * JSON file memory store. Zero deps, case-insensitive substring search.
 *
 * Interface (implements Memory store contract):
 *   store(content, metadata)   → id
 *   search(query, options)     → [{ id, content, metadata, score }]
 *   get(id)                    → { content, metadata }
 *   delete(id)                 → void
 */
class JsonFileStore {
  constructor(options = {}) {
    if (!options.path) throw new Error('JsonFileStore requires options.path');
    this._path = options.path;
    this._data = existsSync(this._path)
      ? JSON.parse(readFileSync(this._path, 'utf8'))
      : [];
    this._nextId = this._data.length
      ? Math.max(...this._data.map(d => d.id)) + 1
      : 1;
  }

  _save() {
    writeFileSync(this._path, JSON.stringify(this._data, null, 2));
  }

  store(content, metadata = {}) {
    const id = this._nextId++;
    this._data.push({ id, content, metadata, createdAt: new Date().toISOString() });
    this._save();
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
