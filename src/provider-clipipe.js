'use strict';

const { spawn } = require('child_process');
const { ProviderError } = require('./errors');
const { buildToolSystemPrompt, renderTranscript, resolveToolProtocol } = require('./provider-clipipe-tools');

/** @typedef {import('../types').Message} Message */
/** @typedef {import('../types').ToolDef} ToolDef */
/** @typedef {import('../types').GenerateResult} GenerateResult */

/**
 * @typedef {object} CLIPipeOptions
 * @property {string} [command] - CLI command to spawn (required).
 * @property {string[]} [args=[]] - Arguments to pass to the command.
 * @property {string} [cwd] - Working directory for the child process.
 * @property {Record<string, string>} [env] - Environment variables for the child process.
 * @property {number} [timeout=30000] - Timeout in milliseconds.
 * @property {string} [systemPromptFlag] - CLI flag for system prompt (e.g. '--system'). When set, system messages are extracted and passed via this flag instead of stdin.
 * @property {(chunk: string) => void} [onChunk] - Called with each stdout chunk as it streams.
 * @property {'claude-json'|((stdout: string) => Partial<GenerateResult>)} [parse] - Opt-in structured-output parser for stdout. Default (unset) returns stdout verbatim as `text` with zero usage (no behavior change). `'claude-json'` is a shipped preset for `claude -p --output-format json`: it maps the CLI's result envelope onto `GenerateResult` (text←`result`, usage←`usage.*`, model←first `modelUsage` key, costUsd←`total_cost_usd`) and throws `ProviderError` on malformed JSON or an error envelope (`is_error`/non-success subtype). A function is the CLI-agnostic escape hatch: it receives trimmed stdout and returns a partial `GenerateResult` (merged over defaults); throw to signal a parse failure.
 * @property {'claude'} [toolProtocol] - Opt into TOOL MODE (v0.32.0). A subscription CLI is a plain turn-provider with no native tool channel; this enables schema-validated tool EMULATION so a caller's `tools` work over the CLI (letting a Claude/etc. subscription drive an agentic Loop without metered-API spend). When set, ANY `generate(msgs, tools)` call with a non-empty `tools` array auto-uses emulation (the caller's own system stance + a tool manifest + a JSON envelope, parsed back into normalized `toolCalls`); an empty `tools` array is unchanged plain-text. When NOT set, `tools` are IGNORED (plain-text mode, the long-standing behavior — a non-tool-calling CLI can legitimately sit in a Loop that has tools mounted) with a one-time `console.warn` for visibility. Claude-only for now (`'claude'`); the claude-specific flags/schema/parse live in `provider-clipipe-tools.js` so a second CLI slots in behind the same seam. NOTE: tool mode requires a capable model — weak models (e.g. haiku) answer in prose instead of calling tools; see `probeCapability`.
 * @property {boolean} [probeCapability=true] - (tool mode only) On the first tool-mode `generate`, run ONE cheap upfront probe that asks the model to obtain unknowable info via a tool. If it answers in prose instead of emitting a tool_call, throw a loud `ProviderError` naming the model — FAIL FAST rather than silently degrade mid-run (the weak-model failure mode). Behaviour-based, never a model name-list (a roster goes stale, BA-10). The verdict is cached per instance (one probe per provider, not per turn). Set `false` to skip when the caller already knows the model is capable.
 */

class CLIPipeProvider {
  /**
   * Provider that pipes prompts to a CLI command via stdin and reads stdout.
   * @param {CLIPipeOptions} [options]
   * @throws {Error} `[CLIPipeProvider] requires command` — when options.command is missing.
   */
  constructor(options = {}) {
    if (!options.command) throw new Error('[CLIPipeProvider] requires command');
    this.command = options.command;
    this.args = options.args || [];
    this.cwd = options.cwd || undefined;
    this.env = options.env || undefined;
    this.timeout = options.timeout ?? 30000;
    this.systemPromptFlag = options.systemPromptFlag || null;
    this.onChunk = options.onChunk || null;
    if (options.parse != null && options.parse !== 'claude-json' && typeof options.parse !== 'function') {
      throw new Error("[CLIPipeProvider] options.parse must be 'claude-json' or a function");
    }
    this.parse = options.parse || null;
    // Tool mode (v0.32.0). Resolve the protocol adapter eagerly so an unknown name fails at
    // construction, not mid-run. `_toolCapability` caches the upfront probe verdict per instance
    // (null = not yet probed; a Promise while in flight; true once confirmed capable).
    this.toolProtocol = options.toolProtocol ? resolveToolProtocol(options.toolProtocol) : null;
    this.probeCapability = options.probeCapability !== false;
    /** @type {Promise<void>|null} */
    this._toolCapability = null;
  }

  /**
   * Generate a response by piping messages to the CLI command. With a `toolProtocol` configured and
   * a non-empty `tools` array, routes to schema-validated tool EMULATION (v0.32.0); otherwise the
   * plain-text path below (unchanged). Passing `tools` with no `toolProtocol` throws — a silent
   * no-tools degrade is exactly the failure tool mode exists to prevent.
   * @param {Message[]} messages - Conversation messages in OpenAI format.
   * @param {ToolDef[]} [tools=[]] - Caller tools. Honored only in tool mode (`toolProtocol` set).
   * @param {Record<string, any>} [options={}] - Unused.
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[CLIPipeProvider] failed to spawn "cmd": ...` — when the command cannot be found or executed.
   * @throws {Error} `[CLIPipeProvider] process exited with code N: ...` — on non-zero exit.
   * @throws {Error} `[CLIPipeProvider] timed out after Nms` — when the process exceeds timeout.
   * @throws {Error} `[CLIPipeProvider] process produced no output` — when stdout is empty.
   */
  async generate(messages, tools = [], options = {}) {
    if (Array.isArray(tools) && tools.length > 0) {
      if (this.toolProtocol) return this._generateWithTools(messages, tools);
      // No protocol configured → plain-text mode, tools IGNORED — the long-standing behavior, kept
      // for backward compatibility (a non-tool-calling CLI legitimately coexists in a Loop that has
      // tools mounted, e.g. via MCP; the Loop's contract lets a provider simply not call them).
      // A silent ignore is the trap the caller might not notice, so warn ONCE per instance (the
      // provider-temperature BA-10 pattern) — visible, not fatal. Genuine loud-failure for tool
      // mode lives in the capability probe, where a weak model that SHOULD call tools cannot.
      if (!this._warnedNoProtocol) {
        this._warnedNoProtocol = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[CLIPipeProvider] received tools but no toolProtocol is configured — tools are IGNORED ' +
          "(plain-text mode). Construct with { toolProtocol: 'claude' } to enable tool emulation.",
        );
      }
    }

    /** @type {string[]} */
    let extraArgs = [];
    let promptMessages = messages;

    if (this.systemPromptFlag) {
      const systemMessages = messages.filter(m => m.role === 'system');
      if (systemMessages.length > 0) {
        const systemContent = systemMessages.map(m => m.content).join('\n\n');
        extraArgs = [this.systemPromptFlag, systemContent];
        promptMessages = messages.filter(m => m.role !== 'system');
      }
    }

    const prompt = this._formatPrompt(promptMessages);
    const stdout = await this._spawn(prompt, extraArgs);

    if (this.parse === 'claude-json') return this._parseClaudeJson(stdout);
    if (typeof this.parse === 'function') {
      const partial = this.parse(stdout) || {};
      return {
        text: '',
        toolCalls: [],
        ...partial,
        usage: { inputTokens: 0, outputTokens: 0, ...(partial.usage || {}) },
      };
    }
    return {
      text: stdout,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  /**
   * Tool mode (v0.32.0) — one turn of schema-validated tool emulation. Renders the Loop's
   * OpenAI-shaped transcript to text, injects the caller's system stance + a tool manifest + the
   * envelope contract, spawns the CLI under the protocol's flags, and parses the envelope back into
   * normalized `toolCalls` (a `tool_call`) or `text` (a `final_answer`). The Loop drives the cycle.
   * @param {Message[]} messages
   * @param {ToolDef[]} tools
   * @returns {Promise<GenerateResult>}
   */
  async _generateWithTools(messages, tools) {
    await this._ensureToolCapability();
    const proto = this.toolProtocol;
    if (!proto) throw new ProviderError('[CLIPipeProvider] tool mode not configured', /** @type {any} */ ({ status: 0 })); // unreachable: only called from the tools branch
    const sysMsg = messages.find((m) => m.role === 'system');
    const systemPrompt = buildToolSystemPrompt(sysMsg && typeof sysMsg.content === 'string' ? sysMsg.content : null, tools);
    const stdout = await this._spawn(renderTranscript(messages), proto.turnArgs(systemPrompt));
    const parsed = proto.parseResult(stdout);

    /** @type {GenerateResult} */
    const result = { text: '', toolCalls: [], usage: parsed.usage, model: parsed.model ?? null };
    if (Number.isFinite(parsed.costUsd)) result.costUsd = parsed.costUsd;
    if (parsed.action === 'tool_call') {
      this._toolCallSeq = (this._toolCallSeq || 0) + 1;
      result.toolCalls = [{ id: `cli_${this._toolCallSeq}`, name: parsed.toolName || '', arguments: parsed.toolArguments || {} }];
    } else {
      result.text = parsed.answer || '';
    }
    return result;
  }

  /**
   * Run the upfront capability probe ONCE per instance (cached), unless `probeCapability` is off.
   * A model that answers the probe in prose instead of emitting a tool_call throws a loud
   * `ProviderError` — fail fast, never silently degrade to a no-tools run mid-conversation.
   * @returns {Promise<void>}
   */
  _ensureToolCapability() {
    if (!this.probeCapability) return Promise.resolve();
    // Cache the in-flight promise so concurrent first-calls share one probe, and a resolved
    // capable verdict is never re-probed.
    if (this._toolCapability) return this._toolCapability;
    const proto = this.toolProtocol;
    if (!proto) return Promise.resolve(); // unreachable: only called from the tools branch
    this._toolCapability = (async () => {
      const stdout = await this._spawn(proto.probe.user, proto.turnArgs(proto.probe.system));
      let parsed;
      try {
        parsed = proto.parseResult(stdout);
      } catch (err) {
        // A malformed probe response is itself an incapability signal — name it as such.
        this._toolCapability = null; // allow a retry on a transient parse failure
        throw new ProviderError(`[CLIPipeProvider] tool-mode capability probe failed to parse: ${/** @type {Error} */ (err).message}`, /** @type {any} */ ({ status: 0 }));
      }
      if (!proto.probe.isCapable(parsed)) {
        const model = this._modelFromArgs();
        throw new ProviderError(
          `[CLIPipeProvider] the CLI model${model ? ` '${model}'` : ''} is not capable of tool use: the ` +
          'capability probe answered in prose instead of emitting a tool_call. Weak models (e.g. haiku) ' +
          'cannot drive tool emulation reliably — use a stronger model for tool mode, or run without ' +
          'tools for plain-text. (Set { probeCapability: false } to skip this check.)',
          /** @type {any} */ ({ status: 0 }),
        );
      }
    })();
    return this._toolCapability;
  }

  /** Best-effort model id from `--model X` in the base args, for a clearer probe-failure message. */
  _modelFromArgs() {
    const i = this.args.indexOf('--model');
    return i >= 0 && i + 1 < this.args.length ? this.args[i + 1] : null;
  }

  /**
   * Map the `claude -p --output-format json` result envelope onto a normalized GenerateResult.
   * The caller explicitly opted into structured output, so a malformed or error envelope is a LOUD
   * ProviderError — never a silent fall-back to raw text.
   * @param {string} stdout - Trimmed stdout from the CLI.
   * @returns {GenerateResult}
   * @throws {ProviderError} On non-JSON stdout, or an error envelope (`is_error` / non-success subtype).
   */
  _parseClaudeJson(stdout) {
    let obj;
    try {
      obj = JSON.parse(stdout);
    } catch (_) {
      const preview = stdout.length > 200 ? `${stdout.slice(0, 200)}…` : stdout;
      throw new ProviderError(`[CLIPipeProvider] parse:'claude-json' expected JSON on stdout, got: ${preview}`, /** @type {any} */ ({ status: 0 }));
    }
    if (!obj || typeof obj !== 'object') {
      throw new ProviderError(`[CLIPipeProvider] parse:'claude-json' expected a JSON object, got ${obj === null ? 'null' : typeof obj}`, /** @type {any} */ ({ status: 0 }));
    }
    if (obj.is_error === true || obj.subtype !== 'success') {
      const detail = typeof obj.result === 'string' ? obj.result : JSON.stringify(obj.result ?? null);
      throw new ProviderError(`[CLIPipeProvider] claude CLI reported failure (subtype='${obj.subtype}'): ${detail}`, /** @type {any} */ ({ status: 0 }));
    }

    const u = (obj.usage && typeof obj.usage === 'object') ? obj.usage : {};
    /** @type {import('../types').Usage} */
    const usage = {
      inputTokens: Number(u.input_tokens) || 0,
      outputTokens: Number(u.output_tokens) || 0,
    };
    // Absent cache tiers mean the model didn't cache — omit rather than emit a synthetic 0 (per Usage docs).
    if (Number.isFinite(u.cache_read_input_tokens)) usage.cacheReadTokens = u.cache_read_input_tokens;
    if (Number.isFinite(u.cache_creation_input_tokens)) usage.cacheCreationTokens = u.cache_creation_input_tokens;

    // `modelUsage` is an object keyed by model id (e.g. {"claude-opus-4-8[1m]": {...}}) — take the first key.
    const model = (obj.modelUsage && typeof obj.modelUsage === 'object')
      ? (Object.keys(obj.modelUsage)[0] ?? null)
      : null;

    /** @type {GenerateResult} */
    const result = {
      text: typeof obj.result === 'string' ? obj.result : '',
      toolCalls: [],
      usage,
      model,
    };
    // The CLI's own price is authoritative (subscription runs report an equivalent cost even at $0
    // marginal) — feeds bareguard's USD axis with no local rate table. Only a finite number counts.
    if (Number.isFinite(obj.total_cost_usd)) result.costUsd = obj.total_cost_usd;
    return result;
  }

  /**
   * Convert OpenAI-format messages to a plain text prompt.
   * @param {Message[]} messages
   * @returns {string}
   */
  _formatPrompt(messages) {
    return messages.map(m => {
      const role = m.role.charAt(0).toUpperCase() + m.role.slice(1);
      return `${role}: ${m.content}`;
    }).join('\n') + '\n';
  }

  /**
   * Spawn the CLI process, pipe prompt to stdin, collect stdout.
   * @param {string} prompt
   * @param {string[]} [extraArgs=[]] - Additional args appended after this.args.
   * @returns {Promise<string>}
   */
  _spawn(prompt, extraArgs = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [...this.args, ...extraArgs], /** @type {any} */ ({
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));

      let stdout = '';
      let stderr = '';

      // Settle exactly once, no matter which combination of events fires. 'close' can be
      // withheld indefinitely when the CLI spawns a grandchild that inherits its stdio pipes
      // (the child exits, but the pipes stay open) — observed live as a generate() promise
      // that never settled. Every path below funnels through settle().
      let settled = false;
      /** @type {NodeJS.Timeout[]} */
      const timers = [];
      const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };
      const settle = (/** @type {Error|null} */ err, text = '') => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        if (err) reject(err); else resolve(text);
      };

      const finish = (/** @type {number|null} */ code) => {
        if (code !== 0) {
          // The claude CLI reports errors on STDOUT (a JSON envelope) with stderr often
          // empty — fall back to a stdout tail so the operator never sees a blank reason.
          const detail = stderr.trim() || (stdout.trim() ? `(stderr empty) stdout: ${stdout.trim().slice(-400)}` : '');
          return settle(new ProviderError(`[CLIPipeProvider] process exited with code ${code}: ${detail}`, /** @type {any} */ ({ status: code })));
        }
        const text = stdout.trim();
        if (!text) {
          return settle(new ProviderError('[CLIPipeProvider] process produced no output', /** @type {any} */ ({ status: 0 })));
        }
        settle(null, text);
      };

      child.stdout.on('data', d => {
        stdout += d;
        try {
          this.onChunk?.(d.toString());
        } catch (err) {
          // an observer callback must fail the call loudly, never crash the host process
          settle(new ProviderError(`[CLIPipeProvider] onChunk callback threw: ${/** @type {Error} */ (err).message}`, /** @type {any} */ ({ status: 0 })));
        }
      });
      child.stderr.on('data', d => { stderr += d; });

      child.on('error', err => {
        settle(new ProviderError(`[CLIPipeProvider] failed to spawn "${this.command}": ${err.message}`, /** @type {any} */ ({ status: 0 })));
      });

      // Primary completion path: all stdio drained.
      child.on('close', code => finish(code));

      // Fallback: the process exited but 'close' is being held open by inherited pipes.
      // Give real drainage a short grace, then finish with what has arrived — a bounded
      // wait, never a hang.
      child.on('exit', code => later(() => finish(code), 2000));

      later(() => {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1000).unref?.();
        settle(new ProviderError(`[CLIPipeProvider] timed out after ${this.timeout}ms`, /** @type {any} */ ({ status: 0 })));
      }, this.timeout);

      // Write prompt to stdin — catch errors silently (process may exit early)
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}

module.exports = { CLIPipeProvider };
