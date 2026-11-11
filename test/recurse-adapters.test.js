'use strict';

// The recurse adapters (buildScanTool/buildSearchTool/buildExactTool/litectxCorpus), now at bare-agent/recurse-adapters.
// Moved verbatim from the v1 recurse tests — only the recurse()-driven cases were dropped (see recurse.test.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { HaltError } = require('../src/errors');
const { Loop } = require('../src/loop');
const { buildExactTool, buildSearchTool, buildScanTool, litectxCorpus, normalizeCorpus, rotate } = require('../src/recurse-adapters');
const { classifySystem } = require('../src/recurse-prompts');

const lastUser = (messages) => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content || ''; return ''; };
const systemOf = (messages) => (messages.find(m => m.role === 'system') || {}).content || '';

function scriptedProvider(handler, { model = 'stub-model', name = 'stub' } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      model, name,
      async generate(messages, tools, options) {
        calls.push({ messages: messages.map(m => ({ role: m.role, content: m.content })), tools: (tools || []).map(t => t.name), options });
        const r = (await handler(messages, tools, options, calls.length - 1)) || {};
        return { text: r.text || '', toolCalls: r.toolCalls || [], usage: r.usage || { inputTokens: 5, outputTokens: 3 }, model };
      },
    },
  };
}

// A fake litectx exposing ONLY `enumerate` (the slice-source contract recurse depends on — NOT the whole
// litectx API), paging a known fact set. Mirrors litectx 0.26's verified shape: items carry `.path` (the id)
// and `.body`; `nextOffset` is null past the last row; `total` is the full count.
function fakeLitectx(rows) {
  const lc = {
    calls: 0,
    enumerate({ kind, offset = 0, limit = 100 }) {
      lc.calls++;
      const items = rows.slice(offset, offset + limit).map((r) => ({ path: r.id, body: r.text }));
      const nextOffset = offset + items.length < rows.length ? offset + items.length : null;
      return Promise.resolve({ items, total: rows.length, offset, nextOffset });
    },
  };
  return lc;
}

const isClassify = (messages) => systemOf(messages).includes('precise classifier');
const SCAN_TASK = 'how many of these records match?'; // 'how many' → completeness ask

// A scan corpus of N records, even ids matching ('MATCH'), odd not — so the truth count is known to CODE.
function corpusOf(n, { allMatch = false } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    text: allMatch ? `MATCH item ${i}` : (i % 2 === 0 ? `MATCH item ${i}` : `plain item ${i}`),
  }));
}

// The scripted scan judge: parses the items it was SHOWN, returns the ids whose text contains 'MATCH'.
// Knobs simulate the failure modes the mechanism must survive:
//   hallucinate  — also emit a foreign id never shown (must be dropped by the RC-2 intersect)
//   tailMiss     — drop the LAST item of each window (simulates tail under-recall the multi-pass union fixes)
//   deadWindowAt — the Nth classify call faults (plain error) → a DEAD window (RC-9)
function scanJudge({ hallucinate = false, tailMiss = false, deadWindowAt = null } = {}) {
  let seen = 0;
  return (messages) => {
    if (!isClassify(messages)) return { text: 'none' };
    const idx = seen++;
    if (deadWindowAt != null && idx === deadWindowAt) throw new Error('provider boom');
    const items = [];
    for (const line of lastUser(messages).split('\n')) {
      const m = line.match(/^(\S+) => (.*)$/); // shipped display format: `<id> => <text>`
      if (m) items.push({ id: m[1], text: m[2] });
    }
    let matched = items.filter((it) => /MATCH/.test(it.text));
    if (tailMiss && items.length) {
      const lastId = items[items.length - 1].id;
      matched = matched.filter((it) => it.id !== lastId);
    }
    const ids = matched.map((it) => it.id);
    if (hallucinate) ids.push('r999'); // never shown in any window → must be intersected away
    return { text: ids.length ? ids.join(', ') : 'none' };
  };
}

describe('recurse-adapters — helper units (mutation points)', () => {
  it('normalizeCorpus drops malformed entries (a non-string id/text can neither be judged nor counted)', () => {
    const out = normalizeCorpus([{ id: 'a', text: 'x' }, { id: 1, text: 'y' }, { id: 'b' }, null, { id: 'c', text: 'z' }]);
    assert.deepEqual(out.map((r) => r.id), ['a', 'c']);
  });

  it('buildExactTool is a deterministic AND-term filter over the corpus (embeddings-free, complete)', async () => {
    const tool = buildExactTool([{ id: 'a', text: 'alpha beta' }, { id: 'b', text: 'alpha gamma' }, { id: 'c', text: 'delta' }]);
    assert.match(await tool.execute({ terms: 'alpha' }), /^a: alpha beta\nb: alpha gamma$/);
    assert.equal(await tool.execute({ terms: 'alpha beta' }), 'a: alpha beta'); // AND: both terms required
    assert.equal(await tool.execute({ terms: 'zeta' }), 'no matches');
    assert.match(await tool.execute({ terms: '' }), /requires/);
  });

  it('buildSearchTool caps recall and never returns the whole corpus (KNN_K)', async () => {
    let capturedN = null;
    const litectx = { recall: async (_q, opts) => { capturedN = opts.n; return { fact: [{ path: 'f', body: 'b' }], episode: [] }; } };
    const tool = buildSearchTool(litectx);
    const r = await tool.execute({ query: 'x' });
    assert.equal(capturedN, 8, 'recall is capped at KNN_K=8 (cannot count)');
    assert.match(r, /\[fact\] f: b/);
  });

  it('classifySystem keeps the §9.2-validated wording, forbids a model count, and pins ids unambiguously', () => {
    const s = classifySystem('SPORTS news');
    assert.match(s, /Examine EACH item individually/);
    assert.match(s, /No count, no prose/);
    assert.match(s, /PREDICATE: SPORTS news/);
    // step-8 finding: a colon-ambiguous id instruction silently under-recalled (0.93→0.29); the fix is an
    // unambiguous ` => ` delimiter + a VERBATIM-copy instruction that keeps colon-bearing ids whole.
    assert.match(s, /VERBATIM/);
    assert.match(s, /=> /);
  });

  it('rotate is a deterministic boundary shift (no RNG) — same input ⇒ same output', () => {
    assert.deepEqual(rotate([1, 2, 3, 4, 5], 2), [3, 4, 5, 1, 2]);
    assert.deepEqual(rotate([1, 2, 3, 4, 5], 2), [3, 4, 5, 1, 2]);
    assert.deepEqual(rotate([], 3), []);
  });

  it('buildScanTool wraps the full scan into a per-query tool: CODE-counted head + matching-id evidence', async () => {
    const sp = scriptedProvider(scanJudge()); // matches 'MATCH' in shown items
    const tool = buildScanTool(corpusOf(6), { provider: sp.provider, window: 3, passes: 1 }); // 3 even-id matches
    const r = await tool.execute({ predicate: 'records containing MATCH' });
    assert.match(r, /^count=3 \(scanned 6 records, window=3, passes=1\)/, 'the head is the CODE-counted total (not a model number)');
    assert.match(r, /matching ids: r0, r2, r4/, 'the matching ids are returned as evidence');
    assert.match(await tool.execute({ predicate: '' }), /requires a non-empty predicate/, 'an empty predicate is rejected, not scanned');
  });

  it('buildScanTool surfaces a dead window as an explicit FLOOR (RC-9 at the tool boundary), never a clean hole', async () => {
    const sp = scriptedProvider(scanJudge({ deadWindowAt: 0 })); // the first window faults
    const tool = buildScanTool(corpusOf(8), { provider: sp.provider, window: 4, passes: 1 });
    const r = await tool.execute({ predicate: 'records containing MATCH' });
    assert.match(r, /INCOMPLETE/, 'a dead window is flagged, not hidden');
    assert.match(r, /floor, not exact/, 'the count is presented as a floor (the worker must not treat it as exact)');
  });

  it('buildScanTool materializes an async slice-source ONCE (cached) and propagates a HaltError unwrapped', async () => {
    let sourceCalls = 0;
    const source = async () => { sourceCalls++; return corpusOf(4); };
    const ok = scriptedProvider(scanJudge());
    const tool = buildScanTool(source, { provider: ok.provider, window: 2, passes: 1 });
    await tool.execute({ predicate: 'records containing MATCH' });
    await tool.execute({ predicate: 'records containing MATCH' });
    assert.equal(sourceCalls, 1, 'the async source is resolved once and cached (a re-scan reads the same set — RC-3)');

    // A governance HaltError from the inner scan must PROPAGATE out of execute (the Loop turns it into a clean
    // halt), never be swallowed into a ToolError (the 0.18.0 tool-execute invariant).
    const onLlmResult = () => { throw new HaltError('budget exhausted', { rule: 'budget' }); };
    const halting = buildScanTool(corpusOf(4), { provider: scriptedProvider(scanJudge()).provider, window: 2, passes: 1, onLlmResult });
    await assert.rejects(() => halting.execute({ predicate: 'records containing MATCH' }), (e) => e instanceof HaltError);
  });
});

describe('litectxCorpus (enumerate slice-source)', () => {
  it('litectxCorpus pages through EVERY row via enumerate and maps path→id, body→text', async () => {
    const lc = fakeLitectx(corpusOf(20)); // 20 rows
    const source = litectxCorpus(lc, { kind: 'fact', pageSize: 7 });
    const slices = await source();
    assert.equal(slices.length, 20, 'every row materialized across pages (no early stop)');
    assert.equal(lc.calls, 3, `paginated EXACTLY ⌈20/7⌉=3 calls, got ${lc.calls}`); // catches BOTH under-pagination (1 call → 7 rows) AND wasteful over-pagination (an extra empty end-probe)
    assert.deepEqual(slices[4], { id: 'r4', text: 'MATCH item 4' }, 'path→id and body→text mapping');
  });
});

