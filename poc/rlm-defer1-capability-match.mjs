// DEFERRED-ITEM POC 1/3 — RC-4 capability-matched dispatch, RULED IN OR OUT against what we have.
// Question: does routing a sub-task to a worker offered ONLY its matching tool ("matched", the RC-4 idea) beat
// the current homogeneous worker offered the WHOLE toolset ("all-tools")? RC-4 only earns its place if a big/
// confusable toolset measurably degrades tool selection — otherwise a capable model picks the right tool anyway
// and matching is pure overhead.
//
// DESIGN (able-to-fail, real wire): same-family CONFUSABLE arithmetic-op tools (add/sub/mul/div/pow/mod/gcd/max)
// — the worst case for selection — plus unrelated distractors to scale the tool count. Each sub-task needs
// exactly ONE op; ground truth is CODE-computed. We sweep how many tools the worker is offered:
//   matched(1)  vs  all-arith(8)  vs  all+8 distractors(16)  vs  all+16 distractors(24)
// Metrics per arm: accuracy (answer == truth), WRONG-TOOL rate (called the wrong op), avg tokens.
// VERDICT: RC-4 WINS only if accuracy(matched) − accuracy(all-tools-at-scale) is materially > 0. If accuracy
// stays flat as the toolset grows, RC-4 is ruled OUT (homogeneous is equal-or-better and simpler).
//
// Run:  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-defer1-capability-match.mjs

import { Loop } from '../index.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { OpenAIProvider } from '../src/provider-openai.js';

let provider, providerName;
if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else { console.error('needs ANTHROPIC_API_KEY or OPENAI_API_KEY'); process.exit(1); }

// ── the confusable same-family op tools (the hard case for selection) ─────────────────────────────
const OPS = {
  add:      { word: 'plus',                fn: (a, b) => a + b },
  subtract: { word: 'minus',               fn: (a, b) => a - b },
  multiply: { word: 'multiplied by',       fn: (a, b) => a * b },
  divide:   { word: 'divided by (integer)', fn: (a, b) => Math.trunc(a / b) },
  power:    { word: 'to the power of',     fn: (a, b) => a ** b },
  modulo:   { word: 'modulo',              fn: (a, b) => a % b },
  gcd:      { word: 'gcd with',            fn: (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; } },
  max2:     { word: 'the larger of it and', fn: (a, b) => Math.max(a, b) },
};
// instrumented op tools — record which op the model actually invoked
function arithTools(record) {
  return Object.entries(OPS).map(([name, { fn }]) => ({
    name,
    description: `Compute the ${name} of two integers a and b.`,
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    execute: async ({ a, b }) => { record.push(name); return String(fn(Number(a), Number(b))); },
  }));
}
// unrelated distractors (plausible, never correct for an arithmetic ask) — scale the toolset size
const DISTRACTOR_NAMES = ['weather_lookup', 'translate_text', 'stock_price', 'dictionary_define', 'unit_convert',
  'timezone_at', 'color_to_hex', 'spell_check', 'qr_encode', 'ip_geolocate', 'rhyme_find', 'morse_encode',
  'roman_numeral', 'caesar_cipher', 'base64_encode', 'uuid_make'];
function distractorTools(n, record) {
  return DISTRACTOR_NAMES.slice(0, n).map((name) => ({
    name,
    description: `${name.replace(/_/g, ' ')} (utility).`,
    parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    execute: async () => { record.push(name); return 'n/a'; },
  }));
}

// ── a fixed, un-crafted set of sub-tasks (deterministic — no RNG; each needs exactly one op) ──────
const PAIRS = [[12, 7], [9, 4], [15, 6], [8, 3], [20, 5], [11, 9], [18, 12], [6, 6], [14, 5], [21, 8], [13, 4], [16, 10], [7, 7], [24, 9], [10, 3], [19, 6]];
const OP_NAMES = Object.keys(OPS);
const TASKS = PAIRS.map(([a, b], i) => { const op = OP_NAMES[i % OP_NAMES.length]; return { a, b, op, truth: OPS[op].fn(a, b) }; });

async function runArm(label, toolsFor) {
  let correct = 0, wrongTool = 0, toks = 0;
  for (const t of TASKS) {
    const record = [];
    const tools = toolsFor(t, record);
    const loop = new Loop({
      provider,
      system: 'You compute an arithmetic result by calling exactly ONE tool, then reply with ONLY the integer result (no words).',
      // Loop forwards the round usage as `usage` (NOT `tokens`); sum all four normalized tiers so cache-read/
      // creation aren't dropped (the earlier `{ tokens }` destructure was always undefined → ~0 tok reported).
      onLlmResult: ({ usage }) => {
        if (usage) toks += (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheCreationTokens || 0);
      },
      throwOnError: false,
    });
    const q = `What is ${t.a} ${OPS[t.op].word} ${t.b}? Use a tool.`;
    const out = await loop.run([{ role: 'user', content: q }], tools, {});
    const got = (String(out.text || '').match(/-?\d+/) || [])[0];
    if (got != null && Number(got) === t.truth) correct++;
    // the model called a tool other than the correct op (a selection error the matched arm can't make)
    if (record.length && !record.includes(t.op)) wrongTool++;
  }
  const acc = correct / TASKS.length;
  console.log(`  ${label.padEnd(22)} acc=${(100 * acc).toFixed(0)}%  wrong-tool=${wrongTool}/${TASKS.length}  ~${toks} tok`);
  return acc;
}

console.log(`POC1 RC-4 capability-match — ${providerName}, ${TASKS.length} confusable arithmetic sub-tasks\n`);
console.log('  arm                    accuracy / wrong-tool / tokens');
const accMatched = await runArm('matched(1 tool)', (t, rec) => arithTools(rec).filter((x) => x.name === t.op));
const accAll8 = await runArm('all-arith(8)', (t, rec) => arithTools(rec));
const accPlus8 = await runArm('all+8 distractors(16)', (t, rec) => [...arithTools(rec), ...distractorTools(8, rec)]);
const accPlus16 = await runArm('all+16 distractors(24)', (t, rec) => [...arithTools(rec), ...distractorTools(16, rec)]);

const worstHomo = Math.min(accAll8, accPlus8, accPlus16);
const gain = accMatched - worstHomo; // how much matching buys at the worst toolset scale
console.log(`\n  matched − worst-homogeneous = ${(100 * gain).toFixed(0)} percentage points`);
// RC-4 is worth building only if scoping to the matched tool materially beats the full toolset. <10pp ⇒ ruled OUT.
const ruledIn = gain >= 0.10;
console.log(`\nVERDICT: RC-4 capability-match is ${ruledIn ? 'BETTER (worth considering)' : 'RULED OUT — homogeneous all-tools is equal-or-better'} for this model`);
console.log(`  (matched ${(100 * accMatched).toFixed(0)}% vs all-tools-at-scale ${(100 * worstHomo).toFixed(0)}%; a capable model ${ruledIn ? 'IS confused by a big toolset' : 'picks the right tool regardless of toolset size'})`);
process.exit(0);
