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
    const text = await this._spawn(prompt, extraArgs);
    return {
      text,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
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
      let killed = false;

      child.stdout.on('data', d => { stdout += d; this.onChunk?.(d.toString()); });
      child.stderr.on('data', d => { stderr += d; });

      child.on('error', err => {
        reject(new ProviderError(`[CLIPipeProvider] failed to spawn "${this.command}": ${err.message}`, /** @type {any} */ ({ status: 0 })));
      });

      child.on('close', code => {
        if (killed) return; // timeout already rejected
        if (code !== 0) {
          return reject(new ProviderError(`[CLIPipeProvider] process exited with code ${code}: ${stderr.trim()}`, /** @type {any} */ ({ status: code })));
        }
        const text = stdout.trim();
        if (!text) {
          return reject(new ProviderError('[CLIPipeProvider] process produced no output', /** @type {any} */ ({ status: 0 })));
        }
        resolve(text);
      });

      // Timeout handling
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) {}
        }, 1000);
        reject(new ProviderError(`[CLIPipeProvider] timed out after ${this.timeout}ms`, /** @type {any} */ ({ status: 0 })));
      }, this.timeout);

      child.on('close', () => clearTimeout(timer));

      // Write prompt to stdin — catch errors silently (process may exit early)
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}

module.exports = { CLIPipeProvider };
