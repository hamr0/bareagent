// POC (F3 / Gemini): decide reuse-vs-native. Load-bearing unknown: does Gemini's OpenAI-COMPAT
// endpoint surface the cached tier as prompt_tokens_details.cached_tokens? If yes → Gemini works
// through the EXISTING OpenAIProvider (baseUrl override) with the fix I'm already making, no new
// provider. If no → small native provider keyed on usageMetadata.cachedContentTokenCount.
//
// Probes three things so the answer is unambiguous (and CAN fail):
//   A. OpenAI-compat endpoint usage shape — is cached_tokens present + populated on call 2?
//   B. NATIVE endpoint usageMetadata — does cachedContentTokenCount populate at all? (proves the data
//      EXISTS even if compat hides it; distinguishes "compat doesn't surface it" from "caching didn't engage")
//   C. Through bareagent's OpenAIProvider pointed at the compat baseUrl — does the reuse path carry it?
//
// Implicit caching is best-effort: cached_tokens may be 0 (a FINDING, not a pass) if it didn't engage.
// Run:  GEMINI_API_KEY=$(pass amr/gemini_api) node poc/f3-gemini-tiers.mjs
import { OpenAIProvider } from '../src/provider-openai.js';

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('Set GEMINI_API_KEY (e.g. `pass amr/gemini_api`). Aborting — no key, no real POC.'); process.exit(2); }

const MODEL = 'gemini-2.5-flash';             // implicit caching auto-on for 2.5 models (min ~1024 tok)
const COMPAT = 'https://generativelanguage.googleapis.com/v1beta/openai';
const NATIVE = 'https://generativelanguage.googleapis.com/v1beta';

// Stable prefix well above the implicit-cache threshold (~2000 lines ≈ 24k tokens), identical per call.
const bigPrefix = 'You are a precise assistant. Reference corpus (treat as ground truth):\n'
  + Array.from({ length: 2000 }, (_, i) => `Record ${i}: token ${i} resolves to shard ${(i * 31) % 97}.`).join('\n');

async function compatCall(label) {
  const res = await fetch(`${COMPAT}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 8,
      messages: [{ role: 'system', content: bigPrefix }, { role: 'user', content: 'Reply with: ok' }] }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(`${label} HTTP ${res.status}:`, JSON.stringify(data).slice(0, 400)); process.exit(1); }
  console.log(`[compat ${label}] usage =`, JSON.stringify(data.usage));
  return data.usage || {};
}

async function nativeCall(label) {
  const res = await fetch(`${NATIVE}/models/${MODEL}:generateContent?key=${KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: bigPrefix }] },
      contents: [{ role: 'user', parts: [{ text: 'Reply with: ok' }] }],
      generationConfig: { maxOutputTokens: 8 },
    }),
  });
  const data = await res.json();
  if (!res.ok) { console.error(`${label} HTTP ${res.status}:`, JSON.stringify(data).slice(0, 400)); process.exit(1); }
  console.log(`[native ${label}] usageMetadata =`, JSON.stringify(data.usageMetadata));
  return data.usageMetadata || {};
}

console.log('--- A. OpenAI-COMPAT endpoint (decides reuse vs native) ---');
await compatCall('call-1');
const c2 = await compatCall('call-2');
const compatCached = c2.prompt_tokens_details?.cached_tokens || 0;
const compatHasField = c2.prompt_tokens_details && ('cached_tokens' in c2.prompt_tokens_details);
console.log(`A-result: compat exposes prompt_tokens_details.cached_tokens? ${!!compatHasField}; value call-2 = ${compatCached}`);

console.log('\n--- B. NATIVE endpoint (does the tier data exist at all?) ---');
await nativeCall('call-1');
const n2 = await nativeCall('call-2');
const nativeCached = n2.cachedContentTokenCount || 0;
console.log(`B-result: native cachedContentTokenCount call-2 = ${nativeCached} (promptTokenCount=${n2.promptTokenCount || 0})`);

console.log('\n--- C. Reuse path: bareagent OpenAIProvider @ Gemini compat baseUrl ---');
const provider = new OpenAIProvider({ apiKey: KEY, model: MODEL, baseUrl: COMPAT });
const r = await provider.generate(
  [{ role: 'system', content: bigPrefix }, { role: 'user', content: 'Reply with: ok' }], [], {});
console.log('provider usage =', JSON.stringify(r.usage), '| keys:', Object.keys(r.usage).join(','));

console.log('\n=== POC verdict ===');
console.log(`compat surfaces cached_tokens: ${!!compatHasField} (value ${compatCached})`);
console.log(`native surfaces cachedContentTokenCount: ${nativeCached > 0 ? 'yes' : 'no/0'} (value ${nativeCached})`);
console.log(compatHasField && compatCached > 0
  ? 'DECISION → reuse OpenAIProvider via baseUrl; map prompt_tokens_details.cached_tokens like OpenAI.'
  : nativeCached > 0
    ? 'DECISION → compat hides the tier but native has it → small native provider-gemini.js keyed on usageMetadata.'
    : 'FINDING → cache tier was 0 on both; implicit caching did not engage this run — retry larger/closer before deciding.');
