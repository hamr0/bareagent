'use strict';

const https = require('https');
const http = require('http');
const { ProviderError } = require('./errors');
const { requestWithTemperatureFallback } = require('./provider-temperature');
const { normalizeStopReason } = require('./provider-stop-reason');
const { resolveTimeoutMs, applyRequestBounds } = require('./provider-http');
const { hasUsageSignal } = require('./provider-usage');

// BA-24: the raw Anthropic usage field names. Presence of any (even value 0) means the API reported a
// usage signal → build the object; absence of all means no signal → surface null (unpriceable).
const ANTHROPIC_USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

/** @param {string} hostname @returns {boolean} */
function isLoopbackHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').GenerateResult} GenerateResult */

/**
 * @typedef {object} AnthropicOptions
 * @property {string} [apiKey] - Anthropic API key (required).
 * @property {string} [model='claude-haiku-4-5-20251001'] - Model ID.
 * @property {string} [baseUrl='https://api.anthropic.com/v1'] - API base (override for proxies/gateways; the request posts to `${baseUrl}/messages`).
 * @property {boolean} [cacheSystem=false] - Opt-in prompt caching: send the system prompt with a `cache_control` breakpoint so Anthropic caches it. Anthropic does NOT auto-cache, so without this its cache tiers are always 0. Overridable per call via `generate(..., { cacheSystem })`. NOTE: on its own this rarely helps a tool loop — Anthropic's minimum cacheable prefix is 1024–4096 tokens (model-dependent) and a typical system persona is a few hundred, so it silently never caches. The transcript is where a tool loop's tokens actually live — see `cacheMessages`.
 * @property {boolean} [cacheMessages=false] - Opt-in TRANSCRIPT caching (BA-1): roll a `cache_control` breakpoint onto the last content block of the last message, so Anthropic caches the whole conversation prefix and the loop stops re-buying it at full price every round. In a tool loop the transcript IS the tool results (file bodies from `shell_read`) and it always ENDS on one, which `_toAnthropicMessage` rebuilds from scratch — so no caller-side seam (`assemble` included) can reach it, and this has to live in the provider. Measured on `claude-sonnet-5` with a ~15k-token tool-result transcript (`poc/ba1-message-caching.mjs`): steady state **$0.0753 → $0.0110 per round, 6.8x cheaper**; round 1 pays a 1.25x cache WRITE once. Off by default — it changes the wire format, so adopters opt in. Overridable per call via `generate(..., { cacheMessages })`. **Interaction:** a destructive `trim`/stash fold that rewrites the transcript PREFIX invalidates the cache (the prefix is the cache key), so a fold must keep the head stable or you re-pay the write premium every round for nothing.
 * @property {any} [thinking] - Opt-in extended thinking (BA-7), forwarded to `body.thinking` VERBATIM and unvalidated — e.g. `{ type: 'adaptive' }`, or `{ type: 'adaptive', display: 'summarized' }` to surface the reasoning (the default `display` is `'omitted'`). Deliberately opaque: this parameter has already broken once (`budget_tokens` was removed and now 400s on `claude-sonnet-5` / Opus 4.7+), and a library that reshapes it would need a release every time the API moves. Overridable per call via `generate(..., { thinking })`; pass `null` there to suppress an instance default.
 *
 *   **MEASURED CAVEAT — this option does not "turn thinking on".** On `claude-sonnet-5` adaptive thinking is ALREADY the default: sending this changed the observed thinking rate not at all (2/10 rounds with it vs 3/10 without — `poc/ba7-adaptive-default.mjs`). Its real use is pinning the mode and reaching `display`/`effort`. The change that mattered is that thinking blocks are now PRESERVED and replayed (see `Message.providerBlocks`), which happens whether or not you ever set this.
 * @property {boolean} [exposeErrorBody=false] - Attach the full upstream response to `err.body` on HTTP errors (off by default to avoid leaking unexpected fields through error logs; `err.message` still carries the API error).
 * @property {number} [timeoutMs=600000] - BA-18: request/idle timeout in ms. A silent or never-answering socket (dropped by the server, or a response that never starts) was otherwise bounded only by the OS TCP timeout (~2h) — a hang, not an error, so every retry policy above it was inert. Bounds on socket INACTIVITY (the timer resets on activity, so a slow-but-streaming response is not killed); on trip, `generate()` rejects with a retryable `TimeoutError` (`code: 'ETIMEDOUT'`, `context.bound: 'idle'`) that a wired `Retry` (`Loop({ retry })`) retries. Default 10 min sits above any single non-streaming completion; `0` or `Infinity` disables it (pre-BA-18 behaviour). Overridable per call via `generate(..., { timeoutMs })`.
 * @property {number} [deadlineMs=0] - BA-19: TOTAL call-duration deadline in ms, beside `timeoutMs`. The idle bound resets on any socket activity, so a response that trickles a byte forever (a "zombie stream") never trips it and hangs the caller for hours. This is an absolute, non-resetting wall-clock ceiling; on trip, `generate()` rejects with a TERMINAL `TimeoutError` (`code: 'EDEADLINE'`, `context.bound: 'deadline'`, `retryable: false` — a hard ceiling meant to STOP, not re-spend). DISABLED by default (a deliberately long single call is legitimate); `0`/`Infinity` disable. When both are set with `timeoutMs < deadlineMs`, a silent socket trips the idle bound first. Overridable per call via `generate(..., { deadlineMs })`.
 */

class AnthropicProvider {
  /**
   * @param {AnthropicOptions} [options]
   * @throws {Error} `[AnthropicProvider] requires apiKey` — when apiKey is missing.
   */
  constructor(options = {}) {
    if (!options.apiKey) throw new Error('[AnthropicProvider] requires apiKey');
    this.apiKey = options.apiKey.trim();
    this.model = options.model || 'claude-haiku-4-5-20251001';
    this.baseUrl = options.baseUrl || 'https://api.anthropic.com/v1';
    // Opt-in prompt caching: when true, the system prompt is sent with a cache_control breakpoint so
    // Anthropic caches it (unlike OpenAI/Gemini, Anthropic does NOT auto-cache — without this its
    // cache_read/cache_creation tiers are always 0). Default off keeps requests byte-identical to before.
    this.cacheSystem = options.cacheSystem === true;
    this.cacheMessages = options.cacheMessages === true;
    // BA-7: forwarded to `body.thinking` VERBATIM — deliberately unvalidated and un-reshaped. This
    // parameter has already broken once (`budget_tokens` was removed and now 400s on sonnet-5 /
    // Opus 4.7+; `{type:'adaptive'}` replaced it). A library that parses it would have to ship a
    // release every time Anthropic moves; passing it through means the caller can always express
    // the current API. Omit it to keep today's body byte-identical.
    this.thinking = options.thinking != null ? options.thinking : null;
    // See OpenAIProvider: attach full upstream body to err.body only on opt-in.
    this.exposeErrorBody = options.exposeErrorBody === true;
    // BA-18: request/idle timeout (ms). Resolved at call time (default 600000; 0/Infinity disable).
    this.timeoutMs = options.timeoutMs;
    // BA-19: total call-duration deadline (ms). Resolved at call time (default 0 = disabled).
    this.deadlineMs = options.deadlineMs;
  }

  /**
   * Generate a response from the Anthropic API.
   * @param {Message[]} messages - Conversation messages (OpenAI format, auto-converted).
   * @param {ToolDef[]} [tools=[]] - Tool definitions.
   * @param {Record<string, any>} [options={}] - Options (temperature, maxTokens, system, timeoutMs — a per-call override of the constructor's `timeoutMs`, see BA-18; deadlineMs — a per-call override of the constructor's `deadlineMs`, see BA-19).
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[AnthropicProvider] ...` — on HTTP errors (4xx/5xx) or invalid JSON response.
   */
  async generate(messages, tools = [], options = {}) {
    // Separate system message from conversation messages
    /** @type {any} */
    let system;
    /** @type {any[]} */
    const msgs = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system = m.content;
      } else {
        msgs.push(this._toAnthropicMessage(m));
      }
    }

    // Override with options.system if provided
    if (options.system) system = options.system;

    // Opt-in caching: mark a string system prompt as a cache breakpoint. Anthropic caches the prefix
    // up to this point (min ~1024-4096 tok depending on model; a shorter prompt silently won't cache —
    // harmless). A per-call options.cacheSystem can override the instance default. Arrays are passed
    // through untouched (the caller already shaped their own cache_control blocks).
    const cacheSystem = options.cacheSystem != null ? options.cacheSystem === true : this.cacheSystem;
    if (cacheSystem && typeof system === 'string' && system.length > 0) {
      system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    }

    // BA-1: roll a cache breakpoint onto the LAST content block of the LAST message. Anthropic caches the
    // whole prefix up to the mark, and rolling it forward each round keeps the GROWING transcript cached
    // — otherwise a tool loop re-buys its entire history at full input price, every single round.
    //
    // This MUST live here, not in a caller-side seam: in a tool loop the transcript IS the tool results,
    // it always ENDS on one, and `_toAnthropicMessage` rebuilds `role:'tool'` messages into fresh
    // `tool_result` blocks — discarding anything a caller attached. There is no other reachable seam.
    //
    // Copy-on-write, deliberately: a caller's `content` array is passed through by reference, so marking
    // it in place would mutate the caller's own message objects and leave a stale breakpoint behind on
    // every later round (Anthropic allows at most 4, and a stray one silently shifts the cache key).
    const cacheMessages = options.cacheMessages != null ? options.cacheMessages === true : this.cacheMessages;
    if (cacheMessages && msgs.length > 0) {
      const i = msgs.length - 1;
      const last = msgs[i];
      if (Array.isArray(last.content) && last.content.length > 0) {
        const blocks = last.content.slice();
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } };
        msgs[i] = { ...last, content: blocks };
      } else if (typeof last.content === 'string' && last.content.length > 0) {
        msgs[i] = { ...last, content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }] };
      }
      // An empty-content message gets no mark — there is no block to hang it on, and a synthesized empty
      // one would be a wire error. Under the cache minimum (1024–4096 tok, model-dependent) Anthropic
      // silently doesn't cache: harmless, just no saving. Never an error.
    }

    /** @type {Record<string, any>} */
    const body = {
      model: this.model,
      max_tokens: options.maxTokens || 4096,
      messages: msgs,
      ...(system && { system }),
      ...(options.temperature != null && { temperature: options.temperature }),
    };

    // BA-7 (b). Measured caveat, and it matters: on `claude-sonnet-5` adaptive thinking is ALREADY
    // the default — sending this changed the thinking rate not at all (2/10 vs 3/10 rounds,
    // `poc/ba7-adaptive-default.mjs`). So this option does NOT "turn thinking on"; it lets you pin
    // the mode and reach `display`/`effort`. The fix that actually mattered is the preservation
    // above, which applies whether or not you ever set this.
    const thinking = options.thinking !== undefined ? options.thinking : this.thinking;
    if (thinking) body.thinking = thinking;
    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    // BA-10: some models (e.g. claude-sonnet-5) reject a non-default `temperature` with a 400 — drop it
    // and retry once rather than let the whole call fail. `temperatureDropped` flows back so an upstream
    // receipt (recurse's refineLeaf) can report the effective temperature, not the one the model ignored.
    const timeoutMs = resolveTimeoutMs(this.timeoutMs, options.timeoutMs);
    const deadlineMs = resolveTimeoutMs(this.deadlineMs, options.deadlineMs, 0, 'deadlineMs');
    const { data, temperatureDropped } = await requestWithTemperatureFallback({
      request: () => this._request(body, timeoutMs, deadlineMs),
      hadTemperature: () => body.temperature != null,
      stripTemperature: () => { delete body.temperature; },
      warnOnce: () => this._warnTemperatureDropped(),
    });

    let text = '';
    /** @type {import('../types').ToolCall[]} */
    const toolCalls = [];
    // BA-7: everything that is NOT text/tool_use is a block our normalized {text, toolCalls} shape
    // cannot express — today that means `thinking` and `redacted_thinking`. We used to drop these on
    // the floor. Anthropic's contract is that they are echoed back UNCHANGED (signature included) when
    // continuing a tool-use conversation, so they are collected OPAQUELY here: whatever the block is,
    // we keep its bytes. Deliberately not a `block.type === 'thinking'` check — a future block type
    // would be silently dropped again, which is the exact bug being fixed.
    /** @type {any[]} */
    const nativeBlocks = [];
    for (const block of data.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, arguments: block.input });
      else nativeBlocks.push(block);
    }

    return {
      text,
      toolCalls,
      model: data.model || this.model,
      // BA-6: why generation ended. `max_tokens` here means the API CUT THIS ROUND OFF — the Loop must
      // not read it as a finished turn, and must not execute any tool call it carries (a complete call
      // arrives as `tool_use`; one riding a `max_tokens` round was cut off mid-generation).
      stopReason: normalizeStopReason(data.stop_reason, 'anthropic', { hasToolCalls: toolCalls.length > 0 }),
      // BA-7: the opaque blocks, tagged so they can only ever be replayed to the model that signed
      // them. A thinking `signature` is model-bound; on a mismatch we drop them and degrade to the
      // pre-BA-7 behavior (a lossy request that still succeeds) rather than risk a 400.
      ...(nativeBlocks.length > 0 && {
        providerBlocks: { provider: 'anthropic', model: this.model, blocks: nativeBlocks },
      }),
      // Anthropic's `input_tokens` is ALREADY the uncached remainder (cached tokens are reported
      // separately, not folded in — verified live), so no subtraction here, unlike OpenAI/Gemini.
      // BA-24: honest null when the API returned no usage block (or an empty one) — do NOT manufacture
      // an all-zeros object, which launders an unpriceable round into a $0 PRICED one.
      usage: hasUsageSignal(data.usage, ANTHROPIC_USAGE_KEYS)
        ? {
            inputTokens: data.usage.input_tokens || 0,
            outputTokens: data.usage.output_tokens || 0,
            cacheReadTokens: data.usage.cache_read_input_tokens || 0,
            cacheCreationTokens: data.usage.cache_creation_input_tokens || 0,
          }
        : null,
      ...(temperatureDropped && { temperatureDropped: true }),
    };
  }

  /** One-time warning that this model rejected `temperature` and the request was retried without it (BA-10). */
  _warnTemperatureDropped() {
    if (this._warnedTempDropped) return;
    this._warnedTempDropped = true;
    console.warn(`[AnthropicProvider] '${this.model}' rejected a non-default 'temperature' (unsupported/deprecated) — retrying without it. Further drops from this provider instance are silent.`);
  }

  /**
   * BA-7: the provider-native blocks to replay at the FRONT of an assistant turn's content, or `[]`.
   *
   * Only ever returns blocks this model itself produced. The tag carries `this.model` (the CONFIGURED
   * id, not the response's resolved one — those can differ by date suffix, and a mismatch there would
   * silently disable preservation, which is the very bug class BA-7 exists to close).
   *
   * Front, because Anthropic requires `thinking` to lead the content array — the verbatim order we
   * measured a successful round-trip on (`poc/ba7-thinking-contract.mjs`, R3).
   *
   * @param {Message} msg
   * @returns {any[]}
   */
  _nativeBlocks(msg) {
    const pb = /** @type {any} */ (msg).providerBlocks;
    if (!pb || pb.provider !== 'anthropic' || !Array.isArray(pb.blocks) || pb.blocks.length === 0) return [];
    // A thinking signature is bound to the model that issued it. Swap models mid-transcript and these
    // blocks are not ours to replay: drop them (lossy but valid) rather than send a signature this
    // model will reject.
    if (pb.model !== this.model) return [];
    return pb.blocks;
  }

  /**
   * @param {Message} msg
   * @returns {any}
   */
  _toAnthropicMessage(msg) {
    // Convert OpenAI-format tool results → Anthropic tool_result blocks
    if (msg.role === 'tool') {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        }],
      };
    }
    // Convert OpenAI-format assistant tool_calls → Anthropic tool_use content blocks
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      /** @type {any[]} */
      const content = [];
      // BA-7: thinking blocks lead, then text, then tool_use — this is THE turn the contract is about
      // (continuing a tool-use conversation). Note the normalized `content`/`tool_calls` stay the
      // source of truth: we replay only the opaque blocks, never a cached copy of the text, so a
      // `trim`/`assemble` seam that rewrites this message is not silently undone.
      content.push(...this._nativeBlocks(msg));
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments,
        });
      }
      return { role: 'assistant', content };
    }
    // A tool-call-free assistant turn can still carry thinking (a final answer, or an earlier turn a
    // caller replays into a fresh run). Same rule: native blocks lead.
    if (msg.role === 'assistant') {
      const native = this._nativeBlocks(msg);
      if (native.length > 0) {
        const content = [...native];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        return { role: 'assistant', content };
      }
    }
    return { role: msg.role, content: msg.content };
  }

  /**
   * @param {Record<string, any>} body
   * @param {number} [timeoutMs=0] - Idle-socket timeout (ms); 0 disables. See BA-18 / provider-http.
   * @param {number} [deadlineMs=0] - Total call-duration deadline (ms); 0 disables. See BA-19 / provider-http.
   * @returns {Promise<any>}
   */
  _request(body, timeoutMs = 0, deadlineMs = 0) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const url = new URL(this.baseUrl + '/messages');
      const transport = url.protocol === 'https:' ? https : http;
      // Plaintext key to a remote host exposes it on the wire; loopback (test servers / local
      // proxies) is the legitimate http case. Warn once, mirror OpenAIProvider.
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !this._warnedInsecure) {
        this._warnedInsecure = true;
        console.warn(`[AnthropicProvider] sending x-api-key over PLAINTEXT http to ${url.hostname} — key exposed on the wire. Use https.`);
      }
      const req = transport.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
      }, (res) => {
        let chunks = '';
        res.on('data', d => chunks += d);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(chunks);
            if ((res.statusCode ?? 0) >= 400) {
              return reject(new ProviderError(
                `[AnthropicProvider] ${parsed.error?.message || `HTTP ${res.statusCode}`}`,
                /** @type {any} */ ({ status: res.statusCode, body: this.exposeErrorBody ? parsed : undefined })
              ));
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`[AnthropicProvider] Invalid JSON response: ${chunks.slice(0, 200)}`));
          }
        });
      });
      applyRequestBounds(req, { timeoutMs, deadlineMs }, 'AnthropicProvider');
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}

module.exports = { AnthropicProvider };
