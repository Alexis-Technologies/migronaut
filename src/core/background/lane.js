const { LockLostError, MigronautError } = require('../../errors/index.js');
const { documentErrorText, errorText } = require('../../utils/error.js');
const { addCounters, processPartition } = require('./engine.js');
const { STATE_SCHEMA } = require('./store.js');
const { createAdaptive, createThrottle } = require('./throttle.js');
const { runWithLock } = require('../lock.js');
const { assertTransactions, CONTROL_FIELDS, jobFor, planMismatch } = require('./job.js');
const { anySignal, failState, withSpan } = require('./coordinator.js');

/**
 * A lane's slice: claim a partition, rewrite it batch by batch under the
 * lease, checkpoint, and claim the next while the slice lasts. See job.js for
 * the deps it runs on.
 */

/** How a slice that threw ended: its lease lost, the lane stopped, or an error */
const thrownOutcome = (lost, stopped) => {
  if (lost) return 'lost';
  return stopped ? 'stopped' : 'error';
};

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
const runSlice = async (deps, name, { signal, sliceMs, owner } = {}) => {
  const { store } = deps;
  const state = await store.get(name);
  if (state === null) return { outcome: 'cancelled', counters: {} };
  if (state.status === 'paused' || state.status === 'cancelled' || state.status === 'failed') {
    return { outcome: state.status, counters: {} };
  }
  if (state.status !== 'running' || state.phase !== 'process' || state.plan === undefined) {
    return { outcome: state.status === 'completed' ? 'exhausted' : 'stale', counters: {} };
  }
  // A newer release's state (an old pod mid-deploy): its plan may hold scopes
  // this one cannot read. The coordinator waits; so does the lane.
  if (state.schema > STATE_SCHEMA) return { outcome: 'stale', counters: {} };
  let job = null;
  try {
    job = await jobFor(deps, name, state);
    // A plan this job cannot work (made before a reshard, or by the other
    // partitioner): the coordinator must re-split first.
    if (planMismatch(job, state.plan) !== undefined) return { outcome: 'stale', counters: {} };
    await assertTransactions(deps, name, job.spec);
  } catch (error) {
    // Before any claim (the file changed or is gone, the deployment cannot
    // run it): no partition to count it on and no slice:start to pair an
    // event with — but measured like any failed slice; the drivers log it.
    deps.telemetry?.backgroundSliceEnded({ name, durationMs: 0, outcome: 'error', error });
    throw error;
  }
  job.generation = state.generation;
  const now = deps.now ?? Date.now;
  const deadline = now() + (sliceMs ?? job.spec.sliceMs);
  const counters = {};
  const throttle = createThrottle({
    spec: { ...job.spec, throttle: job.fns.throttle },
    db: deps.db,
    logger: deps.logger,
    name,
    warned: deps.warned,
    ...(deps.lagWaits ? { lagWaits: deps.lagWaits } : {}),
  });
  let worked = false;
  for (;;) {
    if (signal?.aborted) return { outcome: 'stopped', counters };
    // The first claim is always made: a slice shorter than its setup still works a batch.
    if (worked && now() >= deadline) return { outcome: 'yielded', counters };
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
      partition: `${partition._id}`,
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
          // Every batch of every lane asks: only what it decides on is read.
          readControl: () =>
            store
              .get(name, { projection: CONTROL_FIELDS })
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
              partition: `${partition._id}`,
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
    let result = null;
    const sliceStarted = now();
    try {
      // One span per lease held — it exists only once the claim succeeded.
      result = await withSpan(deps, 'slice', name, runLease);
    } catch (error) {
      const lost = error instanceof LockLostError;
      // The caller stopped the lane (a shutdown, a deploy): whatever a wait
      // rejected with is the stop, not a fault of the partition — counting it
      // would fail a partition after a few rolling deploys.
      const stopped = !lost && signal?.aborted === true;
      deps.telemetry?.backgroundSliceEnded({
        name,
        durationMs: now() - sliceStarted,
        outcome: thrownOutcome(lost, stopped),
        ...(stopped ? {} : { error }),
      });
      if (lost) {
        deps.emit('background:lease:lost', { migration: name, partition: `${partition._id}` });
        return { outcome: 'lost', counters };
      }
      if (stopped) {
        deps.emit('background:slice:end', {
          migration: name,
          partition: `${partition._id}`,
          outcome: 'stopped',
        });
        return { outcome: 'stopped', counters };
      }
      // The slice may have failed on what was cached — a hint on an index a
      // converge dropped since: the next one reads the indexes again instead
      // of failing the same way until the cache runs out.
      deps.indexCache?.delete(job.spec.collection);
      deps.shardKeyCache?.delete(job.spec.collection);
      const partitionFailed = await store
        .failSlice(lease, {
          error: documentErrorText(error),
          maxSliceFailures: job.spec.maxSliceFailures,
        })
        .catch((countError) => {
          // The slice's own error is what is thrown; this one is only said.
          deps.logger.debug(
            `Could not count a failed slice of ${name}: ${errorText(countError)}`,
            deps.fields({ background: name }),
          );
          return false;
        });
      deps.emit('background:slice:end', {
        migration: name,
        partition: `${partition._id}`,
        outcome: 'error',
        error: documentErrorText(error),
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
    addCounters(counters, result.counters ?? {});
    await store.set(name, { lastProgressAt: new Date() });
    deps.emit('background:slice:end', {
      migration: name,
      partition: `${partition._id}`,
      outcome: result.outcome,
      counters: result.counters,
    });
    if (result.outcome === 'failed' && result.error) {
      await store
        .failPartition(lease, { error: documentErrorText(result.error) })
        .catch((error) => {
          // The state below fails the migration whatever the partition says.
          deps.logger.debug(
            `Background migration ${name}: could not mark the partition failed — ${errorText(error)}`,
            deps.fields({ background: name, error: errorText(error) }),
          );
        });
      await failState(deps, state, documentErrorText(result.error));
      return { outcome: 'failed', counters, error: result.error };
    }
    if (result.outcome !== 'exhausted') return { outcome: result.outcome, counters };
    // That partition is done: claim another while the slice lasts.
  }
};

/**
 * The process's AIMD controller for one background migration and group —
 * shared by its lanes, and kept for as long as its settings are the ones it
 * was made with. A repin that lowers `batchSize` (the batches were too big)
 * must reach a runner that has been up for days: the controller is made
 * anew, from what the old one had learned, within the new bounds.
 */
const adaptiveFor = (deps, name, partition, settings) => {
  const cache = deps.adaptiveCache;
  const key = `${name}:${partition.group ?? ''}`;
  const signature =
    `${settings.targetLatencyMs}:${settings.minBatchSize}:` +
    `${settings.maxBatchSize}:${settings.maxPauseMs}`;
  const cached = cache?.get(key);
  if (cached?.signature === signature) return cached.controller;
  const initial = cached?.controller.state() ?? partition.throttle;
  const controller = createAdaptive(settings, initial ? { initial } : {});
  cache?.set(key, { signature, controller });
  return controller;
};

module.exports = {
  runSlice,
  adaptiveFor,
};
