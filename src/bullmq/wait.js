const { addAbortListener } = require('node:events');

const { ConfigInvalidError, QueueJobFailedError, RunAbortedError } = require('../errors/index.js');
const { MAX_TIMER_MS } = require('../utils/concurrency.js');
const { formatError } = require('../utils/error.js');
const { redactOutbound } = require('../utils/redact.js');

/** Rejects a budgeted await that outlived the deadline — told apart from every other failure */
const DEADLINE = Symbol('wait deadline');

/** Rejects a budgeted await that the caller's signal stopped */
const ABORTED = Symbol('wait aborted');

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
 * One budget for everything a wait awaits — connecting QueueEvents and
 * reading a job included: with a Redis that is down, those are the awaits
 * that would otherwise hang. `race(promise)` settles as the promise does, or
 * rejects with DEADLINE or ABORTED, whichever comes first.
 */
const createBudget = (timeoutMs, signal) => {
  const deadlineMs = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
  let stopping = null;
  const aborted =
    signal === undefined
      ? null
      : new Promise((_resolve, reject) => {
          stopping = addAbortListener(signal, () => reject(ABORTED));
        });
  // Raced on every await, never awaited alone: a stop between two awaits must
  // not surface as an unhandled rejection.
  aborted?.catch(() => undefined);
  const race = (promise) => {
    if (deadlineMs === undefined && aborted === null) return promise;
    let timer = null;
    const racers = [promise];
    if (aborted !== null) racers.push(aborted);
    if (deadlineMs !== undefined) {
      const expired = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(DEADLINE), Math.max(0, deadlineMs - Date.now()));
      });
      racers.push(expired);
    }
    return Promise.race(racers).finally(() => clearTimeout(timer));
  };
  return {
    deadline: deadlineMs,
    race,
    isPastDeadline: () => deadlineMs !== undefined && Date.now() >= deadlineMs,
    dispose: () => stopping?.[Symbol.dispose](),
  };
};

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
const waitForGroup = async (options) => {
  const { queue, queueEvents, groupId, direction, batch, jobs, converge, timeoutMs, signal } =
    options;

  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new ConfigInvalidError('signal must be an AbortSignal', {
      context: { signal: typeof signal },
    });
  }
  const isBadTimeout =
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS);
  if (isBadTimeout) {
    throw new ConfigInvalidError(`timeoutMs must be a positive number, at most ${MAX_TIMER_MS}`, {
      context: { timeoutMs },
    });
  }
  const results = [];
  // Nothing was enqueued: nothing to wait for, and no reason to need QueueEvents.
  if (jobs.length === 0 && !converge) return { groupId, direction, batch, results };
  if (!queueEvents) {
    throw new ConfigInvalidError(
      'wait() needs QueueEvents — pass bullmq.QueueEvents to createMigrationQueue, ' +
        'or a queueEvents instance to wait()',
      { context: { groupId } },
    );
  }

  const budget = createBudget(timeoutMs, signal);
  const budgeted = budget.race;
  const { deadline, isPastDeadline } = budget;
  // Stopped by the caller: what finished before it goes with the error.
  const stopped = () => {
    return new RunAbortedError('Group wait aborted', {
      ...(signal.reason !== undefined ? { cause: signal.reason } : {}),
      context: { reason: formatError(signal.reason ?? 'aborted'), groupId, finished: [...results] },
    });
  };

  /**
   * The typed code a failed job reported in its progress — what a caller
   * branches on (ALX_ERR_MIGRATION_BLOCKED, ALX_ERR_CHECKSUM_MISMATCH, …) instead of parsing
   * `failedReason`. Best-effort: the job may be gone, or Redis unreachable.
   */
  const failureCode = async (id) => {
    try {
      const code = (await budgeted(queue.getJob(id)))?.progress?.code;
      return typeof code === 'string' && code.length <= 64 ? code : undefined;
    } catch {
      return undefined;
    }
  };

  /** Wait for one job; `message` and `fields` say which one in a failure */
  const finish = async (id, message, fields) => {
    const fail = (failedReason, timedOut, code, cause) => {
      return new QueueJobFailedError(message, {
        ...(cause !== undefined ? { cause } : {}),
        context: {
          groupId,
          jobId: id,
          ...fields,
          failedReason,
          timedOut,
          ...(code !== undefined ? { code } : {}),
          results: [...results],
        },
      });
    };

    const outOfTime = () => fail(`wait timed out after ${timeoutMs}ms`, true);
    try {
      await budgeted(queueEvents.waitUntilReady?.());
      const job = await budgeted(queue.getJob(id));
      if (!job) throw fail('job not found — it was removed before wait() could read it', false);
      if (isPastDeadline()) throw outOfTime();
      return await budgeted(
        job.waitUntilFinished(
          queueEvents,
          deadline === undefined ? undefined : deadline - Date.now() + LISTENER_GRACE_MS,
        ),
      );
    } catch (error) {
      if (error instanceof QueueJobFailedError) throw error;
      if (error === ABORTED) throw stopped();
      // Decided by the clock, not by how BullMQ happens to word its timeout.
      if (error === DEADLINE || isPastDeadline()) throw outOfTime();
      throw fail(redactOutbound(formatError(error)), false, await failureCode(id), error);
    }
  };

  try {
    for (const { id, migration } of jobs) {
      const fields = { migration, direction };
      results.push(await finish(id, `Migration job failed: ${migration}`, fields));
    }
    if (!converge) return { groupId, direction, batch, results };
    const converged = await finish(converge.id, 'Converge job failed', { kind: 'converge' });
    return { groupId, direction, batch, results, converge: converged };
  } finally {
    budget.dispose();
  }
};

module.exports = { waitForGroup };
