#!/usr/bin/env node
/**
 * BA-7 follow-up — is adaptive thinking really ON BY DEFAULT?
 *
 * bareloop's BA-7 ask rests on this premise:
 *   "claude-sonnet-5 (and Opus 4.7+) run adaptive thinking by DEFAULT when `thinking` is omitted
 *    — so bare-agent is receiving thinking blocks today, every round, without asking for them."
 * They report POSTing bare-agent's exact body shape and getting blocks ["thinking","tool_use"].
 *
 * My first probe saw the OPPOSITE (n=1): no param => no thinking block. But `adaptive` means the
 * MODEL decides, so a single miss could just be an easy prompt — not a falsified premise. n=1 on a
 * nondeterministic feature is a degenerate number; audit it before believing it.
 *
 * So: a repeated DIFFERENTIAL. Same prompt, same model, same cap. Only the `thinking` key varies.
 *   - If OFF is ~0/N and ON is ~N/N  => the param is load-bearing; adaptive is NOT on by default;
 *                                       bareloop's premise (and the "losing data today" claim) is wrong.
 *   - If OFF is also ~N/N            => my first run was the fluke; their premise stands.
 *   - If OFF is somewhere in between => it IS adaptive-by-default and genuinely prompt-dependent,
 *                                       which is its own (weaker) version of their claim.
 * The test can produce any of the three. It is not built to confirm one.
 *
 * Also runs a HARD prompt arm: if the default only thinks on hard problems, an easy prompt in the
 * OFF arm would be a confound in MY harness, not a finding.
 *
 * Run:  ANTHROPIC_API_KEY=... node poc/ba7-adaptive-default.mjs
 */

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('need ANTHROPIC_API_KEY'); process.exit(2); }

const MODEL = process.env.MODEL || 'claude-sonnet-5';
const N = Number(process.env.N || 5);

async function post(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

const TOOLS = [{
  name: 'read_file',
  description: 'Read a file from disk.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

const EASY = 'Read /etc/ci/config.yml and tell me what is in it. Use the tool first.';
const HARD = 'A distributed job queue drops ~0.3% of tasks, but only when a consumer is restarted during a rebalance, and only if the task was enqueued in the 40ms before the restart. Reason carefully about the possible race conditions, then read /etc/ci/config.yml before answering. Use the tool first.';

/** @returns {Promise<{think:number, blocks:string[], thinkTokens:number}>} */
async function trial(prompt, thinkingOn) {
  const { status, data } = await post({
    model: MODEL,
    max_tokens: 4096,
    tools: TOOLS,
    ...(thinkingOn && { thinking: { type: 'adaptive' } }),
    messages: [{ role: 'user', content: prompt }],
  });
  if (status !== 200) return { think: -1, blocks: [`HTTP ${status}`], thinkTokens: 0 };
  const blocks = data.content.map(b => b.type);
  const think = data.content.filter(b => b.type.includes('thinking')).length;
  // The API does not report thinking tokens separately; thinking is billed as output.
  return { think, blocks, thinkTokens: data.usage?.output_tokens || 0 };
}

async function arm(label, prompt, thinkingOn) {
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(await trial(prompt, thinkingOn));
  const hits = runs.filter(r => r.think > 0).length;
  const err = runs.filter(r => r.think < 0).length;
  console.log(`  ${label.padEnd(34)} thinking blocks in ${hits}/${N} runs${err ? `  (${err} HTTP error)` : ''}`);
  console.log(`  ${''.padEnd(34)} ${runs.map(r => `[${r.blocks.join(',')}]`).join(' ')}`);
  return hits;
}

console.log(`\nIs adaptive thinking ON BY DEFAULT?  model=${MODEL}  n=${N} per arm\n`);
console.log('EASY prompt:');
const easyOff = await arm('thinking OMITTED (today\'s body)', EASY, false);
const easyOn = await arm('thinking: {type:adaptive}', EASY, true);
console.log('\nHARD prompt (rules out "the task was too easy to think about"):');
const hardOff = await arm('thinking OMITTED (today\'s body)', HARD, false);
const hardOn = await arm('thinking: {type:adaptive}', HARD, true);

console.log('\n' + '='.repeat(70));
const offTotal = easyOff + hardOff;
const onTotal = easyOn + hardOn;
console.log(`OFF (param omitted): ${offTotal}/${2 * N} runs returned a thinking block`);
console.log(`ON  (param sent):    ${onTotal}/${2 * N} runs returned a thinking block`);
console.log('='.repeat(70));

if (offTotal === 0 && onTotal > 0) {
  console.log(`
VERDICT: adaptive thinking is NOT on by default on ${MODEL}.
  The 'thinking' param is load-bearing: omit it and the model returns no thinking blocks at all.
  => bare-agent is NOT "silently dropping thinking blocks today, every round". It receives none.
  => BA-7's severity drops: the data loss is LATENT, reachable only once we ship the opt-in param.
  => That makes preservation (a) a PRECONDITION of the opt-in (b), not an independent fix.
  bareloop's premise, as stated, does not reproduce. Their evidence must be re-examined.`);
} else if (offTotal > 0 && onTotal > 0) {
  console.log(`
VERDICT: thinking DOES arrive with the param omitted (${offTotal}/${2 * N}).
  bareloop's premise stands — bare-agent is dropping real blocks today. My first run was a fluke.`);
} else {
  console.log(`
VERDICT: inconclusive / harness fault (ON arm produced ${onTotal} thinking blocks).
  Debug the harness before believing any of this.`);
}
console.log();
