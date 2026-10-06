const { MigratorKit } = require('../core/migrator.js');
const { ConfigInvalidError, MigronautError, RunAbortedError } = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { redactOutbound } = require('../utils/redact.js');
const { JOB_NAMES, buildLaneJob, isPlainObject, parseBackgroundJobData } = require('./jobs.js');
const {
  UNRECOVERABLE_ERROR_NAME,
  isRetryableError,
  prepareErrorForQueue,
} = require('./processor.js');
const {
  DEFAULT_STALL_MS,
  assertBackgroundJobOptions,
  enqueueBackground,
} = require('./producer.js');

/**
 * Background migrations on a queue of their own. A coordinator job per
 * background migration plans its partitions and spawns lanes as its children
 * (`parent` + `moveToWaitingChildren`); each lane works slices, continuing
 * itself with `moveToDelayed` between them, until nothing is left to claim.
 * The coordinator wakes once its last lane is done and decides — from
 * MongoDB, never from how its lanes ended — whether to spawn more, plan
 * another pass or finish. Everything that matters (plans, cursors, leases,
 * counters) is in MongoDB: a lost job or a lost Redis costs a heal, not work.
 *
 * Unlike the migration processor, jobs run side by side here — the kit's
 * background methods are reentrant, and the leases cap the lanes.
 */

const DEFAULTS = Object.freeze({
  pollIntervalMs: 5_000,
  maxLaneRetries: 8,
});

/** What BullMQ checks (by name) for a job the processor moved to delayed itself */
const DELAYED_ERROR_NAME = 'DelayedError';
/** What BullMQ checks (by name) for a job the processor moved to wait for its children */
const WAITING_CHILDREN_ERROR_NAME = 'WaitingChildrenError';
/** The longest a failing lane backs off for */
const MAX_LANE_BACKOFF_MS = 5 * 60_000;
/**
 * Coordinator steps one job takes in a row when its lanes all finished before
 * it could wait for them — then it yields the worker and comes back.
 */
const MAX_INLINE_STEPS = 5;

/** The longest slice a caller may ask for — the kit's limit, mirrored (a unit test pins it) */
const MAX_SLICE_MS = 3_600_000;

/**
 * The error that tells BullMQ a job was moved (delayed, waiting for its
 * children) — a typed one, renamed: BullMQ matches the name, and the adapter
 * cannot import its classes.
 */
const moved = (name) => {
  const error = new RunAbortedError(`Moved: ${name}`, { reason: name, moved: true });
  error.name = name;
  return error;
};

/**
 * Validate the background processor's options. Pure, like the migration
 * processor's: nothing is constructed.
 */
function resolveBackgroundProcessorOptions(options) {
  if (!isPlainObject(options)) {
    throw new ConfigInvalidError('createBackgroundProcessor options must be an object');
  }
  const {
    kit,
    config,
    queue,
    jobOptions,
    sliceMs,
    children = 'auto',
    pollIntervalMs = DEFAULTS.pollIntervalMs,
    stallMs = DEFAULT_STALL_MS,
    maxLaneRetries = DEFAULTS.maxLaneRetries,
  } = options;
  if (kit !== undefined && config !== undefined) {
    throw new ConfigInvalidError('Pass either `kit` or `config`, not both');
  }
  if (kit !== undefined && typeof kit?.coordinateBackground !== 'function') {
    throw new ConfigInvalidError('kit must be a MigratorKit instance');
  }
  if (!queue || typeof queue.addBulk !== 'function') {
    throw new ConfigInvalidError(
      'queue is required — the background queue the coordinators add their lanes to',
    );
  }
  // The kit's own range for a caller's slice (background-spec's assertSliceMs).
  if (
    sliceMs !== undefined &&
    (!Number.isSafeInteger(sliceMs) || sliceMs < 1 || sliceMs > MAX_SLICE_MS)
  ) {
    throw new ConfigInvalidError(`sliceMs must be an integer from 1 to ${MAX_SLICE_MS}`, {
      sliceMs,
    });
  }
  if (children !== 'auto' && children !== false) {
    throw new ConfigInvalidError("children must be 'auto' or false", { children });
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new ConfigInvalidError('pollIntervalMs must be an integer ≥ 10', { pollIntervalMs });
  }
  if (!Number.isSafeInteger(stallMs) || stallMs < 1000) {
    throw new ConfigInvalidError('stallMs must be an integer of at least 1000', { stallMs });
  }
  if (!Number.isSafeInteger(maxLaneRetries) || maxLaneRetries < 0 || maxLaneRetries > 100) {
    throw new ConfigInvalidError('maxLaneRetries must be an integer from 0 to 100', {
      maxLaneRetries,
    });
  }
  assertBackgroundJobOptions(jobOptions);
  return { sliceMs, children, pollIntervalMs, stallMs, maxLaneRetries };
}

/**
 * Build the function a BullMQ Worker on the background queue runs. Declared
 * with exactly three parameters, so BullMQ hands it the cancellation signal.
 */
function createBackgroundProcessor(options = {}) {
  const settings = resolveBackgroundProcessorOptions(options);
  const { kit: injectedKit, config, kitOptions, queue, jobOptions } = options;
  const ownsKit = injectedKit === undefined;
  const kit = injectedKit ?? new MigratorKit(config ?? {}, kitOptions);
  const shutdownController = new AbortController();
  const inFlight = new Set();

  /** A log row on the job — never allowed to fail it */
  async function log(job, row) {
    try {
      await job.log?.(redactOutbound(row));
    } catch {
      // Redis is the job's problem, not the background migration's.
    }
  }

  /**
   * Continue this job later: its data updated first (when `data` is given),
   * then moved to delayed — which BullMQ learns from the error's name. Outside
   * a Worker (no token) there is nothing to move: the outcome is returned.
   */
  async function later(ctx, delayMs, result, data) {
    const { job, token } = ctx;
    if (typeof job.moveToDelayed !== 'function' || typeof token !== 'string') {
      return { ...result, retryAfterMs: delayMs };
    }
    if (data !== undefined) await job.updateData(data);
    await job.moveToDelayed(Date.now() + Math.max(0, delayMs), token);
    throw moved(DELAYED_ERROR_NAME);
  }

  /** Heal from MongoDB: a coordinator for every background migration with work to do */
  async function heal(reason) {
    try {
      return await enqueueBackground(queue, kit, {
        stallMs: settings.stallMs,
        ...(jobOptions !== undefined ? { jobOptions } : {}),
      });
    } catch (error) {
      kit.logger.warn(`⚠ Background heal (${reason}) failed: ${errorText(error)}`, {
        error: errorText(error),
      });
      return { jobs: [] };
    }
  }

  /** Whether this coordinator can spawn its lanes as children and wait for them */
  function childrenFor(ctx) {
    return (
      settings.children !== false &&
      typeof queue.qualifiedName === 'string' &&
      typeof ctx.job.moveToWaitingChildren === 'function' &&
      typeof ctx.token === 'string'
    );
  }

  async function runCoordinator(ctx, data) {
    const { job } = ctx;
    const name = data.migration;
    const status = await kit.backgroundStatus(name);
    const base = { kind: JOB_NAMES.BACKGROUND, migration: name };
    if (status === null) return { ...base, status: 'unregistered' };
    // A new chain outranks every coordinator before it; the round is kept in
    // the job's data, so the chain keeps it across its moves.
    const round = data.round ?? (status.coordinator?.round ?? 0) + 1;
    let spawn = data.spawn ?? 0;
    const children = childrenFor(ctx);
    const keep = () => ({ ...job.data, round, spawn });

    for (let step = 0; ; step++) {
      if (shutdownController.signal.aborted) return later(ctx, 0, { ...base, round }, keep());
      const answer = await kit.coordinateBackground(name, {
        signal: ctx.abort,
        driver: { kind: 'bullmq', ref: String(job.id), round },
      });
      if (answer.next === 'done') {
        await log(job, `✔ ${name}: ${answer.status}`);
        // Its dependents may just have been unblocked.
        if (answer.status === 'completed') await heal('completed');
        return { ...base, status: answer.status, round };
      }
      if (answer.next === 'superseded') {
        await log(job, `↷ ${name}: superseded by a newer coordinator`);
        return { ...base, status: 'superseded', round };
      }
      if (answer.next !== 'process' || answer.lanes === 0) {
        return later(
          ctx,
          answer.retryAfterMs ?? settings.pollIntervalMs,
          { ...base, status: answer.next, round },
          keep(),
        );
      }
      if (!children) {
        // No parents in this BullMQ (or turned off): lanes deduplicated per
        // slot, and the coordinator looks again after a while.
        await addLanes(ctx, { name, status, answer, round, spawn });
        return later(ctx, settings.pollIntervalMs, { ...base, status: 'process', round }, keep());
      }
      if (step >= MAX_INLINE_STEPS) return later(ctx, 0, { ...base, round }, keep());
      spawn += 1;
      // Before the lanes: their ids carry the spawn, and a new one must never
      // repeat one a finished lane already has.
      await job.updateData(keep());
      await addLanes(ctx, {
        name,
        status,
        answer,
        round,
        spawn,
        parent: { id: String(job.id), queue: queue.qualifiedName },
      });
      if (await job.moveToWaitingChildren(ctx.token)) throw moved(WAITING_CHILDREN_ERROR_NAME);
      // Every lane finished before this job could wait for them: look again now.
    }
  }

  async function addLanes(ctx, { name, status, answer, round, spawn, parent }) {
    const specs = [];
    for (let lane = 0; lane < answer.lanes; lane++) {
      specs.push(
        buildLaneJob({
          migration: name,
          registration: status.registration,
          generation: answer.generation,
          round,
          spawn,
          lane,
          ...(parent !== undefined ? { parent } : {}),
          jobOptions,
        }),
      );
    }
    await queue.addBulk(specs);
    await log(
      ctx.job,
      `⇉ ${name}: ${specs.length} lane(s) for generation ${answer.generation} (round ${round})`,
    );
  }

  async function runLane(ctx, data) {
    const { job } = ctx;
    const name = data.migration;
    const base = { kind: JOB_NAMES.BACKGROUND_LANE, migration: name };
    if (shutdownController.signal.aborted) return later(ctx, 0, { ...base, outcome: 'stopped' });
    let slice;
    try {
      slice = await kit.runBackgroundSlice(name, {
        signal: ctx.abort,
        ...(settings.sliceMs !== undefined ? { sliceMs: settings.sliceMs } : {}),
      });
    } catch (error) {
      if (shutdownController.signal.aborted) {
        return later(ctx, 0, { ...base, outcome: 'stopped' });
      }
      // The failure is already counted on its partition, in MongoDB — which
      // fails the partition after `maxSliceFailures`; this lane only backs off.
      const retry = data.retry + 1;
      const message = errorText(error);
      if (retry > settings.maxLaneRetries) {
        kit.logger.warn(`⚠ Background lane of ${name} gave up: ${message}`, {
          background: name,
          error: message,
        });
        await log(job, `✖ gave up after ${data.retry} retries: ${message}`);
        return {
          ...base,
          outcome: 'gave-up',
          ...(error instanceof MigronautError ? { code: error.code } : {}),
        };
      }
      await log(job, `⚠ slice failed (${message}) — retry ${retry}`);
      return later(
        ctx,
        Math.min(MAX_LANE_BACKOFF_MS, 1000 * 2 ** (retry - 1)),
        { ...base, outcome: 'retry' },
        { ...job.data, retry },
      );
    }
    const reset = data.retry > 0 ? { ...job.data, retry: 0 } : undefined;
    switch (slice.outcome) {
      case 'yielded':
      case 'stopped':
      case 'lost':
        // Work is left — continue as the same job, behind whatever waits.
        return later(ctx, 0, { ...base, outcome: slice.outcome }, reset);
      case 'busy':
        return later(
          ctx,
          slice.retryAfterMs ?? settings.pollIntervalMs,
          { ...base, outcome: 'busy' },
          reset,
        );
      default:
        return { ...base, outcome: slice.outcome, counters: slice.counters };
    }
  }

  async function runVerify() {
    const result = await kit.verifyBackground();
    const healed = await heal('verify');
    return {
      kind: JOB_NAMES.BACKGROUND_VERIFY,
      checked: result.checked,
      skipped: result.skipped,
      drift: result.drift,
      enqueued: healed.jobs.length,
    };
  }

  async function handle(job, token, signal) {
    const signals = [shutdownController.signal];
    if (signal) signals.push(signal);
    const ctx = { job, token, abort: AbortSignal.any(signals) };
    const data = parseBackgroundJobData(job);
    // A job fetched while this process shuts down goes back for another worker.
    if (shutdownController.signal.aborted) {
      return later(ctx, 0, { kind: data.kind, outcome: 'stopped' });
    }
    await kit.connect();
    if (data.kind === JOB_NAMES.BACKGROUND) return runCoordinator(ctx, data);
    if (data.kind === JOB_NAMES.BACKGROUND_LANE) return runLane(ctx, data);
    return runVerify();
  }

  // Three declared parameters, on purpose — see the factory's doc comment.
  async function processor(job, token, signal) {
    const run = handle(job, token, signal);
    inFlight.add(run);
    try {
      return await run;
    } catch (error) {
      if (error?.name !== DELAYED_ERROR_NAME && error?.name !== WAITING_CHILDREN_ERROR_NAME) {
        // A coordinator has a few attempts; a failure no retry can fix
        // (an invalid payload) is told apart by name, as BullMQ checks it.
        if (!isRetryableError(error) && (job?.opts?.attempts ?? 1) > 1) {
          error.name = UNRECOVERABLE_ERROR_NAME;
        }
        prepareErrorForQueue(error);
      }
      throw error;
    } finally {
      inFlight.delete(run);
    }
  }

  /**
   * Stop: a lane stops at its next batch boundary, checkpoints, releases its
   * lease and goes back to the queue (moved to delayed, for the next worker);
   * a coordinator that is deciding bows out and comes back. Irreversible.
   */
  processor.shutdown = (reason = 'Background worker shutting down') => {
    if (!shutdownController.signal.aborted) {
      shutdownController.abort(new RunAbortedError(reason, { reason }));
    }
  };

  /** Shut down, let the jobs in flight settle, disconnect a kit the processor created */
  processor.close = async () => {
    processor.shutdown();
    await Promise.allSettled([...inFlight]);
    if (ownsKit) await kit.disconnect();
  };

  /** Heal from MongoDB now — what a worker does when it starts */
  processor.heal = () => heal('boot');

  Object.defineProperty(processor, 'kit', { value: kit, enumerable: true });
  return processor;
}

module.exports = {
  BACKGROUND_PROCESSOR_DEFAULTS: DEFAULTS,
  MAX_SLICE_MS,
  createBackgroundProcessor,
  resolveBackgroundProcessorOptions,
};
