/**
 * BA-1 POC — can a tool loop cache its transcript on Anthropic, and what does it actually buy US?
 *
 * bareloop measured 9.4x cheaper per round. D3 was explicit: take our OWN measurement before flipping
 * every adopter's wire format. This is that measurement.
 *
 * Riskiest assumptions under test (a source-read answers none of them):
 *
 *   Q1. Does a rolling `cache_control` breakpoint on the LAST content block of the LAST message
 *       actually produce a cache READ on round 2+ — on a TOOL-RESULT-TERMINATED transcript, which is
 *       the shape a tool loop ALWAYS ends on and the one _toAnthropicMessage rebuilds from scratch?
 *   Q2. NEGATIVE CONTROL: with the breakpoint OFF, are the cache tiers really 0? If both arms cache,
 *       the flag isn't what's doing the work and the whole measurement is an artifact.
 *   Q3. The MINIMUM CACHEABLE PREFIX. Anthropic's minimum is model-dependent (1024 / 2048 / 4096
 *       tokens) and a prefix under it SILENTLY does not cache — no error, just zeros. Does a realistic
 *       tool-loop transcript clear it on claude-sonnet-5? (Unknown for this model — measure, don't
 *       assume. This is exactly why `cacheSystem` never helped: a ~200-token persona is far below it.)
 *   Q4. What is the real per-round $ curve, and where is break-even? A cache WRITE costs ~1.25x, a READ
 *       ~0.1x. Two requests break even at the 5-minute TTL — but only if reads actually land.
 *
 * Both arms replay the SAME transcript, one knob apart. Raw fetch, mimicking bare-agent's exact body
 * shape (incl. the tool_result rebuild), so what we learn transfers to the provider unchanged.
 */

import { readFileSync } from 'node:fs';

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error('need ANTHROPIC_API_KEY'); process.exit(1); }

const MODEL = 'claude-sonnet-5';
// Sonnet 5 pricing ($/MTok). Cache write = 1.25x input, cache read = 0.1x input.
const IN = 3.00 / 1e6, OUT = 15.00 / 1e6;
const cost = (u) => (u.input_tokens * IN)
  + ((u.cache_creation_input_tokens || 0) * IN * 1.25)
  + ((u.cache_read_input_tokens || 0) * IN * 0.10)
  + (u.output_tokens * OUT);

// A REAL file, not a synthetic blob — this is what a tool loop actually drags through context.
const FILE = readFileSync(new URL('../src/loop.js', import.meta.url), 'utf8').slice(0, 60000);

const TOOLS = [{
  name: 'shell_read',
  description: 'Read a file from disk.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

/**
 * Build a realistic tool-loop transcript: the model read a big file, and the transcript ENDS on the
 * tool_result. This is the shape bare-agent's _toAnthropicMessage rebuilds — and the shape that no
 * caller-side seam can reach.
 */
function transcript(followups) {
  const msgs = [
    { role: 'user', content: 'Find the bug in loop.js. Start by reading it.' },
    { role: 'assistant', content: [
      { type: 'text', text: 'I will read the file.' },
      { type: 'tool_use', id: 'tu_1', name: 'shell_read', input: { path: 'src/loop.js' } },
    ] },
    // The tool_result — the bulk of the transcript, and the LAST message on round 1.
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: FILE }] },
  ];
  for (const f of followups) msgs.push({ role: 'user', content: [{ type: 'text', text: f }] });
  return msgs;
}

/** The BA-1 fix, verbatim: roll a breakpoint onto the last content block of the last message. */
function mark(msgs) {
  const last = msgs[msgs.length - 1];
  if (Array.isArray(last.content) && last.content.length > 0) {
    last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  } else if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  }
  return msgs;
}

async function round(msgs, cacheMessages) {
  const body = {
    model: MODEL,
    max_tokens: 256,
    system: 'You are a debugging assistant.', // the ~200-token persona: far below any cache minimum
    messages: cacheMessages ? mark(structuredClone(msgs)) : structuredClone(msgs),
    tools: TOOLS,
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await res.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d.usage;
}

// Four rounds, each adding a follow-up turn — the transcript GROWS, exactly like a real tool loop.
const FOLLOWUPS = [
  'What does the trim seam do?',
  'And what does the assemble seam do?',
  'Which line handles the deny streak?',
  'Summarize the termination paths.',
];

async function arm(label, cacheMessages) {
  console.log(`\n── ${label} ${'─'.repeat(50 - label.length)}`);
  console.log('round │    input │ cache_write │ cache_read │      cost');
  let total = 0;
  for (let i = 0; i < FOLLOWUPS.length; i++) {
    const u = await round(transcript(FOLLOWUPS.slice(0, i + 1)), cacheMessages);
    const c = cost(u);
    total += c;
    console.log(
      `    ${i + 1} │ ${String(u.input_tokens).padStart(8)} │ ${String(u.cache_creation_input_tokens || 0).padStart(11)} │ ${String(u.cache_read_input_tokens || 0).padStart(10)} │ $${c.toFixed(4)}`,
    );
  }
  console.log(`total: $${total.toFixed(4)}`);
  return total;
}

console.log(`BA-1 — message caching on ${MODEL}. Transcript ends on a tool_result (~${Math.round(FILE.length / 4)} tok).`);

const off = await arm('ARM A: NO breakpoint (today) — NEGATIVE CONTROL', false);
const on = await arm('ARM B: rolling breakpoint (the BA-1 fix)', true);

console.log(`\n${'='.repeat(64)}`);
console.log(`no breakpoint : $${off.toFixed(4)}`);
console.log(`with          : $${on.toFixed(4)}`);
const saving = off > 0 ? off / on : 0;
console.log(`=> ${saving.toFixed(2)}x cheaper over ${FOLLOWUPS.length} rounds`);
console.log('\nREAD THIS OUT:');
console.log('- Arm A cache_read must be 0 on every round. If it is not, Anthropic is caching WITHOUT');
console.log('  our flag and the flag is not what is doing the work — the measurement would be an artifact.');
console.log('- Arm B round 1 pays a cache WRITE (1.25x); rounds 2+ must show a nonzero cache_read.');
console.log('  If cache_read stays 0 in arm B, the transcript is UNDER the model minimum and silently');
console.log('  did not cache — which is the same trap that makes cacheSystem useless on a short persona.');
