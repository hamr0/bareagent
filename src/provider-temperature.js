'use strict';

// Graceful degradation for models that reject a non-default `temperature` (BA-10 / relayfact F34).
//
// Newer models — claude-sonnet-5 ("`temperature` is deprecated for this model."), OpenAI o1/gpt-5-class
// ("Unsupported value: 'temperature' … Only the default (1) …") — return a 400 for ANY non-default
// temperature. Left unhandled, the whole `generate` throws; upstream (e.g. recurse's `refineLeaf`) then
// collapses to `incomplete` with the executable close never run — a failure that LOOKS like "the model
// couldn't do it" when in fact no attempt was ever made.
//
// The fix keys off the API's own error TEXT, never a hardcoded model list, so it survives future models
// that drop the param and stays dormant on every model that accepts it. It retries ONCE without the
// temperature, and ONLY for the unsupported/deprecated class — a genuine out-of-range 400 re-throws
// (dropping it would mask a caller bug).

/** The error names `temperature` … */
const TEMP_NAMED = /temperature/i;
// … AND indicates it's unsupported/deprecated (NOT merely out of range — that stays a hard error).
// The `only…default` alternative uses a BOUNDED gap (`[^.]{0,40}`, not `.*`): an unbounded `.*` here is a
// quadratic-blowup footgun on a long provider/proxy-supplied error message that repeats "only" with no
// "default" (O(n) start positions × O(n) backtrack). The bound keeps it linear and still matches
// "Only the default (1) value is supported."
const TEMP_UNSUPPORTED = /(deprecat|unsupported|not support|does not support|no longer support|only\b[^.]{0,40}\bdefault|must be omitted|isn't supported|is not allowed)/i;

/**
 * Does this error mean the model rejected `temperature` as unsupported/deprecated?
 * @param {any} err - the rejection from a provider `_request` (a {@link ProviderError} carries `.status`).
 * @returns {boolean}
 */
function isTemperatureUnsupported(err) {
  const msg = err && typeof err.message === 'string' ? err.message : '';
  return !!err && err.status === 400 && TEMP_NAMED.test(msg) && TEMP_UNSUPPORTED.test(msg);
}

// Anthropic with thinking ENABLED rejects any non-default temperature ("`temperature` may only be set to 1
// when thinking is enabled" — live-confirmed 2026-10-11 on haiku-4-5; sonnet-5 appends "or in adaptive mode"). Thinking-on wins: the
// caller asked for thinking explicitly, so the temperature is what gets dropped. Narrow: a 400 that names
// BOTH words (no `.*`, so ReDoS-safe); only consulted when the caller passes `thinkingOn`.
const THINKING_NAMED = /thinking/i;

/**
 * Is this a 400 saying `temperature` conflicts with enabled thinking (names both)?
 * @param {any} err
 * @returns {boolean}
 */
function isTemperatureThinkingConflict(err) {
  const msg = err && typeof err.message === 'string' ? err.message : '';
  return !!err && err.status === 400 && TEMP_NAMED.test(msg) && THINKING_NAMED.test(msg);
}

/**
 * Issue a provider request; if it 400s because `temperature` is unsupported AND a temperature was
 * actually sent, strip it and retry ONCE. Returns whether the temperature was dropped so the caller
 * can report the EFFECTIVE temperature (the receipt must not claim a value the model ignored).
 *
 * @param {object} opts
 * @param {() => Promise<any>} opts.request - issues the API call (rejects `ProviderError` on 4xx).
 * @param {() => boolean} opts.hadTemperature - was a temperature actually in the request body?
 * @param {() => void} opts.stripTemperature - mutate the request body to remove the temperature.
 * @param {boolean} [opts.thinkingOn] - a thinkingMode 'on' shape is being sent: ALSO treat a 400 naming both temperature and thinking as droppable (thinking wins). Default off ⇒ behavior unchanged.
 * @param {(reason: 'unsupported'|'thinking') => void} [opts.warnOnce] - emit the one-time degrade warning for that reason (caller dedupes per instance AND reason).
 * @returns {Promise<{ data: any, temperatureDropped: boolean }>}
 */
async function requestWithTemperatureFallback({ request, hadTemperature, stripTemperature, thinkingOn, warnOnce }) {
  try {
    return { data: await request(), temperatureDropped: false };
  } catch (err) {
    // 'unsupported' wins when both match (the model refuses temperature outright); else the thinking conflict.
    const reason = isTemperatureUnsupported(err) ? 'unsupported' : (thinkingOn === true && isTemperatureThinkingConflict(err)) ? 'thinking' : null;
    if (reason && hadTemperature()) {
      stripTemperature();
      if (warnOnce) warnOnce(reason);
      return { data: await request(), temperatureDropped: true };
    }
    throw err;
  }
}

module.exports = { isTemperatureUnsupported, isTemperatureThinkingConflict, requestWithTemperatureFallback };
