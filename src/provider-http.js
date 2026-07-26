'use strict';

const { TimeoutError } = require('./errors');

/**
 * BA-18 — shared request-timeout helper for the http(s)-based providers (Anthropic, OpenAI,
 * Gemini, Ollama). They all build a `http.ClientRequest` with only `req.on('error')` wired, so a
 * socket the server silently dropped — or a response that never starts — was bounded only by the
 * OS TCP timeout (~2h on Linux). That presents to the caller as a hang, not a failure, so every
 * retry/casualty policy above it is inert. This adds a finite, configurable idle bound in one
 * place so the four providers cannot drift.
 */

// 10 minutes: safely above any single non-streaming completion (a big reasoning response is a few
// minutes at most), well below the ~2h OS TCP default. These requests are non-streaming, so a legit
// slow completion can have no socket activity until the whole body arrives (TTFB ≈ generation time)
// — the default must clear that, not a typical round-trip.
const DEFAULT_TIMEOUT_MS = 600000;

/**
 * Resolve the effective timeout in ms. A per-call value overrides the instance default, but `null`
 * and `undefined` BOTH mean "inherit" — so a per-call `null` never shadows an instance-level
 * disable (finding-2). The explicit opt-out idiom is `0` or `Infinity` → returns 0 (no bound, the
 * pre-BA-18 behaviour). A NaN / negative / otherwise non-finite value is treated as a caller
 * MISTAKE and falls back to {@link DEFAULT_TIMEOUT_MS}: it must never silently disable the safety
 * bound, which would round optimistically back toward the ~2h hang BA-18 exists to prevent
 * (finding-3; the disable-edge bug class).
 * @param {number|undefined|null} instanceTimeout
 * @param {number|undefined|null} [callTimeout]
 * @returns {number} a finite positive ms bound, or 0 to disable
 */
function resolveTimeoutMs(instanceTimeout, callTimeout) {
  const raw = callTimeout != null ? callTimeout : instanceTimeout; // null/undefined per-call → inherit
  if (raw == null) return DEFAULT_TIMEOUT_MS;    // absent on both → finite default
  const n = Number(raw);
  if (n === 0 || n === Infinity) return 0;       // the explicit opt-out idiom → no bound
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TIMEOUT_MS; // NaN / negative / garbage → SAFE default, never a silent disable
  return n;                                      // finite positive bound
}

/**
 * Bound an in-flight ClientRequest on socket INACTIVITY. On timeout, destroy the request with a
 * retryable {@link TimeoutError} (`code: 'ETIMEDOUT'`) — `DEFAULT_RETRY_ON` classifies that as
 * transient, and the provider's own `req.on('error', reject)` turns it into a rejected promise, so
 * the caller regains control instead of hanging. Idle semantics (via `req.setTimeout`): the timer
 * resets on any socket activity, so a slow-but-streaming response is NOT killed — only a silent or
 * never-answering socket trips it. A `timeoutMs` of 0 is a no-op (bound disabled).
 * @param {import('http').ClientRequest} req
 * @param {number} timeoutMs - resolved bound; 0 disables
 * @param {string} providerName - for the error message (e.g. 'AnthropicProvider')
 */
function applyRequestTimeout(req, timeoutMs, providerName) {
  if (!(timeoutMs > 0)) return;
  req.setTimeout(timeoutMs, () => {
    req.destroy(new TimeoutError(`[${providerName}] request timed out after ${timeoutMs}ms of socket inactivity`));
  });
}

module.exports = { DEFAULT_TIMEOUT_MS, resolveTimeoutMs, applyRequestTimeout };
