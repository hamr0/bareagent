// audit-refusal-laundering.mjs — finding #2, the Loop-side leg.
//
// CLASS: an event the neutral shape CAN represent (stopReason:'refusal'/'context_exceeded') but the
// Loop DOESN'T ACT ON, so it rounds toward success. BA-6 fixed the `max_tokens` leg of exactly this;
// the other non-clean stop reasons still fall through the "no tool calls ⇒ final answer" rule and
// return `error:null` — a safety refusal or a blown context window reads to the caller as a
// successful (usually empty) answer, and the return carries no stopReason to detect it by.
//
// WHY A STUB, NOT A LIVE REFUSAL: triggering a real SAFETY/RECITATION/content_filter block is
// fragile and non-deterministic (and I won't craft harmful input to force one). The stop-reason
// VALUES here are ones the providers PROVABLY emit — their normalization is already live-verified
// (BA-6, poc/ba6-stop-reason-mapping.mjs). So this isolates the LOOP's handling of a real value,
// deterministically. (Repo rule: don't assert a fragile property via a live test; lock it with a
// deterministic unit test instead.) RECITATION in particular fires on BENIGN prompts (e.g. "recite
// the lyrics to…"), so this is reachable on ordinary, non-adversarial runs.
//
// PROVE, DON'T ASSERT: we RUN the real Loop and print its actual return per stop reason. The
// `max_tokens` and `end_turn` rows are the controls — if max_tokens weren't caught (error set) or a
// clean end_turn WERE flagged, the harness itself would be suspect.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Loop } = require('../src/loop');

/** A provider that returns one canned round, then (if asked again) a clean end to avoid an infinite loop. */
function stubProvider({ text, stopReason }) {
  let calls = 0;
  return {
    model: 'stub-1',
    async generate() {
      calls++;
      // First call: the round under test. Any later call: a benign clean finish (not exercised here —
      // every case under test terminates on round 1).
      if (calls === 1) return { text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 0 }, stopReason };
      return { text: 'fallback', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
    },
  };
}

const CASES = [
  // The dangerous ones: non-clean stops that SHOULD signal, carrying empty text like a real block does.
  { label: 'refusal (empty text) — OpenAI content_filter / Gemini SAFETY / Anthropic refusal', text: '', stopReason: 'refusal', shouldSignal: true },
  { label: 'refusal (RECITATION, benign prompt trigger)',                                       text: '', stopReason: 'refusal', shouldSignal: true },
  { label: 'context_exceeded (empty text) — ran out of context window',                         text: '', stopReason: 'context_exceeded', shouldSignal: true },
  // pause_turn is the ODD ONE OUT (post-BA-13): it must RESUME, not signal. The stub's 2nd call returns a
  // clean end_turn ('fallback'), so a correctly-resuming Loop lands on a clean finish — NOT a signal. If
  // pause_turn were laundered (pre-fix) it would ALSO be a clean finish, so this row is checked by the
  // resume assertion below (the loop was called twice), not by shouldSignal.
  { label: 'pause_turn — resumable server-tool pause (must RESUME to the 2nd round, not terminate)',
                                                                                                 text: '', stopReason: 'pause_turn', shouldSignal: false, isResume: true },
  // Controls:
  { label: 'CONTROL max_tokens — BA-6 already handles this (must be flagged)',                   text: 'partial', stopReason: 'max_tokens', shouldSignal: true, isControlHandled: true },
  { label: 'CONTROL end_turn (real text) — a genuine clean finish (must NOT be flagged)',        text: 'Here is the answer.', stopReason: 'end_turn', shouldSignal: false },
];

console.log('Running each stop reason through the REAL Loop, observing the actual return:\n');

let laundered = 0;
for (const c of CASES) {
  const loop = new Loop({ provider: stubProvider(c), throwOnError: false });
  const res = await loop.run([{ role: 'user', content: 'do the task' }]);
  const surfacedStop = 'stopReason' in res ? res.stopReason : '(field absent)';
  // "Signalled" = the caller can tell this wasn't a clean success: error set OR a non-clean stopReason surfaced.
  const signalled = res.error != null || (surfacedStop && surfacedStop !== 'end_turn' && surfacedStop !== '(field absent)');
  const ok = signalled === c.shouldSignal;

  console.log(`• ${c.label}`);
  console.log(`    → error=${JSON.stringify(res.error)}  text=${JSON.stringify(res.text)}  stopReason on return=${surfacedStop}`);
  if (c.isResume) {
    // The stub's 2nd canned response is a clean end_turn carrying 'fallback'. If the Loop RESUMED, it
    // reached round 2 and lands there; if it laundered pause_turn into a round-1 clean finish, res.text
    // is '' (the round-1 text). So res.text === 'fallback' is the proof the loop advanced past the pause.
    const resumed = res.error == null && res.text === 'fallback';
    if (resumed) {
      console.log(`    ✅ resumed — the loop advanced to round 2 and finished clean (pause_turn is not terminal, not an error)`);
    } else {
      laundered++;
      console.log(`    ❌ NOT RESUMED — a 'pause_turn' round terminated on round 1 instead of resuming (text=${JSON.stringify(res.text)}).`);
    }
  } else if (c.shouldSignal && !signalled) {
    laundered++;
    console.log(`    ❌ LAUNDERED — a '${c.stopReason}' round returned as a clean success (error:null, no stopReason). The caller cannot distinguish it from a real answer.`);
  } else if (c.isControlHandled && signalled) {
    console.log(`    ✅ control: correctly flagged (BA-6) as ${JSON.stringify(res.error)}`);
  } else if (!c.shouldSignal && !signalled) {
    console.log(`    ✅ control: correctly returned as a clean finish`);
  } else if (signalled) {
    console.log(`    ✅ flagged`);
  }
  console.log('');
}

console.log('──────────────────────────────────────────────');
if (laundered > 0) {
  console.log(`RESULT: ${laundered} non-clean stop reason(s) LAUNDERED into a clean success by the Loop.`);
  console.log('This is the BA-6 class, unfixed for the non-truncation legs. A safety refusal / blocked');
  console.log('content / blown context window returns error:null with empty text and no stopReason.');
  process.exit(1);
}
console.log('RESULT: every non-clean stop reason is signalled to the caller — no laundering.');
