#!/usr/bin/env node
/**
 * BA-7 POC — what is the ACTUAL thinking-block contract on a tool-use continuation?
 *
 * The PRD (§F2) forbids coding this from a recalled schema. Four things must be MEASURED,
 * because each one changes the design and none is answerable from the docs:
 *
 *   R1 (THE COUPLING RISK — the one that decides the shape of the fix):
 *       If we ship the opt-in `thinking` param WITHOUT preservation, does round N+1 400?
 *       - 400  => (a) and (b) are INSEPARABLE. Preservation is mandatory; shipping (b) alone
 *                is a REGRESSION that breaks every tool loop that opts in.
 *       - 200  => the API tolerates the drop. The defect is purely silent data loss, and (b)
 *                could in principle ship alone. bareloop observed no 400 today, but bare-agent
 *                also never sends `thinking` — so today's silence proves nothing about (b).
 *
 *   R2: With NO thinking param, does sonnet-5 really return thinking blocks by default? And with
 *       `display` defaulting to 'omitted', what is actually IN one — text? just a signature?
 *       If the text is empty, "preserve verbatim" means preserving a signature, and we should
 *       say so plainly rather than implying we're preserving reasoning.
 *
 *   R3: Does replaying the block VERBATIM actually validate? (A signature the API rejects would
 *       make the whole feature a 400-generator.)
 *
 *   R4: Do we ever see `redacted_thinking`? If so the passthrough must be opaque — a field that
 *       preserves BYTES, not a parsed 'thinking' shape we re-emit.
 *
 * This probe hits the RAW API (no bare-agent) so it measures the contract, not our bug.
 * It can FAIL: every arm prints what it actually got, and R1/R3 assert on real HTTP status.
 *
 * Run:  ANTHROPIC_API_KEY=... node poc/ba7-thinking-contract.mjs
 */

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('need ANTHROPIC_API_KEY'); process.exit(2); }

const MODEL = process.env.MODEL || 'claude-sonnet-5';

async function post(body) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

const TOOLS = [{
  name: 'read_file',
  description: 'Read a file from disk.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

// A task hard enough to actually provoke thinking, and one that forces a tool call.
const TASK = 'The build is failing intermittently, only in CI, only on Tuesdays. Read /etc/ci/config.yml and tell me your leading hypothesis. Use the tool first.';

const kinds = (content) => content.map(b => b.type);
const line = (s) => console.log(s);
const hr = () => line('-'.repeat(78));

let failures = 0;
const check = (name, ok, detail) => {
  line(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

line(`\nBA-7 thinking contract probe — model=${MODEL}\n`);

// ── R2: today's exact body shape (NO thinking param). Does thinking arrive anyway? ──────────
hr();
line('R2  bare-agent\'s CURRENT body shape (no `thinking` key) — does thinking arrive uninvited?');
const r2 = await post({
  model: MODEL,
  max_tokens: 2048,
  tools: TOOLS,
  messages: [{ role: 'user', content: TASK }],
});
if (r2.status !== 200) {
  line(`   HTTP ${r2.status}: ${JSON.stringify(r2.data).slice(0, 300)}`);
  process.exit(1);
}
line(`   stop_reason: ${r2.data.stop_reason}`);
line(`   blocks:      ${JSON.stringify(kinds(r2.data.content))}`);
const thinkingDefault = r2.data.content.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking');
check('thinking arrives with NO thinking param (adaptive-by-default)', thinkingDefault.length > 0,
  `${thinkingDefault.length} block(s)`);
if (thinkingDefault.length > 0) {
  const b = thinkingDefault[0];
  line(`   block keys:  ${JSON.stringify(Object.keys(b))}`);
  line(`   .thinking:   ${JSON.stringify(b.thinking ?? null)?.slice(0, 120)}  (len=${(b.thinking || '').length})`);
  line(`   .signature:  ${b.signature ? `present, ${b.signature.length} chars` : 'ABSENT'}`);
  line(`   R2 verdict:  display defaults to '${(b.thinking || '').length === 0 ? 'omitted → EMPTY text, signature only' : 'text present'}'`);
}

// ── R1: THE DECISIVE ARM. thinking ON, continue the tool loop WITHOUT the thinking blocks ────
// This is exactly what bare-agent+opt-in-thinking would put on the wire if we shipped (b) alone.
hr();
line('R1  DECISIVE: `thinking` ON, replay assistant turn WITHOUT thinking blocks (= shipping (b) alone)');
const r1base = await post({
  model: MODEL,
  max_tokens: 2048,
  thinking: { type: 'adaptive' },
  tools: TOOLS,
  messages: [{ role: 'user', content: TASK }],
});
if (r1base.status !== 200) {
  line(`   HTTP ${r1base.status} on the OPT-IN param itself: ${JSON.stringify(r1base.data).slice(0, 300)}`);
  check('thinking:{type:adaptive} is accepted (criterion 2)', false, `HTTP ${r1base.status}`);
} else {
  check('thinking:{type:adaptive} is accepted (criterion 2)', true, `stop=${r1base.data.stop_reason}`);
  line(`   blocks:      ${JSON.stringify(kinds(r1base.data.content))}`);

  const toolUse = r1base.data.content.find(b => b.type === 'tool_use');
  if (!toolUse) {
    line('   (no tool_use in round 1 — cannot test the continuation; rerun)');
  } else {
    // Rebuild the assistant turn the way bare-agent does TODAY: text + tool_use only.
    const stripped = r1base.data.content.filter(b => b.type === 'text' || b.type === 'tool_use');
    const cont = (assistantContent) => ({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      tools: TOOLS,
      messages: [
        { role: 'user', content: TASK },
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'schedule: "0 3 * * 2"\nretries: 0\n' }] },
      ],
    });

    const dropped = await post(cont(stripped));
    line(`   WITHOUT thinking blocks → HTTP ${dropped.status}`);
    if (dropped.status !== 200) {
      line(`   error: ${JSON.stringify(dropped.data.error || dropped.data).slice(0, 260)}`);
    }
    // NOT a pass/fail check: BOTH outcomes are real findings, and scoring one as "PASS" would
    // bias the read toward the answer I expected. Report the measurement; let it decide.
    line(`   >>> R1 FINDING: ${dropped.status === 200
      ? 'API TOLERATED the drop (200) → (a) and (b) are SEPARABLE. Silent data loss, no 400.'
      : `HTTP ${dropped.status} → (a) and (b) are INSEPARABLE. Shipping the opt-in param WITHOUT preservation would BREAK every tool loop that enables it.`}`);

    // ── R3: same continuation, blocks preserved VERBATIM. Must be 200. ─────────────────────
    hr();
    line('R3  same continuation, thinking blocks preserved VERBATIM (signature included)');
    const kept = await post(cont(r1base.data.content));
    line(`   WITH thinking blocks    → HTTP ${kept.status}`);
    if (kept.status !== 200) {
      line(`   error: ${JSON.stringify(kept.data.error || kept.data).slice(0, 260)}`);
    } else {
      line(`   blocks:      ${JSON.stringify(kinds(kept.data.content))}`);
    }
    check('R3: verbatim replay validates (the signature is accepted)', kept.status === 200,
      kept.status === 200 ? 'round-trip works' : 'verbatim replay 400s — the fix as specified would not work');

    // ── R4: opacity. Did we ever see a redacted block, or non-'thinking' keys? ─────────────
    hr();
    line('R4  opacity — what must the passthrough field be able to hold?');
    const allBlocks = [...r2.data.content, ...r1base.data.content, ...(kept.data.content || [])];
    const seen = [...new Set(allBlocks.map(b => b.type))];
    const thinkKeys = [...new Set(allBlocks.filter(b => b.type.includes('thinking')).flatMap(b => Object.keys(b)))];
    line(`   block types seen across all arms: ${JSON.stringify(seen)}`);
    line(`   keys on thinking-ish blocks:      ${JSON.stringify(thinkKeys)}`);
    check('R4: passthrough must be OPAQUE (preserve bytes, not a parsed shape)', true,
      seen.includes('redacted_thinking')
        ? 'redacted_thinking OBSERVED — opacity is mandatory'
        : 'no redacted block this run, but it is a documented type: stay opaque anyway');
  }
}

// ── Criterion 3: negative control. No thinking param on a non-thinking model = today's body. ──
hr();
line('NEG  criterion-3 control: haiku-4-5, no thinking param — the body must stay as it is today');
const neg = await post({
  model: 'claude-haiku-4-5',
  max_tokens: 512,
  tools: TOOLS,
  messages: [{ role: 'user', content: TASK }],
});
const negThinking = (neg.data.content || []).filter(b => b.type.includes('thinking'));
line(`   HTTP ${neg.status}  blocks: ${JSON.stringify(kinds(neg.data.content || []))}`);
check('NEG: a non-thinking model returns no thinking blocks (the flag reads the flag, not the weather)',
  neg.status === 200 && negThinking.length === 0, `${negThinking.length} thinking block(s)`);

hr();
line(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} — read the R1 verdict above; it decides the design.\n`);
process.exit(failures === 0 ? 0 : 1);
