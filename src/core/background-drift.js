const { errorText } = require('../utils/error.js');
const { STATE_SUMMARY, control, probeHint } = require('./background.js');
const { excludeBadIds, matchOf } = require('./background-engine.js');
const { READ_OPTIONS } = require('./server-info.js');

/**
 * Drift: old-shape documents that appear after a background migration
 * completed — an old pod, a forgotten worker, another service. The probes
 * the requires guard, the poll (`verifyBackground`) and audit share: one
 * hinted, time-boxed look per completed forward migration. Orchestration
 * over what the kit injects (`deps`), as in background.js.
 */

/** How long one drift probe may run */
const DRIFT_PROBE_MS = 5_000;

/** Statuses still at work on a collection — its drift is not drift yet */
const ACTIVE = new Set(['blocked', 'pending', 'running', 'paused']);

/** One indexed look for a document of a completed forward migration's old shape */
async function probeOldShape(deps, state, hint) {
  const spec = state.spec;
  return deps.db
    .collection(spec.collection)
    .findOne(excludeBadIds(matchOf(spec, 'forward'), state.badIds), {
      projection: { _id: 1 },
      hint,
      maxTimeMS: DRIFT_PROBE_MS,
      ...READ_OPTIONS,
    });
}

/**
 * Whether a completed forward migration's collection holds an old-shape
 * document again — for the `requires` guard, which runs under the migration
 * lock: one hinted probe, time-boxed. Where that is not possible (a step
 * migration, no version index, a probe that ran out of time) the status is
 * trusted — a scan of the whole collection on every `up` is not an option.
 */
async function stillDirty(deps, state) {
  const spec = state.spec;
  if (!spec || spec.mode !== 'declarative' || state.direction === 'revert') return false;
  const hint = await probeHint(deps, spec);
  if (hint === undefined) return false;
  try {
    return (await probeOldShape(deps, state, hint)) !== null;
  } catch (error) {
    deps.logger.warn(
      `⚠ Could not check ${state._id} for old-shape documents: ${errorText(error)} — trusting its status`,
      deps.fields({ background: state._id }),
    );
    return false;
  }
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
 * `streaming`: collections a live watcher leads right now — skipped too.
 */
async function verify(deps, { onDrift = 'reopen', collections, streaming } = {}) {
  const states = await deps.store.list({}, { projection: STATE_SUMMARY });
  const active = new Set();
  for (const state of states) {
    if (ACTIVE.has(state.status) && state.spec?.collection) active.add(state.spec.collection);
  }
  // In `backgroundDrift: 'stream'` mode a live watcher's collection is its, not the poll's.
  for (const collection of streaming ?? []) active.add(collection);
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
    const hint = await probeHint(deps, spec);
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

module.exports = { probeOldShape, stillDirty, verify };
