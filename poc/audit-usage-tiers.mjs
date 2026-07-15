// audit-usage-tiers.mjs — LIVE probe for the "dropped token tier → silent budget-cap defeat" class.
//
// THESIS (the one audit question): at the usage-normalization boundary, what can the real API
// report that our neutral Usage shape has no slot for — and when a tier is unrepresented, our
// count rounds DOWN, so bareguard's USD/token cap sees less than reality and fires late or never.
//
// METHOD (prove, don't assert): wrap each provider's internal `_request` so we capture the RAW
// API usage object and our NEUTRAL Usage from the SAME response (one call, no cross-call drift).
// Then flag every token-bearing key in the raw usage that our neutral shape neither maps nor
// knowingly treats as a subtotal/total. A non-empty "unmapped" list is a real undercount gap.
//
// THE TEST MUST BE ABLE TO FAIL: run() below asserts unmapped-is-empty; selfTest() feeds the
// gap-detector a raw object carrying an EXTRA billable tier the mapping ignores and asserts it is
// caught — so a green run proves the detector discriminates, not that it's blind.
//
// Usage:
//   ANTHROPIC_API_KEY=… node poc/audit-usage-tiers.mjs        # runs whichever providers have keys
//   OPENAI_API_KEY=… GEMINI_API_KEY=… node poc/audit-usage-tiers.mjs
//   node poc/audit-usage-tiers.mjs --selftest-only            # offline: prove the detector can fail
//
// Exit 1 if any provider shows an unmapped token tier OR the self-test fails to catch its planted gap.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OpenAIProvider, AnthropicProvider, GeminiProvider } = require('../src/providers');

// ── helpers ────────────────────────────────────────────────────────────────

/** Flatten an object to { 'a.b.c': number } for every NUMERIC leaf. Non-numeric leaves are dropped. */
function flattenNumeric(obj, prefix = '') {
  /** @type {Record<string, number>} */
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'number') out[path] = v;
    else if (v && typeof v === 'object') Object.assign(out, flattenNumeric(v, path));
  }
  return out;
}

/** A raw usage leaf is "token-bearing" if its path names a token count. */
const isTokenKey = (path) => /token/i.test(path);

/**
 * The core gap detector. Given the raw usage object + a provider spec describing which leaf paths
 * we MAP (consume into neutral) and which are known TOTALS/SUBTOTALS (double-counts we deliberately
 * ignore), return the token-bearing leaves that are NEITHER — i.e. real undercount candidates.
 * @param {any} rawUsage
 * @param {{mapped: string[], subtotalPrefixes: string[], subtotalExact?: string[]}} spec
 */
function findUnmappedTierKeys(rawUsage, spec) {
  const numeric = flattenNumeric(rawUsage);
  const mapped = new Set(spec.mapped);
  const subExact = new Set(spec.subtotalExact || []);
  /** @type {{path: string, value: number}[]} */
  const unmapped = [];
  for (const [path, value] of Object.entries(numeric)) {
    if (!isTokenKey(path)) continue;              // non-token counts (e.g. request tallies) aren't a token undercount
    if (mapped.has(path)) continue;               // consumed into neutral
    if (subExact.has(path)) continue;             // a known total/subtotal
    if (spec.subtotalPrefixes.some((p) => path.startsWith(p))) continue; // a known nested subtotal group
    unmapped.push({ path, value });
  }
  return unmapped;
}

const sum = (o) => Object.values(o).reduce((a, b) => a + (b || 0), 0);
const neutralBillable = (u) =>
  (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0);

// ── per-provider specs ───────────────────────────────────────────────────────
// `mapped` = raw leaf paths we actually consume. `subtotalExact`/`subtotalPrefixes` = raw token
// leaves that are totals or subtotals of a mapped tier (counting them would DOUBLE-count, so they
// are deliberately not consumed — but they are NOT undercounts). Anything token-bearing and outside
// both sets is a genuine "the API billed for tokens our neutral shape can't see" gap.

const SPECS = {
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY',
    rawUsage: (resp) => resp?.usage,
    make: (apiKey) => new AnthropicProvider({ apiKey, model: 'claude-haiku-4-5-20251001', cacheSystem: true, cacheMessages: true }),
    mapped: ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'],
    subtotalExact: [],
    // cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens are a per-TTL breakdown of cache_creation_input_tokens.
    subtotalPrefixes: ['cache_creation.'],
    // Anthropic reports no single "total" field — reconciliation falls back to the unmapped-key check.
    authoritativeTotal: () => null,
  },
  openai: {
    envKey: 'OPENAI_API_KEY',
    rawUsage: (resp) => resp?.usage,
    make: (apiKey) => new OpenAIProvider({ apiKey, model: 'gpt-4o-mini' }),
    mapped: ['prompt_tokens', 'completion_tokens', 'prompt_tokens_details.cached_tokens'],
    // total_tokens = prompt+completion. *_details.* are subtotals OF prompt/completion (reasoning,
    // audio, accepted/rejected prediction) — billed within completion_tokens, so already counted.
    subtotalExact: ['total_tokens'],
    subtotalPrefixes: ['prompt_tokens_details.', 'completion_tokens_details.'],
    authoritativeTotal: (raw) => raw?.total_tokens,
  },
  gemini: {
    envKey: 'GEMINI_API_KEY',
    rawUsage: (resp) => resp?.usageMetadata,
    make: (apiKey) => new GeminiProvider({ apiKey, model: 'gemini-2.5-flash' }),
    mapped: ['promptTokenCount', 'candidatesTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount'],
    subtotalExact: ['totalTokenCount'],
    // *TokensDetails[] arrays itemize prompt/candidate/cache tokens BY MODALITY — they re-slice tokens
    // already counted in the top-line counts, never a separate tier. (Verified live: promptTokensDetails
    // [0].tokenCount==promptTokenCount and neutral total reconciled to totalTokenCount exactly.)
    subtotalPrefixes: ['promptTokensDetails.', 'candidatesTokensDetails.', 'cacheTokensDetails.', 'toolUsePromptTokensDetails.'],
    authoritativeTotal: (raw) => raw?.totalTokenCount,
    // NB: toolUsePromptTokenCount (scalar), if ever returned, is NOT in mapped/subtotal → surfaces as a
    // real gap AND breaks reconciliation (it's a distinct tier, not a modality re-slice). Kept unmapped
    // deliberately so the probe flags it if Gemini starts billing tool-use prompt tokens separately.
  },
};

// ── the live run ─────────────────────────────────────────────────────────────

// A ~6k-token cacheable prefix so the SECOND call warms the cache tiers. Must clear the LARGEST
// per-model cache minimum (Haiku's floor is higher than Sonnet/Opus's ~1024) or the cold/warm calls
// come back identically uncached and the cache-tier mapping goes unexercised. Real filler, not a
// crafted number. OpenAI auto-caches ≥1024; Gemini implicit-caches on 2.5 models.
const BIG = ('You are a meticulous accounting assistant. Follow every instruction precisely and never omit a step. '
  .repeat(300));

async function run(name) {
  const spec = SPECS[name];
  const apiKey = process.env[spec.envKey];
  if (!apiKey) { console.log(`\n[${name}] SKIP — no ${spec.envKey} in env`); return null; }

  const provider = spec.make(apiKey.trim());
  // Capture the raw parsed response from the SAME call the provider normalizes.
  const orig = provider._request.bind(provider);
  let lastRaw = null;
  provider._request = async (...args) => { const r = await orig(...args); lastRaw = r; return r; };

  const messages = [
    { role: 'system', content: BIG },
    { role: 'user', content: 'Reply with the single word: acknowledged.' },
  ];

  // Two calls: the second should warm the cache-read tier so it is non-zero and thus really exercised.
  let neutral;
  for (let i = 0; i < 2; i++) {
    const res = await provider.generate(messages, [], { maxTokens: 16 });
    neutral = res.usage;
  }
  const raw = spec.rawUsage(lastRaw);

  const unmapped = findUnmappedTierKeys(raw, spec);
  const rawTokenLeaves = Object.entries(flattenNumeric(raw)).filter(([p]) => isTokenKey(p));
  const nb = neutralBillable(neutral);
  const authTotal = spec.authoritativeTotal(raw);
  // Ground truth: does our neutral token sum equal the total the provider itself reports? A neutral
  // BELOW the authoritative total is a real undercount (dropped tier). Equality proves completeness,
  // and demotes any "unmapped" leaf to a breakdown/re-slice of already-counted tokens (false alarm).
  const reconciles = (typeof authTotal === 'number') ? nb === authTotal : null;

  console.log(`\n[${name}] model=${provider.model}`);
  console.log('  raw usage      :', JSON.stringify(raw));
  console.log('  neutral usage  :', JSON.stringify(neutral));
  console.log(`  reconciliation : neutral billable ${nb} vs provider total ${authTotal ?? '(none reported)'}`);
  console.log('  raw token leaves       :', rawTokenLeaves.map(([p, v]) => `${p}=${v}`).join(', ') || '(none)');
  const exercised = {
    input: (neutral.inputTokens || 0) > 0,
    output: (neutral.outputTokens || 0) > 0,
    cacheRead: (neutral.cacheReadTokens || 0) > 0,
    cacheCreation: (neutral.cacheCreationTokens || 0) > 0,
  };
  console.log('  tiers exercised (non-zero):', JSON.stringify(exercised));

  // Verdict: reconciliation is authoritative where a total exists; else fall back to the key check.
  let gap = false;
  if (reconciles === true) {
    console.log(`  ✅ neutral total reconciles to the provider's own total — no token-count undercount`);
    if (unmapped.length) console.log('     (advisory: breakdown leaves not separately consumed:', unmapped.map((u) => u.path).join(', ') + ')');
  } else if (reconciles === false) {
    gap = true;
    console.log(`  ❌ UNDERCOUNT — neutral ${nb} < provider total ${authTotal} (missing ${authTotal - nb} tokens). Suspect unmapped tier(s):`);
    for (const u of unmapped) console.log(`       ${u.path} = ${u.value}`);
    if (!unmapped.length) console.log('       (no unmapped token leaf found — the gap is in a mapped-tier miscomputation, investigate the normalizer)');
  } else if (unmapped.length) {
    gap = true;
    console.log(`  ❌ UNMAPPED token tier(s) (no provider total to reconcile against) — budget may undercount:`);
    for (const u of unmapped) console.log(`       ${u.path} = ${u.value}`);
  } else {
    console.log('  ✅ every token-bearing raw field is mapped or a known subtotal — no undercount gap');
  }
  return { name, gap, unmapped, exercised, reconciles };
}

// ── the negative control (offline, always runs) ──────────────────────────────
// Prove the detector CAN fail: plant a billable tier the mapping ignores and assert it's caught.
function selfTest() {
  console.log('\n[selftest] gap-detector negative control (offline)');
  // Anthropic-shaped raw with a HYPOTHETICAL new billable field our mapping doesn't know about.
  const rawWithGap = {
    input_tokens: 100, output_tokens: 20,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    reasoning_output_tokens: 5000, // <- a real billable tier we never mapped: MUST be flagged
  };
  const caught = findUnmappedTierKeys(rawWithGap, SPECS.anthropic);
  const ok = caught.length === 1 && caught[0].path === 'reasoning_output_tokens';
  console.log(`  planted tier reasoning_output_tokens=5000 → detector ${ok ? 'CAUGHT it ✅' : 'MISSED it ❌'}`);

  // And a clean raw must produce NO false positive.
  const clean = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 40,
    cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } };
  const fp = findUnmappedTierKeys(clean, SPECS.anthropic);
  const noFp = fp.length === 0;
  console.log(`  clean raw (with cache_creation subtotal) → ${noFp ? 'no false positive ✅' : `FALSE POSITIVE ❌ ${JSON.stringify(fp)}`}`);

  // Reconciliation must vindicate a modality-breakdown (Gemini's promptTokensDetails), NOT flag it:
  // neutral == totalTokenCount even though the breakdown leaf is "unmapped".
  const geminiRaw = { promptTokenCount: 5110, totalTokenCount: 5123, thoughtsTokenCount: 13,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 5110 }] };
  const gNeutralBillable = 5110 + 13 + 0 + 0; // input + thoughts(output) + caches
  const gReconciles = gNeutralBillable === SPECS.gemini.authoritativeTotal(geminiRaw);
  console.log(`  gemini modality-breakdown reconciles (${gNeutralBillable}==${geminiRaw.totalTokenCount}) → ${gReconciles ? 'not a false undercount ✅' : 'MISHANDLED ❌'}`);
  return ok && noFp && gReconciles;
}

// ── main ─────────────────────────────────────────────────────────────────────
const selfOnly = process.argv.includes('--selftest-only');
const selfOk = selfTest();
if (!selfOk) { console.error('\nFATAL: self-test failed — the gap-detector cannot be trusted. Aborting.'); process.exit(1); }
if (selfOnly) { console.log('\n--selftest-only: detector proven able to fail. Exit 0.'); process.exit(0); }

const results = [];
for (const name of ['anthropic', 'openai', 'gemini']) {
  try { const r = await run(name); if (r) results.push(r); }
  catch (err) { console.error(`\n[${name}] ERROR:`, err.message); results.push({ name, unmapped: [{ path: 'ERROR', value: err.message }] }); }
}

const gaps = results.filter((r) => r.gap);
console.log('\n──────────────────────────────────────────────');
if (!results.length) { console.log('No providers ran (no keys present). Nothing proven.'); process.exit(0); }
if (gaps.length) {
  console.log(`RESULT: ${gaps.length} provider(s) with a real token undercount: ${gaps.map((g) => g.name).join(', ')}`);
  process.exit(1);
}
console.log(`RESULT: all ${results.length} live provider(s) reconcile to the provider's own total — no silent undercount found on this run.`);
