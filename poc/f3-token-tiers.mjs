// POC (F3 / D9 / L7): does the cache-read token tier actually FLOW, and is it dropped+mispriced today?
// Targets OpenAI because it auto-caches prompts >=1024 tokens and returns the discounted tier with NO
// provider opt-in — so the bug bites in practice now (unlike native Anthropic, whose provider sends no
// cache_control, source-confirmed src/provider-openai.js has no details handling / provider-anthropic.js:60).
//
// Riskiest assumptions (this test CAN fail — see notes):
//   A. The live OpenAI API populates usage.prompt_tokens_details.cached_tokens (>0) on a repeated
//      >=1024-token prompt. REAL, uncrafted observation. If caching doesn't engage it stays 0 — a
//      finding (the tier isn't reachable through this path), NOT a pass.
//   B. bareagent's OpenAIProvider.generate() DROPS that tier (the silent-cost defect).
//   C. Mispricing magnitude: cached input bills ~0.5x, so folding it into full-rate input over-prices it.
//
// Never embeds a key. Run:  OPENAI_API_KEY=$(pass amr/openai_api) node poc/f3-token-tiers.mjs
import { OpenAIProvider } from '../src/provider-openai.js';

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('Set OPENAI_API_KEY (e.g. `pass amr/openai_api`). Aborting — no key, no real POC.'); process.exit(2); }

const MODEL = 'gpt-4o-mini'; // cheap. OpenAI auto-caches the prompt prefix once it exceeds 1024 tokens.

// A stable prefix WELL over 1024 tokens (~1500 lines ≈ 9-10k tokens) so prefix caching can engage on
// call 2. Identical across both calls — caching keys on the longest common prefix.
const bigPrefix = 'You are a precise assistant. Reference corpus (treat as ground truth):\n'
  + Array.from({ length: 1500 }, (_, i) => `Record ${i}: token ${i} resolves to shard ${(i * 31) % 97}.`).join('\n');

async function rawCall(label) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      messages: [{ role: 'system', content: bigPrefix }, { role: 'user', content: 'Reply with: ok' }],
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(`${label} HTTP ${res.status}:`, JSON.stringify(data)); process.exit(1); }
  console.log(`[${label}] raw usage =`, JSON.stringify(data.usage));
  return data.usage || {};
}

console.log('--- A. Live OpenAI usage shape (two identical >1024-tok prompts) ---');
const u1 = await rawCall('call-1 (cache write)');
const u2 = await rawCall('call-2 (cache read)');
const cached = u2.prompt_tokens_details?.cached_tokens || 0;
console.log(`\nA-result: call-2 cached_tokens = ${cached} (prompt_tokens=${u2.prompt_tokens || 0}).`);
if (cached === 0) console.log('  ⚠️ cached_tokens=0 — prefix caching did NOT engage; tier unreachable via this path (FINDING, not pass). Retry: prompt larger / calls closer together.');

// C. Mispricing: gpt-4o-mini input $0.15/MTok; cached input $0.075/MTok (0.5x). Folding cached into
//    full-rate input over-prices the cached portion 2x.
console.log(`  C mispricing: ${cached} cached tok @ full ($0.15/MTok)=$${(cached * 0.15 / 1e6).toFixed(8)} vs correct 0.5x=$${(cached * 0.075 / 1e6).toFixed(8)}`);

// B. What does the CURRENT bareagent provider surface?
console.log('\n--- B. Current bareagent OpenAIProvider.generate() usage ---');
const provider = new OpenAIProvider({ apiKey: KEY, model: MODEL });
const r = await provider.generate(
  [{ role: 'system', content: bigPrefix }, { role: 'user', content: 'Reply with: ok' }], [], {},
);
console.log('provider usage =', JSON.stringify(r.usage));
const surfacesCacheRead = 'cacheReadTokens' in r.usage;
console.log(`B-result: provider ${surfacesCacheRead ? 'surfaces' : 'DROPS'} the cache-read tier`
  + ` — keys present: [${Object.keys(r.usage).join(', ')}] (expect input/output only, pre-fix).`);

console.log('\n=== POC verdict ===');
console.log(`A live tier populated: ${cached > 0}`);
console.log(`B provider drops it:   ${!surfacesCacheRead}`);
console.log('C native-Anthropic path: LATENT (provider sends no cache_control — source-confirmed); OpenAI is the live-biting case.');
