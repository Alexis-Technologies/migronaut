const { BackgroundConflictError, BackgroundFailedError } = require('../../errors/index.js');
const { TERMINAL, matchHash, resolveTransition } = require('./spec.js');
const { sleep } = require('./throttle.js');
const { listWaiting } = require('./coordinator.js');

/**
 * The controls of a background migration — pause, resume, cancel, retry,
 * repin — and the wait for its lanes. See job.js for the deps they run on.
 */

/**
 * Apply a control action — `pause`, `resume`, `cancel`, `retry` (with
 * `fromStart`) — to a background migration. Resolves to
 * `{ applied: 'changed' | 'unchanged', status }`.
 *
 * @throws {BackgroundConflictError} when the action does not fit its state
 * @throws {NotAppliedError} via the kit when it is not registered
 */
const applyControl = async (
  deps,
  name,
  action,
  { requestedBy, reason, fromStart = false } = {},
) => {
  const { store } = deps;
  const state = await store.get(name);
  if (state === null) {
    throw new BackgroundConflictError(`Background migration ${name} is not registered`, {
      context: { action, migration: name, status: 'unregistered' },
    });
  }
  const effective = action === 'retry' && state.status === 'completed' ? 'reopen' : action;
  const { to, applied } = resolveTransition(state.status, effective, { migration: name });
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
    const waitsFor = await listWaiting(deps, state.requires ?? []);
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
  // A pass that already closed (its counters rolled up) is not resumed: its
  // partitions' work since would never be counted. A new pass takes what is left.
  const isClosed = state.plan !== undefined && (state.rolledGeneration ?? 0) >= state.generation;
  if (action === 'retry' && fromStart) {
    fields.phase = 'partition';
    fields.pass = 0;
    fields.badIds = [];
    fields.failedPartitions = 0;
    // Diagnostics of the runs before; `totals` stays — it is what was rewritten.
    fields.docErrors = [];
    fields.lastError = null;
  } else if (action === 'retry') {
    fields.failedPartitions = 0;
    if (isClosed) fields.phase = 'partition';
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
    return applyControl(deps, name, action, { requestedBy, reason, fromStart });
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
    } else if (action === 'retry' && effective !== 'reopen' && !isClosed) {
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
};

/**
 * Pin what is on disk now: its checksum and spec become the state's. A
 * change to what is matched, or how it is split, means a new plan.
 */
const repin = async (deps, name, { requestedBy, reason } = {}) => {
  const { store } = deps;
  const state = await store.get(name);
  if (state === null) {
    throw new BackgroundConflictError(`Background migration ${name} is not registered`, {
      context: { action: 'repin', migration: name, status: 'unregistered' },
    });
  }
  const loaded = await deps.load(name);
  const before = state.spec ?? {};
  const after = loaded.spec;
  const resolvedDirection = state.direction === 'revert' ? 'revert' : 'forward';
  const shouldReplan =
    matchHash(before, resolvedDirection) !== matchHash(after, resolvedDirection) ||
    before.maxParallel !== after.maxParallel ||
    JSON.stringify(before.partitions) !== JSON.stringify(after.partitions);
  const fields = {
    checksum: loaded.checksum,
    spec: after,
    ...(shouldReplan && !TERMINAL.has(state.status) && state.plan !== undefined
      ? { phase: 'replan' }
      : {}),
    control: { action: 'repin', requestedBy, reason, at: new Date() },
  };
  await store.set(name, fields);
  deps.emit('background:control', { migration: name, action: 'repin', replan: shouldReplan });
  return {
    applied: 'changed',
    status: state.status,
    replan: shouldReplan,
    checksum: loaded.checksum,
  };
};

/**
 * Wait until no lane holds a lease any more — after a pause or a cancel,
 * for a caller that wants "stopped" to mean stopped.
 */
const waitForLanes = async (deps, name, { signal, timeoutMs = 120_000, pollMs = 250 } = {}) => {
  const now = deps.now ?? Date.now;
  const until = now() + timeoutMs;
  for (;;) {
    const { live } = await deps.store.leases(name);
    if (live === 0) return true;
    if (now() >= until) return false;
    // One listener per wait, removed with it — and an aborted signal ends it at once.
    await sleep(pollMs, signal);
  }
};

/** Why a failed state failed, for a thrown error */
const createFailedError = (state) => {
  return new BackgroundFailedError(
    `Background migration ${state._id} failed${state.lastError ? `: ${state.lastError}` : ''}`,
    { context: { migration: state._id, lastError: state.lastError } },
  );
};

module.exports = {
  applyControl,
  repin,
  waitForLanes,
  createFailedError,
};
