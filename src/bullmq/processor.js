const { MigratorKit, RECORD_LOCK_WAIT } = require('../core/migrator.js');
const { assertLockWaitOptions, withLockWait } = require('../core/lock-wait.js');
const {
  ConfigInvalidError,
  LockAlreadyHeldError,
  MigrationBlockedError,
  MigronautError,
  NotAppliedError,
  RunAbortedError,
} = require('../errors/index.js');
const { pickActor } = require('../utils/actor.js');
const { errorText } = require('../utils/error.js');
const { jobRefIssue } = require('../utils/job-ref.js');
const { redactDeep, redactOutbound } = require('../utils/redact.js');
const { JOB_NAMES, assertAllowed, isObjectLike, parseJobData, resolveAllow } = require('./jobs.js');
const {
  assertBackgroundJobOptions,
  assertJobOptions,
  enqueueBackground,
  enqueueConverge,
  enqueueUp,
} = require('./producer.js');

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

/**
 * What a job waits out instead of failing: a held lock — and a block by
 * migrations that have not failed. With more than one worker taking jobs
 * (global concurrency off or unsupported, several processors), the job for an
 * earlier migration can still be in flight on another worker when a later one
 * takes the lock; failing the later job would fail its whole group although
 * nothing went wrong. A blocker with a `'failed'` trace stopped the line for
 * real, and that job fails at once, as before.
 */
function isTransientForJob(error) {
  if (error instanceof LockAlreadyHeldError) return true;
  return (
    error instanceof MigrationBlockedError &&
    Array.isArray(error.context?.failed) &&
    error.context.failed.length === 0
  );
}

function isRetryableError(error) {
  return !(error instanceof MigronautError) || RETRYABLE_CODES.includes(error.code);
}

/** The least time between two `lock-wait` progress updates of one job */
const WAIT_PROGRESS_INTERVAL_MS = 2000;

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

/**
 * The job a run works for, as the kit's `job` option — `{ id, groupId? }`, or
 * undefined when the job has no id the kit would take (it then logs nothing
 * of the job; the run itself is unaffected).
 */
function jobRefOf(job, groupId) {
  if (job?.id === undefined || job.id === null) return undefined;
  const id = String(job.id);
  const ref = groupId !== undefined ? { id, groupId } : { id };
  if (jobRefIssue(ref) === null) return ref;
  return jobRefIssue({ id }) === null ? { id } : undefined;
}

/** The longest row a `migration:log` event becomes in a job's log */
const USERLAND_ROW_MAX = 1024;

/** BigInts have no JSON form of their own; a log row shows their digits */
const jsonValue = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);

/**
 * A `migration:log` event as a row of the job's log, next to the processor's
 * own lifecycle rows: `✎ <level: ><msg> <data as JSON>`, the attempt when a
 * transaction was retried, the partition of a background lane. Cut at
 * {@link USERLAND_ROW_MAX}; redacted on its way out like every row.
 */
function userlandRow(event) {
  const level = event.level === 'info' ? '' : `${event.level}: `;
  let data = '';
  if (event.data !== null && typeof event.data === 'object' && Object.keys(event.data).length > 0) {
    try {
      data = ` ${JSON.stringify(event.data, jsonValue)}`;
    } catch {
      data = ' [data not serializable]';
    }
  }
  const attempt = event.attempt > 1 ? ` (attempt ${event.attempt})` : '';
  const partition =
    event.kind === 'background' && event.partition ? ` [partition ${event.partition}]` : '';
  const row = `✎ ${level}${event.msg}${data}${attempt}${partition}`;
  return row.length > USERLAND_ROW_MAX ? `${row.slice(0, USERLAND_ROW_MAX - 1)}…` : row;
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
    const message = redactOutbound(error.message);
    error.message =
      typeof cause === 'string' && cause.length > 0 && !message.includes(cause)
        ? `${message} — ${redactOutbound(cause)}`
        : message;
    if (typeof error.stack === 'string') error.stack = redactOutbound(error.stack);
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
  if (!isObjectLike(options)) {
    throw new ConfigInvalidError('createMigrationProcessor options must be an object');
  }
  const { kit, config, lockWait = {}, jobOptions, ordered = true, allow, background } = options;
  if (kit !== undefined && config !== undefined) {
    throw new ConfigInvalidError('Pass either `kit` or `config`, not both');
  }
  if (kit !== undefined && typeof kit?.up !== 'function') {
    throw new ConfigInvalidError('kit must be a MigratorKit instance');
  }
  if (typeof ordered !== 'boolean') {
    throw new ConfigInvalidError('ordered must be a boolean', { ordered });
  }
  if (!isObjectLike(lockWait)) {
    throw new ConfigInvalidError('lockWait must be an object', { lockWait: typeof lockWait });
  }
  // Unlike runMigrations, waiting is the default: nothing is blocked on this
  // job, and the budget only burns while the lock's holder is stalled.
  const waitOptions = { onLockHeld: 'wait', ...lockWait };
  assertLockWaitOptions(waitOptions);
  assertJobOptions(jobOptions);
  if (background !== undefined) assertBackgroundLink(background);
  return { waitOptions, defaultOrdered: ordered, allow: resolveAllow(allow) };
}

/**
 * The background queue a migration processor hands what it registers to:
 * `{ queue, jobOptions?, stallMs? }`.
 */
function assertBackgroundLink(background) {
  if (!isObjectLike(background) || typeof background.queue?.addBulk !== 'function') {
    throw new ConfigInvalidError('background must be { queue } — the background queue');
  }
  for (const key of Object.keys(background)) {
    if (key !== 'queue' && key !== 'jobOptions' && key !== 'stallMs') {
      throw new ConfigInvalidError(`background.${key} is not an option here`, { key });
    }
  }
  assertBackgroundJobOptions(background.jobOptions);
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
  const { waitOptions, defaultOrdered, allow } = resolveProcessorOptions(options);
  const { kit: injectedKit, config, kitOptions, queue, jobOptions, background } = options;

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
  const log = (ctx, row) => write(ctx, (job) => job.log?.(redactOutbound(row)));
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
    'background:registered': (event) => {
      if (current) current.registered.push(event.migration);
    },
    'converge:start': () => {
      if (!current) return;
      current.started = true;
      progress(current, 'running');
    },
    'converge:action': (event) => {
      if (!current) return;
      const target =
        event.target === 'index'
          ? `index ${event.name}`
          : event.target === 'searchIndex'
            ? `search index ${event.name}`
            : event.target;
      const what = `${event.action} ${target} on ${event.collection}`;
      if (event.status === 'started') log(current, `… ${what}`);
      else if (event.status === 'applied') log(current, `✔ ${what} [${event.durationMs ?? 0}ms]`);
      else log(current, `✖ ${what}: ${event.error ?? 'failed'}`);
    },
    'converge:wait': (event) => {
      if (!current) return;
      if (event.status === 'started' || event.status === 'progress') {
        const waited = event.status === 'started' ? 0 : event.waitedMs;
        log(
          current,
          event.status === 'started'
            ? `… Waiting for ${event.searchIndexes} search index(es) to become queryable` +
                (event.lockReleased ? ' — the migration lock is released meanwhile' : '')
            : `… Still waiting for search indexes [${Math.round(waited / 1000)}s]`,
        );
        progress(current, 'search-wait', { searchIndexes: event.searchIndexes, waitedMs: waited });
      } else if (event.status === 'ready') {
        log(current, `✔ Search index(es) queryable [${event.waitedMs}ms]`);
      } else {
        log(current, `✖ Wait for search indexes ended: ${event.status} [${event.waitedMs}ms]`);
      }
    },
    'converge:end': (event) => {
      if (current && event.success) log(current, `✔ Converged ${event.changed} change(s)`);
    },
    // What the migration itself logged for its users. Matched by job, not by
    // `current` alone: a body that outlived its timeout may still log while
    // the next job runs, and its lines must not land in that job's log.
    'migration:log': (event) => {
      if (!current || current.sealed || event.kind !== 'migration') return;
      const ours = current.jobRef
        ? event.jobId === current.jobRef.id
        : current.runId !== undefined && event.runId === current.runId;
      if (ours) log(current, userlandRow(event));
    },
  };
  for (const [event, listener] of Object.entries(listeners)) kit.on(event, listener);

  /** The background queue options every enqueue from here shares */
  const backgroundOptions = () => ({
    ...(background.jobOptions !== undefined ? { jobOptions: background.jobOptions } : {}),
    ...(background.stallMs !== undefined ? { stallMs: background.stallMs } : {}),
  });

  /**
   * Hand what this job registered to the background queue. Never fails the
   * job — it is applied; a coordinator that could not be added now is added
   * by the next heal (a sync tick, a verify tick, a worker's start).
   */
  async function startBackground(ctx) {
    if (background === undefined || ctx.registered.length === 0) return undefined;
    const started = [];
    for (const migration of ctx.registered) {
      try {
        const { jobs } = await enqueueBackground(background.queue, kit, {
          migration,
          ...backgroundOptions(),
        });
        for (const job of jobs) started.push({ migration, jobId: job.id });
      } catch (error) {
        kit.logger.warn(
          `⚠ Could not enqueue background migration ${migration}: ${errorText(error)} — ` +
            'the next heal will',
          { ...jobIds(ctx), migration, error: errorText(error) },
        );
      }
    }
    for (const entry of started) log(ctx, `⧗ Background coordinator ${entry.jobId} enqueued`);
    return started;
  }

  /** Every background migration with work to do gets its coordinator — a sync tick's heal */
  async function healBackground() {
    if (background === undefined) return undefined;
    try {
      const { jobs } = await enqueueBackground(background.queue, kit, backgroundOptions());
      return jobs.length;
    } catch (error) {
      kit.logger.warn(`⚠ Background heal failed: ${errorText(error)}`, {
        error: errorText(error),
      });
      return 0;
    }
  }

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
    // The run's correlation names this job, so what the migration logs can be
    // joined to it (and its userland lines routed into its log).
    ctx.jobRef = jobRefOf(ctx.job, data.groupId);
    if (ctx.jobRef === undefined) {
      kit.logger.debug(`Job ${ctx.job?.id} has no id the run can carry — its lines name no job`, {
        ...jobIds(ctx),
      });
    }
    const jobField = ctx.jobRef ? { job: ctx.jobRef } : {};
    const attempt = () =>
      data.direction === JOB_NAMES.UP
        ? kit.up(data.migration, {
            batch: data.batch,
            ...(ordered ? { ordered: true } : {}),
            ...(data.force ? { force: true } : {}),
            ...(data.checksum ? { checksum: data.checksum } : {}),
            ...pickActor(data),
            ...jobField,
          })
        : kit.down(data.migration, {
            ...(ordered ? { ordered: true } : {}),
            ...pickActor(data),
            ...jobField,
          });

    try {
      const { result, waitedMs } = await waitForLock(ctx, attempt, signal);
      const started = await startBackground(ctx);
      return { ...resultOf(ctx, result, waitedMs), ...(started ? { background: started } : {}) };
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
      isTransient: isTransientForJob,
      // A duck-typed kit has no telemetry to report to.
      onSettle: (wait) => kit[RECORD_LOCK_WAIT]?.(wait),
      onWait: ({ attempts, waitedMs: soFar, code }) => {
        // Each progress update is a Redis write and an event-stream entry:
        // a long wait reports every few seconds, not on every poll.
        const now = Date.now();
        if (attempts > 1 && now - (ctx.lastWaitProgressAt ?? 0) < WAIT_PROGRESS_INTERVAL_MS) {
          return;
        }
        ctx.lastWaitProgressAt = now;
        if (attempts === 1) {
          log(
            ctx,
            code === 'MIGRATION_BLOCKED'
              ? 'Earlier migration(s) not applied yet — waiting for them…'
              : 'Migration lock held by another process — waiting…',
          );
        }
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
      () => kit.converge({ ...(ordered ? { ordered: true } : {}), ...pickActor(data) }),
      signal,
    );
    return redactDeep({
      kind: 'converge',
      ...(data.groupId !== undefined ? { groupId: data.groupId } : {}),
      changed: result.changed,
      inSync: result.inSync,
      collections: result.collections,
      ...(result.unstable ? { unstable: result.unstable } : {}),
      ...(result.search ? { search: result.search } : {}),
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      lockWaitMs: waitedMs,
    });
  }

  /**
   * The circuit breaker of a schedule: the next migration in line failed, and
   * its file is still the version that failed. Re-enqueueing it every tick
   * would re-run a migration that may have half-applied its changes, again and
   * again, adding a failed job each time — until a fix is deployed (the
   * checksum changes) or someone asks for it explicitly (`enqueueUp(name)`,
   * which never consults this). Returns `{ migration, reason, failedAt? }`.
   */
  async function heldFailure(first, to) {
    if (!first || (to !== undefined && first.file > to)) return undefined;
    if (typeof kit.list !== 'function' || typeof kit.dryRun !== 'function') return undefined;
    const row = (await kit.list('all', { checksums: false })).find(
      (candidate) => candidate.file === first.file,
    );
    if (row?.status !== 'failed' || typeof row.failedChecksum !== 'string') return undefined;
    const [planned] = await kit.dryRun('up', first.file);
    if (planned?.checksum !== row.failedChecksum) return undefined;
    return {
      migration: first.file,
      reason: 'failed, and unchanged since',
      ...(row.failedAt ? { failedAt: row.failedAt } : {}),
    };
  }

  /** What the last sync tick found the line waiting for — `{ migration, waitsFor }` */
  let lastWaiting;

  async function runSyncJob(ctx) {
    if (!queue) {
      throw new ConfigInvalidError(
        'A sync job needs the queue to enqueue into — pass `queue` to createMigrationProcessor',
      );
    }
    const { to } = ctx.data;
    // Background migrations first: whatever this tick enqueues may wait for one.
    const healed = await healBackground();
    const backgroundField = healed !== undefined ? { background: { enqueued: healed } } : {};
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
        ...backgroundField,
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
    const held = await heldFailure(pending[0], to);
    if (held) {
      kit.logger.warn(
        `⚠ sync: ${held.migration} failed and has not changed since — not enqueued again ` +
          `until the file changes (or enqueueUp('${held.migration}') asks for it)`,
        { migration: held.migration },
      );
      return {
        kind: 'sync',
        groupId: null,
        batch: null,
        enqueued: 0,
        upToDate: false,
        migrations: [],
        held,
        ...backgroundField,
      };
    }
    // Still waiting where the last tick found it waiting, for what is still
    // not done: said again without planning — a background migration takes
    // hours, and planning re-reads the whole directory on every tick.
    if (lastWaiting?.migration === pending[0].file && (await stillWaiting(lastWaiting))) {
      return {
        kind: 'sync',
        groupId: null,
        batch: null,
        enqueued: 0,
        upToDate: false,
        migrations: [],
        waiting: lastWaiting,
        ...backgroundField,
      };
    }
    const group = await enqueueUp(queue, kit, {
      ...(to !== undefined ? { to } : {}),
      ...(jobOptions ? { jobOptions } : {}),
    });
    lastWaiting = group.waiting;
    const migrations = [];
    for (const job of group.jobs) migrations.push(job.migration);
    return {
      kind: 'sync',
      groupId: group.jobs.length === 0 ? null : group.groupId,
      batch: group.batch,
      enqueued: group.jobs.length,
      upToDate: group.upToDate,
      migrations,
      ...(group.converge
        ? { converge: { jobId: group.converge.id, deduplicated: group.converge.deduplicated } }
        : {}),
      // Waiting is not held: `held` stays the circuit breaker on a failure.
      ...(group.waiting ? { waiting: group.waiting } : {}),
      ...backgroundField,
    };
  }

  /** Whether a background migration `waiting` waits for is still not done */
  async function stillWaiting(waiting) {
    if (typeof kit.backgroundStatus !== 'function') return false;
    for (const name of waiting.waitsFor) {
      const status = await kit.backgroundStatus(name);
      if (status?.status !== 'completed' || status.direction === 'revert') return true;
    }
    return false;
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
    const ctx = {
      job,
      data: undefined,
      runId: undefined,
      started: false,
      writes: new Set(),
      registered: [],
    };
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
      // Well-formed is not the same as permitted: what a payload may ask for
      // beyond the ordinary is this worker's decision, not Redis's.
      assertAllowed(job, ctx.data, allow);
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
      // Nothing more is written for the migration once the job settles: a row
      // after BullMQ removed the job would leave its log behind in Redis.
      ctx.sealed = true;
      progress(ctx, 'completed', ctx.runId ? { runId: ctx.runId } : {});
      await flush(ctx);
      kit.logger.debug(`✔ Job ${job?.id} done`, {
        ...jobIds(ctx),
        ...jobFields(ctx.data),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      ctx.sealed = true;
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
        target.log?.(
          redactOutbound(`✖ ${errorText(error)}${ctx.runId ? ` [run ${ctx.runId}]` : ''}`),
        ),
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
  UNRECOVERABLE_ERROR_NAME,
  WAITING_ERROR_NAME,
  createMigrationProcessor,
  isTransientForJob,
  isRetryableError,
  jobRefOf,
  prepareErrorForQueue,
  resolveProcessorOptions,
  userlandRow,
};
