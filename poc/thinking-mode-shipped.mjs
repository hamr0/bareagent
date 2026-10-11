// Live SHIPPED smoke for the normalized `thinkingMode` switch. Drives the REAL providers
// (src/provider-*.js) — not raw fetch — off and on per model, and FAILS (non-zero) on any mismatch.
// Keys only from env: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY.
// A missing key is a loud SKIPPED; if every provider is skipped the script exits non-zero (a green
// run that proved nothing is the failure mode this guards against).
//
// Expectations (live-measured, poc/thinking-mode-verify.mjs):
//   off  → thinkingStatus === 'applied' (zero thinking signal)   on → thinkingStatus === 'applied' (shape accepted)
//   claude-opus-5-5 off and gemini-3.1-pro-preview off → the call RUNS (exactly one request, no thinking
//     field), returns text, thinkingStatus === 'unsupported' (not an error).
//   deepseek-flash on + toolChoice 'required' + one dummy tool → RUNS, calls the tool, thinkingStatus 'unsupported'.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AnthropicProvider } = require('../src/provider-anthropic');
const { OpenAIProvider } = require('../src/provider-openai');
const { GeminiProvider } = require('../src/provider-gemini');

const MSGS = [{ role: 'user', content: 'What is 17 * 23? Think it through, then answer with just the number.' }];
const MAX = 2000;

const PROVIDERS = [
  { env: 'ANTHROPIC_API_KEY', name: 'anthropic', make: (key, model) => new AnthropicProvider({ apiKey: key, model }),
    models: [['claude-sonnet-5'], ['claude-haiku-4-5'], ['claude-opus-5-5', { offUnsupported: true }]] },
  { env: 'OPENAI_API_KEY', name: 'openai', make: (key, model) => new OpenAIProvider({ apiKey: key, model }),
    models: [['gpt-5-mini'], ['gpt-5.4-mini']] },
  { env: 'GEMINI_API_KEY', name: 'gemini', make: (key, model) => new GeminiProvider({ apiKey: key, model }),
    models: [['gemini-2.5-flash'], ['gemini-3.1-pro-preview', { offUnsupported: true }]] },
  { env: 'DEEPSEEK_API_KEY', name: 'deepseek', make: (key, model) => new OpenAIProvider({ apiKey: key, model, baseUrl: 'https://api.deepseek.com' }),
    models: [['deepseek-flash']] },
];

let ran = 0, skipped = 0, failures = 0;
const fail = (m) => { failures++; console.log(`  FAIL ${m}`); };

for (const p of PROVIDERS) {
  const key = process.env[p.env];
  if (!key) { skipped++; console.log(`SKIPPED ${p.name}: ${p.env} not set — nothing proven for ${p.models.map((m) => m[0]).join(', ')}`); continue; }
  for (const [model, opts = {}] of p.models) {
    for (const mode of ['off', 'on']) {
      const tag = `${p.name}/${model} thinkingMode=${mode}`;
      const provider = p.make(key, model);
      ran++;
      if (mode === 'off' && opts.offUnsupported) {
        const sent = [];
        const origRequest = provider._request.bind(provider);
        provider._request = (...a) => { sent.push(a.find((x) => x && typeof x === 'object' && !Array.isArray(x))); return origRequest(...a); };
        try {
          const r = await provider.generate(MSGS, [], { thinkingMode: 'off', maxTokens: MAX });
          const hasField = sent[0] && ('thinking' in sent[0] || (sent[0].generationConfig && 'thinkingConfig' in sent[0].generationConfig));
          if (r.thinkingStatus !== 'unsupported') fail(`${tag}: thinkingStatus=${r.thinkingStatus} (expected 'unsupported')`);
          else if (r.thinkingApplied !== false) fail(`${tag}: thinkingApplied=${r.thinkingApplied} (expected false)`);
          else if (!r.text) fail(`${tag}: ran but returned no text`);
          else if (sent.length !== 1) fail(`${tag}: ${sent.length} request(s) sent (expected exactly 1)`);
          else if (hasField) fail(`${tag}: the request still carried a thinking field`);
          else console.log(`  ok   ${tag}: ran, thinkingStatus=unsupported, 1 request, no thinking field, text=${JSON.stringify(r.text.slice(0, 30))}`);
        } catch (e) {
          fail(`${tag}: threw ${e && e.name}: ${e && e.message} (must RUN, not throw)`);
        }
        continue;
      }
      try {
        const r = await provider.generate(MSGS, [], { thinkingMode: mode, maxTokens: MAX });
        if (r.thinkingStatus !== 'applied') fail(`${tag}: thinkingStatus=${r.thinkingStatus} (expected 'applied')`);
        else if (r.thinkingApplied !== true) fail(`${tag}: thinkingApplied=${r.thinkingApplied} (expected true)`);
        else console.log(`  ok   ${tag}: thinkingStatus=applied out_tokens=${r.usage && r.usage.outputTokens} text=${JSON.stringify(r.text.slice(0, 30))}`);
      } catch (e) {
        fail(`${tag}: threw ${e && e.name}: ${e && e.message}`);
      }
    }
  }
}

// thinking-on + non-default temperature (live-confirms the "thinking wins" drop; prints the raw first 400).
if (process.env.ANTHROPIC_API_KEY) {
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-5']) {
    const tag = `anthropic/${model} thinkingMode=on temperature=0.5`;
    const provider = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model, exposeErrorBody: true });
    const orig = provider._request.bind(provider);
    let first400 = null;
    provider._request = async (...a) => {
      try { return await orig(...a); } catch (e) { if (e && e.status === 400 && first400 === null) first400 = `${e.message}${e.body ? ' | body=' + JSON.stringify(e.body) : ''}`; throw e; }
    };
    ran++;
    try {
      const r = await provider.generate(MSGS, [], { thinkingMode: 'on', temperature: 0.5, maxTokens: MAX });
      console.log(`  info ${tag}: temperatureDropped=${r.temperatureDropped === true} first400=${first400 === null ? '(none)' : first400}`);
      if (r.thinkingStatus !== 'applied') fail(`${tag}: thinkingStatus=${r.thinkingStatus} (expected 'applied')`);
      else console.log(`  ok   ${tag}: no throw, thinkingStatus=applied`);
    } catch (e) {
      fail(`${tag}: threw ${e && e.name}: ${e && e.message} (first400=${first400})`);
    }
  }
}

// DeepSeek thinking-on + a forced tool choice cannot work: it must RUN (thinking disabled), call the tool, report unsupported.
if (process.env.DEEPSEEK_API_KEY) {
  const tag = 'deepseek/deepseek-flash thinkingMode=on toolChoice=required + 1 tool';
  const provider = new OpenAIProvider({ apiKey: process.env.DEEPSEEK_API_KEY, model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
  const tools = [{ name: 'answer', description: 'Submit the final numeric answer.', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }];
  ran++;
  try {
    const r = await provider.generate(MSGS, tools, { thinkingMode: 'on', toolChoice: 'required', maxTokens: MAX });
    if (r.thinkingStatus !== 'unsupported') fail(`${tag}: thinkingStatus=${r.thinkingStatus} (expected 'unsupported')`);
    else if (r.thinkingApplied !== false) fail(`${tag}: thinkingApplied=${r.thinkingApplied} (expected false)`);
    else if (!r.toolCalls.some((c) => c.name === 'answer')) fail(`${tag}: the forced tool was not called (toolCalls=${JSON.stringify(r.toolCalls)})`);
    else console.log(`  ok   ${tag}: ran, called the tool, thinkingStatus=unsupported`);
  } catch (e) {
    fail(`${tag}: threw ${e && e.name}: ${e && e.message} (must RUN, not throw)`);
  }
}

// The ladder WALKED for real: gpt-5-nano is not in the measured table ('unverified'), so 'off' starts at
// reasoning_effort:'none'; the gpt-5 family 400s on it and 'minimal' should then be accepted.
if (process.env.OPENAI_API_KEY) {
  const tag = 'openai/gpt-5-nano thinkingMode=off (ladder walk)';
  const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-5-nano' });
  const sent = [];
  let first400 = null;
  const orig = provider._request.bind(provider);
  provider._request = async (...a) => {
    sent.push(a.find((x) => x && typeof x === 'object' && !Array.isArray(x)));
    try { return await orig(...a); } catch (e) { if (e && e.status === 400 && first400 === null) first400 = e.message; throw e; }
  };
  ran++;
  try {
    const r = await provider.generate(MSGS, [], { thinkingMode: 'off', maxTokens: MAX });
    const efforts = sent.map((b) => b && b.reasoning_effort);
    console.log(`  info ${tag}: requests=${sent.length} efforts=${JSON.stringify(efforts)} thinkingStatus=${r.thinkingStatus} first400=${first400 === null ? '(none)' : JSON.stringify(first400)}`);
    if (sent.length === 1 && efforts[0] === 'none' && r.thinkingStatus === 'applied') {
      console.log(`  info ${tag}: the API accepted 'none' outright — ladder not walked on this model today (not a failure)`);
    } else if (sent.length < 2) fail(`${tag}: ${sent.length} request(s) (expected >= 2 to walk the ladder)`);
    else if (efforts[0] !== 'none') fail(`${tag}: first request effort=${efforts[0]} (expected 'none')`);
    else if (efforts[efforts.length - 1] !== 'minimal') fail(`${tag}: accepted request effort=${efforts[efforts.length - 1]} (expected 'minimal')`);
    else if (r.thinkingStatus !== 'applied') fail(`${tag}: thinkingStatus=${r.thinkingStatus} (expected 'applied')`);
    else console.log(`  ok   ${tag}: ladder walked none -> minimal, thinkingStatus=applied`);
  } catch (e) {
    fail(`${tag}: threw ${e && e.name}: ${e && e.message} (first400=${first400})`);
  }
}

if (ran === 0) { console.log(`\nALL SKIPPED (${skipped} providers) — no key set, nothing was proven. Exiting non-zero.`); process.exit(2); }
if (failures > 0) { console.log(`\n${failures} FAILURE(s) over ${ran} case(s) (${skipped} provider(s) skipped).`); process.exit(1); }
console.log(`\nPASS: ${ran} case(s)${skipped ? `; ${skipped} provider(s) SKIPPED (not proven)` : ''}.`);
