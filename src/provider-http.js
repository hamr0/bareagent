'use strict';

const { TimeoutError, ValidationError } = require('./errors');

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
 * Resolve an effective timeout-shaped ms bound. A per-call value overrides the instance default, but
 * `null` and `undefined` BOTH mean "inherit" — so a per-call `null` never shadows an instance-level
 * disable. The explicit opt-out idiom is `0` or `Infinity` → returns 0 (no bound). When the knob is
 * UNSET on both, returns `defaultMs` (the idle bound's 10 min, or 0/disabled for the deadline).
 *
 * The disable-edge (finding-3, and the BA-4/5/6 optimistic-rounding family) is the load-bearing part:
 * a config MISTAKE — a NaN / negative / non-numeric value the caller EXPLICITLY set (e.g.
 * `Number(process.env.X)` on an unset var, or a string `'30s'`) — must never SILENTLY remove a bound
 * the caller evidently tried to set. Two cases, decided by whether the knob has a safe default:
 *   - `defaultMs > 0` (the BA-18 idle bound): fail SAFE to that real default (a garbage idle value
 *     keeps the 10-min safety net — byte-identical to the shipped BA-18 behaviour).
 *   - `defaultMs === 0` (the BA-19 deadline, disabled-by-design): there is NO safe bound to fall back
 *     to, so silently returning 0 would reintroduce the very hang the deadline exists to prevent
 *     (BA-19 review finding 1). Fail LOUD instead — throw a {@link ValidationError} so the config
 *     mistake surfaces immediately, rather than running unbounded for hours.
 * NOTE: an UNSET deadline (null/undefined) is legitimate and still returns 0 — only an explicitly-set
 * garbage value throws.
 * @param {number|undefined|null} instanceTimeout
 * @param {number|undefined|null} [callTimeout]
 * @param {number} [defaultMs=DEFAULT_TIMEOUT_MS] - value returned when the knob is unset (or garbage, if >0)
 * @param {string} [name='timeoutMs'] - knob name for the throw message
 * @returns {number} a finite positive ms bound, or 0 to disable
 * @throws {ValidationError} when the value is explicitly set but garbage AND `defaultMs` is 0 (no safe fallback)
 */
function resolveTimeoutMs(instanceTimeout, callTimeout, defaultMs = DEFAULT_TIMEOUT_MS, name = 'timeoutMs') {
  const raw = callTimeout != null ? callTimeout : instanceTimeout; // null/undefined per-call → inherit
  if (raw == null) return defaultMs;             // absent on both → the knob's own default (0 = disabled)
  const n = Number(raw);
  if (n === 0 || n === Infinity) return 0;       // the explicit opt-out idiom → no bound
  if (Number.isFinite(n) && n > 0) return n;     // finite positive bound
  // Explicitly set but garbage. Never SILENTLY disable a bound the caller tried to set.
  if (defaultMs > 0) return defaultMs;           // a real default exists → fail safe to it (BA-18)
  throw new ValidationError(
    `[provider-http] invalid ${name}: ${String(raw).slice(0, 40)} — expected a positive number, 0, or Infinity`
  );
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
    // `context.bound: 'idle'` mirrors the deadline trip's discriminator (BA-19) so a consumer can
    // switch on one uniform field to tell which timer spoke, not just on the `code`.
    req.destroy(new TimeoutError(
      `[${providerName}] request timed out after ${timeoutMs}ms of socket inactivity`,
      { context: { bound: 'idle' } }
    ));
  });
}

/**
 * BA-19 — bound an in-flight ClientRequest on TOTAL call duration, beside {@link applyRequestTimeout}.
 * The idle bound (`req.setTimeout`) resets on ANY socket activity, so a response that trickles a byte
 * forever (a "zombie stream") never trips it — bytes keep arriving while the response never completes,
 * and the call hangs until the OS TCP timeout (~4.5h observed). This adds an absolute, non-resetting
 * wall-clock ceiling: a plain `setTimeout` that destroys the request whether or not the socket is
 * active. On trip, the request is destroyed with a TERMINAL {@link TimeoutError} — distinct
 * `code: 'EDEADLINE'` and `context.bound: 'deadline'` (so a consumer routing governance stops vs
 * transport casualties can tell which timer fired), and `retryable: false` because a deadline is a
 * HARD ceiling the caller set to STOP: auto-retrying would re-spend up to another full `deadlineMs`
 * of tokens/budget. Disabled-by-design (a deliberately long single call is legitimate); a
 * `deadlineMs` of 0 is a no-op. When both bounds are armed and `timeoutMs < deadlineMs`, a silent
 * socket trips the idle bound first; only a still-active-but-never-completing stream reaches the
 * deadline. The timer is unref'd (never keeps the event loop alive) and cleared when the request
 * closes (no dangling handle, no late destroy of a settled request).
 * @param {import('http').ClientRequest} req
 * @param {number} deadlineMs - resolved bound; 0 disables
 * @param {string} providerName - for the error message (e.g. 'AnthropicProvider')
 */
function applyRequestDeadline(req, deadlineMs, providerName) {
  if (!(deadlineMs > 0)) return;
  const timer = setTimeout(() => {
    req.destroy(new TimeoutError(
      `[${providerName}] request exceeded its total deadline of ${deadlineMs}ms`,
      { code: 'EDEADLINE', retryable: false, context: { bound: 'deadline' } }
    ));
  }, deadlineMs);
  if (timer.unref) timer.unref();
  req.once('close', () => clearTimeout(timer));
}

/**
 * Wire ALL request bounds onto a ClientRequest in one call — the single seam each provider's
 * `_request` uses, so the idle (BA-18) + deadline (BA-19) wiring is not copy-pasted at four call
 * sites (BA-19 review finding 2). A future third bound is added HERE once, not at every provider.
 * Each individual bound is a no-op when its ms value is 0/absent, so an unset knob costs nothing.
 * @param {import('http').ClientRequest} req
 * @param {{ timeoutMs?: number, deadlineMs?: number }} bounds - resolved ms bounds; 0/absent disables each
 * @param {string} providerName - for error messages (e.g. 'AnthropicProvider')
 */
function applyRequestBounds(req, bounds, providerName) {
  applyRequestTimeout(req, (bounds && bounds.timeoutMs) || 0, providerName);
  applyRequestDeadline(req, (bounds && bounds.deadlineMs) || 0, providerName);
}

module.exports = { DEFAULT_TIMEOUT_MS, resolveTimeoutMs, applyRequestTimeout, applyRequestDeadline, applyRequestBounds };
