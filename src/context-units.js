'use strict';

// RT-1 — the msgs⇄units adapter for the `assemble` context-assembly seam (src/loop.js).
//
// Division of labour (litectx CE-PRD §8.2, line 321 — the frozen contract):
//   - bareagent owns GRAMMAR: msgs→units, units→msgs, atomic bundling of a tool-call + its result(s),
//     `pinned` flags, the pairing seatbelt, and fail-open. Broken tool-pairing and a dropped system
//     prompt are UNREPRESENTABLE here, by construction — not by trusting the consumer.
//   - litectx owns CONTENT + RELEVANCE: a single verb `assemble(units, ctx) → { units, dropped, tokens }`
//     (the AssembleResult envelope — `dropped[]` is load-bearing, ships in the same slice, never silent)
//     that does SELECT (keep / drop / reorder / recall-inject) + COMPRESS (rewrite a unit's `content`) +
//     fit-to-`ctx.budget`, best-effort. It never learns the message grammar. `unitAssembler` unwraps `.units`.
//
// The neutral unit (the SOCKET litectx codes against — exactly these 7 enumerable fields):
//   { id, role, content, kind, pinned, atomic, tokensApprox }
//     id           — stable within one assemble() call; litectx references units by it.
//     role         — 'system' | 'user' | 'assistant' | 'tool' (the message grammar role).
//     content      — flat string view litectx reads to score and MAY rewrite to COMPRESS.
//     kind         — litectx's memory-node kind ('code'|'doc'|'fact'|'episode') on units litectx
//                    INJECTS from recall. Transcript-derived units carry `null` — and that is the
//                    CORRECT value, not a placeholder. `role` and `kind` are orthogonal: `role`
//                    (user/assistant/tool/system) carries conversational position = bareagent's
//                    grammar, present on every unit; `kind` carries litectx's graph-node type, present
//                    only on units litectx owns. Typing a live turn would force litectx to learn the
//                    provider's conversation structure — the exact coupling the keystone boundary
//                    forbids (PRD §1.2 / litectx CE-PRD §8.2). RATIFIED by litectx (2026-06-12): do
//                    NOT define transcript-kinds. injected = kinded, transcript = null.
//     pinned       — true ⇒ bareagent guarantees the unit is never dropped and never reordered
//                    (system prompt, first user/task turn). litectx still sees its tokensApprox so the
//                    pin counts against the budget: pin-don't-hide.
//     atomic       — group-id (string) | null. litectx keeps/drops units sharing one group-id WHOLE,
//                    never split. bareagent pre-bundles an assistant tool-call + ALL its result(s) into
//                    one unit, so each bundle is its OWN group (group-id = the unit's id); everything
//                    else is null. NOTE: string|null, not boolean — a boolean collapses every bundle
//                    under one key and litectx would fit them all-or-nothing (test/context-units.test.js (real-litectx sweep)).
//     tokensApprox — chars/4 estimate over the unit's backing messages, for litectx's budget math.
//
// `_msgs` (the verbatim backing messages) is attached NON-ENUMERABLE: it does not appear in the 7-field
// view, JSON, or iteration. It is bareagent's reconstruction backing — litectx must not read it. A unit
// with no backing (one litectx minted via recall-inject) is synthesised into a single message on the
// way out.

/** chars/4 token estimate over a list of messages (matches poc2 / the Loop's own heuristic). */
function approxTokens(msgs) {
  let c = 0;
  for (const m of msgs) {
    if (m.content != null) c += String(m.content).length;
    if (m.tool_calls) c += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(c / 4);
}

/** Flat string view of a unit's backing messages — what litectx scores on and may rewrite. */
function renderContent(msgs) {
  const parts = [];
  for (const m of msgs) {
    if (m.content != null && String(m.content).length) parts.push(String(m.content));
  }
  return parts.join('\n');
}

let _seq = 0;
/** Attach the verbatim backing + original-content fingerprint as non-enumerable carry. */
function withBacking(unit, msgs) {
  Object.defineProperty(unit, '_msgs', { value: msgs, enumerable: false, writable: true });
  Object.defineProperty(unit, '_origContent', { value: unit.content, enumerable: false, writable: true });
  return unit;
}

/**
 * msgs → neutral units. Bundles each assistant-tool-call message with the contiguous tool result(s)
 * that answer its ids into ONE atomic unit (so pairing can never be split). system + first user turn
 * are pinned.
 * @param {Array<Record<string, any>>} msgs
 * @returns {Array<Record<string, any>>}
 */
function toUnits(msgs) {
  const units = [];
  let seenUser = false;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];

    if (m.role === 'system') {
      units.push(withBacking({ id: `u${_seq++}`, role: 'system', content: renderContent([m]), kind: null, pinned: true, atomic: null, tokensApprox: approxTokens([m]) }, [m]));
      continue;
    }
    if (m.role === 'user') {
      const pinned = !seenUser; // first user turn = the task; pin it
      seenUser = true;
      units.push(withBacking({ id: `u${_seq++}`, role: 'user', content: renderContent([m]), kind: null, pinned, atomic: null, tokensApprox: approxTokens([m]) }, [m]));
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // bundle this assistant message with the contiguous tool results answering its ids
      const ids = new Set(m.tool_calls.map((t) => t.id));
      const group = [m];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === 'tool' && ids.has(msgs[j].tool_call_id)) {
        group.push(msgs[j]);
        j++;
      }
      // `atomic` is litectx's group-id (string|null), NOT a boolean: units sharing one are kept/dropped
      // whole. bareagent already pre-bundles a tool-call + its result(s) into ONE unit, so each bundle is
      // its OWN group — group-id = the unit's id. (A boolean would collapse every bundle under one key,
      // making litectx fit them all-or-nothing — see test/context-units.test.js (real-litectx sweep).)
      const gid = `u${_seq++}`;
      units.push(withBacking({ id: gid, role: 'assistant', content: renderContent(group.slice(1)), kind: null, pinned: false, atomic: gid, tokensApprox: approxTokens(group) }, group));
      i = j - 1;
      continue;
    }
    // plain assistant text, or a stray tool message (handled by the seatbelt on the way out)
    units.push(withBacking({ id: `u${_seq++}`, role: m.role, content: renderContent([m]), kind: null, pinned: false, atomic: null, tokensApprox: approxTokens([m]) }, [m]));
  }
  return units;
}

/**
 * Drop any tool-result whose tool_call_id has no open assistant tool-call before it, and any assistant
 * tool-call message left with zero surviving results. The final grammar guard: even if litectx hands
 * back something that would orphan a pair, the wire is always valid. Returns a fresh array.
 */
function pairingSeatbelt(msgs) {
  // pass 1: which tool_call ids actually have a result present?
  const resultIds = new Set();
  for (const m of msgs) if (m.role === 'tool' && m.tool_call_id != null) resultIds.add(m.tool_call_id);

  const out = [];
  const open = new Set();
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const surviving = m.tool_calls.filter((tc) => resultIds.has(tc.id));
      if (!surviving.length) continue; // assistant tool-call with no results at all → drop the message
      for (const tc of surviving) open.add(tc.id);
      out.push(surviving.length === m.tool_calls.length ? m : { ...m, tool_calls: surviving });
      continue;
    }
    if (m.role === 'tool') {
      if (!open.has(m.tool_call_id)) continue; // orphan result → drop
      open.delete(m.tool_call_id);
      out.push(m);
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * units → msgs. Honors drop (absent units), reorder (order of the returned array), recall-inject
 * (units with no backing → one synthesised message), and COMPRESS (a unit whose `content` was rewritten
 * is reconstructed from the new content). Atomic units keep their assistant tool-call message verbatim
 * so pairing holds; a content rewrite lands on the tool RESULT. A multi-result atomic bundle whose
 * content was rewritten is kept VERBATIM — a flat string can't be faithfully split back into N
 * results, and splitting is grammar (bareagent's), not litectx's to attempt. This isn't a special
 * case: litectx's compress() is a pure text→text render that returns verbatim when handed no single
 * parseable format (compress.js — "never returns less than the body losslessly"), so a flattened
 * multi-result unit round-trips unchanged on both sides. RATIFIED by litectx (2026-06-12). The pairing
 * seatbelt is the final guard.
 * @param {Array<Record<string, any>>} units
 * @returns {Array<Record<string, any>>}
 */
function fromUnits(units) {
  const msgs = [];
  for (const u of units) {
    if (!u || typeof u !== 'object') continue;
    const backing = u._msgs;

    if (!Array.isArray(backing)) {
      // litectx-minted (recall-inject): synthesise one message from role + content
      msgs.push({ role: u.role || 'user', content: u.content == null ? '' : String(u.content) });
      continue;
    }

    const edited = u.content !== u._origContent;
    if (!edited) {
      for (const m of backing) msgs.push(m); // verbatim — preserves tool_call_id pairing exactly
      continue;
    }

    if (!u.atomic) {
      // single backing message, content rewritten
      msgs.push({ ...backing[0], content: u.content == null ? '' : String(u.content) });
      continue;
    }

    // atomic + content rewritten: assistant message stays verbatim (pairing); rewrite lands on the
    // single result. Multi-result bundle → keep verbatim (unsplittable).
    const results = backing.slice(1);
    if (results.length === 1) {
      msgs.push(backing[0]);
      msgs.push({ ...results[0], content: u.content == null ? '' : String(u.content) });
    } else {
      for (const m of backing) msgs.push(m);
    }
  }
  return pairingSeatbelt(msgs);
}

/**
 * Wrap litectx's `assemble(units, ctx)` verb into the Loop's msgs-level `assemble(msgs, ctx)` seam.
 * litectx ships the **`AssembleResult` envelope** `{ units, dropped, tokens }` (CE-PRD §8.2: `dropped[]`
 * is load-bearing — it ships in the same slice, never silently truncated). This wrapper accepts that
 * envelope (uses `.units`) OR a bare `units` array (a simpler consumer). `dropped`/`tokens` are litectx's
 * accounting; the Loop's seam is msgs-in/msgs-out, so they're not threaded onward here (the canonical
 * transcript already holds every dropped unit by id — restorable on demand).
 * Fail-OPEN at this layer too: any other return shape → the original msgs are sent unchanged. A thrown
 * error (incl. HaltError) is left to the Loop's own fail-open / HaltError handling — not swallowed here.
 * @param {(units: Array<Record<string, any>>, ctx: any) => (any | Promise<any>)} assembleUnits
 * @returns {(msgs: Array<Record<string, any>>, ctx: any) => Promise<Array<Record<string, any>>>}
 */
function unitAssembler(assembleUnits) {
  if (typeof assembleUnits !== 'function') {
    throw new Error('[context-units] unitAssembler(fn): fn must be (units, ctx) => units');
  }
  return async (msgs, ctx) => {
    const units = toUnits(msgs);
    const out = await assembleUnits(units, ctx);
    // litectx returns { units, dropped, tokens }; a bare array is also accepted. Anything else → fail-open.
    const view = Array.isArray(out) ? out : (out && Array.isArray(out.units) ? out.units : null);
    if (!view) return msgs; // fail-open: unrecognised return → full context
    return fromUnits(view);
  };
}

module.exports = { toUnits, fromUnits, unitAssembler, approxTokens, pairingSeatbelt };
