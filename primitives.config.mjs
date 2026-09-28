// bare-agent's repo-specific config for the shared primitives.json generator
// core (scripts/primitives-core.mjs, vendored byte-identically into
// bareguard and litectx too). Only what genuinely differs per repo lives
// here — category inference and (for repos with class-method verbs) a
// receiver-name map. See docs/product/prd.md § "Primitives manifest".
import { basename } from 'node:path';

// --- category inference (POSIX-normalized relative path -> category) ---------
// `file` is always forward-slash-separated (the core normalizes it before
// calling this), so 'tools/' matches regardless of the checkout platform.
function inferCategory(file) {
  if (file.startsWith('tools/')) return 'tools';
  const b = basename(file, '.js');
  if (b === 'loop') return 'loop';
  if (/^transport-/.test(b)) return 'transports';
  if (b === 'recurse-retrieval') return 'retrieval';
  if (/^recurse/.test(b) || b === 'planner' || b === 'run-plan') return 'orchestration';
  if (['evaluator', 'refine', 'remember'].includes(b) || /^judge/.test(b)) return 'evaluation';
  if (b === 'complexity') return 'routing';
  if (b === 'skills' || b === 'stash') return 'skills';
  if (b === 'bareguard-adapter') return 'governance';
  if (/^provider-/.test(b)) return 'providers';
  if (/^store-/.test(b)) return 'stores';
  if (b === 'memory') return 'memory';
  if (b === 'retry' || b === 'circuit-breaker') return 'resilience';
  if (b === 'stream') return 'observability';
  if (b === 'scheduler') return 'scheduling';
  if (b === 'state') return 'state';
  if (b === 'checkpoint') return 'hitl';
  if (/^mcp/.test(b)) return 'mcp';
  if (b === 'context-units') return 'context';
  return 'core';
}

export default {
  inferCategory,
  // sourceRoots: default ['src', 'tools'] — bare-agent uses both, unchanged.
  // receivers: default {} — bare-agent has no class-method @when primitives.
};
