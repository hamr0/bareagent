// F1 AGENTIC — Gap #2 validation: the critic drives a REAL headless browser (barebrowse) against a LIVE
// page, not the in-process code-execution stand-in of poc/f1-agentic-calibration.mjs.
//
// The falsifiable trick: the GOOD and BAD pages are byte-identical in their static markup — same heading,
// same "Load" button, same initial text. They differ ONLY in what clicking the button does:
//   - GOOD: click → the page shows "Data loaded: 3 items"
//   - BAD : click → the page shows "Error: could not load data"
// So a critic that merely READS the initial snapshot sees two identical pages and CANNOT tell them apart.
// The only way to a correct verdict is to actually CLICK and re-observe — i.e. exercise the live artifact.
// That is exactly the agentic mode's claim, now tested through a real browser.
//
// Validation (must be able to FAIL — exit 1):
//   - GOOD → satisfied / pass:true
//   - BAD  → NOT satisfied
//   - BOTH must have actually clicked (click-count > 0) — a verdict with zero clicks is the snapshot-reading
//     shortcut, which on these pages cannot have distinguished them → FAIL.
//
// Run (provide your own key — never hardcode):
//   ANTHROPIC_API_KEY=$(pass amr/claude_api)  node poc/f1-agentic-barebrowse.mjs
//   OPENAI_API_KEY=$(pass amr/openai_api)     node poc/f1-agentic-barebrowse.mjs

import http from 'node:http';
import { Evaluator } from '../src/evaluator.js';
import { createBrowsingTools } from '../tools/browse.js';
import { OpenAIProvider } from '../src/provider-openai.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';

const provider = process.env.ANTHROPIC_API_KEY
  ? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-haiku-4-5' })
  : process.env.OPENAI_API_KEY
    ? new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' })
    : null;

if (!provider) {
  console.error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run this validation.');
  process.exit(2);
}

// Two pages, identical static markup, divergent click behaviour. The brokenness is observable ONLY by
// clicking — reading the initial DOM cannot reveal it.
//
// The post-click signal is injected as a LINK, not static text: barebrowse's 'act' snapshot pruning keeps
// interactive elements (links/buttons/headings) but DROPS static text (a <p>/<h2> body is pruned away), so
// a text result would be invisible to the critic. A link with the result as its accessible name survives
// pruning and is observable (verified deterministically against barebrowse 0.5.0 while building this).
const page = (onclickResult) => `<!doctype html><html><head><title>Dashboard</title></head><body>
<h1>Dashboard</h1>
<button id="load" onclick="document.body.insertAdjacentHTML('beforeend', '<a href=&quot;javascript:void(0)&quot; id=result>${onclickResult}</a>')">Load</button>
</body></html>`;
const GOOD_HTML = page('Data loaded: 3 items');
const BAD_HTML = page('Error: could not load data');

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/good')) return res.end(GOOD_HTML);
  if (req.url.startsWith('/bad')) return res.end(BAD_HTML);
  res.statusCode = 404; res.end('not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = (p) => `http://127.0.0.1:${port}/${p}`;

const browsing = await createBrowsingTools({ headless: true });
if (!browsing) { console.error('barebrowse not available'); process.exit(2); }

// Wrap each browser tool so we can prove the critic actually drove it (and count clicks specifically).
const counts = { click: 0, total: 0 };
const tools = browsing.tools.map(t => ({
  ...t,
  execute: async (/** @type {any} */ args) => {
    counts.total++;
    if (t.name === 'click') counts.click++;
    return t.execute(args);
  },
}));

const goal = 'A dashboard page whose "Load" button works.';
const contract = [
  'MUST: clicking the button labelled "Load" makes the exact text "Data loaded: 3 items" appear on the page.',
  'NOTE: the static markup alone does NOT satisfy this — the click behaviour must actually work.',
].join('\n');
const instructions = 'Navigate to the URL in ARTIFACT UNDER REVIEW. Do NOT judge from the initial snapshot — the page looks the same whether or not it works. You MUST click the "Load" button and then re-snapshot to observe what text actually appears. Base your verdict ONLY on the post-click observed state.';

async function judge(label, p) {
  counts.click = 0; counts.total = 0;
  const ev = new Evaluator({ provider, tools });
  const v = await ev.evaluate(goal, `Open and exercise this page: ${url(p)}`, { agentic: instructions, contract });
  console.log(`${label} → toolCalls=${counts.total} clicks=${counts.click} ${JSON.stringify(v)}`);
  return { v, clicked: counts.click > 0 };
}

let exitCode = 1;
try {
  const g = await judge('GOOD', 'good');
  const b = await judge('BAD ', 'bad');

  const goodOk = g.v.pass === true;
  const badOk = b.v.pass === false;
  const clickedBoth = g.clicked && b.clicked;
  if (goodOk && badOk && clickedBoth) {
    console.log('\n✅ VALIDATED (live browser) — clicked through a real page, passed known-good, rejected the click-broken page.');
    exitCode = 0;
  } else {
    console.error(`\n❌ FAILED — goodPassed=${goodOk} badRejected=${badOk} clickedBoth=${clickedBoth}. The critic did not genuinely exercise the live page.`);
  }
} finally {
  if (browsing.close) await browsing.close();
  server.close();
}
process.exit(exitCode);
