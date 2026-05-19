#!/usr/bin/env node
'use strict';

/**
 * Replay-job POC — supervised replay of a recorded browser task.
 *
 * The idea: record once with the LLM driving (full reasoning), then on every
 * subsequent run replay the recorded *intents* against a fresh snapshot, with
 * the LLM acting as a locator/supervisor — not a planner. If the locator
 * can't find a match for a step, fall back to full Loop reasoning from that
 * point and overwrite the trace. That's the self-healing path.
 *
 * Why this isn't a barebrowse feature: barebrowse stays dumb (URL → snapshot,
 * ref → action). The "job" concept (trace storage, replay supervisor, scheduler
 * hookup) is composed from bareagent primitives.
 *
 * Usage:
 *   # First run — record:
 *   OPENAI_API_KEY=sk-... node examples/replay-job.js --record demo-job \
 *     "Go to example.com and click the 'More information' link"
 *
 *   # Subsequent runs — replay:
 *   OPENAI_API_KEY=sk-... node examples/replay-job.js --replay demo-job
 *
 *   # Cron'd:
 *   *\/15 * * * * node /path/to/replay-job.js --replay demo-job
 *
 * What's deliberately NOT in this POC (next steps, in order):
 *   1. Fingerprint fast-path: hash selector+role+text per step, try direct
 *      match before calling the locator LLM. Brings per-step cost to ~0 on
 *      stable UIs (Gmail, IG).
 *   2. PostState assertion: after each step, ask the LLM "does this snapshot
 *      reflect the expected outcome?" Without this, replay can silently drift
 *      on subtly-changed UIs.
 *   3. Trace confidence: rolling success rate per step; below a threshold,
 *      re-derive the whole trace instead of patching one entry.
 *   4. Scheduler integration: wrap as a Scheduler trigger so cron is a config
 *      line instead of an OS cron entry.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Loop } = require('../src/loop');

const JOBS_DIR = path.join(__dirname, '..', '.jobs');

function parseArgs(argv) {
  const mode = argv.includes('--record') ? 'record'
             : argv.includes('--replay') ? 'replay'
             : null;
  const flagIdx = argv.indexOf(`--${mode}`);
  const name = mode ? argv[flagIdx + 1] : null;
  const goal = argv.slice(flagIdx + 2).join(' ');
  return { mode, name, goal };
}

function jobPath(name) { return path.join(JOBS_DIR, `${name}.json`); }

function loadProvider() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error('Set OPENAI_API_KEY'); process.exit(1); }
  const { OpenAIProvider } = require('../src/provider-openai');
  return new OpenAIProvider({ apiKey, model: 'gpt-4.1-mini' });
}

async function loadBrowseTools() {
  const mod = await import('barebrowse/bareagent');
  return mod.createBrowseTools({});
}

// --- RECORD ----------------------------------------------------------------
// Run Loop normally. The onToolCall hook captures each step as it happens.
// The trace stores the LLM's free-text "intent" (the assistant message
// immediately preceding the tool call) alongside the tool name and args.
// On replay, intent is what the locator LLM matches against — not args.
async function record({ name, goal }) {
  const provider = loadProvider();
  const { tools, close } = await loadBrowseTools();

  const trace = [];
  let pendingIntent = '';

  const loop = new Loop({
    provider,
    maxRounds: 15,
    onText: (text) => { pendingIntent = text; },
    onToolCall: (toolName, args) => {
      trace.push({ intent: pendingIntent.trim().slice(0, 500), tool: toolName, args });
      pendingIntent = '';
    },
  });

  try {
    const result = await loop.run([{ role: 'user', content: goal }], tools);
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.writeFileSync(jobPath(name), JSON.stringify({ goal, recordedAt: new Date().toISOString(), trace }, null, 2));
    console.log(`[record] saved ${trace.length} steps to ${jobPath(name)}`);
    console.log(`[record] cost: $${(result.cost ?? 0).toFixed(4)}`);
  } finally {
    await close();
  }
}

// --- REPLAY ----------------------------------------------------------------
// For each recorded step:
//   1. Take a fresh snapshot.
//   2. Ask the LLM (no tools, JSON-mode) to map the recorded intent to a ref
//      in the current snapshot — OR return null if no match.
//   3. On match: execute the tool with the resolved ref. The recorded args
//      that aren't refs (e.g. type's `text`, goto's `url`) carry over verbatim.
//   4. On miss: fall back to driving Loop from the remaining goal, capture
//      the new sub-trace, and splice it into the saved trace.
async function replay({ name }) {
  const job = JSON.parse(fs.readFileSync(jobPath(name), 'utf8'));
  const provider = loadProvider();
  const { tools, close } = await loadBrowseTools();
  const toolByName = Object.fromEntries(tools.map((t) => [t.name, t]));

  let mutated = false;

  try {
    for (let i = 0; i < job.trace.length; i++) {
      const step = job.trace[i];
      const tool = toolByName[step.tool];
      if (!tool) throw new Error(`unknown tool in trace: ${step.tool}`);

      // Steps whose args have no ref (goto, browse, back, scroll) replay verbatim.
      if (!('ref' in (step.args || {}))) {
        console.log(`[replay ${i + 1}/${job.trace.length}] ${step.tool}(${JSON.stringify(step.args)})`);
        await tool.execute(step.args);
        continue;
      }

      // Ref-bearing steps: snapshot, then ask the LLM to locate.
      const snapshot = await toolByName.snapshot.execute({});
      const snapshotText = typeof snapshot === 'string' ? snapshot : (snapshot?.snapshot ?? JSON.stringify(snapshot));
      const located = await locate({ provider, intent: step.intent, tool: step.tool, snapshotText });

      if (located.ref) {
        const args = { ...step.args, ref: located.ref };
        console.log(`[replay ${i + 1}/${job.trace.length}] ${step.tool}(ref=${located.ref}) — intent="${step.intent.slice(0, 60)}"`);
        await tool.execute(args);
      } else {
        console.warn(`[replay ${i + 1}/${job.trace.length}] locator miss — falling back to full Loop`);
        const remaining = `Continue this task from the current page. Original goal: ${job.goal}. We have completed ${i} of ${job.trace.length} recorded steps; the next intended step was: "${step.intent}".`;
        const subTrace = await driveFallback({ provider, tools, goal: remaining });
        job.trace.splice(i, job.trace.length - i, ...subTrace);
        mutated = true;
        break;
      }
    }

    if (mutated) {
      job.recordedAt = new Date().toISOString();
      fs.writeFileSync(jobPath(name), JSON.stringify(job, null, 2));
      console.log(`[replay] trace patched after locator miss; saved ${job.trace.length} steps`);
    } else {
      console.log(`[replay] completed ${job.trace.length} steps without falling back`);
    }
  } finally {
    await close();
  }
}

// Locator: structured-output call, no tools, no loop. One LLM call per ref-bearing step.
async function locate({ provider, intent, tool, snapshotText }) {
  const system = 'You map a recorded intent to a ref in a current ARIA snapshot. Reply with strict JSON: {"ref": "<ref>"} if confident, or {"ref": null, "reason": "<why>"} if no element matches. Never invent refs not present in the snapshot.';
  const user = `Recorded intent: ${intent}\nTool: ${tool}\n\nCurrent snapshot:\n${snapshotText}\n\nReturn JSON only.`;
  const { text } = await provider.generate({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : text);
  } catch {
    return { ref: null, reason: 'unparseable locator response' };
  }
}

// Fallback driver: same shape as record(), just used mid-replay when the
// locator can't resolve a step. Returns the new sub-trace to splice in.
async function driveFallback({ provider, tools, goal }) {
  const sub = [];
  let pendingIntent = '';
  const loop = new Loop({
    provider,
    maxRounds: 10,
    onText: (text) => { pendingIntent = text; },
    onToolCall: (toolName, args) => {
      sub.push({ intent: pendingIntent.trim().slice(0, 500), tool: toolName, args });
      pendingIntent = '';
    },
  });
  await loop.run([{ role: 'user', content: goal }], tools);
  return sub;
}

async function main() {
  const { mode, name, goal } = parseArgs(process.argv.slice(2));
  if (!mode || !name) {
    console.error('Usage:\n  --record <name> "<goal>"\n  --replay <name>');
    process.exit(1);
  }
  if (mode === 'record') {
    if (!goal) { console.error('record mode requires a goal string'); process.exit(1); }
    await record({ name, goal });
  } else {
    if (!fs.existsSync(jobPath(name))) { console.error(`no job at ${jobPath(name)}`); process.exit(1); }
    await replay({ name });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
