// POC: createMCPBridge({ allow }) against a REAL MCP server (@modelcontextprotocol/server-everything via npx).
// Exits non-zero if any check fails. Against code WITHOUT `allow` support it must fail
// (unsigned tools exposed, cache file written, stdout noise, no `missing`).
//   node poc/mcp-allow.mjs
import { mkdtempSync, writeFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMCPBridge } = require(resolve(import.meta.dirname, '../src/mcp-bridge.js'));

const work = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-allow-poc-')));
process.chdir(work); // so a stray .mcp-bridge.json lands here, never in the repo
const cfgPath = join(work, 'servers.json');
writeFileSync(cfgPath, JSON.stringify({
  mcpServers: { everything: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] } },
}));

let failed = 0;
const check = (label, ok) => { console.error(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed++; };

// Capture stdout (console.log + raw writes) during a call.
async function captured(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (c, ...r) => { chunks.push(String(c)); return true; };
  try { return { value: await fn(), out: chunks.join('') }; }
  finally { process.stdout.write = orig; }
}

const SIGNED = ['echo', 'get-sum', 'not-a-real-tool'];
const { value: b, out } = await captured(() =>
  createMCPBridge({ allow: { everything: SIGNED }, configPaths: [cfgPath], bridgePath: join(work, 'bridge.json') }));

try {
  const names = b.tools.map(t => t.name).sort();
  check('exposed == signed ∩ listed', JSON.stringify(names) === JSON.stringify(['everything_echo', 'everything_get-sum']));
  check('fake signed name lands in missing', JSON.stringify(b.missing) === JSON.stringify([{ server: 'everything', tool: 'not-a-real-tool' }]));
  check('no file written (cwd + bridgePath)', readdirSync(work).sort().join() === 'servers.json' && !existsSync(join(work, 'bridge.json')));
  check('no stdout output', out === '');
  check('denied is []', Array.isArray(b.denied) && b.denied.length === 0);
  check('systemContext has no Restricted / .mcp-bridge.json', !/Restricted|mcp-bridge\.json/.test(b.systemContext ?? ''));
  check('metaTools catalog excludes unsigned', b.metaTools && (await b.metaTools[0].execute({})).count === 2);

  // mcp_invoke: listed-but-unsigned => denied context; truly unknown => unknown tool error
  const invoke = b.metaTools?.[1];
  let e1; try { await invoke.execute({ name: 'everything_get-env' }); } catch (e) { e1 = e; }
  check('invoke listed-but-unsigned => denied:true', e1?.context?.denied === true && e1.context.server === 'everything' && e1.context.tool === 'get-env'
    && e1.message === 'mcp_invoke: "everything_get-env" is not on this run\'s allowed list');
  let e2; try { await invoke.execute({ name: 'everything_nope' }); } catch (e) { e2 = e; }
  check('invoke unknown => unknown tool, not denied', /unknown tool/.test(e2?.message ?? '') && !e2.context?.denied
    && !JSON.stringify(e2.context).includes('get-env'));
  const ok = await b.tools.find(t => t.name === 'everything_echo').execute({ message: 'hi' });
  check('signed tool actually callable', /hi/.test(String(ok)));
} catch (e) {
  console.error('POC threw:', e.message); failed++;
} finally {
  await b.close?.();
}

// Timeout labelling (all modes): long-running tool with a tiny callTimeout
const t = await createMCPBridge({ configPaths: [cfgPath], bridgePath: join(work, 'ctl.json'), callTimeout: 500, servers: ['everything'] });
try {
  const long = t.tools.find(x => x.name === 'everything_trigger-long-running-operation');
  let et; try { await long.execute({ duration: 10, steps: 5 }); } catch (e) { et = e; }
  check('timeout: context.timeout===true', et?.context?.timeout === true && et.context.server === 'everything'
    && et.context.tool === 'trigger-long-running-operation' && et.context.timeoutMs === 500);
  check('timeout: message labelled, stderr not in message', et?.message === 'MCP server "everything" tool "trigger-long-running-operation" timed out after 500ms'
    && typeof et.context.stderr === 'string');
} finally {
  await t.close();
}

// Negative control: no `allow` => everything exposed, cache written (proves checks above can fail)
check('control (no allow): exposes unsigned tools + writes cache', t.tools.some(x => x.name === 'everything_get-env') && existsSync(join(work, 'ctl.json')));

console.error(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
