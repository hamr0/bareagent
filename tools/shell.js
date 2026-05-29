'use strict';

/**
 * Pure-Node shell tools — cross-platform (linux, macOS, Windows), no external binaries.
 *
 * Three primitives:
 *   shell_read  — read a file or list a directory
 *   shell_grep  — regex search across files (JS regex, no grep/rg/findstr)
 *   shell_exec  — run a shell command with timeout + max buffer
 *
 * All three run through Loop's policy hook when wired via `new Loop({ policy })`.
 * Library ships zero baked-in allowlist — gating is the agent author's responsibility.
 */

/** @typedef {import('../types').ToolDef} ToolDef */

const fs = require('node:fs/promises');
const path = require('node:path');
const { exec, execFile } = require('node:child_process');

const DEFAULT_READ_MAX_BYTES = 256 * 1024;       // 256 KB
const DEFAULT_GREP_MAX_MATCHES = 200;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_MAX_BUFFER = 1024 * 1024;     // 1 MB

/**
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(home, p.slice(1));
  }
  return p;
}

/**
 * @param {string} rawPath
 * @param {number} [maxBytes]
 */
async function readEntry(rawPath, maxBytes) {
  const resolved = path.resolve(expandHome(rawPath));
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const lines = entries.map(e => {
      const kind = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file';
      return `${kind}\t${e.name}`;
    });
    return `dir ${resolved}\n${lines.join('\n')}`;
  }
  const cap = maxBytes || DEFAULT_READ_MAX_BYTES;
  if (stat.size > cap) {
    const fh = await fs.open(resolved, 'r');
    try {
      const buf = Buffer.alloc(cap);
      await fh.read(buf, 0, cap, 0);
      return buf.toString('utf8') + `\n\n[truncated: ${stat.size - cap} more bytes not shown]`;
    } finally {
      await fh.close();
    }
  }
  return fs.readFile(resolved, 'utf8');
}

// Probe the first 1KB for NUL bytes to skip binary files in grep walks.
/** @param {string} filePath */
async function isProbablyText(filePath) {
  try {
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(1024);
      const { bytesRead } = await fh.read(buf, 0, 1024, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return false;
      }
      return true;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {boolean} recursive
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir, recursive) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) yield* walk(full, true);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

// Conservative ReDoS guard. Rejects the classic catastrophic-backtracking shape:
// a quantifier (* + {n,}) applied to a group whose body itself contains an
// unbounded quantifier — e.g. (a+)+, (a*)*, (.+)* . JS RegExp has no execution
// timeout, and grep runs the pattern against attacker-influenceable file content
// on the main thread, so one such pattern blocks the whole event loop. Errs toward
// rejection; the agent simply rephrases. (Single-level nesting only — does not
// detect deeply nested groups or overlapping alternation like (a|a)*.)
const UNBOUNDED_QUANT = /[*+]|\{\d+,\}/;
/** @param {string} pattern */
function looksCatastrophic(pattern) {
  // A quantifier binds to the atom immediately before it — no whitespace between
  // `)` and the quantifier in a real regex.
  const groupQuant = /\(([^()]*)\)(?:[*+]|\{\d+,\})/g;
  let m;
  while ((m = groupQuant.exec(pattern)) !== null) {
    // Drop escaped literals (\+ \* \{ …) so a group like (\+)+ — one-or-more
    // literal plus signs, which is linear — isn't mistaken for a nested quantifier.
    const body = m[1].replace(/\\./g, '');
    if (UNBOUNDED_QUANT.test(body)) return true;
  }
  return false;
}

/**
 * @typedef {object} GrepArgs
 * @property {string} pattern
 * @property {string} path
 * @property {boolean} [recursive]
 * @property {number} [maxMatches]
 * @property {string} [flags]
 */

/** @param {GrepArgs} args */
async function grepPath({ pattern, path: rawPath, recursive = true, maxMatches, flags = 'i' }) {
  const resolved = path.resolve(expandHome(rawPath));
  const cap = maxMatches || DEFAULT_GREP_MAX_MATCHES;
  if (looksCatastrophic(pattern)) {
    throw new Error(
      `shell_grep: pattern rejected — nested unbounded quantifier (e.g. "(a+)+") risks catastrophic ` +
      `backtracking that would block the process. Simplify the regex.`,
    );
  }
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (/** @type {any} */ err) {
    throw new Error(`shell_grep: invalid regex — ${err.message}`);
  }

  /** @type {{file: string, line: number, text: string}[]} */
  const hits = [];
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`shell_grep: path not found — ${rawPath}`);

  const files = [];
  if (stat.isFile()) {
    files.push(resolved);
  } else if (stat.isDirectory()) {
    for await (const f of walk(resolved, recursive)) files.push(f);
  }

  for (const file of files) {
    if (hits.length >= cap) break;
    if (!(await isProbablyText(file))) continue;
    let content;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= cap) break;
      if (re.test(lines[i])) {
        hits.push({ file, line: i + 1, text: lines[i].slice(0, 500) });
      }
    }
  }

  const truncated = hits.length >= cap;
  return { hits, truncated, fileCount: files.length };
}

/**
 * @typedef {object} RunArgvArgs
 * @property {string[]} argv
 * @property {string} [cwd]
 * @property {number} [timeout]
 * @property {number} [maxBuffer]
 * @property {Record<string, string>} [env]
 */

/** @param {RunArgvArgs} args */
function runArgv({ argv, cwd, timeout, maxBuffer, env }) {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') {
    return Promise.reject(new Error('shell_run: argv must be a non-empty array of strings, starting with the command'));
  }
  const [file, ...args] = argv;
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: cwd ? expandHome(cwd) : undefined,
        timeout: timeout || DEFAULT_EXEC_TIMEOUT_MS,
        maxBuffer: maxBuffer || DEFAULT_EXEC_MAX_BUFFER,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        shell: false,
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            resolve({ stdout: stdout || '', stderr: stderr || '', code: null, timedOut: true });
            return;
          }
          if (err.code === 'ENOENT') {
            resolve({ stdout: '', stderr: `shell_run: command not found: ${file}`, code: null, timedOut: false });
            return;
          }
          resolve({
            stdout: stdout || '',
            stderr: stderr || '',
            code: typeof err.code === 'number' ? err.code : null,
            timedOut: false,
          });
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '', code: 0, timedOut: false });
      }
    );
  });
}

/**
 * @typedef {object} ExecCommandArgs
 * @property {string} command
 * @property {string} [cwd]
 * @property {number} [timeout]
 * @property {number} [maxBuffer]
 * @property {Record<string, string>} [env]
 */

/** @param {ExecCommandArgs} args */
function execCommand({ command, cwd, timeout, maxBuffer, env }) {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: cwd ? expandHome(cwd) : undefined,
        timeout: timeout || DEFAULT_EXEC_TIMEOUT_MS,
        maxBuffer: maxBuffer || DEFAULT_EXEC_MAX_BUFFER,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            resolve({ stdout: stdout || '', stderr: stderr || '', code: null, timedOut: true });
            return;
          }
          resolve({
            stdout: stdout || '',
            stderr: stderr || '',
            code: typeof err.code === 'number' ? err.code : null,
            timedOut: false,
          });
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '', code: 0, timedOut: false });
      }
    );
  });
}

/**
 * Create the three shell tools. No options — configuration is per-call via tool args,
 * gating is the caller's responsibility via `new Loop({ policy })`.
 *
 * @returns {{tools: ToolDef[]}}
 */
function createShellTools() {
  /** @type {ToolDef[]} */
  const tools = [
    {
      name: 'shell_read',
      description: 'Read a file or list a directory. Returns file contents (truncated at 256KB) or a tab-separated directory listing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path. ~ expands to home.' },
          maxBytes: { type: 'integer', description: 'Optional cap for file reads (default 262144).' },
        },
        required: ['path'],
      },
      execute: async (/** @type {{path: string, maxBytes?: number}} */ { path: p, maxBytes }) => readEntry(p, maxBytes),
    },
    {
      name: 'shell_grep',
      description: 'Search for a JavaScript regex pattern across files. Skips binary files. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript regex (without surrounding slashes).' },
          path: { type: 'string', description: 'File or directory to search. ~ expands to home.' },
          recursive: { type: 'boolean', description: 'Recurse into subdirectories (default true).' },
          maxMatches: { type: 'integer', description: 'Stop after this many hits (default 200).' },
          flags: { type: 'string', description: 'Regex flags, e.g. "i" or "gim" (default "i").' },
        },
        required: ['pattern', 'path'],
      },
      execute: async (/** @type {GrepArgs} */ args) => grepPath(args),
    },
    {
      name: 'shell_run',
      description: 'Run a command with an argv array (no shell, no interpolation) and return {stdout, stderr, code, timedOut}. Use this when a policy allowlist needs to match on argv[0] — no shell metacharacter injection is possible. Default timeout 30s, max output 1MB.',
      parameters: {
        type: 'object',
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string' },
            description: 'Non-empty array of strings: argv[0] is the command, argv[1..] are its arguments. Spawned via child_process.execFile (shell: false).',
          },
          cwd: { type: 'string', description: 'Working directory. ~ expands to home.' },
          timeout: { type: 'integer', description: 'Kill after this many ms (default 30000).' },
          maxBuffer: { type: 'integer', description: 'Max stdout/stderr bytes (default 1048576).' },
          env: { type: 'object', description: 'Additional env vars merged over process.env.' },
        },
        required: ['argv'],
      },
      execute: async (/** @type {RunArgvArgs} */ args) => runArgv(args),
    },
    {
      name: 'shell_exec',
      description: 'Run a raw shell command string via /bin/sh -c (or cmd.exe) and return {stdout, stderr, code, timedOut}. SECURITY: shell metacharacters (;, &&, |, `, $(), etc.) are interpreted — a naive base-command allowlist like `command.split(/\\s+/)[0]` is bypassable via "ls;rm -rf". Prefer shell_run for policy-gated use cases. Default timeout 30s, max output 1MB.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Raw shell command string. Goes through the system shell.' },
          cwd: { type: 'string', description: 'Working directory. ~ expands to home.' },
          timeout: { type: 'integer', description: 'Kill after this many ms (default 30000).' },
          maxBuffer: { type: 'integer', description: 'Max stdout/stderr bytes (default 1048576).' },
          env: { type: 'object', description: 'Additional env vars merged over process.env.' },
        },
        required: ['command'],
      },
      execute: async (/** @type {ExecCommandArgs} */ args) => execCommand(args),
    },
  ];
  return { tools };
}

module.exports = { createShellTools };
