// POC (gate): the bulk-mode `errors` RULE, driven against the REAL createMCPBridge + the real mock server.
//   RULE: `errors` lists ONLY servers that did NOT end up connected this run (not in `servers`),
//         exactly ONE entry per such server; working servers never appear; <=1 failure warn per run; a server that failed discovery but connected from the cached def draws exactly one separate cached-def warn (never in `errors`);
//         `errors` always an array; no live child after close().
// Prints a table, exits 1 on any violation.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createMCPBridge } = require(join(root, 'src/mcp-bridge.js'));
const MOCK = join(root, 'test/fixtures/mock-mcp-server.js');

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-errrule-')));
process.chdir(dir);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let uid = 0;
const pidFiles = [];

const mock = (env = {}) => {
  const pf = join(dir, `p${++uid}.pid`); pidFiles.push(pf);
  return { command: 'node', args: [MOCK], env: { ...env, MOCK_PID_FILE: pf } };
};
const good = () => mock();
const endless = () => mock({ MOCK_ENDLESS_PAGES: '1' });
const exits = () => ({ command: 'node', args: ['-e', 'process.exit(1)'] });

// scenario: discover = defs found by discovery; cache = cached defs (null = none); ttl/age; opts
const S = (id, desc, { discover = {}, cache = null, ttl = '1h', opts = {}, servers, errors, cachedWarn = [] }) =>
  ({ id, desc, discover, cache, ttl, opts, servers, errors, cachedWarn });

const scenarios = [
  S('a', 'cold: good g + failing s', { discover: { g: good(), s: endless() }, servers: ['g'], errors: ['s'] }),
  S('b', 'cold: only failing s (early return)', { discover: { s: endless() }, servers: [], errors: ['s'] }),
  S('b2', 'cold: only s that exits at once', { discover: { s: exits() }, servers: [], errors: ['s'] }),
  S('c', 'refresh: cached s fails AND discovery s fails', { discover: { s: endless() }, cache: { s: endless() }, opts: { refresh: true }, servers: [], errors: ['s'] }),
  S('d', 'refresh: discovery s fails, cached s connects', { discover: { s: endless() }, cache: { s: good() }, opts: { refresh: true }, servers: ['s'], errors: [], cachedWarn: ['s'] }),
  S('e1', 'expired TTL variant of c', { discover: { s: endless() }, cache: { s: endless() }, ttl: '1s', servers: [], errors: ['s'] }),
  S('e2', 'expired TTL variant of d', { discover: { s: endless() }, cache: { s: good() }, ttl: '1s', servers: ['s'], errors: [], cachedWarn: ['s'] }),
  S('f', 'warm cache: cached s fails (+ good g)', { cache: { g: good(), s: endless() }, servers: ['g'], errors: ['s'] }),
  S('g', 'warm cache: all healthy', { cache: { g: good(), s: good() }, servers: ['g', 's'], errors: [] }),
  S('h', 'discovery empty, cache exists (fall-through)', { cache: { g: good(), s: endless() }, opts: { refresh: true }, servers: ['g'], errors: ['s'] }),
];

const rows = [];
let bad = 0;
for (const sc of scenarios) {
  const cfg = join(dir, `servers-${sc.id}.json`);
  writeFileSync(cfg, JSON.stringify({ mcpServers: sc.discover }));
  const bridgePath = join(dir, `bridge-${sc.id}.json`);
  if (sc.cache) {
    const servers = {};
    for (const [n, d] of Object.entries(sc.cache)) servers[n] = { ...d, tools: { t1: 'allow' } };
    writeFileSync(bridgePath, JSON.stringify({ discovered: new Date(Date.now() - 60000).toISOString(), ttl: sc.ttl, servers }));
  }
  const warns = [];
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = (...a) => warns.push(a);
  let b, thrown;
  try { b = await createMCPBridge({ bridgePath, configPaths: [cfg], timeout: 3000, ...sc.opts }); }
  catch (e) { thrown = e; }
  finally { console.log = log; console.warn = warn; }

  const v = [];
  if (thrown) v.push(`threw: ${thrown.message}`);
  else {
    if (!Array.isArray(b.errors)) v.push('errors not an array');
    else {
      const names = b.errors.map(e => e.server);
      for (const n of new Set(names)) if (names.filter(x => x === n).length !== 1) v.push(`${n} listed ${names.filter(x => x === n).length}x`);
      for (const n of names) if (b.servers.includes(n)) v.push(`${n} in errors AND servers (stale)`);
      if (JSON.stringify([...new Set(names)].sort()) !== JSON.stringify([...sc.errors].sort())) v.push(`errors=${JSON.stringify(names)} want ${JSON.stringify(sc.errors)}`);
    }
    if (JSON.stringify([...b.servers].sort()) !== JSON.stringify([...sc.servers].sort())) v.push(`servers=${JSON.stringify(b.servers)} want ${JSON.stringify(sc.servers)}`);
    const fw = warns.filter(a => String(a[0]).includes('Some servers failed to connect'));
    if (fw.length > 1) v.push(`failure warn x${fw.length}`);
    if (sc.errors.length === 0 && fw.length) v.push('failure warn with no final errors');
    // cached-def warn: exactly one naming the want-set when expected, none otherwise
    const cw = warns.filter(a => String(a[0]).includes('connected from the cached definition'));
    if (sc.cachedWarn.length === 0) { if (cw.length) v.push(`unexpected cached-def warn x${cw.length}`); }
    else if (cw.length !== 1) v.push(`cached-def warn x${cw.length}, want 1`);
    else {
      const named = (cw[0][1] || []).map(e => e.server);
      if (JSON.stringify(named.sort()) !== JSON.stringify([...sc.cachedWarn].sort())) v.push(`cached-def warn names ${JSON.stringify(named)}`);
    }
    await b.close();
  }
  await sleep(150);
  for (const pf of pidFiles) {
    if (!existsSync(pf)) continue;
    const pid = Number(readFileSync(pf, 'utf8'));
    const end = Date.now() + 3000;
    while (Date.now() < end && alive(pid)) await sleep(25);
    if (alive(pid)) { v.push(`live child ${pid}`); try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  if (v.length) bad++;
  rows.push({ id: sc.id, scenario: sc.desc, servers: thrown ? '-' : b.servers.join(','), errors: thrown ? '-' : (b.errors || []).map(e => e.server).join(','), result: v.length ? 'FAIL ' + v.join('; ') : 'ok' });
}
process.chdir(root);
rmSync(dir, { recursive: true, force: true });
console.table(rows);
console.log(bad ? `${bad} scenario(s) VIOLATE the rule` : 'all scenarios satisfy the rule');
process.exit(bad ? 1 : 0);
