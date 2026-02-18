'use strict';

/**
 * JSONL transport: one JSON object per line to a writable stream.
 * Default: process.stdout. Pipe-friendly, parseable by any language.
 *
 * Debug output goes to stderr (never pollutes stdout).
 */
class JsonlTransport {
  constructor(options = {}) {
    this._output = options.output || process.stdout;
  }

  write(event) {
    this._output.write(JSON.stringify(event) + '\n');
  }
}

module.exports = { JsonlTransport };
