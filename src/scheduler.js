'use strict';

/**
 * Time-triggered agent turns. The only way the agent acts without being messaged.
 *
 * Interface:
 *   add(job)        → jobId
 *   remove(jobId)   → void
 *   list()          → [jobs]
 *   start(handler)  → begin tick loop (handler receives due jobs)
 *   stop()          → stop tick loop
 *
 * Job shape:
 *   { id, type: 'once'|'recurring', schedule, action, status, nextRun, createdAt }
 *
 * Schedule formats:
 *   Cron: '0 7 * * 1-5' (requires optional cron-parser dep)
 *   Relative: '2h', '30m', 'tomorrow 9am' (vanilla Date math)
 *
 * Persistence:
 *   Default: JSON file (jobs.json)
 *   Override: any object with load/save methods
 *
 * ~80 lines target.
 */
class Scheduler {
  constructor(options = {}) {
    // TODO: POC 6
    throw new Error('Not implemented — see POC 6');
  }

  add(job) {
    throw new Error('Not implemented');
  }

  remove(jobId) {
    throw new Error('Not implemented');
  }

  list() {
    throw new Error('Not implemented');
  }

  start(handler) {
    throw new Error('Not implemented');
  }

  stop() {
    throw new Error('Not implemented');
  }
}

module.exports = { Scheduler };
