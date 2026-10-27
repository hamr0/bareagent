// POC: a stdio MCP server whose command cannot start (ENOENT / EACCES) must NOT crash the host.
// Drives the REAL bridge (no stubs) in all three modes. Exits 1 on any crash or wrong shape.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { createMCPBridge, listServerTools } = require('../src/mcp-bridge.js');

let crashed = null;
const onCrash = (e) => { crashed = e; console.error('CRASH-SIGNAL', e && e.message); };
process.on('unhandledRejection', onCrash);
process.on('uncaughtException', onCrash);

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-spawn-poc-')));
const noexec = join(dir, 'not-executable');
writeFileSync(noexec, '#!/bin/sh\n'); chmodSync(noexec, 0o644);
const SECRET = 'SECRET-ARG-123';
const cases = [['ENOENT', 'no-such-cmd-zz']];
if (process.platform !== 'win32') cases.push(['EACCES', noexec]);

const rows = []; let bad = 0;
const check = (ok, why) => { if (!ok) { bad++; console.error('WRONG:', why); } return ok ? 'ok' : 'WRONG'; };
const warn = console.warn; console.warn = () => {};

for (const [code, command] of cases) {
  const cfg = join(dir, `${code}.json`);
  writeFileSync(cfg, JSON.stringify({ mcpServers: { s: { command, args: [SECRET] } } }));
  const want = `MCP server "s" failed to start: command "${command}" (${code})`;
  const common = { configPaths: [cfg], confirmServer: () => true, timeout: 3000 };

  // list
  let r;
  try { await listServerTools({ server: 's', ...common }); r = check(false, 'list did not throw'); }
  catch (e) {
    r = check(e.name === 'ToolError' && e.message === want && e.context.spawnError === true
      && e.context.code === code && e.context.server === 's'
      && !e.message.includes(SECRET) && !JSON.stringify(e.context).includes(SECRET), `list shape: ${e.name} ${e.message}`);
  }
  rows.push([code, 'list', r]);

  // allow
  const a = await createMCPBridge({ ...common, bridgePath: join(dir, 'a.json'), allow: { s: ['x'] } });
  r = check(a.errors.length === 1 && a.errors[0].error === want && a.missing.length === 1 && a.missing[0].tool === 'x', `allow shape ${JSON.stringify(a.errors)} ${JSON.stringify(a.missing)}`);
  await a.close(); rows.push([code, 'allow', r]);

  // bulk
  const b = await createMCPBridge({ ...common, bridgePath: join(dir, 'b.json') });
  r = check(b.errors.length === 1 && b.errors[0].error === want, `bulk shape ${JSON.stringify(b.errors)}`);
  await b.close(); rows.push([code, 'bulk', r]);
}
await new Promise((r) => setTimeout(r, 300)); // let any late unhandled event surface
console.warn = warn;
rmSync(dir, { recursive: true, force: true });
console.table(rows.map(([code, mode, result]) => ({ code, mode, result })));
if (crashed) { console.error('FAIL: host saw an unhandled error'); process.exit(1); }
if (bad) { console.error(`FAIL: ${bad} wrong shape(s)`); process.exit(1); }
console.log('PASS'); process.exit(0);
