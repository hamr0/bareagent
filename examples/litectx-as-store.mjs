// examples/litectx-as-store.mjs
//
// RT-3 — mount litectx as a bareagent `Memory` backend (the rich `Store`).
//
// Run:  node examples/litectx-as-store.mjs
//       (zero-dep: runs the JsonFileStore half always; runs the litectx half only if `litectx`
//        is installed — `npm install litectx` — otherwise it prints the one-line swap and skips.)
//
// What this demonstrates:
//   - The `Store` socket (`{ store, search, get, delete }`) is litectx's documented mount point.
//     Swapping the zero-dep JsonFileStore for litectx's ranked, graph-aware recall is a ONE-LINE
//     change — the host code (everything in `hostWorkflow` below) never changes.
//   - litectx ships the adapter (`liteCtxAsStore`); bareagent ships the socket. No bareagent import
//     in litectx, no litectx import in bareagent — the dependency direction stays one-way.
//
// The five points where the schemaless socket and litectx's typed model are reconciled (PRD §3.2),
// all handled INSIDE litectx's adapter — the host never sees them:
//   #1 the adapter mints the id (`kind:uuid`); the host supplies none.
//   #2 `search` returns content inline via `recall({ body: true })`.
//   #3 arbitrary host metadata round-trips through a sealed `meta` passthrough (kind/by are typed).
//   #4 an un-kinded write defaults to `kind:"fact"` (durable agent memory); `metadata.kind` overrides.
//   #5 `search` targets one kind so scores stay comparable across hits.

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { Memory } = require('bare-agent');
const { JsonFile: JsonFileStore } = require('bare-agent/stores');

// --- the HOST workflow: written once, runs against ANY Store. This is the code that does NOT change
//     when you swap the backend. Note `await` works whether the store is sync (JsonFileStore) or
//     async (litectx) — Memory delegates the return value without awaiting. ---
async function hostWorkflow(memory, label) {
  const id = await memory.store(
    'the auth service uses a token-bucket rate limiter on /login',
    { sessionId: 'sess-1', tag: 'architecture' }, // arbitrary metadata — must survive the round-trip
  );
  const hits = await memory.search('rate limiter');
  const fetched = memory.get(id);

  console.log(`\n[${label}]`);
  console.log(`  store() → id: ${id}`);
  console.log(`  search('rate limiter') → ${hits.length} hit(s); top score=${hits[0]?.score?.toFixed?.(3) ?? hits[0]?.score}`);
  console.log(`  get(id).content: ${JSON.stringify(fetched?.content)}`);
  console.log(`  get(id).metadata: ${JSON.stringify(fetched?.metadata)}  ← host metadata round-tripped`);
}

async function main() {
  // 1) Zero-dep baseline: JsonFileStore (always runs).
  const dir = mkdtempSync(join(tmpdir(), 'litectx-as-store-'));
  try {
    await hostWorkflow(new Memory({ store: new JsonFileStore({ path: join(dir, 'mem.json') }) }), 'JsonFileStore (zero-dep)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 2) The ONE-LINE swap to litectx — identical hostWorkflow, ranked graph-aware recall.
  let liteCtxAsStore, LiteCtx;
  try {
    ({ LiteCtx, liteCtxAsStore } = require('litectx')); // both from the main entry (litectx 0.10+)
  } catch {
    console.log('\n[litectx] not installed — the swap is one line:');
    console.log("    import { LiteCtx, liteCtxAsStore } from 'litectx';");
    console.log('    const lc = new LiteCtx({ root: \'./agent-ctx\' }); await lc.ready();');
    console.log('    const memory = new Memory({ store: liteCtxAsStore(lc) });  // ← only this line changes');
    console.log('\n  Install it (`npm install litectx`) to run the litectx half of this example.');
    return;
  }

  // litectx >= 0.21 takes a `root` DIRECTORY (it manages its own files under it), not a `dbPath` file —
  // passing `{ dbPath }` throws on construction. Use a fresh temp dir per run.
  const root = mkdtempSync(join(tmpdir(), `litectx-as-store-${process.pid}-`));
  const lc = new LiteCtx({ root });
  if (typeof lc.ready === 'function') await lc.ready();
  try {
    await hostWorkflow(new Memory({ store: liteCtxAsStore(lc) }), 'litectx (ranked, graph-aware)');
  } finally {
    if (typeof lc.close === 'function') lc.close();
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
