// DEFERRED-ITEM POC 3/3 — calibration knobs (scan window), RULED IN OR OUT. This one CAN FLIP the "leave
// deferred" judgement: it tests whether the locked window=8 is DATA-DEPENDENT. If the scan recall knee moves
// with item LENGTH, then a single fixed window is fragile and the deferred AUTO-CALIBRATION (measure → pick the
// window) genuinely beats the fixed default. If the knee stays ~8 regardless, the fixed default is robust.
//
// IMPORTANT: this does NOT re-run the settled AG-News window study (forbidden). It uses a DIFFERENT, length-
// controlled corpus to test GENERALIZATION of the number — a distinct question from "where is AG News' knee."
//
// DESIGN (able-to-fail): two corpora, identical sentiment truth, differing only in item LENGTH (short ~12 words
// vs long ~70 words, same sentiment padded with same-polarity sentences so truth is unchanged + code-known).
// Sweep window ∈ {4, 8, 16}, passes=1, and measure recall vs the code-known positive count for each cell.
//   - If recall@8 is high for SHORT but collapses for LONG (knee shifts down) ⇒ window is length-dependent ⇒
//     AUTO-CALIBRATION WINS (the deferral is real; a fixed 8 is wrong for long items).
//   - If recall@8 holds across both lengths ⇒ fixed default ROBUST ⇒ calibration ruled OUT.
//
// Run:  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-defer3-calibration-sweep.mjs

import { AnthropicProvider } from '../src/provider-anthropic.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { scanCount } from '../src/recurse-retrieval.js';

let provider, providerName;
if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else { console.error('needs ANTHROPIC_API_KEY or OPENAI_API_KEY'); process.exit(1); }

// Natural, varied sentiment sentences (NOT crafted toward a count — the count emerges from the even/odd split).
const POS = ['I love this and use it every day.', 'It exceeded my expectations completely.', 'Reliable, well built, and worth the price.', 'The best purchase I have made this year.', 'Works perfectly and looks great too.', 'Genuinely delighted with how it performs.'];
const NEG = ['I regret buying this entirely.', 'It failed within the first week.', 'Cheap feeling and poorly made.', 'A frustrating, disappointing experience.', 'It stopped working and support ignored me.', 'Nothing about this lived up to the claims.'];
// same-polarity filler to LENGTHEN an item without changing its sentiment (truth stays code-known)
const POS_FILL = 'Setup was smooth, the materials feel premium, friends have asked where I got it, and I would happily buy it again without hesitation.';
const NEG_FILL = 'The packaging was already damaged, the instructions were useless, two parts were missing, and getting a refund turned into a drawn-out ordeal.';

function corpus(n, { long }) {
  const out = []; let truth = 0;
  for (let i = 0; i < n; i++) {
    const positive = i % 2 === 0; if (positive) truth++;
    let text = (positive ? POS : NEG)[i % 6];
    if (long) text += ' ' + (positive ? POS_FILL : NEG_FILL) + ' ' + (positive ? POS_FILL : NEG_FILL); // ~70 words
    out.push({ id: `it:${i}`, text });
  }
  return { items: out, truth, words: Math.round(out.reduce((s, r) => s + r.text.split(/\s+/).length, 0) / out.length) };
}

const PRED = 'positive reviews where the customer is satisfied or recommends the product';
const N = 48;

async function sweep(label, c) {
  console.log(`\n  ${label} corpus (${N} items, ~${c.words} words/item, truth=${c.truth} positive):`);
  console.log('    window  recall  precision  count  (truth ' + c.truth + ')');
  const recalls = {};
  for (const window of [4, 8, 16]) {
    const scan = await scanCount(PRED, c.items, { provider, window, passes: 1 });
    const truthIds = new Set(c.items.filter((_, i) => i % 2 === 0).map((r) => r.id));
    let tp = 0; for (const id of scan.matchedIds) if (truthIds.has(id)) tp++;
    const recall = tp / c.truth, precision = scan.matchedIds.length ? tp / scan.matchedIds.length : 0;
    recalls[window] = recall;
    console.log(`    ${String(window).padEnd(6)}  ${recall.toFixed(2)}    ${precision.toFixed(2)}       ${scan.count}`);
  }
  return recalls;
}

console.log(`POC3 calibration — scan window sweep vs item length — ${providerName}`);
const shortR = await sweep('SHORT', corpus(N, { long: false }));
const longR = await sweep('LONG', corpus(N, { long: true }));

// The load-bearing comparison: does recall@8 hold across lengths, or does the knee move?
const drop8 = shortR[8] - longR[8];                 // how much window=8 degrades on long items
const longBest = Math.max(longR[4], longR[8], longR[16]);
const longBestWin = [4, 8, 16].find((w) => longR[w] === longBest);
console.log(`\n  recall@window=8:  short=${shortR[8].toFixed(2)}  long=${longR[8].toFixed(2)}  (drop=${drop8.toFixed(2)})`);
console.log(`  long-item best window = ${longBestWin} (recall ${longBest.toFixed(2)})`);
// Auto-calibration wins if a fixed 8 materially under-serves long items AND a different window clearly does better.
const dataDependent = drop8 >= 0.15 && longBestWin !== 8 && (longBest - longR[8]) >= 0.10;
console.log(`\nVERDICT: scan-window auto-calibration is ${dataDependent ? 'BETTER — the knee is DATA-DEPENDENT (window=8 under-serves long items; a fixed default is fragile) ⇒ FLIPS the deferral' : 'RULED OUT — window=8 holds across item lengths; the fixed default is robust'}`);
process.exit(0);
