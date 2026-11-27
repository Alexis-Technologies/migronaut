const {
  ChecksumMismatchError,
  LockAlreadyHeldError,
  TransactionsUnsupportedError,
} = require('../../errors/index.js');
const { formatDocumentError, formatError } = require('../../utils/error.js');
const { excludeBadIds, toIdKey, matchOf } = require('./engine.js');
const { TERMINAL, matchHash } = require('./spec.js');
const { MAX_BAD_IDS, STATE_SCHEMA } = require('./store.js');
const { runWithLock } = require('../lock.js');
const { READ_OPTIONS } = require('../server-info.js');
const {
  assertTransactions,
  DEGRADED,
  loadJob,
  planMismatch,
  POLL_MS,
  REPLAN_REASONS,
  retrySoon,
  describeSharding,
  warnOnce,
} = require('./job.js');

/**
 * The coordinator of a background migration: one step at a time under the
 * coordinator lock — plan the partitions, wait for the lanes, finalize a
 * pass — and what blocks and unblocks it (`requires`). See job.js for the
 * deps every step runs on.
 */

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
const coordinate = async (deps, name, { signal, driver = { kind: 'local' } } = {}) => {
  const lock = deps.lockFor(name);
  try {
    return await runWithLock(
      lock,
      { logger: deps.logger, owner: deps.ownerOf?.() },
      (lockSignal) => {
        // The span opens once the lock is held: a busy coordinator makes none.
        return withSpan(deps, 'coordinate', name, () => {
          return coordinateStep(deps, name, { signal: combineSignals(signal, lockSignal), driver });
        });
      },
    );
  } catch (error) {
    if (error instanceof LockAlreadyHeldError) {
      return { next: 'busy', retryAfterMs: Math.max(1, Math.floor(lock.ttlMs / 2)) };
    }
    throw error;
  }
};

/** `fn` inside the kit's span for `kind` (`slice`, `coordinate`), when it gives one */
const withSpan = (deps, kind, name, work) => {
  return typeof deps.span === 'function' ? deps.span(kind, name, work) : work();
};

/** A signal aborted when either is */
const combineSignals = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
};

const coordinateStep = async (deps, name, { signal, driver }) => {
  const { store } = deps;
  let state = await store.get(name);
  if (state === null) return { next: 'done', status: 'unregistered' };
  if (state.schema > STATE_SCHEMA) {
    warnOnce(
      deps,
      `schema:${name}`,
      `⚠ ${name} was registered by a newer release (state schema ${state.schema}, this one ` +
        `knows ${STATE_SCHEMA}) — waiting for a process of that release to drive it`,
      { background: name },
    );
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

  // Who drives it — recorded for status. A BullMQ chain of coordinator jobs
  // also carries a round, which only this step hands out (under the
  // coordinator lock): a new chain gets the next round; a chain whose round
  // is not the latest bows out — a newer one took over (two chains started
  // at once each get their own), or it was registered again since. A round
  // the kit never handed out (forged in Redis) is never written.
  let round = -1;
  if (driver.kind === 'bullmq') {
    const current = state.round;
    if (driver.round === undefined) round = (current ?? 0) + 1;
    else if (driver.round !== current) return { next: 'superseded' };
    else round = current;
  }
  await store.set(name, {
    coordinator: {
      kind: driver.kind,
      ...(driver.ref !== undefined ? { ref: driver.ref } : {}),
      at: new Date(),
    },
    ...(round !== -1 ? { round } : {}),
  });
  const answer = await coordinatePass(deps, name, state, { signal });
  return round !== -1 ? { ...answer, round } : answer;
};

/** The rest of a coordinator step, once its driver is recorded */
const coordinatePass = async (deps, name, initial, { signal }) => {
  const { store } = deps;
  let state = initial;
  let job = null;
  try {
    job = await loadJob(deps, name, state);
  } catch (error) {
    const isOtherVersion =
      error instanceof ChecksumMismatchError || error?.code === 'ALX_ERR_MIGRATION_FILE_NOT_FOUND';
    if (isOtherVersion) {
      // Mid-deploy: an older or newer pod holds the other version of the file.
      deps.logger.warn(`⚠ ${formatError(error)}`, deps.fields({ background: name }));
      return retrySoon(deps, 'checksum');
    }
    throw error;
  }
  try {
    await assertTransactions(deps, name, job.spec);
  } catch (error) {
    // Not something a retry fixes: the deployment cannot do it. Anything
    // else (the server could not be asked) is the step's to retry.
    if (!(error instanceof TransactionsUnsupportedError)) throw error;
    return failState(deps, state, error.message);
  }
  const hash = matchHash(job.spec, job.direction === 'revert' ? 'revert' : 'forward');

  for (let guard = 0; guard < job.spec.maxPasses + 2; guard++) {
    if (signal?.aborted) return retrySoon(deps, 'stopping');
    // The plan's ranges mean nothing to this job (planMismatch): re-split the
    // same pass.
    const mismatch = state.phase === 'process' ? planMismatch(job, state.plan) : undefined;
    if (mismatch !== undefined) {
      deps.logger.warn(
        `⚠ ${name}: ${job.spec.collection} — ${REPLAN_REASONS[mismatch]} — replanning`,
        deps.fields({ background: name, replan: mismatch }),
      );
      state =
        (await store.cas(
          name,
          { phase: 'process', 'plan.token': state.plan.token },
          { $set: { phase: 'replan' } },
        )) ?? (await store.get(name));
    }
    // A replan re-splits the same pass; it is not a new one.
    const isReplanning = state.phase === 'replan';
    if (isReplanning && state.plan !== undefined) {
      await store.supersede(name, { generation: state.generation, plan: state.plan.token });
      const leases = await store.leases(name);
      if (leases.live > 0) return retrySoon(deps, 'replan-draining');
      state =
        (await store.cas(name, { phase: 'replan' }, { $set: { phase: 'partition' } })) ?? state;
    }
    if (state.phase !== 'process' || state.plan === undefined || state.plan.match !== hash) {
      const planned = await planPass(deps, job, state, hash, { newPass: !isReplanning });
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
    const reaped = await store.reap(name);
    if (reaped > 0) deps.telemetry?.backgroundLeasesReclaimed({ name, count: reaped });
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
        registration: state.registration,
        counts,
        retryAfterMs: POLL_MS,
      };
    }
    const finalized = await finalize(deps, job, state);
    if (finalized.next) return finalized;
    state = finalized.state;
  }
  return retrySoon(deps, 'passes');
};

/**
 * Plan the next pass: partitions over what still matches, committed under a
 * fresh plan token. Resolves to `{ state }` (with `empty` when nothing is
 * left to plan), or a coordinator answer (`{ next }`).
 */
const planPass = async (deps, job, state, hash, { newPass = true } = {}) => {
  const { store } = deps;
  const spec = job.spec;
  let plan = null;
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
  const sharding = spec.mode === 'step' ? null : describeSharding(job, plan);
  const committed = await store.commitPlan(state._id, {
    generation: state.generation,
    previousToken: state.plan?.token,
    // A repin while this pass was planned changed the spec under it: the
    // commit loses, and the next step plans with the new one.
    filter: {
      status: { $in: ['pending', 'running'] },
      ...(state.checksum !== undefined ? { checksum: state.checksum } : {}),
    },
    plan: {
      partitioner: spec.mode === 'step' ? 'step' : job.partitioner.id,
      method: plan.method,
      estimate: plan.estimate,
      ...(plan.atLeast ? { atLeast: true } : {}),
      match: hash,
      ...(plan.degraded ? { degraded: plan.degraded } : {}),
      ...(plan.epoch ? { epoch: plan.epoch } : {}),
      // Left out of the stored plan when there is none — an absent key, not null.
      ...(sharding !== null ? { sharding } : {}),
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
    ...(plan.atLeast ? { atLeast: true } : {}),
    method: plan.method,
    ...(plan.degraded ? { degraded: plan.degraded } : {}),
  });
  if (plan.degraded) {
    deps.logger.warn(
      `⚠ ${state._id}: ${DEGRADED[plan.degraded] ?? plan.degraded}`,
      deps.fields({ background: state._id, degraded: plan.degraded }),
    );
  }
  return { state: committed, empty: plan.partitions.length === 0 };
};

/**
 * Close a pass: roll the partitions' counters into the state (once per
 * generation — `rolledGeneration` makes it idempotent after a crash), then
 * decide. A failed partition fails the background migration; nothing left
 * to rewrite completes it; anything left starts another pass — unless
 * `maxPasses` passes have not drained it, which means something keeps
 * writing the old shape.
 */
const finalize = async (deps, job, state) => {
  const { store } = deps;
  const name = state._id;
  const generation = state.generation;
  if ((state.rolledGeneration ?? 0) < generation) {
    const rolled = await store.generationTotals(name, generation);
    const inc = {};
    const totals = rolled?.totals ?? {};
    const keys = Object.keys(totals);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = totals[key];
      if (typeof value === 'number' && key !== 'failedPartitions' && value !== 0) {
        inc[`totals.${key}`] = value;
      }
    }
    // One id, one entry — by its canonical form, so a string _id never
    // stands in for an ObjectId with the same hex.
    const badIds = [];
    const seen = new Set();
    for (const list of [state.badIds ?? [], rolled?.badIds ?? []]) {
      for (const id of list) {
        const key = toIdKey(id);
        if (!seen.has(key)) {
          seen.add(key);
          badIds.push(id);
        }
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
    remaining = await deps.db
      .collection(job.spec.collection)
      .countDocuments(excludeBadIds(matchOf(job.spec, job.direction), state.badIds), {
        limit: 1,
        ...(job.hint ? { hint: job.hint } : {}),
        ...READ_OPTIONS,
      });
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
      // A completed revert unblocks nothing: what required it needs the forward shape.
      if (job.direction !== 'revert') await deps.onCompleted?.(name);
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
};

/** Move a state to `failed` with `message`, and say so */
const failState = async (deps, state, reason) => {
  // Kept, emitted and logged: the application's data stays out of it.
  const message = formatDocumentError(reason);
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
};

/**
 * Where each of `requires` stands, in order — the one rule every guard
 * shares: `[{ migration, status, done, state? }]`. A background migration is
 * done when its state completed forward, or — with no state at all — when
 * the changelog has it from a history that predates migronaut (a baseline,
 * an import: `deps.adoptedOf(names)`). A completed revert is not done: what
 * required it needs the forward shape.
 */
const readRequiresStatus = async (deps, requires) => {
  if (requires.length === 0) return [];
  const states = await deps.store.getMany(requires);
  const missing = [];
  for (const name of requires) if (!states.has(name)) missing.push(name);
  const adopted = new Set(missing.length > 0 ? ((await deps.adoptedOf?.(missing)) ?? []) : []);
  const rows = [];
  for (const migration of requires) {
    const state = states.get(migration);
    if (state === undefined) {
      const isDone = adopted.has(migration);
      rows.push({ migration, status: isDone ? 'adopted' : 'unregistered', done: isDone });
    } else if (state.direction === 'revert') {
      rows.push({ migration, status: 'reverted', done: false, state });
    } else {
      rows.push({ migration, status: state.status, done: state.status === 'completed', state });
    }
  }
  return rows;
};

/** The names among `requires` not done yet, in order */
const listWaiting = async (deps, requires) => {
  const waitsFor = [];
  for (const row of await readRequiresStatus(deps, requires)) {
    if (!row.done) waitsFor.push(row.migration);
  }
  return waitsFor;
};

/**
 * A blocked one whose `requires` are all done moves to `pending`. Returns
 * the state after, or `null`.
 */
const tryUnblock = async (deps, state) => {
  const waitsFor = await listWaiting(deps, state.requires ?? []);
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
};

module.exports = {
  coordinate,
  withSpan,
  combineSignals,
  finalize,
  failState,
  readRequiresStatus,
  listWaiting,
  tryUnblock,
};
