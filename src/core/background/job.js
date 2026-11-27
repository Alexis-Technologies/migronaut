const { ChecksumMismatchError, TransactionsUnsupportedError } = require('../../errors/index.js');
const { buildVersionIndexKey } = require('../../versioning/document.js');
const { excludeBadIds, matchOf } = require('./engine.js');
const { idRangePartitioner } = require('./partition.js');
const { createShardPartitioner, withShardKey } = require('./shard.js');
const { NAMESPACE_NOT_FOUND, READ_OPTIONS } = require('../server-info.js');
const { isUnauthorized } = require('../../utils/error.js');
const { buildShardedVersionIndexKey } = require('../converge/versioning-spec.js');

/**
 * What one background migration runs as: its job (`loadJob` — the spec, the
 * functions, the match, the partitioner the live indexes and the shard key
 * call for) and whether a plan still fits it (`planMismatch`).
 *
 * Pure orchestration over what the kit injects (`deps`):
 * `{ db, client, store, logger, fields, emit, lockFor(name), load(name),
 * ttlMs, now?, adaptiveCache?, indexCache?, shardKeyCache?, lagWaits?, warned? }` —
 * `load(name)` resolves the migration file to `{ spec, fns, checksum }`;
 * `lockFor(name)` is the coordinator's `MigrationLock` (`background:<name>`),
 * held only for one step.
 *
 * Every step is idempotent and starts from what MongoDB says, so any number
 * of coordinators and lanes, in any number of processes, may run at once:
 * the coordinator lock serializes the steps, a compare-and-set on the plan
 * token keeps a stale plan from committing, and the leases cap the lanes.
 */

/**
 * How long a collection's index keys are reused (`deps.indexCache`): every
 * slice plans its reads by them, and indexes change on a deploy, not a batch.
 */
const INDEX_CACHE_MS = 30_000;

/** What a lane's control read needs of the state */
const CONTROL_FIELDS = Object.freeze({ status: 1, generation: 1, 'plan.token': 1 });

/** What frequent readers of every state leave out — the history and the document errors */
const STATE_SUMMARY = Object.freeze({ history: 0, docErrors: 0 });

/** What a degraded plan means, for its warning */
const DEGRADED = {
  __proto__: null,
  'sample-timeout': 'the sample ran out of time — some ranges stay whole this pass (fewer lanes)',
  ungrouped:
    'more runs of chunks than maxPartitions — merged blocks span shards and are not capped by ' +
    'shardConcurrency',
};

/** How long a coordinator waits before it looks at its lanes again, without a driver that wakes it */
const POLL_MS = 5_000;

/** What a replan says, by what set the plan aside */
const REPLAN_REASONS = {
  partitioner: 'its plan was split another way than this collection is read now',
  epoch: 'it was resharded since its plan',
};

/** What a coordinator says when a plan, a lock or a deploy is in the way */
const retrySoon = (deps, reason) => {
  return {
    next: 'wait',
    reason,
    retryAfterMs: Math.max(1, Math.floor(deps.ttlMs / 2)),
  };
};

/**
 * The keys of a collection's indexes — none for one that does not exist yet,
 * or whose indexes this user may not list. Any other failure is thrown: "the
 * list could not be read" must not pass for "there is no index", or one blip
 * would have a lane give up the version index — and its partitioner with it.
 */
const readIndexKeys = async (deps, collection) => {
  const cache = deps.indexCache;
  const hit = cache?.get(collection);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < INDEX_CACHE_MS) return hit.keys;
  let indexes = null;
  try {
    indexes = await deps.db.collection(collection).listIndexes(READ_OPTIONS).toArray();
  } catch (error) {
    if (error?.code === NAMESPACE_NOT_FOUND || isUnauthorized(error)) return [];
    throw error;
  }
  const keys = [];
  for (const index of indexes) keys.push(index.key);
  cache?.set(collection, { at: now, keys });
  return keys;
};

/**
 * A collection's shard key as `deps.shardKeyOf` reads it — reused like its
 * index keys (`deps.shardKeyCache`): every slice, every coordinator step and
 * every watcher job asks, and each answer is a read of `config.collections`
 * through the mongos. A reshard is noticed within the same half minute.
 */
const loadShardKey = async (deps, collection) => {
  const cache = deps.shardKeyCache;
  const hit = cache?.get(collection);
  const now = Date.now();
  if (hit !== undefined && now - hit.at < INDEX_CACHE_MS) return hit.sharding;
  const sharding = await deps.shardKeyOf(collection);
  cache?.set(collection, { at: now, sharding });
  return sharding;
};

/** Whether a live index key is `wanted` — same fields, same order, same directions or `hashed` */
const isSameIndexKey = (live, wanted) => {
  const a = Object.keys(live);
  const b = Object.keys(wanted);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
    const x = live[a[i]];
    const y = wanted[b[i]];
    if (x === 'hashed' || y === 'hashed' ? x !== y : Number(x) !== Number(y)) return false;
  }
  return true;
};

const hasIndex = (keys, wanted) => {
  for (let i = 0; i < keys.length; i++) if (isSameIndexKey(keys[i], wanted)) return true;
  return false;
};

/**
 * What a drift probe hints: the version index — or, on a sharded collection,
 * the version index that carries the shard key (any index led by the version
 * field ascending serves an equality probe on it).
 */
const probeHint = async (deps, spec) => {
  const keys = await readIndexKeys(deps, spec.collection);
  const exact = buildVersionIndexKey(spec);
  if (hasIndex(keys, exact)) return exact;
  for (const key of keys) {
    const first = Object.keys(key)[0];
    if (first !== undefined && first === spec.field && Number(key[first]) === 1) return key;
  }
  return findVersionHint(deps, spec, keys);
};

/** Say something once per process — `deps.warned` remembers */
const warnOnce = (deps, id, message, fields) => {
  if (deps.warned?.has(id)) return;
  deps.warned?.add(id);
  deps.logger.warn(message, deps.fields(fields));
};

/** The version index of a collection, when it has one — every scan hints it */
const findVersionHint = async (deps, spec, keys) => {
  if (spec.mode === 'step') return undefined;
  const key = buildVersionIndexKey(spec);
  if (hasIndex(keys ?? (await readIndexKeys(deps, spec.collection)), key)) return key;
  warnOnce(
    deps,
    `index:${spec.collection}`,
    `⚠ ${spec.collection} has no { ${spec.field}: 1, _id: 1 } index — background migrations ` +
      'over it scan the collection (declare versioning in its definition and converge)',
    { collection: spec.collection },
  );
  return undefined;
};

/**
 * A transactional background migration needs a replica set or a mongos —
 * checked once per process (`deps.topology()` caches the answer).
 *
 * @throws {TransactionsUnsupportedError} on a standalone server
 */
const assertTransactions = async (deps, name, spec) => {
  if (!spec.transaction || typeof deps.topology !== 'function') return;
  if ((await deps.topology()) === 'standalone') {
    throw new TransactionsUnsupportedError(
      `Background migration ${name} asks for transactions, which need a replica set or a ` +
        'mongos — this server is standalone (run it with transaction: false)',
      { context: { migration: name, background: true } },
    );
  }
};

/** The job a lane or a coordinator works with: the spec, the functions, and what they scan */
const loadJob = async (deps, name, state, { direction } = {}) => {
  // The state's spec wins below: a definition file broken since the
  // registration must not stop its lanes (`tolerant`).
  const loaded = await deps.load(name, { tolerant: true });
  if (state.checksum !== undefined && loaded.checksum !== state.checksum) {
    throw new ChecksumMismatchError(
      `Background migration ${name} changed on disk since it was registered — finish the ` +
        'deploy, or pin the new version (migronaut background repin)',
      {
        context: {
          migration: name,
          background: true,
          expected: state.checksum,
          actual: loaded.checksum,
        },
      },
    );
  }
  const spec = { ...loaded.spec, ...state.spec };
  const resolvedDirection = direction ?? state.direction ?? 'forward';
  const match =
    spec.mode === 'step'
      ? undefined
      : excludeBadIds(matchOf(spec, resolvedDirection), state.badIds);
  const { partitioner, hint, sharding } = await choosePartitioner(
    deps,
    spec,
    resolvedDirection,
    state.plan?.partitioner,
  );
  // One shape for every job, its every field set here: the engine reads it
  // for each document. What a lane learns as it works — the state's
  // generation, the partition, the lease's signal — starts undefined, as
  // `ctx.background` and `ctx.signal` have always shown it before a lane.
  return {
    name,
    spec,
    fns: loaded.fns,
    direction: resolvedDirection === 'revert' ? 'revert' : 'forward',
    match,
    partitioner,
    hint,
    sharding,
    logger: deps.logger,
    // For ctx.background and ctx.logger: the lane working it and its queue job
    // (with its group when a run drives it inline).
    logs: deps.logs ?? null,
    runId: deps.runId,
    jobId: deps.job?.id,
    groupId: deps.job?.groupId,
    generation: undefined,
    partitionId: undefined,
    signal: undefined,
  };
};

/**
 * How a background migration's collection is split: along the shard key on
 * a sharded collection whose key can be read and whose version index carries
 * it (`sharding.mode` `chunks` or `sampled`, decided at plan time), by `_id`
 * everywhere else — `untargeted` when the collection is sharded but that is
 * all that is known, said once per process. `backgroundShardAware: 'off'`
 * keeps every collection on `_id`.
 *
 * `planned` is the partitioner the plan in force was made with. A topology
 * that could not be read (a `hello` lost to an election) is no answer: a
 * plan along the shard key says the collection is sharded, and is believed —
 * taking "unknown" for "not sharded" would hand its key ranges to the `_id`
 * partitioner, which reads a key range as "everything".
 */
const choosePartitioner = async (deps, spec, direction, planned) => {
  const keys = spec.mode === 'step' ? [] : await readIndexKeys(deps, spec.collection);
  const byId = async (mode) => {
    return {
      partitioner: idRangePartitioner,
      hint: await findVersionHint(deps, spec, keys),
      sharding: { mode },
    };
  };
  if (spec.mode === 'step' || deps.shardAware === 'off' || deps.shardKeyOf === undefined) {
    return byId('off');
  }
  const topology = await deps.topology?.();
  const isSharded = topology === 'sharded' || (topology === undefined && planned === 'shard');
  if (!isSharded) return byId('off');
  const sharding = await loadShardKey(deps, spec.collection);
  if (sharding === null) return byId('off');
  const where = { background: spec.collection, collection: spec.collection };
  if (sharding === undefined) {
    warnOnce(
      deps,
      `shard:${spec.collection}:privileges`,
      `⚠ ${spec.collection}: its shard key cannot be read (config needs clusterMonitor) — ` +
        'background migrations over it are not shard-aware',
      where,
    );
    return byId('untargeted');
  }
  const indexKey = buildShardedVersionIndexKey(spec, sharding.key);
  if (!hasIndex(keys, indexKey)) {
    // The key is known: writes are still targeted, and the guard holds.
    const untargeted = await byId('untargeted');
    warnOnce(
      deps,
      `shard:${spec.collection}:index`,
      `⚠ ${spec.collection} is sharded but has no ${JSON.stringify(indexKey)} index — ` +
        'background migrations over it are not shard-aware (declare versioning in its ' +
        'definition and converge)',
      where,
    );
    return {
      ...untargeted,
      partitioner: withShardKey(idRangePartitioner, sharding.key),
      sharding: { mode: 'untargeted', key: sharding.key },
    };
  }
  return {
    partitioner: createShardPartitioner({
      key: sharding.key,
      field: spec.field,
      source: direction === 'revert' ? spec.to : spec.from,
      readChunks: () => deps.chunksOf(spec.collection, sharding),
      epoch: sharding,
    }),
    hint: indexKey,
    sharding: { mode: 'shard', key: sharding.key },
  };
};

/** The partitioner a job would plan with now, as a plan records it */
const resolvePartitionerId = (job) => (job.spec.mode === 'step' ? 'step' : job.partitioner.id);

/**
 * Why a plan cannot be worked by this job any more, or `undefined`:
 * - `partitioner` — it was split by the other partitioner. The version index
 *   that carries the shard key appeared (or went) since, the shard key became
 *   readable (or stopped being), or `backgroundShardAware` changed. Its scopes
 *   are the other one's: a key range means nothing to the `_id` partitioner,
 *   and an `_id` range has no bounds for the shard-aware one;
 * - `epoch` — the collection was resharded, or its key refined.
 *
 * Either way the same pass is split again — safe: the version filter skips
 * what is done. A plan that names no partitioner is taken as it is.
 */
const planMismatch = (job, plan) => {
  if (plan === undefined) return undefined;
  if (plan.partitioner !== undefined && plan.partitioner !== resolvePartitionerId(job)) {
    return 'partitioner';
  }
  return job.partitioner.stale?.(plan.epoch) ? 'epoch' : undefined;
};

/** The shard-aware facts a plan records, for status: how it split, by which key, into how many groups */
const describeSharding = (job, plan) => {
  if (job.sharding === undefined || job.sharding.mode === 'off') return null;
  if (job.sharding.mode === 'untargeted') {
    return { mode: 'untargeted', ...(job.sharding.key ? { key: job.sharding.key } : {}) };
  }
  const groups = new Set();
  for (const partition of plan.partitions) {
    if (partition.group !== undefined) groups.add(partition.group);
  }
  return { mode: plan.method, key: job.sharding.key, groups: groups.size };
};

module.exports = {
  CONTROL_FIELDS,
  STATE_SUMMARY,
  DEGRADED,
  POLL_MS,
  REPLAN_REASONS,
  retrySoon,
  probeHint,
  warnOnce,
  findVersionHint,
  assertTransactions,
  loadJob,
  choosePartitioner,
  planMismatch,
  describeSharding,
};
