'use strict';

// SkillRegistry — the eval-assist F2 skill mechanism (PRD §2.3–2.7).
//
// A skill is an operator-registered bundle `{ name, description, instructions, tools }` surfaced to the
// agent by PROGRESSIVE DISCLOSURE: a single meta-tool `skill_use` carries a catalog of one-liners in its
// description; until a skill is used, only its one-liner is in context — never its instructions or tool
// schemas. On `skill_use({ name })`, two effects: (1) the skill's `instructions` are returned AS the tool
// result (on-demand injection, lands naturally in the transcript), and (2) the skill's tools are unlocked
// into the active tool set for subsequent rounds, called NATIVELY by their prefixed names.
//
// The genuine gap vs. MCP (which already does tools-on-demand): instructions injected per-invocation inside
// the same agent's context budget — the context-engineering lever (PRD §2.2).
//
// Governance is unchanged (PRD §2.6, D5): the gate judges `(tool, args)` and ignores origin. Skills affect
// DISCOVERY, never AUTHORIZATION — unlocking a tool authorizes nothing; bareguard decides each call blind to
// how the tool was reached. `skill_use` itself, and every unlocked tool, flow through the SAME
// `Loop({ policy })` chokepoint.
//
// The only Loop coupling is the general tools-as-thunk primitive (D4, src/loop.js): pass `activeTools` as
// the `tools` thunk and the freshly-unlocked set is offered on the next round. Loop never imports this file.
//
// Separator is `_`, not `.` (POC-corrected, PRD §2.6): a dot is rejected by both OpenAI's
// `^[a-zA-Z0-9_-]+$` and Anthropic's tool-name validators. Underscore is what MCP already uses
// (`${server}_${tool}`); skills inherit it. Validated by poc/f2-skill-thunk.mjs on OpenAI + Anthropic.

const { ValidationError, ToolError } = require('./errors');

/** @typedef {import('../types').ToolDef} ToolDef */

/**
 * @typedef {Object} Skill
 * @property {string} name - Unique skill name (also the tool-name prefix).
 * @property {string} description - One-line catalog entry shown in `skill_use`'s description.
 * @property {string} instructions - Returned as the `skill_use` tool result when the skill is activated.
 * @property {ToolDef[]} [tools] - Tools unlocked on use; their names are auto-prefixed `${name}_${tool}`.
 */

const META_NAME = 'skill_use';

class SkillRegistry {
  /**
   * @param {Object} [options]
   * @param {Iterable<string>} [options.reserved] - Tool names already in use (native/MCP), so a prefixed
   *   skill tool that would collide with one is rejected at `register` time. Tool names are globally unique
   *   for DISPATCH (PRD §2.6, D6) — this is the collision check across native + MCP + skills, not security.
   * @param {string} [options.metaToolName='skill_use'] - Override the meta-tool name if `skill_use` is taken.
   */
  constructor(options = {}) {
    /** @type {Map<string, {name: string, description: string, instructions: string, tools: ToolDef[]}>} */
    this._skills = new Map();
    /** @type {Set<string>} skill names the agent has activated this run */
    this._unlocked = new Set();
    /** @type {Set<string>} every tool name owned by the registry (meta + all prefixed skill tools) */
    this._toolNames = new Set();
    /** @type {Set<string>} externally-reserved names (native/MCP) for collision detection */
    this._reserved = new Set(options.reserved || []);
    this.metaToolName = options.metaToolName || META_NAME;
    if (this._reserved.has(this.metaToolName)) {
      throw new ValidationError(`[SkillRegistry] meta-tool name "${this.metaToolName}" collides with a reserved tool name.`);
    }
    this._toolNames.add(this.metaToolName);
    // Bind so callers can pass `skills.activeTools` directly as the Loop `tools` thunk (PRD §2.7) without
    // losing `this`.
    this.activeTools = this.activeTools.bind(this);
  }

  /**
   * Register a skill. Throws on a duplicate skill name, or if a prefixed tool name collides with an
   * existing native/MCP/skill tool (or the meta-tool). Returns `this` for chaining.
   * @param {Skill} skill
   * @returns {SkillRegistry}
   */
  register(skill) {
    if (!skill || typeof skill !== 'object') {
      throw new ValidationError('[SkillRegistry] register(skill) requires a { name, description, instructions, tools } object.');
    }
    const { name, description, instructions, tools = [] } = skill;
    if (typeof name !== 'string' || !name) {
      throw new ValidationError(`[SkillRegistry] skill name must be a non-empty string (got ${JSON.stringify(name)}).`);
    }
    if (this._skills.has(name)) {
      throw new ValidationError(`[SkillRegistry] duplicate skill name "${name}".`);
    }
    if (typeof description !== 'string' || !description) {
      throw new ValidationError(`[SkillRegistry] skill "${name}" needs a non-empty string description (the catalog line).`);
    }
    if (typeof instructions !== 'string' || !instructions) {
      throw new ValidationError(`[SkillRegistry] skill "${name}" needs non-empty string instructions (injected on use).`);
    }
    if (!Array.isArray(tools)) {
      throw new ValidationError(`[SkillRegistry] skill "${name}" tools must be an array (got ${typeof tools}).`);
    }

    // Prefix each tool name for global dispatch uniqueness, validating collisions BEFORE committing any
    // (a half-registered skill would be worse than a clean throw).
    /** @type {ToolDef[]} */
    const prefixed = [];
    const seenThisSkill = new Set();
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name) {
        throw new ValidationError(`[SkillRegistry] skill "${name}" has a tool with no name.`);
      }
      if (typeof tool.execute !== 'function') {
        throw new ValidationError(`[SkillRegistry] skill "${name}" tool "${tool.name}" is missing an execute() function.`);
      }
      const fullName = `${name}_${tool.name}`;
      if (seenThisSkill.has(fullName)) {
        throw new ValidationError(`[SkillRegistry] skill "${name}" defines "${tool.name}" twice.`);
      }
      if (this._toolNames.has(fullName) || this._reserved.has(fullName)) {
        throw new ValidationError(`[SkillRegistry] skill "${name}" tool "${fullName}" collides with an existing native/MCP/skill tool name.`);
      }
      seenThisSkill.add(fullName);
      prefixed.push({ ...tool, name: fullName });
    }

    for (const t of prefixed) this._toolNames.add(t.name);
    this._skills.set(name, { name, description, instructions, tools: prefixed });
    return this;
  }

  /** Build the catalog block (one line per registered skill) for the meta-tool description. */
  _catalog() {
    if (this._skills.size === 0) return '(no skills registered)';
    return [...this._skills.values()].map(s => `  ${s.name}: ${s.description}`).join('\n');
  }

  /**
   * The `skill_use` meta-tool ToolDef, with the current catalog in its description. Always included by
   * `activeTools()`. Activating a skill injects its instructions (the tool result) and unlocks its tools.
   * @returns {ToolDef}
   */
  get metaTool() {
    const registry = this;
    return {
      name: this.metaToolName,
      description:
        'Reveal and activate a registered skill by name. Returns the skill\'s instructions and unlocks its '
        + 'tools (callable by their namespaced names on subsequent turns). Available skills:\n'
        + this._catalog(),
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The name of the skill to activate.' } },
        required: ['name'],
      },
      execute: async ({ name } = {}) => {
        const skill = registry._skills.get(name);
        if (!skill) {
          const known = [...registry._skills.keys()].join(', ') || '(none)';
          throw new ToolError(`[skill_use] unknown skill "${name}". Registered skills: ${known}.`);
        }
        registry._unlocked.add(name);
        return skill.instructions;
      },
    };
  }

  /**
   * The current active tool set: `[metaTool, ...tools of every unlocked skill]`. Pass this method (bound)
   * as the Loop `tools` thunk — it is re-evaluated each round, so tools unlocked this round are offered next.
   * @returns {ToolDef[]}
   */
  activeTools() {
    /** @type {ToolDef[]} */
    const out = [this.metaTool];
    for (const name of this._unlocked) {
      const skill = this._skills.get(name);
      if (skill) out.push(...skill.tools);
    }
    return out;
  }

  /** Names of skills activated so far this run. @returns {string[]} */
  unlocked() {
    return [...this._unlocked];
  }

  /** Reset the unlocked set (e.g. between runs). The registered skills are kept. */
  reset() {
    this._unlocked.clear();
  }
}

module.exports = { SkillRegistry };
