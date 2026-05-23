'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Memory } = require('../src/memory');
const { JsonFileStore } = require('../src/store-jsonfile');
const { SQLiteStore } = require('../src/store-sqlite');

// --- Memory (wrapper) ---

describe('Memory', () => {
  it('requires a store', () => {
    assert.throws(() => new Memory(), /requires options\.store/);
  });

  it('delegates all methods to store', () => {
    const calls = [];
    const fakeStore = {
      store: (c, m) => { calls.push(['store', c, m]); return 1; },
      search: (q, o) => { calls.push(['search', q, o]); return []; },
      get: (id) => { calls.push(['get', id]); return null; },
      delete: (id) => { calls.push(['delete', id]); },
    };
    const mem = new Memory({ store: fakeStore });
    mem.store('hello', { type: 'test' });
    mem.search('hello', { limit: 5 });
    mem.get(1);
    mem.delete(1);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0], ['store', 'hello', { type: 'test' }]);
    assert.deepEqual(calls[1], ['search', 'hello', { limit: 5 }]);
    assert.deepEqual(calls[2], ['get', 1]);
    assert.deepEqual(calls[3], ['delete', 1]);
  });
});

// --- JsonFileStore ---

describe('JsonFileStore', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires a path', () => {
    assert.throws(() => new JsonFileStore(), /requires options\.path/);
  });

  it('store and get roundtrip', () => {
    const store = new JsonFileStore({ path: join(dir, 'mem.json') });
    const id = store.store('Berlin flights', { type: 'task' });
    assert.equal(typeof id, 'number');
    const item = store.get(id);
    assert.equal(item.content, 'Berlin flights');
    assert.deepEqual(item.metadata, { type: 'task' });
  });

  it('search finds substring matches (case-insensitive)', () => {
    const store = new JsonFileStore({ path: join(dir, 'mem.json') });
    store.store('Lufthansa flight to Berlin €340');
    store.store('Hotel Europa near venue €89/night');
    store.store('Train schedule Munich to Berlin');

    const results = store.search('berlin');
    assert.equal(results.length, 2);
    assert.ok(results[0].content.toLowerCase().includes('berlin'));
  });

  it('search returns all when query is empty', () => {
    const store = new JsonFileStore({ path: join(dir, 'mem.json') });
    store.store('one');
    store.store('two');
    const results = store.search('');
    assert.equal(results.length, 2);
  });

  it('search respects limit', () => {
    const store = new JsonFileStore({ path: join(dir, 'mem.json') });
    for (let i = 0; i < 20; i++) store.store(`item ${i}`);
    const results = store.search('item', { limit: 5 });
    assert.equal(results.length, 5);
  });

  it('delete removes item', () => {
    const store = new JsonFileStore({ path: join(dir, 'mem.json') });
    const id = store.store('to delete');
    store.delete(id);
    assert.equal(store.get(id), null);
  });

  it('warns once about scaling past the large-store threshold', () => {
    const store = new JsonFileStore({ path: join(dir, 'big.json') });
    const orig = console.warn;
    const warnings = [];
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      for (let i = 0; i < 10002; i++) store.store(`x${i}`);
    } finally {
      console.warn = orig;
    }
    assert.equal(warnings.length, 1, 'should warn exactly once');
    assert.match(warnings[0], /SQLiteStore/);
  });

  it('persists across instances', () => {
    const path = join(dir, 'mem.json');
    const store1 = new JsonFileStore({ path });
    const id = store1.store('persistent data', { type: 'kb' });

    const store2 = new JsonFileStore({ path });
    const item = store2.get(id);
    assert.equal(item.content, 'persistent data');
    assert.deepEqual(item.metadata, { type: 'kb' });
  });

  it('get returns null for non-existent id', () => {
    const store = new JsonFileStore({ path: join(dir, 'mem.json') });
    assert.equal(store.get(999), null);
  });
});

// --- SQLiteStore ---

describe('SQLiteStore', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-test-'));
    store = new SQLiteStore({ path: join(dir, 'test.db') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires a path', () => {
    assert.throws(() => new SQLiteStore(), /requires options\.path/);
  });

  it('store and get roundtrip', () => {
    const id = store.store('Berlin flight options', { type: 'task', source: 'search' });
    assert.equal(typeof id, 'number');
    const item = store.get(id);
    assert.equal(item.content, 'Berlin flight options');
    assert.deepEqual(item.metadata, { type: 'task', source: 'search' });
  });

  it('FTS5 search finds relevant results', () => {
    store.store('Lufthansa flight to Berlin for €340 on Tuesday');
    store.store('Hotel Europa, 400m from venue, €89 per night');
    store.store('Train schedule from Munich to Berlin via ICE');
    store.store('Restaurant recommendations in Amsterdam');

    const results = store.search('Berlin');
    assert.ok(results.length >= 2);
    // All results should contain Berlin
    for (const r of results) {
      assert.ok(r.content.toLowerCase().includes('berlin'));
    }
  });

  it('FTS5 search ranks by relevance (BM25)', () => {
    store.store('hotel near venue in Berlin');
    store.store('The hotel is nice. Berlin Berlin Berlin hotel hotel.');
    // The one with more term occurrences should score higher
    const results = store.search('hotel Berlin');
    assert.ok(results.length >= 2);
    assert.ok(results[0].score >= results[1].score);
  });

  it('search returns all when query is empty', () => {
    store.store('one');
    store.store('two');
    const results = store.search('');
    assert.equal(results.length, 2);
  });

  it('search respects limit', () => {
    for (let i = 0; i < 20; i++) store.store(`item number ${i}`);
    const results = store.search('item', { limit: 5 });
    assert.equal(results.length, 5);
  });

  it('delete removes item and FTS index', () => {
    const id = store.store('temporary data to delete');
    store.delete(id);
    assert.equal(store.get(id), null);
    const results = store.search('temporary');
    assert.equal(results.length, 0);
  });

  it('persists across instances', () => {
    const path = join(dir, 'persist.db');
    const store1 = new SQLiteStore({ path });
    const id = store1.store('persistent chunk', { type: 'kb' });
    store1.close();

    const store2 = new SQLiteStore({ path });
    const item = store2.get(id);
    assert.equal(item.content, 'persistent chunk');
    assert.deepEqual(item.metadata, { type: 'kb' });
    store2.close();
  });

  it('get returns null for non-existent id', () => {
    assert.equal(store.get(999), null);
  });

  it('handles special characters in search query', () => {
    store.store('Error: connection refused (ECONNRESET)');
    // Should not throw on special chars
    const results = store.search('connection (refused)');
    assert.ok(Array.isArray(results));
  });
});
