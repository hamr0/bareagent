// POC — BA-10: does a newer model reject a non-default `temperature`, and does drop-and-retry recover?
//
// Riskiest UNVALIDATED assumption (relayfact already reproduced the 400 live; this validates the FIX):
//   (1) the 400 message reliably contains the word "temperature"  -> my match heuristic will fire
//   (2) re-issuing the SAME request with temperature omitted succeeds -> the graceful-degrade recovers
//   (3) a model/provider that ACCEPTS temperature is untouched (no false drop)
//
// Able-to-fail: if sonnet ever stops 400-ing on temperature, arm (1) prints NO 400 and the POC says so.
//
// Run (keys via your shell, never committed):
//   ANTHROPIC_API_KEY=$(pass amr/claude_api) node poc/ba10-temp-degrade.mjs
//   OPENAI_API_KEY=$(pass amr/openai_api) OPENAI_MODEL=gpt-5 node poc/ba10-temp-degrade.mjs   # optional 2nd arm
//
// Override models: ANTHROPIC_MODEL (default claude-sonnet-5), OPENAI_MODEL (no default — arm skipped unless set).

import { AnthropicProvider, OpenAIProvider } from '../src/providers.js';

const PROMPT = [{ role: 'user', content: 'Reply with exactly the single word: ok' }];
const TEMP_RE = /temperature/i; // the match the fix keys off (case-insensitive, on a 400 where we sent one)

/** Probe one provider: send temperature -> expect 400 naming temperature; then omit -> expect success. */
async function probe(name, provider, sendTemp) {
  console.log(`\n=== ${name} (model=${provider.model}) ===`);

  // Arm 1: WITH a non-default temperature — the shipped code path that collapses to `incomplete`.
  let sawTempErr = false, errMsg = '', errStatus = null;
  try {
    await provider.generate(PROMPT, [], { temperature: 0.2, maxTokens: 16 });
    console.log('  [temp=0.2]   OK  -> this model ACCEPTS temperature; drop-retry must NOT fire here');
  } catch (e) {
    errStatus = e.status ?? null;
    errMsg = e.message || String(e);
    sawTempErr = errStatus === 400 && TEMP_RE.test(errMsg);
    console.log(`  [temp=0.2]   ERR status=${errStatus} matches/temperature/=${TEMP_RE.test(errMsg)}`);
    console.log(`               message: ${errMsg}`);
  }

  // Arm 2: OMITTED temperature — the recovery the graceful-degrade re-issues.
  try {
    const out = await provider.generate(PROMPT, [], { maxTokens: 16 });
    console.log(`  [no temp]    OK  -> recovery viable. text=${JSON.stringify((out.text || '').trim().slice(0, 20))}`);
  } catch (e) {
    console.log(`  [no temp]    ERR status=${e.status ?? '?'} : ${e.message} -> recovery NOT viable (different problem)`);
  }

  // Verdict for this provider.
  if (sawTempErr) console.log('  => FIX APPLIES: 400 names temperature AND omitting it recovers. Match heuristic is sound.');
  else if (errStatus === 400) console.log('  => 400 but message did NOT name temperature — TIGHTEN or RECONSIDER the match.');
  else console.log('  => No temperature-400 on this model; graceful-degrade stays dormant here (expected on accepting models).');
}

let ran = 0;
if (process.env.ANTHROPIC_API_KEY) {
  ran++;
  await probe('Anthropic', new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  }), true);
} else {
  console.log('SKIP Anthropic arm (no ANTHROPIC_API_KEY).');
}

if (process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) {
  ran++;
  await probe('OpenAI', new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  }), true);
} else {
  console.log('SKIP OpenAI arm (set OPENAI_API_KEY + OPENAI_MODEL, e.g. gpt-5, to probe the OpenAI reject path).');
}

if (!ran) { console.error('\nNo arms ran — provide at least ANTHROPIC_API_KEY.'); process.exit(1); }
