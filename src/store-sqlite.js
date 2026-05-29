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
 * @typedef {object} ChunkRow
 * @property {number} id
 * @property {string} content
 * @property {string} metadata - JSON-serialized metadata.
 * @property {number} [rank] - FTS5 rank (search rows only).
 */

class SQLiteStore {
  /**
   * @param {{ path?: string }} [options]
   * @throws {Error} `[SQLiteStore] requires options.path` — when path is missing.
   * @throws {Error} `[SQLiteStore] requires better-sqlite3` — when peer dep is not installed.
   */
  constructor(options = {}) {
    if (!options.path) throw new Error('[SQLiteStore] requires options.path');

    let Database;
    try {
      Database = require('better-sqlite3');
    } catch {
      throw new Error(
        '[SQLiteStore] requires better-sqlite3. Install it: npm install better-sqlite3'
      );
    }

    this._db = new Database(options.path);
    this._db.pragma('journal_mode = WAL');
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        content='chunks',
        content_rowid='id',
        tokenize='porter'
      );
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);

    this._insertStmt = this._db.prepare(
      'INSERT INTO chunks (content, metadata, created_at) VALUES (?, ?, ?)'
    );
    this._getStmt = this._db.prepare(
      'SELECT id, content, metadata FROM chunks WHERE id = ?'
    );
    this._deleteStmt = this._db.prepare('DELETE FROM chunks WHERE id = ?');
    this._searchStmt = this._db.prepare(`
      SELECT chunks.id, chunks.content, chunks.metadata, rank
      FROM chunks_fts
      JOIN chunks ON chunks.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this._allStmt = this._db.prepare(
      'SELECT id, content, metadata FROM chunks ORDER BY id DESC LIMIT ?'
    );
  }

  /**
   * @param {any} content
   * @param {Record<string, any>} [metadata]
   * @returns {number} id
   */
  store(content, metadata = {}) {
    const result = this._insertStmt.run(
      content,
      JSON.stringify(metadata),
      new Date().toISOString()
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * @param {string} query
   * @param {{ limit?: number }} [options]
   * @returns {Array<{ id: number, content: string, metadata: Record<string, any>, score: number }>}
   */
  search(query, options = {}) {
    const limit = options.limit || 10;
    if (!query) {
      return this._allStmt.all(limit).map((/** @type {ChunkRow} */ row) => ({
        id: row.id,
        content: row.content,
        metadata: JSON.parse(row.metadata),
        score: 1,
      }));
    }
    // FTS5 query: wrap each word in quotes for phrase-safe matching
    const ftsQuery = query
      .split(/\s+/)
      .filter(Boolean)
      .map((/** @type {string} */ w) => `"${w.replace(/"/g, '""')}"`)
      .join(' OR ');
    try {
      return this._searchStmt.all(ftsQuery, limit).map((/** @type {ChunkRow} */ row) => ({
        id: row.id,
        content: row.content,
        metadata: JSON.parse(row.metadata),
        score: -(row.rank ?? 0), // FTS5 rank is negative (closer to 0 = better)
      }));
    } catch {
      // If FTS query fails (e.g. special characters), return empty
      return [];
    }
  }

  /**
   * @param {number} id
   * @returns {{ id: number, content: string, metadata: Record<string, any> } | null}
   */
  get(id) {
    const row = /** @type {ChunkRow | undefined} */ (this._getStmt.get(id));
    if (!row) return null;
    return { id: row.id, content: row.content, metadata: JSON.parse(row.metadata) };
  }

  /**
   * @param {number} id
   * @returns {void}
   */
  delete(id) {
    this._deleteStmt.run(id);
  }

  close() {
    this._db.close();
  }
}

module.exports = { SQLiteStore };
