'use strict';

/**
 * Policy helpers — composable predicates for `new Loop({ policy })`.
 *
 * Each helper returns an async function `(toolName, args, ctx) => true | string`
 * matching bareagent's policy contract. `true` allows; anything else denies.
 * A string is fed verbatim to the LLM as the deny reason.
 *
 * Compose multiple helpers with `combinePolicies(a, b, c)` — first non-`true`
 * verdict wins, short-circuit semantics.
 *
 * Zero deps. Pure Node. Cross-platform.
 */

const path = require('node:path');

function expandHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return process.env.HOME || process.env.USERPROFILE || '';
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return path.join(home, p.slice(2));
  }
  return p;
}

function normalize(p) {
  try {
    return path.resolve(expandHome(p));
  } catch {
    return p;
  }
}

/**
 * Allow/deny file-system paths used by tools like shell_read, shell_grep.
 *
 * Deny wins over allow. Paths containing `..` after normalization are denied
 * unconditionally (prevents traversal bypassing the allow list).
 *
 * @param {object} options
 * @param {string[]} [options.allow] - Path prefixes users may access. `~` expands.
 * @param {string[]} [options.deny] - Path prefixes hard-denied. `~` expands.
 * @param {string[]} [options.toolNames] - Only check these tool names. If omitted, checks any tool with an `args.path` string.
 * @param {string} [options.argKey='path'] - Name of the args field to inspect.
 * @returns {Function} policy predicate `(toolName, args) => true | string`
 */
function pathAllowlist({ allow = [], deny = [], toolNames, argKey = 'path' } = {}) {
  const allowNorm = allow.map(normalize);
  const denyNorm = deny.map(normalize);
  const gatedTools = toolNames ? new Set(toolNames) : null;

  return async function pathPolicy(toolName, args) {
    if (gatedTools && !gatedTools.has(toolName)) return true;
    const raw = args?.[argKey];
    if (typeof raw !== 'string') return true; // nothing to check
    const target = normalize(raw);

    for (const d of denyNorm) {
      if (target === d || target.startsWith(d + path.sep) || target.startsWith(d + '/')) {
        return `Path denied: ${raw} is under a denied root (${d}).`;
      }
    }
    if (allowNorm.length === 0) return true;
    for (const a of allowNorm) {
      if (target === a || target.startsWith(a + path.sep) || target.startsWith(a + '/')) {
        return true;
      }
    }
    return `Path denied: ${raw} is not under any allowed root.`;
  };
}

/**
 * Allow/deny commands by their base name.
 *
 * For `shell_run` (argv-array): inspects `args.argv[0]`. Safe — no shell in path.
 * For `shell_exec` (raw shell): inspects `args.command.split(/\s+/)[0]` BUT this
 * is defeatable by shell metacharacters. Prefer gating `shell_run` with this helper
 * and denying `shell_exec` entirely, or handling shell_exec with a custom policy
 * that parses the command string carefully.
 *
 * Deny wins over allow.
 *
 * @param {object} options
 * @param {string[]} [options.allow] - Base command names allowed.
 * @param {string[]} [options.deny] - Base command names denied.
 * @param {string} [options.toolName='shell_run'] - Which tool this helper gates.
 * @returns {Function} policy predicate `(toolName, args) => true | string`
 */
function commandAllowlist({ allow = [], deny = [], toolName = 'shell_run' } = {}) {
  const allowSet = new Set(allow);
  const denySet = new Set(deny);

  return async function commandPolicy(name, args) {
    if (name !== toolName) return true;
    let base;
    if (name === 'shell_run') {
      if (!Array.isArray(args?.argv) || typeof args.argv[0] !== 'string') return true;
      base = args.argv[0];
    } else {
      if (typeof args?.command !== 'string') return true;
      base = args.command.trim().split(/\s+/)[0];
    }
    if (denySet.has(base)) return `Command denied: ${base} is on the denylist.`;
    if (allowSet.size > 0 && !allowSet.has(base)) {
      return `Command denied: ${base} is not on the allowlist.`;
    }
    return true;
  };
}

/**
 * Compose multiple policy predicates into one. First non-true verdict wins.
 * Short-circuits on first deny — later predicates are not called.
 *
 * @param {...Function} policies - Any number of policy predicates.
 * @returns {Function} combined policy predicate `(toolName, args, ctx) => true | string`
 */
function combinePolicies(...policies) {
  const list = policies.filter(p => typeof p === 'function');
  return async function combined(toolName, args, ctx) {
    for (const p of list) {
      const verdict = await p(toolName, args, ctx);
      if (verdict !== true) return verdict;
    }
    return true;
  };
}

module.exports = { pathAllowlist, commandAllowlist, combinePolicies };
