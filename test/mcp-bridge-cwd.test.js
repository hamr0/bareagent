'use strict';

// Bridge-level `cwd`: sets the start folder of every spawned MCP server (sibling of passEnv).
// Drives the REAL bridge + the real mock MCP server, which appends its process.cwd() to MOCK_CWD_FILE.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { join, relative } = require('node:path');
const { writeFileSync, readFileSync, mkdtempSync, realpathSync, rmSync, existsSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { createMCPBridge, listServerTools } = require('../src/mcp-bridge');
const { ValidationError } = require('../src/errors');

const MOCK_SERVER = join(__dirname, 'fixtures', 'mock-mcp-server.js');

describe('MCP bridge cwd', () => {
  let dir, A, B, aFile, n = 0, warnBefore;

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-cwd-')));
    A = join(dir, 'A'); B = join(dir, 'B');
    mkdirSync(A); mkdirSync(B);
    aFile = join(dir, 'afile'); writeFileSync(aFile, 'x');
    warnBefore = console.warn;
    console.warn = () => {};
  });
  after(() => {
    console.warn = warnBefore;
    rmSync(dir, { recursive: true, force: true });
  });

  // A fresh server def + record of the cwd every spawn saw.
  function mk(defCwd) {
    const id = ++n;
    const cwdFile = join(dir, `cwd${id}.txt`);
    const cfg = join(dir, `servers${id}.json`);
    writeFileSync(cfg, JSON.stringify({
      mcpServers: { s: { command: process.execPath, args: [MOCK_SERVER], env: { MOCK_CWD_FILE: cwdFile }, ...(defCwd ? { cwd: defCwd } : {}) } },
    }));
    return {
      cfg, bridgePath: join(dir, `b${id}.json`),
      cwds: () => (existsSync(cwdFile) ? readFileSync(cwdFile, 'utf8').trim().split('\n') : []),
    };
  }

  const modes = {
    bulk: { spawns: 2, run: async (m, extra) => { // cold run: discovery pass + main pass
      const b = await createMCPBridge({ configPaths: [m.cfg], confirmServer: () => true, bridgePath: m.bridgePath, timeout: 5000, ...extra });
      await b.close();
    } },
    allow: { spawns: 1, run: async (m, extra) => {
      const b = await createMCPBridge({ configPaths: [m.cfg], confirmServer: () => true, allow: { s: ['read_file'] }, timeout: 5000, ...extra });
      await b.close();
    } },
    list: { spawns: 1, run: async (m, extra) => {
      await listServerTools({ server: 's', configPaths: [m.cfg], confirmServer: () => true, timeout: 5000, ...extra });
    } },
  };

  for (const [mode, { spawns, run }] of Object.entries(modes)) {
    describe(`mode: ${mode}`, () => {
      it('unset cwd: child starts in process.cwd() (negative control)', async () => {
        const m = mk();
        await run(m, {});
        assert.deepEqual(m.cwds(), Array(spawns).fill(process.cwd()));
      });
      it('bridge cwd reaches EVERY spawn', async () => {
        const m = mk();
        await run(m, { cwd: A });
        assert.deepEqual(m.cwds(), Array(spawns).fill(A));
      });
      it("a server's own def.cwd wins", async () => {
        const m = mk(B);
        await run(m, { cwd: A });
        assert.deepEqual(m.cwds(), Array(spawns).fill(B));
      });
    });
  }

  describe('bulk persisted config', () => {
    it('main pass (warm config, no discovery) gets the bridge cwd', async () => {
      const m = mk();
      await modes.bulk.run(m, { cwd: A });           // cold: writes .mcp-bridge.json
      const before = m.cwds().length;
      const b = await createMCPBridge({ configPaths: [m.cfg], confirmServer: () => true, bridgePath: m.bridgePath, timeout: 5000, cwd: B });
      await b.close();
      assert.deepEqual(m.cwds().slice(before), [B], 'warm run = main pass only');
    });
    it('cwd is absent from the written .mcp-bridge.json (def.cwd still persisted)', async () => {
      const m = mk(B);
      await modes.bulk.run(m, { cwd: A });
      const raw = readFileSync(m.bridgePath, 'utf8');
      assert.equal(raw.includes(A), false);
      assert.equal(JSON.parse(raw).servers.s.cwd, B);
      const m2 = mk();
      await modes.bulk.run(m2, { cwd: A });
      assert.equal(readFileSync(m2.bridgePath, 'utf8').includes(A), false);
      assert.equal(Object.hasOwn(JSON.parse(readFileSync(m2.bridgePath, 'utf8')).servers.s, 'cwd'), false);
    });
    it('does not move the default bridge path / discovery off process.cwd()', async () => {
      const m = mk();
      const b = await createMCPBridge({ configPaths: [m.cfg], confirmServer: () => true, bridgePath: m.bridgePath, timeout: 5000, cwd: A });
      await b.close();
      assert.equal(existsSync(join(A, '.mcp-bridge.json')), false);
    });
  });

  describe('validation', () => {
    const REL = 'secret-rel-DIR-name';
    const bads = [
      ['missing folder', join(tmpdir(), 'mcp-cwd-SECRETNAME-missing')],
      ['file as folder', () => aFile],
      ['relative path', REL],
      ['relative path that EXISTS (resolves against process.cwd())', () => relative(process.cwd(), A)],
      ['dot', '.'],
      ['~/x', '~/SECRETHOMEDIR'],
      ['empty string', ''],
      ['number', 5],
      ['null', null],
      ['object', { SECRETKEY: 1 }],
    ];
    for (const [label, raw] of bads) {
      for (const [mode, { run }] of Object.entries(modes)) {
        it(`${mode} rejects ${label} before spawning anything`, async () => {
          const bad = typeof raw === 'function' ? raw() : raw;
          const m = mk();
          await assert.rejects(run(m, { cwd: bad }), (e) => {
            assert.ok(e instanceof ValidationError);
            assert.match(e.message, /cwd/);
            if (typeof bad === 'string' && bad !== '') assert.equal(e.message.includes(bad), false, 'value must not be echoed');
            assert.equal(e.message.includes('SECRET'), false);
            assert.equal(e.message.includes(REL), false);
            return true;
          });
          assert.deepEqual(m.cwds(), []);
          assert.equal(existsSync(m.bridgePath), false, 'no bridge config written either');
        });
      }
    }
  });
});
