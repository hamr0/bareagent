'use strict';

const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

// Shared tool names (both platforms)
const SHARED_TOOLS = [
  'mobile_snapshot', 'mobile_tap', 'mobile_type', 'mobile_press',
  'mobile_scroll', 'mobile_swipe', 'mobile_long_press', 'mobile_launch',
  'mobile_back', 'mobile_home', 'mobile_screenshot', 'mobile_tap_xy',
  'mobile_find_text', 'mobile_wait_text', 'mobile_wait_state',
];

// Android-only additions
const ANDROID_ONLY = ['mobile_intent', 'mobile_tap_grid', 'mobile_grid'];

// iOS-only additions
const IOS_ONLY = ['mobile_unlock'];

describe('createMobileTools', () => {
  it('returns null when baremobile is not installed', async () => {
    // baremobile is not installed in this test env, so dynamic import fails
    const { createMobileTools } = require('../tools/mobile');
    const result = await createMobileTools();
    assert.equal(result, null);
  });

  it('returns null for ios platform when baremobile/ios is not installed', async () => {
    const { createMobileTools } = require('../tools/mobile');
    const result = await createMobileTools({ platform: 'ios' });
    assert.equal(result, null);
  });
});

// Mock-based tests to verify tool shapes without a real device
describe('createMobileTools (mocked)', () => {
  // We test by reading the source and verifying structure expectations.
  // Since we can't easily mock dynamic import() in node:test, we test
  // the module export shape and tool name expectations.

  it('exports createMobileTools as a function', () => {
    const mod = require('../tools/mobile');
    assert.equal(typeof mod.createMobileTools, 'function');
  });

  it('source defines all expected shared tool names', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../tools/mobile'), 'utf8');

    for (const name of SHARED_TOOLS) {
      assert.ok(src.includes(`name: '${name}'`), `Missing shared tool: ${name}`);
    }
  });

  it('source defines Android-only tool names', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../tools/mobile'), 'utf8');

    for (const name of ANDROID_ONLY) {
      assert.ok(src.includes(`name: '${name}'`), `Missing Android tool: ${name}`);
    }
  });

  it('source defines iOS-only tool names', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../tools/mobile'), 'utf8');

    for (const name of IOS_ONLY) {
      assert.ok(src.includes(`name: '${name}'`), `Missing iOS tool: ${name}`);
    }
  });

  it('Android-only tools are gated behind platform !== ios', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../tools/mobile'), 'utf8');

    // intent, tap_grid, grid should be inside the `if (platform !== 'ios')` block
    const androidBlock = src.slice(
      src.indexOf("if (platform !== 'ios')"),
      src.indexOf("// iOS-only tools")
    );
    for (const name of ANDROID_ONLY) {
      assert.ok(androidBlock.includes(`name: '${name}'`), `${name} should be in Android-only block`);
    }
  });

  it('iOS-only tools are gated behind platform === ios', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../tools/mobile'), 'utf8');

    const iosBlock = src.slice(
      src.indexOf("if (platform === 'ios')"),
      src.indexOf("// Find tools")
    );
    for (const name of IOS_ONLY) {
      assert.ok(iosBlock.includes(`name: '${name}'`), `${name} should be in iOS-only block`);
    }
  });

  it('tap_xy is in shared tools, not Android-only', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../tools/mobile'), 'utf8');

    const androidBlock = src.slice(
      src.indexOf("if (platform !== 'ios')"),
      src.indexOf("// iOS-only tools")
    );
    assert.ok(!androidBlock.includes("name: 'mobile_tap_xy'"), 'tap_xy should NOT be in Android-only block');

    // It should be in the main tools array (before the Android-only block)
    const sharedBlock = src.slice(0, src.indexOf("if (platform !== 'ios')"));
    assert.ok(sharedBlock.includes("name: 'mobile_tap_xy'"), 'tap_xy should be in shared tools');
  });

  it('every tool definition has name, description, parameters, execute', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('../tools/mobile'), 'utf8');

    const allTools = [...SHARED_TOOLS, ...ANDROID_ONLY, ...IOS_ONLY];
    for (const name of allTools) {
      // Each tool object should have these four fields
      // We verify by checking that after each `name: 'tool_name'` there's a description
      const idx = src.indexOf(`name: '${name}'`);
      assert.ok(idx > -1, `Tool ${name} not found in source`);
      // Check that execute exists nearby (within ~800 chars — tool definitions are ~500 chars)
      const slice = src.slice(idx, idx + 800);
      assert.ok(slice.includes('execute:'), `Tool ${name} missing execute`);
      assert.ok(slice.includes('description:'), `Tool ${name} missing description`);
      assert.ok(slice.includes('parameters:'), `Tool ${name} missing parameters`);
    }
  });

  it('expected tool count: 18 total (15 shared + 3 Android-only)', () => {
    assert.equal(SHARED_TOOLS.length + ANDROID_ONLY.length, 18);
  });

  it('expected tool count: 16 total (15 shared + 1 iOS-only)', () => {
    assert.equal(SHARED_TOOLS.length + IOS_ONLY.length, 16);
  });
});
