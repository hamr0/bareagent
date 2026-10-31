'use strict';

// A bad START folder must be labelled as the folder, not blamed on the command (Node reports both
// as ENOENT/EACCES/ENOTDIR). Drives the real bridge + real spawn; no mocks.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { listServerTools } = require('../src/mcp-bridge');
const { ToolError } = require('../src/errors');

const SECRET_DIR = 'SECRETFOLDER';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('MCP spawn failure: bad start folder is labelled as the folder', () => {
  let dir, n = 0;
  before(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-spawn-cwd-'))); });
  after(() => { try { chmodSync(join(dir, 'locked'), 0o755); } catch { /* absent */ } rmSync(dir, { recursive: true, force: true }); });

  const run = (command, defCwd, bridgeCwd) => {
    const cfg = join(dir, `s${++n}.json`);
    writeFileSync(cfg, JSON.stringify({ mcpServers: { s: { command, args: [], ...(defCwd && { cwd: defCwd }) } } }));
    return listServerTools({ server: 's', configPaths: [cfg], confirmServer: () => true, timeout: 3000, ...(bridgeCwd && { cwd: bridgeCwd }) });
  };
  const folderLabel = (code) => `MCP server "s" failed to start: working folder could not be used (${code})`;
  function assertFolder(e, code) {
    assert.ok(e instanceof ToolError);
    assert.equal(e.message, folderLabel(code));
    assert.deepEqual(e.context, { spawnError: true, server: 's', code, cwdFailed: true });
    assert.equal(JSON.stringify([e.message, e.context]).includes(SECRET_DIR), false);
    assert.equal(e.message.includes('node'), false);
  }

  it('missing def.cwd (async ENOENT)', async () => {
    await assert.rejects(run(process.execPath, join(dir, SECRET_DIR, 'nope')), (e) => { assertFolder(e, 'ENOENT'); return true; });
  });

  it('file as def.cwd (sync ENOTDIR throw)', async () => {
    const f = join(dir, `${SECRET_DIR}-file`);
    writeFileSync(f, 'x');
    await assert.rejects(run(process.execPath, f), (e) => { assertFolder(e, 'ENOTDIR'); return true; });
  });

  it('def.cwd without execute permission (EACCES)', { skip: (isRoot && 'root ignores modes') || (process.platform === 'win32' && 'no POSIX modes') }, async () => {
    const d = join(dir, 'locked');
    mkdirSync(d);
    chmodSync(d, 0o000);
    await assert.rejects(run(process.execPath, d), (e) => { assertFolder(e, 'EACCES'); return true; });
  });

  it('bridge-level cwd made unusable after validation', { skip: (isRoot && 'root ignores modes') || (process.platform === 'win32' && 'no POSIX modes') }, async () => {
    const d = join(dir, 'bridge-locked');
    mkdirSync(d);
    chmodSync(d, 0o000);
    try {
      await assert.rejects(run(process.execPath, undefined, d), (e) => { assertFolder(e, 'EACCES'); return true; });
    } finally { chmodSync(d, 0o755); }
  });

  it('missing command with a GOOD cwd keeps the byte-identical command label (no cwdFailed key)', async () => {
    for (const [def, bridge] of [[dir, undefined], [undefined, dir]]) {
      await assert.rejects(run('no-such-cmd-zz', def, bridge), (e) => {
        assert.equal(e.message, 'MCP server "s" failed to start: command "no-such-cmd-zz" (ENOENT)');
        assert.deepEqual(e.context, { spawnError: true, server: 's', code: 'ENOENT' });
        assert.equal('cwdFailed' in e.context, false);
        return true;
      });
    }
  });

  it('missing command with no cwd keeps the old label', async () => {
    await assert.rejects(run('no-such-cmd-zz'), (e) => {
      assert.equal(e.message, 'MCP server "s" failed to start: command "no-such-cmd-zz" (ENOENT)');
      assert.equal('cwdFailed' in e.context, false);
      return true;
    });
  });
});
