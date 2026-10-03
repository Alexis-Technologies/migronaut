const { MigratorKit } = require('../core/migrator.js');
const { assertLockWaitOptions, withLockWait } = require('../core/lock-wait.js');
const {
  ConfigInvalidError,
  MigronautError,
  NotAppliedError,
  RunAbortedError,
} = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { redactDeep, redactUris } = require('../utils/redact.js');
const { JOB_NAMES, isPlainObject, parseJobData } = require('./jobs.js');
const { assertJobOptions, enqueueConverge, enqueueUp } = require('./producer.js');

/**
 * Failures a later attempt can get past without anything being fixed: the lock
 * was busy or lost, the database was unreachable, the run was stopped. Every
 * other MigronautError needs a change first — to the migration, the files or
 * the changelog — so retrying it only repeats the failure (and, in a FIFO
 * queue, reorders the line). Errors of unknown origin stay retryable: not
 * recognising a failure is no reason to rule a retry out.
 */
const RETRYABLE_CODES = Object.freeze([
  'LOCK_ALREADY_HELD',
  'LOCK_LOST',
  'LOCK_RELEASE_FAILED',
  'RUN_ABORTED',
  'CONNECTION_FAILED',
]);

function isRetryableError(error) {
  return !(error instanceof MigronautError) || RETRYABLE_CODES.includes(error.code);
}

/** What BullMQ checks (by name, not only by class) to fail a job without retrying it */
const UNRECOVERABLE_ERROR_NAME = 'UnrecoverableError';

/**
 * What BullMQ checks (by name) for a job the processor has moved back to the
 * wait list itself: neither failed nor completed, nothing more to record.
 */
const WAITING_ERROR_NAME = 'WaitingError';

/** The correlation ids of a job, for its error context and log lines */
function jobIds(ctx) {
  return {
    ...(ctx.job?.id !== undefined ? { jobId: String(ctx.job.id) } : {}),
    ...(ctx.data?.groupId !== undefined ? { groupId: ctx.data.groupId } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
  };
}

/** A job in a few words, for log lines: `up 20260101-x.js (1/3)`, `converge`, `sync` */
function describeJob(data) {
  if (data.kind !== 'migration') return data.kind;
  return `${data.direction} ${data.migration} (${data.index + 1}/${data.total})`;
}

/** The structured fields of a job's log lines */
function jobFields(data) {
  if (data.kind !== 'migration') return { kind: data.kind };
  return {
    migration: data.migration,
    direction: data.direction,
    index: data.index,
    total: data.total,
  };
}

/**
 * Stamp the job's ids onto a typed error before it leaves for the queue — the
 * one place a failed job's run id survives, since a failed job has no return
 * value. Copy-on-write: the error may be a shared abort reason.
 */
function attachJobIds(error, ctx) {
  if (!(error instanceof MigronautError)) return;
  const ids = jobIds(ctx);
  if (Object.keys(ids).length > 0) error.context = { ...error.context, ...ids };
}

/**
 * Prepare an error for the queue. BullMQ stores its message (as the job's
 * `failedReason`) and stack, so both leave the process and must be redacted.
 * The message is also all a dashboard shows: a wrapper says WHICH migration
 * failed and keeps the WHY in `context.cause`, which the queue never sees —
 * so the cause is folded into the message, as the changelog's failure trace
 * already does.
 */
function prepareErrorForQueue(error) {
  if (!(error instanceof Error)) return;
  const cause = error instanceof MigronautError ? error.context?.cause : undefined;
  try {
    const message = redactUris(error.message);
    error.message =
      typeof cause === 'string' && cause.length > 0 && !message.includes(cause)
        ? `${message} — ${redactUris(cause)}`
        : message;
    if (typeof error.stack === 'string') error.stack = redactUris(error.stack);
  } catch {
    // A frozen error cannot be rewritten; its message was written by us anyway.
  }
}

/**
 * Validate the processor's options and return the resolved lock-wait budget.
 * Pure — nothing is constructed — so a caller can reject bad input before it
 * opens any connection of its own.
 */
function resolveProcessorOptions(options) {
  if (!isPlainObject(options)) {
    throw new ConfigInvalidError('createMigrationProcessor options must be an object');
  }
  const { kit, config, lockWait = {}, jobOptions, ordered = true } = options;
  if (kit !== undefined && config !== undefined) {
    throw new ConfigInvalidError('Pass either `kit` or `config`, not both');
  }
  if (kit !== undefined && typeof kit?.up !== 'function') {
    throw new ConfigInvalidError('kit must be a MigratorKit instance');
  }
  if (typeof ordered !== 'boolean') {
    throw new ConfigInvalidError('ordered must be a boolean', { ordered });
  }
  if (!isPlainObject(lockWait)) {
    throw new ConfigInvalidError('lockWait must be an object', { lockWait: typeof lockWait });
  }
  // Unlike runMigrations, waiting is the default: nothing is blocked on this
  // job, and the budget only burns while the lock's holder is stalled.
  const waitOptions = { onLockHeld: 'wait', ...lockWait };
  if (waitOptions.onLockHeld !== 'wait' && waitOptions.onLockHeld !== 'throw') {
    throw new ConfigInvalidError("lockWait.onLockHeld must be 'wait' or 'throw'", {
      onLockHeld: waitOptions.onLockHeld,
    });
  }
  assertLockWaitOptions(waitOptions);
  assertJobOptions(jobOptions);
  return { waitOptions, defaultOrdered: ordered };
}

/**
 * Build the function a BullMQ Worker runs for each migration job.
 *
 * One long-lived MigratorKit serves every job, and jobs are run one at a time
 * even when the Worker is configured for more: a kit rejects overlapping runs,
 * and migrations are sequential by nature. Across processes the MongoDB lock
 * does that job, and the `ordered` guard keeps the sequence.
 *
 * Declared with exactly three parameters: BullMQ passes the cancellation
 * signal only to processors whose `length` is at least 3.
 */
function createMigrationProcessor(options = {}) {
  const { waitOptions, defaultOrdered } = resolveProcessorOptions(options);
  const { kit: injectedKit, config, kitOptions, queue, jobOptions } = options;

  const ownsKit = injectedKit === undefined;
  const kit = injectedKit ?? new MigratorKit(config ?? {}, kitOptions);
  const shutdownController = new AbortController();
  /** Serializes jobs in this process — see the factory's doc comment */
  let chain = Promise.resolve();
  /** The job being processed, for the kit's event listeners */
  let current;

  /**
   * Fire-and-forget write to the job (a log row, a progress update). Never
   * awaited on the run path — Redis must not pace a migration — and never
   * allowed to fail the job; `flush` drains what is still in flight before the
   * job settles, so nothing lands on a job BullMQ already finished.
   */
  function write(ctx, action) {
    let pending;
    try {
      pending = Promise.resolve(action(ctx.job)).catch(() => undefined);
    } catch {
      return;
    }
    ctx.writes.add(pending);
    pending.finally(() => ctx.writes.delete(pending));
  }
  const log = (ctx, row) => write(ctx, (job) => job.log?.(redactUris(row)));
  const progress = (ctx, phase, extra) =>
    write(ctx, (job) =>
      job.updateProgress?.({
        phase,
        ...(ctx.data.kind === 'migration'
          ? {
              migration: ctx.data.migration,
              direction: ctx.data.direction,
              groupId: ctx.data.groupId,
              index: ctx.data.index,
              total: ctx.data.total,
            }
          : { kind: ctx.data.kind }),
        ...extra,
      }),
    );
  const flush = (ctx) => Promise.allSettled([...ctx.writes]);

  // Subscribed once, for the processor's lifetime: the kit emits per run, and
  // `current` says which job that run belongs to.
  const listeners = {
    'run:start': (event) => {
      if (current) current.runId = event.runId;
    },
    'lock:acquired': (event) => {
      if (current && !event.skipped) log(current, `🔒 Lock acquired (${event.acquireMs ?? 0}ms)`);
    },
    'lock:lost': (event) => {
      if (current) log(current, `⚠ Lock lost: ${event.reason ?? 'unknown reason'}`);
    },
    'migration:start': (event) => {
      if (!current) return;
      // From here on the job is doing its work: a shutdown lets it finish
      // rather than putting it back in the queue.
      current.started = true;
      progress(current, 'running');
      log(current, `▶ ${event.direction} ${event.migration}`);
    },
    'migration:success': (event) => {
      if (!current) return;
      const label = event.direction === 'up' ? '✔ Applied' : '↩ Reverted';
      log(current, `${label} ${event.migration} [${event.durationMs ?? 0}ms]`);
    },
    'migration:skipped': (event) => {
      if (current) log(current, `⏭ Skipped ${event.migration} (${event.reason ?? 'skipped'})`);
    },
    'converge:start': () => {
      if (!current) return;
      current.started = true;
      progress(current, 'running');
    },
    'converge:action': (event) => {
      if (!current) return;
      const target = event.target === 'index' ? `index ${event.name}` : event.target;
      const what = `${event.action} ${target} on ${event.collection}`;
      if (event.status === 'started') log(current, `… ${what}`);
      else if (event.status === 'applied') log(current, `✔ ${what} [${event.durationMs ?? 0}ms]`);
      else log(current, `✖ ${what}: ${event.error ?? 'failed'}`);
    },
    'converge:end': (event) => {
      if (current && event.success) log(current, `✔ Converged ${event.changed} change(s)`);
    },
  };
  for (const [event, listener] of Object.entries(listeners)) kit.on(event, listener);

  function resultOf(ctx, rows, waitedMs) {
    const { data } = ctx;
    const row = rows[0];
    return {
      migration: data.migration,
      direction: data.direction,
      status: row?.status ?? 'skipped',
      ...(row?.duration !== undefined ? { duration: row.duration } : {}),
      ...(row?.batch !== undefined ? { batch: row.batch } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(row?.reason ? { reason: row.reason } : {}),
      lockWaitMs: waitedMs,
    };
  }

  async function runMigrationJob(ctx, signal) {
    const { data } = ctx;
    const ordered = data.ordered ?? defaultOrdered;
    const attempt = () =>
      data.direction === JOB_NAMES.UP
        ? kit.up(data.migration, {
            batch: data.batch,
            ...(ordered ? { ordered: true } : {}),
            ...(data.force ? { force: true } : {}),
          })
        : kit.down(data.migration, ordered ? { ordered: true } : {});

    try {
      const { result, waitedMs } = await waitForLock(ctx, attempt, signal);
      return resultOf(ctx, result, waitedMs);
    } catch (error) {
      // A duplicate rollback job: the first one already reverted it. Same
      // outcome as a duplicate `up` job, which the kit reports as skipped.
      if (data.direction === JOB_NAMES.DOWN && error instanceof NotAppliedError) {
        return {
          migration: data.migration,
          direction: data.direction,
          status: 'skipped',
          reason: 'Not applied',
          lockWaitMs: 0,
        };
      }
      throw error;
    }
  }

  /** The lock-wait loop every run-kind job shares */
  function waitForLock(ctx, attempt, signal) {
    return withLockWait(attempt, {
      ...waitOptions,
      logger: kit.logger,
      signal,
      onWait: ({ attempts, waitedMs: soFar }) => {
        if (attempts === 1) log(ctx, 'Migration lock held by another process — waiting…');
        progress(ctx, 'lock-wait', { attempts, waitedMs: soFar });
      },
    });
  }

  async function runConvergeJob(ctx, signal) {
    const { data } = ctx;
    // Ordered by default: the tail of a deploy must not converge to a schema
    // its own migrations have not reached yet — and the check is the kit's,
    // under the lock, so a peer still applying the last migration is waited
    // out rather than raced.
    const ordered = data.ordered ?? defaultOrdered;
    const { result, waitedMs } = await waitForLock(
      ctx,
      () => kit.converge(ordered ? { ordered: true } : {}),
      signal,
    );
    return redactDeep({
      kind: 'converge',
      ...(data.groupId !== undefined ? { groupId: data.groupId } : {}),
      changed: result.changed,
      inSync: result.inSync,
      collections: result.collections,
      ...(result.unstable ? { unstable: result.unstable } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      lockWaitMs: waitedMs,
    });
  }

  async function runSyncJob(ctx) {
    if (!queue) {
      throw new ConfigInvalidError(
        'A sync job needs the queue to enqueue into — pass `queue` to createMigrationProcessor',
      );
    }
    const { to } = ctx.data;
    // The cheap probe first: a scheduler ticks far more often than there is
    // anything to do, and planning proper re-reads the whole directory.
    const pending = await kit.list('pending');
    if (pending.length === 0) {
      const result = {
        kind: 'sync',
        groupId: null,
        batch: null,
        enqueued: 0,
        upToDate: true,
        migrations: [],
      };
      // With `convergeAfterUp`, a tick that finds no migration still checks
      // the declared collections — a deploy that only changed a definition
      // converges on the next tick. A dry run first, so an idle tick takes no
      // lock; a job only when something differs.
      if (
        to === undefined &&
        typeof kit.convergesAfterUp === 'function' &&
        (await kit.convergesAfterUp()) &&
        !(await kit.converge({ dryRun: true })).inSync
      ) {
        const handle = await enqueueConverge(queue, kit, jobOptions ? { jobOptions } : {});
        result.converge = { jobId: handle.jobId, deduplicated: handle.deduplicated };
      }
      return result;
    }
    const group = await enqueueUp(queue, kit, {
      ...(to !== undefined ? { to } : {}),
      ...(jobOptions ? { jobOptions } : {}),
    });
    const migrations = [];
    for (const job of group.jobs) migrations.push(job.migration);
    return {
      kind: 'sync',
      groupId: group.upToDate ? null : group.groupId,
      batch: group.batch,
      enqueued: group.jobs.length,
      upToDate: group.upToDate,
      migrations,
      ...(group.converge
        ? { converge: { jobId: group.converge.id, deduplicated: group.converge.deduplicated } }
        : {}),
    };
  }

  /**
   * Put a job that a shutdown stopped before it started its work back at the
   * head of the queue, and return the error that tells BullMQ so — or
   * undefined when the job is to fail as usual.
   *
   * Failing it would be for good (one attempt), and every job of its group
   * behind it would then fail as blocked: a rolling deploy would end each
   * enqueue it interrupts. Moved back, the job keeps its place in line and the
   * next worker runs it. A job whose migration (or converge) had begun is
   * never put back — it ran, and its outcome is what it is.
   */
  async function requeueOnShutdown(ctx, error, token) {
    if (!(error instanceof RunAbortedError) || !shutdownController.signal.aborted) return undefined;
    if (ctx.started || typeof ctx.job?.moveToWait !== 'function' || typeof token !== 'string') {
      return undefined;
    }
    const reason = errorText(shutdownController.signal.reason ?? 'shutting down');
    log(ctx, `↩ Returned to the queue: ${reason}`);
    await flush(ctx);
    try {
      await ctx.job.moveToWait(token);
    } catch {
      // The lock is gone (a stall already moved it) or Redis is: fail as usual.
      return undefined;
    }
    kit.logger.debug(`↩ Returned job ${ctx.job.id} to the queue: ${reason}`, {
      ...jobIds(ctx),
      reason,
    });
    const requeued = new RunAbortedError(`Returned to the queue: ${reason}`, {
      reason,
      requeued: true,
      ...jobIds(ctx),
    });
    requeued.name = WAITING_ERROR_NAME;
    return requeued;
  }

  async function handle(job, token, signal) {
    const ctx = { job, data: undefined, runId: undefined, started: false, writes: new Set() };
    const startedAt = Date.now();
    const signals = [shutdownController.signal];
    if (signal) signals.push(signal);
    const abort = AbortSignal.any(signals);
    // Reaches a run that is setting up or between migrations; one already
    // executing a migration body finishes it — interrupting a body mid-write
    // is what leaves a database half-migrated.
    const onAbort = () => kit.stop(errorText(abort.reason ?? 'Queue job cancelled'));
    try {
      // Validated before anything connects: a payload that fails the contract
      // must not reach the kit, let alone the filesystem.
      ctx.data = parseJobData(job);
      current = ctx;
      // A job fetched while this process shuts down goes straight back.
      if (shutdownController.signal.aborted) throw shutdownController.signal.reason;
      abort.addEventListener('abort', onAbort, { once: true });
      kit.logger.debug(`▶ Job ${job?.id} (${describeJob(ctx.data)})`, {
        ...jobIds(ctx),
        ...jobFields(ctx.data),
      });
      await kit.connect();
      let result;
      if (ctx.data.kind === 'sync') result = await runSyncJob(ctx);
      else if (ctx.data.kind === 'converge') result = await runConvergeJob(ctx, abort);
      else result = await runMigrationJob(ctx, abort);
      progress(ctx, 'completed', ctx.runId ? { runId: ctx.runId } : {});
      await flush(ctx);
      kit.logger.debug(`✔ Job ${job?.id} done`, {
        ...jobIds(ctx),
        ...jobFields(ctx.data),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const requeued = await requeueOnShutdown(ctx, error, token);
      if (requeued) throw requeued;
      // BullMQ only retries when the job was given more than one attempt — the
      // adapter's own jobs never are, so this matters for jobs enqueued some
      // other way. Renaming is how a library that never imports bullmq says
      // "do not retry"; the typed `code` and class are untouched.
      if (!isRetryableError(error) && (job?.opts?.attempts ?? 1) > 1) {
        error.name = UNRECOVERABLE_ERROR_NAME;
      }
      attachJobIds(error, ctx);
      prepareErrorForQueue(error);
      if (ctx.data) {
        progress(ctx, 'failed', {
          code: error instanceof MigronautError ? error.code : 'UNKNOWN',
          ...(ctx.runId ? { runId: ctx.runId } : {}),
        });
      }
      write(ctx, (target) =>
        target.log?.(`✖ ${errorText(error)}${ctx.runId ? ` [run ${ctx.runId}]` : ''}`),
      );
      await flush(ctx);
      throw error;
    } finally {
      abort.removeEventListener('abort', onAbort);
      current = undefined;
    }
  }

  // Three declared parameters, on purpose — see the factory's doc comment.
  async function processor(job, token, signal) {
    const run = chain.then(() => handle(job, token, signal));
    chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Stop taking the lock: a job waiting for it fails with RunAbortedError (a
   * retryable failure), and a run that has not started its migration is
   * stopped. Irreversible — meant for process shutdown.
   */
  processor.shutdown = (reason = 'Migration worker shutting down') => {
    if (!shutdownController.signal.aborted) {
      shutdownController.abort(new RunAbortedError(reason, { reason }));
    }
  };

  /** Shut down, let the job in flight settle, and disconnect a kit this processor created */
  processor.close = async () => {
    processor.shutdown();
    await chain;
    for (const [event, listener] of Object.entries(listeners)) kit.off(event, listener);
    if (ownsKit) await kit.disconnect();
  };

  Object.defineProperty(processor, 'kit', { value: kit, enumerable: true });
  return processor;
}

module.exports = {
  RETRYABLE_CODES,
  WAITING_ERROR_NAME,
  createMigrationProcessor,
  isRetryableError,
  resolveProcessorOptions,
};
