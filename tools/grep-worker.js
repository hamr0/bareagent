'use strict';

/**
 * Worker thread for shell_grep's matching phase. Runs the (potentially expensive) regex search
 * off the main thread so the parent can enforce a hard timeout via `worker.terminate()` — JS
 * regex backtracking is uninterruptible on its own thread, so isolation is the only sound bound
 * against catastrophic patterns that slip past the static guard. See tools/shell.js `grepPath`.
 */

const { workerData, parentPort } = require('node:worker_threads');
const { _grepCore } = require('./shell.js');

// parentPort is non-null inside a worker, but the type is nullable for the main-thread case.
if (!parentPort) throw new Error('grep-worker.js must be run as a worker thread');
const port = parentPort;

_grepCore(workerData).then(
  (result) => port.postMessage({ ok: true, result }),
  (err) => port.postMessage({ ok: false, error: err && err.message ? err.message : String(err) }),
);
