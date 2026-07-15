/**
 * BA-6 — normalize each provider's native finish-reason field to one neutral vocabulary.
 *
 * Every provider tells you WHY generation ended. Before this, bare-agent read the field on none of
 * them (`grep -rn 'stop_reason\|finish_reason\|done_reason' src/` → zero hits), so a round the API
 * CUT OFF at the token cap was indistinguishable from one the model chose to end — the Loop's rule is
 * "no tool calls ⇒ final answer", and a truncation has no tool calls, so it returned as a clean finish
 * with `error: null`. A truncation was laundered into a completion.
 *
 * The neutral vocabulary (what the Loop is allowed to reason about):
 *
 *   'end_turn'         the model finished of its own accord — the ONLY clean finish
 *   'max_tokens'       CUT OFF at the output cap. NOT a finish. Load-bearing (see below).
 *   'tool_use'         stopped to call a tool, and the call is COMPLETE
 *   'stop_sequence'    hit a caller-supplied stop string — a legitimate finish
 *   'refusal'          declined on safety grounds (Anthropic `refusal`, OpenAI `content_filter`, …)
 *   'pause_turn'       server-side tool loop paused; the caller is expected to RESUME, not to error
 *   'context_exceeded' ran out of CONTEXT WINDOW (distinct from running out of output budget)
 *   null               provider didn't say / we don't recognize it
 *
 * `null` is the safe default and it is deliberate: an unmapped or absent value reproduces the
 * pre-BA-6 behavior exactly. A wrong guess therefore degrades to the status quo rather than inventing
 * a false truncation error on a healthy run. Unknown-but-present values pass through verbatim (a
 * caller can still see them) but the Loop only ever ACTS on the values above.
 *
 * ── Why 'max_tokens' vs 'tool_use' is the load-bearing distinction (measured, not assumed) ──
 *
 * `poc/ba6-stop-reason-mapping.mjs`, real API, claude-sonnet-5 + gpt-4o-mini:
 *
 *   a COMPLETE tool call ALWAYS arrives tagged 'tool_use' — never 'max_tokens'.
 *
 * Anthropic returned `stop_reason: "tool_use"` with intact arguments even at a tight 1024-token cap;
 * OpenAI refuses outright (HTTP 400) rather than emit a tool call it could not finish. Neither ever
 * handed back a COMPLETE tool call tagged as truncated.
 *
 * The converse is the dangerous case, and it is not hypothetical — it is the BA-4 file-zeroing bug one
 * layer up: a round tagged 'max_tokens' that CARRIES a tool call carries a tool call that was cut off
 * mid-generation, whose arguments are missing keys. That is precisely how a `claude-haiku-4-5` worker
 * emptied a 1789-line file — it hit the output cap mid-`shell_write`, the `content` argument never
 * arrived, and the truncated call was executed as if whole. So the Loop must NEVER execute the tool
 * calls of a 'max_tokens' round. Refusing costs nothing legitimate (complete calls come back
 * 'tool_use') and closes the data-loss path at the protocol layer, for every tool, not just
 * `shell_write`.
 */

/** Anthropic `stop_reason` → neutral. */
const ANTHROPIC = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  tool_use: 'tool_use',
  stop_sequence: 'stop_sequence',
  refusal: 'refusal',
  pause_turn: 'pause_turn',
  model_context_window_exceeded: 'context_exceeded',
};

/** OpenAI (and OpenAI-compatible) `finish_reason` → neutral. */
const OPENAI = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

/**
 * Gemini `finishReason` → neutral. Gemini does NOT tag a function call specially — a complete tool call
 * comes back as `STOP` with a `functionCall` part (measured live) — so there is no `tool_use` row here
 * by design. `normalizeStopReason` derives it from `hasToolCalls` instead; see the note there.
 */
const GEMINI = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  BLOCKLIST: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  SPII: 'refusal',
};

/**
 * Ollama `done_reason` → neutral. `load`/`unload` are lifecycle values, not completions — they map to
 * null (unknown) rather than being forced into the vocabulary.
 */
const OLLAMA = {
  stop: 'end_turn',
  length: 'max_tokens',
};

const TABLES = {
  anthropic: ANTHROPIC,
  openai: OPENAI,
  gemini: GEMINI,
  ollama: OLLAMA,
};

/**
 * Map a provider's native finish-reason value onto the neutral vocabulary.
 *
 * @param {string|null|undefined} raw - the provider's native value (`stop_reason` / `finish_reason` /
 *   `finishReason` / `done_reason`). Absent or non-string ⇒ `null` (pre-BA-6 behavior).
 * @param {'anthropic'|'openai'|'gemini'|'ollama'} provider - which table to read.
 * @param {{hasToolCalls?: boolean}} [ctx] - what the round actually CARRIED. See below: two providers
 *   cannot express "stopped to call a tool" in their finish-reason field at all, so the round's own
 *   content is the only place that fact exists.
 * @returns {string|null} a neutral value, an unrecognized value passed through verbatim, or `null`.
 */
function normalizeStopReason(raw, provider, ctx = {}) {
  if (typeof raw !== 'string' || raw === '') return null;
  const table = TABLES[provider];
  if (!table) return raw;
  // An unrecognized-but-present value passes through: the caller can still SEE it, and the Loop only
  // acts on the known vocabulary — so a new upstream value can never be mistaken for a truncation.
  const mapped = table[raw] || raw;

  // GEMINI AND OLLAMA HAVE NO `tool_use` FINISH REASON (both measured live: Gemini returns
  // `finishReason: STOP` and Ollama `done_reason: 'stop'` on a round that emitted a complete function
  // call). Reported verbatim, a round that stopped TO CALL A TOOL would come back as `end_turn` — "the
  // model finished of its own accord" — on 2 of 5 providers and `tool_use` on the other 3.
  //
  // That is the BA-6 defect class in miniature: a round that is NOT a finish, reporting as a finish.
  // An adopter branching on `stopReason === 'end_turn'` would be right on Anthropic/OpenAI and wrong
  // on Gemini/Ollama. So derive it from what the round CARRIED — the model did stop to call a tool,
  // and that is a report, not an invention.
  //
  // Narrow on purpose: only ever promotes `end_turn` → `tool_use`. It cannot touch `max_tokens` (a
  // truncated round carrying a half-generated call must stay TRUNCATED — that is BA-4's mechanism),
  // nor `refusal`/`pause_turn`/`context_exceeded`, nor an unrecognized passthrough value.
  if (mapped === 'end_turn' && ctx.hasToolCalls === true) return 'tool_use';
  return mapped;
}

/**
 * Did this round get CUT OFF at the output-token cap?
 *
 * The one predicate the Loop acts on. Deliberately narrow: `context_exceeded`, `refusal` and
 * `pause_turn` are all "not a normal finish" but they are NOT output-cap truncations and must not be
 * folded in here — `pause_turn` in particular is a RESUMABLE state, and erroring on it would break
 * server-side tool flows that are working exactly as designed.
 *
 * @param {string|null|undefined} stopReason - a NEUTRAL value (post-{@link normalizeStopReason}).
 * @returns {boolean}
 */
function isTruncated(stopReason) {
  return stopReason === 'max_tokens';
}

module.exports = { normalizeStopReason, isTruncated };
