'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildMetaTools } = require('../src/mcp-bridge');

describe('buildMetaTools (mcp_discover + mcp_invoke)', () => {
  function fakeBulkTool(name, description, schema) {
    let called = null;
    const tool = {
      name,
      description,
      parameters: schema,
      execute: async (args) => {
        called = args;
        return { ok: true, args };
      },
    };
    Object.defineProperty(tool, '_lastCalledWith', { get: () => called });
    return tool;
  }

  it('returns exactly two tools named mcp_discover and mcp_invoke', () => {
    const meta = buildMetaTools([], '2026-04-30T12:00:00Z');
    assert.equal(meta.length, 2);
    assert.equal(meta[0].name, 'mcp_discover');
    assert.equal(meta[1].name, 'mcp_invoke');
  });

  describe('mcp_discover', () => {
    it('returns the catalog with descriptors carrying server + tool', async () => {
      const tools = [
        fakeBulkTool('linear_list_issues', 'List issues', { type: 'object' }),
        fakeBulkTool('linear_create_issue', 'Create an issue', { type: 'object' }),
        fakeBulkTool('beeperbox_send_message', 'Send a message', { type: 'object' }),
      ];
      const [discover] = buildMetaTools(tools, '2026-04-30T12:00:00Z');
      const result = await discover.execute({});
      assert.equal(result.count, 3);
      assert.equal(result.cachedAt, '2026-04-30T12:00:00Z');
      const linearList = result.tools.find(t => t.name === 'linear_list_issues');
      assert.equal(linearList.server, 'linear');
      assert.equal(linearList.tool, 'list_issues');
      assert.equal(linearList.description, 'List issues');
    });

    it('filters by server when given the server arg', async () => {
      const tools = [
        fakeBulkTool('linear_list_issues', '', {}),
        fakeBulkTool('beeperbox_send_message', '', {}),
      ];
      const [discover] = buildMetaTools(tools, '2026-04-30T12:00:00Z');
      const result = await discover.execute({ server: 'linear' });
      assert.equal(result.count, 1);
      assert.equal(result.tools[0].server, 'linear');
    });

    it('handles tools with no underscore in the name (no server prefix)', async () => {
      const tools = [fakeBulkTool('standalone', 'A standalone tool', {})];
      const [discover] = buildMetaTools(tools, '2026-04-30T12:00:00Z');
      const result = await discover.execute({});
      assert.equal(result.tools[0].server, 'standalone');
      assert.equal(result.tools[0].tool, '');
    });

    it('defaults cachedAt when not provided', async () => {
      const [discover] = buildMetaTools([], null);
      const result = await discover.execute({});
      assert.match(result.cachedAt, /^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('mcp_invoke', () => {
    it('dispatches by name to the underlying tool execute', async () => {
      const linearList = fakeBulkTool('linear_list_issues', '', {});
      const [, invoke] = buildMetaTools([linearList], '2026-04-30T12:00:00Z');
      const result = await invoke.execute({ name: 'linear_list_issues', args: { limit: 5 } });
      assert.deepEqual(result, { ok: true, args: { limit: 5 } });
      assert.deepEqual(linearList._lastCalledWith, { limit: 5 });
    });

    it('treats missing args as {}', async () => {
      const tool = fakeBulkTool('foo_bar', '', {});
      const [, invoke] = buildMetaTools([tool], '2026-04-30T12:00:00Z');
      await invoke.execute({ name: 'foo_bar' });
      assert.deepEqual(tool._lastCalledWith, {});
    });

    it('throws ToolError when name is unknown', async () => {
      const [, invoke] = buildMetaTools([fakeBulkTool('a_b', '', {})], '2026-04-30T12:00:00Z');
      await assert.rejects(
        () => invoke.execute({ name: 'does_not_exist', args: {} }),
        /unknown tool "does_not_exist"/,
      );
    });

    it('error context lists known names for diagnostic recovery', async () => {
      const [, invoke] = buildMetaTools(
        [fakeBulkTool('a_one', '', {}), fakeBulkTool('b_two', '', {})],
        '2026-04-30T12:00:00Z',
      );
      try {
        await invoke.execute({ name: 'wrong', args: {} });
        assert.fail('should have thrown');
      } catch (err) {
        assert.deepEqual(err.context.knownNames, ['a_one', 'b_two']);
      }
    });
  });
});
