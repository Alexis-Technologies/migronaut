const { ConfigInvalidError, QueueJobInvalidError } = require('../errors/index.js');
const { actorIssue, pickActor } = require('../utils/actor.js');
const { MAX_ID_LENGTH } = require('../utils/id.js');
const { isBareFilename } = require('../utils/migration-name.js');

/**
 * The job contract between whoever enqueues migrations and the worker that
 * runs them. Versioned (`v`), because the two can be different deploys of the
 * same service.
 *
 * The rules (ARCHITECTURE §6.6):
 * - a producer writes `JOB_DATA_VERSION`; a worker accepts every version from
 *   `MIN_JOB_DATA_VERSION` up to its own, so jobs already queued survive an
 *   upgrade of the workers;
 * - a field the worker does not know is refused, never ignored — a meaning it
 *   cannot honour must not be dropped silently. So any new field that changes
 *   what a job does bumps `JOB_DATA_VERSION`, and workers are rolled out
 *   before the producers that write it (an older worker fails a newer job as
 *   QUEUE_JOB_INVALID rather than guessing);
 * - `MIN_JOB_DATA_VERSION` only moves in a major release.
 */
const JOB_DATA_VERSION = 1;
const MIN_JOB_DATA_VERSION = 1;

/**
 * One job name per kind of work — `up`/`down` carry one migration each, `sync`
 * plans and enqueues what is pending, `converge` brings the declared
 * collections to their declared state. The background names live on a queue
 * of their own (`<queueName>-background`): `background` is a background
 * migration's coordinator, `background-lane` one of its lanes (a child of the
 * coordinator), `background-verify` the drift watch.
 */
const JOB_NAMES = Object.freeze({
  UP: 'up',
  DOWN: 'down',
  SYNC: 'sync',
  CONVERGE: 'converge',
  BACKGROUND: 'background',
  BACKGROUND_LANE: 'background-lane',
  BACKGROUND_VERIFY: 'background-verify',
});

const DEFAULT_QUEUE_NAME = 'migronaut';
/** No `:` — BullMQ rejects it in custom ids */
const DEFAULT_SCHEDULER_ID = 'migronaut-sync';
const DEFAULT_CONVERGE_SCHEDULER_ID = 'migronaut-converge';
const DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID = 'migronaut-background-verify';
/** The background queue is named after the migration queue it serves */
const BACKGROUND_QUEUE_SUFFIX = '-background';

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

/**
 * Refused in a background queue's `jobOptions` too: what a coordinator or a
 * lane does when its children fail is the adapter's design, not a knob.
 */
const BACKGROUND_FORBIDDEN_JOB_OPTIONS = Object.freeze([
  ...FORBIDDEN_JOB_OPTIONS,
  'failParentOnFailure',
  'continueParentOnFailure',
  'ignoreDependencyOnFailure',
  'removeDependencyOnFailure',
]);

const MAX_MIGRATION_NAME_LENGTH = 255;
/** At most this many lanes — a background migration's `maxParallel` cap */
const MAX_LANES = 64;
/** A file checksum as migronaut computes it: a SHA-256 hex digest */
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

/** Every field a job of each kind may carry — anything else is refused */
const JOB_FIELDS = Object.freeze({
  migration: new Set([
    'v',
    'direction',
    'migration',
    'groupId',
    'index',
    'total',
    'batch',
    'force',
    'ordered',
    'checksum',
    'requestedBy',
    'reason',
  ]),
  sync: new Set(['v', 'kind', 'to']),
  converge: new Set(['v', 'kind', 'groupId', 'ordered', 'requestedBy', 'reason']),
  background: new Set([
    'v',
    'kind',
    'migration',
    'round',
    'spawn',
    'takeover',
    'requestedBy',
    'reason',
  ]),
  'background-lane': new Set([
    'v',
    'kind',
    'migration',
    'registration',
    'generation',
    'round',
    'spawn',
    'lane',
    'retry',
  ]),
  'background-verify': new Set(['v', 'kind']),
});
/** The limit every migronaut id is minted under — a producer's own check and this one agree */
const MAX_GROUP_ID_LENGTH = MAX_ID_LENGTH;

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * A migration name as an id fragment: letters, digits, `.`, `_` and `-` as
 * they are; every other character as `~` and its UTF-8 bytes in hex (`a b.js`
 * → `a~20b.js`). Reversible on purpose — two names must never share a
 * fragment, or the second file's job would be absorbed as a duplicate of the
 * first's.
 */
function idFragment(migration) {
  return migration.replace(/[^A-Za-z0-9._-]/gu, (char) => {
    let encoded = '';
    for (const byte of Buffer.from(char, 'utf8')) {
      encoded += `~${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return encoded;
  });
}

/**
 * Deduplication id for one migration in one direction. BullMQ holds the key
 * only while that job is waiting or active, so a second enqueue of the same
 * pending file is absorbed, yet a later down → up cycle is never blocked —
 * which a custom `jobId` would do for as long as the finished job is retained.
 */
function dedupId(direction, migration, { force = false } = {}) {
  // A forced re-run is a request of its own: a plain job for the same file
  // still waiting must not absorb it. (`~force` can never be part of a
  // fragment — there `~` is always followed by two upper-case hex digits.)
  return `${direction}${force ? '~force' : ''}-${idFragment(migration)}`;
}

/**
 * Deduplication id for a converge job, keyed on the migration it follows. Two
 * pods enqueueing the same deploy collapse into one converge; a later, longer
 * deploy gets its own at its own tail — sharing one id would fold it into an
 * earlier converge that sits in front of the new migrations, and nothing would
 * converge after them.
 */
function convergeDedupId(after) {
  return after === undefined ? 'converge' : `converge-after-${idFragment(after)}`;
}

const isGroupId = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_GROUP_ID_LENGTH;

/**
 * What a worker accepts from the queue by default. Anything that can write to
 * Redis can enqueue, so the requests a payload can make that go beyond "apply
 * what is pending, in order" are opt-in: re-running an applied migration
 * (`force`) and skipping the order guard (`ordered: false`). A rollback is
 * allowed — it is the queue's other everyday job — but can be switched off.
 */
const DEFAULT_ALLOW = Object.freeze({ down: true, force: false, unordered: false });

/** Validate an `allow` option and fill in the defaults */
function resolveAllow(allow) {
  if (allow === undefined) return DEFAULT_ALLOW;
  if (!isPlainObject(allow)) {
    throw new ConfigInvalidError('allow must be an object', { allow: typeof allow });
  }
  for (const key of Object.keys(allow)) {
    if (!(key in DEFAULT_ALLOW)) {
      throw new ConfigInvalidError(
        `allow.${key} is not a known permission (down, force, unordered)`,
        { key },
      );
    }
    if (typeof allow[key] !== 'boolean') {
      throw new ConfigInvalidError(`allow.${key} must be a boolean`, { [key]: allow[key] });
    }
  }
  return Object.freeze({ ...DEFAULT_ALLOW, ...allow });
}

/** The permissions a parsed job (or an enqueue request) needs: `'down'`, `'force'`, `'unordered'` */
function permissionsNeeded(data) {
  const needed = [];
  if (data.kind === 'migration' && data.direction === JOB_NAMES.DOWN) needed.push('down');
  if (data.force) needed.push('force');
  if (data.ordered === false) needed.push('unordered');
  return needed;
}

/** Refuse a well-formed job this worker is not allowed to run */
function assertAllowed(job, data, allow) {
  for (const permission of permissionsNeeded(data)) {
    if (!allow[permission]) {
      throw new QueueJobInvalidError(
        `Refused migration job: ${permission === 'unordered' ? 'ordered: false' : permission} ` +
          `is not allowed by this worker (allow.${permission})`,
        {
          ...(job?.id !== undefined ? { jobId: String(job.id) } : {}),
          issue: 'not allowed',
          permission,
        },
      );
    }
  }
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
  if (
    name !== JOB_NAMES.UP &&
    name !== JOB_NAMES.DOWN &&
    name !== JOB_NAMES.SYNC &&
    name !== JOB_NAMES.CONVERGE
  ) {
    throw invalid(job, 'unknown job name');
  }
  if (!isPlainObject(data)) throw invalid(job, 'data is not an object');
  if (!Number.isSafeInteger(data.v) || data.v < MIN_JOB_DATA_VERSION) {
    throw invalid(job, 'unsupported job data version');
  }
  if (data.v > JOB_DATA_VERSION) {
    throw invalid(
      job,
      `job data version ${data.v} is newer than this worker supports (${JOB_DATA_VERSION}) — ` +
        'roll the workers out before the producers',
    );
  }
  const kind = name === JOB_NAMES.SYNC || name === JOB_NAMES.CONVERGE ? name : 'migration';
  for (const key of Object.keys(data)) {
    if (!JOB_FIELDS[kind].has(key)) {
      throw invalid(
        job,
        key === 'prune'
          ? "prune is not accepted from a job — the worker's own definitions decide"
          : `unknown field "${key}"`,
      );
    }
  }
  for (const key of ['requestedBy', 'reason']) {
    const issue = actorIssue(key, data[key]);
    if (issue) throw invalid(job, issue);
  }

  if (name === JOB_NAMES.SYNC) {
    if (data.to !== undefined && !isBareFilename(data.to)) {
      throw invalid(job, 'to is not a bare filename');
    }
    return { kind: 'sync', ...(data.to !== undefined ? { to: data.to } : {}) };
  }

  if (name === JOB_NAMES.CONVERGE) {
    // No `prune`, by design: what may be dropped is decided by the
    // definitions the worker loads, never by a payload sitting in Redis.
    if (data.groupId !== undefined && !isGroupId(data.groupId)) {
      throw invalid(job, 'groupId is not a short string');
    }
    if (data.ordered !== undefined && typeof data.ordered !== 'boolean') {
      throw invalid(job, 'ordered is not a boolean');
    }
    return {
      kind: 'converge',
      ...(data.groupId !== undefined ? { groupId: data.groupId } : {}),
      ...(data.ordered !== undefined ? { ordered: data.ordered } : {}),
      ...pickActor(data),
    };
  }

  if (data.direction !== name) throw invalid(job, 'direction does not match the job name');
  if (!isBareFilename(data.migration) || data.migration.length > MAX_MIGRATION_NAME_LENGTH) {
    throw invalid(job, 'migration is not a bare filename');
  }
  if (!isGroupId(data.groupId)) {
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
  if (
    data.checksum !== undefined &&
    !(typeof data.checksum === 'string' && CHECKSUM_PATTERN.test(data.checksum))
  ) {
    throw invalid(job, 'checksum is not a SHA-256 hex digest');
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
    ...(data.checksum !== undefined ? { checksum: data.checksum } : {}),
    ...pickActor(data),
  };
}

/** The version and field checks every job shares — then the fields of `kind` */
function assertEnvelope(job, kind) {
  const { data } = job;
  if (!isPlainObject(data)) throw invalid(job, 'data is not an object');
  if (!Number.isSafeInteger(data.v) || data.v < MIN_JOB_DATA_VERSION) {
    throw invalid(job, 'unsupported job data version');
  }
  if (data.v > JOB_DATA_VERSION) {
    throw invalid(
      job,
      `job data version ${data.v} is newer than this worker supports (${JOB_DATA_VERSION}) — ` +
        'roll the workers out before the producers',
    );
  }
  if (data.kind !== kind) throw invalid(job, 'kind does not match the job name');
  for (const key of Object.keys(data)) {
    if (!JOB_FIELDS[kind].has(key)) throw invalid(job, `unknown field "${key}"`);
  }
}

/**
 * Validate a job read back from a background queue and return a normalized
 * copy — as untrusted as any other: the migration name becomes a path.
 */
function parseBackgroundJobData(job) {
  if (!isPlainObject(job)) throw invalid(job, 'job is not an object');
  const { name } = job;
  if (
    name !== JOB_NAMES.BACKGROUND &&
    name !== JOB_NAMES.BACKGROUND_LANE &&
    name !== JOB_NAMES.BACKGROUND_VERIFY
  ) {
    throw invalid(job, 'unknown background job name');
  }
  assertEnvelope(job, name);
  const { data } = job;
  if (name === JOB_NAMES.BACKGROUND_VERIFY) return { kind: name };
  if (!isBareFilename(data.migration) || data.migration.length > MAX_MIGRATION_NAME_LENGTH) {
    throw invalid(job, 'migration is not a bare filename');
  }
  for (const key of ['round', 'spawn', 'generation', 'retry']) {
    if (data[key] !== undefined && !isCount(data[key])) {
      throw invalid(job, `${key} is not a non-negative integer`);
    }
  }
  if (name === JOB_NAMES.BACKGROUND) {
    for (const key of ['requestedBy', 'reason']) {
      const issue = actorIssue(key, data[key]);
      if (issue) throw invalid(job, issue);
    }
    if (data.takeover !== undefined && data.takeover !== true) {
      throw invalid(job, 'takeover is only valid as `true`');
    }
    return {
      kind: name,
      migration: data.migration,
      ...(data.round !== undefined ? { round: data.round } : {}),
      ...(data.spawn !== undefined ? { spawn: data.spawn } : {}),
      ...(data.takeover ? { takeover: true } : {}),
      ...pickActor(data),
    };
  }
  if (!isGroupId(data.registration)) throw invalid(job, 'registration is not a short string');
  for (const key of ['generation', 'round', 'spawn']) {
    if (data[key] === undefined) throw invalid(job, `${key} is missing`);
  }
  if (!Number.isSafeInteger(data.lane) || data.lane < 0 || data.lane >= MAX_LANES) {
    throw invalid(job, `lane is not an integer from 0 to ${MAX_LANES - 1}`);
  }
  return {
    kind: name,
    migration: data.migration,
    registration: data.registration,
    generation: data.generation,
    round: data.round,
    spawn: data.spawn,
    lane: data.lane,
    retry: data.retry ?? 0,
  };
}

/**
 * Build one `up`/`down` job spec, ready for `queue.addBulk`. `ordered` is
 * always written: a job must say how it is to run, not leave it to whatever
 * default the worker that picks it up was configured with.
 */
function buildMigrationJob({
  direction,
  migration,
  groupId,
  index,
  total,
  batch,
  force,
  ordered = true,
  checksum,
  requestedBy,
  reason,
}) {
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
      ordered: ordered !== false,
      ...(checksum !== undefined ? { checksum } : {}),
      ...pickActor({ requestedBy, reason }),
    },
  };
}

/** Per-job options: the caller's passthrough, then the ones the contract owns */
function migrationJobOptions(jobOptions, direction, migration, { force = false } = {}) {
  return {
    ...jobOptions,
    ...MIGRATION_JOB_OPTIONS,
    deduplication: { id: dedupId(direction, migration, { force }) },
  };
}

/**
 * A converge job spec, ready for `queue.addBulk`: the tail of an `up` group
 * (`after` = its last migration), or a converge of its own. `ordered: false`
 * skips the "nothing may be pending" guard; like a migration job's, it is
 * always written.
 */
function buildConvergeJob({ groupId, ordered, after, jobOptions, requestedBy, reason } = {}) {
  return {
    name: JOB_NAMES.CONVERGE,
    data: {
      v: JOB_DATA_VERSION,
      kind: 'converge',
      ...(groupId !== undefined ? { groupId } : {}),
      ordered: ordered !== false,
      ...pickActor({ requestedBy, reason }),
    },
    opts: {
      ...jobOptions,
      ...MIGRATION_JOB_OPTIONS,
      deduplication: { id: convergeDedupId(after) },
    },
  };
}

/**
 * How many finished scheduler ticks are kept when the caller's `jobOptions`
 * say nothing. BullMQ keeps every finished job by default, and a schedule
 * mints one per tick forever — `every: 60_000` alone is 1,440 jobs a day, in
 * a Redis that usually runs with `noeviction`.
 */
const TICK_RETENTION = Object.freeze({
  removeOnComplete: Object.freeze({ count: 100 }),
  removeOnFail: Object.freeze({ count: 500 }),
});

/**
 * The options every scheduler tick carries: the caller's `jobOptions`
 * (retention, logging), a bounded retention where they set none, the
 * contract's own options, and `omitContext` — which keeps the tick out of
 * whatever trace registered the schedule: BullMQ builds each iteration from
 * the previous job's options, so a trace context stored there would be
 * inherited by every tick after it, and one trace would grow for as long as
 * the schedule lives. Each tick starts its own instead; the migrations it
 * enqueues still hang under it. A no-op for a queue without telemetry.
 */
function tickJobOptions(jobOptions = {}) {
  return {
    removeOnComplete: TICK_RETENTION.removeOnComplete,
    removeOnFail: TICK_RETENTION.removeOnFail,
    ...jobOptions,
    ...MIGRATION_JOB_OPTIONS,
    telemetry: { ...jobOptions.telemetry, omitContext: true },
  };
}

/** The job a scheduler tick produces: plan what is pending, enqueue it */
function buildSyncJobTemplate({ to, jobOptions } = {}) {
  return {
    name: JOB_NAMES.SYNC,
    data: { v: JOB_DATA_VERSION, kind: 'sync', ...(to !== undefined ? { to } : {}) },
    opts: tickJobOptions(jobOptions),
  };
}

/** The job a converge schedule produces — a tick like the `sync` one */
function buildConvergeJobTemplate({ jobOptions } = {}) {
  return {
    name: JOB_NAMES.CONVERGE,
    data: { v: JOB_DATA_VERSION, kind: 'converge' },
    opts: tickJobOptions(jobOptions),
  };
}

/** The background queue that serves a migration queue */
function backgroundQueueName(queueName) {
  return `${queueName}${BACKGROUND_QUEUE_SUFFIX}`;
}

/**
 * Options of a background queue's own jobs: the caller's passthrough, then a
 * bounded retention where they set none — a lane per partition per spawn adds
 * up — then what the contract owns.
 */
function backgroundJobOptions(jobOptions = {}, owned = {}) {
  return {
    removeOnComplete: TICK_RETENTION.removeOnComplete,
    removeOnFail: TICK_RETENTION.removeOnFail,
    ...jobOptions,
    ...owned,
  };
}

/**
 * The coordinator job of a background migration. Deduplicated on its name, so
 * every pod's heal and every sync tick collapse into the one coordinator
 * chain that is alive (waiting, delayed or waiting for its lanes); a takeover
 * of a stalled one gets an id of its own per round. A few attempts with a long
 * backoff are the outer safety net — what it decides is all in MongoDB.
 */
function buildBackgroundJob({ migration, takeoverOf, jobOptions, requestedBy, reason }) {
  const fragment = idFragment(migration);
  return {
    name: JOB_NAMES.BACKGROUND,
    data: {
      v: JOB_DATA_VERSION,
      kind: JOB_NAMES.BACKGROUND,
      migration,
      ...(takeoverOf !== undefined ? { takeover: true } : {}),
      ...pickActor({ requestedBy, reason }),
    },
    opts: backgroundJobOptions(jobOptions, {
      attempts: 3,
      backoff: { type: 'fixed', delay: 30_000 },
      deduplication: {
        id: takeoverOf === undefined ? `bg-${fragment}` : `bg-${fragment}-t${takeoverOf}`,
      },
    }),
  };
}

/**
 * One lane of a background migration. Under a coordinator (`parent`) its id
 * must be new for every spawn — BullMQ will not move an existing job to
 * another parent, and a job it already finished would never wake this one;
 * with no parent (`children: false`) the id is deduplicated per lane slot.
 */
function buildLaneJob({
  migration,
  registration,
  generation,
  round,
  spawn,
  lane,
  parent,
  jobOptions,
}) {
  const base = `bgl-${idFragment(migration)}-${idFragment(registration)}-g${generation}`;
  return {
    name: JOB_NAMES.BACKGROUND_LANE,
    data: {
      v: JOB_DATA_VERSION,
      kind: JOB_NAMES.BACKGROUND_LANE,
      migration,
      registration,
      generation,
      round,
      spawn,
      lane,
    },
    opts: backgroundJobOptions(
      jobOptions,
      parent === undefined
        ? { attempts: 1, deduplication: { id: `${base}-l${lane}` } }
        : {
            attempts: 1,
            jobId: `${base}-r${round}-s${spawn}-l${lane}`,
            parent,
            // A lane that fails still wakes its coordinator — which decides
            // from MongoDB, never from how its lanes ended.
            ignoreDependencyOnFailure: true,
          },
    ),
  };
}

/** The job a drift-watch schedule produces — a tick like the `sync` one */
function buildBackgroundVerifyJobTemplate({ jobOptions } = {}) {
  return {
    name: JOB_NAMES.BACKGROUND_VERIFY,
    data: { v: JOB_DATA_VERSION, kind: JOB_NAMES.BACKGROUND_VERIFY },
    opts: tickJobOptions(jobOptions),
  };
}

module.exports = {
  BACKGROUND_FORBIDDEN_JOB_OPTIONS,
  BACKGROUND_QUEUE_SUFFIX,
  DEFAULT_ALLOW,
  DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID,
  DEFAULT_CONVERGE_SCHEDULER_ID,
  DEFAULT_QUEUE_NAME,
  DEFAULT_SCHEDULER_ID,
  FORBIDDEN_JOB_OPTIONS,
  JOB_DATA_VERSION,
  JOB_FIELDS,
  JOB_NAMES,
  MIN_JOB_DATA_VERSION,
  MIGRATION_JOB_OPTIONS,
  TICK_RETENTION,
  MAX_LANES,
  assertAllowed,
  backgroundQueueName,
  buildBackgroundJob,
  buildBackgroundVerifyJobTemplate,
  buildConvergeJob,
  buildConvergeJobTemplate,
  buildMigrationJob,
  buildLaneJob,
  buildSyncJobTemplate,
  convergeDedupId,
  dedupId,
  idFragment,
  isPlainObject,
  migrationJobOptions,
  parseBackgroundJobData,
  parseJobData,
  permissionsNeeded,
  resolveAllow,
};
