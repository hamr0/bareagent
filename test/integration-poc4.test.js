'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Memory } = require('../src/memory');
const { SQLiteStore } = require('../src/store-sqlite');
const { JsonFileStore } = require('../src/store-jsonfile');
const { Loop } = require('../src/loop');
const { OpenAIProvider } = require('../src/provider-openai');
const { AnthropicProvider } = require('../src/provider-anthropic');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// SQLiteStore is an optional backend that requires better-sqlite3 (not a
// declared dependency). Skip its suite when the driver isn't installed
// (e.g. a minimal CI install) — mirrors the API-key-gated suites below.
let SQLITE_AVAILABLE = true;
try { require('better-sqlite3'); } catch { SQLITE_AVAILABLE = false; }

// Chunks simulating a multi-turn agent session
const CHUNKS = [
  { content: 'User asked about flights to Berlin. Found 3 options: Lufthansa €340, Ryanair €89, EasyJet €120.', metadata: { type: 'task', source: 'flight_search' } },
  { content: 'Hotel Europa is 400m from the venue, €89 per night, 4.2 stars. Breakfast included.', metadata: { type: 'task', source: 'hotel_search' } },
  { content: 'User prefers window seats and vegetarian meals on flights.', metadata: { type: 'preference', source: 'conversation' } },
  { content: 'Conference schedule: Day 1 keynote at 9am, workshops 2-5pm. Day 2 talks 10am-4pm.', metadata: { type: 'kb', source: 'document' } },
  { content: 'Train from Berlin Hauptbahnhof to venue takes 15 minutes. U-Bahn line U2.', metadata: { type: 'kb', source: 'research' } },
  { content: 'Budget for the trip is maximum €800 total including flights, hotel, and food.', metadata: { type: 'preference', source: 'conversation' } },
];

describe('Memory + SQLiteStore integration', { skip: SQLITE_AVAILABLE ? false : 'better-sqlite3 not installed (optional backend)' }, () => {
  let dir, memory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-int-'));
    const store = new SQLiteStore({ path: join(dir, 'test.db') });
    memory = new Memory({ store });
    for (const chunk of CHUNKS) {
      memory.store(chunk.content, chunk.metadata);
    }
  });

  afterEach(() => {
    memory._store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('FTS5 finds hotel info', () => {
    const results = memory.search('hotel venue');
    assert.ok(results.length >= 1);
    assert.ok(results[0].content.includes('Hotel Europa'));
  });

  it('FTS5 finds flight info', () => {
    const results = memory.search('flight Berlin');
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.content.includes('Lufthansa')));
  });

  it('FTS5 finds user preferences', () => {
    const results = memory.search('vegetarian');
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes('window seats'));
  });

  it('FTS5 finds transport info', () => {
    const results = memory.search('train venue');
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.content.includes('U-Bahn')));
  });

  it('survives process restart (persistence)', () => {
    const dbPath = join(dir, 'persist.db');
    const store1 = new SQLiteStore({ path: dbPath });
    const mem1 = new Memory({ store: store1 });
    mem1.store('secret handshake info', { type: 'kb' });
    store1.close();

    const store2 = new SQLiteStore({ path: dbPath });
    const mem2 = new Memory({ store: store2 });
    const results = mem2.search('secret handshake');
    assert.equal(results.length, 1);
    assert.ok(results[0].content.includes('secret handshake'));
    store2.close();
  });
});

describe('Memory + JsonFileStore integration', () => {
  let dir, memory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-int-'));
    const store = new JsonFileStore({ path: join(dir, 'mem.json') });
    memory = new Memory({ store });
    for (const chunk of CHUNKS) {
      memory.store(chunk.content, chunk.metadata);
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('substring search finds hotel info', () => {
    const results = memory.search('hotel');
    assert.ok(results.length >= 1);
    assert.ok(results[0].content.includes('Hotel Europa'));
  });

  it('substring search finds budget info', () => {
    const results = memory.search('budget');
    assert.ok(results.length >= 1);
    assert.ok(results[0].content.includes('€800'));
  });

  it('survives process restart (persistence)', () => {
    const filePath = join(dir, 'persist.json');
    const store1 = new JsonFileStore({ path: filePath });
    const mem1 = new Memory({ store: store1 });
    mem1.store('persistent note', { type: 'kb' });

    const store2 = new JsonFileStore({ path: filePath });
    const mem2 = new Memory({ store: store2 });
    const results = mem2.search('persistent');
    assert.equal(results.length, 1);
  });
});

// Integration with Loop + LLM: store context, use it to answer a question
describe('Memory + Loop + OpenAI', { skip: !OPENAI_API_KEY }, () => {
  let dir, memory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-int-'));
    const store = new SQLiteStore({ path: join(dir, 'test.db') });
    memory = new Memory({ store });
    for (const chunk of CHUNKS) {
      memory.store(chunk.content, chunk.metadata);
    }
  });

  afterEach(() => {
    memory._store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('LLM uses memory search results to answer a question', async () => {
    const provider = new OpenAIProvider({
      apiKey: OPENAI_API_KEY,
      model: 'gpt-4o-mini',
    });

    // Search memory for relevant context
    const context = memory.search('hotel');
    const contextStr = context.map(c => c.content).join('\n');

    const loop = new Loop({ provider });
    const result = await loop.run([
      { role: 'system', content: `You have the following context:\n${contextStr}\nAnswer concisely.` },
      { role: 'user', content: 'What hotel was found and how much does it cost per night?' },
    ], []);

    assert.ok(result.text.includes('Europa') || result.text.includes('89'));
  });
});

describe('Memory + Loop + Anthropic', { skip: !ANTHROPIC_API_KEY }, () => {
  let dir, memory;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bareagent-int-'));
    const store = new SQLiteStore({ path: join(dir, 'test.db') });
    memory = new Memory({ store });
    for (const chunk of CHUNKS) {
      memory.store(chunk.content, chunk.metadata);
    }
  });

  afterEach(() => {
    memory._store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('LLM uses memory search results to answer a question', async () => {
    const provider = new AnthropicProvider({
      apiKey: ANTHROPIC_API_KEY,
      model: 'claude-haiku-4-5-20251001',
    });

    // Search memory for relevant context
    const context = memory.search('budget flight');
    const contextStr = context.map(c => c.content).join('\n');

    const loop = new Loop({ provider });
    const result = await loop.run([
      { role: 'system', content: `You have the following context:\n${contextStr}\nAnswer concisely.` },
      { role: 'user', content: 'What is the cheapest flight option and does it fit the budget?' },
    ], []);

    assert.ok(result.text, 'LLM should return a text response');
    // LLM should reference the flight prices or budget from context
    assert.ok(
      result.text.includes('89') || result.text.includes('Ryanair') || result.text.includes('800') || result.text.includes('budget'),
      `LLM should reference context data. Got: ${result.text.slice(0, 200)}`
    );
  });
});
