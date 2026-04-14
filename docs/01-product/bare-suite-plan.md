# Bare-suite Plan — Governance, Shell Tools, RAG Split

**Status:** active
**Owner:** hamr
**Last updated:** 2026-04-13
**Supersedes:** parts of `~/my_plans/bare-suite-roadmap.md` §3 and §4

This document captures the validated plan for closing the governance hole in bareagent, adding a minimal cross-platform shell tool set, and resolving how document-indexing / RAG fits into the bare-suite without bloating core. It is the reference for the next ~4 days of bareagent + multis work.

---

## 1. Context — what already exists

### Governance (half-built)

- `src/mcp-bridge.js` has a `policy(serverName, toolName, args)` callback wired inside `wrapTools` (mcp-bridge.js:204). It runs before every MCP tool call, returns `true` to allow or a string to deny.
- `.mcp-bridge.json` is a persistent allow/deny file per tool, auto-written on first discovery, merged on re-discovery so user edits survive, TTL-based refresh (default `24h`). Denied tools are surfaced to the LLM via `systemContext` so the model knows not to retry them.
- **The hole:** this policy hook only fires for MCP-sourced tools. `Loop.run()` at loop.js:138-178 dispatches tool calls with no governance layer. Every native tool (`createBrowsingTools`, `createMobileTools`, any user-defined tool) bypasses everything. There is no audit log anywhere.

### SQLite store (atomic only)

- `SQLiteStore` ships FTS5 + BM25 + WAL + insert/update/delete triggers.
- `store(content, metadata) → id`, `search(query, {limit}) → [{content, score}]`, `get(id)`, `delete(id)`. Content is treated as an opaque blob; there is no chunking, no parsers, no scope column, no recency/frequency boost, no citation structure.

### Multis (first real consumer)

- Multis owns its own governance: `src/governance/validate.js` (command allowlist/denylist/confirmation + path allowlist/denied), `src/governance/audit.js` (JSONL audit), `src/skills/executor.js` (execCommand wrapping governance).
- Multis owns its own shell tool set inside `src/tools/definitions.js` — `exec`, `read_file`, `grep_files`, `find_files` plus ~16 OS-integration and agent-domain tools.
- Multis already consumes bareagent's mcp-bridge, so it has **two parallel governance paths today**: one inside `exec` (multis' command allowlist) and one inside mcp-bridge (per-tool allow/deny). They do not share code.
- Multis' indexer (`src/indexer/`, ~1100 lines) is the RAG stack — parsers for PDF/DOCX/MD/TXT, hierarchical chunker, SQLite store with FTS5 + BM25 + ACT-R activation decay + scope column.

---

## 2. Decisions (with rationale)

### D1 — Promote the policy hook to Loop-level middleware

Every tool call, regardless of origin (MCP, shell, browsing, mobile, user-defined) flows through `Loop.run()`'s dispatch. That is the correct place to gate tool execution and emit audit records.

```javascript
const loop = new Loop({
  provider,
  policy: async (toolName, args) => {
    if (toolName === 'shell_exec' && /rm\s+-rf|sudo/.test(args.command)) return 'denied by policy';
    return true;
  },
  audit: './audit.jsonl',
});
```

- `policy(toolName, args) → true | false | string` — `true` allows, `false` denies with a generic message, a `string` denies with that exact message fed back to the LLM as the tool result. Denies do **not** throw — the LLM sees the refusal and can reason around it.
- `audit` is a file path. Loop appends one JSONL line per tool call: `{ts, tool, args, decision: 'allow'|'deny', reason?, result?, error?}`.
- Backwards compatible: omitting both options preserves current behaviour exactly.

**Why not keep governance inside mcp-bridge:** two parallel governance systems is exactly the bloat the user called out. One hook, one audit stream, one mental model.

### D2 — Bareagent ships three minimal shell tools, not multis' toolkit

| Tool | Implementation | Dependencies |
|---|---|---|
| `shell_read({path})` | `fs.readFile` for files, `fs.readdir` for directories, size-capped result | none |
| `shell_grep({pattern, path, recursive, maxMatches})` | `fs` walk + JavaScript `RegExp` line-by-line, returns `[{file, line, text}]` | none |
| `shell_exec({command, cwd, timeout})` | `child_process.exec` with timeout + max buffer, returns `{stdout, stderr, code}` | none |

**All three work on linux, macOS, Windows** because they use Node primitives, not external binaries. `shell_grep` never shells out to `grep` / `rg` / `findstr` — it implements regex matching in JS (~50 lines). `shell_exec` passes command strings through verbatim; the user's policy closure is responsible for the per-platform allowlist. No platform detection, no command translation.

**What is explicitly NOT ported from multis:**

- `send_file` — depends on `ctx.platform.sendFile` (Beeper/Telegram), agent-domain.
- `search_docs`, `recall_memory`, `remember`, `escalate` — multis indexer/memory manager, agent-domain.
- `notify`, `clipboard`, `screenshot`, `brightness`, `media_control`, `wifi`, `open_url` — OS integration. May become a separate `bare-agent-desktop` package later if multiple consumers appear, but does **not** belong next to `grep`/`ls`/`exec` in core.
- `phone_call`, `sms_send`, `sms_list` — Termux/Android-specific, agent-domain.

**Philosophy:** bareagent ships primitives, users add their own tools. Every "helpful" tool baked into the library is an opinion we have to defend to every user who does not want it. Grep and ls do not need `brightnessctl` to exist next to them.

### D3 — RAG does NOT land in bareagent core

Porting multis' entire indexer (~1100 lines + peer deps on `pdfjs-dist` ~1MB and `mammoth`) nearly doubles bareagent's indexer-adjacent surface area and breaks the "0 required deps" pitch. Only one consumer exists today (multis). "Might be helpful for customer support agents" is a soft signal.

**Split decision:**

| Layer | Where it lives | Why |
|---|---|---|
| **60% case** — scope, simple sentence-boundary chunker, `store.indexText(text, {scope, source, sectionPath})`, citation columns (`file_path`, `page_start/end`, `section_path`), ACT-R activation decay as opt-in ranking (`new SQLiteStore({ path, ranking: 'actr' })`) | **bareagent core** — extends existing `SQLiteStore` | ~150 lines, zero new deps, unlocks text-only RAG (markdown, HTML, scraped pages, chat logs, code, READMEs). Plain BM25 stays the default for backwards compat. |
| **40% case** — PDF parser, DOCX parser, folder walker, `indexFolder(path, {scope})` | **`bare-agent-rag`** — separate package, peer-deps on `pdfjs-dist` and `mammoth`, depends on `bare-agent` for `SQLiteStore` | Opinion-heavy (how to chunk tables, trust mammoth heading detection) lives in an opinionated package. Core stays lean. Easy to unpublish if unused. Mirrors how LangChain / LlamaIndex / Mastra structure retrieval. |

**The 60% case is "text in, text out":** any corpus that is already strings — markdown, HTML, scraped web pages, JSON, chat history, code, READMEs, issue tracker dumps. The 40% case is binary document ingestion.

**Deferred:** `bare-agent-rag` is not built now. Revisit when there is a second consumer beyond multis, or when multis is ready to delete `src/indexer/` in the same week.

### D4 — Multis refactors once bareagent ships, in one PR

Multis is the first real consumer of the new Loop policy API. Starting the multis refactor now against a speculative API means designing in the dark. Correct sequence: bareagent ships → multis refactor → any API roughness lands as bareagent patch release → both stabilize together.

Multis' bloat (two governance systems, ~300 lines of executor/validate/audit) is annoying, not broken. Trading "annoying for a week" against "refactor twice" is an easy call.

---

## 3. Multis end-state — what deletes, what stays

### Delete entirely

| File / section | Replacement |
|---|---|
| `src/governance/validate.js` (96 lines) | One ~25-line policy closure passed to `new Loop({ policy })`. `governance.json` stays as data the closure reads. |
| `src/governance/audit.js` (89 lines) | `new Loop({ audit: './.multis/audit.jsonl' })` writes the same JSONL shape automatically. |
| `src/skills/executor.js` | Tools call Node primitives directly. Gating happens in the Loop policy, not inside the tool. |
| `src/tools/definitions.js` entries for `exec`, `read_file`, `grep_files`, `find_files` | Consumed from `createShellTools()`. |
| Any multis-side MCP allow/deny plumbing parallel to `.mcp-bridge.json` | Consumed from bareagent's mcp-bridge. |

### Keep

| Tool / module | Why |
|---|---|
| `send_file` | Depends on `ctx.platform.sendFile` — Beeper/Telegram-specific. |
| `search_docs`, `recall_memory`, `remember` | Wired to multis' indexer + memory manager. |
| `escalate` | Multis-specific (kick to owner). |
| `notify`, `clipboard`, `screenshot`, `brightness`, `media_control`, `wifi`, `open_url` | OS integration; fine in multis until there is reuse pressure. |
| `phone_call`, `sms_send`, `sms_list` | Termux/Android-specific. |
| `src/indexer/` | RAG decision D3 — stays in multis. |

### The governance closure that replaces `validate.js`

```javascript
const gov = JSON.parse(fs.readFileSync(PATHS.governance(), 'utf8'));

const policy = async (toolName, args) => {
  if (toolName === 'shell_exec') {
    const base = args.command.trim().split(/\s+/)[0];
    if (gov.commands.denylist.includes(base)) return `Denied: ${base}`;
    if (!gov.commands.allowlist.includes(base)) return `Not in allowlist: ${base}`;
  }
  if (toolName === 'shell_read') {
    const abs = args.path.replace(/^~/, process.env.HOME);
    if (gov.paths.denied.some(p => abs.startsWith(p))) return 'Path denied';
    if (!gov.paths.allowed.some(p => abs.startsWith(p))) return 'Path not in allowlist';
  }
  return true;
};

const loop = new Loop({ provider, policy, audit: './.multis/audit.jsonl' });
```

**Net effect:** ~300 lines deleted from multis, two governance systems → one, governance coverage goes **up** (same closure now also covers MCP tools and browsing tools uniformly).

### Open question before day 1

If multis' current `execCommand` does anything the policy signature above cannot express — per-user sender-ID gating, audit correlation IDs, confirmation prompts wired into Beeper chat replies — flag it before Loop policy lands. The cheap extension is `policy(toolName, args, ctx?)` where `ctx` is an opaque blob passed to `loop.run(messages, tools, { ctx })` and forwarded to the policy function. Easier to design in now than bolt on later.

---

## 4. Timeline

| Day | Repo | Deliverable | Release |
|---|---|---|---|
| 1 | bareagent | Loop `policy` + `audit` options, deny-as-tool-result, mcp-bridge refactored to rely on Loop policy, full test coverage, context.md update | `0.6.0` |
| 2 | bareagent | `createShellTools()` factory with `shell_read` / `shell_grep` / `shell_exec`, cross-platform tests (no external binaries), tools/shell.js under `src/tools/` or top-level `tools/shell.js` per convention, context.md recipe | `0.6.1` |
| 3 | multis | Single PR: delete `governance/validate.js` + `governance/audit.js` + `skills/executor.js`, remove shell tool entries from `definitions.js`, wire governance as policy closure, bump `bare-agent` dep to `^0.6.1`, ensure existing tests pass | (multis release) |
| 4 | multis + bareagent | Fix rough edges from day 3 as bareagent patch (`0.6.2`) if needed; multis follow-up release | `0.6.2` if needed |

**Deferred to a later cycle:**
- `SQLiteStore` extensions for the 60% RAG case (scope column, chunker, ACT-R opt-in, citation columns, `indexText`). Standalone 1-day task, safe to pick up after day 4.
- `bare-agent-rag` sibling package. Blocked on a second consumer or a confirmed multis-indexer deletion plan.
- `bareagent.context.md` already updated in this session with the MCP recipe and beeperbox example — no day-0 work needed there.

---

## 5. API contract for Loop policy + audit

This is the exact shape day 1 will land. Documented here so day 3 (multis refactor) can be written against it without reading the implementation.

### Constructor options

```javascript
new Loop({
  provider,                   // required
  policy,                     // optional: async (toolName, args) => true | false | string
  audit,                      // optional: string path to JSONL file
  // ... existing options unchanged
});
```

### Policy semantics

- **Return `true`** → tool executes normally.
- **Return `false`** → tool call is aborted. The message `[Loop] Tool "<name>" denied by policy` is pushed back as the `tool` role result. LLM sees a refusal and continues the loop.
- **Return a string** → same as `false` but the string is used verbatim as the tool result. Use this to give the LLM an actionable reason (`"finance chats are read-only for this agent"`).
- **Throws** → treated as a deny with the error message as the reason. Logged to audit. Loop continues.
- **Omitted (no `policy`)** → every tool is allowed. Current behaviour preserved.

### Audit record shape

One JSON object per line in the file at `audit`:

```json
{
  "ts": "2026-04-13T12:34:56.789Z",
  "tool": "shell_exec",
  "args": {"command": "ls /tmp"},
  "decision": "allow",
  "result": "foo\nbar\n",
  "durationMs": 12
}
```

For a deny:

```json
{
  "ts": "2026-04-13T12:34:57.123Z",
  "tool": "shell_exec",
  "args": {"command": "rm -rf /"},
  "decision": "deny",
  "reason": "Denied: rm not in allowlist"
}
```

For a tool that throws:

```json
{
  "ts": "2026-04-13T12:34:58.000Z",
  "tool": "shell_exec",
  "args": {"command": "nonexistent"},
  "decision": "allow",
  "error": "Command failed: nonexistent"
}
```

- File is created if missing, appended to if present. Append-only; Loop never reads it back.
- Writes are best-effort (async, non-blocking). An audit write failure logs a warning and does not abort the tool call — audit must never break the agent.
- No rotation, no compression, no size cap. Operational concerns are the user's responsibility.

### mcp-bridge refactor

- `wrapTools` stops taking a `policy` parameter.
- The static `.mcp-bridge.json` allow/deny filter stays inside mcp-bridge (it decides which tools to expose to the Loop in the first place — that is discovery, not runtime policy).
- Runtime arg-dependent policy moves entirely to `Loop.policy`. The `createMCPBridge({ policy })` option is removed in the same release; docs updated to show the Loop option.
- `.mcp-bridge.json`: unchanged on disk. `systemContext` generation unchanged.

### What stays out of scope for day 1

- Per-user or multi-tenant ctx forwarding into `policy`. If multis needs it (open question §3), extend in a patch release.
- Structured deny reasons (enum/code). String reason is enough for the LLM.
- Audit rotation / shipping to external sinks. Users who want that write their own transport.

---

## 6. Success criteria

- [ ] `Loop` accepts `policy` and `audit`; existing tests pass unchanged when neither is set.
- [ ] A denied tool returns the reason string to the LLM as the `tool` role message; Loop continues to the next round.
- [ ] Audit file contains the expected JSONL for allow, deny, and error cases.
- [ ] `createMCPBridge` no longer wraps tools with its own policy; a Loop-level policy gates MCP tools identically to native tools.
- [ ] `createShellTools()` returns `{tools: [shell_read, shell_grep, shell_exec], close?}`; all three work under `node --test` on linux without relying on `grep` / `rg` / `find` being installed.
- [ ] `bareagent.context.md` gains a Recipe covering `createShellTools` + `policy` + `audit`.
- [ ] Multis PR on day 3 deletes `validate.js`, `audit.js`, `executor.js`, and the four shell tool entries from `definitions.js` in a single commit, with all existing multis tests still passing.
