// DEFERRED-ITEM POC 2/3 — history-compaction (the paper's `fit(history)`), RULED IN OR OUT against what we have.
// Question: does a recurse run's per-node window (its accumulated history — system + task + child results coming
// back) actually OVERFLOW, so the paper's summarize-vs-externalize policy is needed? Our claim: copy-on-return +
// handles keep windows small BY CONSTRUCTION, so it never bites. The paper needs `fit(history)` because ITS loop
// accumulates a lot in-window. RLM targets SMALL models, so the honest bar is a small window (8k / 4k), not 200k.
//
// DESIGN (able-to-fail, real wire): drive a Family-A decomposition at increasing fan-out WIDTH (3 → 6 → 9 sub-
// parts, each child returning a verbose ~120-word result), and INSTRUMENT the provider to record the single
// largest window (tokens, chars/4) any node ever held. If the parent window grows toward an SLM budget as width
// rises, compaction is REAL. If it stays flat/small (externalized), compaction is ruled OUT.
//
// VERDICT: compaction WINS if peak node window exceeds a small-model budget (8k tok) at a realistic width. If the
// peak stays well under it even at width 9, the deferral is confirmed (our design engineers away the pressure).
//
// Run:  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-defer2-history-overflow.mjs

import { recurse } from '../index.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { OpenAIProvider } from '../src/provider-openai.js';

let baseProvider, providerName;
if (process.env.ANTHROPIC_API_KEY) { baseProvider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else if (process.env.OPENAI_API_KEY) { baseProvider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else { console.error('needs ANTHROPIC_API_KEY or OPENAI_API_KEY'); process.exit(1); }

const SLM_BUDGET = 8000;   // a small-model context window — RLM's real target (the honest bar, not 200k)
const TIGHT_BUDGET = 4000; // an even smaller local model

// Instrument: wrap generate to measure each window's size (the full message array handed to the model).
function instrumentedProvider(stats) {
  return {
    ...baseProvider,
    async generate(messages, tools, options) {
      const chars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
      const toolChars = (tools || []).reduce((n, t) => n + JSON.stringify(t.parameters || {}).length + (t.description || '').length, 0);
      const winTokens = Math.ceil((chars + toolChars) / 4);
      if (winTokens > stats.peak) stats.peak = winTokens;
      stats.calls++;
      return baseProvider.generate(messages, tools, options);
    },
  };
}

async function runWidth(width) {
  const stats = { peak: 0, calls: 0 };
  const provider = instrumentedProvider(stats);
  // A task that genuinely fans out: each sub-part is independent and the child must return a verbose result that
  // crosses back into the parent window (the history-pressure path).
  const task =
    `Produce a portfolio review of ${width} fictional companies named Co-1 .. Co-${width}. For EACH company, ` +
    `spawn a child to write a detailed ~120-word profile (market, risks, outlook). Then assemble all profiles ` +
    `into one report. Decompose: one child per company.`;
  const out = await recurse(task, { provider }, { maxDepth: 2 });
  const spawned = out.receipts && Array.isArray(out.receipts.spawned) ? out.receipts.spawned.length : 0;
  return { width, peak: stats.peak, calls: stats.calls, spawned, incomplete: !!out.incomplete };
}

console.log(`POC2 history-overflow — ${providerName}, SLM budget=${SLM_BUDGET} tok (tight=${TIGHT_BUDGET})\n`);
console.log('  requested-width  actual-spawns  peak-window(tok)  calls  > tight?  > SLM?');
const rows = [];
for (const w of [3, 6, 9]) {
  const r = await runWidth(w);
  rows.push(r);
  console.log(`  ${String(r.width).padEnd(15)}  ${String(r.spawned).padEnd(13)}  ${String(r.peak).padEnd(16)}  ${String(r.calls).padEnd(5)}  ${r.peak > TIGHT_BUDGET ? 'YES' : 'no '}      ${r.peak > SLM_BUDGET ? 'YES' : 'no'}`);
}

const maxPeak = Math.max(...rows.map((r) => r.peak));
const growth = rows[rows.length - 1].peak - rows[0].peak; // does the window grow with width?
const overflowsSLM = maxPeak > SLM_BUDGET;
const overflowsTight = maxPeak > TIGHT_BUDGET;
console.log(`\n  peak window across all widths = ${maxPeak} tok; growth (width 3→9) = ${growth} tok`);
console.log(`\nVERDICT: history-compaction is ${overflowsSLM ? 'BETTER — windows overflow an 8k SLM, the paper\'s fit(history) is needed' : overflowsTight ? 'MARGINAL — fits 8k but exceeds a tight 4k local model (note it)' : 'RULED OUT — windows stay well under a small-model budget; copy-on-return engineers the pressure away'}`);
process.exit(0);
