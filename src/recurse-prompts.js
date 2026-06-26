'use strict';

// NB-5 + NB-4 prompt assets for src/recurse.js (RLM_PRD §4.3). Pure text, ZERO runtime — kept in their own
// file so the decomposition policy (which the RLM paper Fig 4 shows directly lifts accuracy and the
// first-split-correct rate) is inspectable and editable without touching the glue. Two assets:
//   - DECOMPOSITION_POLICY (NB-5): the worker's system-prompt blurb + 1-2 worked splits.
//   - capabilityScrub (NB-4 / RC-12): the depth-conservative suffix deeper workers receive.

/**
 * NB-5 — the decomposition-policy system blurb + few-shot. Prepended to a Family-A worker's system prompt so
 * the model has an in-context example of HOW to split before it is offered the `spawn_child` A-tool. Flat-first
 * (§4.2/§8): the model fans out flat over a window-sized batch and only escalates to a nested `spawn_child`
 * when a single sub-task is genuinely too large to handle directly. Worked splits are deliberately small —
 * the lift is from showing the SHAPE of a good split, not from volume.
 * @type {string}
 */
const DECOMPOSITION_POLICY = [
  'You solve a task by DECOMPOSING it, not by swallowing everything at once.',
  '',
  'How to decompose:',
  '- Break the task into independent sub-tasks, each small enough to handle in one focused pass.',
  '- Prefer a FLAT split (several sibling sub-tasks) over a deep one. Only nest — split a sub-task again —',
  '  when that single sub-task is itself too large to handle directly.',
  '- When you have a sub-task that is large or independent, delegate it with the `spawn_child` tool: it runs',
  '  in a FRESH context window and returns only its result. Do the small/glue parts yourself.',
  '- After the sub-results come back, COMBINE them into one final answer for the original task.',
  '- If you can answer directly without splitting, just do so — decomposition is for tasks too big for one pass.',
  '',
  'Worked example 1 (flat split):',
  '  Task: "Summarize the security posture of services A, B, and C."',
  '  Good split: spawn_child("Summarize the security posture of service A"), same for B, same for C,',
  '  then combine the three summaries into one posture report.',
  '',
  'Worked example 2 (nest only on overflow):',
  '  Task: "Count matching records across a 10,000-line log."',
  '  The log is too large for one pass, so split it into chunks and spawn_child a count for each chunk;',
  '  if a chunk is STILL too large, that child splits again. Sum the per-chunk counts in your final answer.',
].join('\n');

/**
 * NB-4 / RC-12 — the depth-aware capability-scrub suffix. Deeper workers get a more conservative prompt:
 * "prefer direct action, only delegate if truly necessary." Combined with `scrubSpawn` (the tool half of the
 * scrub) in recurse.js, this realizes guard #5's prompt+tool-shaping half (the part bareguard's blind
 * `policy` cap cannot express). At depth 0 there is no suffix (the top-level worker decomposes freely);
 * from depth 1 on, each level nudges harder toward answering directly so recursion contracts toward its base
 * case rather than fanning out without bound.
 * @param {number} depth - The worker's depth (0 = top level).
 * @param {number} maxDepth - The topology ceiling; at `depth >= maxDepth` the `spawn_child` tool is withheld.
 * @returns {string} A suffix to append to the worker system prompt ('' at depth 0).
 */
function capabilityScrub(depth, maxDepth) {
  if (depth <= 0) return '';
  if (depth >= maxDepth) {
    return [
      '',
      `DEPTH ${depth} of ${maxDepth} — this is the deepest level. You CANNOT delegate further; there is no`,
      'spawn tool here. Answer this sub-task DIRECTLY and concisely from what you have. If the sub-task is',
      'still too large to answer faithfully, say so explicitly rather than guessing — an honest "incomplete"',
      'is correct; a fabricated answer is not.',
    ].join('\n');
  }
  return [
    '',
    `DEPTH ${depth} of ${maxDepth} — you are already inside a delegated sub-task. PREFER DIRECT ACTION:`,
    'answer this sub-task yourself if you reasonably can. Only delegate further (spawn_child) when a part of',
    'it is genuinely too large to handle in one pass. Keep the recursion shallow.',
  ].join('\n');
}

module.exports = { DECOMPOSITION_POLICY, capabilityScrub };
