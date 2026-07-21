'use strict';

/**
 * BA-16 — the MCP stdio server the CLI spawns in native tool mode (`toolProtocol:'claude-mcp'`).
 *
 * This file owns NO tool logic. bare-agent's tools are `execute` CLOSURES living in the caller's
 * process, but `--mcp-config` can only point the CLI at a COMMAND — so the tool surface has to cross
 * a process boundary that the closures cannot. This stub is the bridge for exactly that hop:
 *
 *   claude CLI  <--stdio JSON-RPC-->  THIS FILE  <--unix socket-->  parent (caller's closures)
 *
 * It is deliberately dumb. Everything that can decide anything — the manifest, the gate, the spin
 * guards, redaction — lives parent-side, so the stub can never become a second place where policy
 * is enforced (and never a second place where a secret can be logged: it writes no files at all).
 *
 * The one rule it does enforce is the BA-15 principle at the process boundary: EVERY failure of the
 * hop is returned as a tool RESULT, never as a crash and never as a hang. A dead parent, a malformed
 * frame and a slow handler all become `isError` results the model can read and react to — validated
 * live before this shipped (probe 6: parent killed mid-call, session ended in 5.9s, no hang).
 *
 * Not a package export and never `require`d by the library — it is spawned as `node <this file>`.
 */

const { createInterface } = require('readline');
const net = require('net');

const SOCK = process.env.BAREAGENT_BRIDGE_SOCK;
const CALL_TIMEOUT_MS = Number(process.env.BAREAGENT_BRIDGE_TIMEOUT_MS) || 120000;

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const errResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * One request/response over the unix socket.
 *
 * A FRESH connection per call is deliberate: a pooled socket opened while the parent was alive
 * hides a parent that died later, turning "the bridge is gone" into a silent hang. Connecting per
 * call makes a dead parent surface immediately, as an error result.
 *
 * @param {object} payload
 * @returns {Promise<any>} always resolves — never rejects, so no failure can escape as a crash.
 */
function bridge(payload) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    if (!SOCK) return done({ error: 'bridge not configured' });

    const sock = net.createConnection(SOCK);
    let buf = '';

    // A hung parent handler must not hang the CLI session. Bounded, always.
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch (_) { /* already gone */ }
      done({ error: `bridge timeout after ${CALL_TIMEOUT_MS}ms` });
    }, CALL_TIMEOUT_MS);

    const finish = (v) => {
      clearTimeout(timer);
      try { sock.end(); } catch (_) { /* already gone */ }
      done(v);
    };

    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // frame incomplete — wait for the rest
      try { finish(JSON.parse(buf.slice(0, nl))); }
      catch (err) { finish({ error: `bridge sent malformed JSON: ${/** @type {Error} */ (err).message}` }); }
    });
    sock.on('error', (err) => finish({ error: `bridge unreachable: ${/** @type {any} */ (err).code || /** @type {Error} */ (err).message}` }));
    sock.on('close', () => finish({ error: 'bridge closed before responding' }));
  });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; } // not JSON — not ours to answer
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'bareagent', version: '1' },
    } });
  }

  if (method === 'tools/list') {
    // The PARENT owns the manifest — a tool definition is never duplicated here.
    const res = await bridge({ op: 'list' });
    return send({ jsonrpc: '2.0', id, result: { tools: (res && res.tools) || [] } });
  }

  if (method === 'tools/call') {
    const res = await bridge({ op: 'call', name: params && params.name, args: (params && params.arguments) || {} });
    if (res && res.error) return send({ jsonrpc: '2.0', id, result: errResult(`TOOL BRIDGE ERROR: ${res.error}`) });
    if (res && res.isError) return send({ jsonrpc: '2.0', id, result: errResult(String(res.text)) });
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String((res && res.text) ?? '') }] } });
  }

  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});
