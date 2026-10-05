const {
  BackgroundConflictError,
  BackgroundFailedError,
  ChecksumMismatchError,
  LockAlreadyHeldError,
  LockLostError,
  MigronautError,
  TransactionsUnsupportedError,
} = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { versionIndexKey } = require('../versioning/document.js');
const { matchOf, processPartition } = require('./background-engine.js');
const { idRangePartitioner } = require('./background-partition.js');
const { createShardPartitioner } = require('./background-shard.js');
const { TERMINAL, matchHash, transition } = require('./background-spec.js');
const { MAX_BAD_IDS, STATE_SCHEMA } = require('./background-store.js');
const { createAdaptive, createThrottle } = require('./background-throttle.js');
const { runWithLock } = require('./lock.js');
const { READ_OPTIONS } = require('./server-info.js');
const { shardedVersionIndexKey } = require('./versioning-spec.js');

/**
 * Background migrations, orchestrated: the coordinator's steps (plan the
 * partitions, wait for the lanes, finalize a pass), a lane's slice over the
 * partitions, and the controls (pause, resume, cancel, retry, repin).
 *
 * Pure orchestration over what the kit injects (`deps`):
 * `{ db, client, store, logger, fields, emit, lockFor(name), load(name),
 * ttlMs, now?, adaptiveCache?, warned? }` — `load(name)` resolves the
 * migration file to `{ spec, fns, checksum }`; `lockFor(name)` is the
 * coordinator's `MigrationLock` (`background:<name>`), held only for one step.
 *
 * Every step is idempotent and starts from what MongoDB says, so any number
 * of coordinators and lanes, in any number of processes, may run at once:
 * the coordinator lock serializes the steps, a compare-and-set on the plan
 * token keeps a stale plan from committing, and the leases cap the lanes.
 */

/** How long a coordinator waits before it looks at its lanes again, without a driver that wakes it */
const POLL_MS = 5_000;

/** What a coordinator says when a plan, a lock or a deploy is in the way */
const retrySoon = (deps, reason) => ({
  next: 'wait',
  reason,
  retryAfterMs: Math.max(1, Math.floor(deps.ttlMs / 2)),
});

/** The keys of a collection's indexes — none for one that does not exist yet */
async function indexKeys(deps, collection) {
  try {
    const indexes = await deps.db.collection(collection).listIndexes(READ_OPTIONS).toArray();
    const keys = [];
    for (const index of indexes) keys.push(index.key);
    return keys;
  } catch {
    return [];
  }
}

/** Whether a live index key is `wanted` — same fields, same order, same directions or `hashed` */
function sameIndexKey(live, wanted) {
  const a = Object.entries(live);
  const b = Object.entries(wanted);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0]) return false;
    const [x, y] = [a[i][1], b[i][1]];
    if (x === 'hashed' || y === 'hashed' ? x !== y : Number(x) !== Number(y)) return false;
  }
  return true;
}

const hasIndex = (keys, wanted) => keys.some((key) => sameIndexKey(key, wanted));

/** Say something once per process — `deps.warned` remembers */
function warnOnce(deps, id, message, fields) {
  if (deps.warned?.has(id)) return;
  deps.warned?.add(id);
  deps.logger.warn(message, deps.fields(fields));
}

/** The version index of a collection, when it has one — every scan hints it */
async function versionHint(deps, spec, keys) {
  if (spec.mode === 'step') return undefined;
  const key = versionIndexKey(spec);
  if (hasIndex(keys ?? (await indexKeys(deps, spec.collection)), key)) return key;
  if (!deps.warned?.has(`index:${spec.collection}`)) {
    deps.warned?.add(`index:${spec.collection}`);
    deps.logger.warn(
      `⚠ ${spec.collection} has no { ${spec.field}: 1, _id: 1 } index — background migrations ` +
        'over it scan the collection (declare versioning in its definition and converge)',
      deps.fields({ collection: spec.collection }),
    );
  }
  return undefined;
}

/**
 * A transactional background migration needs a replica set or a mongos —
 * checked once per process (`deps.topology()` caches the answer).
 *
 * @throws {TransactionsUnsupportedError} on a standalone server
 */
async function assertTransactions(deps, name, spec) {
  if (!spec.transaction || typeof deps.topology !== 'function') return;
  if ((await deps.topology()) === 'standalone') {
    throw new TransactionsUnsupportedError(
      `Background migration ${name} asks for transactions, which need a replica set or a ` +
        'mongos — this server is standalone (run it with transaction: false)',
      { migration: name, background: true },
    );
  }
}

/** The job a lane or a coordinator works with: the spec, the functions, and what they scan */
async function jobFor(deps, name, state, { direction } = {}) {
  const loaded = await deps.load(name);
  if (state.checksum !== undefined && loaded.checksum !== state.checksum) {
    throw new ChecksumMismatchError(
      `Background migration ${name} changed on disk since it was registered — finish the ` +
        'deploy, or pin the new version (migronaut background repin)',
      { migration: name, background: true, expected: state.checksum, actual: loaded.checksum },
    );
  }
  const spec = { ...loaded.spec, ...(state.spec ?? {}) };
  const dir = direction ?? state.direction ?? 'forward';
  const badIds = state.badIds ?? [];
  const match =
    spec.mode === 'step'
      ? undefined
      : badIds.length > 0
        ? { $and: [matchOf(spec, dir), { _id: { $nin: badIds } }] }
        : matchOf(spec, dir);
  return {
    name,
    spec,
    fns: loaded.fns,
    direction: dir === 'revert' ? 'revert' : 'forward',
    match,
    ...(await partitionerFor(deps, spec, dir)),
    logger: deps.logger,
  };
}

/**
 * How a background migration's collection is split: along the shard key on
 * a sharded collection whose key can be read and whose version index carries
 * it (`sharding.mode` `chunks` or `sampled`, decided at plan time), by `_id`
 * everywhere else — `untargeted` when the collection is sharded but that is
 * all that is known, said once per process. `backgroundShardAware: 'off'`
 * keeps every collection on `_id`.
 */
async function partitionerFor(deps, spec, direction) {
  const keys = spec.mode === 'step' ? [] : await indexKeys(deps, spec.collection);
  const byId = async (mode) => ({
    partitioner: idRangePartitioner,
    hint: await versionHint(deps, spec, keys),
    sharding: { mode },
  });
  if (spec.mode === 'step' || deps.shardAware === 'off' || deps.shardKeyOf === undefined) {
    return byId('off');
  }
  if ((await deps.topology?.()) !== 'sharded') return byId('off');
  const sharding = await deps.shardKeyOf(spec.collection);
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
  const indexKey = shardedVersionIndexKey(spec, sharding.key);
  if (!hasIndex(keys, indexKey)) {
    warnOnce(
      deps,
      `shard:${spec.collection}:index`,
      `⚠ ${spec.collection} is sharded but has no ${JSON.stringify(indexKey)} index — ` +
        'background migrations over it are not shard-aware (declare versioning in its ' +
        'definition and converge)',
      where,
    );
    return byId('untargeted');
  }
  return {
    partitioner: createShardPartitioner({
      key: sharding.key,
      field: spec.field,
      source: direction === 'revert' ? spec.to : spec.from,
      readChunks: () => deps.chunksOf(spec.collection, sharding),
    }),
    hint: indexKey,
    sharding: { mode: 'shard', key: sharding.key },
  };
}

// ─── The coordinator ──────────────────────────────────────────────────────────

/**
 * One coordinator step, under the coordinator lock: whatever the state
 * needs next. Resolves to `{ next, … }`:
 * - `process` — lanes have work (`lanes`: how many could start now);
 * - `wait` — nothing to do yet (`retryAfterMs`): leases draining, a deploy
 *   in progress, a lost commit race;
 * - `done` — terminal, paused, or blocked (`status`);
 * - `busy` — another coordinator holds the lock;
 * - `superseded` — a newer BullMQ coordinator round took over.
 *
 * `driver`: `{ kind, ref?, round? }` — who runs this coordinator.
 */
async function coordinate(deps, name, { signal, driver = { kind: 'local' } } = {}) {
  const lock = deps.lockFor(name);
  try {
    return await runWithLock(lock, { logger: deps.logger, owner: deps.owner?.() }, (lockSignal) =>
      // The span opens once the lock is held: a busy coordinator makes none.
      withSpan(deps, 'coordinate', name, () =>
        coordinateStep(deps, name, { signal: anySignal(signal, lockSignal), driver }),
      ),
    );
  } catch (error) {
    if (error instanceof LockAlreadyHeldError) {
      return { next: 'busy', retryAfterMs: Math.max(1, Math.floor(lock.ttlMs / 2)) };
    }
    throw error;
  }
}

/** `fn` inside the kit's span for `kind` (`slice`, `coordinate`), when it gives one */
function withSpan(deps, kind, name, fn) {
  return typeof deps.span === 'function' ? deps.span(kind, name, fn) : fn();
}

/** A signal aborted when either is */
function anySignal(a, b) {
  if (!a) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}

async function coordinateStep(deps, name, { signal, driver }) {
  const { store } = deps;
  let state = await store.get(name);
  if (state === null) return { next: 'done', status: 'unregistered' };
  if (state.schema > STATE_SCHEMA) {
    return retrySoon(deps, 'newer-schema');
  }
  if (TERMINAL.has(state.status) || state.status === 'paused') {
    return { next: 'done', status: state.status };
  }
  if (state.status === 'blocked') {
    const unblocked = await tryUnblock(deps, state);
    if (!unblocked) return { next: 'done', status: 'blocked', waitsFor: state.waitsFor };
    state = unblocked;
  }

  // The newest round wins: an older BullMQ coordinator bows out.
  if (driver.round !== undefined) {
    const current = state.coordinator?.round;
    if (current !== undefined && driver.round < current) return { next: 'superseded' };
    await store.set(name, {
      coordinator: { kind: driver.kind, ref: driver.ref, round: driver.round, at: new Date() },
    });
  }

  let job;
  try {
    job = await jobFor(deps, name, state);
  } catch (error) {
    if (error instanceof ChecksumMismatchError || error?.code === 'MIGRATION_FILE_NOT_FOUND') {
      // Mid-deploy: an older or newer pod holds the other version of the file.
      deps.logger.warn(`⚠ ${errorText(error)}`, deps.fields({ background: name }));
      return retrySoon(deps, 'checksum');
    }
    throw error;
  }
  try {
    await assertTransactions(deps, name, job.spec);
  } catch (error) {
    // Not something a retry fixes: the deployment cannot do it.
    return failState(deps, state, error.message);
  }
  const hash = matchHash(job.spec, job.direction === 'revert' ? 'revert' : 'forward');

  for (let guard = 0; guard < job.spec.maxPasses + 2; guard++) {
    if (signal?.aborted) return retrySoon(deps, 'stopping');
    // A replan re-splits the same pass; it is not a new one.
    const replanning = state.phase === 'replan';
    if (replanning && state.plan !== undefined) {
      await store.supersede(name, { generation: state.generation, plan: state.plan.token });
      const leases = await store.leases(name);
      if (leases.live > 0) return retrySoon(deps, 'replan-draining');
      state =
        (await store.cas(name, { phase: 'replan' }, { $set: { phase: 'partition' } })) ?? state;
    }
    if (state.phase !== 'process' || state.plan === undefined || state.plan.match !== hash) {
      const planned = await planPass(deps, job, state, hash, { newPass: !replanning });
      if (planned.next) return planned;
      state = planned.state;
      if (planned.empty) {
        const finalized = await finalize(deps, job, state);
        if (finalized.next) return finalized;
        state = finalized.state;
        continue;
      }
    }
    if (state.status === 'pending') {
      state =
        (await store.move(name, { from: ['pending'], to: 'running', action: 'plan' })) ?? state;
    }
    await store.reap(name);
    const counts = await store.partitionCounts(name, {
      generation: state.generation,
      plan: state.plan.token,
    });
    const open = counts.pending + counts.running;
    if (open > 0) {
      const claimable = counts.pending + (counts.running - counts.leased);
      return {
        next: 'process',
        lanes: Math.max(0, Math.min(claimable, job.spec.maxParallel - counts.leased)),
        generation: state.generation,
        round: driver.round,
        counts,
        retryAfterMs: POLL_MS,
      };
    }
    const finalized = await finalize(deps, job, state);
    if (finalized.next) return finalized;
    state = finalized.state;
  }
  return retrySoon(deps, 'passes');
}

/**
 * Plan the next pass: partitions over what still matches, committed under a
 * fresh plan token. Resolves to `{ state }` (with `empty` when nothing is
 * left to plan), or a coordinator answer (`{ next }`).
 */
async function planPass(deps, job, state, hash, { newPass = true } = {}) {
  const { store } = deps;
  const spec = job.spec;
  let plan;
  if (spec.mode === 'step') {
    plan = { method: 'step', estimate: 0, partitions: [{ scope: { kind: 'step' } }] };
  } else {
    plan = await job.partitioner.plan({
      collection: deps.db.collection(spec.collection),
      match: job.match,
      hint: job.hint,
      maxParallel: spec.maxParallel,
      settings: spec.partitions,
      shardConcurrency: spec.shardConcurrency,
    });
  }
  const pass = (state.pass ?? 0) + (newPass ? 1 : 0);
  const committed = await store.commitPlan(state._id, {
    generation: state.generation,
    previousToken: state.plan?.token,
    filter: { status: { $in: ['pending', 'running'] } },
    plan: {
      partitioner: spec.mode === 'step' ? 'step' : job.partitioner.id,
      method: plan.method,
      estimate: plan.estimate,
      match: hash,
      ...(plan.degraded ? { degraded: plan.degraded } : {}),
    },
    partitions: plan.partitions,
    fields: {
      pass,
      ...(state.startedAt === undefined ? { startedAt: new Date() } : {}),
      lastProgressAt: new Date(),
    },
  });
  if (committed === null) return retrySoon(deps, 'plan-race');
  // A coordinator that lost a commit race earlier left partitions nobody can claim.
  await store.dropForeignPlans(state._id, committed.plan.token);
  deps.emit('background:partitioned', {
    migration: state._id,
    generation: committed.generation,
    pass,
    partitions: plan.partitions.length,
    estimate: plan.estimate,
    method: plan.method,
    ...(plan.degraded ? { degraded: plan.degraded } : {}),
  });
  if (plan.degraded) {
    deps.logger.warn(
      `⚠ ${state._id}: the _id sample timed out — one partition per type this pass`,
      deps.fields({ background: state._id, degraded: plan.degraded }),
    );
  }
  return { state: committed, empty: plan.partitions.length === 0 };
}

/**
 * Close a pass: roll the partitions' counters into the state (once per
 * generation — `rolledGeneration` makes it idempotent after a crash), then
 * decide. A failed partition fails the background migration; nothing left
 * to rewrite completes it; anything left starts another pass — unless
 * `maxPasses` passes have not drained it, which means something keeps
 * writing the old shape.
 */
async function finalize(deps, job, state) {
  const { store } = deps;
  const name = state._id;
  const generation = state.generation;
  if ((state.rolledGeneration ?? 0) < generation) {
    const rolled = await store.generationTotals(name, generation);
    const inc = {};
    for (const [key, value] of Object.entries(rolled?.totals ?? {})) {
      if (typeof value === 'number' && key !== 'failedPartitions' && value !== 0) {
        inc[`totals.${key}`] = value;
      }
    }
    const badIds = [];
    const seen = new Set();
    for (const id of [...(state.badIds ?? []), ...(rolled?.badIds ?? [])]) {
      const key = JSON.stringify(id);
      if (!seen.has(key)) {
        seen.add(key);
        badIds.push(id);
      }
    }
    const updated = await store.cas(
      name,
      { rolledGeneration: { $lt: generation } },
      {
        ...(Object.keys(inc).length > 0 ? { $inc: inc } : {}),
        $set: {
          rolledGeneration: generation,
          badIds: badIds.slice(0, MAX_BAD_IDS + 1),
          ...(rolled?.docErrors?.length ? { docErrors: rolled.docErrors } : {}),
          ...(rolled?.totals?.failedPartitions > 0
            ? {
                failedPartitions: rolled.totals.failedPartitions,
                lastError: rolled.totals.lastError,
              }
            : {}),
          updatedAt: new Date(),
        },
      },
    );
    state = updated ?? (await store.get(name));
  }

  if ((state.failedPartitions ?? 0) > 0) {
    return failState(
      deps,
      state,
      `${state.failedPartitions} partition(s) failed: ${state.lastError}`,
    );
  }

  let remaining = 0;
  if (job.spec.mode !== 'step') {
    const badIds = state.badIds ?? [];
    remaining = await deps.db
      .collection(job.spec.collection)
      .countDocuments(
        badIds.length > 0
          ? { $and: [matchOf(job.spec, job.direction), { _id: { $nin: badIds } }] }
          : matchOf(job.spec, job.direction),
        { limit: 1, ...(job.hint ? { hint: job.hint } : {}), ...READ_OPTIONS },
      );
  }
  if (remaining === 0) {
    const completed = await store.move(name, {
      from: ['running', 'pending'],
      to: 'completed',
      action: 'complete',
      fields: { completedAt: new Date(), phase: 'process' },
    });
    await store.dropGenerations(name, generation - 1);
    if (completed !== null) {
      if ((state.badIds ?? []).length > 0) {
        deps.logger.warn(
          `⚠ ${name} completed with ${state.badIds.length} document(s) it could not migrate ` +
            '(within maxDocumentErrors) — they are still in the old shape',
          deps.fields({ background: name, failedDocuments: state.badIds.length }),
        );
      }
      deps.emit('background:completed', {
        migration: name,
        totals: completed.totals,
        passes: completed.pass,
      });
      deps.logger.info(
        `✔ Background migration ${name} completed (${completed.totals?.migrated ?? 0} migrated, ` +
          `${completed.pass} pass(es))`,
        deps.fields({ background: name }),
      );
      await deps.onCompleted?.(name);
    }
    return { next: 'done', status: completed?.status ?? (await store.get(name))?.status };
  }
  if ((state.pass ?? 0) >= job.spec.maxPasses) {
    return failState(
      deps,
      state,
      `old-shape documents keep appearing after ${state.pass} pass(es) — is an old version ` +
        'of the application still writing them?',
    );
  }
  deps.emit('background:pass', {
    migration: name,
    pass: state.pass,
    generation,
    totals: state.totals,
  });
  const next = await store.cas(
    name,
    { generation, phase: 'process' },
    { $set: { phase: 'partition', updatedAt: new Date() } },
  );
  await store.dropGenerations(name, generation - 1);
  return { state: next ?? (await store.get(name)) };
}

/** Move a state to `failed` with `message`, and say so */
async function failState(deps, state, message) {
  const failed = await deps.store.move(state._id, {
    from: ['running', 'pending', 'blocked'],
    to: 'failed',
    action: 'fail',
    fields: { lastError: message, failedAt: new Date() },
  });
  if (failed !== null) {
    deps.emit('background:failed', { migration: state._id, error: message });
    deps.logger.error(
      `✖ Background migration ${state._id} failed: ${message}`,
      deps.fields({ background: state._id }),
    );
  }
  return { next: 'done', status: 'failed', error: message };
}

/**
 * A blocked one whose `requires` are all completed moves to `pending`
 * (phase 20 adds the data probe). Returns the state after, or `null`.
 */
async function tryUnblock(deps, state) {
  const waitsFor = [];
  for (const required of state.requires ?? []) {
    const other = await deps.store.get(required);
    if (other === null || other.status !== 'completed') waitsFor.push(required);
  }
  if (waitsFor.length > 0) {
    if (JSON.stringify(waitsFor) !== JSON.stringify(state.waitsFor ?? [])) {
      await deps.store.set(state._id, { waitsFor });
    }
    return null;
  }
  const unblocked = await deps.store.move(state._id, {
    from: ['blocked'],
    to: 'pending',
    action: 'unblock',
    fields: { waitsFor: [] },
  });
  if (unblocked !== null) deps.emit('background:unblocked', { migration: state._id });
  return unblocked;
}

// ─── A lane's slice ───────────────────────────────────────────────────────────

/**
 * One slice of a lane: claim a partition (and its slot), work it until the
 * slice ends, release — then claim another while time is left. Resolves to
 * `{ outcome, counters, … }`: `yielded` (time is up, work is left),
 * `exhausted` (nothing left to claim), `busy` (every slot is held —
 * `retryAfterMs`), `stale` (no current plan: the coordinator must run),
 * `paused`, `cancelled`, `failed`, `stopped` (the signal) or `lost` (the
 * lease was taken). A slice that fails is counted on its partition and
 * thrown.
 */
async function runSlice(deps, name, { signal, sliceMs, owner } = {}) {
  const { store } = deps;
  const state = await store.get(name);
  if (state === null) return { outcome: 'cancelled', counters: {} };
  if (state.status === 'paused' || state.status === 'cancelled' || state.status === 'failed') {
    return { outcome: state.status, counters: {} };
  }
  if (state.status !== 'running' || state.phase !== 'process' || state.plan === undefined) {
    return { outcome: state.status === 'completed' ? 'exhausted' : 'stale', counters: {} };
  }
  const job = await jobFor(deps, name, state);
  job.generation = state.generation;
  await assertTransactions(deps, name, job.spec);
  const now = deps.now ?? Date.now;
  const deadline = now() + (sliceMs ?? job.spec.sliceMs);
  const counters = {};
  const throttle = createThrottle({
    spec: { ...job.spec, throttle: job.fns.throttle },
    db: deps.db,
    logger: deps.logger,
    name,
    warned: deps.warned,
  });
  let worked = false;
  for (;;) {
    if (signal?.aborted) return { outcome: 'stopped', counters };
    if (now() >= deadline) return { outcome: 'yielded', counters };
    const claimed = await store.claim(name, {
      generation: state.generation,
      plan: state.plan.token,
      maxParallel: job.spec.maxParallel,
      ttlMs: deps.ttlMs,
      owner,
      // Lanes per shard, on partitions that belong to one.
      ...(job.partitioner.id === 'shard' ? { shardConcurrency: job.spec.shardConcurrency } : {}),
      onReaped: (count) => deps.telemetry?.backgroundLeasesReclaimed({ name, count }),
    });
    if (claimed.exhausted) return { outcome: 'exhausted', counters };
    if (claimed.busy) {
      return worked
        ? { outcome: 'yielded', counters }
        : { outcome: 'busy', counters, retryAfterMs: claimed.retryAfterMs };
    }
    worked = true;
    const { partition, lease } = claimed;
    job.partitionId = partition._id;
    const adaptive =
      job.spec.adaptive === false
        ? undefined
        : adaptiveFor(deps, name, partition, job.spec.adaptive);
    deps.emit('background:slice:start', {
      migration: name,
      generation: state.generation,
      partition: String(partition._id),
      slot: partition.lease.slot,
    });
    const runLease = () =>
      runWithLock(lease, { logger: deps.logger, owner }, (leaseSignal) => {
        job.signal = anySignal(signal, leaseSignal);
        return processPartition(job, {
          store,
          lease,
          partition,
          db: deps.db,
          client: deps.client,
          signal: job.signal,
          deadline,
          throttle,
          adaptive,
          now,
          readControl: () =>
            store
              .get(name)
              .then((current) =>
                current === null
                  ? null
                  : { status: current.status, generation: current.generation, plan: current.plan },
              ),
          onBatch: (info) => {
            deps.telemetry?.backgroundBatchWritten({
              name,
              durationMs: info.latencyMs,
              shard: partition.group,
            });
            deps.emit('background:batch', {
              migration: name,
              partition: String(partition._id),
              ...(partition.group !== undefined ? { group: partition.group } : {}),
              ...info,
            });
          },
          onTransactionRetries: (count) =>
            deps.telemetry?.backgroundTransactionRetried({ name, reason: 'transient', count }),
          onThrottle: (change) => {
            deps.telemetry?.backgroundThrottled({ name, reason: change.reason });
            deps.emit('background:throttle', {
              migration: name,
              ...(partition.group !== undefined ? { group: partition.group } : {}),
              ...change,
            });
          },
        });
      });
    let result;
    const sliceStarted = now();
    try {
      // One span per lease held — it exists only once the claim succeeded.
      result = await withSpan(deps, 'slice', name, runLease);
    } catch (error) {
      deps.telemetry?.backgroundSliceEnded({
        name,
        durationMs: now() - sliceStarted,
        outcome: error instanceof LockLostError ? 'lost' : 'error',
        error,
      });
      if (error instanceof LockLostError) {
        deps.emit('background:lease:lost', { migration: name, partition: String(partition._id) });
        return { outcome: 'lost', counters };
      }
      const partitionFailed = await store
        .failSlice(lease, { error: errorText(error), maxSliceFailures: job.spec.maxSliceFailures })
        .catch(() => false);
      deps.emit('background:slice:end', {
        migration: name,
        partition: String(partition._id),
        outcome: 'error',
        error: errorText(error),
      });
      if (error instanceof MigronautError) {
        error.context = { ...error.context, background: name, partitionFailed };
      }
      throw error;
    }
    deps.telemetry?.backgroundSliceEnded({
      name,
      durationMs: now() - sliceStarted,
      outcome: result.outcome,
      counters: result.counters,
    });
    addInto(counters, result.counters);
    await store.set(name, { lastProgressAt: new Date() });
    deps.emit('background:slice:end', {
      migration: name,
      partition: String(partition._id),
      outcome: result.outcome,
      counters: result.counters,
    });
    if (result.outcome === 'failed' && result.error) {
      await store.failPartition(lease, { error: errorText(result.error) }).catch(() => undefined);
      await failState(deps, state, result.error.message);
      return { outcome: 'failed', counters, error: result.error };
    }
    if (result.outcome !== 'exhausted') return { outcome: result.outcome, counters };
    // That partition is done: claim another while the slice lasts.
  }
}

/** The process's AIMD controller for one background migration and group — shared by its lanes */
function adaptiveFor(deps, name, partition, settings) {
  const cache = deps.adaptiveCache;
  const key = `${name}:${partition.group ?? ''}`;
  if (cache?.has(key)) return cache.get(key);
  const controller = createAdaptive(settings, {
    ...(partition.throttle ? { initial: partition.throttle } : {}),
  });
  cache?.set(key, controller);
  return controller;
}

function addInto(into, from = {}) {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
}

// ─── Controls ─────────────────────────────────────────────────────────────────

/**
 * Apply a control action — `pause`, `resume`, `cancel`, `retry` (with
 * `fromStart`) — to a background migration. Resolves to
 * `{ applied: 'changed' | 'unchanged', status }`.
 *
 * @throws {BackgroundConflictError} when the action does not fit its state
 * @throws {NotAppliedError} via the kit when it is not registered
 */
async function control(deps, name, action, { requestedBy, reason, fromStart = false } = {}) {
  const { store } = deps;
  const state = await store.get(name);
  if (state === null) {
    throw new BackgroundConflictError(`Background migration ${name} is not registered`, {
      action,
      migration: name,
      status: 'unregistered',
    });
  }
  const effective = action === 'retry' && state.status === 'completed' ? 'reopen' : action;
  const { to, applied } = transition(state.status, effective, { migration: name });
  if (applied === 'unchanged') return { applied, status: state.status };

  const stamp = {
    action,
    ...(requestedBy !== undefined ? { requestedBy } : {}),
    ...(reason !== undefined ? { reason } : {}),
    at: new Date(),
  };
  let target = to;
  const fields = { control: stamp };
  if (action === 'resume') {
    // Back to where it was: blocked if what it requires is still not done.
    const waitsFor = [];
    for (const required of state.requires ?? []) {
      if ((await store.get(required))?.status !== 'completed') waitsFor.push(required);
    }
    if (waitsFor.length > 0) {
      target = 'blocked';
      fields.waitsFor = waitsFor;
    } else if (state.plan !== undefined && state.phase === 'process') {
      target = 'running';
    }
  }
  if (effective === 'reopen') {
    fields.phase = 'partition';
    fields.reopened = (state.reopened ?? 0) + 1;
  }
  if (action === 'retry' && fromStart) {
    fields.phase = 'partition';
    fields.pass = 0;
    fields.badIds = [];
    fields.failedPartitions = 0;
  } else if (action === 'retry') {
    fields.failedPartitions = 0;
  }
  const moved = await store.move(name, {
    from: [state.status],
    to: target,
    action,
    fields,
    by: requestedBy,
    reason,
  });
  if (moved === null) {
    // Someone moved it first: judge again from what it is now.
    return control(deps, name, action, { requestedBy, reason, fromStart });
  }

  const plan = state.plan;
  if (plan !== undefined) {
    if (action === 'cancel') {
      await store.setOpenPartitions(name, {
        generation: state.generation,
        plan: plan.token,
        status: 'cancelled',
      });
    } else if (action === 'retry' && fromStart) {
      await store.dropGenerations(name, state.generation);
    } else if (action === 'retry' && effective !== 'reopen') {
      await store.setOpenPartitions(name, {
        generation: state.generation,
        plan: plan.token,
        from: ['failed', 'cancelled'],
        status: 'pending',
      });
    }
  }
  deps.emit('background:control', { migration: name, action, from: state.status, to: target });
  deps.logger.info(
    `${name}: ${action} (${state.status} → ${target})`,
    deps.fields({ background: name, action }),
  );
  return { applied: 'changed', status: target };
}

/**
 * Pin what is on disk now: its checksum and spec become the state's. A
 * change to what is matched, or how it is split, means a new plan.
 */
async function repin(deps, name, { requestedBy, reason } = {}) {
  const { store } = deps;
  const state = await store.get(name);
  if (state === null) {
    throw new BackgroundConflictError(`Background migration ${name} is not registered`, {
      action: 'repin',
      migration: name,
      status: 'unregistered',
    });
  }
  const loaded = await deps.load(name);
  const before = state.spec ?? {};
  const after = loaded.spec;
  const dir = state.direction === 'revert' ? 'revert' : 'forward';
  const replan =
    matchHash(before, dir) !== matchHash(after, dir) ||
    before.maxParallel !== after.maxParallel ||
    JSON.stringify(before.partitions) !== JSON.stringify(after.partitions);
  const fields = {
    checksum: loaded.checksum,
    spec: after,
    ...(replan && !TERMINAL.has(state.status) && state.plan !== undefined
      ? { phase: 'replan' }
      : {}),
    control: { action: 'repin', requestedBy, reason, at: new Date() },
  };
  await store.set(name, fields);
  deps.emit('background:control', { migration: name, action: 'repin', replan });
  return { applied: 'changed', status: state.status, replan, checksum: loaded.checksum };
}

/**
 * Wait until no lane holds a lease any more — after a pause or a cancel,
 * for a caller that wants "stopped" to mean stopped.
 */
async function waitForLanes(deps, name, { signal, timeoutMs = 120_000, pollMs = 250 } = {}) {
  const now = deps.now ?? Date.now;
  const until = now() + timeoutMs;
  for (;;) {
    const { live } = await deps.store.leases(name);
    if (live === 0) return true;
    if (now() >= until) return false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, pollMs);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}

// ─── Drift ────────────────────────────────────────────────────────────────────

/** How long one drift probe may run */
const DRIFT_PROBE_MS = 5_000;

/** Statuses still at work on a collection — its drift is not drift yet */
const ACTIVE = new Set(['blocked', 'pending', 'running', 'paused']);

/** One indexed look for a document of a completed forward migration's old shape */
async function probeOldShape(deps, state, hint) {
  const spec = state.spec;
  const badIds = state.badIds ?? [];
  const match = matchOf(spec, 'forward');
  return deps.db
    .collection(spec.collection)
    .findOne(badIds.length > 0 ? { $and: [match, { _id: { $nin: badIds } }] } : match, {
      projection: { _id: 1 },
      hint,
      maxTimeMS: DRIFT_PROBE_MS,
      ...READ_OPTIONS,
    });
}

/**
 * The drift watch: old-shape documents that appeared after a background
 * migration completed — an old pod, a forgotten worker, another service.
 * One indexed probe per completed forward (declarative) migration; skipped
 * where another one is still at work on the collection, where the validator
 * already refuses the old shape (`to ≤ versioning.min`), and where the
 * version index is missing. With `onDrift: 'reopen'` a finding reopens it —
 * a new pass over what is left, not a reset — and with `'report'` it is only
 * said. Chains (v1→v2→v3) converge on their own. No document id is reported.
 */
async function verify(deps, { onDrift = 'reopen', collections } = {}) {
  const states = await deps.store.list();
  const active = new Set();
  for (const state of states) {
    if (ACTIVE.has(state.status) && state.spec?.collection) active.add(state.spec.collection);
  }
  const wanted = collections === undefined ? undefined : new Set(collections);
  const result = { checked: 0, skipped: 0, drift: [] };
  for (const state of states) {
    const spec = state.spec;
    if (state.status !== 'completed' || state.direction === 'revert') continue;
    if (spec?.mode !== 'declarative') continue;
    if (wanted !== undefined && !wanted.has(spec.collection)) continue;
    const versioning = await deps.versioningOf?.(spec.collection);
    if (active.has(spec.collection) || (versioning && spec.to <= versioning.min)) {
      result.skipped += 1;
      continue;
    }
    const hint = await versionHint(deps, spec);
    if (hint === undefined) {
      result.skipped += 1;
      continue;
    }
    let found;
    try {
      found = await probeOldShape(deps, state, hint);
    } catch (error) {
      deps.logger.warn(
        `⚠ Drift check of ${state._id} failed: ${errorText(error)}`,
        deps.fields({ background: state._id }),
      );
      result.skipped += 1;
      continue;
    }
    result.checked += 1;
    if (found === null) continue;
    const action = onDrift === 'reopen' ? 'reopened' : 'reported';
    if (action === 'reopened') {
      await control(deps, state._id, 'retry', { reason: 'old-shape documents reappeared' });
    }
    deps.telemetry?.backgroundDrift({ name: state._id });
    deps.emit('background:drift', {
      migration: state._id,
      collection: spec.collection,
      source: 'poll',
      action,
    });
    deps.logger.warn(
      `⚠ ${spec.collection}: old-shape documents appeared after ${state._id} completed — ` +
        (action === 'reopened' ? 'reopened it' : 'an old release may still be writing'),
      deps.fields({ background: state._id, collection: spec.collection, action }),
    );
    result.drift.push({ migration: state._id, collection: spec.collection, action });
  }
  return result;
}

/** How long a background migration may sit in `pending`, or `running` without progress, before audit warns */
const STALL_MS = 15 * 60_000;

/**
 * What `audit` says about background migrations: `{ status, detail }` with
 * the worst finding — or `null` when none is registered. `deps.checksumOf`
 * reads the file on disk; `deps.backgroundRecords` the changelog's
 * background records.
 */
async function auditFindings(deps, { now = Date.now() } = {}) {
  const states = await deps.store.list();
  const records = await deps.backgroundRecords();
  if (states.length === 0 && records.length === 0) return null;
  const failures = [];
  const warnings = [];
  const byName = new Map(states.map((state) => [state._id, state]));
  const counts = {};
  for (const state of states) {
    const name = state._id;
    counts[state.status] = (counts[state.status] ?? 0) + 1;
    if (state.status === 'failed') {
      failures.push(`${name} failed${state.lastError ? ` (${state.lastError})` : ''}`);
      continue;
    }
    const registeredAt = new Date(state.registeredAt).getTime();
    const progressAt = new Date(
      state.lastProgressAt ?? state.startedAt ?? state.registeredAt,
    ).getTime();
    if (state.status === 'pending' && now - registeredAt > STALL_MS) {
      warnings.push(
        `${name} has been pending since ${new Date(registeredAt).toISOString()} — is a runner up?`,
      );
    }
    if (state.status === 'paused') warnings.push(`${name} is paused`);
    if (state.status === 'running') {
      const { live } = await deps.store.leases(name);
      if (live === 0 && now - progressAt > STALL_MS) {
        warnings.push(
          `${name} is running but stalled — no lane for ${Math.round((now - progressAt) / 60_000)} min`,
        );
      }
    }
    if (state.status === 'blocked') {
      for (const required of state.waitsFor ?? []) {
        if (byName.get(required)?.status === 'failed') {
          warnings.push(`${name} is blocked by ${required}, which failed`);
        }
      }
    }
    if (state.plan !== undefined) {
      const current = await deps.store.partitionCounts(name, {
        generation: state.generation,
        plan: state.plan.token,
      });
      if (current.failed > 0 && state.status !== 'failed') {
        warnings.push(`${name} has ${current.failed} failed partition(s)`);
      }
      const all = await deps.store.partitions(name);
      let orphaned = 0;
      for (const partition of all) if (partition.plan !== state.plan.token) orphaned += 1;
      if (orphaned > 0) warnings.push(`${name} keeps ${orphaned} partition(s) of an old plan`);
    }
    if (state.status === 'completed') {
      if ((state.badIds ?? []).length > 0) {
        warnings.push(
          `${name} completed with ${state.badIds.length} document(s) it could not migrate`,
        );
      }
      if (state.spec?.mode === 'declarative' && state.direction !== 'revert') {
        const hint = await versionHint(deps, state.spec);
        if (
          hint !== undefined &&
          (await probeOldShape(deps, state, hint).catch(() => null)) !== null
        ) {
          warnings.push(
            `${state.spec.collection} holds old-shape documents again (${name} completed)`,
          );
        }
      }
    }
    try {
      const checksum = await deps.checksumOf(name);
      if (state.checksum !== undefined && checksum !== state.checksum) {
        warnings.push(`${name} changed on disk since it was registered (repin it)`);
      }
    } catch {
      warnings.push(`${name} is registered but its file is missing`);
    }
  }
  for (const record of records) {
    if (!byName.has(record.name)) {
      warnings.push(`${record.name} is applied but its background migration is not registered`);
    }
  }
  const summary = Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
  if (failures.length > 0) return { status: 'fail', detail: [...failures, ...warnings].join('; ') };
  if (warnings.length > 0) return { status: 'warn', detail: warnings.join('; ') };
  return { status: 'pass', detail: `${states.length} background migration(s): ${summary}` };
}

/** Why a failed state failed, for a thrown error */
function failedError(state) {
  return new BackgroundFailedError(
    `Background migration ${state._id} failed${state.lastError ? `: ${state.lastError}` : ''}`,
    { migration: state._id, lastError: state.lastError },
  );
}

module.exports = {
  auditFindings,
  coordinate,
  control,
  failedError,
  finalize,
  jobFor,
  repin,
  runSlice,
  tryUnblock,
  verify,
  versionHint,
  waitForLanes,
};
