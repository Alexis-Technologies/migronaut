const {
  BackgroundPendingError,
  ConfigInvalidError,
  MigrationBlockedError,
  NotAppliedError,
} = require('../errors/index.js');
const { actorIssue, pickActor } = require('../utils/actor.js');
const { mapLimit } = require('../utils/concurrency.js');
const { assertId, randomId } = require('../utils/id.js');
const { assertMigrationName } = require('../utils/migration-name.js');
const {
  BACKGROUND_FORBIDDEN_JOB_OPTIONS,
  FORBIDDEN_JOB_OPTIONS,
  JOB_NAMES,
  buildBackgroundJob,
  buildConvergeJob,
  buildMigrationJob,
  isPlainObject,
  migrationJobOptions,
} = require('./jobs.js');
const { waitForGroup } = require('./wait.js');

/** Job lookups in flight while checking a group for deduplicated adds */
const LOOKUP_CONCURRENCY = 16;

/**
 * `jobOptions` is a passthrough for retention and logging knobs
 * (`removeOnComplete`, `removeOnFail`, `keepLogs`, …). Anything that would
 * reorder, delay or re-run a job is refused by name rather than silently
 * overridden — the caller should learn the queue is FIFO on purpose.
 */
function assertJobOptions(jobOptions) {
  if (jobOptions === undefined) return;
  if (!isPlainObject(jobOptions)) {
    throw new ConfigInvalidError('jobOptions must be an object', { jobOptions: typeof jobOptions });
  }
  for (const key of FORBIDDEN_JOB_OPTIONS) {
    if (jobOptions[key] !== undefined) {
      throw new ConfigInvalidError(
        `jobOptions.${key} is not configurable — migration jobs run strictly first-in, ` +
          'first-out with a single attempt',
        { key },
      );
    }
  }
}

/**
 * A background queue's `jobOptions`: the same passthrough, minus what decides
 * how its coordinators and lanes are retried, ordered and woken.
 */
function assertBackgroundJobOptions(jobOptions) {
  if (jobOptions === undefined) return;
  if (!isPlainObject(jobOptions)) {
    throw new ConfigInvalidError('background jobOptions must be an object', {
      jobOptions: typeof jobOptions,
    });
  }
  for (const key of BACKGROUND_FORBIDDEN_JOB_OPTIONS) {
    if (jobOptions[key] !== undefined) {
      throw new ConfigInvalidError(
        `background jobOptions.${key} is not configurable — coordinators and lanes set their own`,
        { key },
      );
    }
  }
}

/** Validate the `requestedBy` / `reason` of an enqueue call, and return them */
function actorOf(options) {
  for (const key of ['requestedBy', 'reason']) {
    const issue = actorIssue(key, options[key]);
    if (issue) throw new ConfigInvalidError(issue, { [key]: typeof options[key] });
  }
  return pickActor(options);
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    throw new ConfigInvalidError(`${name} must be a boolean`, { [name]: value });
  }
}

/**
 * The id of one enqueue call, in the kit's configured format (`generateId`) so
 * a deployment sees one id format across the changelog and the queue. A
 * duck-typed kit without the method gets the default. Checked again here
 * either way: a worker refuses a job whose group id is not a short string, and
 * that has to be this call's error, not a job failing later in the queue.
 */
async function newGroupId(kit) {
  return assertId(typeof kit.generateId === 'function' ? await kit.generateId() : randomId());
}

/** Newest applied first — `appliedAt`, name-desc tiebreak: the order rollbacks must follow */
function newestFirst(a, b) {
  const delta = (b.appliedAt?.getTime?.() ?? 0) - (a.appliedAt?.getTime?.() ?? 0);
  if (delta !== 0) return delta;
  if (a.file === b.file) return 0;
  return a.file < b.file ? 1 : -1;
}

/**
 * Whether an `up` group ends with a converge job. Explicit `converge` wins;
 * otherwise it mirrors the kit's own after-up hook (`convergeAfterUp`), which
 * never fires in a queue — every job there is a single-file run. Only a group
 * that brings the database to the head converges, as in the kit.
 */
async function resolveConverge(kit, { converge, filename, to }) {
  if (converge !== undefined) {
    assertBoolean(converge, 'converge');
    if (converge && (filename !== undefined || to !== undefined)) {
      throw new ConfigInvalidError(
        'converge needs a group that reaches the newest migration — not a filename or `to`',
        { converge },
      );
    }
    return converge;
  }
  if (filename !== undefined || to !== undefined) return false;
  return typeof kit.convergesAfterUp === 'function' && (await kit.convergesAfterUp()) === true;
}

/**
 * Plan an `up` group without enqueuing it: which files, in which order, under
 * which batch. The selection is `kit.dryRun('up')` — the same one a real run
 * makes, order policy included — so the plan can never name a file a run
 * would not apply. One batch number is peeked for the whole group, which is
 * what makes a later `down` revert it as a unit.
 *
 * A group that converges carries its converge job apart from the migration
 * jobs, as `plan.converge`, so `plan.jobs` stays one-to-one with
 * `plan.migrations`. With nothing pending the converge job is planned only if
 * a dry run finds the database out of step.
 */
async function planUpJobs(kit, options = {}) {
  const { filename, to, force = false, ordered = true, jobOptions } = options;
  if (filename !== undefined) assertMigrationName(filename);
  if (to !== undefined) assertMigrationName(to);
  assertBoolean(force, 'force');
  assertBoolean(ordered, 'ordered');
  const actor = actorOf(options);
  if (force && filename === undefined) {
    // A bulk plan only ever holds pending files — there is no applied target
    // for `force` to re-run.
    throw new ConfigInvalidError('force requires a filename', { force });
  }
  assertJobOptions(jobOptions);
  const converge = await resolveConverge(kit, { converge: options.converge, filename, to });

  const rows = await kit.dryRun('up', filename, to !== undefined ? { to } : {});
  const migrations = [];
  /** The version of each file the plan was made from — a worker refuses any other */
  const checksums = new Map();
  /**
   * The first migration that requires a background migration not completed
   * yet — the plan ends before it. (A background file that requires one is
   * not held: it registers as blocked, and starts once it is unblocked.)
   */
  let waiting;
  for (const row of rows) {
    if (row.status === 'applied' && !force) continue;
    if (row.kind !== 'background' && Array.isArray(row.waitsFor) && row.waitsFor.length > 0) {
      waiting = { migration: row.file, waitsFor: row.waitsFor };
      break;
    }
    migrations.push(row.file);
    if (typeof row.checksum === 'string') checksums.set(row.file, row.checksum);
  }
  if (waiting !== undefined && filename !== undefined) {
    // Asked for by name: say why now, rather than enqueue a job that can only fail.
    throw new BackgroundPendingError(
      `${waiting.migration} requires background migration(s) that have not completed: ` +
        waiting.waitsFor.join(', '),
      {
        migration: waiting.migration,
        waitsFor: waiting.waitsFor.map((migration) => ({ migration })),
      },
    );
  }
  const groupId = await newGroupId(kit);
  const tail = waiting !== undefined ? { waiting } : {};
  if (migrations.length === 0) {
    const plan = { groupId, direction: JOB_NAMES.UP, batch: null, migrations, jobs: [], ...tail };
    // A group cut short of the head never converges — nor does it with nothing to run.
    if (waiting === undefined && converge && !(await kit.converge({ dryRun: true })).inSync) {
      plan.converge = buildConvergeJob({ groupId, ordered, jobOptions, ...actor });
    }
    return plan;
  }

  const batch = await kit.nextBatch();
  const jobs = [];
  for (const [index, migration] of migrations.entries()) {
    jobs.push({
      ...buildMigrationJob({
        direction: JOB_NAMES.UP,
        migration,
        groupId,
        index,
        total: migrations.length,
        batch,
        force,
        ordered,
        checksum: checksums.get(migration),
        ...actor,
      }),
      opts: migrationJobOptions(jobOptions, JOB_NAMES.UP, migration, { force }),
    });
  }
  const plan = { groupId, direction: JOB_NAMES.UP, batch, migrations, jobs, ...tail };
  if (converge && waiting === undefined) {
    plan.converge = buildConvergeJob({
      groupId,
      ordered,
      after: migrations.at(-1),
      jobOptions,
      ...actor,
    });
  }
  return plan;
}

/**
 * An ordered rollback must be the top of the applied stack: every job reverts
 * only once nothing applied after it remains, so a plan that skips a newer
 * migration can never finish. Refusing here turns that into one synchronous
 * error instead of a group that fails halfway through.
 */
async function assertTopOfStack(kit, migrations) {
  // Names and dates are all this needs — not a re-hash of every applied file.
  const applied = await kit.list('applied', { checksums: false });
  applied.sort(newestFirst);
  const planned = new Set(migrations);
  let deepest = -1;
  for (const [index, row] of applied.entries()) {
    if (planned.has(row.file)) deepest = index;
  }
  const blockedBy = [];
  for (let index = 0; index < deepest; index++) {
    if (!planned.has(applied[index].file)) blockedBy.push(applied[index].file);
  }
  if (blockedBy.length === 0) return;
  throw new MigrationBlockedError(
    `Rollback is blocked: ${blockedBy.length} later migration(s) still applied and not part of ` +
      `it: ${blockedBy.join(', ')}`,
    { direction: JOB_NAMES.DOWN, names: [...migrations], blockedBy },
  );
}

/**
 * Plan a `down` group: `kit.dryRun('down')` picks the records (so forward-only
 * and not-applied refusals happen here, before anything is enqueued), then an
 * ordered plan is put in revert order — newest applied first.
 */
async function planDownJobs(kit, options = {}) {
  const { filename, steps, batch, to, ordered = true, jobOptions } = options;
  if (filename !== undefined) assertMigrationName(filename);
  if (to !== undefined) assertMigrationName(to);
  assertBoolean(ordered, 'ordered');
  assertJobOptions(jobOptions);
  const actor = actorOf(options);

  const selection = {};
  if (steps !== undefined) selection.steps = steps;
  if (batch !== undefined) selection.batch = batch;
  if (to !== undefined) selection.to = to;
  const rows = await kit.dryRun('down', filename, selection);
  if (ordered) rows.sort(newestFirst);

  const migrations = [];
  for (const row of rows) migrations.push(row.file);
  const groupId = await newGroupId(kit);
  if (migrations.length === 0) {
    return { groupId, direction: JOB_NAMES.DOWN, batch: null, migrations, jobs: [] };
  }
  if (ordered) await assertTopOfStack(kit, migrations);

  const jobs = [];
  for (const [index, row] of rows.entries()) {
    jobs.push({
      ...buildMigrationJob({
        direction: JOB_NAMES.DOWN,
        migration: row.file,
        groupId,
        index,
        total: rows.length,
        batch: row.batch,
        ordered,
        ...actor,
      }),
      opts: migrationJobOptions(jobOptions, JOB_NAMES.DOWN, row.file),
    });
  }
  return { groupId, direction: JOB_NAMES.DOWN, batch: null, migrations, jobs };
}

/**
 * For each id, whether the job stored under it was queued by another enqueue
 * call. A deduplicated add hands back the *existing* job's id, so the stored
 * job's group differs from ours — and waiting on that id simply joins the job
 * that will do the work. All false on a queue that cannot read jobs back.
 */
async function foreignJobs(queue, ids, groupId) {
  if (typeof queue.getJob !== 'function') return new Array(ids.length).fill(false);
  // A first deploy can enqueue hundreds of jobs: read them back a few at a time,
  // each answered as it arrives.
  return mapLimit(ids, LOOKUP_CONCURRENCY, async (id) => {
    const job = await queue.getJob(id);
    return Boolean(job && job.data?.groupId !== groupId);
  });
}

/**
 * The `wait()` of an enqueue handle. It waits through the caller's
 * QueueEvents, else the one the facade lends (`getQueueEvents`) — never
 * opened for a group that has nothing to wait for.
 */
function makeWait(queue, group, { queueEvents, getQueueEvents } = {}) {
  const waitsForSomething = group.jobs.length > 0 || group.converge !== undefined;
  return (waitOptions = {}) =>
    waitForGroup({
      queue,
      queueEvents:
        waitOptions.queueEvents ??
        queueEvents ??
        (waitsForSomething ? getQueueEvents?.() : undefined),
      ...group,
      timeoutMs: waitOptions.timeoutMs,
    });
}

function assertQueue(queue) {
  if (!queue || typeof queue.addBulk !== 'function') {
    throw new ConfigInvalidError('queue must be a BullMQ Queue (it has no addBulk method)');
  }
}

/** Add a planned group to the queue (atomically) and return its handle */
async function enqueueGroup(queue, kit, plan, { queueEvents, getQueueEvents } = {}) {
  assertQueue(queue);
  const { groupId, direction, batch } = plan;
  let jobs = [];
  const deduplicated = [];
  let converge = null;

  const specs = plan.converge ? [...plan.jobs, plan.converge] : plan.jobs;
  if (specs.length > 0) {
    const added = await queue.addBulk(specs);
    if (!Array.isArray(added) || added.length !== specs.length) {
      throw new ConfigInvalidError('queue.addBulk did not return one job per migration', {
        expected: specs.length,
      });
    }
    // The ids of every job added, and the migration ones as jobs — one pass.
    const ids = new Array(added.length);
    jobs = new Array(plan.migrations.length);
    for (const [index, job] of added.entries()) {
      ids[index] = String(job.id);
      if (index < jobs.length) {
        jobs[index] = { id: ids[index], migration: plan.migrations[index], index };
      }
    }
    const foreign = await foreignJobs(queue, ids, groupId);
    for (const job of jobs) {
      if (foreign[job.index]) deduplicated.push(job.migration);
    }
    if (plan.converge) {
      converge = { id: String(added[specs.length - 1].id), deduplicated: foreign.at(-1) };
    }
    const what =
      jobs.length > 0
        ? `${jobs.length} migration(s)${converge ? ' + converge' : ''}`
        : 'a converge job';
    kit.logger.info(
      `⇢ Enqueued ${what}   [${direction}${batch !== null ? `, batch ${batch}` : ''}]`,
      {
        groupId,
        direction,
        ...(batch !== null ? { batch } : {}),
        count: jobs.length,
        deduplicated: deduplicated.length,
        ...(converge ? { converge: true } : {}),
      },
    );
  }

  if (plan.waiting !== undefined) {
    kit.logger.info(
      `⧗ ${plan.waiting.migration} waits for background migration(s): ` +
        `${plan.waiting.waitsFor.join(', ')} — not enqueued yet`,
      { groupId, migration: plan.waiting.migration, waitsFor: plan.waiting.waitsFor.length },
    );
  }

  return {
    groupId,
    direction,
    batch,
    // "No migration to run" — a converge-only group is still up to date; one
    // cut short by a background migration is not.
    upToDate: jobs.length === 0 && plan.waiting === undefined,
    ...(plan.waiting !== undefined ? { waiting: plan.waiting } : {}),
    jobs,
    deduplicated,
    converge,
    wait: makeWait(
      queue,
      { groupId, direction, batch, jobs, ...(converge ? { converge } : {}) },
      { queueEvents, getQueueEvents },
    ),
  };
}

/**
 * Enqueue a converge job on its own, on a queue you own: it brings the
 * declared collections to their declared state, under the MongoDB lock.
 * `ordered` (default true) makes it refuse while a migration is still
 * pending — the declared state describes the newest schema.
 */
async function enqueueConverge(queue, kit, options = {}, internals = {}) {
  if (!isPlainObject(options)) {
    throw new ConfigInvalidError('enqueueConverge options must be an object');
  }
  const { ordered, jobOptions, queueEvents } = options;
  if (ordered !== undefined) assertBoolean(ordered, 'ordered');
  assertJobOptions(jobOptions);
  assertQueue(queue);
  const actor = actorOf(options);
  const groupId = await newGroupId(kit);
  const [added] = await queue.addBulk([
    buildConvergeJob({ groupId, ordered, jobOptions, ...actor }),
  ]);
  if (!added) throw new ConfigInvalidError('queue.addBulk did not return the converge job');
  const jobId = String(added.id);
  const [deduplicated] = await foreignJobs(queue, [jobId], groupId);
  const wait = makeWait(
    queue,
    { groupId, direction: 'converge', batch: null, jobs: [], converge: { id: jobId } },
    { queueEvents, getQueueEvents: internals.getQueueEvents },
  );
  kit.logger.info(`⇢ Enqueued a converge job${deduplicated ? ' (already queued)' : ''}`, {
    groupId,
    jobId,
    deduplicated,
  });
  return {
    groupId,
    jobId,
    deduplicated,
    wait: async (waitOptions = {}) => {
      const { converge } = await wait(waitOptions);
      return converge;
    },
  };
}

/**
 * Enqueue pending migrations (all, up to `to`, or one `filename`) as one job
 * each, on a queue you own. `internals` is how the facade lends its lazily
 * built QueueEvents to `wait()`.
 */
async function enqueueUp(queue, kit, options = {}, internals = {}) {
  const { queueEvents, ...planOptions } = options;
  return enqueueGroup(queue, kit, await planUpJobs(kit, planOptions), {
    queueEvents,
    ...internals,
  });
}

/** How long a running background migration may show no sign of life before a takeover */
const DEFAULT_STALL_MS = 15 * 60_000;

/** The latest sign of life of a background migration: a checkpoint, a coordinator step, its start */
function lastActivity(status) {
  let latest = 0;
  for (const at of [
    status.lastProgressAt,
    status.coordinator?.at,
    status.startedAt,
    status.registeredAt,
  ]) {
    const time = at instanceof Date ? at.getTime() : 0;
    if (time > latest) latest = time;
  }
  return latest;
}

/**
 * Enqueue the coordinator of one background migration — or, with no
 * `migration`, of every one with work to do (unblocking those whose requires
 * are met on the way). Safe to call from every pod, as often as you like: a
 * coordinator chain that is alive absorbs the add. A background migration
 * nothing has moved for `stallMs` (no live lease, no checkpoint, no
 * coordinator step) also gets a takeover coordinator — one per round, however
 * many pods ask — whose newer round retires the stuck one.
 */
async function enqueueBackground(queue, kit, options = {}) {
  if (!isPlainObject(options)) {
    throw new ConfigInvalidError('enqueueBackground options must be an object');
  }
  const { migration, jobOptions, stallMs = DEFAULT_STALL_MS } = options;
  assertQueue(queue);
  assertBackgroundJobOptions(jobOptions);
  if (!Number.isSafeInteger(stallMs) || stallMs < 1000) {
    throw new ConfigInvalidError('stallMs must be an integer of at least 1000', { stallMs });
  }
  const actor = actorOf(options);
  const targets = [];
  if (migration !== undefined) {
    assertMigrationName(migration);
    const status = await kit.backgroundStatus(migration);
    if (status === null) {
      throw new NotAppliedError(
        `Background migration ${migration} is not registered — run up first`,
        { migration },
      );
    }
    targets.push(status);
  } else {
    for (const entry of await kit.runnableBackground()) {
      targets.push(
        entry.status === 'pending'
          ? entry
          : ((await kit.backgroundStatus(entry.migration)) ?? entry),
      );
    }
  }
  const specs = [];
  const now = Date.now();
  for (const status of targets) {
    specs.push(buildBackgroundJob({ migration: status.migration, jobOptions, ...actor }));
    const stalled =
      status.status === 'running' &&
      status.liveLeases === 0 &&
      now - lastActivity(status) > stallMs;
    if (stalled) {
      specs.push(
        buildBackgroundJob({
          migration: status.migration,
          takeoverOf: status.coordinator?.round ?? 0,
          jobOptions,
          ...actor,
        }),
      );
    }
  }
  if (specs.length === 0) return { jobs: [] };
  const added = await queue.addBulk(specs);
  const jobs = [];
  for (const [index, job] of added.entries()) {
    jobs.push({
      migration: specs[index].data.migration,
      id: String(job.id),
      ...(specs[index].data.takeover ? { takeover: true } : {}),
    });
  }
  return { jobs };
}

/** Enqueue a rollback (last batch, a `batch`, `steps`, back `to`, or one `filename`) */
async function enqueueDown(queue, kit, options = {}, internals = {}) {
  const { queueEvents, ...planOptions } = options;
  return enqueueGroup(queue, kit, await planDownJobs(kit, planOptions), {
    queueEvents,
    ...internals,
  });
}

module.exports = {
  DEFAULT_STALL_MS,
  assertBackgroundJobOptions,
  assertJobOptions,
  enqueueBackground,
  enqueueConverge,
  enqueueDown,
  enqueueUp,
  planDownJobs,
  planUpJobs,
};
