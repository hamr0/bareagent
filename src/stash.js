'use strict';

// Stash — the eval-assist F2 reference skill (PRD §2.8–2.14). Compaction-first context hygiene: fold a
// FINISHED sub-task out of the live transcript to stay under a budget within one run, restorable verbatim.
//
// Shape: `createStashSkill(options)` returns `{ skill, trim }`. Register `skill` into a SkillRegistry
// (progressive disclosure, src/skills.js) and wire `trim` into `new Loop({ trim })`. The three tools
// (stash_checkpoint / stash_compact / stash_restore) are auto-prefixed by the registry.
//
// THE LOAD-BEARING DESIGN (validated by poc/f2-stash-fold.mjs against a real Loop + real litectx 0.16.0):
//   • Tool execute() receives ARGS ONLY — no `msgs`, no `ctx` (loop.js:676) — and the Loop runs on a COPY
//     of the caller's messages (loop.js:305). So a tool CANNOT touch the live transcript directly. The
//     tools QUEUE INTENT; the work happens in `trim(msgs, ctx)` (loop.js:487) — the one seam that receives
//     the live canonical transcript + ctx and may mutate it in place.
//   • Deferring the fold to trim is not just convenient, it is CORRECT: a synchronous fold inside execute()
//     would capture the triggering stash_compact's own assistant-tool_calls message but NOT yet its
//     tool-result (the Loop appends that after execute returns) — orphaning its own pair. trim runs at a
//     clean ROUND BOUNDARY, so every fold spans whole rounds.
//   • Anchor = an identity REFERENCE to the existing boundary message at checkpoint time — NOT an injected
//     marker (a `system` marker is hoisted out of position + clobbers the system prompt on Anthropic,
//     provider-anthropic.js:59).
//   • TWO transcript invariants must survive a fold or real providers reject the next call: (1) every
//     assistant tool_call has its tool_result and vice-versa; (2) strict user/assistant alternation after
//     Anthropic normalization (provider-anthropic.js:127 does NO consecutive-role merging). The fold EVICTS
//     whole rounds (preserves both) and, where it leaves an inline note, injects it as a self-contained
//     `assistant(tool_call) + tool(result)` PAIR — pairing-safe and alternation-safe by construction (a
//     bare user/assistant note would break alternation).
//
// Two strategies (D10): 'stash' (lossless — verbatim parked to litectx's stash table or an in-process Map,
// restorable byte-exact) and 'summarize' (lossy — `ctx.summarize` folds the span into an inline gist; the
// detail is NOT retained, the smallest footprint). The note pair carries the gist ('summarize') or a
// "restorable" breadcrumb ('stash') so the model is never left blind about what it just folded. The stance
// side (D13) writes a litectx `episode` via `remember` when a `reason` is given. Governance is unchanged:
// stash tools flow through the same `Loop({ policy })` chokepoint as any tool.

const { ToolError } = require('./errors');

/** @typedef {import('../types').ToolDef} ToolDef */

const DEFAULT_KEY_PREFIX = 'stash:';
const DEFAULT_MAX_LABELS = 128;
const STRATEGIES = new Set(['stash', 'summarize']);

const ARG_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'The sub-task label that brackets the span (set at checkpoint).' },
    strategy: { type: 'string', description: "Compaction strategy: 'summarize' (lossy gist) or 'stash' (lossless, restorable verbatim)." },
    reason: { type: 'string', description: 'Short note on what the sub-task accomplished (recorded as the durable stance).' },
  },
  required: ['label'],
};

const INSTRUCTIONS =
  'Keep the working context lean by folding FINISHED sub-tasks out of it:\n'
  + '• stash_checkpoint({ label }) at the START of a self-contained sub-task — plants a labeled anchor.\n'
  + '• stash_compact({ label, reason, strategy }) once that sub-task is DONE and you will not need its '
  + 'step-by-step detail inline again — folds everything since the checkpoint out of context, leaving a '
  + "short note. strategy 'summarize' (default) keeps a gist and drops the detail; 'stash' keeps the detail "
  + 'restorable verbatim. Pass a short `reason` describing the outcome.\n'
  + "• stash_restore({ label }) to bring a 'stash'-compacted sub-task back verbatim (a 'summarize'd one "
  + 'cannot be restored — its detail was not retained).\n'
  + 'Never compact work that is still in progress.';

/**
 * Build the stash reference skill + the trim function that executes its folds.
 *
 * @param {Object} [options]
 * @param {'summarize'|'stash'} [options.defaultStrategy='summarize'] - Strategy when the model omits one.
 *   'summarize' (OQ5 lean / §2.11) is lossy; 'stash' is lossless. 'summarize' degrades to a lossless park
 *   when no `ctx.summarize` is wired (loud, never a silent detail-loss).
 * @param {string} [options.keyPrefix='stash:'] - Namespace for stash/episode ids.
 * @param {number} [options.maxLabels=128] - LRU backstop on DISTINCT live labels (§2.13) — visible, not silent.
 * @param {Object} [options.compaction] - AUTOMATIC token-pressure trigger (§2.11/D12, all bareagent — a
 *   housekeeping threshold, NEVER a bareguard halt bound). Opt-in: omit, or omit `ceilingTokens`, → OFF
 *   (no guessed model→window table). Fires on the NEXT round's trim when the Loop's measured
 *   `ctx.usage.inputTokens / ceilingTokens > triggerAt`.
 * @param {number} [options.compaction.ceilingTokens] - OPERATOR-SET context ceiling (enables auto-trigger).
 * @param {number} [options.compaction.triggerAt=0.7] - Fraction of the ceiling that fires a fold.
 * @param {'summarize'|'stash'} [options.compaction.strategy] - Strategy for auto-folds (default: defaultStrategy).
 * @param {number} [options.compaction.keepHeadTurns=1] - Recent turns to keep at the START (initial context).
 * @param {number} [options.compaction.keepRecentTurns=3] - Recent turns to keep at the END (live working set).
 * @param {(msg: string) => void} [options.onNote=console.warn] - Sink for the loud one-time/backstop notes.
 * @returns {{ skill: { name: string, description: string, instructions: string, tools: ToolDef[] }, trim: (msgs: any[], ctx: any) => Promise<any[]>, restoreHandles: () => string[] }}
 */
function createStashSkill(options = {}) {
  const {
    defaultStrategy = 'summarize',
    keyPrefix = DEFAULT_KEY_PREFIX,
    maxLabels = DEFAULT_MAX_LABELS,
    compaction = null,
    onNote = (/** @type {string} */ msg) => console.warn(msg),
  } = options;
  const auto = compaction && compaction.ceilingTokens
    ? { ceilingTokens: compaction.ceilingTokens, triggerAt: compaction.triggerAt ?? 0.7, strategy: compaction.strategy || defaultStrategy, keepHeadTurns: compaction.keepHeadTurns ?? 1, keepRecentTurns: compaction.keepRecentTurns ?? 3 }
    : null;
  let autoSeq = 0;

  /** @type {Map<string, any>} label → identity-ref to the boundary message (the anchor). */
  const anchors = new Map();
  /** @type {Map<string, { backend: 'ctx'|'local'|'summary', id: string }>} label → restore handle. */
  const parked = new Map();
  /** @type {Map<string, string>} id → parked JSON, the in-process lossless backend (no litectx). */
  const local = new Map();
  /** @type {Array<{ action: string, label: string, strategy?: string, reason?: string }>} intent queue. */
  const pending = [];
  let warnedNoStash = false;
  let noteSeq = 0;

  const idFor = (/** @type {string} */ label) => `${keyPrefix}${label}`;
  const hasCheckpoint = (/** @type {string} */ label) =>
    anchors.has(label) || pending.some(p => p.action === 'checkpoint' && p.label === label);

  const requireLabel = (/** @type {string} */ label, /** @type {string} */ tool) => {
    if (typeof label !== 'string' || !label) throw new ToolError(`[${tool}] requires a non-empty string "label".`);
  };

  // A provider-safe inline note: a self-contained assistant(tool_call)+tool(result) PAIR. Bare user/
  // assistant notes break Anthropic's strict alternation; this pair satisfies both pairing and alternation
  // by construction when it follows a tool-result (user) boundary — which the checkpoint anchor always is.
  const noteMessages = (/** @type {string} */ text) => {
    // The id goes ON THE WIRE as a tool_use.id — Anthropic enforces ^[a-zA-Z0-9_-]+$ on it (live-POC
    // caught a colon'd id being rejected). Keep it in-charset; do NOT reuse keyPrefix (it has a colon).
    const id = `stash_note_${noteSeq++}`;
    return [
      { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'context_compacted', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: id, content: text },
    ];
  };

  // Tools — they only QUEUE intent (args-only signature); trim does the transcript work next round.
  /** @type {ToolDef} */
  const checkpointTool = {
    name: 'checkpoint',
    description: 'Plant a labeled anchor at the start of a sub-task, so it can later be compacted as a unit.',
    parameters: ARG_SCHEMA,
    execute: async ({ label } = {}) => {
      requireLabel(label, 'stash_checkpoint');
      pending.push({ action: 'checkpoint', label });
      return { label, status: 'checkpoint scheduled' };
    },
  };
  /** @type {ToolDef} */
  const compactTool = {
    name: 'compact',
    description: 'Fold everything since the matching checkpoint out of the live context, leaving a short note.',
    parameters: ARG_SCHEMA,
    execute: async ({ label, strategy, reason } = {}) => {
      requireLabel(label, 'stash_compact');
      if (!hasCheckpoint(label)) {
        throw new ToolError(`[stash_compact] no checkpoint for "${label}" — call stash_checkpoint({ label: "${label}" }) first.`);
      }
      const used = strategy || defaultStrategy;
      if (!STRATEGIES.has(used)) {
        throw new ToolError(`[stash_compact] strategy must be 'summarize' (lossy) or 'stash' (lossless); got "${used}".`);
      }
      pending.push({ action: 'compact', label, strategy: used, reason });
      return { label, strategy: used, status: 'compaction scheduled' };
    },
  };
  /** @type {ToolDef} */
  const restoreTool = {
    name: 'restore',
    description: "Rehydrate a 'stash'-compacted sub-task verbatim into the live context.",
    parameters: ARG_SCHEMA,
    execute: async ({ label } = {}) => {
      requireLabel(label, 'stash_restore');
      if (!parked.has(label) && !pending.some(p => p.action === 'compact' && p.label === label)) {
        throw new ToolError(`[stash_restore] nothing compacted under "${label}" to restore.`);
      }
      pending.push({ action: 'restore', label });
      return { label, status: 'restore scheduled' };
    },
  };

  // Park / rehydrate over litectx when wired, else the in-process Map. Same lossless guarantee.
  const park = (/** @type {any} */ ctx, /** @type {string} */ label, /** @type {string} */ json) => {
    const id = idFor(label);
    if (ctx && typeof ctx.stash === 'function') {
      ctx.stash(id, json);
      parked.set(label, { backend: 'ctx', id });
    } else {
      if (!warnedNoStash) {
        warnedNoStash = true;
        onNote('[stash] no litectx ctx.stash wired — parking verbatim in-process (lossless, but run-scoped, not durable across runs).');
      }
      local.set(id, json);
      parked.set(label, { backend: 'local', id });
    }
  };
  const rehydrate = (/** @type {any} */ ctx, /** @type {string} */ label) => {
    const handle = parked.get(label);
    if (!handle) return null;
    if (handle.backend === 'ctx') {
      const item = ctx && typeof ctx.get === 'function' ? ctx.get(handle.id) : null;
      return item && typeof item.text === 'string' ? item.text : null;
    }
    if (handle.backend === 'local') return local.get(handle.id) ?? null;
    return null; // 'summary' — lossy, no verbatim retained
  };

  // LRU backstop on distinct live labels (§2.13) — visible, never silent.
  const enforceBackstop = (/** @type {any} */ ctx) => {
    while (parked.size > maxLabels) {
      const oldest = parked.keys().next().value;
      const handle = parked.get(oldest);
      if (handle) {
        if (handle.backend === 'ctx') { if (ctx && typeof ctx.evict === 'function') { try { ctx.evict(handle.id); } catch { /* best-effort */ } } }
        else if (handle.backend === 'local') local.delete(handle.id);
      }
      parked.delete(oldest);
      onNote(`[stash] label backstop (${maxLabels}) exceeded — evicted oldest stash "${oldest}".`);
    }
  };

  // Fold msgs[from, to) into a parked stash (or a lossy summary) + a provider-safe note pair, IN PLACE.
  // Shared by on-demand compact (to = end) and the auto-trigger (a middle range). Callers must pass a
  // range whose left edge follows a user-normalized message and whose right edge is an assistant turn
  // start, so the spliced note pair keeps both tool-pairing and alternation valid.
  const foldRange = async (/** @type {any[]} */ msgs, /** @type {any} */ ctx, /** @type {string} */ label, /** @type {number} */ from, /** @type {number} */ to, /** @type {string} */ strategy, /** @type {string|undefined} */ reason) => {
    const span = msgs.slice(from, to);
    if (!span.length) return false;
    let note;
    if (strategy === 'summarize') {
      let summary = '';
      if (ctx && typeof ctx.summarize === 'function') {
        try { summary = await ctx.summarize(span); }
        catch (err) { if (err && err.name === 'HaltError') throw err; onNote(`[stash] summarize failed for "${label}": ${err && err.message}`); }
      }
      if (summary) {
        parked.set(label, { backend: 'summary', id: idFor(label) }); // lossy: nothing verbatim retained
        note = `Compacted "${label}" (${span.length} turns, summarized; not restorable): ${summary}`;
      } else {
        onNote(`[stash] 'summarize' for "${label}" has no ctx.summarize — parked verbatim (lossless) instead.`);
        park(ctx, label, JSON.stringify(span));
        note = `Compacted "${label}" (${span.length} turns) — restorable verbatim via stash_restore.`;
      }
    } else { // 'stash' — lossless
      park(ctx, label, JSON.stringify(span));
      note = `Compacted "${label}" (${span.length} turns) — restorable verbatim via stash_restore.`;
    }
    msgs.splice(from, to - from, ...noteMessages(note)); // replace the span with the note pair, in place
    if (reason && ctx && typeof ctx.remember === 'function') {
      try { await ctx.remember(`${keyPrefix}episode:${label}`, reason, { kind: 'episode' }); }
      catch (err) { if (err && err.name === 'HaltError') throw err; onNote(`[stash] episode stance write failed for "${label}": ${err && err.message}`); }
    }
    enforceBackstop(ctx);
    return true;
  };

  // Assistant turn starts: indices where an assistant turn begins after a user-normalized message (tool
  // results normalize to user). Folding between two such indices removes WHOLE turns and lands the note
  // pair on a user→assistant boundary — both transcript invariants hold by construction.
  const turnStarts = (/** @type {any[]} */ msgs) => {
    const out = [];
    for (let i = 0; i < msgs.length; i++) {
      const norm = msgs[i].role === 'tool' ? 'user' : msgs[i].role;
      const prev = i === 0 ? null : (msgs[i - 1].role === 'tool' ? 'user' : msgs[i - 1].role);
      if (norm === 'assistant' && prev !== 'assistant') out.push(i);
    }
    return out;
  };

  // Automatic token-pressure compaction (§2.11): fold the MIDDLE — keep the first `keepHeadTurns` turns
  // (initial context) and the last `keepRecentTurns` turns (the live working set) — when measured context
  // pressure crosses the ceiling. Reuses foldRange's validated machinery.
  const autoCompact = async (/** @type {any[]} */ msgs, /** @type {any} */ ctx) => {
    if (!auto || !ctx || !ctx.usage) return false;
    const used = ctx.usage.inputTokens || 0;
    if (!(used / auto.ceilingTokens > auto.triggerAt)) return false;
    const starts = turnStarts(msgs);
    if (starts.length < auto.keepHeadTurns + auto.keepRecentTurns + 1) return false; // too little to fold
    const from = starts[auto.keepHeadTurns];
    const to = starts[starts.length - auto.keepRecentTurns];
    if (to == null || to <= from) return false;
    const label = `auto:${autoSeq++}`;
    const folded = await foldRange(msgs, ctx, label, from, to, auto.strategy, undefined);
    if (folded) onNote(`[stash] auto-compaction fired at ${used}/${auto.ceilingTokens} tokens (>${auto.triggerAt}) — folded ${to - from} turns as "${label}".`);
    return folded;
  };

  /**
   * The trim seam (loop.js:487): drains queued intents against the LIVE canonical transcript each round,
   * at a clean round boundary. Mutates `msgs` in place and returns it. Fail-open per the trim contract:
   * a HaltError (e.g. a litectx write-gate deny) propagates; anything else is contained so a hygiene bug
   * never halts the agent.
   * @param {any[]} msgs
   * @param {any} ctx
   * @returns {Promise<any[]>}
   */
  const trim = async (msgs, ctx) => {
    while (pending.length) {
      const op = pending.shift();
      if (!op) break;
      if (op.action === 'checkpoint') {
        anchors.set(op.label, msgs.length ? msgs[msgs.length - 1] : null);
      } else if (op.action === 'compact') {
        const anchorMsg = anchors.get(op.label);
        const at = anchorMsg == null ? -1 : msgs.indexOf(anchorMsg);
        if (anchorMsg !== null && at < 0) { anchors.delete(op.label); continue; } // anchor already folded
        const from = anchorMsg === null ? 0 : at + 1;
        anchors.delete(op.label);
        await foldRange(msgs, ctx, op.label, from, msgs.length, op.strategy || defaultStrategy, op.reason); // on-demand: anchor→now
      } else if (op.action === 'restore') {
        const handle = parked.get(op.label);
        if (handle && handle.backend === 'summary') {
          msgs.push(...noteMessages(`Cannot restore "${op.label}" verbatim — it was compacted with the lossy 'summarize' strategy.`));
          continue;
        }
        const json = rehydrate(ctx, op.label);
        if (json == null) { onNote(`[stash] restore "${op.label}": nothing parked (or backend lost it).`); continue; }
        let span;
        try { span = JSON.parse(json); } catch { onNote(`[stash] restore "${op.label}": parked payload was not valid JSON.`); continue; }
        if (Array.isArray(span)) msgs.push(...span); // verbatim re-append (whole rounds → still valid)
      }
    }
    // After on-demand intents, fire the automatic token-pressure fold if the ceiling is crossed (§2.11).
    if (auto) await autoCompact(msgs, ctx);
    return msgs;
  };

  const skill = {
    name: 'stash',
    description: 'Compact finished sub-tasks to keep the live context window lean.',
    instructions: INSTRUCTIONS,
    tools: [checkpointTool, compactTool, restoreTool],
  };

  return { skill, trim, restoreHandles: () => [...parked.keys()] };
}

module.exports = { createStashSkill };
