const { setTimeout: sleepFor } = require('node:timers/promises');
const { ConvergeFailedError, MigronautError } = require('../errors/index.js');
const { mapLimit } = require('../utils/concurrency.js');
const { errorText } = require('../utils/error.js');
const { SERVED_ACTIONS } = require('./converge-plan.js');
const {
  awaitSearchIndexes,
  listSearchIndexes,
  probeSearch,
  searchHint,
} = require('./converge-search.js');
const { searchBuild, searchBuildState } = require('./search-index-spec.js');
const { READ_CONCURRENCY, READ_OPTIONS } = require('./server-info.js');

/**
 * The search half of a converge run: reading the live search indexes (and
 * whether the server has Search at all), the run's word on Search in its
 * result, and the optional wait for the builds — with the log lines, events
 * and metric point that tell it. Orchestration over the same `deps` as
 * converge.js, which calls in at its read, verify, wait and report phases;
 * the commands themselves are converge-search.js's.
 */

/**
 * Pauses before the search indexes of a collection are read again, when the
 * first read after a create or an update does not show it yet — the list is
 * eventually consistent. A fixed, short budget: anything still differing
 * after it is reported as unstable, as for regular indexes.
 */
const SEARCH_SETTLE_DELAYS_MS = [250, 500, 1000];

/** Sleep `ms` — less, when `signal` aborts: the caller's next abort check says why */
async function pause(ms, signal) {
  try {
    await sleepFor(ms, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (error?.name !== 'AbortError') throw error;
  }
}

/**
 * The run's word on Search, when search indexes are declared: whether the
 * server has it (and how that was told — `evidence`), every declared index
 * that exists but does not serve its latest definition yet — building,
 * updating, stale or failed — and how a wait for them ended (`wait`).
 */
function searchSummary(result, search) {
  const notReady = [];
  for (const collection of result.collections) {
    for (const action of collection.actions) {
      if (action.target !== 'searchIndex' || action.build === undefined) continue;
      if (!SERVED_ACTIONS.has(action.action)) continue;
      if (searchBuildState(action.build) === 'serving') continue;
      notReady.push({ collection: collection.name, name: action.name, ...action.build });
    }
  }
  return {
    available: search.available,
    ...(search.evidence !== undefined ? { evidence: search.evidence } : {}),
    notReady,
    ...(search.wait !== undefined ? { wait: search.wait } : {}),
  };
}

/**
 * One line for every search index whose server-reported options the
 * comparison left out — the declarations do not set them, and migronaut knows
 * no default for them (a newer mongot's). Not a problem; worth knowing.
 */
function warnIgnored(deps, plans) {
  const found = [];
  for (const plan of plans) {
    for (const action of plan.actions) {
      if (action.target !== 'searchIndex' || !action.ignored) continue;
      found.push(`${plan.name}.${action.name} (${action.ignored.join(', ')})`);
    }
  }
  if (found.length === 0) return;
  deps.logger.warn(
    `⚠ The server reports search index options the declarations do not set, with no default ` +
      `migronaut knows — left out of the comparison: ${found.join('; ')} — declare them to ` +
      'manage them',
    deps.fields({ searchIndexes: found.length }),
  );
}

/**
 * A search index read that failed for a reason other than "no Search here",
 * in the phase it happened in: `'plan'` (nothing written yet), `'replan'`,
 * `'apply'` (the verify phase after a collection's steps) or `'wait'`.
 */
function searchReadFailure(error, collection, phase) {
  if (error instanceof MigronautError) return error;
  const mongoCode = typeof error?.code === 'number' ? error.code : undefined;
  const hint = searchHint(error);
  const cause = errorText(error);
  return new ConvergeFailedError(
    `Could not read the search indexes of ${collection}: ${cause}${hint ? ` — ${hint}` : ''}`,
    {
      phase,
      ...(phase === 'wait' ? { reason: 'unreadable' } : {}),
      collection,
      target: 'searchIndex',
      cause,
      ...(mongoCode !== undefined ? { mongoCode } : {}),
      ...(hint ? { hint } : {}),
    },
    { cause: error },
  );
}

/**
 * The search half of the read phase: whether the server has Atlas Search
 * (one probe, cached in `search` for the run), and the live search indexes of
 * every existing collection that declares some. Collections that declare
 * none are never asked — a run without `searchIndexes` makes no search call.
 */
async function readSearch(deps, server, definitions, live, search) {
  const declaring = [];
  for (const [position, definition] of definitions.entries()) {
    if (definition.searchIndexes !== undefined) declaring.push(position);
  }
  const isRegular = (position) => live[position].exists && live[position].type === 'collection';
  const existing = declaring.filter(isRegular);
  // A view or a time-series collection is refused by the planner anyway.
  const target = existing[0] ?? declaring.find((position) => !live[position].exists);
  if (target === undefined) return;
  const targetName = definitions[target].name;
  let probe;
  try {
    probe = await probeSearch(deps.db, server, {
      collection: targetName,
      readOptions: READ_OPTIONS,
    });
  } catch (error) {
    throw searchReadFailure(error, targetName, 'plan');
  }
  search.available = probe.available;
  search.evidence = probe.evidence;
  if (!probe.available) {
    deps.logger.debug(
      `Atlas Search is not available: ${probe.reason}`,
      deps.fields({ evidence: probe.evidence }),
    );
    warnSkipping(deps, definitions, search);
    return;
  }
  if (probe.evidence === 'assumed') {
    // Worth seeing when the run is about to wait on what it assumed.
    deps.logger[search.waitRequested ? 'info' : 'debug'](
      'Atlas Search assumed available: the server listed no search index and would not say more',
      deps.fields({ evidence: probe.evidence }),
    );
  }
  await mapLimit(existing, READ_CONCURRENCY, async (position) => {
    if (position === target) {
      live[position].searchIndexes = probe.listed;
      return;
    }
    live[position].searchIndexes = await readSearchIndexes(
      deps,
      definitions[position].name,
      'plan',
    );
  });
}

async function readSearchIndexes(deps, name, phase) {
  try {
    return await listSearchIndexes(deps.db, name, READ_OPTIONS);
  } catch (error) {
    throw searchReadFailure(error, name, phase);
  }
}

/** In skip mode, one line for every declared search index the run will not touch */
function warnSkipping(deps, definitions, search) {
  if (search.onUnavailable !== 'skip') return;
  let count = 0;
  for (const definition of definitions) count += definition.searchIndexes?.length ?? 0;
  if (count === 0) return;
  deps.logger.warn(
    `⚠ Atlas Search is not available on this server — skipping ${count} declared search ` +
      "index(es) (onSearchUnavailable: 'skip')",
    deps.fields({ skipped: count }),
  );
}

/** The build state each search index row now has, from the verify phase's read */
function refreshBuilds(rows, fresh) {
  const builds = new Map();
  for (const action of fresh) {
    if (action.target === 'searchIndex' && action.build !== undefined) {
      builds.set(action.name, action.build);
    }
  }
  for (const row of rows) {
    if (row.target === 'searchIndex' && builds.has(row.name)) row.build = builds.get(row.name);
  }
}

/** How often a wait for search indexes says it is still waiting */
const WAIT_PROGRESS_MS = 30_000;

/**
 * Every declared search index a wait is for: the ones that exist (or were
 * just created) — with, for one this run updated, the definition version the
 * update started from, so the old definition reading READY does not count —
 * and whether this run created or changed it (`touched`): a FAILED or STALE
 * index the run did not touch does not hold the wait (see awaitSearchIndexes).
 */
function waitTargets(run) {
  const { definitions, plans, result } = run;
  const targets = [];
  for (const [position, definition] of definitions.entries()) {
    const rows = result.collections[position].actions;
    for (const declared of definition.searchIndexes ?? []) {
      const row = rows.find(
        (action) => action.target === 'searchIndex' && action.name === declared.name,
      );
      if (!row || !SERVED_ACTIONS.has(row.action)) continue;
      const update = plans[position].steps.find(
        (step) => step.op === 'updateSearchIndex' && step.name === declared.name,
      );
      targets.push({
        collection: definition.name,
        name: declared.name,
        ...(update?.sinceVersion !== undefined ? { sinceVersion: update.sinceVersion } : {}),
        touched: row.action !== 'unchanged',
      });
    }
  }
  return targets;
}

/** `movies.default (BUILDING), shows.plot (FAILED: …)` */
function describeNotReady(notReady) {
  return notReady
    .map((index) => {
      const state = searchBuildState(index);
      const note =
        state === 'updating' ? ', updating' : state === 'stale' ? ', not replicating' : '';
      return (
        `${index.collection}.${index.name} (${index.status}${note}` +
        `${index.message ? `: ${index.message}` : ''})`
      );
    })
    .join(', ');
}

/** Why a wait ran out, and what to do — a STALE index will not get there by waiting longer */
function timeoutAdvice(notReady) {
  const stale = notReady.filter((index) => searchBuildState(index) === 'stale');
  if (stale.length === notReady.length) {
    return 'a STALE index is queryable but no longer replicating from the collection — see troubleshooting';
  }
  return 'the server goes on building; converge again to wait more, or raise searchIndexWaitTimeoutMs';
}

/**
 * The wait phase (`waitForSearchIndexes`): after every collection's steps,
 * poll until each declared search index serves its declaration — or fail the
 * run on a FAILED build or when the budget runs out. It only reads, so the
 * migration lock is given up first (`deps.releaseLock`, when the run holds
 * one): other runs — the next deploy, a queue's jobs — need not wait out a
 * build. The run itself goes on until the wait ends; an abort (a stop) ends
 * the wait between polls, and cuts the pause before the next one short.
 */
async function waitPhase(run, signal) {
  const { deps, result, search, wait } = run;
  if (!wait.enabled || !search.declared || !search.available) return;
  const targets = waitTargets(run);
  if (targets.length === 0) return;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const lockReleased = typeof deps.releaseLock === 'function' && (await deps.releaseLock());
  const limit =
    wait.timeoutMs === undefined ? '' : ` (up to ${Math.round(wait.timeoutMs / 1000)}s)`;
  deps.logger.info(
    `… Waiting for ${targets.length} search index(es) to become queryable${limit}` +
      (lockReleased ? ' — the migration lock is released meanwhile' : ''),
    deps.fields({ searchIndexes: targets.length, timeoutMs: wait.timeoutMs, lockReleased }),
  );
  deps.emit('converge:wait', {
    status: 'started',
    searchIndexes: targets.length,
    lockReleased,
    ...(wait.timeoutMs !== undefined ? { timeoutMs: wait.timeoutMs } : {}),
  });
  let reportedAt = startedAt;
  let ended = 'aborted';
  let notReady = [];
  const sleep = deps.sleep ?? pause;
  try {
    const outcome = await awaitSearchIndexes({
      targets,
      read: (collection) => readSearchIndexes(deps, collection, 'wait'),
      timeoutMs: wait.timeoutMs,
      sleep: (ms) => sleep(ms, signal),
      now,
      // An abort ends the wait here; runConverge attaches the result to it.
      beforePoll: () => deps.assertNotAborted(signal),
      onReadError: (error, inARow) => {
        deps.logger.warn(
          `⚠ Could not read the search indexes (${inARow} in a row) — trying again: ` +
            errorText(error),
          deps.fields({ error: errorText(error), consecutiveFailures: inARow }),
        );
      },
      onPoll: (live) => {
        for (const collection of result.collections) {
          for (const row of collection.actions) {
            const index = live.get(`${collection.name}\u0000${row.name}`);
            if (row.target === 'searchIndex' && index) row.build = searchBuild(index);
          }
        }
        if (now() - reportedAt < WAIT_PROGRESS_MS) return;
        reportedAt = now();
        const waitedMs = reportedAt - startedAt;
        deps.logger.info(
          `… Still waiting for search indexes [${Math.round(waitedMs / 1000)}s]`,
          deps.fields({ waitedMs }),
        );
        deps.emit('converge:wait', { status: 'progress', searchIndexes: targets.length, waitedMs });
      },
    });
    ended = outcome.outcome;
    notReady = outcome.notReady;
    settleWait(deps, targets, outcome, wait, result);
  } catch (error) {
    if (error instanceof ConvergeFailedError && error.context?.reason === 'unreadable') {
      ended = 'unreadable';
    }
    throw error;
  } finally {
    const waitedMs = now() - startedAt;
    search.wait = { outcome: ended, waitedMs };
    deps.recordSearchWait?.(waitedMs, ended);
    deps.emit('converge:wait', {
      status: ended,
      searchIndexes: targets.length,
      waitedMs,
      ...(notReady.length > 0 ? { notReady } : {}),
    });
  }
}

/** A wait that ended: its closing lines — or, unless every index is ready, the error */
function settleWait(deps, targets, outcome, wait, result) {
  if (outcome.preexisting.length > 0) {
    deps.logger.info(
      `• Not waiting for ${outcome.preexisting.length} search index(es) this run did not ` +
        `change, which cannot get there by waiting: ${describeNotReady(outcome.preexisting)}`,
      deps.fields({ preexisting: outcome.preexisting.length }),
    );
  }
  if (outcome.outcome === 'ready') {
    const ready = targets.length - outcome.preexisting.length;
    deps.logger.info(
      `✔ Search index(es) queryable: ${ready}   [${outcome.waitedMs}ms]`,
      deps.fields({ searchIndexes: ready, waitedMs: outcome.waitedMs }),
    );
    return;
  }
  const failed = outcome.outcome === 'failed';
  throw new ConvergeFailedError(
    failed
      ? `Search index build failed: ${describeNotReady(outcome.notReady.filter((index) => index.status === 'FAILED'))} — fix the definition or the data, then converge again`
      : `Search index(es) not queryable after ${Math.round(outcome.waitedMs / 1000)}s: ` +
          `${describeNotReady(outcome.notReady)} — ${timeoutAdvice(outcome.notReady)}`,
    {
      phase: 'wait',
      reason: failed ? 'failed' : 'timeout',
      notReady: outcome.notReady,
      waitedMs: outcome.waitedMs,
      ...(wait.timeoutMs !== undefined ? { timeoutMs: wait.timeoutMs } : {}),
      converge: result,
    },
  );
}

/** Closing lines about search indexes that do not serve their declaration yet */
function reportNotReady(deps, result) {
  const notReady = result.search?.notReady ?? [];
  const building = notReady.filter(
    (index) => !['stale', 'failed'].includes(searchBuildState(index)),
  );
  if (building.length > 0) {
    deps.logger.info(
      `• ${building.length} search index(es) still building on the server: ` +
        building.map((index) => `${index.collection}.${index.name}`).join(', ') +
        ' — waitForSearchIndexes (CLI: --wait-search) waits for them',
      deps.fields({ building: building.length }),
    );
  }
  for (const index of notReady) {
    if (searchBuildState(index) === 'stale') {
      deps.logger.warn(
        `⚠ ${index.collection}: search index "${index.name}" is STALE — queryable, but no ` +
          'longer replicating from the collection, so its results may be out of date' +
          `${index.message ? `: ${index.message}` : ''}`,
        deps.fields({ collection: index.collection, searchIndex: index.name }),
      );
      continue;
    }
    if (searchBuildState(index) !== 'failed') continue;
    deps.logger.warn(
      `⚠ ${index.collection}: search index "${index.name}" failed to build` +
        `${index.message ? `: ${index.message}` : ''} — converge does not resubmit an unchanged ` +
        'definition; fix the definition or the data',
      deps.fields({ collection: index.collection, searchIndex: index.name }),
    );
  }
}

module.exports = {
  SEARCH_SETTLE_DELAYS_MS,
  pause,
  readSearch,
  readSearchIndexes,
  refreshBuilds,
  reportNotReady,
  searchSummary,
  waitPhase,
  warnIgnored,
};
