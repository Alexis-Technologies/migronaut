const { ConfigInvalidError, QueueJobFailedError } = require('../errors/index.js');
const { redactUris } = require('../utils/redact.js');

/** How BullMQ words a `waitUntilFinished` that ran out of time */
const TIMEOUT_MARKER = 'timed out before finishing';

/**
 * Wait for every job of an enqueue group, in group order, and resolve
 * `{ groupId, direction, batch, results }`.
 *
 * Rejects with QueueJobFailedError at the first job that fails or outlives the
 * budget — the jobs after it cannot succeed anyway (they fail as blocked), and
 * `context.results` keeps what finished before it. `timeoutMs` is one budget
 * for the whole group, not per job.
 *
 * Finished jobs must still exist in the queue when this attaches: a
 * `removeOnComplete: true` queue gives it nothing to read.
 */
async function waitForGroup({ queue, queueEvents, groupId, direction, batch, jobs, timeoutMs }) {
  if (!queueEvents) {
    throw new ConfigInvalidError(
      'wait() needs QueueEvents — pass bullmq.QueueEvents to createMigrationQueue, ' +
        'or a queueEvents instance to wait()',
      { groupId },
    );
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new ConfigInvalidError('timeoutMs must be a positive finite number', { timeoutMs });
  }

  const results = [];
  if (jobs.length === 0) return { groupId, direction, batch, results };

  await queueEvents.waitUntilReady?.();
  const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;

  for (const { id, migration } of jobs) {
    const fail = (failedReason, timedOut) =>
      new QueueJobFailedError(`Migration job failed: ${migration}`, {
        groupId,
        jobId: id,
        migration,
        direction,
        failedReason,
        timedOut,
        results: [...results],
      });

    const job = await queue.getJob(id);
    if (!job) throw fail('job not found — it was removed before wait() could read it', false);

    let remaining;
    if (deadline !== undefined) {
      remaining = deadline - Date.now();
      if (remaining <= 0) throw fail(`wait timed out after ${timeoutMs}ms`, true);
    }
    try {
      results.push(await job.waitUntilFinished(queueEvents, remaining));
    } catch (error) {
      const reason = redactUris(error instanceof Error ? error.message : String(error));
      throw fail(reason, reason.includes(TIMEOUT_MARKER));
    }
  }
  return { groupId, direction, batch, results };
}

module.exports = { waitForGroup };
