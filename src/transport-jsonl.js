'use strict';

/**
 * JSONL transport: one JSON object per line to a writable stream.
 * Default: process.stdout. Pipe-friendly, parseable by any language.
 *
 * Debug output goes to stderr (never pollutes stdout).
 */

/**
 * @typedef {object} JsonlTransportOptions
 * @property {NodeJS.WritableStream} [output] - Writable stream to write JSONL lines to. Defaults to process.stdout.
 */

class JsonlTransport {
  /**
   * @param {JsonlTransportOptions} [options={}]
   */
  constructor(options = {}) {
    this._output = options.output || process.stdout;
  }

  /**
   * @param {*} event - Event object to serialize as one JSON line.
   * @returns {void}
   */
  write(event) {
    this._output.write(JSON.stringify(event) + '\n');
  }
}

module.exports = { JsonlTransport };
