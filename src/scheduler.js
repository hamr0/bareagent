'use strict';

const { readFileSync, writeFileSync, existsSync } = require('node:fs');

/**
 * Time-triggered agent turns. The only way the agent acts without being messaged.
 *
 * Interface:
 *   add(job)        → jobId
 *   remove(jobId)   → void
 *   list()          → [jobs]
 *   start(handler)  → begin tick loop (handler receives due jobs)
 *   stop()          → stop tick loop
 */
class Scheduler {
  constructor(options = {}) {
    this._file = options.file || null;
    this._interval = options.interval || 60000;
    this.onError = options.onError || null;
    this._jobs = this._file && existsSync(this._file)
      ? JSON.parse(readFileSync(this._file, 'utf8'))
      : [];
    this._timer = null;
    this._nextId = this._jobs.length
      ? this._jobs.reduce((max, j) => Math.max(max, j.id), 0) + 1
      : 1;
  }

  _save() {
    if (this._file) writeFileSync(this._file, JSON.stringify(this._jobs, null, 2));
  }

  add(job) {
    const id = this._nextId++;
    const nextRun = this._parseSchedule(job.schedule);
    this._jobs.push({
      id,
      type: job.type || 'once',
      schedule: job.schedule,
      action: job.action,
      status: 'active',
      nextRun: nextRun.toISOString(),
      createdAt: new Date().toISOString(),
    });
    this._save();
    return id;
  }

  remove(jobId) {
    this._jobs = this._jobs.filter(j => j.id !== jobId);
    this._save();
  }

  list() {
    return this._jobs.map(j => ({ ...j }));
  }

  /**
   * Begin the tick loop. Calls `handler(job)` for each due job every tick interval.
   *
   * - `handler` is called with the full job object: `{ id, type, schedule, action, status, nextRun }`.
   * - Jobs that are still running (handler hasn't resolved) are skipped on subsequent ticks
   *   via the internal `_running` Set — this prevents overlapping executions of the same job.
   * - Within a single tick, due jobs are executed sequentially (awaited one at a time).
   * - If a handler throws, the error is passed to `onError(err, job)` if configured.
   *   The tick loop continues to the next job — handler errors never crash the scheduler.
   *
   * @param {(job: object) => Promise<void>} handler - Async function called for each due job.
   */
  start(handler) {
    if (this._timer) return;
    this._running = new Set();
    const tick = async () => {
      const now = new Date();
      for (const job of this._jobs) {
        if (job.status !== 'active') continue;
        if (this._running.has(job.id)) continue;
        if (new Date(job.nextRun) > now) continue;
        this._running.add(job.id);
        try {
          await handler(job);
        } catch (err) {
          try { this.onError?.(err, job); } catch { /* swallow onError throws */ }
        } finally {
          this._running.delete(job.id);
          if (job.type === 'once') {
            job.status = 'done';
          } else {
            job.nextRun = this._parseSchedule(job.schedule).toISOString();
          }
          this._save();
        }
      }
    };
    tick();
    this._timer = setInterval(tick, this._interval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * @param {string} schedule - Relative ('5s','30m','2h','1d') or cron expression.
   * @returns {Date} The next run time.
   * @throws {Error} `[Scheduler] Cannot parse schedule` — when format is not recognized.
   * @private
   */
  _parseSchedule(schedule) {
    // Relative: '5s', '30m', '2h', '1d'
    const rel = schedule.match(/^(\d+)(s|m|h|d)$/);
    if (rel) {
      const [, n, unit] = rel;
      const ms = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
      return new Date(Date.now() + Number(n) * ms);
    }
    // Cron: try cron-parser
    try {
      const { parseExpression } = require('cron-parser');
      return parseExpression(schedule).next().toDate();
    } catch {
      throw new Error(`[Scheduler] Cannot parse schedule: "${schedule}". Use relative (5s/30m/2h/1d) or cron expression.`);
    }
  }
}

module.exports = { Scheduler };
