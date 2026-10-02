const { ConfigInvalidError, MigrationBlockedError } = require('../errors/index.js');
const { assertId, randomId } = require('../utils/id.js');
const { assertMigrationName } = require('../utils/migration-name.js');
const {
  FORBIDDEN_JOB_OPTIONS,
  JOB_NAMES,
  buildMigrationJob,
  isPlainObject,
  migrationJobOptions,
} = require('./jobs.js');
const { waitForGroup } = require('./wait.js');

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
 * Plan an `up` group without enqueuing it: which files, in which order, under
 * which batch. The selection is `kit.dryRun('up')` — the same one a real run
 * makes, order policy included — so the plan can never name a file a run
 * would not apply. One batch number is peeked for the whole group, which is
 * what makes a later `down` revert it as a unit.
 */
async function planUpJobs(kit, options = {}) {
  const { filename, to, force = false, ordered = true, jobOptions } = options;
  if (filename !== undefined) assertMigrationName(filename);
  if (to !== undefined) assertMigrationName(to);
  assertBoolean(force, 'force');
  assertBoolean(ordered, 'ordered');
  if (force && filename === undefined) {
    // A bulk plan only ever holds pending files — there is no applied target
    // for `force` to re-run.
    throw new ConfigInvalidError('force requires a filename', { force });
  }
  assertJobOptions(jobOptions);

  const rows = await kit.dryRun('up', filename, to !== undefined ? { to } : {});
  const migrations = [];
  for (const row of rows) {
    if (row.status !== 'applied' || force) migrations.push(row.file);
  }
  const groupId = await newGroupId(kit);
  if (migrations.length === 0) {
    return { groupId, direction: JOB_NAMES.UP, batch: null, migrations, jobs: [] };
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
      }),
      opts: migrationJobOptions(jobOptions, JOB_NAMES.UP, migration),
    });
  }
  return { groupId, direction: JOB_NAMES.UP, batch, migrations, jobs };
}

/**
 * An ordered rollback must be the top of the applied stack: every job reverts
 * only once nothing applied after it remains, so a plan that skips a newer
 * migration can never finish. Refusing here turns that into one synchronous
 * error instead of a group that fails halfway through.
 */
async function assertTopOfStack(kit, migrations) {
  const applied = await kit.list('applied');
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
      }),
      opts: migrationJobOptions(jobOptions, JOB_NAMES.DOWN, row.file),
    });
  }
  return { groupId, direction: JOB_NAMES.DOWN, batch: null, migrations, jobs };
}

/**
 * Which of the group's files were already queued by someone else. A
 * deduplicated add hands back the *existing* job's id, so the stored job's
 * group differs from ours — and waiting on that id simply joins the job that
 * will do the work.
 */
async function findDeduplicated(queue, jobs, groupId) {
  if (typeof queue.getJob !== 'function') return [];
  const stored = await Promise.all(jobs.map((job) => queue.getJob(job.id)));
  const deduplicated = [];
  for (const [index, job] of stored.entries()) {
    if (job && job.data?.groupId !== groupId) deduplicated.push(jobs[index].migration);
  }
  return deduplicated;
}

/** Add a planned group to the queue (atomically) and return its handle */
async function enqueueGroup(queue, kit, plan, { queueEvents, getQueueEvents } = {}) {
  if (!queue || typeof queue.addBulk !== 'function') {
    throw new ConfigInvalidError('queue must be a BullMQ Queue (it has no addBulk method)');
  }
  const { groupId, direction, batch } = plan;
  let jobs = [];
  let deduplicated = [];

  if (plan.jobs.length > 0) {
    const added = await queue.addBulk(plan.jobs);
    if (!Array.isArray(added) || added.length !== plan.jobs.length) {
      throw new ConfigInvalidError('queue.addBulk did not return one job per migration', {
        expected: plan.jobs.length,
      });
    }
    jobs = plan.migrations.map((migration, index) => ({
      id: String(added[index].id),
      migration,
      index,
    }));
    deduplicated = await findDeduplicated(queue, jobs, groupId);
    kit.logger.info(
      `⇢ Enqueued ${jobs.length} migration(s)   [${direction}${batch !== null ? `, batch ${batch}` : ''}]`,
      {
        groupId,
        direction,
        ...(batch !== null ? { batch } : {}),
        count: jobs.length,
        deduplicated: deduplicated.length,
      },
    );
  }

  return {
    groupId,
    direction,
    batch,
    upToDate: jobs.length === 0,
    jobs,
    deduplicated,
    wait: (waitOptions = {}) =>
      waitForGroup({
        queue,
        queueEvents: waitOptions.queueEvents ?? queueEvents ?? getQueueEvents?.(),
        groupId,
        direction,
        batch,
        jobs,
        timeoutMs: waitOptions.timeoutMs,
      }),
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

/** Enqueue a rollback (last batch, a `batch`, `steps`, back `to`, or one `filename`) */
async function enqueueDown(queue, kit, options = {}, internals = {}) {
  const { queueEvents, ...planOptions } = options;
  return enqueueGroup(queue, kit, await planDownJobs(kit, planOptions), {
    queueEvents,
    ...internals,
  });
}

module.exports = { assertJobOptions, enqueueDown, enqueueUp, planDownJobs, planUpJobs };
