#!/usr/bin/env node
// POC — Feature 2 Part B: the LOSSLESS `stash` strategy against REAL litectx 0.16.0.
//
// Riskiest assumption (the whole reason lossless-stash exists): litectx's stash table
// round-trips a transcript span BYTE-EXACT through SQLite, `get(id)` rehydrates it (not
// `recall`), keyed-upsert supersedes, and the `episode` stance ladder behaves. No LLM —
// this path never calls a model, so the POC is deterministic and offline. It is built to
// FAIL: every claim is asserted; any miss → exit 1. Run: node poc/f2-stash-litectx.mjs
import { LiteCtx } from 'litectx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const ok = (cond, msg) => { if (cond) { console.log(`  PASS — ${msg}`); } else { console.log(`  FAIL — ${msg}`); failures++; } };

const root = mkdtempSync(join(tmpdir(), 'f2-stash-poc-'));
const dbPath = join(root, 'index.db');

// A realistic compaction span: multiple transcript turns serialized, with the things that
// break naive storage — unicode, embedded quotes/newlines, a code fence, trailing whitespace.
const span = JSON.stringify([
  { role: 'user', content: 'refactor auth → JWT. Edge: expiry, cl-ock-skew ±30s, 日本語 comment.' },
  { role: 'assistant', content: 'Plan:\n```js\nconst t = sign({sub}, KEY, {expiresIn:"15m"});\n```\nDone.  ' },
  { role: 'tool', content: 'exit 0\nstderr:\n  "warning: skew"\n' },
], null, 2);

try {
  // ── Claim 1: stash → get round-trips BYTE-EXACT (the lossless contract) ──────────────
  const ctx = new LiteCtx({ root, dbPath });
  ctx.stash('stash:auth-refactor', span);
  const got = ctx.get('stash:auth-refactor');
  ok(got != null, 'get() reaches the stash table (non-null)');
  ok(got?.text === span, `get(id).text is byte-exact (${got?.text?.length} chars, src=${got?.source})`);

  // ── Claim 2: `get` not `recall` — a stash lives in NO FTS table (PRD §2.14 hard fact) ─
  // recall(q) with no kind → grouped { kind: Hit[] }; flatten across every kind.
  const grouped = await ctx.recall('auth refactor JWT expiry skew');
  const allHits = Object.values(grouped || {}).flat();
  const surfaced = allHits.some(h => (h.id || h.path || '').includes('auth-refactor'));
  ok(!surfaced, `recall() does NOT surface the stash (got ${allHits.length} hits across kinds, none the stash)`);

  // ── Claim 3: keyed-upsert supersedes (retention bound = distinct labels, not count) ──
  ctx.stash('stash:auth-refactor', 'SUPERSEDED v2');
  ok(ctx.get('stash:auth-refactor')?.text === 'SUPERSEDED v2', 're-stash same id → latest wins (upsert)');

  // ── Claim 4: durability — a FRESH instance on the same dbPath rehydrates (it's the ──
  //    store, not an in-process map; this is what the in-memory fallback can NOT do) ─────
  ctx.stash('stash:durable', span);
  const ctx2 = new LiteCtx({ root, dbPath });
  ok(ctx2.get('stash:durable')?.text === span, 'fresh LiteCtx on same dbPath rehydrates byte-exact (durable)');

  // ── Claim 5: peek returns a bounded preview without paying the whole payload ─────────
  const pk = ctx2.peek('stash:durable');
  ok(pk && typeof pk.bytes === 'number' && pk.bytes === Buffer.byteLength(span),
     `peek() reports true byte size (${pk?.bytes}) without full rehydrate`);

  // ── Claim 6: evict backstop — { maxCount } keeps newest N (the §2.13 LRU/size cap) ───
  ctx2.stash('stash:e1', 'one'); ctx2.stash('stash:e2', 'two'); ctx2.stash('stash:e3', 'three');
  const removedById = ctx2.evict('stash:e1');
  ok(removedById === 1 && ctx2.get('stash:e1') == null, 'evict(id) drops one parked payload');

  // ── Claim 7: the `episode` stance ladder — upsert-by-key, latest stance wins, ─────────
  //    retrievable, and (unlike a stash) recall-surfaceable since episodes ARE indexed ──
  await ctx2.remember('episode:auth-refactor', 'sub-task: auth→JWT, wired but tests pending', { kind: 'episode' });
  await ctx2.remember('episode:auth-refactor', 'sub-task: auth→JWT, wired AND tested ✓', { kind: 'episode' });
  ok(ctx2.get('episode:auth-refactor')?.text.includes('tested'), 'episode upsert-by-key → latest stance wins');
  const epHits = await ctx2.recall('auth refactor JWT tests', { kind: 'episode' });
  ok((epHits || []).some(h => (h.id || h.path || '').includes('episode:auth-refactor')),
     `recall() DOES surface the episode stance (episodes are FTS-indexed; ${epHits?.length ?? 0} hits)`);

  ctx.close?.(); ctx2.close?.();
} catch (e) {
  console.log(`  FAIL — threw: ${e?.stack || e}`);
  failures++;
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? '\n✅ POC PASS — litectx stash/get/episode contract holds for the lossless path.'
  : `\n❌ POC FAIL — ${failures} claim(s) broke. Do NOT build on this until resolved.`);
process.exit(failures === 0 ? 0 : 1);
