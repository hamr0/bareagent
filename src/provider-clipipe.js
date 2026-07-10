'use strict';

const { spawn } = require('child_process');
const { ProviderError } = require('./errors');

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
  }

  /**
   * Generate a response by piping messages to the CLI command.
   * @param {Message[]} messages - Conversation messages in OpenAI format.
   * @param {ToolDef[]} [tools=[]] - Unused (CLI commands don't support tools).
   * @param {Record<string, any>} [options={}] - Unused.
   * @returns {Promise<GenerateResult>}
   * @throws {Error} `[CLIPipeProvider] failed to spawn "cmd": ...` — when the command cannot be found or executed.
   * @throws {Error} `[CLIPipeProvider] process exited with code N: ...` — on non-zero exit.
   * @throws {Error} `[CLIPipeProvider] timed out after Nms` — when the process exceeds timeout.
   * @throws {Error} `[CLIPipeProvider] process produced no output` — when stdout is empty.
   */
  async generate(messages, tools = [], options = {}) {
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
