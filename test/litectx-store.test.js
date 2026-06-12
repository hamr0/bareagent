'use strict';

// RT-3 — litectx-as-Store mount. Proves bareagent's `Memory` + the `Store` socket accommodate
// litectx's `liteCtxAsStore` adapter shape, and that swapping JsonFileStore → litectx is a one-line
// change with the host code untouched (the drop-in promise).
//
// bareagent MUST NOT import litectx (dependency direction is fixed: litectx is the consumer). So this
// test stands in a FAITHFUL in-repo fake of litectx's adapter contract (litectx/src/memory-store.js)
// and asserts bareagent-side behaviour against it. litectx's own 8 tests cover the adapter internals;
// here we verify the SOCKET — that Memory delegates async, never mints/overrides ids, and round-trips
// arbitrary metadata verbatim, so litectx's id-owning, async, sealed-meta adapter drops straight in.
//
// The five reconciliation points (PRD §3.2) the fake encodes, exactly as litectx ships them:
//   #1 the adapter (Store) mints the id — the host never supplies one
//   #2 search returns content via recall({ body: true })
//   #3 arbitrary metadata round-trips through a sealed `meta` passthrough (kind/by are typed columns)
//   #4 un-kinded write defaults to kind:"fact"; metadata.kind overrides
//   #5 search targets ONE kind so scores stay comparable

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Memory } = require('../src/memory');
const { JsonFileStore } = require('../src/store-jsonfile');

// --- faithful stand-in for litectx wrapped by liteCtxAsStore (mirrors litectx/src/memory-store.js) ---
const RESERVED = new Set(['kind', 'by']);

function fakeLiteCtxStore(opts = {}) {
  const defaultKind = opts.kind ?? 'fact';
  // a minimal LiteCtx-shaped backend: typed columns (kind/provenance) + a sealed meta blob per row
  const rows = new Map(); // id -> { id, text, kind, provenance, meta }

  const reassembleMeta = (x) => {
    const md = { ...(x.meta ?? {}) };
    if (x.kind != null) md.kind = x.kind;
    if (x.provenance != null) md.by = x.provenance;
    return md;
  };

  return {
    async store(content, metadata = {}) {
      const kind = typeof metadata.kind === 'string' ? metadata.kind : defaultKind; // #4
      const by = metadata.by;
      const passthrough = {};
      for (const k of Object.keys(metadata)) if (!RESERVED.has(k)) passthrough[k] = metadata[k]; // #3 split
      const id = `${kind}:${randomUUID()}`; // #1 adapter mints id
      rows.set(id, { id, text: content, kind, provenance: by ?? 'agent', meta: Object.keys(passthrough).length ? passthrough : null });
      return id;
    },
    async search(query, options = {}) {
      const kind = typeof options.kind === 'string' ? options.kind : defaultKind; // #5 one kind
      const n = typeof options.limit === 'number' ? options.limit : options.n;
      // toy ranking: substring presence → score by match count; only the targeted kind
      const hits = [];
      for (const r of rows.values()) {
        if (r.kind !== kind) continue;
        const text = String(r.text);
        const idx = text.toLowerCase().indexOf(String(query).toLowerCase());
        if (idx === -1) continue;
        hits.push({ path: r.id, body: text, score: 1 / (1 + idx), kind: r.kind, provenance: r.provenance, meta: r.meta });
      }
      hits.sort((a, b) => b.score - a.score);
      const limited = typeof n === 'number' ? hits.slice(0, n) : hits;
      return limited.map((h) => ({ id: h.path, content: h.body ?? null, metadata: reassembleMeta(h), score: h.score })); // #2 body inline
    },
    get(id) {
      const r = rows.get(id);
      if (!r) return null;
      return { id: r.id, content: r.text, metadata: reassembleMeta(r) };
    },
    delete(id) { rows.delete(id); },
  };
}

// the HOST workflow — written once, run against any Store. This is the code that must NOT change when
// an adopter swaps backends.
async function hostWorkflow(memory) {
  const id = await memory.store('the auth service uses a token bucket rate limiter', { sessionId: 'sess-1', tag: 'arch' });
  const hits = await memory.search('rate limiter');
  const fetched = memory.get(id);
  return { id, hits, fetched };
}

describe('RT-3: litectx-as-Store mount (socket + drop-in)', () => {
  it('Memory delegates async store/search and returns the ADAPTER-minted id (host supplies none, #1)', async () => {
    const mem = new Memory({ store: fakeLiteCtxStore() });
    const id = await mem.store('a durable fact');
    assert.equal(typeof id, 'string');
    assert.match(id, /^fact:/, 'id is minted by the adapter with the default kind prefix, not the host');
  });

  it('round-trips arbitrary metadata verbatim through the sealed passthrough (#3 — the drop-in promise)', async () => {
    const mem = new Memory({ store: fakeLiteCtxStore() });
    const id = await mem.store('content', { sessionId: 'sess-9', tag: 'note', nested: { a: 1 } });
    const got = mem.get(id);
    assert.equal(got.metadata.sessionId, 'sess-9');
    assert.equal(got.metadata.tag, 'note');
    assert.deepEqual(got.metadata.nested, { a: 1 }, 'unknown keys survive the swap, untokenized');
  });

  it('defaults to kind:"fact" and lets metadata.kind override (#4)', async () => {
    const mem = new Memory({ store: fakeLiteCtxStore() });
    const factId = await mem.store('default kind');
    const epId = await mem.store('an episode', { kind: 'episode' });
    assert.match(factId, /^fact:/);
    assert.match(epId, /^episode:/);
    assert.equal(mem.get(factId).metadata.kind, 'fact');
    assert.equal(mem.get(epId).metadata.kind, 'episode');
  });

  it('search returns ranked hits with content inline and comparable single-kind scores (#2/#5)', async () => {
    const mem = new Memory({ store: fakeLiteCtxStore() });
    await mem.store('rate limiter at the edge', { tag: 'a' });
    await mem.store('rate limiter token bucket', { tag: 'b' });
    await mem.store('unrelated note about caching', { tag: 'c' });
    await mem.store('an episode mentioning rate limiter', { kind: 'episode' }); // different kind → excluded
    const hits = await mem.search('rate limiter');
    assert.equal(hits.length, 2, 'only the default fact kind is searched (scores comparable, #5)');
    for (const h of hits) {
      assert.ok(typeof h.content === 'string' && h.content.includes('rate limiter'), 'body returned inline (#2)');
      assert.equal(typeof h.score, 'number');
      assert.ok(h.id && h.metadata, 'projected to { id, content, metadata, score }');
    }
  });

  it('delete removes the record (→ forget)', async () => {
    const mem = new Memory({ store: fakeLiteCtxStore() });
    const id = await mem.store('temporary');
    assert.ok(mem.get(id));
    mem.delete(id);
    assert.equal(mem.get(id), null);
  });
});

describe('RT-3: drop-in equivalence — same host code, two backends', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rt3-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('the identical hostWorkflow runs unchanged against JsonFileStore AND the litectx adapter', async () => {
    const jsonResult = await hostWorkflow(new Memory({ store: new JsonFileStore({ path: join(dir, 'mem.json') }) }));
    const liteResult = await hostWorkflow(new Memory({ store: fakeLiteCtxStore() }));

    // both backends honour the SAME socket contract — the host never branched on backend type
    for (const r of [jsonResult, liteResult]) {
      assert.ok(r.id != null, 'store returned an id');
      assert.ok(Array.isArray(r.hits), 'search returned an array');
      assert.ok(r.hits.length >= 1, 'the stored content was found');
      const top = r.hits[0];
      assert.ok('id' in top && 'content' in top && 'metadata' in top && 'score' in top, 'hit shape { id, content, metadata, score }');
      assert.equal(r.fetched.content, 'the auth service uses a token bucket rate limiter', 'get returns the body');
      assert.equal(r.fetched.metadata.sessionId, 'sess-1', 'get round-trips host metadata');
    }
  });
});
