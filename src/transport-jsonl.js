'use strict';

/**
 * JSONL transport: one JSON object per line to stdout.
 * Pipe-friendly, parseable by any language.
 *
 * Used by Stream for cross-process communication.
 * Debug output goes to stderr (never pollutes stdout).
 *
 * ~30 lines target.
 */
class JsonlTransport {
  write(event) {
    process.stdout.write(JSON.stringify(event) + '\n');
  }
}

module.exports = { JsonlTransport };
