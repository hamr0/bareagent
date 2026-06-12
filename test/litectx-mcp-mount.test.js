'use strict';

// RT-4 — mount litectx-mcp into a child agent, read-only, on its own db. Drives the REAL MCPBridge
// (src/mcp-bridge.js) through the helper-built config (tools/litectx-mcp.js) against a faithful
// litectx-mcp double (test/fixtures/fake-litectx-mcp.js). Proves the bareagent-owned mechanism with
// zero real-litectx dependency: tool curation, the stdio launch, and own-db isolation. litectx's own
// tests cover the real server; the real swap is `command: 'litectx-mcp'`.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { createMCPBridge } = require('../src/mcp-bridge');
const { liteCtxMcpBridgeConfig, READ_VERBS, WRITE_VERBS, ADMIN_VERBS } = require('../tools/litectx-mcp');

const FAKE = require.resolve('./fixtures/fake-litectx-mcp.js');

// The real `litectx-mcp` is an optional, externally-installed binary (not a dep). Detect it so the
// fixture suite always runs (CI) and the REAL-server suite runs only where litectx is installed —
// same skip discipline as the SQLite suite vs better-sqlite3.
const LITECTX_MCP_AVAILABLE = process.platform !== 'win32' &&
  spawnSync('command', ['-v', 'litectx-mcp'], { shell: true }).status === 0;
// The populated-db e2e also needs the `litectx` CLI to index a temp repo out of band (`index` is
// human/hook-driven — denied to children, so it can't come through the bridge).
const LITECTX_CLI_AVAILABLE = process.platform !== 'win32' &&
  spawnSync('command', ['-v', 'litectx'], { shell: true }).status === 0;

// Build a bridge config that launches the fake via node (the real swap drops `command: 'litectx-mcp'`
// and removes the node-script arg). The helper still owns the curated tool allow/deny + --root.
function configFor(dir, { writable = false } = {}) {
  const childRoot = join(dir, 'child-db-root');
  const cfg = liteCtxMcpBridgeConfig({ root: childRoot, command: process.execPath, args: [], writable });
  // splice the fake script path in front of the helper's `--root <root>` args
  cfg.servers.litectx.args = [FAKE, ...cfg.servers.litectx.args];
  return { cfg, childRoot };
}

describe('RT-4: liteCtxMcpBridgeConfig (the helper)', () => {
  it('encodes the read-only default: read verbs allow, write+admin verbs deny', () => {
    const cfg = liteCtxMcpBridgeConfig({ root: '/tmp/agent-db' });
    const t = cfg.servers.litectx.tools;
    for (const v of READ_VERBS) assert.equal(t[v], 'allow', `${v} should be allow`);
    for (const v of WRITE_VERBS) assert.equal(t[v], 'deny', `${v} should be deny by default`);
    for (const v of ADMIN_VERBS) assert.equal(t[v], 'deny', `${v} should always be deny`);
  });

  it('passes the child root as --root (own-db isolation)', () => {
    const cfg = liteCtxMcpBridgeConfig({ root: '/tmp/agent-db' });
    assert.deepEqual(cfg.servers.litectx.args, ['--root', '/tmp/agent-db']);
  });

  it('writable:true flips remember/forget to allow (admin still denied)', () => {
    const t = liteCtxMcpBridgeConfig({ root: '/tmp/db', writable: true }).servers.litectx.tools;
    assert.equal(t.remember, 'allow');
    assert.equal(t.forget, 'allow');
    assert.equal(t.index, 'deny', 'index stays denied even when writable');
    assert.equal(t.promotions, 'deny', 'promotions stays denied even when writable');
  });

  it('requires a root', () => {
    assert.throws(() => liteCtxMcpBridgeConfig({}), /requires opts\.root/);
  });

  it('defaults the real command to litectx-mcp', () => {
    assert.equal(liteCtxMcpBridgeConfig({ root: '/tmp/db' }).servers.litectx.command, 'litectx-mcp');
  });
});

describe('RT-4: mount through the real MCPBridge (read-only, own-db)', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'rt4-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('exposes exactly the read verbs and denies write/admin verbs', async () => {
    const { cfg } = configFor(dir);
    const bridgePath = join(dir, '.mcp-bridge.json');
    writeFileSync(bridgePath, JSON.stringify(cfg));
    const bridge = await createMCPBridge({ bridgePath, servers: ['litectx'], timeout: 8000 });
    try {
      assert.deepEqual(bridge.servers, ['litectx'], 'connected to the stdio child');
      const toolNames = bridge.tools.map((t) => t.name).sort();
      assert.deepEqual(toolNames, ['litectx_get', 'litectx_impact', 'litectx_recall', 'litectx_recent']);
      const deniedNames = bridge.denied.map((d) => d.tool).sort();
      assert.deepEqual(deniedNames, ['forget', 'index', 'promotions', 'remember']);
      assert.ok(!toolNames.some((n) => /remember|forget|index|promotions/.test(n)), 'no write/admin verb leaked');
    } finally {
      await bridge.close();
    }
  });

  it('an allowed verb round-trips through the stdio child and carries the child-own db root', async () => {
    const { cfg, childRoot } = configFor(dir);
    const bridgePath = join(dir, '.mcp-bridge.json');
    writeFileSync(bridgePath, JSON.stringify(cfg));
    const bridge = await createMCPBridge({ bridgePath, servers: ['litectx'], timeout: 8000 });
    try {
      const recall = bridge.tools.find((t) => t.name === 'litectx_recall');
      assert.ok(recall, 'recall is exposed');
      const raw = await recall.execute({ query: 'rate limiter' });
      const hits = JSON.parse(typeof raw === 'string' ? raw : raw.content[0].text);
      assert.equal(hits.length, 1, 'recall returned a hit');
      assert.equal(hits[0].root, childRoot, 'child ran on its OWN db root (own-db isolation)');
    } finally {
      await bridge.close();
    }
  });

  it('writable:true exposes remember as a callable tool (explicit opt-in, child-db-local)', async () => {
    const { cfg } = configFor(dir, { writable: true });
    const bridgePath = join(dir, '.mcp-bridge-w.json');
    writeFileSync(bridgePath, JSON.stringify(cfg));
    const bridge = await createMCPBridge({ bridgePath, servers: ['litectx'], timeout: 8000 });
    try {
      const names = bridge.tools.map((t) => t.name);
      assert.ok(names.includes('litectx_remember'), 'remember exposed when writable');
      assert.ok(names.includes('litectx_forget'), 'forget exposed when writable');
      assert.ok(!names.includes('litectx_index'), 'index still denied');
    } finally {
      await bridge.close();
    }
  });
});

// The REAL server — drives the actual `litectx-mcp` binary, not the fixture. Skips where litectx isn't
// installed (CI). This is the non-circular proof: bareagent's bridge against litectx itself.
describe('RT-4: mount through the REAL litectx-mcp', { skip: LITECTX_MCP_AVAILABLE ? false : 'litectx-mcp not on PATH' }, () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'rt4-real-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('connects to the real binary read-only, and recall round-trips against it', async () => {
    const childRoot = join(dir, 'child-db');
    const cfg = liteCtxMcpBridgeConfig({ root: childRoot }); // command defaults to the real 'litectx-mcp'
    const bridgePath = join(dir, '.mcp-bridge.json');
    writeFileSync(bridgePath, JSON.stringify(cfg));
    const bridge = await createMCPBridge({ bridgePath, servers: ['litectx'], timeout: 15000 });
    try {
      assert.deepEqual(bridge.servers, ['litectx'], `real litectx-mcp connected (errors=${JSON.stringify(bridge.errors)})`);
      const names = bridge.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['litectx_get', 'litectx_impact', 'litectx_recall', 'litectx_recent'], 'read verbs exposed against the real server');
      assert.deepEqual(bridge.denied.map((d) => d.tool).sort(), ['forget', 'index', 'promotions', 'remember'], 'write/admin denied against the real server');
      const recall = bridge.tools.find((t) => t.name === 'litectx_recall');
      const raw = await recall.execute({ query: 'rate limiter' });
      // structural check: the real server returns a parseable result grouped by kind (empty on a fresh
      // db, but the SHAPE proves a genuine protocol round-trip — not just a truthy value).
      const parsed = JSON.parse(typeof raw === 'string' ? raw : raw.content[0].text);
      assert.ok(parsed && typeof parsed === 'object', 'recall returned a structured result');
      assert.ok(['code', 'doc', 'fact', 'episode'].some((k) => k in parsed) || Array.isArray(parsed),
        'real litectx recall is grouped by kind (code/doc/fact/episode)');
    } finally {
      await bridge.close();
    }
  });
});

// The POPULATED-db e2e — closes the three litectx-behavior residuals the fresh/empty-db suites can't:
//   (3) recall returns REAL hits from an indexed db, (2) writable persistence (remember lands+recalls),
//   (1) two-root physical isolation (childA never sees childB's write). All driven THROUGH the bridge
//   (the curated helper config + createMCPBridge), against the real binary. litectx's own tests cover
//   these as litectx properties; this proves they hold end-to-end through bareagent's mount.
describe('RT-4: populated-db e2e through the REAL litectx-mcp', {
  skip: LITECTX_MCP_AVAILABLE && LITECTX_CLI_AVAILABLE ? false : 'litectx / litectx-mcp not on PATH',
}, () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'rt4-pop-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  // Mount one curated root through the real bridge. `--no-embeddings` keeps recall BM25-only:
  // deterministic + fast, no model download in CI.
  async function mount(root, { writable = false } = {}) {
    const cfg = liteCtxMcpBridgeConfig({ root, writable, args: ['--no-embeddings'] });
    const bridgePath = join(root, '.mcp-bridge.json');
    writeFileSync(bridgePath, JSON.stringify(cfg));
    return createMCPBridge({ bridgePath, servers: ['litectx'], timeout: 15000 });
  }
  const recall = async (bridge, query) => {
    const raw = await bridge.tools.find((t) => t.name === 'litectx_recall').execute({ query });
    return JSON.parse(typeof raw === 'string' ? raw : raw.content[0].text);
  };
  const allHits = (grouped) => Object.values(grouped).flat();

  it('recall returns REAL hits from a populated/indexed db (residual 3)', async () => {
    const indexed = join(dir, 'indexed');
    mkdirSync(indexed, { recursive: true });
    writeFileSync(join(indexed, 'limiter.py'),
      '# token bucket rate limiter\nclass TokenBucketRateLimiter:\n    """Limit requests via a token bucket with refill."""\n    def allow_request(self):\n        return self.tokens >= 1\n');
    execFileSync('litectx', ['index', indexed, '--no-embeddings'], { stdio: 'pipe' }); // out of band

    const bridge = await mount(indexed, { writable: false });
    try {
      const hits = allHits(await recall(bridge, 'rate limiter token bucket'));
      assert.ok(hits.length >= 1, 'recall returned at least one real hit from the indexed db');
      assert.ok(hits.some((h) => h.path === 'limiter.py'), 'the indexed limiter.py surfaced through the bridge');
      assert.ok(bridge.denied.some((d) => d.tool === 'index'), 'index stayed denied to the read-only child');
    } finally {
      await bridge.close();
    }
  });

  it('writable child: remember persists and recalls back from its own db (residual 2)', async () => {
    const childB = join(dir, 'childB');
    mkdirSync(childB, { recursive: true });
    const bridge = await mount(childB, { writable: true });
    try {
      const remember = bridge.tools.find((t) => t.name === 'litectx_remember');
      assert.ok(remember, 'writable child exposes litectx_remember');
      await remember.execute({ id: 'note-deploy', text: 'the deploy secret rotation runs every tuesday at 3am UTC', kind: 'fact', by: 'agent' });
      const hits = allHits(await recall(bridge, 'deploy secret rotation'));
      assert.ok(hits.some((h) => h.path === 'note-deploy'), 'the remembered fact persisted and recalled back');
    } finally {
      await bridge.close();
    }
  });

  it('two-root isolation: childA never sees childB\'s write (residual 1)', async () => {
    const childB = join(dir, 'childB-iso');
    const childA = join(dir, 'childA-iso');
    mkdirSync(childB, { recursive: true });
    mkdirSync(childA, { recursive: true });

    const wB = await mount(childB, { writable: true });
    try {
      await wB.tools.find((t) => t.name === 'litectx_remember')
        .execute({ id: 'note-deploy', text: 'the deploy secret rotation runs every tuesday at 3am UTC', kind: 'fact', by: 'agent' });
    } finally {
      await wB.close();
    }

    const aBridge = await mount(childA, { writable: false }); // childA: its OWN, empty root
    try {
      const hits = allHits(await recall(aBridge, 'deploy secret rotation'));
      assert.equal(hits.length, 0, 'childA\'s own-db root contains none of childB\'s writes (physical isolation)');
    } finally {
      await aBridge.close();
    }
  });
});
