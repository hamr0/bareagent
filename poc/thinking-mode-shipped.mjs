// Live SHIPPED smoke for the normalized `thinkingMode` switch. Drives the REAL providers
// (src/provider-*.js) — not raw fetch — off and on per model, and FAILS (non-zero) on any mismatch.
// Keys only from env: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY.
// A missing key is a loud SKIPPED; if every provider is skipped the script exits non-zero (a green
// run that proved nothing is the failure mode this guards against).
//
// Expectations (live-measured, poc/thinking-mode-verify.mjs):
//   off  → thinkingApplied === true (zero thinking signal)   on → thinkingApplied === true (shape accepted)
//   claude-opus-5-5 off and gemini-3.1-pro-preview off → ValidationError BEFORE any request.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AnthropicProvider } = require('../src/provider-anthropic');
const { OpenAIProvider } = require('../src/provider-openai');
const { GeminiProvider } = require('../src/provider-gemini');
const { ValidationError } = require('../src/errors');

const MSGS = [{ role: 'user', content: 'What is 17 * 23? Think it through, then answer with just the number.' }];
const MAX = 2000;

const PROVIDERS = [
  { env: 'ANTHROPIC_API_KEY', name: 'anthropic', make: (key, model) => new AnthropicProvider({ apiKey: key, model }),
    models: [['claude-sonnet-5'], ['claude-haiku-4-5'], ['claude-opus-5-5', { offThrows: true }]] },
  { env: 'OPENAI_API_KEY', name: 'openai', make: (key, model) => new OpenAIProvider({ apiKey: key, model }),
    models: [['gpt-5-mini'], ['gpt-5.4-mini']] },
  { env: 'GEMINI_API_KEY', name: 'gemini', make: (key, model) => new GeminiProvider({ apiKey: key, model }),
    models: [['gemini-2.5-flash'], ['gemini-3.1-pro-preview', { offThrows: true }]] },
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
      if (mode === 'off' && opts.offThrows) {
        const sent = [];
        const origRequest = provider._request.bind(provider);
        provider._request = (...a) => { sent.push(1); return origRequest(...a); };
        try {
          await provider.generate(MSGS, [], { thinkingMode: 'off', maxTokens: MAX });
          fail(`${tag}: expected ValidationError, got a reply`);
        } catch (e) {
          if (!(e instanceof ValidationError)) fail(`${tag}: expected ValidationError, got ${e && e.name}: ${e && e.message}`);
          else if (sent.length !== 0) fail(`${tag}: ValidationError thrown but ${sent.length} request(s) were sent`);
          else console.log(`  ok   ${tag}: threw before sending — ${e.message.slice(0, 110)}`);
        }
        continue;
      }
      try {
        const r = await provider.generate(MSGS, [], { thinkingMode: mode, maxTokens: MAX });
        if (r.thinkingApplied !== true) fail(`${tag}: thinkingApplied=${r.thinkingApplied} (expected true)`);
        else console.log(`  ok   ${tag}: thinkingApplied=true out_tokens=${r.usage && r.usage.outputTokens} text=${JSON.stringify(r.text.slice(0, 30))}`);
      } catch (e) {
        fail(`${tag}: threw ${e && e.name}: ${e && e.message}`);
      }
    }
  }
}

if (ran === 0) { console.log(`\nALL SKIPPED (${skipped} providers) — no key set, nothing was proven. Exiting non-zero.`); process.exit(2); }
if (failures > 0) { console.log(`\n${failures} FAILURE(s) over ${ran} case(s) (${skipped} provider(s) skipped).`); process.exit(1); }
console.log(`\nPASS: ${ran} case(s)${skipped ? `; ${skipped} provider(s) SKIPPED (not proven)` : ''}.`);
