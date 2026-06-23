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
//     tools therefore QUEUE INTENT; the work happens in `trim(msgs, ctx)` (loop.js:487) — the one seam that
//     receives the live canonical transcript + ctx and may mutate it in place.
//   • Deferring the fold to trim is not just convenient, it is CORRECT: a synchronous fold inside execute()
//     would capture the triggering stash_compact's own assistant-tool_calls message but NOT yet its
//     tool-result (the Loop appends that after execute returns) — orphaning its own pair. trim runs at a
//     clean ROUND BOUNDARY, so every fold spans whole rounds.
//   • Anchor = an identity REFERENCE to the existing boundary message at checkpoint time — NOT an injected
//     marker. A `system`-role marker would be hoisted out of position and clobber the system prompt on
//     Anthropic (provider-anthropic.js:59); a bare user/assistant note breaks Anthropic's strict
//     user/assistant alternation (no consecutive-role merging, provider-anthropic.js:127). So the lossless
//     fold EVICTS the whole span and injects NO inline note — both the tool-pairing and the alternation
//     invariants hold by construction. The restore handle lives in this closure (label→id), the breadcrumb
//     rides the compact tool-result; restore re-appends the verbatim span (whole rounds → still valid).
//
// Composition (D14): the lossless path uses litectx's `stash(id,text)`/`get(id)`/`evict(sel)` when a litectx
// ctx is wired; absent it, an in-process Map keeps the run-scoped lossless guarantee (stash compaction's
// lifetime is "within one run", §2.8 — so the Map is a faithful backend, not a lossy degrade). The stance
// side (D13) writes a litectx `episode` via `remember` when a `reason` is given and ctx supports it.
// Governance is unchanged: stash tools flow through the same `Loop({ policy })` chokepoint as any tool.

const { ToolError } = require('./errors');

/** @typedef {import('../types').ToolDef} ToolDef */

const DEFAULT_KEY_PREFIX = 'stash:';
const DEFAULT_MAX_LABELS = 128;

const ARG_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'The sub-task label that brackets the span (set at checkpoint).' },
    strategy: { type: 'string', description: "Compaction strategy. v1: 'stash' (lossless, restorable verbatim)." },
    reason: { type: 'string', description: 'Short note on what the sub-task accomplished (recorded as the durable stance).' },
  },
  required: ['label'],
};

const INSTRUCTIONS =
  'Keep the working context lean by folding FINISHED sub-tasks out of it:\n'
  + '• stash_checkpoint({ label }) at the START of a self-contained sub-task — plants a labeled anchor.\n'
  + '• stash_compact({ label, reason }) once that sub-task is DONE and you will not need its step-by-step '
  + 'detail inline again — folds everything since the checkpoint into a restorable stash (it disappears from '
  + 'context on the next turn). Pass a short `reason` describing the outcome.\n'
  + '• stash_restore({ label }) if you over-compacted and need the detail back verbatim.\n'
  + 'Never compact work that is still in progress. Compaction is hygiene, not a handoff — the detail is '
  + 'preserved and restorable, only removed from the live window.';

/**
 * Build the stash reference skill + the trim function that executes its folds.
 *
 * @param {Object} [options]
 * @param {'stash'} [options.defaultStrategy='stash'] - Default compaction strategy. Only 'stash' (lossless)
 *   is functional in v1; 'summarize' (lossy inline note) is deferred (its provider-safe injection — a
 *   synthetic tool_call/result pair — is designed but not yet shipped) and coerces to 'stash' with a note.
 * @param {string} [options.keyPrefix='stash:'] - Namespace for stash/episode ids.
 * @param {number} [options.maxLabels=128] - LRU backstop on DISTINCT live labels (§2.13) — the conservative,
 *   VISIBLE cap covering the pathological ever-unique-label run. Oldest parked label is evicted past it.
 * @param {(msg: string) => void} [options.onNote=console.warn] - Sink for the loud one-time/backstop notes.
 * @returns {{ skill: { name: string, description: string, instructions: string, tools: ToolDef[] }, trim: (msgs: any[], ctx: any) => Promise<any[]>, restoreHandles: () => string[] }}
 */
function createStashSkill(options = {}) {
  const {
    defaultStrategy = 'stash',
    keyPrefix = DEFAULT_KEY_PREFIX,
    maxLabels = DEFAULT_MAX_LABELS,
    onNote = (/** @type {string} */ msg) => console.warn(msg),
  } = options;

  /** @type {Map<string, any>} label → identity-ref to the boundary message (the anchor). */
  const anchors = new Map();
  /** @type {Map<string, { backend: 'ctx'|'local', id: string }>} label → restore handle. */
  const parked = new Map();
  /** @type {Map<string, string>} id → parked JSON, the in-process lossless backend (no litectx). */
  const local = new Map();
  /** @type {Array<{ action: string, label: string, strategy?: string, reason?: string }>} intent queue. */
  const pending = [];
  let warnedNoStash = false;

  const idFor = (/** @type {string} */ label) => `${keyPrefix}${label}`;
  const hasCheckpoint = (/** @type {string} */ label) =>
    anchors.has(label) || pending.some(p => p.action === 'checkpoint' && p.label === label);

  /** Validate the model-supplied label; throw a model-facing ToolError on a bad one. */
  const requireLabel = (/** @type {string} */ label, /** @type {string} */ tool) => {
    if (typeof label !== 'string' || !label) {
      throw new ToolError(`[${tool}] requires a non-empty string "label".`);
    }
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
    description: 'Fold everything since the matching checkpoint out of the live context (restorable verbatim).',
    parameters: ARG_SCHEMA,
    execute: async ({ label, strategy, reason } = {}) => {
      requireLabel(label, 'stash_compact');
      if (!hasCheckpoint(label)) {
        throw new ToolError(`[stash_compact] no checkpoint for "${label}" — call stash_checkpoint({ label: "${label}" }) first.`);
      }
      let used = strategy || defaultStrategy;
      if (used !== 'stash') {
        onNote(`[stash] strategy "${used}" is not available in v1 — using lossless "stash" for "${label}".`);
        used = 'stash';
      }
      pending.push({ action: 'compact', label, strategy: used, reason });
      return { label, strategy: used, status: 'compaction scheduled' };
    },
  };
  /** @type {ToolDef} */
  const restoreTool = {
    name: 'restore',
    description: 'Rehydrate a previously compacted sub-task verbatim into the live context.',
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
    return local.get(handle.id) ?? null;
  };

  // LRU backstop on distinct live labels (§2.13) — visible, never silent.
  const enforceBackstop = (/** @type {any} */ ctx) => {
    while (parked.size > maxLabels) {
      const oldest = parked.keys().next().value;
      const handle = parked.get(oldest);
      if (handle) {
        if (handle.backend === 'ctx') { if (ctx && typeof ctx.evict === 'function') { try { ctx.evict(handle.id); } catch { /* best-effort */ } } }
        else local.delete(handle.id);
      }
      parked.delete(oldest);
      onNote(`[stash] label backstop (${maxLabels}) exceeded — evicted oldest stash "${oldest}".`);
    }
  };

  /**
   * The trim seam (loop.js:487): drains queued intents against the LIVE canonical transcript each round,
   * at a clean round boundary. Mutates `msgs` in place and returns it. Fail-open per the trim contract:
   * a HaltError from a litectx write-gate propagates; anything else is contained so a hygiene bug never
   * halts the agent.
   * @param {any[]} msgs
   * @param {any} ctx
   * @returns {Promise<any[]>}
   */
  const trim = async (msgs, ctx) => {
    while (pending.length) {
      const op = pending.shift();
      if (!op) break;
      if (op.action === 'checkpoint') {
        // Anchor on the current last message — a round boundary at trim time. Identity-ref so later folds
        // that reindex the transcript never invalidate it. null only if the transcript is somehow empty.
        anchors.set(op.label, msgs.length ? msgs[msgs.length - 1] : null);
      } else if (op.action === 'compact') {
        const anchorMsg = anchors.get(op.label);
        const at = anchorMsg === null ? -1 : (anchorMsg === undefined ? -2 : msgs.indexOf(anchorMsg));
        // anchorMsg === null → checkpoint at an empty transcript → fold from the start (from = 0).
        // at === -1 (not found) → anchor already folded by an earlier compaction → no-op.
        const from = anchorMsg === null ? 0 : at + 1;
        if (anchorMsg !== null && at < 0) { anchors.delete(op.label); continue; }
        const span = msgs.slice(from);
        if (!span.length) { anchors.delete(op.label); continue; }
        park(ctx, op.label, JSON.stringify(span));     // lossless: verbatim → litectx stash table or Map
        msgs.length = from;                            // EVICT the span; no inline note (alternation-safe)
        anchors.delete(op.label);
        // Stance (D13): record what the sub-task became as a durable, upsert-by-key litectx episode.
        if (op.reason && ctx && typeof ctx.remember === 'function') {
          try { await ctx.remember(`${keyPrefix}episode:${op.label}`, op.reason, { kind: 'episode' }); }
          catch (err) { if (err && err.name === 'HaltError') throw err; onNote(`[stash] episode stance write failed for "${op.label}": ${err && err.message}`); }
        }
        enforceBackstop(ctx);
      } else if (op.action === 'restore') {
        const json = rehydrate(ctx, op.label);
        if (json == null) { onNote(`[stash] restore "${op.label}": nothing parked (or backend lost it).`); continue; }
        let span;
        try { span = JSON.parse(json); } catch { onNote(`[stash] restore "${op.label}": parked payload was not valid JSON.`); continue; }
        if (Array.isArray(span)) msgs.push(...span);   // verbatim re-append (whole rounds → still valid)
      }
    }
    return msgs;
  };

  const skill = {
    name: 'stash',
    description: 'Compact finished sub-tasks to keep the live context window lean (restorable verbatim).',
    instructions: INSTRUCTIONS,
    tools: [checkpointTool, compactTool, restoreTool],
  };

  return { skill, trim, restoreHandles: () => [...parked.keys()] };
}

module.exports = { createStashSkill };
