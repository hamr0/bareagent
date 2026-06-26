'use strict';

/** @typedef {import('../types').Provider} Provider */

/**
 * @typedef {object} Step
 * @property {string} id - Unique step identifier.
 * @property {string} action - Description of the step to execute.
 * @property {string[]} dependsOn - Ids of steps that must complete first.
 * @property {string} status - Lifecycle status (e.g. 'pending').
 */

/**
 * @typedef {object} PlannerOptions
 * @property {Provider} provider - LLM provider (must implement generate()).
 * @property {string} [prompt] - Custom planning prompt override.
 * @property {number} [cacheTTL] - Cache time-to-live in ms. 0 disables caching.
 */

const PLAN_PROMPT = `You are a planning agent. Break the user's goal into concrete steps.

Rules:
- Each step must be a single, actionable task an agent can execute with tools.
- Use dependsOn to express ordering. Steps with no dependencies can run in parallel.
- Keep it minimal: 2-7 steps. Don't over-decompose simple goals.
- Output ONLY a JSON array, no markdown, no explanation.

Output format:
[
  { "id": "s1", "action": "description of step", "dependsOn": [] },
  { "id": "s2", "action": "description of step", "dependsOn": ["s1"] }
]`;

class Planner {
  /**
   * @param {PlannerOptions} options
   * @throws {Error} `[Planner] requires a provider` — when options.provider is missing.
   */
  constructor(options = /** @type {PlannerOptions} */ ({})) {
    if (!options.provider) throw new Error('[Planner] requires a provider');
    this.provider = options.provider;
    this.prompt = options.prompt || PLAN_PROMPT;
    this._cacheTTL = options.cacheTTL || 0;
    this._cache = new Map();
  }

  /**
   * Generate a step DAG from a goal.
   * @param {string} goal - The user's goal to decompose.
   * @param {{info?: string, count?: number}} [context={}] - Optional context. `info` is prior
   *   context to factor in. `count` (RLM NB-2 seam): when a positive integer, forces the plan to
   *   exactly that many INDEPENDENT, parallelizable steps (all `dependsOn: []`) instead of the
   *   model's free 2–7 — lets `recurse()` impose the deterministic tier→count for forced fan-out.
   * @returns {Promise<Step[]>}
   * @throws {Error} `[Planner] could not parse plan` — when LLM output is not parseable JSON.
   * @throws {Error} `[Planner] expected JSON array` — when parsed result is not an array.
   * @throws {Error} `[Planner] step missing id or action` — when a step lacks required fields.
   */
  async plan(goal, context = {}) {
    // NB-2: a forced fan-out count (positive integer only — a 0/NaN/negative falls back to free planning).
    const count = Number.isInteger(context.count) && /** @type {number} */ (context.count) > 0
      ? /** @type {number} */ (context.count) : null;
    if (this._cacheTTL > 0) {
      const cacheKey = JSON.stringify({ goal, info: context.info || '', count });
      const cached = this._cache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.result;
      }
    }

    const system = count
      ? `${this.prompt}\n\nOVERRIDE: ignore the "2-7 steps" guidance. Decompose into EXACTLY ${count} independent, parallelizable steps, each with "dependsOn": []. Split the goal into ${count} disjoint slices of comparable size that together cover it with no overlap.`
      : this.prompt;
    const messages = [
      { role: 'system', content: system },
    ];
    if (context.info) {
      messages.push({ role: 'user', content: `Context: ${context.info}` });
      messages.push({ role: 'assistant', content: 'Understood. I will factor this context into the plan.' });
    }
    messages.push({ role: 'user', content: goal });

    const result = await this.provider.generate(messages, [], {
      temperature: 0,
    });

    const steps = this._parse(result.text);

    if (this._cacheTTL > 0) {
      const cacheKey = JSON.stringify({ goal, info: context.info || '', count });
      this._cache.set(cacheKey, { result: steps, expiresAt: Date.now() + this._cacheTTL });
    }

    return steps;
  }

  clearCache() {
    this._cache.clear();
  }

  /**
   * @param {string} text - Raw LLM output to parse into steps.
   * @returns {Step[]}
   */
  _parse(text) {
    // Extract JSON array from response (handle markdown code blocks)
    const cleaned = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    let steps;
    try {
      steps = JSON.parse(cleaned);
    } catch (e) {
      // Try to find array in the text
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (!match) throw new Error(`[Planner] could not parse plan from LLM output: ${text.slice(0, 200)}`);
      steps = JSON.parse(match[0]);
    }

    if (!Array.isArray(steps)) throw new Error('[Planner] expected JSON array');

    // Validate and normalize
    const ids = new Set(steps.map(s => s.id));
    return steps.map(s => {
      if (!s.id || !s.action) throw new Error(`[Planner] step missing id or action: ${JSON.stringify(s)}`);
      const deps = (s.dependsOn || []).filter(/** @param {string} d */ d => ids.has(d));
      return { id: s.id, action: s.action, dependsOn: deps, status: 'pending' };
    });
  }
}

module.exports = { Planner };
