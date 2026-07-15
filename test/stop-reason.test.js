'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { normalizeStopReason, isTruncated, classifyStopReason } = require('../src/provider-stop-reason');

// BA-6. Pure mapping logic, so it gets real unit tests (the Testing Trophy's narrow top).
// Every value below was MEASURED against the live API, not copied from documentation —
// poc/ba6-stop-reason-mapping.mjs (Anthropic, OpenAI) and poc/ba6-stop-reason-gemini-ollama.mjs
// (Gemini on gemini-2.5-flash, Ollama on qwen2.5:0.5b).
describe('normalizeStopReason — the neutral vocabulary', () => {
  it('maps each provider\'s native finish reason', () => {
    assert.equal(normalizeStopReason('end_turn', 'anthropic'), 'end_turn');
    assert.equal(normalizeStopReason('max_tokens', 'anthropic'), 'max_tokens');
    assert.equal(normalizeStopReason('tool_use', 'anthropic'), 'tool_use');
    assert.equal(normalizeStopReason('stop', 'openai'), 'end_turn');
    assert.equal(normalizeStopReason('length', 'openai'), 'max_tokens');
    assert.equal(normalizeStopReason('tool_calls', 'openai'), 'tool_use');
    assert.equal(normalizeStopReason('STOP', 'gemini'), 'end_turn');
    assert.equal(normalizeStopReason('MAX_TOKENS', 'gemini'), 'max_tokens');
    assert.equal(normalizeStopReason('stop', 'ollama'), 'end_turn');
    assert.equal(normalizeStopReason('length', 'ollama'), 'max_tokens');
  });

  // The safe default: a wrong/absent value must degrade to PRE-BA-6 behavior, never invent a truncation.
  it('absent or non-string ⇒ null (pre-BA-6 behavior)', () => {
    for (const v of [undefined, null, '', 0, {}]) {
      assert.equal(normalizeStopReason(/** @type {any} */ (v), 'anthropic'), null);
    }
  });

  it('an unrecognized value passes through verbatim — visible, but never acted on', () => {
    assert.equal(normalizeStopReason('some_new_reason', 'anthropic'), 'some_new_reason');
    assert.equal(isTruncated('some_new_reason'), false, 'and it is NOT a truncation');
  });

  it('an unknown provider passes the raw value through', () => {
    assert.equal(normalizeStopReason('whatever', /** @type {any} */ ('mystery')), 'whatever');
  });
});

// Gemini and Ollama have NO tool_use finish reason — both measured live: a COMPLETE tool call comes
// back as `STOP` / `stop`. Reported verbatim, a round that stopped to CALL A TOOL would read as
// `end_turn` ("the model finished") on 2 of 5 providers — the BA-6 defect class in miniature.
describe('normalizeStopReason — tool_use derived where the provider cannot express it', () => {
  it('promotes end_turn ⇒ tool_use when the round carried tool calls (Gemini)', () => {
    assert.equal(normalizeStopReason('STOP', 'gemini', { hasToolCalls: true }), 'tool_use');
  });

  it('promotes end_turn ⇒ tool_use when the round carried tool calls (Ollama)', () => {
    assert.equal(normalizeStopReason('stop', 'ollama', { hasToolCalls: true }), 'tool_use');
  });

  it('leaves a genuine finish alone (no tool calls ⇒ still end_turn)', () => {
    assert.equal(normalizeStopReason('STOP', 'gemini', { hasToolCalls: false }), 'end_turn');
    assert.equal(normalizeStopReason('stop', 'ollama'), 'end_turn', 'omitted ctx behaves as false');
  });

  it('is a no-op where the provider already says tool_use (Anthropic/OpenAI)', () => {
    assert.equal(normalizeStopReason('tool_use', 'anthropic', { hasToolCalls: true }), 'tool_use');
    assert.equal(normalizeStopReason('tool_calls', 'openai', { hasToolCalls: true }), 'tool_use');
  });

  // THE LOAD-BEARING GUARD. A truncated round CAN carry a half-generated tool call — that is exactly
  // BA-4's file-zeroing mechanism, and the Loop refuses to execute it. If the derivation could promote
  // max_tokens to tool_use, it would launder a truncation into a legitimate tool round and re-open the
  // bug at the protocol layer. It must only ever touch end_turn.
  it('NEVER promotes a TRUNCATED round, even when it carries tool calls (BA-4 guard)', () => {
    assert.equal(normalizeStopReason('max_tokens', 'anthropic', { hasToolCalls: true }), 'max_tokens');
    assert.equal(normalizeStopReason('MAX_TOKENS', 'gemini', { hasToolCalls: true }), 'max_tokens');
    assert.equal(normalizeStopReason('length', 'ollama', { hasToolCalls: true }), 'max_tokens');
    assert.equal(normalizeStopReason('length', 'openai', { hasToolCalls: true }), 'max_tokens');
    assert.equal(isTruncated(normalizeStopReason('MAX_TOKENS', 'gemini', { hasToolCalls: true })), true,
      'and it still reads as a truncation, so the Loop still refuses the call');
  });

  it('never promotes refusal / pause_turn / context_exceeded', () => {
    assert.equal(normalizeStopReason('refusal', 'anthropic', { hasToolCalls: true }), 'refusal');
    assert.equal(normalizeStopReason('pause_turn', 'anthropic', { hasToolCalls: true }), 'pause_turn');
    assert.equal(normalizeStopReason('model_context_window_exceeded', 'anthropic', { hasToolCalls: true }), 'context_exceeded');
    assert.equal(normalizeStopReason('SAFETY', 'gemini', { hasToolCalls: true }), 'refusal');
  });

  it('never promotes an unrecognized passthrough value', () => {
    assert.equal(normalizeStopReason('brand_new', 'anthropic', { hasToolCalls: true }), 'brand_new');
  });
});

describe('isTruncated — deliberately narrow', () => {
  it('is true ONLY for max_tokens', () => {
    assert.equal(isTruncated('max_tokens'), true);
    for (const v of ['end_turn', 'tool_use', 'stop_sequence', 'refusal', 'pause_turn', 'context_exceeded', null, undefined]) {
      assert.equal(isTruncated(/** @type {any} */ (v)), false, `${v} must not read as a truncation`);
    }
  });
});

// BA-13 — the terminal-action table. One classifier over the neutral vocabulary replaces the single
// isTruncated short-circuit, with an EXPLICIT pass-through default so the next new stop reason degrades
// to the status quo instead of re-breeding the laundering bug.
describe('classifyStopReason — the terminal-action table', () => {
  it('maps each non-clean terminal reason to its action', () => {
    assert.equal(classifyStopReason('max_tokens'), 'truncated');
    assert.equal(classifyStopReason('refusal'), 'refusal');
    assert.equal(classifyStopReason('context_exceeded'), 'context_exceeded');
    assert.equal(classifyStopReason('pause_turn'), 'resume', 'pause_turn resumes — not terminal, not an error');
  });

  // The pass-through default: a clean finish, a tool round, an unrecognized value, and absence all return
  // null so the Loop's existing tool-exec / final-answer logic runs unchanged.
  it('returns null (pass-through) for clean / tool / unrecognized / absent reasons', () => {
    for (const v of ['end_turn', 'stop_sequence', 'tool_use', 'some_brand_new_reason', null, undefined, '', 0, {}]) {
      assert.equal(classifyStopReason(/** @type {any} */ (v)), null, `${JSON.stringify(v)} must pass through`);
    }
  });

  // Back-compat: the retained isTruncated is exactly the truncated leg of the classifier.
  it('agrees with isTruncated on the truncation leg', () => {
    assert.equal(classifyStopReason('max_tokens') === 'truncated', isTruncated('max_tokens'));
    assert.equal(classifyStopReason('refusal') === 'truncated', isTruncated('refusal'));
  });

  // Own-property only: normalizeStopReason passes an unrecognized value through verbatim, so a rogue
  // provider/proxy emitting an Object.prototype method name must NOT resolve to the inherited function
  // (which is truthy and would be mistaken for a terminal action, aborting an otherwise clean round).
  it('a prototype-inherited key is NOT treated as a terminal action', () => {
    for (const k of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      assert.equal(classifyStopReason(k), null, `${k} must resolve to null, not an inherited value`);
    }
  });
});
