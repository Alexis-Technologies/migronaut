const { pickActor } = require('../../utils/actor.js');
const { formatError } = require('../../utils/error.js');
const { CHANGE_ACTIONS } = require('./plan.js');
const { toNotReadyEntry, searchSummary } = require('./search-run.js');
const { describeTarget } = require('./failure.js');

/**
 * The converge result as it grows: rows settled, tallies, the closing
 * totals, the lines that announce a step, and the history entry a run appends.
 */

/** Steps that build an index — the ones that can take minutes or hours */
const BUILD_STEPS = new Set(['createIndexes', 'rebuild']);

const STARTING = {
  create: 'Creating',
  modify: 'Modifying',
  recreate: 'Rebuilding',
  drop: 'Dropping',
};

/** Mark every row that never ran, once a run stops early */
const settleRest = (result) => {
  for (const collection of result.collections) {
    for (const action of collection.actions) {
      if (action.status !== 'planned') continue;
      action.status = action.action === 'conflict' ? 'failed' : 'skipped';
    }
  }
};

/**
 * Everything the closing report needs, from one pass over every row: the
 * counts behind `changed` and `inSync`, the collections touched, the
 * undeclared indexes kept, a count per action kind, the rows the history
 * keeps, and — when search indexes are declared — those not serving yet.
 * With `settle`, a row never reached is settled first, as in settleRest.
 */
const tally = (result, search, settle) => {
  const totals = {
    changes: 0,
    applied: 0,
    conflicts: 0,
    touched: 0,
    kept: { indexes: 0, searchIndexes: 0 },
    counts: {},
    history: [],
    notReady: [],
  };
  const isSearching = search?.declared === true;
  for (const collection of result.collections) {
    let isTouched = false;
    for (const action of collection.actions) {
      if (settle && action.status === 'planned') {
        action.status = action.action === 'conflict' ? 'failed' : 'skipped';
      }
      const kind = action.action;
      totals.counts[kind] = (totals.counts[kind] ?? 0) + 1;
      const isChange = CHANGE_ACTIONS.has(kind);
      if (isChange) {
        totals.changes += 1;
        if (action.status === 'applied') totals.applied += 1;
        if (result.dryRun || action.status === 'applied') isTouched = true;
      } else if (kind === 'conflict') {
        totals.conflicts += 1;
      } else if (kind === 'keep' && action.reason === 'not declared') {
        // Left in place because prune was off — not the ones that back a shard
        // key (or are being deleted), for which "converge with prune" is wrong advice.
        if (action.target === 'searchIndex') totals.kept.searchIndexes += 1;
        else totals.kept.indexes += 1;
      }
      // The history keeps what changed, failed or refused the run.
      if (isChange || kind === 'conflict' || action.status === 'failed') {
        totals.history.push([collection.name, action]);
      }
      if (isSearching) {
        const entry = toNotReadyEntry(collection.name, action);
        if (entry) totals.notReady.push(entry);
      }
    }
    if (isTouched) totals.touched += 1;
  }
  return totals;
};

/** The result's closing figures — `changed`, `inSync`, `search` — and the tally behind them */
const finalize = (result, search, settle = false) => {
  const totals = tally(result, search, settle);
  if (search?.declared) result.search = searchSummary(search, totals.notReady);
  const { changes, applied, conflicts } = totals;
  if (result.dryRun) {
    result.changed = changes;
    result.inSync = changes === 0 && conflicts === 0;
  } else {
    result.changed = applied;
    result.inSync = conflicts === 0 && applied === changes && !(result.unstable?.length > 0);
  }
  return totals;
};

/**
 * Say a step is starting, before it runs: the `converge:action` event with
 * status `'started'` for every step, and a log line for an index build — on a
 * large collection it is the only sign of which index the run is busy with.
 */
const announce = (deps, collection, step) => {
  for (const action of step.actions) {
    deps.emit('converge:action', {
      collection,
      target: action.target,
      name: action.name,
      action: action.action,
      status: 'started',
      ...(action.reason !== undefined ? { reason: action.reason } : {}),
    });
    const line = `… ${STARTING[action.action] ?? action.action} ${describeTarget(action, collection)}`;
    const fields = deps.fields({
      collection,
      target: action.target,
      name: action.name,
      action: action.action,
      status: 'started',
    });
    if (BUILD_STEPS.has(step.op)) deps.logger.info(line, fields);
    else deps.logger.debug(line, fields);
  }
};

/** The history's rows: each kept action, with the collection it is on */
const listHistoryRows = (history) => {
  const rows = [];
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    rows.push({ collection: entry[0], ...entry[1] });
  }
  return rows;
};

/**
 * Append the run to the converge history — a run that changed something or
 * failed; a converge that found everything in place is not news. Best-effort,
 * like the changelog's failure trace: a history that cannot be written is
 * warned about, never allowed to turn a converge that worked into a failure.
 */
const recordHistory = async (deps, options, result, { startedAt, error, history }) => {
  if (typeof deps.record !== 'function') return;
  if (error === undefined && result.changed === 0) return;
  const finishedAt = new Date();
  try {
    await deps.record({
      ...deps.audit(),
      trigger: options.trigger ?? 'converge',
      startedAt: new Date(startedAt),
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt,
      success: error === undefined,
      ...(error !== undefined ? { error: formatError(error) } : {}),
      ...pickActor(options),
      changed: result.changed,
      actions: listHistoryRows(history),
      ...(result.fingerprint !== undefined ? { fingerprint: result.fingerprint } : {}),
      ...(result.unstable ? { unstable: result.unstable } : {}),
      ...(result.search ? { search: result.search } : {}),
    });
  } catch (recordError) {
    deps.logger.warn(
      `⚠ Could not record the converge in its history: ${formatError(recordError)}`,
      deps.fields({ error: formatError(recordError) }),
    );
  }
};

module.exports = {
  settleRest,
  finalize,
  announce,
  recordHistory,
};
