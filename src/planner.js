'use strict';

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
   * @param {object} options
   * @param {object} options.provider - LLM provider (must implement generate()).
   * @param {string} [options.prompt] - Custom planning prompt override.
   * @throws {Error} `[Planner] requires a provider` — when options.provider is missing.
   */
  constructor(options = {}) {
    if (!options.provider) throw new Error('[Planner] requires a provider');
    this.provider = options.provider;
    this.prompt = options.prompt || PLAN_PROMPT;
    this._cacheTTL = options.cacheTTL || 0;
    this._cache = new Map();
  }

  /**
   * Generate a step DAG from a goal.
   * @param {string} goal - The user's goal to decompose.
   * @param {object} [context={}] - Optional context with info field.
   * @returns {Promise<Array<{id: string, action: string, dependsOn: string[], status: string}>>}
   * @throws {Error} `[Planner] could not parse plan` — when LLM output is not parseable JSON.
   * @throws {Error} `[Planner] expected JSON array` — when parsed result is not an array.
   * @throws {Error} `[Planner] step missing id or action` — when a step lacks required fields.
   */
  async plan(goal, context = {}) {
    if (this._cacheTTL > 0) {
      const cacheKey = JSON.stringify({ goal, info: context.info || '' });
      const cached = this._cache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.result;
      }
    }

    const messages = [
      { role: 'system', content: this.prompt },
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
      const cacheKey = JSON.stringify({ goal, info: context.info || '' });
      this._cache.set(cacheKey, { result: steps, expiresAt: Date.now() + this._cacheTTL });
    }

    return steps;
  }

  clearCache() {
    this._cache.clear();
  }

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
      const deps = (s.dependsOn || []).filter(d => ids.has(d));
      return { id: s.id, action: s.action, dependsOn: deps, status: 'pending' };
    });
  }
}

module.exports = { Planner };
