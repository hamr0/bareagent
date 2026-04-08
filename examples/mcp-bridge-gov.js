#!/usr/bin/env node
'use strict';

/**
 * MCP Bridge + mcp-gov integration test.
 * Uses mcp-gov's operation detector as a policy function.
 *
 * Usage:
 *   node examples/mcp-bridge-gov.js
 */

const { createMCPBridge } = require('../src/mcp-bridge');

async function main() {
  // Import mcp-gov (ESM) — use the operation detector directly
  const { detectOperation, parseToolName } = await import(
    '/home/hamr/PycharmProjects/mcp-gov/src/operation-detector.js'
  );

  // Define rules: what operation types are allowed per server
  const rules = {
    barebrowse: { read: 'allow', write: 'allow', delete: 'deny', execute: 'deny', admin: 'deny' },
    baremobile: { read: 'allow', write: 'deny', delete: 'deny', execute: 'deny', admin: 'deny' },
  };

  // Show how mcp-gov classifies each tool
  console.log('--- mcp-gov classification of barebrowse tools ---');
  const probe = await createMCPBridge({ servers: ['barebrowse'], timeout: 10000 });
  for (const tool of probe.tools) {
    const { service, operation } = parseToolName(tool.name);
    const rule = rules[service]?.[operation] || 'allow';
    console.log(`  ${tool.name.padEnd(25)} → ${operation.padEnd(8)} → ${rule}`);
  }
  await probe.close();

  // Now create a governed bridge
  console.log('\n--- Governed bridge ---');
  const bridge = await createMCPBridge({
    servers: ['barebrowse'],
    timeout: 10000,
    policy: async (server, tool, args) => {
      const fullName = `${server}_${tool}`;
      const { service, operation } = parseToolName(fullName);
      const serverRules = rules[service];
      if (!serverRules) return true; // no rules = allow

      const permission = serverRules[operation];
      if (permission === 'deny') {
        return `mcp-gov: ${operation} operations denied for ${service} (tool: ${tool})`;
      }
      return true;
    },
  });

  console.log(`Connected: ${bridge.servers.join(', ')}`);
  console.log(`Tools available: ${bridge.tools.length}`);
  console.log(`Tools: ${bridge.tools.map(t => t.name).join(', ')}`);

  // Test 1: allowed call (browse = has "browse" keyword → read)
  console.log('\n--- Test 1: browse (read) — should ALLOW ---');
  try {
    const result = await bridge.tools
      .find(t => t.name === 'barebrowse_browse')
      .execute({ url: 'https://example.com', maxChars: 500 });
    console.log(`  ALLOWED — ${typeof result === 'string' ? result.slice(0, 80) : 'ok'}...`);
  } catch (err) {
    const isPolicy = err.message.includes('mcp-gov');
    console.log(isPolicy
      ? `  POLICY DENIED — ${err.message}`
      : `  TOOL ERROR (allowed, but tool failed) — ${err.message}`);
  }

  // Test 2: allowed call (goto = has "go" → not matched, defaults to write → allowed)
  console.log('\n--- Test 2: goto (write) — should ALLOW ---');
  try {
    await bridge.tools
      .find(t => t.name === 'barebrowse_goto')
      .execute({ url: 'https://example.com' });
    console.log('  ALLOWED');
  } catch (err) {
    const isPolicy = err.message.includes('mcp-gov');
    console.log(isPolicy
      ? `  POLICY DENIED — ${err.message}`
      : `  TOOL ERROR (allowed, but tool failed) — ${err.message}`);
  }

  // Test 3: snapshot (read operation — has "snap" → not matched directly, let's see)
  console.log('\n--- Test 3: snapshot — should ALLOW ---');
  try {
    const result = await bridge.tools
      .find(t => t.name === 'barebrowse_snapshot')
      .execute({});
    console.log(`  ALLOWED — ${typeof result === 'string' ? result.slice(0, 80) : 'ok'}...`);
  } catch (err) {
    const isPolicy = err.message.includes('mcp-gov');
    console.log(isPolicy
      ? `  POLICY DENIED — ${err.message}`
      : `  TOOL ERROR (allowed, but tool failed) — ${err.message}`);
  }

  // Test 4: upload (has "upload" keyword → write → allowed for barebrowse)
  console.log('\n--- Test 4: upload (write) — should ALLOW ---');
  try {
    await bridge.tools
      .find(t => t.name === 'barebrowse_upload')
      .execute({ ref: '1', files: ['/tmp/test.txt'] });
    console.log('  ALLOWED');
  } catch (err) {
    const isPolicy = err.message.includes('mcp-gov');
    console.log(isPolicy
      ? `  POLICY DENIED — ${err.message}`
      : `  TOOL ERROR (allowed, but tool failed) — ${err.message}`);
  }

  // Test 5: click (has "click" → not in keywords, defaults to write → allowed)
  console.log('\n--- Test 5: click (write default) — should ALLOW ---');
  try {
    await bridge.tools
      .find(t => t.name === 'barebrowse_click')
      .execute({ ref: '1' });
    console.log('  ALLOWED');
  } catch (err) {
    const isPolicy = err.message.includes('mcp-gov');
    console.log(isPolicy
      ? `  POLICY DENIED — ${err.message}`
      : `  TOOL ERROR (allowed, but tool failed) — ${err.message}`);
  }

  // Test 6: Now test with baremobile rules (read-only)
  console.log('\n--- Test 6: baremobile with read-only rules ---');
  const mobileBridge = await createMCPBridge({
    servers: ['baremobile'],
    timeout: 10000,
    policy: async (server, tool, args) => {
      const fullName = `${server}_${tool}`;
      const { service, operation } = parseToolName(fullName);
      const serverRules = rules[service];
      if (!serverRules) return true;
      const permission = serverRules[operation];
      if (permission === 'deny') {
        return `mcp-gov: ${operation} operations denied for ${service} (tool: ${tool})`;
      }
      return true;
    },
  });

  console.log(`\nbaremobile tool classifications:`);
  for (const tool of mobileBridge.tools) {
    const { operation } = parseToolName(tool.name);
    const rule = rules.baremobile?.[operation] || 'allow';
    console.log(`  ${tool.name.padEnd(28)} → ${operation.padEnd(8)} → ${rule}`);
  }

  // Test 7: tap should not even exist in the tool list
  console.log('\n--- Test 7: baremobile tap — should be REMOVED from tool list ---');
  const tap = mobileBridge.tools.find(t => t.name === 'baremobile_tap');
  console.log(tap
    ? `  FAIL — tap is still in tool list (LLM would see it)`
    : `  PASS — tap removed at discovery time. LLM never sees it.`);

  // Test 8: snapshot classified as write by mcp-gov, so also removed
  console.log('\n--- Test 8: baremobile snapshot — mcp-gov classifies as write ---');
  const snap = mobileBridge.tools.find(t => t.name === 'baremobile_snapshot');
  const snapOp = parseToolName('baremobile_snapshot');
  console.log(`  mcp-gov classification: ${snapOp.operation}`);
  console.log(snap
    ? `  PRESENT — tool is available (${snapOp.operation} is allowed)`
    : `  REMOVED — tool filtered out (${snapOp.operation} is denied). NOTE: mcp-gov misclassifies snapshot as "${snapOp.operation}" — should be "read".`);

  // Test 9: find_by_text should be the only tool left (read → allowed)
  console.log('\n--- Test 9: find_by_text — only read tool remaining ---');
  const find = mobileBridge.tools.find(t => t.name === 'baremobile_find_by_text');
  if (find) {
    try {
      await find.execute({ text: 'Settings', platform: 'android' });
      console.log('  PASS — allowed and executed');
    } catch (err) {
      const isPolicy = err.message.includes('mcp-gov') || err.message.includes('GOVERNANCE');
      console.log(isPolicy
        ? `  FAIL — policy blocked a read tool: ${err.message}`
        : `  PASS — allowed (device error is fine: ${err.message})`);
    }
  } else {
    console.log('  FAIL — find_by_text should be in the tool list');
  }

  await bridge.close();
  await mobileBridge.close();
  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
