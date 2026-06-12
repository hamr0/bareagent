'use strict';

// RT-4 (spawn boundary) — a CONFIG-driven child process, spawned via spawnChild → bin/cli.js, mounts
// litectx-mcp from `cfg.mcp` and runs a governed loop with those tools, then exits cleanly. This is
// the part the in-process bridge test couldn't reach: the real spawn → cli.js → createMCPBridge chain
// (the gap that became `cfg.mcp` wiring in cli.js). Uses the fixture litectx-mcp (CI-safe) and the
// text-only CLIPipe(`cat`) provider so the child completes a round with no API key. Tool-execution
// against the REAL litectx server is covered by the gated mount test + poc/rt4-spawn-mount-poc.mjs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnChild } = require('../tools/spawn');
const { liteCtxMcpBridgeConfig } = require('../tools/litectx-mcp');

const FAKE = require.resolve('./fixtures/fake-litectx-mcp.js');

describe('RT-4: spawned child mounts litectx-mcp from cfg.mcp', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'rt4-spawn-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('child process mounts the read-only bridge, runs a governed loop, and exits 0', async () => {
    const childRoot = join(dir, 'child-db');
    const mcp = liteCtxMcpBridgeConfig({ root: childRoot, command: process.execPath });
    // launch the fixture via node: command=node, args=[FAKE, --root, <root>]
    mcp.servers.litectx.args = [FAKE, ...mcp.servers.litectx.args];

    const config = {
      provider: 'clipipe',
      command: 'cat',          // echoes the piped prompt back as the (final) assistant text — no key, no tool call
      systemPrompt: 'You are a memory-equipped sub-agent.',
      tools: [],
      mcp,                      // ← the NEW field: mount litectx-mcp read-only on the child's own db
      ungoverned: true,         // keep the test self-contained (gate path covered elsewhere)
      defaultPrompt: 'What do we know about rate limiting?',
    };
    const configPath = join(dir, 'child.json');
    writeFileSync(configPath, JSON.stringify(config));

    const handle = spawnChild({ config: configPath, timeoutMs: 25000 });
    const res = await handle.wait();

    // 1) the child exited cleanly — the mounted MCP grandchild was reaped, no hang
    assert.equal(res.exitCode, 0, `child exited non-zero (error=${res.error})`);

    // 2) the bridge actually mounted INSIDE the spawned child — createMCPBridge's banner surfaces as a
    //    raw stdout event through spawnChild's channel
    const text = res.events.map((e) => e.text || JSON.stringify(e.data || '')).join('\n');
    assert.match(text, /MCP Bridge: \d+ tools? available from 1 server\(s\): litectx/, 'bridge mounted in the child');
    assert.match(text, /litectx: recall, get/, 'read verbs exposed in the child');

    // 3) the child completed a loop with the mounted tools present (didn't break the loop)
    assert.ok(res.events.some((e) => e.type === 'loop:done'), 'child reached loop:done with tools mounted');
  });
});
