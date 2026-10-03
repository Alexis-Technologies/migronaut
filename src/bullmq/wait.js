const { ConfigInvalidError, QueueJobFailedError } = require('../errors/index.js');
const { redactOutbound } = require('../utils/redact.js');

/** Rejects a budgeted await that outlived the deadline — told apart from every other failure */
const DEADLINE = Symbol('wait deadline');

/**
 * How much longer than the remaining budget BullMQ's own `waitUntilFinished`
 * timer is given. That timer is only there to take its listeners off
 * QueueEvents; whether the wait timed out is this module's clock to say.
 * Given the same remaining time, BullMQ's timer can fire first — while
 * `Date.now()` is still a millisecond short of the deadline — and a timeout
 * would be reported as an ordinary job failure.
 */
const LISTENER_GRACE_MS = 1000;

/**
 * Wait for every job of an enqueue group, in group order — and for the
 * group's converge job last, when it has one — and resolve
 * `{ groupId, direction, batch, results, converge? }`.
 *
 * Rejects with QueueJobFailedError at the first job that fails or outlives the
 * budget — the jobs after it cannot succeed anyway (they fail as blocked), and
 * `context.results` keeps what finished before it. `timeoutMs` is one budget
 * for the whole group, not per job.
 *
 * Finished jobs must still exist in the queue when this attaches: a
 * `removeOnComplete: true` queue gives it nothing to read.
 */
async function waitForGroup({
  queue,
  queueEvents,
  groupId,
  direction,
  batch,
  jobs,
  converge,
  timeoutMs,
}) {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new ConfigInvalidError('timeoutMs must be a positive finite number', { timeoutMs });
  }
  const results = [];
  // Nothing was enqueued: nothing to wait for, and no reason to need QueueEvents.
  if (jobs.length === 0 && !converge) return { groupId, direction, batch, results };
  if (!queueEvents) {
    throw new ConfigInvalidError(
      'wait() needs QueueEvents — pass bullmq.QueueEvents to createMigrationQueue, ' +
        'or a queueEvents instance to wait()',
      { groupId },
    );
  }

  // One budget for everything this call awaits — connecting QueueEvents and
  // reading a job included: with a Redis that is down, those are the awaits
  // that would otherwise hang.
  const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
  const budgeted = (promise) => {
    if (deadline === undefined) return promise;
    let timer;
    const expired = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(DEADLINE), Math.max(0, deadline - Date.now()));
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  };
  const timedOut = () => deadline !== undefined && Date.now() >= deadline;

  /**
   * The typed code a failed job reported in its progress — what a caller
   * branches on (MIGRATION_BLOCKED, CHECKSUM_MISMATCH, …) instead of parsing
   * `failedReason`. Best-effort: the job may be gone, or Redis unreachable.
   */
  async function failureCode(id) {
    try {
      const code = (await budgeted(queue.getJob(id)))?.progress?.code;
      return typeof code === 'string' && code.length <= 64 ? code : undefined;
    } catch {
      return undefined;
    }
  }

  /** Wait for one job; `message` and `fields` say which one in a failure */
  async function finish(id, message, fields) {
    const fail = (failedReason, timedOut, code) =>
      new QueueJobFailedError(message, {
        groupId,
        jobId: id,
        ...fields,
        failedReason,
        timedOut,
        ...(code !== undefined ? { code } : {}),
        results: [...results],
      });

    const outOfTime = () => fail(`wait timed out after ${timeoutMs}ms`, true);
    try {
      await budgeted(queueEvents.waitUntilReady?.());
      const job = await budgeted(queue.getJob(id));
      if (!job) throw fail('job not found — it was removed before wait() could read it', false);
      if (timedOut()) throw outOfTime();
      return await budgeted(
        job.waitUntilFinished(
          queueEvents,
          deadline === undefined ? undefined : deadline - Date.now() + LISTENER_GRACE_MS,
        ),
      );
    } catch (error) {
      if (error instanceof QueueJobFailedError) throw error;
      // Decided by the clock, not by how BullMQ happens to word its timeout.
      if (error === DEADLINE || timedOut()) throw outOfTime();
      const reason = redactOutbound(error instanceof Error ? error.message : String(error));
      throw fail(reason, false, await failureCode(id));
    }
  }

  for (const { id, migration } of jobs) {
    results.push(await finish(id, `Migration job failed: ${migration}`, { migration, direction }));
  }
  if (!converge) return { groupId, direction, batch, results };
  const converged = await finish(converge.id, 'Converge job failed', { kind: 'converge' });
  return { groupId, direction, batch, results, converge: converged };
}

module.exports = { waitForGroup };
