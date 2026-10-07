const { LockAlreadyHeldError, MigronautError } = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { ATTRIBUTES } = require('../utils/telemetry.js');

/**
 * The record one run under the lock leaves behind: its `run:start` /
 * `run:end` and lock events, its run metrics, the end of its span, and the
 * closing "Done" line. Kept apart from MigratorKit#withLock, which is left
 * with what is its own — reentrancy, the abort wiring, and the lock.
 *
 * Built from the kit's own capabilities: `emit` (runId stamped, listeners
 * contained), `telemetry` (a no-op without one), the resolved `logger` and
 * `fields`. All of them are guarded, so nothing recorded here can fail a run.
 * The span itself is opened by the kit — the run span is one of its two wrap
 * sites — and handed over with {@link RunRecorder#spanOpened}.
 */
class RunRecorder {
  #info;
  #runId;
  /** The queue job the run works for — `{ jobId?, groupId? }` — for its span */
  #job;
  #telemetry;
  #emit;
  #logger;
  #fields;
  #startedAt;
  /** What the lock reported when it was acquired — the run span's lock attributes */
  #acquired;
  /** The first reason the lock was lost */
  #lostReason;
  /** Set once the lock is held and the run span is open */
  #span;

  constructor({ info, runId, job = {}, telemetry, emit, logger, fields }) {
    this.#info = info;
    this.#runId = runId;
    this.#job = job;
    this.#telemetry = telemetry;
    this.#emit = emit;
    this.#logger = logger;
    this.#fields = fields;
  }

  start() {
    this.#startedAt = Date.now();
    this.#emit('run:start', { ...this.#info });
  }

  lockAcquired(extra) {
    this.#acquired = extra;
    if (typeof extra?.acquireMs === 'number') this.#telemetry.lockAcquired(extra.acquireMs);
    this.#emit('lock:acquired', { owner: this.#runId, ...extra });
  }

  lockReleased(extra) {
    this.#emit('lock:released', { owner: this.#runId, ...extra });
  }

  lockLost(reason) {
    // The heartbeat and the TTL deadline can each report the same loss: the
    // first reason is the cause, and it is one lost lock.
    if (this.#lostReason === undefined) {
      this.#lostReason = reason;
      this.#telemetry.lockLost();
    }
    this.#emit('lock:lost', { owner: this.#runId, reason });
  }

  /** The run span's attributes — complete once the lock is held */
  spanAttributes() {
    return {
      [ATTRIBUTES.RUN_ID]: this.#runId,
      [ATTRIBUTES.RUN_COMMAND]: this.#info.command,
      [ATTRIBUTES.RUN_DIRECTION]: this.#info.direction,
      [ATTRIBUTES.JOB_ID]: this.#job.jobId,
      [ATTRIBUTES.JOB_GROUP_ID]: this.#job.groupId,
      [ATTRIBUTES.LOCK_ACQUIRE_MS]: this.#acquired?.acquireMs,
      [ATTRIBUTES.LOCK_SKIPPED]: this.#acquired?.skipped,
    };
  }

  spanOpened(span) {
    this.#span = span;
  }

  /** Close the record: `result` on success, `failure` (what the run threw) otherwise */
  finish(result, failure) {
    // Result counts, so a metrics subscriber gets "3 applied in 812ms"
    // without reconstructing it from per-migration events. On the failure
    // path the partial rows live on the error's context — exactly the case
    // where "how far did it get?" is the question, so they count too.
    const rows = Array.isArray(result)
      ? result
      : failure instanceof MigronautError && Array.isArray(failure.context?.results)
        ? failure.context.results
        : null;
    const { summary, skipped } = countRows(rows);
    const durationMs = Date.now() - this.#startedAt;
    const telemetry = this.#telemetry;
    if (this.#span) {
      this.#span.finish(
        {
          [ATTRIBUTES.RUN_APPLIED]: summary.applied,
          [ATTRIBUTES.RUN_REVERTED]: summary.reverted,
          [ATTRIBUTES.RUN_SKIPPED]: skipped,
          [ATTRIBUTES.RUN_TOTAL]: summary.total,
          [ATTRIBUTES.LOCK_LOST_REASON]: this.#lostReason,
        },
        failure,
      );
      telemetry.runEnded({ ...this.#info, durationMs, error: failure });
    } else if (failure instanceof LockAlreadyHeldError) {
      // Never held the lock, so there is no run to time — only a refusal to
      // count. Any other failure this early (an unreachable database) is the
      // caller's to report; it is not contention.
      telemetry.lockRefused();
    }
    this.#emit('run:end', {
      ...this.#info,
      success: failure === undefined,
      durationMs,
      ...summary,
      // A raw Error here would hand subscribers an unredacted driver message
      // (which can echo the credentialed URI) — errorText is the same
      // chokepoint every log line and result row already goes through.
      ...(failure ? { error: errorText(failure) } : {}),
    });
    // One human rollup after the per-migration lines: total wall-clock time
    // (lock wait and hooks included) is otherwise unobtainable from the
    // output — per-file durations exclude all overhead. Success path only;
    // a failure already ends with its own error line.
    if (failure === undefined && (summary.applied || summary.reverted)) {
      const parts = [];
      if (summary.applied) parts.push(`${summary.applied} applied`);
      if (summary.reverted) parts.push(`${summary.reverted} reverted`);
      this.#logger.info(
        `✔ Done     ${parts.join(', ')} in ${durationMs}ms`,
        this.#fields({ ...this.#info, ...summary, durationMs }),
      );
    }
  }
}

/**
 * `{ summary: { applied, reverted, total }, skipped }` of a run's rows, in one
 * pass — `summary` is empty when the run produced no rows (a converge, a
 * failure before the first migration).
 */
function countRows(rows) {
  if (!rows) return { summary: {}, skipped: undefined };
  let applied = 0;
  let reverted = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.status === 'applied') applied += 1;
    else if (row.status === 'reverted') reverted += 1;
    else if (row.status === 'skipped') skipped += 1;
  }
  return { summary: { applied, reverted, total: rows.length }, skipped };
}

module.exports = { RunRecorder };
