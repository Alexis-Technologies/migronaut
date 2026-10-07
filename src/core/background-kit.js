const {
  BackgroundConflictError,
  ChecksumMismatchError,
  IrreversibleMigrationError,
  RunAbortedError,
} = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const {
  control,
  coordinate,
  failedError,
  requiresStatus,
  runSlice,
  tryUnblock,
  waitForLanes,
} = require('./background.js');
const { stillDirty } = require('./background-drift.js');
const { sleep } = require('./background-throttle.js');

/**
 * The kit's background side — what MigratorKit's background methods do
 * beyond plumbing: driving lanes in this process, a `down` without a
 * revert, the `requires` guard, and the public views of states, partitions
 * and watchers. A flow like background.js: it gets what it needs from the
 * kit (`host`), built only by migrator.js:
 *
 * `{ store, deps(owner?, { job }?), newId(), logger, emit(event, payload),
 *    registered(name), status(name) }` — `deps` is background.js's deps (`job`:
 * the queue job a run driving it inline works for), `registered` the state or
 * NotAppliedError, `status` the public view.
 */

/**
 * Slice errors no retry fixes: the file changed or is gone or invalid, the
 * configuration or the deployment cannot run it. A lane ends on them.
 */
const FATAL_SLICE_CODES = new Set([
  'CHECKSUM_MISMATCH',
  'MIGRATION_FILE_NOT_FOUND',
  'MIGRATION_INVALID_EXPORT',
  'MIGRATION_INVALID_NAME',
  'CONFIG_INVALID',
  'TRANSACTIONS_UNSUPPORTED',
]);

/** Failed slices in a row after which a lane of runBackground gives up */
const MAX_LANE_FAILURES = 10;

/** A lane's backoff after a failed slice: 250 ms · 2ⁿ, up to this */
const MAX_LANE_BACKOFF_MS = 30_000;

/** Statuses a `down` without a revert pauses before it judges whether anything was rewritten */
const PAUSABLE = new Set(['blocked', 'pending', 'running']);

/** How recent a streaming watcher's record must be for the poll to leave its collection alone */
const STREAMING_FRESH_MS = 60_000;

/** A background migration that has rewritten documents and declares no way back */
const irreversibleBackground = (name) =>
  new IrreversibleMigrationError(
    `Background migration ${name} has already rewritten documents and declares no revert — ` +
      'write a background migration back instead',
    { names: [name] },
  );

// ─── Driving it from this process ─────────────────────────────────────────────

/**
 * runBackground's loop: the coordinator and up to `concurrency` lanes until
 * it is done (`untilDone`) or for one round. `inline` (a run waiting for it
 * under the migration lock) cannot wait out a file that changed on disk
 * since it was registered — that wait is for a deploy in progress, and this
 * run is the deploy — so it fails instead. `job`: the queue job that run works
 * for, named on every lane's lines and `migration:log` events.
 */
async function drive(
  host,
  name,
  { signal, sliceMs, untilDone = true, concurrency = 1, inline, job },
) {
  const jobOption = job ? { job } : {};
  const deps = host.deps(host.newId(), jobOption);
  const stopped = () =>
    new RunAbortedError(`Stopped driving background migration ${name} — it goes on from here`, {
      migration: name,
    });
  for (;;) {
    if (signal?.aborted) throw stopped();
    const answer = await coordinate(deps, name, {
      signal,
      driver: { kind: inline ? 'inline' : 'local' },
    });
    if (answer.next === 'done' || answer.next === 'superseded') break;
    if (answer.next === 'process') {
      const state = await host.registered(name);
      const count = Math.max(1, Math.min(concurrency, state.spec?.maxParallel ?? 1));
      await lanes(host, name, count, { signal, sliceMs, untilDone, jobOption });
    } else {
      if (inline && answer.reason === 'checksum') {
        throw new ChecksumMismatchError(
          `Background migration ${name} changed on disk since it was registered — it cannot ` +
            'run inline until it is pinned again (migronaut background repin)',
          { migration: name, background: true },
        );
      }
      if (!untilDone) break;
      try {
        await sleep(answer.retryAfterMs ?? 1000, signal);
      } catch {
        throw stopped();
      }
    }
    if (!untilDone) break;
  }
  if (signal?.aborted) throw stopped();
  const state = await host.registered(name);
  if (state.status === 'failed') throw failedError(state);
  return host.status(name);
}

/** `count` lanes at once: the first that fails for good stops the others, and its error is thrown */
async function lanes(host, name, count, { signal, sliceMs, untilDone, jobOption }) {
  const stop = new AbortController();
  const laneSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const running = [];
  for (let i = 0; i < count; i++) {
    running.push(
      lane(host, name, { signal: laneSignal, sliceMs, untilDone, jobOption }).catch((error) => {
        if (!stop.signal.aborted) stop.abort(error);
        throw error;
      }),
    );
  }
  const settled = await Promise.allSettled(running);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
}

/**
 * One lane: slices until nothing is left to claim (or one, without
 * untilDone). A failed slice is counted on its partition (which fails after
 * `maxSliceFailures` in a row) and retried after a backoff; an error no
 * retry can fix — the file changed or is gone, the deployment cannot run it
 * — ends the lane, and so do `MAX_LANE_FAILURES` in a row.
 */
async function lane(host, name, { signal, sliceMs, untilDone, jobOption = {} }) {
  let failures = 0;
  for (;;) {
    if (signal?.aborted) return;
    const owner = host.newId();
    let slice;
    try {
      slice = await runSlice(host.deps(owner, jobOption), name, { signal, sliceMs, owner });
      failures = 0;
    } catch (error) {
      if (signal?.aborted) return;
      failures += 1;
      if (FATAL_SLICE_CODES.has(error?.code) || failures >= MAX_LANE_FAILURES) throw error;
      host.logger.warn(
        `⚠ Background migration ${name}: a slice failed (${errorText(error)}) — retrying`,
        { background: name, runId: owner, error: errorText(error) },
      );
      if (!untilDone) return;
      try {
        await sleep(Math.min(MAX_LANE_BACKOFF_MS, 250 * 2 ** failures), signal);
      } catch {
        return;
      }
      continue;
    }
    if (!untilDone) return;
    if (slice.outcome === 'yielded') continue;
    if (slice.outcome === 'busy') {
      try {
        await sleep(slice.retryAfterMs ?? 1000, signal);
      } catch {
        return;
      }
      continue;
    }
    return;
  }
}

// ─── down, and requires ───────────────────────────────────────────────────────

/**
 * Whether a background migration has written anything a `down` without a
 * revert could not put back: documents rewritten — or, for a step
 * migration (which says how many it rewrote only when it wants to), any
 * step checkpointed at all.
 */
async function hasRewritten(store, name, spec) {
  const { migrated, batches } = await store.progress(name);
  return spec.mode === 'step' ? batches > 0 : migrated > 0;
}

/**
 * `down` of a background migration without a revert: withdrawn — but only
 * while nothing has been rewritten, since nothing could put it back. A plan
 * never committed means no lane ever claimed anything: one conditional
 * delete. Otherwise the lanes are paused and waited for first, so the check
 * sees every batch they wrote; a refused `down` resumes it.
 */
async function withdraw(host, name, spec, session) {
  const { store } = host;
  const withdrawn = { status: 'withdrawn', direction: 'forward' };
  const state = await store.get(name);
  if (state === null) return withdrawn;
  if (await hasRewritten(store, name, spec)) throw irreversibleBackground(name);
  if (
    (state.generation ?? 0) === 0 &&
    (await store.remove(name, { session, filter: { generation: 0 } }))
  ) {
    return withdrawn;
  }
  const deps = host.deps();
  const paused = PAUSABLE.has(state.status)
    ? (await control(deps, name, 'pause', { reason: 'down withdraws it' })).applied === 'changed'
    : false;
  const stopped = await waitForLanes(deps, name);
  if (!stopped || (await hasRewritten(store, name, spec))) {
    if (paused) await control(deps, name, 'resume', { reason: 'down refused' });
    if (!stopped) {
      throw new BackgroundConflictError(
        `Background migration ${name} still has lanes at work — down cannot tell whether ` +
          'they rewrote documents; try again once they stop',
        { migration: name, action: 'withdraw' },
      );
    }
    throw irreversibleBackground(name);
  }
  await store.remove(name, { session });
  return withdrawn;
}

/**
 * The background migrations of `requires` not done yet:
 * `[{ migration, status }]`. A completed one is checked against its data —
 * and, unless this is only a preview (`reopen: false`), reopened when old
 * shapes reappeared.
 */
async function unsatisfied(host, requires, { reopen = true } = {}) {
  const deps = host.deps();
  const waiting = [];
  for (const row of await requiresStatus(deps, requires)) {
    if (!row.done) {
      waiting.push({ migration: row.migration, status: row.status });
    } else if (row.state !== undefined && (await stillDirty(deps, row.state))) {
      if (reopen) {
        await control(deps, row.migration, 'retry', { reason: 'old-shape documents reappeared' });
        host.emit('background:drift', {
          migration: row.migration,
          source: 'requires',
          action: 'reopened',
        });
      }
      waiting.push({ migration: row.migration, status: reopen ? 'running' : 'completed' });
    }
  }
  return waiting;
}

// ─── What it says ─────────────────────────────────────────────────────────────

/** Who drove it last — and a queue chain's round */
function coordinatorView(state) {
  return state.coordinator
    ? {
        coordinator: {
          kind: state.coordinator.kind,
          ...(state.round !== undefined ? { round: state.round } : {}),
          at: state.coordinator.at,
        },
      }
    : {};
}

/** How a background migration's plan used the shard key — for its status */
function shardingView(sharding) {
  let hashed = false;
  for (const value of Object.values(sharding.key ?? {})) if (value === 'hashed') hashed = true;
  return {
    mode: sharding.mode,
    ...(sharding.key !== undefined ? { shardKey: sharding.key, hashed } : {}),
    ...(sharding.groups !== undefined ? { groups: sharding.groups } : {}),
  };
}

/** The public view of a state document, with its current plan's partition counts */
async function stateView(store, state) {
  const spec = state.spec ?? {};
  const counts =
    state.plan !== undefined
      ? await store.partitionCounts(state._id, {
          generation: state.generation,
          plan: state.plan.token,
        })
      : undefined;
  const leases = await store.leases(state._id);
  return {
    migration: state._id,
    status: state.status,
    phase: state.phase,
    direction: state.direction ?? 'forward',
    registration: state.registration,
    mode: state.mode ?? spec.mode,
    ...(state.collection !== undefined ? { collection: state.collection } : {}),
    ...(spec.from !== undefined ? { from: spec.from, to: spec.to } : {}),
    generation: state.generation ?? 0,
    pass: state.pass ?? 0,
    maxParallel: spec.maxParallel ?? 1,
    transaction: Boolean(spec.transaction),
    totals: { ...state.totals },
    failedDocuments: (state.badIds ?? []).length,
    requires: state.requires ?? [],
    waitsFor: state.waitsFor ?? [],
    ...(counts ? { partitions: counts } : {}),
    liveLeases: leases.live,
    ...coordinatorView(state),
    ...(state.plan
      ? {
          plan: {
            method: state.plan.method,
            estimate: state.plan.estimate,
            ...(state.plan.atLeast ? { atLeast: true } : {}),
            partitions: state.plan.partitions,
            ...(state.plan.degraded ? { degraded: state.plan.degraded } : {}),
          },
        }
      : {}),
    ...(state.plan?.sharding ? { sharding: shardingView(state.plan.sharding) } : {}),
    registeredAt: state.registeredAt,
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    ...(state.lastProgressAt ? { lastProgressAt: state.lastProgressAt } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(state.description ? { description: state.description } : {}),
    ...(state.previous ? { previous: { ...state.previous } } : {}),
  };
}

/** A partition as `backgroundPartitions` shows it — its lease holder, never the token */
function partitionView(partition) {
  return {
    id: String(partition._id),
    generation: partition.generation,
    seq: partition.seq,
    status: partition.status,
    scope: partition.scope,
    estimate: partition.estimate,
    counters: { ...partition.counters },
    ...(partition.group !== undefined ? { group: partition.group } : {}),
    ...(partition.lease
      ? {
          lease: {
            slot: partition.lease.slot,
            owner: partition.lease.owner,
            host: partition.lease.host,
            pid: partition.lease.pid,
            renewedAt: partition.lease.renewedAt,
          },
        }
      : {}),
    ...(partition.throttle ? { throttle: partition.throttle } : {}),
    claims: partition.claims ?? 0,
    reclaims: partition.reclaims ?? 0,
    failures: partition.failures ?? 0,
    ...(partition.lastError ? { lastError: partition.lastError } : {}),
  };
}

/**
 * The background migrations with work to do — blocked ones whose requires
 * are met are unblocked on the way — with what a heal needs to tell a
 * stalled one (live leases read for all of them at once).
 */
async function runnable(host) {
  const { store } = host;
  const deps = host.deps();
  const states = [];
  for (const state of await store.list({ status: { $in: ['blocked', 'pending', 'running'] } })) {
    let current = state;
    if (state.status === 'blocked') current = (await tryUnblock(deps, state)) ?? state;
    if (current.status !== 'blocked') states.push(current);
  }
  const names = [];
  for (const state of states) names.push(state._id);
  const live = await store.liveLeasesOf(names);
  const rows = [];
  for (const state of states) {
    rows.push({
      migration: state._id,
      status: state.status,
      maxParallel: state.spec?.maxParallel ?? 1,
      liveLeases: live.get(state._id) ?? 0,
      registeredAt: state.registeredAt,
      ...(state.startedAt ? { startedAt: state.startedAt } : {}),
      ...(state.lastProgressAt ? { lastProgressAt: state.lastProgressAt } : {}),
      ...coordinatorView(state),
    });
  }
  return rows;
}

/** A drift watcher's stored document as its status row */
function watchRow(row) {
  return {
    collection: row._id,
    state: row.state ?? 'starting',
    ...(row.target !== undefined ? { target: row.target } : {}),
    edges: row.edges ?? [],
    ...(row.leader
      ? { leader: { host: row.leader.host, pid: row.leader.pid, at: row.leader.at } }
      : {}),
    counters: { events: 0, upgraded: 0, failed: 0, skipped: 0, ...row.counters },
    ...(row.lastEventAt ? { lastEventAt: row.lastEventAt } : {}),
    updatedAt: row.updatedAt,
  };
}

module.exports = {
  STREAMING_FRESH_MS,
  drive,
  hasRewritten,
  irreversibleBackground,
  partitionView,
  runnable,
  stateView,
  unsatisfied,
  watchRow,
  withdraw,
};
