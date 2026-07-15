// Verify-shipped-vs-spec — litectx 0.26 `enumerate` against the DoD in docs/01-product/prd.md
// §5. Pure SQL, no model, no API key. Seeds KNOWN fact rows, code-computes ground truth, exits 1 on any miss.
// The same discipline that caught the step-8 scan regression: don't trust that litectx built what was asked —
// prove it. Run: node poc/litectx-enumerate-verify.mjs
import { LiteCtx } from 'litectx';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = mkdtempSync(join(tmpdir(), 'enum-verify-'));
let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); } };

async function drain(ctx, kind, limit) {
  const seen = []; let offset = 0, guard = 0;
  for (;;) {
    const page = await ctx.enumerate({ kind, offset, limit, body: true });
    seen.push(...page.items);
    if (page.nextOffset === null) return { items: seen, total: page.total };
    assert.equal(page.nextOffset, offset + page.items.length, 'nextOffset must be contiguous');
    offset = page.nextOffset;
    if (++guard > 10000) throw new Error('pagination did not terminate');
  }
}

const N = 1000;
const ctx = new LiteCtx({ root, embeddings: true }); // embeddings ON — enumerate must ignore it
const truth = new Set();
for (let i = 0; i < N; i++) { const id = `fact:${i}`; truth.add(id); await ctx.remember(id, `record number ${i} about topic ${i % 7}`, { kind: 'fact' }); }

console.log(`litectx ${new LiteCtx({ root: mkdtempSync(join(tmpdir(), 'v-')) }) && '0.26'} enumerate DoD (seeded ${N} fact rows):`);

// 1) COMPLETENESS + GAPLESS — the load-bearing property. Page small (limit 7) to force many pages.
const walk = await drain(ctx, 'fact', 7);
const seenIds = walk.items.map((it) => it.path);
check('1. exhaustive + gapless: union of all pages === seeded set, no dupes', () => {
  assert.equal(seenIds.length, N, `expected ${N} items, got ${seenIds.length} (dupes or gaps)`);
  const set = new Set(seenIds);
  assert.equal(set.size, N, 'duplicate ids across pages');
  for (const id of truth) assert.ok(set.has(id), `missing ${id}`);
});

// 2) total === count(kind) === actual rows
check('2. total === count({kind}) === N', () => {
  assert.equal(walk.total, N, 'page.total wrong');
  assert.equal(ctx.count({ kind: 'fact' }), N, 'count({kind}) disagrees with enumerate total');
});

// 3) DETERMINISTIC order — two full walks identical (bareagent's multi-pass scan shuffles over a STABLE base)
const walk2 = await drain(ctx, 'fact', 7);
check('3. deterministic stable order across two full walks', () => {
  assert.deepEqual(walk2.items.map((it) => it.path), seenIds);
});

// 4) BODY fidelity — body:true returns the verbatim stored text
check('4. body:true is verbatim stored text', () => {
  const it = walk.items.find((x) => x.path === 'fact:42');
  assert.ok(it && it.body === 'record number 42 about topic 0', `body mismatch: ${it && it.body}`);
});

// 5) why enumerate exists: a recall CAPPED at the realistic KNN_K=8 returns far fewer than enumerate's full
// set — it cannot enumerate/count, which is the whole point (§9.2.1; full magnitude measured live on AG News).
const rec = await ctx.recall('topic 3', { kind: 'fact', n: 8 });
check('5. a capped recall (KNN_K=8) returns << enumerate\'s full set (why enumerate exists)', () => {
  assert.ok(rec.length <= 8, `capped recall should return <= 8, got ${rec.length}`);
  assert.ok(rec.length < N, 'enumerate returns the full set a capped recall structurally cannot');
});

await ctx.close();

// 6) SCOPE isolation — a B-scoped write must be invisible to an A-scoped enumerate
const a = new LiteCtx({ root, owner: 'A' });
const b = new LiteCtx({ root, owner: 'B' });
await b.remember('fact:secretB', 'B-only secret', { kind: 'fact' });
const aWalk = await drain(a, 'fact', 50);
check('6. scope-honoring: A-scoped enumerate never returns B-scoped rows', () => {
  assert.ok(!aWalk.items.some((it) => it.path === 'fact:secretB'), 'B-scoped row leaked into A');
});
await a.close(); await b.close();

rmSync(root, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'PASS — enumerate matches the spec DoD' : `FAIL — ${failures} DoD check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
