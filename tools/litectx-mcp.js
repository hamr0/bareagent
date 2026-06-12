'use strict';

// RT-4 — mount litectx-mcp into a child agent, read-only, on its own db. A thin recipe helper: it
// builds the curated `.mcp-bridge.json` config that `createMCPBridge` consumes, so a parent composing
// a child's toolbox can't fat-finger the allow-list (e.g. accidentally allow a write verb). It encodes
// ONE thing — the agreed read-only default (PRD §4.2) — and knows only litectx-mcp's public verb names
// (the same strings a hand-written `.mcp-bridge.json` would carry). It does NOT import litectx: the
// dependency direction stays one-way; this is config curation, bareagent's job.
//
// Default toolbox (PRD §4.2):
//   recall · get · impact · recent  → allow   (read / reason — the point of giving a child memory)
//   remember · forget               → deny    (agent writes are by:"agent", suspect-until-curated;
//                                               flip with { writable: true } as the explicit opt-in)
//   index · promotions              → deny    (index is human/hook-driven; promotions is a review flow)
//
// Isolation is OWN-DB, not a scope column (this is what decouples RT-4 from RT-5): the child gets its
// own `--root` → physical isolation, zero schema change. An opted-in child's writes land in ITS db;
// promotion to the parent is an explicit parent-side `recall`→`remember`, never automatic.

/** Read/reason verbs a child is given by default. */
const READ_VERBS = ['recall', 'get', 'impact', 'recent'];
/** Write verbs — denied unless `writable`, then allowed (writes still land in the child's OWN db). */
const WRITE_VERBS = ['remember', 'forget'];
/** Admin/review verbs — always denied to a child (human/hook + review flows). */
const ADMIN_VERBS = ['index', 'promotions'];

/**
 * Build a curated bridge config that mounts litectx-mcp read-only on its own db.
 * @param {object} opts
 * @param {string} opts.root - the child's OWN litectx root/db (passed as `--root`). Isolation.
 * @param {string} [opts.command='litectx-mcp'] - the server command (override for a fake/abs path).
 * @param {string[]} [opts.args=[]] - extra args appended after `--root <root>` (e.g. `--no-embeddings`).
 * @param {boolean} [opts.writable=false] - opt-in: allow remember/forget (still child-db-local).
 * @param {string} [opts.name='litectx'] - server name (tool prefix → `<name>_recall`, …).
 * @param {string} [opts.ttl='24h'] - bridge config TTL.
 * @param {string} [opts.now] - ISO timestamp for `discovered` (default: now). Pre-seed fresh so
 *   `createMCPBridge` skips IDE discovery and connects straight to this curated server.
 * @returns {import('../src/mcp-bridge').BridgeConfig}
 */
function liteCtxMcpBridgeConfig(opts) {
  if (!opts || typeof opts.root !== 'string' || !opts.root) {
    throw new Error('[litectx-mcp] requires opts.root (the child\'s own db root — own-db isolation)');
  }
  const { root, command = 'litectx-mcp', args = [], writable = false, name = 'litectx', ttl = '24h', now } = opts;

  /** @type {Record<string, string>} */
  const tools = {};
  for (const v of READ_VERBS) tools[v] = 'allow';
  for (const v of WRITE_VERBS) tools[v] = writable ? 'allow' : 'deny';
  for (const v of ADMIN_VERBS) tools[v] = 'deny';

  return {
    discovered: now || new Date().toISOString(),
    ttl,
    servers: {
      [name]: {
        command,
        args: ['--root', root, ...args],
        tools,
      },
    },
  };
}

module.exports = { liteCtxMcpBridgeConfig, READ_VERBS, WRITE_VERBS, ADMIN_VERBS };
