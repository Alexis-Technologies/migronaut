const { createHash } = require('node:crypto');
const { ConvergeFailedError } = require('../../errors/index.js');
const { errorText } = require('../../utils/error.js');
const {
  CHANGE_ACTIONS,
  SEARCH_UNAVAILABLE_REASON,
  isDestructive,
  planCollection,
} = require('./plan.js');
const { SEARCH_UNAVAILABLE_HINT } = require('./search.js');
const {
  SEARCH_SETTLE_DELAYS_MS,
  pause,
  readSearch,
  readSearchIndexes,
  refreshBuilds,
  reportNotReady,
  waitPhase,
  warnIgnored,
} = require('./search-run.js');
const { inPlaceCapabilities } = require('./index-spec.js');
const { belowVersionFilter } = require('../../versioning/document.js');
const { READ_OPTIONS, readServer } = require('../server-info.js');
const {
  FLOOR_PROBE_TIMEOUT_MS,
  probeVersionFloor,
  probeVersionFloors,
  readLiveState,
  readLiveStates,
  readShardKeys,
} = require('./live.js');
const {
  attachConverge,
  describe,
  describeAll,
  LABELS,
  whatOf,
  wrapFailure,
} = require('./failure.js');
const { runStep } = require('./steps.js');
const { announce, finalize, recordHistory, settleRest } = require('./report.js');

/**
 * Converge: bring the declared collections' indexes, search indexes and
 * validators to their declared state. Stateless — every run reads
 * `listCollections`, `listIndexes` (and `$listSearchIndexes` where search
 * indexes are declared), plans against what it finds (plan.js), and carries
 * the plan out one operation at a time. The declaration is the only source of
 * truth, and the database is checked against it afresh each time: the history
 * a run appends (log.js) is for people, and nothing reads it back to
 * decide what to do.
 *
 * Pure orchestration over capabilities the MigratorKit injects (`deps`):
 * `{db, logger, fields, emit, assertNotAborted}`, and optionally `audit` +
 * `record` (the history entry), `shardKeyOf` (behind a mongos), `releaseLock`
 * (`() => Promise<boolean>`: give the run's lock up before waiting for search
 * index builds), `recordSearchWait` (`(waitedMs, outcome)`: the wait's
 * metric point), and `sleep` (`(ms, signal) => Promise`, cut short by an
 * abort) and `now` (`() => ms`) — the pause between search index reads and
 * the clock that times a wait for them, for tests.
 */
/**
 * The read and plan phases: every declared collection's live state (one
 * read for all of them), and its plan. Behind a mongos each live state also
 * carries the collection's shard key, so the plan keeps the index behind it.
 *
 * Returns `{ planFor, live, plans }` — `planFor(definition, live)` plans one
 * collection with the run's options, for the re-plans and the fixed-point
 * check to come.
 */
const readAndPlan = async (deps, options) => {
  const { db } = deps;
  const { definitions } = options;
  const pruneFor = (definition) => definition.prune ?? options.prune ?? false;
  const server = await readServer(db);
  const capabilities = inPlaceCapabilities(server.version);
  // The names to read, and whether any definition declares search indexes — one pass.
  const names = [];
  let declared = false;
  for (let position = 0; position < definitions.length; position++) {
    const definition = definitions[position];
    names.push(definition.name);
    if (definition.searchIndexes !== undefined) declared = true;
  }
  const search = {
    declared,
    available: true,
    onUnavailable: options.search?.onUnavailable ?? 'fail',
    waitRequested: options.search?.wait === true && !options.dryRun,
  };
  // Reads `search` at call time: a skip at apply time turns Search off for the rest of the run.
  const planFor = (definition, live) =>
    planCollection(definition, live, {
      prune: pruneFor(definition),
      rebuildUnique: options.rebuildUnique === true,
      capabilities,
      search: { available: search.available, onUnavailable: search.onUnavailable },
    });

  const live = await readLiveStates(db, names);
  if (server.mongos) {
    const shardKeys = await readShardKeys(deps, names);
    for (let position = 0; position < names.length; position++) {
      const name = names[position];
      if (shardKeys.has(name)) live[position].shardKey = shardKeys.get(name);
    }
  }
  if (search.declared) await readSearch(deps, server, definitions, live, search);
  await probeVersionFloors(db, definitions, live);
  const plans = [];
  const ignored = [];
  for (let position = 0; position < definitions.length; position++) {
    const definition = definitions[position];
    const plan = planFor(definition, live[position]);
    plans.push(plan);
    reviewPlan(deps, definition, plan, pruneFor(definition), ignored);
  }
  warnIgnored(deps, ignored);
  return { planFor, live, plans, search };
};

/** The warning for one emptied list (`indexes: []` or `searchIndexes: []`) that prune drops */
const warnEmptied = (deps, definition, key, names, what) => {
  if (definition[key]?.length !== 0 || names.length === 0) return;
  deps.logger.warn(
    `⚠ ${definition.name}: ${key}: [] with prune drops ${what} (${names.join(', ')})`,
    deps.fields({ collection: definition.name, drops: names.length }),
  );
};

/**
 * One pass over a fresh plan for what is worth saying before anything runs:
 * the search index options the comparison left out (gathered into `ignored`,
 * for one line about all of them), and every drop of `indexes: []` or
 * `searchIndexes: []` with prune — "none here", every index but _id goes.
 * Legitimate, and easy to write by accident: say it out loud.
 */
const reviewPlan = (deps, definition, plan, prune, ignored) => {
  const emptied =
    prune && (definition.indexes?.length === 0 || definition.searchIndexes?.length === 0);
  const indexDrops = [];
  const searchDrops = [];
  for (const action of plan.actions) {
    if (action.ignored) ignored.push(`${plan.name}.${action.name} (${action.ignored.join(', ')})`);
    if (!emptied || action.action !== 'drop') continue;
    if (action.target === 'index') indexDrops.push(action.name);
    else if (action.target === 'searchIndex') searchDrops.push(action.name);
  }
  if (!emptied) return;
  warnEmptied(deps, definition, 'indexes', indexDrops, 'every index but _id');
  warnEmptied(deps, definition, 'searchIndexes', searchDrops, 'every search index');
};

/**
 * One collection's live state read afresh — its search indexes too, when it
 * declares any and the server has Search — for a re-plan (`phase: 'replan'`)
 * or the verify phase (`'apply'`): what a failed read is reported as.
 */
const readFresh = async (run, position, phase) => {
  const { deps, definitions, live, search } = run;
  const definition = definitions[position];
  const fresh = await readLiveState(deps.db, definition.name);
  if (live[position].shardKey) fresh.shardKey = live[position].shardKey;
  const readsSearch =
    search.available &&
    definition.searchIndexes !== undefined &&
    fresh.exists &&
    fresh.type === 'collection';
  if (readsSearch) {
    fresh.searchIndexes = await readSearchIndexes(deps, definition.name, phase);
  }
  await probeVersionFloor(deps.db, definition, fresh);
  return fresh;
};

/** A dry run's answer: the plan as the result, and one line about it */
const reportPlan = (deps, result, search) => {
  const totals = finalize(result, search);
  const total = result.collections.length;
  const line = `◎ Planned  ${result.changed} change(s) in ${totals.touched} of ${total} collection(s)`;
  const fields = deps.fields({ dryRun: true, changed: result.changed, collections: total });
  // A probe that finds nothing to do (a scheduler tick, a CI gate) is not news.
  if (result.inSync) deps.logger.debug(line, fields);
  else deps.logger.info(line, fields);
  return result;
};

/**
 * A plan in one word: a digest of everything it would change or refuse —
 * each such row's collection, target, name, action and reason, in a fixed
 * order. `undefined` for a plan that asks for nothing.
 *
 * Two plans with the same fingerprint ask the same of the database, which is
 * how a failure that repeats is told from news: the history counts it on the
 * entry it repeats, and a schedule that converges (the queue's sync tick)
 * stops asking for a converge that failed on this very plan — a definition
 * that needs `rebuildUnique`, or data that must be fixed first, is not
 * settled by trying again every minute.
 */
const planFingerprint = (plans) => {
  const rows = [];
  for (const { name, actions } of plans) {
    for (const action of actions) {
      if (!CHANGE_ACTIONS.has(action.action) && action.action !== 'conflict') continue;
      rows.push(
        [name, action.target, action.name, action.action, action.reason ?? ''].join('\u0000'),
      );
    }
  }
  if (rows.length === 0) return undefined;
  rows.sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 32);
};

/** The guard phase: a plan with any conflict refuses the whole run, before the first write */
const refuseConflicts = (result) => {
  const conflicts = [];
  let unavailable = false;
  // The conflicts as the message lists them.
  let listed = '';
  for (const collection of result.collections) {
    for (const action of collection.actions) {
      if (action.action !== 'conflict') continue;
      if (action.reason === SEARCH_UNAVAILABLE_REASON) unavailable = true;
      const conflict = {
        collection: collection.name,
        target: action.target,
        name: action.name,
        reason: action.reason,
        ...(action.liveName !== undefined ? { liveName: action.liveName } : {}),
      };
      conflicts.push(conflict);
      if (conflicts.length > 1) listed += '; ';
      listed +=
        conflict.target === 'collection'
          ? `${conflict.collection} ${conflict.reason}`
          : `${conflict.collection} ${describe(conflict)}: ${conflict.reason}`;
    }
  }
  if (conflicts.length === 0) return;
  settleRest(result);
  throw new ConvergeFailedError(
    `Converge refused: ${conflicts.length} conflict(s) — ${listed}` +
      (unavailable ? ` — ${SEARCH_UNAVAILABLE_HINT}` : ''),
    {
      context: {
        phase: 'plan',
        conflicts,
        ...(unavailable ? { hint: SEARCH_UNAVAILABLE_HINT } : {}),
        converge: result,
      },
    },
  );
};

/**
 * The collection at `position`, planned afresh — the guard again, right
 * before its turn. It may only have become *less* to do: a conflict or a
 * drop/rebuild that the plan the run started from did not have — an index
 * someone created meanwhile — refuses the run here, before this collection is
 * touched, rather than act on what nobody reviewed.
 */
const replan = async (run, position) => {
  const { definitions, plans, result, planFor } = run;
  const definition = definitions[position];
  const plan = planFor(definition, await readFresh(run, position, 'replan'));
  const known = new Set();
  for (const action of plans[position].actions) {
    known.add(`${action.target}:${action.name}:${action.action}`);
  }
  // What the new plan asks that the reviewed one did not, and the message's list of it.
  const introduced = [];
  let listed = '';
  for (let i = 0; i < plan.actions.length; i++) {
    const row = plan.actions[i];
    const { target, name, action, reason } = row;
    if (action !== 'conflict' && !isDestructive(row)) continue;
    if (known.has(`${target}:${name}:${action}`)) continue;
    if (introduced.length > 0) listed += '; ';
    listed += `${describe(row)} now ${action}`;
    introduced.push({ target, name, action, ...(reason !== undefined ? { reason } : {}) });
  }
  if (introduced.length === 0) return plan;
  result.collections[position].actions = plan.actions;
  settleRest(result);
  throw new ConvergeFailedError(
    `Converge stopped before ${definition.name}: it changed while the run was under way — ` +
      listed,
    { context: { phase: 'replan', collection: definition.name, introduced, converge: result } },
  );
};

/** A declared index found under another name is kept as it is — say so */
const warnRenamed = (deps, plan) => {
  for (const action of plan.actions) {
    if (action.liveName !== undefined && action.action === 'unchanged') {
      deps.logger.warn(
        `⚠ ${plan.name}: index "${action.name}" exists as "${action.liveName}" — kept under ` +
          'its current name',
        deps.fields({ collection: plan.name, index: action.name, liveName: action.liveName }),
      );
    }
  }
};

/** Mark a row applied, and say so: the `converge:action` event and its log line */
const settler = (deps, collection) => {
  return (action, durationMs) => {
    action.status = 'applied';
    action.durationMs = durationMs;
    deps.emit('converge:action', {
      collection,
      target: action.target,
      name: action.name,
      action: action.action,
      status: 'applied',
      durationMs,
      ...(action.reason !== undefined ? { reason: action.reason } : {}),
    });
    // A search index is only accepted here; the server builds it afterwards.
    const building =
      action.target === 'searchIndex' && action.action !== 'drop'
        ? ' — building on the server'
        : '';
    deps.logger.info(
      `${LABELS[action.action]} ${whatOf(action, collection)}   [${durationMs}ms]${building}`,
      deps.fields({
        collection,
        target: action.target,
        name: action.name,
        action: action.action,
        durationMs,
      }),
    );
  };
};

/** Stop here when the run was aborted: every row not reached is settled, the result attached */
const stopIfAborted = (deps, signal, result) => {
  try {
    deps.assertNotAborted(signal);
  } catch (error) {
    settleRest(result);
    throw attachConverge(error, result);
  }
};

/**
 * The apply phase for one collection: its steps, in order. Returns the
 * indexes the server would not let go of (a shard key's), which the verify
 * phase must not report as unstable. A failed step stops the run.
 */
const applyCollection = async (deps, plan, result, signal, search) => {
  const kept = new Set();
  const settle = settler(deps, plan.name);
  for (const step of plan.steps) {
    // Between operations is the only safe place to stop — and never inside
    // a rebuild, which runs its drop and its create back to back.
    stopIfAborted(deps, signal, result);
    announce(deps, plan.name, step);
    const failure = await runStep(deps.db, plan.name, step, settle, search);
    if (failure?.skipped) {
      // Search turned out to be missing after all: the rest of the run plans
      // every search index as skipped instead of asking again.
      search.available = false;
      deps.logger.warn(
        `⚠ ${plan.name}: Atlas Search refused ${describeAll(step.actions)} — skipped ` +
          "(onSearchUnavailable: 'skip')",
        deps.fields({ collection: plan.name }),
      );
      continue;
    }
    if (failure?.kept) {
      for (const action of step.actions) {
        kept.add(action.name);
        deps.logger.warn(
          `⚠ ${plan.name}: index "${action.name}" backs the shard key — kept, not dropped`,
          deps.fields({ collection: plan.name, index: action.name }),
        );
      }
      continue;
    }
    if (failure) {
      const { error, actions, extra } = failure;
      for (const action of actions) {
        action.status = 'failed';
        deps.emit('converge:action', {
          collection: plan.name,
          target: action.target,
          name: action.name,
          action: action.action,
          status: 'failed',
          error: errorText(error),
        });
      }
      settleRest(result);
      throw wrapFailure(error, plan.name, actions, result, extra);
    }
  }
  return kept;
};

/** Whether a row of `target` in `actions` was applied */
const hasApplied = (actions, target) => {
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].target === target && actions[i].status === 'applied') return true;
  }
  return false;
};

/** Whether a plan still changes a search index */
const changesSearchIndex = (actions) => {
  for (let i = 0; i < actions.length; i++) {
    if (actions[i].target === 'searchIndex' && CHANGE_ACTIONS.has(actions[i].action)) return true;
  }
  return false;
};

/**
 * After a run raised `versioning.min`: old-shape documents written while it
 * ran (an old pod still deploying) got past the probe. Converge cannot undo
 * the validator, so it says so — those documents now fail validation on
 * their next strict write, and a background migration has to pick them up.
 */
const warnFloorBreach = async (run, position) => {
  const { deps, definitions, live, result } = run;
  const floor = live[position].versionFloor;
  if (floor?.below !== false) return;
  if (!hasApplied(result.collections[position].actions, 'validator')) return;
  const definition = definitions[position];
  let found = null;
  try {
    found = await deps.db
      .collection(definition.name)
      .findOne(belowVersionFilter(definition.versioning, floor.min), {
        projection: { _id: 1 },
        maxTimeMS: FLOOR_PROBE_TIMEOUT_MS,
        ...READ_OPTIONS,
      });
  } catch (error) {
    // A warning, at best: a probe that cannot answer leaves the run as it is.
    deps.logger.debug(
      `${definition.name}: could not probe for documents below version ${floor.min} — ${errorText(error)}`,
      deps.fields({ collection: definition.name, error: errorText(error) }),
    );
    return;
  }
  if (found === null) return;
  deps.logger.warn(
    `⚠ ${definition.name}: documents below version ${floor.min} were written while converge ` +
      'raised versioning.min — an old release is still writing; run the background migration ' +
      'again once it is gone',
    deps.fields({ collection: definition.name, min: floor.min }),
  );
};

/**
 * The verify phase — the fixed-point check: what was just applied must now
 * compare as unchanged. Anything that does not would be "changed" again on
 * every run — a comparison rule that disagrees with this server version — so
 * it is reported in `result.unstable` instead of silently rebuilt forever.
 */
const verifyFixedPoint = async (run, position, kept, signal) => {
  const { deps, definitions, result, planFor } = run;
  const definition = definitions[position];
  let after = planFor(definition, await readFresh(run, position, 'apply'));
  // The search index list catches up with a create or an update a moment
  // later: read it again a few times before calling anything unstable.
  const rows = result.collections[position].actions;
  const submitted = hasApplied(rows, 'searchIndex');
  for (const delay of submitted ? SEARCH_SETTLE_DELAYS_MS : []) {
    if (!changesSearchIndex(after.actions)) break;
    await (deps.sleep ?? pause)(delay, signal);
    stopIfAborted(deps, signal, result);
    after = planFor(definition, await readFresh(run, position, 'apply'));
  }
  refreshBuilds(rows, after.actions);
  await warnFloorBreach(run, position);
  for (const action of after.actions) {
    if (!CHANGE_ACTIONS.has(action.action)) continue;
    if (action.action === 'drop' && kept.has(action.name)) continue;
    (result.unstable ??= []).push({
      collection: definition.name,
      target: action.target,
      name: action.name,
      action: action.action,
      ...(action.reason !== undefined ? { reason: action.reason } : {}),
    });
    // Every update of a search index has the server build it again: say what that costs.
    const rebuilds =
      action.target === 'searchIndex'
        ? ', and every update builds the search index again on the server — declare the value ' +
          'the server reports'
        : '';
    deps.logger.warn(
      `⚠ ${definition.name}: ${describe(action)} still differs after converge` +
        `${action.reason ? ` (${action.reason})` : ''} — it would change again on every run` +
        rebuilds,
      deps.fields({ collection: definition.name, target: action.target, name: action.name }),
    );
  }
};

/** "Kept 2 undeclared index(es) and 1 search index(es)" — the parts there are */
const keptLine = (kept) => {
  const parts = [];
  if (kept.indexes > 0) parts.push(`${kept.indexes} undeclared index(es)`);
  if (kept.searchIndexes > 0) {
    parts.push(`${kept.searchIndexes} ${kept.indexes > 0 ? '' : 'undeclared '}search index(es)`);
  }
  return parts.length > 0 ? `• Kept ${parts.join(' and ')} — converge with prune to drop them` : '';
};

/** A converge that ran to the end: its closing lines, its history entry, `converge:end` */
const reportSuccess = async (deps, options, result, startedAt, search) => {
  const { logger } = deps;
  const total = result.collections.length;
  const totals = finalize(result, search, true);
  const durationMs = Date.now() - startedAt;
  const { kept } = totals;
  if (result.changed > 0) {
    logger.info(
      `✔ Converged ${result.changed} change(s) in ${totals.touched} of ${total} ` +
        `collection(s) in ${durationMs}ms`,
      deps.fields({ changed: result.changed, collections: total, durationMs }),
    );
  } else {
    logger.info(
      'Collections already match their declarations',
      deps.fields({ collections: total, durationMs }),
    );
  }
  const line = keptLine(kept);
  if (line) {
    logger.info(line, deps.fields({ kept: kept.indexes + kept.searchIndexes }));
  }
  reportNotReady(deps, result);
  await recordHistory(deps, options, result, { startedAt, history: totals.history });
  deps.emit('converge:end', {
    trigger: options.trigger ?? 'converge',
    success: true,
    durationMs,
    changed: result.changed,
    inSync: result.inSync,
    counts: totals.counts,
    result,
  });
};

/** A converge that stopped: its history entry and `converge:end` — the error is the caller's */
const reportFailure = async (deps, options, result, startedAt, error, search) => {
  const totals = finalize(result, search);
  await recordHistory(deps, options, result, { startedAt, error, history: totals.history });
  deps.emit('converge:end', {
    trigger: options.trigger ?? 'converge',
    success: false,
    durationMs: Date.now() - startedAt,
    changed: result.changed,
    inSync: false,
    counts: totals.counts,
    error: errorText(error),
    result,
  });
};

/**
 * Plan every declared collection and, unless `dryRun`, carry the plans out:
 * read → plan → guard → (per collection: re-plan → apply → verify) → report.
 *
 * `options`: `{ definitions, prune?, rebuildUnique?, dryRun?, trigger?, requestedBy?,
 * reason?, search? }` —
 * `definitions` normalized (collections.js); `prune` the default for
 * definitions that do not set their own; `rebuildUnique` lets a rebuild drop a
 * unique index it builds back (a conflict otherwise); `trigger` is
 * `'converge'` or `'up'` (the after-up hook), for events and logs; `search`
 * is `{ onUnavailable, wait, waitTimeoutMs }` — `'fail'` (the default)
 * refuses declared search indexes on a server without Atlas Search, `'skip'`
 * converges without them; `wait` holds the run until every declared search
 * index serves its declaration, for at most `waitTimeoutMs`.
 *
 * A plan with any conflict refuses the whole run before the first write. A
 * failed step stops the run (`ConvergeFailedError`); an abort between steps
 * stops it with the abort's own error. Either way `context.converge` holds
 * the result so far.
 */
const runConverge = async (deps, options, signal) => {
  const { definitions, dryRun = false, trigger = 'converge' } = options;
  const startedAt = Date.now();
  let planned = null;
  try {
    planned = await readAndPlan(deps, options);
  } catch (error) {
    throw attachConverge(error, { dryRun, changed: 0, inSync: false, collections: [] });
  }
  const { planFor, live, plans, search } = planned;
  const fingerprint = planFingerprint(plans);
  const collections = [];
  for (let i = 0; i < plans.length; i++) {
    collections.push({ name: plans[i].name, actions: plans[i].actions });
  }
  const result = {
    dryRun,
    changed: 0,
    inSync: true,
    collections,
    // Of the plan as first read: what a dry run of the same database gives.
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
  if (dryRun) return reportPlan(deps, result, search);

  const wait = {
    enabled: options.search?.wait === true,
    timeoutMs: options.search?.waitTimeoutMs,
  };
  const run = { deps, definitions, live, plans, result, planFor, search, wait };
  deps.emit('converge:start', { trigger, collections: definitions.length });
  try {
    refuseConflicts(result);
    for (const position of plans.keys()) {
      // Every collection but the first is re-read and re-planned right before
      // its turn: the ones before it may have built indexes for hours, and a
      // plan made at the start would act on a database that has moved on.
      const plan = position === 0 ? plans[0] : await replan(run, position);
      plans[position] = plan;
      result.collections[position].actions = plan.actions;
      warnRenamed(deps, plan);
      if (plan.steps.length === 0) continue;
      const kept = await applyCollection(deps, plan, result, signal, search);
      await verifyFixedPoint(run, position, kept, signal);
    }
    await waitPhase(run, signal);
    await reportSuccess(deps, options, result, startedAt, search);
    return result;
  } catch (error) {
    // Whatever stopped the run, no row is left `planned`, and the error
    // carries the result so far — a failed read included.
    settleRest(result);
    await reportFailure(deps, options, result, startedAt, error, search);
    throw attachConverge(error, result);
  }
};

module.exports = {
  planFingerprint,
  runConverge,
};
