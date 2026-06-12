// examples/litectx-mcp-child.mjs
//
// RT-4 — give a child/sub-agent litectx memory, READ-ONLY, on its own db (own-db isolation).
//
// Run:  node examples/litectx-mcp-child.mjs [--root <indexed-litectx-root>]
//       Prints the curated .mcp-bridge.json always; launches the real mount if `litectx-mcp` is on
//       PATH (`npm install -g litectx`), otherwise prints the one-line recipe and exits 0.
//
// What this demonstrates:
//   - `liteCtxMcpBridgeConfig({ root })` builds the curated bridge config: the read-only default
//     (recall/get/impact/recent allow; remember/forget/index/promotions deny) so a child can reason
//     over memory but can't mutate durable shared state. Flip with `{ writable: true }` to opt a child
//     into writes — which still land in ITS OWN db, never the parent's.
//   - `createMCPBridge` launches `litectx-mcp --root <child-db>` over stdio and exposes only the
//     allowed verbs as bareagent tools. Pass `bridge.tools` to a child Loop.
//   - Isolation is the child's own `--root`, not a shared store — which is what keeps RT-5's scope
//     column deferred. Promotion of a child-learned fact to the parent is an explicit, parent-side
//     `recall`(child db) → `remember`(parent db); never automatic.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createMCPBridge } = require('../src/mcp-bridge');
const { liteCtxMcpBridgeConfig } = require('bare-agent/tools');
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const rootFlag = process.argv.indexOf('--root');
const childRoot = rootFlag !== -1 ? process.argv[rootFlag + 1] : process.cwd();

// 1) Build the curated config — the artifact a parent drops in to compose the child's toolbox.
const cfg = liteCtxMcpBridgeConfig({ root: childRoot });
console.log('Curated .mcp-bridge.json (read-only litectx mount):');
console.log(JSON.stringify(cfg, null, 2));
console.log('\n  allow: recall, get, impact, recent   deny: remember, forget, index, promotions');
console.log('  (writable:true opts into remember/forget — still child-db-local)\n');

// 2) Attempt the real mount. Connects iff `litectx-mcp` is on PATH and the root is an indexed litectx db.
const dir = mkdtempSync(join(tmpdir(), 'litectx-mcp-child-'));
const bridgePath = join(dir, '.mcp-bridge.json');
writeFileSync(bridgePath, JSON.stringify(cfg));
try {
  const bridge = await createMCPBridge({ bridgePath, servers: ['litectx'], timeout: 8000 });
  if (bridge.servers.includes('litectx')) {
    console.log(`[mounted] child tools: ${bridge.tools.map((t) => t.name).join(', ')}`);
    console.log(`[mounted] withheld:    ${bridge.denied.map((d) => d.tool).join(', ')}`);
    // hand bridge.tools to a child Loop here: new Loop({ provider, ... }).run(msgs, bridge.tools)
    await bridge.close();
  } else {
    console.log('[litectx-mcp not on PATH] the mount above is the recipe. To run it live:');
    console.log('    npm install -g litectx           # provides the `litectx-mcp` command');
    console.log(`    litectx-mcp --root ${childRoot}   # (index the root first; see litectx docs)`);
    console.log('  then re-run this example. The parent code never changes.');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
