#!/usr/bin/env node
'use strict';

/**
 * Concurrent MCP stress test — real domains, real payloads, varying complexity.
 *
 * Usage:
 *   node examples/mcp-bridge-concurrent.js
 */

const { readFileSync } = require('node:fs');
const { createMCPBridge } = require('../src/mcp-bridge');

async function main() {
  console.log('Connecting to barebrowse...');
  const bridge = await createMCPBridge({ servers: ['barebrowse'], timeout: 15000 });

  if (bridge.servers.length === 0) {
    console.error('No servers connected');
    process.exit(1);
  }

  const browse = bridge.tools.find(t => t.name === 'barebrowse_browse');

  const tasks = [
    {
      label: 'Amazon NL — 2.5 inch HDD SATA case',
      args: { url: 'https://www.amazon.nl/s?k=2.5+inch+hdd+sata+case', maxChars: 3000 },
      verify: (r) => /amazon/i.test(r) || /hdd|sata|case|behuizing/i.test(r),
      shouldFail: false,
    },
    {
      label: 'Wikipedia — Phoenician language',
      args: { url: 'https://en.wikipedia.org/wiki/Phoenician_language', maxChars: 3000 },
      verify: (r) => /phoenician/i.test(r) || /semitic|canaanite/i.test(r),
      shouldFail: false,
    },
    {
      label: 'Dead domain — should fail or timeout',
      args: { url: 'https://this-domain-does-not-exist-xyz-999.com/page', maxChars: 1000 },
      verify: () => true, // any response is fine, we just want to see it doesn't hang or crash others
      shouldFail: true,
    },
    {
      label: 'GitHub — bare-agent repo',
      args: { url: 'https://github.com/nicobailon/bareagent', maxChars: 2000 },
      verify: (r) => /bare.?agent|orchestration|lightweight/i.test(r),
      shouldFail: false,
    },
    {
      label: 'Slow static page — archive.org',
      args: { url: 'https://web.archive.org/web/2024/https://example.com/', maxChars: 2000 },
      verify: (r) => /example|wayback|archive/i.test(r),
      shouldFail: false,
    },
  ];

  console.log(`\nFiring ${tasks.length} concurrent browse calls...\n`);

  const t0 = Date.now();
  const results = await Promise.allSettled(
    tasks.map(t => browse.execute(t.args))
  );
  const elapsed = Date.now() - t0;

  let passed = 0;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const r = results[i];
    const status = r.status === 'fulfilled' ? 'OK' : 'FAIL';
    const value = r.status === 'fulfilled' ? r.value : r.reason.message;
    let text = typeof value === 'string' ? value : JSON.stringify(value);
    // If barebrowse saved to disk, read the file to verify actual content
    const fileMatch = text.match(/saved to (.+\.yml)/);
    if (fileMatch) {
      try { text += '\n' + readFileSync(fileMatch[1], 'utf8'); } catch {}
    }
    const correct = r.status === 'fulfilled' && task.verify(text);

    console.log(`[${i + 1}] ${task.label}`);
    if (task.shouldFail) {
      const handled = r.status === 'rejected' || (r.status === 'fulfilled' && /error|fail|not|ERR_/i.test(text.slice(0, 500)));
      console.log(`    Status: ${status} | Error handled gracefully: ${handled ? 'YES' : 'NO'}`);
      console.log(`    Preview: ${(r.status === 'rejected' ? r.reason.message : text).slice(0, 120)}...`);
      console.log();
      if (handled) passed++;
    } else {
      console.log(`    Status: ${status} | Routed correctly: ${correct ? 'YES' : 'NO'}`);
      console.log(`    Size: ${text.length} chars`);
      console.log(`    Preview: ${text.slice(0, 120)}...`);
      console.log();
      if (correct) passed++;
    }
  }

  console.log(`--- Result: ${passed}/${tasks.length} routed correctly in ${elapsed}ms ---`);
  console.log(passed === tasks.length ? 'PASS' : 'FAIL');

  await bridge.close();
  console.log('Closed.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
