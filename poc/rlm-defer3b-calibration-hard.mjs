// DEFERRED-ITEM POC 3b/3 — calibration RE-RUN, HARDER (the 3a corpus was too easy: recall 1.00 at every window,
// so no knee formed and the test couldn't distinguish). This version uses a SUBTLE, confusable predicate (find
// the REFUND/billing-dispute messages among 5 adjacent support categories — login, shipping, product, feature,
// praise) on LONG, dense items, swept up to window=24, single pass — conditions that actually induce a real
// recall KNEE (the judge under-enumerates a window packed with too much confusable text). Then we ask the only
// question that matters for the deferral: does the knee MOVE with item length?
//   - long-item knee at a SMALLER window than short ⇒ window=8 is DATA-DEPENDENT ⇒ auto-calibration WINS (flip).
//   - knee in the same place for both ⇒ fixed window=8 robust ⇒ calibration ruled OUT (now with a real knee).
//
// Run:  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-defer3b-calibration-hard.mjs

import { AnthropicProvider } from '../src/provider-anthropic.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { scanCount } from '../src/recurse-retrieval.js';

let provider, providerName;
if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else { console.error('needs ANTHROPIC_API_KEY or OPENAI_API_KEY'); process.exit(1); }

// TARGET = refund/billing-dispute. The 5 NON-target categories are deliberately adjacent (a support agent could
// confuse them), so a judge skimming a dense window misses some — the mechanism that creates a knee.
const REFUND = ['I was charged twice for the same order and need one payment reversed.', 'Please refund me — the amount billed is higher than the price I agreed to.', 'I am disputing this charge; cancel it and return my money.', 'You took a subscription fee after I cancelled; I want that money back.', 'My card was billed for an item I never received and I want a refund.', 'There is a duplicate charge on my statement — please reverse it.'];
const SHIPPING = ['My package is three days late and the tracking has not updated.', 'The courier marked it delivered but nothing arrived at my door.', 'Can you tell me when my order will actually ship out?', 'The box arrived crushed and one item inside was broken.', 'I need to change the delivery address before it ships.', 'Shipping is taking far longer than the estimate you gave.'];
const LOGIN = ['I cannot sign in — it says my password is wrong every time.', 'My account is locked after a few login attempts; please unlock it.', 'The password reset email never arrives in my inbox.', 'Two-factor codes are not being sent to my phone anymore.', 'I am stuck on the login screen and the page keeps reloading.', 'It will not accept my username even though it is correct.'];
const PRODUCT = ['Does this model work with a 240-volt outlet in Europe?', 'How long does the battery last on a single full charge?', 'Is the casing waterproof or only splash resistant?', 'What is the maximum weight this stand can hold?', 'Can I connect two of these together at once?', 'Which replacement filters fit this particular unit?'];
const OTHER = ['It would be great if you added a dark mode in the app.', 'Please consider supporting exports to a spreadsheet format.', 'A weekly summary email would be a really useful feature.', 'I love this product and tell all my friends about it.', 'Thank you, the support team was wonderful to deal with.', 'Honestly the best purchase I have made all year.'];
const NON = [SHIPPING, LOGIN, PRODUCT, OTHER];
// same-category filler to lengthen an item WITHOUT changing its category (truth stays code-known)
const FILL = {
  refund: ' I have attached the statement showing the disputed line, I have already contacted my bank about it, and I would like written confirmation once the reversal is processed because this has happened before.',
  other: ' I have been a customer for a couple of years now, I use it most days, and I just wanted to pass along the context in case it is useful for your records and planning going forward.',
};

function corpus(n, { long }) {
  const out = []; const truthIds = new Set();
  for (let i = 0; i < n; i++) {
    const isRefund = i % 3 === 0; // 1/3 are the TARGET
    let text;
    if (isRefund) { text = REFUND[i % 6]; truthIds.add(`m:${i}`); if (long) text += FILL.refund + FILL.refund; }
    else { const cat = NON[i % NON.length]; text = cat[i % 6]; if (long) text += FILL.other + FILL.other; }
    out.push({ id: `m:${i}`, text });
  }
  return { items: out, truth: truthIds.size, truthIds, words: Math.round(out.reduce((s, r) => s + r.text.split(/\s+/).length, 0) / out.length) };
}

const PRED = 'messages where the customer is requesting a REFUND or disputing/contesting a billing charge (money back) — NOT shipping/delivery, NOT login/account access, NOT product questions, NOT feature requests or praise';
const N = 48;
const WINDOWS = [4, 8, 12, 16, 24];

async function sweep(label, c) {
  console.log(`\n  ${label} corpus (${N} items, ~${c.words} words/item, truth=${c.truth} refund):`);
  console.log('    window  recall  precision  count  (truth ' + c.truth + ')');
  const recalls = {};
  for (const window of WINDOWS) {
    const scan = await scanCount(PRED, c.items, { provider, window, passes: 1 });
    let tp = 0; for (const id of scan.matchedIds) if (c.truthIds.has(id)) tp++;
    const recall = tp / c.truth, precision = scan.matchedIds.length ? tp / scan.matchedIds.length : 0;
    recalls[window] = recall;
    console.log(`    ${String(window).padEnd(6)}  ${recall.toFixed(2)}    ${precision.toFixed(2)}       ${scan.count}`);
  }
  return recalls;
}

console.log(`POC3b calibration (HARDER) — refund-needle scan, window sweep vs item length — ${providerName}`);
const shortR = await sweep('SHORT', corpus(N, { long: false }));
const longR = await sweep('LONG', corpus(N, { long: true }));

// knee = the largest window still within 0.05 of that length's best recall (where it starts to collapse past).
const knee = (R) => { const best = Math.max(...WINDOWS.map((w) => R[w])); let k = WINDOWS[0]; for (const w of WINDOWS) if (R[w] >= best - 0.05) k = w; return { knee: k, best }; };
const ks = knee(shortR), kl = knee(longR);
const sawAKnee = Math.min(...WINDOWS.map((w) => Math.min(shortR[w], longR[w]))) < 0.85; // did recall ever collapse?
console.log(`\n  recall@window=8:  short=${shortR[8].toFixed(2)}  long=${longR[8].toFixed(2)}`);
console.log(`  short knee window=${ks.knee} (best ${ks.best.toFixed(2)});  long knee window=${kl.knee} (best ${kl.best.toFixed(2)})`);
console.log(`  a real recall knee ${sawAKnee ? 'DID' : 'did NOT'} form (recall collapsed somewhere: ${sawAKnee})`);

const kneeMoved = kl.knee < ks.knee && (shortR[8] - longR[8]) >= 0.10;
let verdict;
if (!sawAKnee) verdict = 'INCONCLUSIVE AGAIN — still too easy (no collapse); window=8 does not break, but the knee was not stressed';
else if (kneeMoved) verdict = 'BETTER — the knee MOVED with item length (long items need a smaller window) ⇒ auto-calibration WINS, FLIP the deferral';
else verdict = 'RULED OUT (with a real knee this time) — the knee did not move with length; fixed window=8 is robust';
console.log(`\nVERDICT: scan-window auto-calibration is ${verdict}`);
process.exit(0);
