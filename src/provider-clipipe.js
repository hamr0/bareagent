'use strict';

const { spawn } = require('child_process');

class CLIPipeProvider {
  /**
   * Provider that pipes prompts to a CLI command via stdin and reads stdout.
   * @param {object} options
   * @param {string} options.command - CLI command to spawn (required).
   * @param {string[]} [options.args=[]] - Arguments to pass to the command.
   * @param {string} [options.cwd] - Working directory for the child process.
   * @param {object} [options.env] - Environment variables for the child process.
   * @param {number} [options.timeout=30000] - Timeout in milliseconds.
   * @throws {Error} `[CLIPipeProvider] requires command` — when options.command is missing.
   */
  constructor(options = {}) {
    if (!options.command) throw new Error('[CLIPipeProvider] requires command');
    this.command = options.command;
    this.args = options.args || [];
    this.cwd = options.cwd || undefined;
    this.env = options.env || undefined;
    this.timeout = options.timeout ?? 30000;
  }

  /**
   * Generate a response by piping messages to the CLI command.
   * @param {Array<object>} messages - Conversation messages in OpenAI format.
   * @param {Array<object>} [tools=[]] - Unused (CLI commands don't support tools).
   * @param {object} [options={}] - Unused.
   * @returns {Promise<{text: string, toolCalls: Array, usage: object}>}
   * @throws {Error} `[CLIPipeProvider] failed to spawn "cmd": ...` — when the command cannot be found or executed.
   * @throws {Error} `[CLIPipeProvider] process exited with code N: ...` — on non-zero exit.
   * @throws {Error} `[CLIPipeProvider] timed out after Nms` — when the process exceeds timeout.
   * @throws {Error} `[CLIPipeProvider] process produced no output` — when stdout is empty.
   */
  async generate(messages, tools = [], options = {}) {
    const prompt = this._formatPrompt(messages);
    const text = await this._spawn(prompt);
    return {
      text,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  /**
   * Convert OpenAI-format messages to a plain text prompt.
   * @param {Array<object>} messages
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
   * @returns {Promise<string>}
   */
  _spawn(prompt) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });

      child.on('error', err => {
        reject(new Error(`[CLIPipeProvider] failed to spawn "${this.command}": ${err.message}`));
      });

      child.on('close', code => {
        if (killed) return; // timeout already rejected
        if (code !== 0) {
          return reject(new Error(`[CLIPipeProvider] process exited with code ${code}: ${stderr.trim()}`));
        }
        const text = stdout.trim();
        if (!text) {
          return reject(new Error('[CLIPipeProvider] process produced no output'));
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
        reject(new Error(`[CLIPipeProvider] timed out after ${this.timeout}ms`));
      }, this.timeout);

      child.on('close', () => clearTimeout(timer));

      // Write prompt to stdin — catch errors silently (process may exit early)
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}

module.exports = { CLIPipeProvider };
