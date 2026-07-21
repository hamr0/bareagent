/**
 * POC — CLIPipe-with-tools, step 5: VALIDATE THE SHIPPED CODE, not a prototype. Step 3 proved a
 * standalone prototype provider works through a real Loop; this drives the ACTUAL
 * `CLIPipeProvider({ toolProtocol:'claude' })` from src/ through a real Loop, multi-round, on
 * sonnet — "validate delivery, not assert". Also exercises the loud-failure path (weak model →
 * capability-probe throw) so the safety net is proven, not assumed.
 *
 * Usage:  MODEL=sonnet node poc/clipipe-tools-05-shipped.mjs
 */
import { Loop } from '../index.js';
import { CLIPipeProvider } from '../src/provider-clipipe.js';

const MODEL = process.env.MODEL || 'sonnet';

const BALANCES = { 'ACC-7731': '£4,182.55', 'ACC-2200': '£917.03' };
let toolHits = 0;
const balanceTool = {
  name: 'get_account_balance',
  description: 'Returns the balance for an account id.',
  parameters: { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] },
  execute: async ({ account_id }) => { toolHits++; return BALANCES[account_id] || 'NO SUCH ACCOUNT'; },
};

function makeProvider(model, opts = {}) {
  return new CLIPipeProvider({
    command: 'claude',
    args: ['-p', '--model', model],
    toolProtocol: 'claude',
    timeout: 180000,
    ...opts,
  });
}

// ---- 1. Happy path: shipped provider, real Loop, two-tool task, sonnet ---------------------
console.log(`=== 1. SHIPPED provider through a real Loop (model=${MODEL}) ===`);
const loop = new Loop({
  provider: makeProvider(MODEL),
  system: 'You answer account questions by calling tools for the numbers.',
  throwOnError: false,
});
const t0 = Date.now();
const out = await loop.run(
  [{ role: 'user', content: 'What are the balances of accounts ACC-7731 and ACC-2200? Report both with their ids.' }],
  [balanceTool],
);
const ms = Date.now() - t0;
console.log(`  tool executions: ${toolHits}  | loop error: ${out.error ?? 'null'}  | ${ms}ms`);
console.log(`  final text     : ${String(out.text).replace(/\n/g, ' ').slice(0, 200)}`);
const happyPass = !out.error && toolHits >= 2 && out.text.includes('4,182.55') && out.text.includes('917.03');
console.log(`  => ${happyPass ? 'PASS — shipped code carries the round-trip' : '>>> FAIL <<<'}\n`);

// ---- 2. Loud failure: a weak model is caught by the upfront probe, not silently degraded -----
console.log('=== 2. Loud-failure path (weak model → capability-probe throw) ===');
let loudOk = false;
try {
  const weak = makeProvider('haiku');
  await weak.generate([{ role: 'user', content: 'What is the balance of ACC-7731?' }], [balanceTool]);
  console.log('  >>> FAIL — haiku was NOT rejected; it would silently degrade <<<');
} catch (e) {
  loudOk = /not capable of tool use|capability probe/i.test(e.message);
  console.log(`  threw: ${e.message.slice(0, 140)}`);
  console.log(`  => ${loudOk ? 'PASS — weak model rejected upfront, loudly' : '>>> FAIL — wrong error <<<'}\n`);
}

// ---- 3. Misconfiguration: tools with no protocol → ignored (text mode) + one-time warn ------
console.log('=== 3. tools without toolProtocol → plain-text (ignored) + warn ===');
let cfgOk = false;
{
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(String(m));
  const noProto = new CLIPipeProvider({ command: 'echo', args: ['plain reply'] });
  const r = await noProto.generate([{ role: 'user', content: 'hi' }], [balanceTool]);
  console.warn = orig;
  cfgOk = r.toolCalls.length === 0 && warnings.some((w) => /no toolProtocol/.test(w));
  console.log(`  toolCalls=${r.toolCalls.length}, warned=${warnings.length > 0}`);
  console.log(`  => ${cfgOk ? 'PASS — tools ignored (backward compat), warned once' : '>>> FAIL <<<'}`);
}

console.log('\n=== SUMMARY ===');
console.log(`happy-path ${happyPass ? 'PASS' : 'FAIL'} | loud-failure ${loudOk ? 'PASS' : 'FAIL'} | misconfig ${cfgOk ? 'PASS' : 'FAIL'}`);
process.exit(happyPass && loudOk && cfgOk ? 0 : 1);
