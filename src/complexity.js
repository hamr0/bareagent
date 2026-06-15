'use strict';

/**
 * Keyword complexity assessor — a fast, pure-code "pre-planner" that classifies a goal as
 * simple / medium / complex / critical from its text alone, with NO LLM call. Ported (concept,
 * not line-for-line) from Aurora's SOAR keyword assessor. It exists to drive a routing decision:
 * a `simple` goal can run single-shot; `medium`+ warrants a Planner pass; `critical` (security,
 * production, compliance, financial) flags work that deserves extra scrutiny (e.g. a checkpoint /
 * adversarial verification) before acting.
 *
 *   const { level, needsPlanning } = assessComplexity(goal);
 *   const steps = needsPlanning ? await planner.plan(goal) : [{ id: 's1', action: goal }];
 *
 * Concept, deliberately lightweight: a critical-keyword override, tiered action-verb scoring
 * (simple verbs subtract, complex verbs add the most), feature nouns + scope + structure signals,
 * and two calibrated thresholds. It is a heuristic — transparent and debuggable via `signals`, not
 * a model. On the upstream validation corpus it lands ~89% (the fuller LLM-free original ~95%);
 * the gap is long-tail ambiguity ("add a button" is genuinely context-dependent).
 */

const has = (/** @type {Set<string>} */ words, /** @type {Set<string>} */ set) =>
  [...set].filter(w => words.has(w));
const wordSet = (/** @type {string} */ s) => new Set(s.match(/\b\w+\b/g) || []);
const hasAny = (/** @type {string} */ s, /** @type {string[]} */ list) =>
  list.some(k => new RegExp(`\\b${k}\\b`).test(s));

// --- critical safety override: high-stakes work jumps straight to the top tier ---
const CRIT_INCIDENT = ['emergency', 'outage', 'breach', 'vulnerability', 'exploit', 'corruption', 'data loss', 'incident', 'penetration'];
const CRIT_COMPLIANCE = ['gdpr', 'hipaa', 'pci', 'compliance', 'regulation'];
const SEC_CONTEXT = ['security', 'production', 'authentication', 'authorization'];
const CRIT_ACTIONS = ['fix', 'patch', 'investigate', 'secure', 'protect', 'mitigate', 'prevent', 'respond', 'handle'];
const FINANCIAL = ['payment', 'transaction', 'billing', 'financial'];
const SECURE_ACTS = ['encrypt', 'secure', 'protect', 'audit'];

/** @param {string} s lowercased prompt */
function isCritical(s) {
  if (hasAny(s, CRIT_INCIDENT) || hasAny(s, CRIT_COMPLIANCE)) return true;
  if (hasAny(s, SEC_CONTEXT) && hasAny(s, CRIT_ACTIONS)) return true;     // e.g. "fix security ..."
  if (hasAny(s, FINANCIAL) && hasAny(s, SECURE_ACTS)) return true;        // e.g. "encrypt payment ..."
  return false;
}

// --- tiered keyword scoring: verb "weight" reflects how much work the ask implies ---
const COMPLEX_VERBS = new Set(['implement', 'design', 'architect', 'refactor', 'integrate', 'migrate', 'build', 'create', 'develop', 'construct', 'engineer', 'establish', 'transform', 'overhaul', 'rewrite', 'restructure', 'optimize']);
const ANALYSIS_VERBS = new Set(['explain', 'compare', 'analyze', 'debug', 'understand', 'investigate', 'describe', 'evaluate', 'review', 'examine', 'diagnose', 'trace', 'why', 'difference']);
const MEDIUM_VERBS = new Set(['add', 'update', 'fix', 'write', 'change', 'modify', 'remove', 'delete', 'improve', 'enhance', 'extend', 'convert', 'rename', 'move', 'test', 'configure', 'setup', 'set', 'enable', 'disable']);
const SIMPLE_VERBS = new Set(['what', 'show', 'list', 'get', 'find', 'print', 'check', 'read', 'open', 'run', 'where', 'which', 'display', 'view', 'see', 'tell', 'give', 'name', 'count', 'who', 'when', 'is']);
const SCOPE = new Set(['all', 'every', 'entire', 'across', 'comprehensive', 'complete', 'codebase', 'project', 'system', 'application', 'full', 'whole', 'everything', 'throughout']);
const DOMAINS = new Set(['security', 'performance', 'scalability', 'reliability', 'testing', 'authentication', 'authorization', 'caching', 'logging', 'monitoring', 'database', 'api', 'frontend', 'backend', 'infrastructure', 'deployment', 'docker', 'kubernetes', 'microservices', 'distributed']);
// Feature/system nouns: paired with an action verb they signal a real feature, not a one-liner.
const COMPLEX_NOUNS = new Set(['authentication', 'authorization', 'oauth', 'jwt', 'session', 'sessions', 'pipeline', 'workflow', 'notification', 'notifications', 'dashboard', 'crud', 'plugin', 'framework', 'websocket', 'websockets', 'realtime', 'pagination', 'search', 'validation', 'migration', 'schema', 'registration']);
const SEQUENCE = ['first', 'then', 'after that', 'finally', 'next', 'afterwards', 'subsequently', 'step by step', 'and then', 'as well as', 'additionally', 'along with'];
const CONSTRAINTS = ['without breaking', 'without changing', 'maintaining', 'ensuring', 'backward compatible', 'backwards compatible', 'must not', 'should not', 'preserve', 'without affecting'];

const SIMPLE_THRESHOLD = 11;
const MEDIUM_THRESHOLD = 28;

// Bound the text the assessor scans. Several signal patterns contain `.*`, which can backtrack
// quadratically on adversarial input (e.g. "integrate "×N with no "with" — O(n²)). Complexity is
// fully determined by the opening of a goal, so capping the working string makes every scan
// linear-bounded and removes the DoS surface for callers that pass untrusted end-user text.
const MAX_ASSESS_LEN = 4000;

/**
 * @typedef {object} ComplexityResult
 * @property {'simple'|'medium'|'complex'|'critical'} level - Assessed complexity tier.
 * @property {number} score - Raw heuristic score (100 for a critical override).
 * @property {boolean} needsPlanning - false for `simple`, true otherwise — the routing hint.
 * @property {string[]} signals - Which signals fired, for transparency/debugging.
 */

/**
 * Assess the complexity of a goal/prompt from its text alone (no LLM).
 * @param {string} prompt - The goal to classify.
 * @returns {ComplexityResult}
 */
function assessComplexity(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { level: 'simple', score: 0, needsPlanning: false, signals: ['empty'] };
  }
  const text = prompt.trim().slice(0, MAX_ASSESS_LEN);
  const lower = text.toLowerCase();
  if (isCritical(lower)) {
    return { level: 'critical', score: 100, needsPlanning: true, signals: ['critical_override'] };
  }

  const words = wordSet(lower);
  const wc = text.split(/\s+/).length;
  /** @type {string[]} */
  const signals = [];
  let score = 0;
  /** @param {number} n @param {string} [sig] */
  const add = (n, sig) => { score += n; if (sig) signals.push(sig); };

  const complex = has(words, COMPLEX_VERBS);
  const analysis = has(words, ANALYSIS_VERBS);
  const medium = has(words, MEDIUM_VERBS);
  const simple = has(words, SIMPLE_VERBS);
  const scope = has(words, SCOPE);
  const domains = has(words, DOMAINS);

  if (complex.length) add(complex.length * 25, 'complex_verbs');
  if (analysis.length) add(Math.min(analysis.length * 15, 20), 'analysis_verbs');
  if (medium.length) add(medium.length * 12, 'medium_verbs');
  if (simple.length) add(-Math.min(simple.length * 3, 10), 'simple_verbs');
  if (scope.length) add(scope.length * 12, 'scope');
  if (domains.length > 1) add(domains.length * 8, 'multi_domain');
  else if (domains.length) add(5, 'domain');

  // feature noun + an action verb => a real feature (pushes single-verb asks up a tier)
  const nouns = has(words, COMPLEX_NOUNS);
  if (nouns.length && (medium.length || complex.length)) add(nouns.length * 10, 'feature_nouns');
  if (/\b(?:dark\s*mode|feature\s*flags?|real-?time|end-?to-?end|full-?stack)\b/.test(lower)) add(12, 'feature_pattern');
  if (/\bintegrate\b.*\bwith\b/.test(lower)) add(15, 'integration');
  if (/\b(?:improve|optimize)\s+(?:performance|speed|efficiency)\b/.test(lower)
    && !/\b(?:this|the)\s+(?:function|method|query|loop)\b/.test(lower)) add(15, 'open_ended');

  // structure / sequencing — multi-step asks are heavier
  const seq = SEQUENCE.filter(m => lower.includes(m)).length;
  if (seq) add(seq * 8, 'sequence');
  const constraints = CONSTRAINTS.filter(m => lower.includes(m)).length;
  if (constraints) add(constraints * 12, 'constraints');
  const listItems = (text.match(/(?:^|\n)\s*(?:\d+[.)]|[-*])\s/g) || []).length;
  if (listItems) add(listItems * 9, 'list');

  // length: longer prompts trend more complex
  if (wc > 40) add(15, 'long'); else if (wc > 20) add(10); else if (wc > 10) add(5);

  // architectural / open-ended questions read simple lexically but imply design work
  if (/\bbest\s+(?:way|approach|practice|architecture)\b|\barchitecture\s+for\b|\bhow (?:should|can|do) (?:we|i)\b.*\b(?:handle|design|implement|build)\b/.test(lower)) add(15, 'design_question');
  if (/^(?:what is|where is|which|who|is there)\b/.test(lower)) add(-8, 'simple_question');

  // a trivial edit (typo, comment, log line, version bump) stays simple even though its verb is
  // "medium" weight — gated to trivial OBJECTS so real medium work isn't wrongly demoted.
  const trivial = /\b(?:fix|add|remove|delete|rename|update|change)\b.*\b(?:typo|comment|console\.?log|variable|version|line|import)\b/.test(lower)
    || /\bwrite\s+(?:a|the)\s+function\s+(?:that|to|which)\b/.test(lower);
  if (trivial && !complex.length && !scope.length && wc <= 10) {
    score = Math.min(score, SIMPLE_THRESHOLD);
    signals.push('trivial_edit');
  }

  const level = score <= SIMPLE_THRESHOLD ? 'simple' : score <= MEDIUM_THRESHOLD ? 'medium' : 'complex';
  return { level, score, needsPlanning: level !== 'simple', signals };
}

module.exports = { assessComplexity };
