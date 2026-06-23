'use strict';

// SkillRegistry — eval-assist F2 skill mechanism (PRD §2.3–2.7).
// Unit coverage of the registry contract + an integration test that wires `activeTools` into a REAL Loop
// via the tools-as-thunk primitive (D4), reproducing poc/f2-skill-thunk.mjs with a mock provider: the
// model calls skill_use → the thunk surfaces the unlocked prefixed tools → it calls them natively.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SkillRegistry } = require('../src/skills');
const { ValidationError, ToolError } = require('../src/errors');
const { Loop } = require('../src/loop');

const mkTool = (name, exec) => ({
  name,
  description: `tool ${name}`,
  parameters: { type: 'object', properties: {} },
  execute: exec || (async () => `${name} ran`),
});

function stashSkill(onCompact) {
  return {
    name: 'stash',
    description: 'Compact finished sub-tasks to keep the context window lean.',
    instructions: 'Checkpoint at the start of a sub-task; compact once it is done.',
    tools: [mkTool('checkpoint'), mkTool('compact', onCompact)],
  };
}

describe('SkillRegistry — registration & catalog', () => {
  it('starts with only the meta-tool active; catalog lists registered skills, not their tools', () => {
    const skills = new SkillRegistry();
    skills.register(stashSkill());
    const active = skills.activeTools();
    assert.deepEqual(active.map(t => t.name), ['skill_use'], 'before use, only skill_use is active');
    assert.match(active[0].description, /stash: Compact finished sub-tasks/, 'catalog one-liner present');
    assert.doesNotMatch(active[0].description, /checkpoint|compact/, 'tool names are NOT disclosed pre-use');
  });

  it('auto-prefixes tool names with the skill name and underscore (not dot)', () => {
    const skills = new SkillRegistry();
    skills.register(stashSkill());
    skills._unlocked.add('stash');
    const names = skills.activeTools().map(t => t.name);
    assert.deepEqual(names, ['skill_use', 'stash_checkpoint', 'stash_compact']);
  });

  it('rejects a duplicate skill name', () => {
    const skills = new SkillRegistry();
    skills.register(stashSkill());
    assert.throws(() => skills.register(stashSkill()), ValidationError);
  });

  it('rejects a prefixed tool-name collision across skills', () => {
    const skills = new SkillRegistry();
    skills.register({ name: 'a', description: 'd', instructions: 'i', tools: [mkTool('b_x')] }); // → a_b_x
    // A second skill whose prefixed tool also yields a_b_x must be rejected.
    assert.throws(
      () => skills.register({ name: 'a_b', description: 'd', instructions: 'i', tools: [mkTool('x')] }),
      ValidationError,
    );
  });

  it('rejects a collision with an externally-reserved (native/MCP) tool name', () => {
    const skills = new SkillRegistry({ reserved: ['stash_compact'] });
    assert.throws(() => skills.register(stashSkill()), ValidationError);
  });

  it('rejects a skill tool missing execute()', () => {
    const skills = new SkillRegistry();
    assert.throws(
      () => skills.register({ name: 's', description: 'd', instructions: 'i', tools: [{ name: 'x' }] }),
      ValidationError,
    );
  });

  it('rejects a skill name or tool name outside the provider-safe charset (fail-fast, not mid-run)', () => {
    const skills = new SkillRegistry();
    // A dot in the skill name → prefixed tool name breaks OpenAI/Anthropic at generate time; reject early.
    assert.throws(() => skills.register({ name: 'my.skill', description: 'd', instructions: 'i', tools: [] }), ValidationError);
    // A dot in a bare tool name has the same effect.
    assert.throws(
      () => skills.register({ name: 'ok', description: 'd', instructions: 'i', tools: [mkTool('bad.name')] }),
      ValidationError,
    );
    // An unsafe meta-tool name is rejected at construction.
    assert.throws(() => new SkillRegistry({ metaToolName: 'skill.use' }), ValidationError);
  });

  it('rejects a missing description or instructions', () => {
    const skills = new SkillRegistry();
    assert.throws(() => skills.register({ name: 's', instructions: 'i', tools: [] }), ValidationError);
    assert.throws(() => skills.register({ name: 's', description: 'd', tools: [] }), ValidationError);
  });

  it('registration does not commit a half-registered skill on a tool collision', () => {
    const skills = new SkillRegistry({ reserved: ['s_b'] });
    assert.throws(
      () => skills.register({ name: 's', description: 'd', instructions: 'i', tools: [mkTool('a'), mkTool('b')] }),
      ValidationError,
    );
    // 's' must not exist, and s_a must not have leaked into the tool-name set.
    skills.register({ name: 's', description: 'd', instructions: 'i', tools: [mkTool('a')] });
    assert.deepEqual(skills.unlocked(), []);
  });
});

describe('SkillRegistry — skill_use behavior', () => {
  it('skill_use returns the skill instructions and unlocks its tools', async () => {
    const skills = new SkillRegistry();
    skills.register(stashSkill());
    const result = await skills.metaTool.execute({ name: 'stash' });
    assert.match(result, /Checkpoint at the start/, 'instructions returned as the tool result');
    assert.deepEqual(skills.unlocked(), ['stash']);
    assert.deepEqual(skills.activeTools().map(t => t.name), ['skill_use', 'stash_checkpoint', 'stash_compact']);
  });

  it('skill_use on an unknown skill throws ToolError', async () => {
    const skills = new SkillRegistry();
    skills.register(stashSkill());
    await assert.rejects(() => skills.metaTool.execute({ name: 'nope' }), ToolError);
  });

  it('reset() clears the unlocked set but keeps registered skills', async () => {
    const skills = new SkillRegistry();
    skills.register(stashSkill());
    await skills.metaTool.execute({ name: 'stash' });
    skills.reset();
    assert.deepEqual(skills.unlocked(), []);
    assert.deepEqual(skills.activeTools().map(t => t.name), ['skill_use']);
  });
});

describe('SkillRegistry — integration with a real Loop (thunk D4)', () => {
  it('progressive disclosure end-to-end: skill_use unlocks tools the model then calls natively', async () => {
    let compactArgs = null;
    const skills = new SkillRegistry();
    skills.register(stashSkill(async (args) => { compactArgs = args; return { ok: true, foldedTurns: 3 }; }));

    // Mock provider reproducing the POC trace: round 0 skill_use(stash) → round 1 stash_compact → done.
    const offered = [];
    let i = 0;
    const responses = [
      { text: '', toolCalls: [{ id: 'c0', name: 'skill_use', arguments: { name: 'stash' } }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: '', toolCalls: [{ id: 'c1', name: 'stash_compact', arguments: { label: 'auth', reason: 'done' } }], usage: { inputTokens: 1, outputTokens: 1 } },
      { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const provider = {
      name: 'mock', model: 'fake',
      async generate(_msgs, tools) { offered.push((tools || []).map(t => t.name)); return responses[i++]; },
    };

    const loop = new Loop({ provider });
    // Pass the bound method directly as the tools thunk — exactly the PRD §2.7 API.
    const result = await loop.run([{ role: 'user', content: 'compact the finished auth sub-task' }], skills.activeTools);

    assert.equal(result.error, null);
    assert.deepEqual(offered[0], ['skill_use'], 'round 0: only the meta-tool offered (the negative)');
    assert.deepEqual(offered[1], ['skill_use', 'stash_checkpoint', 'stash_compact'], 'round 1: thunk surfaced unlocked tools');
    assert.deepEqual(compactArgs, { label: 'auth', reason: 'done' }, 'the unlocked tool executed with the model args');
  });
});
