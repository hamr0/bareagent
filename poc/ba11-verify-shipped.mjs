// BA-11 VERIFY-SHIPPED — run the REAL recurse() on a live model and confirm the deny-spin guard
// short-circuits to {incomplete, blocker:'governance-deny'} instead of burning the budget to the cap.
// This validates DELIVERY (the shipped code path), not the POC's isolated logic.
//
// Run:  ANTHROPIC_API_KEY=... node poc/ba11-verify-shipped.mjs
//
// Expect: incomplete=true, blocker='governance-deny', and the worker stopped after ~3 denied writes
// (the default maxConsecutiveDenials), NOT a spin to HARD_ROUND_LIMIT(100). A control run with the
// guard disabled (maxConsecutiveDenials via a hand-built Loop) is out of scope here — the guard's
// default-on behavior through recurse is what relayfact consumes, so that is what we verify.

import { recurse } from '../src/recurse.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error('set ANTHROPIC_API_KEY'); process.exit(2); }

const provider = new AnthropicProvider({ apiKey, model: 'claude-haiku-4-5-20251001' });

const readTool = {
  name: 'read_file',
  description: 'Read a file, returns its text.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async ({ path }) => `// ${path}\nexport const add = (a,b) => a - b; // BUG: should be a + b`,
};
const writeTool = {
  name: 'write_file',
  description: 'Save text to a file. Use this to persist your fix.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, contents: { type: 'string' } }, required: ['path', 'contents'] },
  execute: async () => 'OK', // never reached — policy denies
};

// A governance policy that always DENIES the write with a retry-inviting reason (the probe-16 shape).
let denials = 0, allowed = 0;
const policy = async (toolName) => {
  if (toolName === 'write_file') { denials++; return '[blocked: content-review] the contents contain a disallowed phrase; revise the wording and retry'; }
  allowed++;
  return true;
};

const task = 'Read /work/add.js, fix the bug (add should return a+b), and SAVE it with write_file.';
const out = await recurse(task, { provider, policy }, { tools: [readTool, writeTool] });

console.log('\n=== BA-11 verify-shipped (recurse + haiku, write always denied) ===');
console.log('incomplete      :', out.incomplete);
console.log('blocker         :', out.blocker);
console.log('receipts.blocker:', out.receipts?.blocker);
console.log('write denials   :', denials, '| allowed calls:', allowed);
console.log('receipts.tokens :', out.receipts?.tokens);

const pass = out.incomplete === true
  && out.blocker === 'governance-deny'
  && out.receipts?.blocker === 'governance-deny'
  && denials <= 4;                       // fired at the default 3 (allow one round of slack), NOT a 100-round burn
console.log('\nVERDICT:', pass ? 'PASS — short-circuited cleanly at the guard, no burn' : 'FAIL — see values above');
process.exit(pass ? 0 : 1);
