// DEFERRED-ITEM POC 2b — history-overflow triangulation, DIFFERENT growth axis. POC2 tested WIDTH (fan-out:
// child results accumulate in the PARENT window). This tests ITERATION: a SINGLE worker making many sequential
// tool calls, each returning a sizeable (~80-word) payload that accumulates in ITS OWN window — the other path
// to overflow, the one a fan-out test cannot see. If even a 20-step iterative worker stays under a small-model
// budget, the "windows stay small" claim holds from a second, independent direction. Weak model (gpt-4o-mini)
// so the per-step text is realistic for the RLM target tier.
//
// VERDICT: compaction WINS if the single-worker window crosses an 8k SLM budget at a realistic iteration count.
//
// Run:  OPENAI_API_KEY=$(pass amr/openai_api) node poc/rlm-defer2b-iterative-history.mjs
//   or  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-defer2b-iterative-history.mjs

import { Loop } from '../index.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { OpenAIProvider } from '../src/provider-openai.js';

let baseProvider, providerName;
if (process.env.OPENAI_API_KEY) { baseProvider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else if (process.env.ANTHROPIC_API_KEY) { baseProvider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else { console.error('needs OPENAI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1); }

const SLM_BUDGET = 8000, TIGHT_BUDGET = 4000;

// ~80-word document body the fetch tool returns each call (the per-step payload that accumulates in the window).
const BODY = ('This internal report section reviews quarterly performance, supply-chain exposure, staffing levels, ' +
  'and forward guidance. It notes regional demand shifts, margin pressure from input costs, an inventory ' +
  'rebalancing underway, and several open risks the committee flagged for follow-up next period, including ' +
  'vendor concentration, currency exposure on overseas contracts, and a pending regulatory review whose ' +
  'outcome could affect two product lines and the associated revenue recognition timing this fiscal year.').trim();

function instrumentedProvider(stats) {
  return {
    ...baseProvider,
    async generate(messages, tools, options) {
      const chars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
      const winTokens = Math.ceil(chars / 4);
      if (winTokens > stats.peak) stats.peak = winTokens;
      stats.calls++;
      return baseProvider.generate(messages, tools, options);
    },
  };
}

async function runN(n) {
  const stats = { peak: 0, calls: 0 };
  const provider = instrumentedProvider(stats);
  const fetch_document = {
    name: 'fetch_document',
    description: 'Fetch the full text of a document by its id (e.g. "doc-3").',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async ({ id }) => `[${id}] ${BODY}`,
  };
  const loop = new Loop({ provider, system: 'You build a combined briefing. Fetch EACH document one at a time with the tool, then write one short combined summary at the end.', throwOnError: false });
  const ids = Array.from({ length: n }, (_, i) => `doc-${i + 1}`).join(', ');
  const task = `Fetch these ${n} documents one at a time and then give a single combined summary: ${ids}.`;
  await loop.run([{ role: 'user', content: task }], [fetch_document], {});
  return { n, peak: stats.peak, calls: stats.calls };
}

console.log(`POC2b iterative-history — ${providerName}, ~${BODY.split(/\s+/).length}-word payload/step, SLM budget=${SLM_BUDGET}\n`);
console.log('  iterations  peak-window(tok)  calls  > tight(4k)?  > SLM(8k)?');
const rows = [];
for (const n of [5, 10, 20]) {
  const r = await runN(n);
  rows.push(r);
  console.log(`  ${String(r.n).padEnd(10)}  ${String(r.peak).padEnd(16)}  ${String(r.calls).padEnd(5)}  ${r.peak > TIGHT_BUDGET ? 'YES' : 'no '}          ${r.peak > SLM_BUDGET ? 'YES' : 'no'}`);
}
const maxPeak = Math.max(...rows.map((r) => r.peak));
console.log(`\n  peak single-worker window = ${maxPeak} tok`);
console.log(`\nVERDICT: history-compaction (iterative path) is ${maxPeak > SLM_BUDGET ? 'BETTER — a single worker overflows 8k, fit(history) needed' : maxPeak > TIGHT_BUDGET ? 'MARGINAL — exceeds a tight 4k local model at high iteration counts' : 'RULED OUT — even a 20-step iterative worker stays under a small-model budget'}`);
process.exit(0);
