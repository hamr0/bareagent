'use strict';

/**
 * Pure-Node shell tools — cross-platform (linux, macOS, Windows), no external binaries.
 *
 * Primitives:
 *   shell_read  — read a file or list a directory
 *   shell_grep  — regex search across files (JS regex, no grep/rg/findstr)
 *   shell_write — write/overwrite (or append to) a file, creating parent dirs (no shell)
 *   shell_edit  — anchored exact-string replace: change one span without rewriting the whole file
 *   shell_run   — run a command via an argv array (no shell, allowlist-friendly on argv[0])
 *   shell_exec  — run a raw shell command with timeout + max buffer
 *
 * All run through Loop's policy hook when wired via `new Loop({ policy })`.
 * Library ships zero baked-in allowlist — gating is the agent author's responsibility.
 *
 * GATING WITH bareguard's fs/bash PRIMITIVES: these tools carry tool-named actions by default
 * (`{ type:'shell_write' }`), which match `tools.allowlist`/`tools.denylist` but do NOT activate the
 * `fs`/`bash` primitives — those need `action.type ∈ {read,write,edit,bash}` with `action.path`/`action.cmd`.
 * To gate `shell_write`/`shell_edit` by `fs.writeScope` (so a write outside the allowed root is denied BEFORE it
 * touches disk), translate it at the gate — see `examples/with-bareguard.mjs` for the `wireGate(gate, { actionTranslator })`
 * mapping (`shell_write` → `{ type:'write', path: resolveToolPath(path) }`, `shell_edit` → `{ type:'edit', path: resolveToolPath(path) }`,
 * `shell_read`/`shell_grep` → `{ type:'read', path: resolveToolPath(path) }`, `shell_run`/`shell_exec` → `{ type:'bash', cmd }`) —
 * canonicalize with `resolveToolPath` (exported alongside `createShellTools`) before the gate check, so the string
 * the gate judges is the string the tool actually opens (see the CAVEAT below). bareguard gates `edit` by
 * `fs.writeScope` identically to `write` (its FS primitive's `FS_TYPES` includes `edit`), so a consumer that
 * fences `write` gets `edit` fenced by the same scope with ZERO extra config. A write/edit tool alone is NOT
 * auto-gated — validated by poc/ba2-write-tool-gate.mjs (without the translator the out-of-scope write leaks).
 *
 * CAVEAT (applies to read AND write scopes): bareguard's `fs` primitive matches paths LEXICALLY TODAY
 * (no symlink resolution) — a resolved-path (symlink) containment check is planned for an upcoming
 * bareguard release, not yet published; until it ships, a symlinked PARENT directory is NOT contained
 * even when the link itself sits inside an allowed scope. bare-agent canonicalizes the path (`~` +
 * resolve, via `resolveToolPath`) before the gate check and opens that same path — this closes a
 * DIFFERENT gap (the gate judging a `~`/relative path in a different form than the one the tool
 * actually opens), not the lexical-match gap above. `noFollowSymlinks` refuses a symlinked FINAL path
 * component at open time (opt-in, below). None of this covers hardlinks.
 *
 * OPT-IN SYMLINK REFUSAL: `createShellTools({ noFollowSymlinks: true })` closes the specific case above
 * where the symlink itself is the FINAL path component the tool opens (`shell_read`/`shell_write`/`shell_edit`
 * on the path directly, `shell_grep`'s root and per-file reads) — that open now refuses (throws, `ELOOP`)
 * instead of following the link, whether it points inside or outside any configured scope. Three things
 * this does NOT cover, by design: (1) a symlinked PARENT directory (e.g. `/scope/linked-dir/file.txt`
 * where `linked-dir` itself is the link) — that's the lexical-match gap above, unrelated to this flag;
 * (2) on Windows, where `fs.constants.O_NOFOLLOW` doesn't exist, the check falls back to a non-atomic
 * `fs.lstat`-then-open — a symlink planted in the gap between the two calls slips through; and (3) the
 * `cwd` option of `shell_run`/`shell_exec` — it only gets `~` expansion, never `noFollowSymlinks` or
 * `resolveToolPath`'s full canonicalization, so a symlinked `cwd` is followed. Default is `false`
 * (identical behavior to before this option existed).
 *
 * DIRECTORY-LISTING RACE (narrowed, not closed): a directory listing (`shell_read` on a dir,
 * `shell_grep`'s root when it's a dir) opens by FD then still has to list by PATH — Node's
 * `fs/promises` has no `fdopendir` — so a directory swapped in at that path between the open and the
 * listing could report a DIFFERENT directory's NAMES (never contents; every content read goes through
 * the already-open fd, never re-opened by path). With `noFollowSymlinks` on, a `dev`+`ino` recheck
 * runs immediately after the listing and refuses (`ELOOP`) on a mismatch — this narrows the window to
 * essentially nothing but does not close it: a swap-and-swap-back that lands on the original `dev`+
 * `ino` before the recheck runs is undetectable by any check that must re-consult the path.
 */

/** @typedef {import('../types').ToolDef} ToolDef */

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { exec, execFile } = require('node:child_process');
const { Worker } = require('node:worker_threads');

const fsConstants = fs.constants;

const DEFAULT_READ_MAX_BYTES = 256 * 1024;       // 256 KB
const DEFAULT_WRITE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — a sanity ceiling on a single write (LLM-authored)
const DEFAULT_GREP_MAX_MATCHES = 200;
const DEFAULT_GREP_TIMEOUT_MS = 5_000;           // hard ceiling on a single grep — bounds ReDoS
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_MAX_BUFFER = 1024 * 1024;     // 1 MB

/**
 * Type-only description of a bad path arg for an error message — NEVER the value itself (repo rule:
 * an unexpected value must never leak into an error/audit log, only its type/category). `p` here is
 * untrusted, model-authored tool-call input, so this is the boundary that rule protects.
 * @param {unknown} p
 * @returns {string}
 */
function describeBadPath(p) {
  if (p === undefined) return 'undefined';
  if (p === null) return 'null';
  if (p === '') return 'empty string';
  return typeof p;
}

/**
 * Expand a leading `~`/`~/…` to the real home directory via `os.homedir()` — matching how bareguard's
 * own config-side `~` expansion works, so the SAME string means the same absolute path on both sides
 * of a gate check. Throws a clear error rather than ever silently degrading `~/x` to `/x`:
 * the previous `process.env.HOME || process.env.USERPROFILE || ''` fallback did exactly that when
 * `HOME` was unset or empty — a `~`-rooted path would resolve to the FILESYSTEM ROOT, not "no home,"
 * an under-modeled-boundary bug (an ambiguous case rounding toward "works" instead of surfacing).
 * @param {string} p
 * @param {() => string} [homedirFn] - Injectable override, used ONLY by tests to force the
 *   empty/throwing-homedir case deterministically, without monkeypatching `os.homedir` globally
 *   (which would affect every other test in this process). Production call sites never pass this.
 * @returns {string}
 */
function expandHome(p, homedirFn = os.homedir) {
  if (typeof p !== 'string') {
    throw new Error(`expandHome: path must be a string (got ${describeBadPath(p)})`);
  }
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') {
    let home;
    try {
      home = homedirFn();
    } catch (/** @type {any} */ err) {
      throw new Error(`cannot expand ~: no home directory (${err && err.message ? err.message : String(err)})`);
    }
    if (!home) {
      throw new Error('cannot expand ~: no home directory');
    }
    return path.join(home, p.slice(1));
  }
  return p;
}

/**
 * THE canonicalizer every shell file tool uses before opening a path — and the same canonicalization
 * an adopter should apply before `gate.check` so the string it judges is the string that gets opened
 * (see the top-of-file CAVEAT). Expands `~`/`~/…` via `os.homedir()` (throwing rather than silently
 * degrading — see `expandHome`), then resolves against `process.cwd()` — matching how bareguard's own
 * config-side path handling expects `~` and relative paths to be canonicalized before it judges them.
 *
 * Idempotent: `resolveToolPath(resolveToolPath(p)) === resolveToolPath(p)` — an already-absolute,
 * already-`~`-free path passed back in is returned unchanged (`path.resolve` on an absolute path is
 * a no-op; there is no `~` left to expand).
 * REJECTS a non-string or empty `p` outright (thrown, before any expansion/resolution runs) —
 * every file tool routes through this function, so a model-authored call that omits `path` or sends
 * `""` must not silently resolve to `process.cwd()` (an assumed default a gate would judge and a tool
 * would then read/list, for input that named no path at all). The rejection message names only the
 * TYPE/category of the bad value (`describeBadPath`), never the value itself.
 * @param {string} p
 * @returns {string}
 * @when you need the SAME absolute path bareguard's fs primitive will canonicalize at gate-check
 *   time (>=0.19.0) — canonicalize once with this before `gate.check`, then open exactly that string.
 * @fails throws when `p` is not a non-empty string, and when `p` starts with `~` and no home
 *   directory can be determined (`os.homedir()` returns empty or throws) — never turns `~/x` into
 *   `/x`, and never turns a missing/empty path into `process.cwd()`.
 * @example
 *   const resolved = resolveToolPath('~/notes.txt');
 */
function resolveToolPath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error(`resolveToolPath: path must be a non-empty string (got ${describeBadPath(p)})`);
  }
  return path.resolve(expandHome(p));
}

/**
 * Build the standard refusal thrown by every symlink-refusing site (BA-nofollow). Deliberately a
 * plain `Error` (not a subclass) so it crosses the Loop's tool-error boundary like any other tool
 * failure and feeds the BA-12 identical-error spin guard; `code:'ELOOP'` mirrors the kernel errno
 * that `O_NOFOLLOW` itself raises, so callers can switch on ONE field regardless of which of the
 * two code paths (native flag vs the Windows lstat fallback) produced it.
 * @param {string} toolName
 * @param {string} resolvedPath
 * @returns {Error}
 */
function symlinkRefusalError(toolName, resolvedPath) {
  const err = /** @type {any} */ (new Error(
    `${toolName}: refusing to follow symlink at ${resolvedPath} (noFollowSymlinks is on)`,
  ));
  err.code = 'ELOOP';
  return err;
}

/**
 * ONE shared open path for every file-open site in this module (`shell_read`, `shell_write`,
 * `shell_edit`, and `shell_grep`'s root check + per-file reads). With `noFollowSymlinks` off this
 * is a plain `fs.open` — the caller's `flags` decide read/write/create semantics, byte-identical to
 * this module's pre-existing behavior. With it on, refuses to follow a symlink at the FINAL path
 * component (opt-in — never covers a symlinked PARENT directory; see the top-of-file CAVEAT for
 * bareguard's resolved-path containment side of that, upcoming but not yet published).
 *
 * Two implementations when the flag is on, selected by whether the platform exposes `O_NOFOLLOW`
 * (present on linux/macOS, `undefined` on Windows):
 *   - Native: pass `O_NOFOLLOW` straight to the kernel via `fs.open`. Atomic — there is no window
 *     between checking and opening. A symlink at the final component (file, dir, or DANGLING)
 *     makes the open fail with `ELOOP` before anything is created or read, which we translate to
 *     `symlinkRefusalError`. Any other error (ENOENT, EACCES, …) passes through unchanged.
 *   - Fallback (`O_NOFOLLOW` undefined): `fs.lstat` the path first and refuse if it is a symlink,
 *     then `fs.open` normally. This is NOT atomic — a symlink planted between the `lstat` and the
 *     `open` slips through (TOCTOU) — documented as a known Windows limitation, not a bug: Windows
 *     has no `O_NOFOLLOW`-equivalent open flag reachable from Node. `lstat` throwing `ENOENT` means
 *     "nothing there yet," which is fine for a write/create call — the open below still runs and
 *     either creates the file or throws its own ENOENT for a read.
 * @param {string} toolName
 * @param {string} resolvedPath
 * @param {number} flags
 * @param {number} [mode]
 * @param {{noFollowSymlinks?: boolean, constants?: {O_NOFOLLOW?: number}}} [options] - `constants` is
 *   an injectable override, used by tests to force the Windows fallback branch on a non-Windows CI
 *   box without monkeypatching `fs.constants` globally.
 */
async function openFile(toolName, resolvedPath, flags, mode, options = {}) {
  const { noFollowSymlinks = false, constants = fsConstants } = options;
  if (!noFollowSymlinks) {
    return fs.open(resolvedPath, flags, mode);
  }
  const oNoFollow = constants.O_NOFOLLOW;
  if (typeof oNoFollow === 'number') {
    try {
      return await fs.open(resolvedPath, flags | oNoFollow, mode);
    } catch (/** @type {any} */ err) {
      if (err && err.code === 'ELOOP') throw symlinkRefusalError(toolName, resolvedPath);
      throw err;
    }
  }
  // Windows fallback: non-atomic lstat-then-open.
  let lst = null;
  try {
    lst = await fs.lstat(resolvedPath);
  } catch (/** @type {any} */ err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
  if (lst && lst.isSymbolicLink()) throw symlinkRefusalError(toolName, resolvedPath);
  return fs.open(resolvedPath, flags, mode);
}

/**
 * Narrows (does not close) the directory-listing race: after opening a directory by FD we still
 * have to list it by PATH — Node's `fs/promises` exposes no `fdopendir` — so a directory or symlink
 * swapped in at that path between the open and the `readdir` could make us list a DIFFERENT
 * directory's NAMES. This never leaks file CONTENTS (every content read in this module goes through
 * the already-open fd, never re-opened by path), only which names are reported for a listing.
 *
 * Re-`lstat`s the path right after the read and refuses (throws, `ELOOP`) unless its `dev`+`ino`
 * still match the handle that was opened — catching both a swap-to-a-symlink (whose own inode won't
 * match the real directory's) and a swap-to-a-different-real-directory (a different inode).
 *
 * RESIDUAL, documented not closed: a swap-and-swap-back that lands back on the original dev+ino
 * before this check runs is undetectable — any check that must re-consult the path shares this
 * limit. Only called when `noFollowSymlinks` is on; the recheck is inert otherwise.
 * @param {string} toolName
 * @param {string} resolvedPath
 * @param {import('node:fs').Stats} handleStat
 */
async function assertDirStillMatchesHandle(toolName, resolvedPath, handleStat) {
  const current = await fs.lstat(resolvedPath).catch(() => null);
  if (!current || current.dev !== handleStat.dev || current.ino !== handleStat.ino) {
    throw symlinkRefusalError(toolName, resolvedPath);
  }
}

const READ_BOUNDED_CHUNK_SIZE = 64 * 1024;

/**
 * Read from an open file handle in chunks, stopping at EOF or once `limit + 1` bytes have been
 * read — NEVER more, regardless of what `stat.size` claims. This is the fix for a real OOM: a
 * device file like `/dev/zero` has no EOF at all, so an unbounded `fh.readFile()` grows without
 * bound until the process dies (observed: `shell_read({path:'/dev/zero'})` killed the whole agent
 * with a FATAL heap OOM, exit 134). A `stat.size`-lying file (e.g. `/proc/kallsyms`, `size:0` but
 * actually ~20MB) is a lesser version of the same problem — fully read then discarded down to the
 * cap. `readBounded` reads AT MOST `limit + 1` bytes either way: the `+1` exists only so the caller
 * can distinguish "exactly `limit` bytes, then real EOF" (`hitLimit:false`) from "there was more"
 * (`hitLimit:true`) without a second read.
 *
 * Reads at `position: null` (the fd's own advancing cursor, not a caller-tracked offset) — this is
 * what makes it correct uniformly across regular files, procfs/sysfs (offset-readable despite a
 * lying size), and character devices (which generally ignore any offset argument regardless).
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {number} limit
 * @returns {Promise<{buf: Buffer, hitLimit: boolean}>}
 */
async function readBounded(fh, limit) {
  const chunks = [];
  let total = 0;
  while (total <= limit) {
    const wantBytes = Math.min(READ_BOUNDED_CHUNK_SIZE, limit + 1 - total);
    const chunk = Buffer.alloc(wantBytes);
    const { bytesRead } = await fh.read(chunk, 0, wantBytes, null);
    if (bytesRead === 0) break; // real EOF
    chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return { buf: Buffer.concat(chunks, total), hitLimit: total > limit };
}

/**
 * @param {string} rawPath
 * @param {number} [maxBytes]
 * @param {{noFollowSymlinks?: boolean}} [options]
 */
async function readEntry(rawPath, maxBytes, options = {}) {
  const resolved = resolveToolPath(rawPath);
  const cap = maxBytes || DEFAULT_READ_MAX_BYTES;

  const fh = await openFile('shell_read', resolved, fsConstants.O_RDONLY, undefined, options);
  try {
    const stat = await fh.stat();
    if (stat.isDirectory()) {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      // Directory-listing race (item 3): the listing above still goes by PATH, not the fd we just
      // opened (no fdopendir in fs/promises) — recheck right after, narrowing the swap window.
      if (options.noFollowSymlinks) await assertDirStillMatchesHandle('shell_read', resolved, stat);
      const lines = entries.map(e => {
        const kind = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file';
        return `${kind}\t${e.name}`;
      });
      return `dir ${resolved}\n${lines.join('\n')}`;
    }
    if (stat.size > cap) {
      // Known-large regular file: stat.size is trustworthy here, so a fixed cap-byte read from
      // offset 0 is the fast path — no need to read the whole thing just to discard the tail.
      const buf = Buffer.alloc(cap);
      await fh.read(buf, 0, cap, 0);
      return buf.toString('utf8') + `\n\n[truncated: ${stat.size - cap} more bytes not shown]`;
    }
    // stat.size is <= cap here, but NOT trustworthy: procfs/sysfs files (e.g. /proc/self/status,
    // /proc/kallsyms) commonly report a size that has nothing to do with their real content, and a
    // device file like /dev/zero has no EOF at all. readBounded caps the read at cap+1 bytes no
    // matter what — never the unbounded `fh.readFile()` this module used to call here (that OOM'd
    // the whole process on /dev/zero, exit 134).
    const { buf, hitLimit } = await readBounded(fh, cap);
    if (hitLimit) {
      // We only know we read cap+1+ bytes, not the real total (stat.size lied) — never invent a
      // "more bytes not shown" count for a size we don't actually know.
      return buf.subarray(0, cap).toString('utf8') + `\n\n[truncated at ${cap} bytes: file size unknown]`;
    }
    return buf.toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }
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
 * `content` is typed REQUIRED so the generated `.d.ts` states the real contract — a library caller that omits
 * it is a type error, not a runtime surprise. The guard below still runs, because the tool-execute boundary
 * feeds this UNTRUSTED model-authored args (that is the boundary BA-4 was breached at, and where types buy
 * nothing).
 * @param {{path: string, content: string, append?: boolean, maxBytes?: number}} args
 * @param {{noFollowSymlinks?: boolean}} [options]
 * @returns {Promise<string>}
 */
async function writeFile({ path: rawPath, content, append = false, maxBytes }, options = {}) {
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
  const cap = maxBytes || DEFAULT_WRITE_MAX_BYTES;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > cap) {
    throw new Error(`shell_write content is ${bytes} bytes, over the ${cap}-byte cap (pass maxBytes to raise it)`);
  }
  const resolved = resolveToolPath(rawPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  // O_TRUNC/O_APPEND + O_CREAT, mode 0o666 (subject to umask) — the same semantics `fs.writeFile`/
  // `fs.appendFile` use under the hood. With `noFollowSymlinks` on, O_NOFOLLOW refuses at the kernel
  // if the final component is a symlink (dangling or not) — the link's target is NEVER created or
  // touched, because the open call fails before that.
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | (append ? fsConstants.O_APPEND : fsConstants.O_TRUNC);
  const fh = await openFile('shell_write', resolved, flags, 0o666, options);
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close().catch(() => {});
  }
  return `${append ? 'appended' : 'wrote'} ${bytes} bytes to ${resolved}`;
}

/**
 * Anchored exact-string replace (BA-13) — the surgical counterpart to the whole-file `shell_write`.
 * Changing one line of an 800-line file with `shell_write` forces the model to EMIT all 800 lines as
 * tool-call JSON: an output-token tax ∝ file size (output is the expensive token class), paid on every
 * revision, and the maximal broken-tree surface (a truncated rewrite mangles the 799 lines it never meant
 * to touch — the BA-4/BA-6 truncation class). `shell_edit` emits only the anchor and its replacement.
 *
 * TWO error classes, deliberately split:
 *   - ANCHOR failures (`oldText` matches 0 or 2+ times) RETURN a refusal string as a normal tool RESULT —
 *     the loop continues and the model re-anchors, and the refusal names the count so the retry is a DISTINCT
 *     call. (Tradeoff, chosen with eyes open: a result does NOT feed the Loop's `maxIdenticalToolErrors` spin
 *     guard, so a model that repeats the byte-identical wrong anchor is bounded only by maxTurns/budget, not
 *     short-circuited. A widened anchor is a different call and recovers naturally; the exact-repeat spin is
 *     the rare degenerate case. This matches the ask's "refusal, not a throw" contract.)
 *   - fs-layer errors (missing file, a directory), BA-4 param-guard violations, and a SOURCE file larger
 *     than the `maxBytes` cap (read bounded via `readBounded`, never fully loaded to find out) THROW at
 *     the tool boundary, before any edit is computed — no change made.
 *
 * BA-4 param guards (guarded from birth this time — cf. `shell_write` zeroing files on an absent arg):
 * `oldText` a required NON-EMPTY string, `newText` a required string — both THROW when absent/wrong-type (an
 * absent param is the truncated-call signature, never a silent default). Explicit `newText:""` is a legal
 * deletion; an absent `newText` is not.
 *
 * ATOMIC: read → splice in memory → write a sibling temp (same filesystem, so `rename` is atomic) carrying
 * the original's mode → rename over the original. Any throw before the rename leaves the original
 * byte-identical and cleans the temp up, so a reader never sees a partial file, and an edit can't silently
 * drop the executable bit.
 *
 * LITERAL splice, NOT `String.replace`: `.replace(oldText, newText)` interprets `$&`/`$1`/`` $` `` patterns in
 * `newText` and would corrupt any edit whose replacement contains a `$`. We index + slice, so every byte of
 * `newText` lands verbatim.
 * @param {{path: string, oldText: string, newText: string, maxBytes?: number}} args
 * @param {{noFollowSymlinks?: boolean}} [options]
 * @returns {Promise<string>}
 */
async function editFile({ path: rawPath, oldText, newText, maxBytes }, options = {}) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('shell_edit requires a non-empty "path" string');
  }
  if (typeof oldText !== 'string' || oldText.length === 0) {
    throw new Error(
      'shell_edit requires a non-empty "oldText" string to anchor the edit — refusing to edit, the file is unchanged. '
      + `Got ${oldText === undefined ? 'no oldText argument' : oldText === '' ? 'an empty string' : `oldText of type ${oldText === null ? 'null' : typeof oldText}`}.`,
    );
  }
  if (typeof newText !== 'string') {
    throw new Error(
      'shell_edit requires a "newText" string (pass newText:"" to delete the anchored text) — refusing to edit, the file is unchanged. '
      + `Got ${newText === undefined ? 'no newText argument' : `newText of type ${newText === null ? 'null' : typeof newText}`}`
      + '. If your output was cut short, retry with the full newText.',
    );
  }

  const resolved = resolveToolPath(rawPath);
  // Hoisted above the read (previously computed only after) — readBounded needs a limit up front.
  const cap = maxBytes || DEFAULT_WRITE_MAX_BYTES;

  // The read (and, when noFollowSymlinks is on, the symlink refusal) happens BEFORE any temp file
  // or rename — a refusal must leave both the target and a would-be link's target untouched.
  // fs-layer errors (ENOENT for a missing file, EISDIR for a directory) throw — same surface as shell_read.
  let content;
  let stat;
  const fh = await openFile('shell_edit', resolved, fsConstants.O_RDONLY, undefined, options);
  try {
    stat = await fh.stat();
    // Bounded read, same reasoning as readEntry: stat.size is untrustworthy (procfs/sysfs) and a
    // device file like /dev/zero has no EOF at all — an unbounded fh.readFile() here OOM'd the
    // whole process (exit 134). `stat` is still kept, for the mode preserved on the rewritten temp
    // file below. Capped at the SAME cap the patched-result size is checked against below — a file
    // already at or over the cap can never produce an in-cap edit anyway.
    const { buf, hitLimit } = await readBounded(fh, cap);
    if (hitLimit) {
      throw new Error(`shell_edit: file is larger than the ${cap}-byte cap (pass maxBytes to raise it) — no change made`);
    }
    content = buf.toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }

  // Literal, non-overlapping occurrence count (split on a string does no regex interpretation).
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    return `shell_edit: oldText not found in ${resolved} — no change made. Quote the exact text to replace `
      + `(check whitespace and indentation), or read the file to re-anchor.`;
  }
  if (occurrences > 1) {
    return `shell_edit: oldText occurs ${occurrences}× in ${resolved} — the anchor must match exactly once. `
      + `Widen it with surrounding lines so it is unique. No change made.`;
  }

  const idx = content.indexOf(oldText);
  const patched = content.slice(0, idx) + newText + content.slice(idx + oldText.length);

  // `cap` was hoisted above the read (readBounded needed it); reused here unchanged.
  const bytes = Buffer.byteLength(patched, 'utf8');
  if (bytes > cap) {
    throw new Error(`shell_edit result is ${bytes} bytes, over the ${cap}-byte cap (pass maxBytes to raise it)`);
  }

  // Atomic replace: a sibling temp (same dir → same filesystem → rename is atomic) with the original's
  // mode. `stat` is already the handle's stat from the read above — no second `fs.stat` call needed.
  const tmp = `${resolved}.shell_edit-${crypto.randomBytes(9).toString('hex')}.tmp`;
  try {
    // flag 'wx' (O_CREAT|O_EXCL) — never follow or clobber a pre-planted file/symlink at the temp path; a
    // colliding name fails the write instead. Create owner-only (0o600) so the patched body — which may hold
    // a secret from a sensitive source file — is never briefly world-readable in the window before chmod sets
    // the original's real mode. (This temp pattern is new to shell_edit, so it carries its own hardening.)
    await fs.writeFile(tmp, patched, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.chmod(tmp, stat.mode & 0o777);
    await fs.rename(tmp, resolved);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  const removed = oldText.split('\n').length - 1;
  const added = newText.split('\n').length - 1;
  return `edited ${resolved}: 1 replacement (-${removed}/+${added} lines)`;
}

// Probe the first 1KB for NUL bytes to skip binary files in grep walks. Per-file grep opens go
// through the shared `openFile` helper like every other open site; unlike read/write/edit, a
// symlink refusal here is caught and swallowed (SILENT skip), not surfaced — per the design, only
// the grep ROOT refusal (in `grepPath`) is a loud tool error. A file that turns into a link between
// `readdir` and open is skipped like any other read error (ENOENT, EACCES, …) already is.
/**
 * @param {string} filePath
 * @param {boolean} [noFollowSymlinks]
 */
async function isProbablyText(filePath, noFollowSymlinks = false) {
  try {
    const fh = await openFile('shell_grep', filePath, fsConstants.O_RDONLY, undefined, { noFollowSymlinks });
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
 * @property {boolean} [noFollowSymlinks] - When true, refuses a symlinked ROOT path (thrown, loud)
 *   and skips (silently, like any other read error) a file that is or becomes a symlink during the
 *   walk. Threaded into `workerData` so the worker thread's file reads honor it too.
 */

/**
 * The actual search: walk, skip binaries, regex-test each line. Runs in a worker thread (see
 * grep-worker.js) so a runaway regex is killable via `worker.terminate()`. JS RegExp has no
 * execution timeout and backtracking is uninterruptible on its own thread — isolation is the
 * only sound bound (the static `looksCatastrophic` guard is a best-effort fast-reject, not a
 * guarantee; a grounded bypass like `(a|a|a)*` passes it yet backtracks exponentially).
 * @param {GrepArgs} args
 */
async function _grepCore({ pattern, path: rawPath, recursive = true, maxMatches, flags = 'i', noFollowSymlinks = false }) {
  const resolved = resolveToolPath(rawPath);
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
    if (!(await isProbablyText(file, noFollowSymlinks))) continue;
    let content;
    try {
      const fh = await openFile('shell_grep', file, fsConstants.O_RDONLY, undefined, { noFollowSymlinks });
      try {
        content = (await fh.readFile()).toString('utf8');
      } finally {
        await fh.close();
      }
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
 *
 * The ROOT symlink refusal (opt-in `noFollowSymlinks`) runs HERE, on the main thread, before the
 * worker is even spawned — the ONLY loud/thrown refusal in the grep path (per-file skips during
 * the walk happen inside the worker and stay silent, matching the existing read-error `continue`).
 * @param {GrepArgs} args
 */
async function grepPath(args) {
  const { pattern, flags = 'i', timeout, path: rawPath, noFollowSymlinks = false } = args;
  if (looksCatastrophic(pattern)) {
    throw new Error(
      `shell_grep: pattern rejected — nested unbounded quantifier (e.g. "(a+)+") risks catastrophic ` +
      `backtracking that would block the process. Simplify the regex.`,
    );
  }
  // Cheap up-front validation so a syntactically invalid regex fails clearly without a worker spin-up.
  try {
    new RegExp(pattern, flags);
  } catch (/** @type {any} */ err) {
    throw new Error(`shell_grep: invalid regex — ${err.message}`);
  }

  if (noFollowSymlinks) {
    // Atomic root check through the SAME shared helper every other open site uses (item 2) — O_RDONLY
    // opens either a file or a directory on Linux/macOS, so one open covers both root shapes. A
    // missing root is left to the worker's own "path not found" error (same message either flag
    // state); any other open failure, including the ELOOP symlink refusal, surfaces here, loud, before
    // the worker is spawned.
    const resolvedRoot = resolveToolPath(rawPath);
    let fh = null;
    try {
      fh = await openFile('shell_grep', resolvedRoot, fsConstants.O_RDONLY, undefined, { noFollowSymlinks: true });
    } catch (/** @type {any} */ err) {
      if (!(err && err.code === 'ENOENT')) throw err;
    }
    if (fh) {
      try {
        const stat = await fh.stat();
        // Directory-listing race (item 3): the worker's own walk() re-reads this root by PATH, so
        // recheck the root's identity here too, narrowing the swap window the same way shell_read does.
        if (stat.isDirectory()) await assertDirStillMatchesHandle('shell_grep', resolvedRoot, stat);
      } finally {
        await fh.close().catch(() => {});
      }
    }
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
 * Create the six shell tools. Configuration is mostly per-call via tool args; gating is the
 * caller's responsibility via `new Loop({ policy })`.
 *
 * @param {{noFollowSymlinks?: boolean}} [options] - `noFollowSymlinks` (default `false`, byte-
 *   identical to the pre-existing behavior when omitted): when `true`, `shell_read`, `shell_write`,
 *   `shell_edit`, and `shell_grep` refuse to open a path whose FINAL path component is a symlink
 *   (file, dir, or dangling) — THROWN, `err.code:'ELOOP'`, never a silently-followed link. Scope is
 *   the final component ONLY — a symlinked PARENT directory is NOT refused (bareguard's own
 *   resolved-path containment check for that is planned for an upcoming release, not yet published;
 *   until then the gate matches paths lexically, so a symlinked parent dir is not contained there
 *   either — see the top-of-file CAVEAT). The `cwd` option of `shell_run`/`shell_exec` is a separate,
 *   NARROWER gap: it only gets `~` expansion, never this flag or `resolveToolPath`'s full
 *   canonicalization, so a symlinked `cwd` is always followed. On Windows (`fs.constants.O_NOFOLLOW`
 *   is undefined there) the guard falls back to a non-atomic `fs.lstat`-then-open check — a symlink
 *   planted in the gap between the two calls slips through; this is a documented platform limitation,
 *   not a bug. Set per `createShellTools()` instance, not module-global — safe to mix a
 *   `noFollowSymlinks:true` toolset for one agent alongside a default toolset for another in the same
 *   process.
 * @returns {{tools: ToolDef[]}}
 * @when you want to give an agent shell/file tools (read, grep, write, edit, run, exec) — cross-platform, pure Node, zero deps
 * @fails never throws at creation; gating is the caller's via Loop({ policy }) and fs.writeScope, shell_edit refuses a non-unique anchor as a tool result (file untouched), and with noFollowSymlinks:true the four file tools throw ELOOP on a symlinked final path component.
 * @example
 *   const { tools } = createShellTools();
 *   const loop = new Loop({ provider, tools, policy });
 * @example
 *   const { tools: safeTools } = createShellTools({ noFollowSymlinks: true });
 */
function createShellTools(options = {}) {
  const { noFollowSymlinks = false } = options;
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
      execute: async (/** @type {{path: string, maxBytes?: number}} */ { path: p, maxBytes }) =>
        readEntry(p, maxBytes, { noFollowSymlinks }),
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
      execute: async (/** @type {GrepArgs} */ args) => grepPath({ ...args, noFollowSymlinks }),
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
      // The args are model-authored and UNTRUSTED — `content` may be absent (an output-token-capped
      // generation), so the boundary type stays loose and `writeFile` enforces the contract at runtime (BA-4).
      execute: async (/** @type {{path: string, content?: string, append?: boolean, maxBytes?: number}} */ args) =>
        writeFile(/** @type {any} */ (args), { noFollowSymlinks }),
    },
    {
      name: 'shell_edit',
      description: 'Replace an exact, unique text span in a file — the surgical alternative to shell_write, which ' +
        'rewrites the ENTIRE file. Give oldText (the exact text to replace — it must occur EXACTLY ONCE, so quote ' +
        'enough surrounding lines to be unique) and newText (its replacement; pass "" to delete). Matched literally ' +
        '(no regex; whitespace and indentation are significant). Returns a compact "edited <path>: 1 replacement" ' +
        'receipt, never the file body. If oldText matches 0 or 2+ times the file is left unchanged and the reason is ' +
        'returned so you can re-anchor. The file must already exist. No shell — gate by path with an fs.writeScope ' +
        'policy (translate to {type:"edit"}).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to edit. ~ expands to home. The file must already exist.' },
          oldText: { type: 'string', description: 'Exact text to find — must occur exactly once. Quote surrounding lines to disambiguate. Matched literally (no regex); whitespace and indentation are significant.' },
          newText: { type: 'string', description: 'Replacement text, inserted verbatim (a literal splice — $ is not special). Pass "" to delete the anchored text. Required — a call without it is REJECTED, not treated as a deletion.' },
          maxBytes: { type: 'integer', description: 'Reject if the resulting file would exceed this many bytes (default 5242880).' },
        },
        required: ['path', 'oldText', 'newText'],
      },
      // The args are model-authored and UNTRUSTED — oldText/newText may be absent (an output-token-capped
      // generation), so the boundary type stays loose and editFile enforces the BA-4 contract at runtime.
      execute: async (/** @type {{path: string, oldText?: string, newText?: string, maxBytes?: number}} */ args) =>
        editFile(/** @type {any} */ (args), { noFollowSymlinks }),
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

module.exports = {
  createShellTools,
  resolveToolPath,
  _grepCore,
  _writeFile: writeFile,
  _editFile: editFile,
  _openFile: openFile,
  _assertDirStillMatchesHandle: assertDirStillMatchesHandle,
  _expandHome: expandHome,
};
