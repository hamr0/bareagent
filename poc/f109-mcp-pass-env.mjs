// F109 POC: do parent API keys reach a spawned MCP server? Drives the real createMCPBridge + the
// real mock stdio MCP server. Exits non-zero if either arm is wrong (negative control).
import { createRequire } from 'node:module';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { createMCPBridge } = require('../src/mcp-bridge');

const CANARY = 'F109_CANARY_KEY';
process.env[CANARY] = 'sk-canary-value';
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'f109-')));
const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'mock-mcp-server.js');
console.warn = () => {};
console.log = () => {};

async function childSees(extra, tag) {
  const envFile = join(dir, `${tag}.env`);
  const cfg = join(dir, `${tag}.json`);
  writeFileSync(cfg, JSON.stringify({ mcpServers: { s: { command: process.execPath, args: [server], env: { MOCK_ENV_FILE: envFile } } } }));
  const b = await createMCPBridge({ configPaths: [cfg], confirmServer: () => true, bridgePath: join(dir, `${tag}.bridge.json`), timeout: 5000, ...extra });
  await b.close();
  return readFileSync(envFile, 'utf8').trim().split('\n').map(l => Object.hasOwn(JSON.parse(l), CANARY));
}

const without = await childSees({}, 'without');
const withPass = await childSees({ passEnv: ['PATH', 'HOME'] }, 'with');
rmSync(dir, { recursive: true, force: true });
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
out(`without passEnv: canary visible to child per spawn = ${JSON.stringify(without)}  (must be all true)`);
out(`with passEnv [PATH,HOME]: canary visible per spawn = ${JSON.stringify(withPass)}  (must be all false)`);
const ok = without.length > 0 && without.every(Boolean) && withPass.length > 0 && withPass.every(v => v === false);
out(ok ? 'POC OK' : 'POC FAILED');
process.exit(ok ? 0 : 1);
