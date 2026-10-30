'use strict';

// F109: passEnv restricts which parent env vars reach spawned MCP servers.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { writeFileSync, readFileSync, mkdtempSync, realpathSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { createMCPBridge, listServerTools } = require('../src/mcp-bridge');
const { ValidationError } = require('../src/errors');

const MOCK_SERVER = join(__dirname, 'fixtures', 'mock-mcp-server.js');
const CANARY = 'F109_CANARY_KEY';
const CANARY_VAL = 'sk-canary-value-123';

describe('MCP passEnv (F109)', () => {
  let dir, n = 0, warnBefore, savedCanary, savedOther;

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-passenv-')));
    warnBefore = console.warn;
    console.warn = () => {};
    savedCanary = process.env[CANARY];
    savedOther = process.env.F109_OTHER;
    process.env[CANARY] = CANARY_VAL;
    process.env.F109_OTHER = 'other-val';
  });
  after(() => {
    console.warn = warnBefore;
    for (const [k, v] of [[CANARY, savedCanary], ['F109_OTHER', savedOther]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  let envFile;
  beforeEach(() => { envFile = join(dir, `env${++n}.json`); });

  // Server def runs the real mock MCP server, which dumps its full env to MOCK_ENV_FILE.
  function cfgFor(ownEnv = {}) {
    const cfg = join(dir, `servers${++n}.json`);
    writeFileSync(cfg, JSON.stringify({
      mcpServers: { s: { command: process.execPath, args: [MOCK_SERVER], env: { MOCK_ENV_FILE: envFile, ...ownEnv } } },
    }));
    return cfg;
  }
  // Every spawn appends a line (bulk mode spawns twice: discovery + main). ALL spawns must obey
  // passEnv, so assertions run on each; childEnvs() returns them, childEnv() asserts they agree.
  const childEnvs = () => readFileSync(envFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const childEnv = () => {
    const all = childEnvs();
    assert.ok(all.length >= 1);
    for (const e of all) assert.deepEqual(e, all[0], 'every spawn in this run must see the same env');
    return all[0];
  };
  const bp = () => join(dir, `b${++n}.json`);

  // Each mode spawns the real server and returns after it connected.
  const modes = {
    bulk: async (cfg, extra) => {
      const b = await createMCPBridge({ configPaths: [cfg], confirmServer: () => true, bridgePath: bp(), timeout: 5000, ...extra });
      await b.close();
    },
    allow: async (cfg, extra) => {
      const b = await createMCPBridge({ configPaths: [cfg], confirmServer: () => true, allow: { s: ['read_file'] }, timeout: 5000, ...extra });
      await b.close();
    },
    list: async (cfg, extra) => {
      await listServerTools({ server: 's', configPaths: [cfg], confirmServer: () => true, timeout: 5000, ...extra });
    },
  };

  for (const [mode, run] of Object.entries(modes)) {
    describe(`mode: ${mode}`, () => {
      it('negative control: passEnv unset leaks parent vars to the child (today\'s behavior)', async () => {
        await run(cfgFor(), {});
        assert.equal(childEnv()[CANARY], CANARY_VAL);
        if (mode === 'bulk') assert.equal(childEnvs().length, 2, 'bulk cold run spawns discovery + main');
      });

      it('passEnv [PATH, HOME] keeps canary out; child sees only passed + own (+ nothing injected on this platform)', async () => {
        await run(cfgFor(), { passEnv: ['PATH', 'HOME'] });
        const env = childEnv();
        assert.equal(Object.hasOwn(env, CANARY), false);
        assert.equal(Object.hasOwn(env, 'F109_OTHER'), false);
        assert.equal(env.PATH, process.env.PATH);
        assert.equal(env.HOME, process.env.HOME);
        // Subset check. Node itself injects no vars into a child given an explicit env on Linux/macOS;
        // on Windows the OS may add a few (e.g. SystemRoot), so only enforce the strict set off Windows.
        if (process.platform !== 'win32') {
          const allowed = new Set(['PATH', 'HOME', 'MOCK_ENV_FILE']);
          const extra = Object.keys(env).filter(k => !allowed.has(k));
          assert.deepEqual(extra, []);
        }
      });

      it('passEnv [] => only the server\'s own env', async () => {
        await run(cfgFor(), { passEnv: [] });
        const env = childEnv();
        assert.equal(Object.hasOwn(env, CANARY), false);
        assert.equal(Object.hasOwn(env, 'PATH'), false);
        assert.ok(Object.hasOwn(env, 'MOCK_ENV_FILE'));
      });
    });
  }

  it('own env ${VAR} still resolves from the full process.env under passEnv (deliberate handoff)', async () => {
    await modes.bulk(cfgFor({ HANDED: `\${${CANARY}}` }), { passEnv: [] });
    const env = childEnv();
    assert.equal(env.HANDED, CANARY_VAL);
    assert.equal(Object.hasOwn(env, CANARY), false);
  });

  it('server own env wins over a passEnv var of the same name', async () => {
    await modes.bulk(cfgFor({ [CANARY]: 'server-own' }), { passEnv: [CANARY] });
    assert.equal(childEnv()[CANARY], 'server-own');
  });

  it('a passEnv name absent from process.env is simply omitted (not set to undefined/empty)', async () => {
    await modes.bulk(cfgFor(), { passEnv: ['F109_DOES_NOT_EXIST_XYZ'] });
    assert.equal(Object.hasOwn(childEnv(), 'F109_DOES_NOT_EXIST_XYZ'), false);
  });

  describe('validation', () => {
    const SECRET = 'SUPER-SECRET-VALUE';
    const bads = [['string', SECRET], ['number entry', [1]], ['empty-string entry', ['']], ['object', { [SECRET]: 1 }], ['null', null], ['mixed', [SECRET, 2]]];
    for (const [label, bad] of bads) {
      it(`createMCPBridge rejects ${label}`, async () => {
        await assert.rejects(createMCPBridge({ passEnv: bad, bridgePath: bp() }), (e) => {
          assert.ok(e instanceof ValidationError);
          assert.equal(e.message.includes(SECRET), false);
          assert.match(e.message, /passEnv/);
          return true;
        });
      });
      it(`listServerTools rejects ${label}`, async () => {
        await assert.rejects(listServerTools({ server: 's', passEnv: bad }), (e) => {
          assert.ok(e instanceof ValidationError);
          assert.equal(e.message.includes(SECRET), false);
          assert.match(e.message, /passEnv/);
          return true;
        });
      });
    }
    it('allow mode validates passEnv before spawning anything', async () => {
      await assert.rejects(createMCPBridge({ allow: { s: ['x'] }, passEnv: 'nope' }), ValidationError);
      assert.equal(existsSync(envFile), false);
    });
  });
});
