// POC: bridge-level `cwd` for createMCPBridge/listServerTools. Drives the REAL bridge + the real mock
// stdio MCP server (which appends its process.cwd() to MOCK_CWD_FILE). Also MEASURES raw spawn()
// behaviour for a missing folder / a file as folder. Exits non-zero if any expectation fails.
//
// NOTE: this POC validates the DESIGN against src/mcp-bridge.js once `cwd` is implemented; before the
// build, the "bridge cwd reaches child" arms are expected to FAIL (negative control).
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { createMCPBridge, listServerTools } = require('../src/mcp-bridge');
const { ValidationError } = require('../src/errors');

console.warn = () => {};
console.log = () => {};
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cwdpoc-')));
const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'mock-mcp-server.js');
const A = join(dir, 'A'); const B = join(dir, 'B'); mkdirSync(A); mkdirSync(B);
const aFile = join(dir, 'afile'); writeFileSync(aFile, 'x');
let n = 0, fails = 0;
const check = (label, ok) => { out(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

function mk(defCwd) {
  const id = ++n;
  const cwdFile = join(dir, `cwd${id}.txt`);
  const cfg = join(dir, `cfg${id}.json`);
  writeFileSync(cfg, JSON.stringify({ mcpServers: { s: { command: process.execPath, args: [server],
    env: { MOCK_CWD_FILE: cwdFile }, ...(defCwd ? { cwd: defCwd } : {}) } } }));
  const bridgePath = join(dir, `b${id}.json`);
  const cwds = () => existsSync(cwdFile) ? readFileSync(cwdFile, 'utf8').trim().split('\n') : [];
  return { cfg, bridgePath, cwds };
}
const bulk = async (m, extra) => { const b = await createMCPBridge({ configPaths: [m.cfg], confirmServer: () => true, bridgePath: m.bridgePath, timeout: 5000, ...extra }); await b.close(); };
const allow = async (m, extra) => { const b = await createMCPBridge({ configPaths: [m.cfg], confirmServer: () => true, allow: { s: ['read_file'] }, timeout: 5000, ...extra }); await b.close(); };
const list = async (m, extra) => { await listServerTools({ server: 's', configPaths: [m.cfg], confirmServer: () => true, timeout: 5000, ...extra }); };

for (const [mode, run, spawns] of [['bulk', bulk, 2], ['allow', allow, 1], ['list', list, 1]]) {
  let m = mk(); await run(m, { cwd: A });
  check(`${mode}: bridge cwd reaches every spawn (${spawns})`, m.cwds().length === spawns && m.cwds().every(c => c === A));
  m = mk(B); await run(m, { cwd: A });
  check(`${mode}: def.cwd wins over bridge cwd`, m.cwds().length === spawns && m.cwds().every(c => c === B));
  m = mk(); await run(m, {});
  check(`${mode}: unset = process cwd`, m.cwds().length === spawns && m.cwds().every(c => c === process.cwd()));
}
{ const m = mk(); await bulk(m, { cwd: A });
  check('bulk: bridge cwd NOT persisted in .mcp-bridge.json', !readFileSync(m.bridgePath, 'utf8').includes(A)); }

const bads = [['missing folder', join(dir, 'nope')], ['file as folder', aFile], ['relative', 'rel/dir'], ['~/x', '~/x'], ['empty string', ''], ['number', 5], ['null', null]];
for (const [label, bad] of bads) {
  for (const [mode, run] of [['bulk', bulk], ['allow', allow], ['list', list]]) {
    const m = mk();
    let err; try { await run(m, { cwd: bad }); } catch (e) { err = e; }
    const ok = err instanceof ValidationError && m.cwds().length === 0 && (typeof bad !== 'string' || bad === '' || !err.message.includes(bad));
    check(`${mode}: ${label} => ValidationError, nothing spawned, value not echoed`, ok);
    if (!ok) out('      got:', err && err.message);
  }
}

// Raw spawn() measurement
async function raw(cwd) {
  try {
    return await new Promise((res) => {
      const c = spawn(process.execPath, ['-e', ''], { cwd });
      c.on('error', (e) => res(`ASYNC error event code=${e.code}`));
      c.on('exit', (code) => res(`spawned fine, exit ${code}`));
    });
  } catch (e) { return `SYNC throw code=${e.code}`; }
}
out('MEASURED raw spawn, missing folder:', await raw(join(dir, 'nope')));
out('MEASURED raw spawn, file as folder:', await raw(aFile));

rmSync(dir, { recursive: true, force: true });
out(fails === 0 ? 'POC OK' : `POC FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
