// POC: listServerTools against a REAL MCP server (@modelcontextprotocol/server-everything via npx).
// Prints tool names + annotations; exits 1 if the shape is wrong, leaves a file, prints to stdout, or leaks the child.
//   node poc/mcp-annotations-list.mjs
import { mkdtempSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listServerTools } = require(resolve(import.meta.dirname, '../src/mcp.js'));

const work = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-list-poc-')));
process.chdir(work); // a stray .mcp-bridge.json would land here
const cfgPath = join(work, 'servers.json');
writeFileSync(cfgPath, JSON.stringify({
  mcpServers: { everything: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] } },
}));

let failed = 0;
const check = (label, ok) => { console.error(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };

const chunks = [];
const orig = process.stdout.write;
process.stdout.write = (c) => { chunks.push(String(c)); return true; };
let tools;
try { tools = await listServerTools({ server: 'everything', configPaths: [cfgPath], timeout: 60000 }); }
finally { process.stdout.write = orig; }

const withAnn = tools.filter(t => 'annotations' in t);
for (const t of tools) console.error(`  ${t.name}${'annotations' in t ? '  ' + JSON.stringify(t.annotations) : '  (no annotations key)'}`);
console.error(`tools=${tools.length} withAnnotations=${withAnn.length}`);

check('array of tools', Array.isArray(tools) && tools.length > 0);
check('every entry {name:string, description:string}', tools.every(t => typeof t.name === 'string' && t.name && typeof t.description === 'string'));
check('annotations key absent or a plain object', tools.every(t => !('annotations' in t) || (t.annotations && typeof t.annotations === 'object' && !Array.isArray(t.annotations))));
check('no extra keys', tools.every(t => Object.keys(t).every(k => ['name', 'description', 'annotations'].includes(k))));
check('known tool "echo" present', tools.some(t => t.name === 'echo'));
check('no stdout output', chunks.join('') === '');
check('no file written', readdirSync(work).join() === 'servers.json');

// Child reaped: no npm/node server-everything process remains (anchored so it can't match a wrapping shell's argv).
const { execFileSync } = await import('node:child_process');
await new Promise(r => setTimeout(r, 500));
let left = '';
try { left = execFileSync('pgrep', ['-f', '^(npm exec|node|npx).*server-everything'], { encoding: 'utf8' }).trim(); } catch { /* none */ }
check('server child reaped (no server-everything process)', left === '');

process.exit(failed ? 1 : 0);
