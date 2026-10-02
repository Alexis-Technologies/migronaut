const { QueueJobInvalidError } = require('../errors/index.js');
const { MAX_ID_LENGTH } = require('../utils/id.js');
const { isBareFilename } = require('../utils/migration-name.js');

/**
 * The job contract between whoever enqueues migrations and the worker that
 * runs them. Versioned (`v`), because the two can be different deploys of the
 * same service: a worker that meets a payload from a newer producer must fail
 * that job cleanly instead of guessing at fields it does not know.
 */
const JOB_DATA_VERSION = 1;

/** One job name per kind of work — `up`/`down` carry one migration each */
const JOB_NAMES = Object.freeze({ UP: 'up', DOWN: 'down', SYNC: 'sync' });

const DEFAULT_QUEUE_NAME = 'migronaut';
/** No `:` — BullMQ rejects it in custom ids */
const DEFAULT_SCHEDULER_ID = 'migronaut-sync';

/**
 * Forced onto every migration job, over anything the caller configured. A
 * BullMQ retry re-queues the job *behind* the ones waiting, so the migrations
 * after it would run first and fail as blocked; transient trouble (a held
 * lock) is retried inside the processor instead, where order is kept.
 */
const MIGRATION_JOB_OPTIONS = Object.freeze({ attempts: 1 });

/** Job options that reorder, delay or re-run jobs — each would break FIFO */
const FORBIDDEN_JOB_OPTIONS = Object.freeze([
  'attempts',
  'backoff',
  'delay',
  'priority',
  'lifo',
  'jobId',
  'deduplication',
  'repeat',
  'parent',
]);

const MAX_MIGRATION_NAME_LENGTH = 255;
/** The limit every migronaut id is minted under — a producer's own check and this one agree */
const MAX_GROUP_ID_LENGTH = MAX_ID_LENGTH;

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * Deduplication id for one migration in one direction. BullMQ holds the key
 * only while that job is waiting or active, so a second enqueue of the same
 * pending file is absorbed, yet a later down → up cycle is never blocked —
 * which a custom `jobId` would do for as long as the finished job is retained.
 */
function dedupId(direction, migration) {
  return `${direction}-${migration.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function invalid(job, issue) {
  return new QueueJobInvalidError(`Invalid migration job: ${issue}`, {
    ...(job?.id !== undefined ? { jobId: String(job.id) } : {}),
    issue,
  });
}

/**
 * Validate a job read back from the queue and return a normalized copy.
 *
 * Everything here is untrusted: the payload sat in Redis, where anything with
 * write access could have put it. Nothing is passed on that was not checked —
 * above all the migration name, which becomes a filesystem path.
 */
function parseJobData(job) {
  if (!isPlainObject(job)) throw invalid(job, 'job is not an object');
  const { name, data } = job;
  if (name !== JOB_NAMES.UP && name !== JOB_NAMES.DOWN && name !== JOB_NAMES.SYNC) {
    throw invalid(job, 'unknown job name');
  }
  if (!isPlainObject(data)) throw invalid(job, 'data is not an object');
  if (data.v !== JOB_DATA_VERSION) throw invalid(job, 'unsupported job data version');

  if (name === JOB_NAMES.SYNC) {
    if (data.to !== undefined && !isBareFilename(data.to)) {
      throw invalid(job, 'to is not a bare filename');
    }
    return { kind: 'sync', ...(data.to !== undefined ? { to: data.to } : {}) };
  }

  if (data.direction !== name) throw invalid(job, 'direction does not match the job name');
  if (!isBareFilename(data.migration) || data.migration.length > MAX_MIGRATION_NAME_LENGTH) {
    throw invalid(job, 'migration is not a bare filename');
  }
  if (
    typeof data.groupId !== 'string' ||
    data.groupId.length === 0 ||
    data.groupId.length > MAX_GROUP_ID_LENGTH
  ) {
    throw invalid(job, 'groupId is not a short string');
  }
  if (
    !Number.isSafeInteger(data.index) ||
    !Number.isSafeInteger(data.total) ||
    data.index < 0 ||
    data.index >= data.total
  ) {
    throw invalid(job, 'index/total are not a valid position');
  }
  const isUp = name === JOB_NAMES.UP;
  if (
    isUp ? !isPositiveInteger(data.batch) : data.batch != null && !isPositiveInteger(data.batch)
  ) {
    throw invalid(job, 'batch is not a positive integer');
  }
  if (data.force !== undefined && (data.force !== true || !isUp)) {
    throw invalid(job, 'force is only valid as `true` on an up job');
  }
  if (data.ordered !== undefined && typeof data.ordered !== 'boolean') {
    throw invalid(job, 'ordered is not a boolean');
  }

  return {
    kind: 'migration',
    direction: name,
    migration: data.migration,
    groupId: data.groupId,
    index: data.index,
    total: data.total,
    ...(data.batch != null ? { batch: data.batch } : {}),
    ...(data.force ? { force: true } : {}),
    ...(data.ordered !== undefined ? { ordered: data.ordered } : {}),
  };
}

/** Build one `up`/`down` job spec, ready for `queue.addBulk` */
function buildMigrationJob({ direction, migration, groupId, index, total, batch, force, ordered }) {
  return {
    name: direction,
    data: {
      v: JOB_DATA_VERSION,
      direction,
      migration,
      groupId,
      index,
      total,
      ...(batch != null ? { batch } : {}),
      ...(force ? { force: true } : {}),
      ...(ordered === false ? { ordered: false } : {}),
    },
  };
}

/** Per-job options: the caller's passthrough, then the ones the contract owns */
function migrationJobOptions(jobOptions, direction, migration) {
  return {
    ...jobOptions,
    ...MIGRATION_JOB_OPTIONS,
    deduplication: { id: dedupId(direction, migration) },
  };
}

/** The job a scheduler tick produces: plan what is pending, enqueue it */
function buildSyncJobTemplate({ to } = {}) {
  return {
    name: JOB_NAMES.SYNC,
    data: { v: JOB_DATA_VERSION, kind: 'sync', ...(to !== undefined ? { to } : {}) },
    opts: { ...MIGRATION_JOB_OPTIONS },
  };
}

module.exports = {
  DEFAULT_QUEUE_NAME,
  DEFAULT_SCHEDULER_ID,
  FORBIDDEN_JOB_OPTIONS,
  JOB_DATA_VERSION,
  JOB_NAMES,
  MIGRATION_JOB_OPTIONS,
  buildMigrationJob,
  buildSyncJobTemplate,
  dedupId,
  isPlainObject,
  migrationJobOptions,
  parseJobData,
};
