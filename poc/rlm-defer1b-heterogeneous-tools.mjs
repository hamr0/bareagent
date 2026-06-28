// DEFERRED-ITEM POC 1b — RC-4 triangulation, DIFFERENT method + WEAK model. POC1 used same-family arithmetic
// tools on haiku (strong). This uses HETEROGENEOUS tools with deliberately OVERLAPPING descriptions (three
// "search" tools + a DB query + an employee lookup — the realistic confusion case) on the WEAK model where
// misrouting is most likely (gpt-4o-mini, RLM's target tier). If even here the all-tools worker routes to the
// capability-correct tool, RC-4 is robustly ruled out; if it misroutes, RC-4 (scoping to the matched tool) has
// value for weak models.
//
// Metric: RIGHT-TOOL rate (did it call the capability-correct tool?). The "matched" arm is trivially 100% (only
// the right tool offered), so the whole question is whether the ALL-TOOLS arm degrades.
//
// Run:  OPENAI_API_KEY=$(pass amr/openai_api) node poc/rlm-defer1b-heterogeneous-tools.mjs
//   or  ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/rlm-defer1b-heterogeneous-tools.mjs

import { Loop } from '../index.js';
import { AnthropicProvider } from '../src/provider-anthropic.js';
import { OpenAIProvider } from '../src/provider-openai.js';

let provider, providerName;
if (process.env.OPENAI_API_KEY) { provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }); providerName = 'openai/gpt-4o-mini'; }
else if (process.env.ANTHROPIC_API_KEY) { provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }); providerName = 'anthropic/claude-haiku-4-5'; }
else { console.error('needs OPENAI_API_KEY or ANTHROPIC_API_KEY'); process.exit(1); }

// Heterogeneous tools — the three search_* + lookup/query cluster have OVERLAPPING descriptions (the confusable
// case RC-4 would target). Each returns a stub; we only care which one the model PICKS.
const TOOLDEFS = [
  ['search_web', 'Search the public internet / world wide web for general facts and current events.', 'query'],
  ['search_internal_docs', 'Search the COMPANY\'S internal documentation, policies, and runbooks.', 'query'],
  ['search_codebase', 'Search the SOURCE CODE repository for functions, files, and symbols.', 'query'],
  ['lookup_employee', 'Look up an EMPLOYEE\'S contact details (phone, desk, manager) in the staff directory.', 'name'],
  ['query_database', 'Run a read-only SQL query against the PRODUCTION application database (orders, users, metrics).', 'sql'],
  ['get_weather', 'Get the current WEATHER and forecast for a city.', 'city'],
  ['convert_currency', 'Convert an amount of MONEY from one currency to another at today\'s rate.', 'spec'],
  ['translate_text', 'TRANSLATE a phrase from one natural language to another.', 'text'],
  ['calculator', 'Evaluate an ARITHMETIC expression.', 'expr'],
  ['calendar_lookup', 'Find the DAY OF THE WEEK or date arithmetic for a calendar date.', 'date'],
];
function toolsFor(names, record) {
  return TOOLDEFS.filter(([n]) => names.includes(n)).map(([name, description, arg]) => ({
    name, description,
    parameters: { type: 'object', properties: { [arg]: { type: 'string' } }, required: [arg] },
    execute: async () => { record.push(name); return 'ok (stub result)'; },
  }));
}

// Each task needs EXACTLY ONE capability-correct tool (code-known). Weighted toward the confusable search cluster.
const TASKS = [
  ['What is the capital of New Zealand?', 'search_web'],
  ['Find our internal data-retention policy document.', 'search_internal_docs'],
  ['Where is the function that validates email addresses defined?', 'search_codebase'],
  ['What is Priya Nair\'s phone extension?', 'lookup_employee'],
  ['How many orders were placed yesterday?', 'query_database'],
  ['Which file contains the retry-backoff logic?', 'search_codebase'],
  ['What does our refund-approval runbook say to do?', 'search_internal_docs'],
  ['Who is the latest Nobel Peace Prize laureate?', 'search_web'],
  ['List the top 5 customers by total spend.', 'query_database'],
  ['Find the desk location and manager of Tom Becker.', 'lookup_employee'],
  ['Is it going to rain in Lisbon tomorrow?', 'get_weather'],
  ['Convert 250 GBP to Japanese yen.', 'convert_currency'],
  ['Translate "thank you very much" into German.', 'translate_text'],
  ['What is 1234 multiplied by 56?', 'calculator'],
  ['What day of the week is 2027-01-01?', 'calendar_lookup'],
  ['Search the repo for where the auth token is signed.', 'search_codebase'],
];
const ALL = TOOLDEFS.map(([n]) => n);

async function runArm(label, pick) {
  let right = 0;
  for (const [q, correct] of TASKS) {
    const record = [];
    const tools = toolsFor(pick(correct), record);
    const loop = new Loop({ provider, system: 'Pick the single most appropriate tool for the request and call it. Then answer briefly.', throwOnError: false });
    await loop.run([{ role: 'user', content: q }], tools, {});
    if (record.length && record[0] === correct) right++;
  }
  const acc = right / TASKS.length;
  console.log(`  ${label.padEnd(20)} right-tool=${right}/${TASKS.length}  (${(100 * acc).toFixed(0)}%)`);
  return acc;
}

console.log(`POC1b RC-4 (heterogeneous, overlapping descriptions) — ${providerName}, ${TASKS.length} tasks\n`);
const accAll = await runArm('all-tools(10)', () => ALL);
const accMatched = await runArm('matched(1 tool)', (correct) => [correct]);
const gain = accMatched - accAll;
console.log(`\n  matched − all-tools = ${(100 * gain).toFixed(0)} pp`);
const ruledIn = gain >= 0.10;
console.log(`\nVERDICT: RC-4 is ${ruledIn ? 'BETTER on the weak model — all-tools misroutes, matching helps' : 'RULED OUT even on the weak model with confusable tools — all-tools routes correctly'} (all-tools ${(100 * accAll).toFixed(0)}% vs matched ${(100 * accMatched).toFixed(0)}%)`);
process.exit(0);
