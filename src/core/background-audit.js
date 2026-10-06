const { STATE_SUMMARY, probeHint } = require('./background.js');
const { probeOldShape } = require('./background-drift.js');

/**
 * What `audit` says about background migrations — read-only, from what the
 * kit injects (`deps`): the states, their partitions and leases, the files
 * on disk, the changelog's background records and the live watchers.
 */

/** How long a background migration may sit in `pending`, or `running` without progress, before audit warns */
const STALL_MS = 15 * 60_000;

/**
 * What `audit` says about background migrations: `{ status, detail }` with
 * the worst finding — or `null` when none is registered. `deps.checksumOf`
 * reads the file on disk; `deps.backgroundRecords` the changelog's
 * background records.
 */
async function auditFindings(deps, { now = Date.now() } = {}) {
  const states = await deps.store.list({}, { projection: STATE_SUMMARY });
  const records = await deps.backgroundRecords();
  if (states.length === 0 && records.length === 0) return null;
  const failures = [];
  const warnings = [];
  const byName = new Map();
  const running = [];
  for (const state of states) {
    byName.set(state._id, state);
    if (state.status === 'running') running.push(state._id);
  }
  // Read once for all of them, not once per state.
  const live = await deps.store.liveLeasesOf(running);
  const hints = new Map();
  const hintOf = async (spec) => {
    const key = `${spec.collection}\u0000${spec.field}`;
    if (!hints.has(key)) hints.set(key, await probeHint(deps, spec));
    return hints.get(key);
  };
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
      if ((live.get(name) ?? 0) === 0 && now - progressAt > STALL_MS) {
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
      // Of the current generation only: the done partitions of the pass before
      // are kept on purpose (finalize drops the generation before last).
      const orphaned = await deps.store.countForeignPlans(name, {
        generation: state.generation,
        plan: state.plan.token,
      });
      if (orphaned > 0) warnings.push(`${name} keeps ${orphaned} partition(s) of an old plan`);
    }
    if (state.status === 'completed') {
      if ((state.badIds ?? []).length > 0) {
        warnings.push(
          `${name} completed with ${state.badIds.length} document(s) it could not migrate`,
        );
      }
      if (state.spec?.mode === 'declarative' && state.direction !== 'revert') {
        const hint = await hintOf(state.spec);
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
  // Live drift watchers, when drift is streamed: one left to the poll for
  // long, or one nobody has led for long, is worth a look.
  for (const row of (await deps.watchRows?.()) ?? []) {
    const quietMs = now - new Date(row.updatedAt).getTime();
    if (!(quietMs > STALL_MS)) continue;
    const minutes = Math.round(quietMs / 60_000);
    warnings.push(
      row.state === 'fallback'
        ? `the drift watcher of ${row._id} has fallen back to polling for ${minutes} min`
        : `the drift watcher of ${row._id} has had no live leader for ${minutes} min`,
    );
  }
  const summary = Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
  if (failures.length > 0) return { status: 'fail', detail: [...failures, ...warnings].join('; ') };
  if (warnings.length > 0) return { status: 'warn', detail: warnings.join('; ') };
  return { status: 'pass', detail: `${states.length} background migration(s): ${summary}` };
}

module.exports = { auditFindings };
