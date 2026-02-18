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
  constructor(options = {}) {
    if (!options.provider) throw new Error('Planner requires a provider');
    this.provider = options.provider;
    this.prompt = options.prompt || PLAN_PROMPT;
  }

  async plan(goal, context = {}) {
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

    return this._parse(result.text);
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
      if (!match) throw new Error(`Planner: could not parse plan from LLM output: ${text.slice(0, 200)}`);
      steps = JSON.parse(match[0]);
    }

    if (!Array.isArray(steps)) throw new Error('Planner: expected JSON array');

    // Validate and normalize
    const ids = new Set(steps.map(s => s.id));
    return steps.map(s => {
      if (!s.id || !s.action) throw new Error(`Planner: step missing id or action: ${JSON.stringify(s)}`);
      const deps = (s.dependsOn || []).filter(d => ids.has(d));
      return { id: s.id, action: s.action, dependsOn: deps, status: 'pending' };
    });
  }
}

module.exports = { Planner };
