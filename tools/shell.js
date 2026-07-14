'use strict';

/**
 * Pure-Node shell tools — cross-platform (linux, macOS, Windows), no external binaries.
 *
 * Primitives:
 *   shell_read  — read a file or list a directory
 *   shell_grep  — regex search across files (JS regex, no grep/rg/findstr)
 *   shell_write — write/overwrite (or append to) a file, creating parent dirs (no shell)
 *   shell_run   — run a command via an argv array (no shell, allowlist-friendly on argv[0])
 *   shell_exec  — run a raw shell command with timeout + max buffer
 *
 * All run through Loop's policy hook when wired via `new Loop({ policy })`.
 * Library ships zero baked-in allowlist — gating is the agent author's responsibility.
 *
 * GATING WITH bareguard's fs/bash PRIMITIVES: these tools carry tool-named actions by default
 * (`{ type:'shell_write' }`), which match `tools.allowlist`/`tools.denylist` but do NOT activate the
 * `fs`/`bash` primitives — those need `action.type ∈ {read,write,edit,bash}` with `action.path`/`action.cmd`.
 * To gate `shell_write` by `fs.writeScope` (so a write outside the allowed root is denied BEFORE it touches
 * disk), translate it at the gate — see `examples/with-bareguard.mjs` for the `wireGate(gate, { actionTranslator })`
 * mapping (`shell_write` → `{ type:'write', path }`, `shell_read`/`shell_grep` → `{ type:'read', path }`,
 * `shell_run`/`shell_exec` → `{ type:'bash', cmd }`). A write tool alone is NOT auto-gated — validated by
 * poc/ba2-write-tool-gate.mjs (without the translator the out-of-scope write leaks).
 *
 * CAVEAT (applies to read AND write scopes): bareguard's `fs` primitive matches paths LEXICALLY (no
 * `realpath`/symlink resolution), so a symlink that lives INSIDE the allowed scope but points OUTSIDE it is
 * not caught — a `shell_write` through such a link can escape the scope. If untrusted input can create
 * symlinks under your scope, canonicalize (`fs.realpath`) before the gate, or keep the scope on a root with
 * no attacker-writable symlinks. This is bareguard's documented lexical-match contract, not specific to this tool.
 */

/** @typedef {import('../types').ToolDef} ToolDef */

const fs = require('node:fs/promises');
const path = require('node:path');
const { exec, execFile } = require('node:child_process');
const { Worker } = require('node:worker_threads');

const DEFAULT_READ_MAX_BYTES = 256 * 1024;       // 256 KB
const DEFAULT_WRITE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — a sanity ceiling on a single write (LLM-authored)
const DEFAULT_GREP_MAX_MATCHES = 200;
const DEFAULT_GREP_TIMEOUT_MS = 5_000;           // hard ceiling on a single grep — bounds ReDoS
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

/**
 * Write text to a file (the BA-2 first-class write primitive — a coding agent must edit files, and routing
 * writes through the shell is impractical: redirection is a shell metachar that an argv/bash allowlist denies).
 * Creates parent directories. Caps size as a sanity ceiling. NO shell — so it gates cleanly through bareguard's
 * fs primitive when the adopter translates `shell_write` → `{ type:'write', path }` (see createShellTools doc).
 *
 * `content` is REQUIRED and must be a string (BA-4). It used to default to `''`, which made the ordinary
 * failure mode of a long generation — the model hits its output-token cap and the tool call arrives with
 * `content` absent — silently truncate the target to zero bytes and report `"wrote 0 bytes"` as SUCCESS.
 * No policy can catch that: a 0-byte write is a legal write, and bareguard's fs primitive judges
 * `{type:'write', path}` without ever inspecting the body. It is a missing precondition in the primitive,
 * not a governance gap. An explicit `content: ''` still empties the file — the caller meant it.
 * @param {{path: string, content?: string, append?: boolean, maxBytes?: number}} args
 * @returns {Promise<string>}
 */
async function writeFile({ path: rawPath, content, append = false, maxBytes }) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('shell_write requires a non-empty "path" string');
  }
  if (typeof content !== 'string') {
    throw new Error(
      'shell_write requires a "content" string (pass content:"" to deliberately empty the file). '
      + `Got ${content === undefined ? 'no content argument' : `content of type ${content === null ? 'null' : typeof content}`}`
      + ' — refusing to write, the file is unchanged. If your output was cut short, retry with the full content.',
    );
  }
  const text = content;
  const cap = maxBytes || DEFAULT_WRITE_MAX_BYTES;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > cap) {
    throw new Error(`shell_write content is ${bytes} bytes, over the ${cap}-byte cap (pass maxBytes to raise it)`);
  }
  const resolved = path.resolve(expandHome(rawPath));
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  if (append) await fs.appendFile(resolved, text, 'utf8');
  else await fs.writeFile(resolved, text, 'utf8');
  return `${append ? 'appended' : 'wrote'} ${bytes} bytes to ${resolved}`;
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
 * @property {number} [timeout] - Hard wall-clock ceiling in ms (default 5000). The match runs in a
 *   worker thread; on overrun the worker is terminated and the call rejects, so a pattern that slips
 *   past `looksCatastrophic` can no longer hang the host event loop.
 */

/**
 * The actual search: walk, skip binaries, regex-test each line. Runs in a worker thread (see
 * grep-worker.js) so a runaway regex is killable via `worker.terminate()`. JS RegExp has no
 * execution timeout and backtracking is uninterruptible on its own thread — isolation is the
 * only sound bound (the static `looksCatastrophic` guard is a best-effort fast-reject, not a
 * guarantee; a grounded bypass like `(a|a|a)*` passes it yet backtracks exponentially).
 * @param {GrepArgs} args
 */
async function _grepCore({ pattern, path: rawPath, recursive = true, maxMatches, flags = 'i' }) {
  const resolved = path.resolve(expandHome(rawPath));
  const cap = maxMatches || DEFAULT_GREP_MAX_MATCHES;
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
 * Public grep entry. Fast-rejects obviously catastrophic patterns without paying for a worker,
 * then runs the search in a worker thread bounded by a hard timeout — so even a pattern that
 * defeats the static guard degrades to a bounded rejection instead of an event-loop hang.
 * @param {GrepArgs} args
 */
function grepPath(args) {
  const { pattern, flags = 'i', timeout } = args;
  if (looksCatastrophic(pattern)) {
    return Promise.reject(new Error(
      `shell_grep: pattern rejected — nested unbounded quantifier (e.g. "(a+)+") risks catastrophic ` +
      `backtracking that would block the process. Simplify the regex.`,
    ));
  }
  // Cheap up-front validation so a syntactically invalid regex fails clearly without a worker spin-up.
  try {
    new RegExp(pattern, flags);
  } catch (/** @type {any} */ err) {
    return Promise.reject(new Error(`shell_grep: invalid regex — ${err.message}`));
  }

  const budgetMs = timeout && timeout > 0 ? timeout : DEFAULT_GREP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'grep-worker.js'), { workerData: args });
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn(val);
    };
    const timer = setTimeout(() => {
      done(reject, new Error(
        `shell_grep: pattern exceeded ${budgetMs}ms time budget — likely catastrophic backtracking. ` +
        `Simplify the regex.`,
      ));
    }, budgetMs);
    timer.unref?.();
    worker.once('message', (msg) => {
      if (msg && msg.ok) done(resolve, msg.result);
      else done(reject, new Error((msg && msg.error) || 'shell_grep: worker failed'));
    });
    worker.once('error', (err) => done(reject, err));
  });
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
      name: 'shell_write',
      description: 'Write text to a file (overwriting it), creating parent directories as needed. No shell — so an ' +
        'fs.writeScope policy can gate it by path (translate to {type:"write"}). Use append:true to add to the end ' +
        'instead of overwriting. Returns a "wrote N bytes to <path>" summary. Max 5MB per write by default.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target file path. ~ expands to home. Parent dirs are created.' },
          content: { type: 'string', description: 'The full text to write (UTF-8). Required — a call without it is REJECTED, not treated as an empty write. Pass "" only to deliberately empty the file.' },
          append: { type: 'boolean', description: 'Append to the file instead of overwriting it (default false).' },
          maxBytes: { type: 'integer', description: 'Reject a write larger than this many bytes (default 5242880).' },
        },
        required: ['path', 'content'],
      },
      execute: async (/** @type {{path: string, content?: string, append?: boolean, maxBytes?: number}} */ args) => writeFile(args),
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

module.exports = { createShellTools, _grepCore, _writeFile: writeFile };
