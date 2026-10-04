const { ConvergeFailedError, MigronautError } = require('../errors/index.js');
const { pickActor } = require('../utils/actor.js');
const { mapLimit } = require('../utils/concurrency.js');
const { errorText } = require('../utils/error.js');
const { CHANGE_ACTIONS, isDestructive, planCollection, summarize } = require('./converge-plan.js');
const { inPlaceCapabilities } = require('./index-spec.js');

/**
 * Converge: bring the declared collections' indexes and validators to their
 * declared state. Stateless — every run reads `listCollections` and
 * `listIndexes`, plans against what it finds (converge-plan.js), and carries
 * the plan out one operation at a time. The declaration is the only source of
 * truth, and the database is checked against it afresh each time: the history
 * a run appends (converge-log.js) is for people, and nothing reads it back to
 * decide what to do.
 *
 * Pure orchestration over capabilities the MigratorKit injects (`deps`):
 * `{db, logger, fields, emit, assertNotAborted}`, and optionally `audit` +
 * `record` (the history entry) and `shardKeyOf` (behind a mongos).
 */

/**
 * Read options forced onto both reads: the primary (a secondary may not have
 * an index build yet), and BSON values as plain JavaScript — an injected
 * client configured with `promoteValues: false` or `useBigInt64: true` would
 * otherwise hand back `Int32` objects or `1n`, and everything would compare as
 * changed.
 */
const READ_OPTIONS = Object.freeze({
  readPreference: 'primary',
  promoteLongs: true,
  promoteValues: true,
  useBigInt64: false,
  bsonRegExp: false,
});

/** listIndexes calls in flight while reading many collections — a pace, not a pool */
const READ_CONCURRENCY = 8;

const NAMESPACE_NOT_FOUND = 26;
const INDEX_NOT_FOUND = 27;
const NAMESPACE_EXISTS = 48;

/** What usually fixes the server error behind a failed step */
const HINTS = {
  11000:
    'existing documents hold duplicate values for this unique index — deduplicate them in a ' +
    'migration first',
  13: 'not authorized — collMod and creating a collection with a validator need the dbAdmin role',
  85:
    'an equivalent index already exists under another name — declare it under that name, or ' +
    'converge with prune to replace it',
  86: 'an index with this name already exists with a different key or options',
  359:
    'existing documents hold duplicate values for this key — deduplicate them in a migration ' +
    'first (the index was left as it was)',
};

/**
 * What the server is: a mongos in front of shards (its shard keys matter to
 * prune), and its version (what it can change in place). Best-effort — a
 * server that refuses to say gets the conservative answer: no in-place
 * extras, no shard-key handling.
 */
async function readServer(db) {
  const server = { mongos: false, version: undefined };
  if (typeof db.admin !== 'function') return server;
  try {
    const hello = await db.admin().command({ hello: 1 });
    server.mongos = hello?.msg === 'isdbgrid';
  } catch {
    // Unknown — treated as a replica set or standalone.
  }
  try {
    const info = await db.admin().command({ buildInfo: 1 });
    const [major, minor] = Array.isArray(info?.versionArray) ? info.versionArray : [];
    if (Number.isInteger(major) && Number.isInteger(minor)) server.version = { major, minor };
  } catch {
    // Unknown version: only the always-available in-place changes.
  }
  return server;
}

/** Shard key of each named collection, behind a mongos — when `config.collections` may be read */
async function readShardKeys(deps, names) {
  const keys = new Map();
  if (typeof deps.shardKeyOf !== 'function') return keys;
  for (const name of names) {
    try {
      const key = await deps.shardKeyOf(name);
      if (key) keys.set(name, key);
    } catch {
      // Not readable (privileges): a refused drop is caught when it happens.
    }
  }
  return keys;
}

/** The server's refusal to drop the index that backs a shard key */
function isShardKeyRefusal(error) {
  return /shard key/i.test(errorText(error));
}

const VERBS = { create: 'create', modify: 'modify', recreate: 'rebuild', drop: 'drop' };
const LABELS = {
  create: '✔ Created ',
  modify: '✔ Modified',
  recreate: '✔ Rebuilt ',
  drop: '✔ Dropped ',
};

/**
 * Every named collection's live state, in order: one `listCollections` for
 * all of them, then their `listIndexes` a few at a time — not two sequential
 * round trips per collection, which for a few hundred declared collections
 * is the better part of a minute before the first decision.
 */
async function readLiveStates(db, names) {
  const infos = await db
    .listCollections({ name: { $in: names } }, { nameOnly: false, ...READ_OPTIONS })
    .toArray();
  const byName = new Map();
  for (const info of infos) byName.set(info.name, info);
  return mapLimit(names, READ_CONCURRENCY, (name) => liveStateOf(db, name, byName.get(name)));
}

/**
 * One collection's live state: `{ exists, type?, options?, indexes }`. A view
 * or a time-series collection is reported by type (the planner refuses it)
 * without listing indexes.
 */
async function readLiveState(db, name) {
  const [state] = await readLiveStates(db, [name]);
  return state;
}

async function liveStateOf(db, name, info) {
  if (!info) return { exists: false, indexes: [] };
  const options = info.options ?? {};
  if (info.type !== undefined && info.type !== 'collection') {
    return { exists: true, type: info.type, options, indexes: [] };
  }
  try {
    const indexes = await db.collection(name).listIndexes(READ_OPTIONS).toArray();
    return { exists: true, type: 'collection', options, indexes };
  } catch (error) {
    // Dropped between the two reads — plan it as missing, like the first read would have.
    if (error?.code === NAMESPACE_NOT_FOUND) return { exists: false, indexes: [] };
    throw error;
  }
}

/** Copy-on-write, like the kit's #attachResults: the error may live on a shared abort signal */
function attachConverge(error, result) {
  if (error instanceof MigronautError) {
    error.context = { ...error.context, converge: result };
  }
  return error;
}

function describe(action) {
  if (action.target === 'index') return `index "${action.name}"`;
  return action.target === 'validator' ? 'the validator' : 'the collection';
}

/** What a failed step was doing — one row, or the indexes one command built together */
function describeAll(actions) {
  if (actions.length === 1) return describe(actions[0]);
  return `indexes ${actions.map((action) => `"${action.name}"`).join(', ')}`;
}

/**
 * Errors that leave it unknown what the server did: the connection broke, or
 * a client-side deadline ran out, while the server may well still be building.
 * After one of these, nothing is "put back" — a restore would race a build the
 * server is still running; the next converge reads what actually happened.
 */
const CONNECTION_ERROR_NAMES = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoOperationTimeoutError',
  'MongoTopologyClosedError',
]);
const CONNECTION_ERROR_CODES = new Set([50, 89, 91, 189, 10107, 11600, 11602, 13435]);

function isConnectionTrouble(error) {
  return CONNECTION_ERROR_NAMES.has(error?.name) || CONNECTION_ERROR_CODES.has(error?.code);
}

/** What a failed rebuild left behind, when it could not put the dropped index back */
function lostIndexes(extra) {
  if (extra.restored !== false) return '';
  if (extra.uncertain) {
    return (
      ` — the connection failed mid-build, so ${extra.dropped.map((name) => `"${name}"`).join(', ')} ` +
      'was not put back: the server may still be building; converge --dry-run shows what it finished'
    );
  }
  return (
    ` — the dropped index(es) ${extra.dropped.map((name) => `"${name}"`).join(', ')} could ` +
    `not be put back (${extra.restoreError}); the collection is without them until fixed`
  );
}

function wrapFailure(error, collection, actions, result, extra = {}) {
  const action = actions[0];
  if (error instanceof MigronautError) return attachConverge(error, result);
  const mongoCode = typeof error?.code === 'number' ? error.code : undefined;
  const hint = mongoCode !== undefined ? HINTS[mongoCode] : undefined;
  const cause = errorText(error);
  return new ConvergeFailedError(
    `Could not ${VERBS[action.action] ?? action.action} ${describeAll(actions)} on ${collection}: ` +
      `${cause}${hint ? ` — ${hint}` : ''}${lostIndexes(extra)}`,
    {
      phase: 'apply',
      collection,
      target: action.target,
      name: action.name,
      action: action.action,
      cause,
      ...(mongoCode !== undefined ? { mongoCode } : {}),
      ...(hint ? { hint } : {}),
      ...extra,
      converge: result,
    },
    { cause: error },
  );
}

async function dropIndex(db, collection, name) {
  try {
    await db.collection(collection).dropIndex(name);
  } catch (error) {
    // Already gone is the state this step wanted.
    if (error?.code !== INDEX_NOT_FOUND) throw error;
  }
}

/**
 * Drop, then create — the only way to change most index options. A failed
 * create (a unique index over duplicate data, typically) would otherwise
 * leave the collection without the index it had a moment ago, so every
 * dropped index whose name is still free is put back, best-effort, and the
 * failure says whether that worked.
 *
 * Returns undefined on success, or `{ error, action, extra }` for the create
 * that failed — a drop that fails has nothing to restore and simply throws.
 */
async function runRebuild(db, collection, step, settle) {
  const dropped = [];
  for (const drop of step.drops) {
    await dropIndex(db, collection, drop.name);
    dropped.push(drop);
  }
  const created = new Set();
  for (const { spec, action } of step.creates) {
    const startedAt = Date.now();
    try {
      await db.collection(collection).createIndexes([spec]);
    } catch (error) {
      const droppedNames = dropped.map((drop) => drop.name);
      if (isConnectionTrouble(error)) {
        return {
          error,
          actions: [action],
          extra: { restored: false, uncertain: true, dropped: droppedNames },
        };
      }
      const restoreErrors = [];
      for (const drop of dropped) {
        if (created.has(drop.name)) continue;
        try {
          await db.collection(collection).createIndexes([drop.restore]);
        } catch (restoreError) {
          restoreErrors.push(`${drop.name}: ${errorText(restoreError)}`);
        }
      }
      return {
        error,
        actions: [action],
        extra: {
          restored: restoreErrors.length === 0,
          dropped: droppedNames,
          ...(restoreErrors.length > 0 ? { restoreError: restoreErrors.join('; ') } : {}),
        },
      };
    }
    created.add(spec.name);
    settle(action, Date.now() - startedAt);
  }
  return undefined;
}

/**
 * Make an index unique in place (MongoDB 7.0+): `prepareUnique` first — from
 * then on no new duplicate can be written — then `unique`, which checks the
 * existing documents. If they hold duplicates, `prepareUnique` is taken back
 * off, so the index is exactly as it was before. Never a window without the
 * index, and no rebuild of a large collection.
 */
async function convertToUnique(db, collection, step) {
  await db.command({ collMod: collection, index: { name: step.name, prepareUnique: true } });
  try {
    await db.command({ collMod: collection, index: { name: step.name, unique: true } });
  } catch (error) {
    await db
      .command({ collMod: collection, index: { name: step.name, prepareUnique: false } })
      .catch(() => undefined);
    throw error;
  }
  if (Object.keys(step.rest).length > 0) {
    await db.command({ collMod: collection, index: { name: step.name, ...step.rest } });
  }
}

/** Carry out one planned step; returns `{ error, actions, extra }` on failure, else undefined */
async function runStep(db, collection, step, settle) {
  try {
    if (step.op === 'rebuild') return await runRebuild(db, collection, step, settle);
    const startedAt = Date.now();
    if (step.op === 'createCollection') {
      try {
        await db.createCollection(collection, step.options);
      } catch (error) {
        // Created by someone else since it was read — set the validator on it instead.
        if (error?.code !== NAMESPACE_EXISTS) throw error;
        if (step.options.validator) await db.command({ collMod: collection, ...step.options });
      }
    } else if (step.op === 'collMod') {
      await db.command({ collMod: collection, ...step.command });
    } else if (step.op === 'convertUnique') {
      await convertToUnique(db, collection, step);
    } else if (step.op === 'createIndexes') {
      // One command, one pass over the collection for all of them — and all
      // or nothing: a build that fails leaves none of the batch behind.
      await db.collection(collection).createIndexes(step.specs);
    } else {
      try {
        await dropIndex(db, collection, step.name);
      } catch (error) {
        // A sharded collection's shard-key index cannot be dropped, and its
        // shard key could not be read up front: keep it, say so, go on.
        if (!isShardKeyRefusal(error)) throw error;
        for (const action of step.actions) {
          action.action = 'keep';
          action.reason = 'backs the shard key';
        }
        return { kept: true };
      }
    }
    const durationMs = Date.now() - startedAt;
    for (const action of step.actions) settle(action, durationMs);
    return undefined;
  } catch (error) {
    return {
      error,
      actions: step.op === 'createIndexes' ? step.actions : [step.actions[0]],
      extra: {},
    };
  }
}

/** Mark every row that never ran, once a run stops early */
function settleRest(result) {
  for (const collection of result.collections) {
    for (const action of collection.actions) {
      if (action.status !== 'planned') continue;
      action.status = action.action === 'conflict' ? 'failed' : 'skipped';
    }
  }
}

function finalize(result) {
  const { changes, applied, conflicts } = summarize(result.collections);
  if (result.dryRun) {
    result.changed = changes;
    result.inSync = changes === 0 && conflicts === 0;
  } else {
    result.changed = applied;
    result.inSync = conflicts === 0 && applied === changes && !(result.unstable?.length > 0);
  }
  return result;
}

/** Collections with at least one change — planned in a dry run, applied otherwise */
function touched(result) {
  let count = 0;
  for (const collection of result.collections) {
    for (const action of collection.actions) {
      if (CHANGE_ACTIONS.has(action.action) && (result.dryRun || action.status === 'applied')) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

/** Steps that build an index — the ones that can take minutes or hours */
const BUILD_STEPS = new Set(['createIndexes', 'rebuild']);
const STARTING = {
  create: 'Creating',
  modify: 'Modifying',
  recreate: 'Rebuilding',
  drop: 'Dropping',
};

/**
 * Say a step is starting, before it runs: the `converge:action` event with
 * status `'started'` for every step, and a log line for an index build — on a
 * large collection it is the only sign of which index the run is busy with.
 */
function announce(deps, collection, step) {
  for (const action of step.actions) {
    deps.emit('converge:action', {
      collection,
      target: action.target,
      name: action.name,
      action: action.action,
      status: 'started',
      ...(action.reason !== undefined ? { reason: action.reason } : {}),
    });
    const what = action.target === 'index' ? `${action.name} on ${collection}` : collection;
    const line = `… ${STARTING[action.action] ?? action.action} ${action.target} ${what}`;
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
}

/** The rows worth keeping in the history: what changed, failed, or refused the run */
function historyActions(result) {
  const actions = [];
  for (const collection of result.collections) {
    for (const action of collection.actions) {
      if (
        !CHANGE_ACTIONS.has(action.action) &&
        action.action !== 'conflict' &&
        action.status !== 'failed'
      ) {
        continue;
      }
      actions.push({ collection: collection.name, ...action });
    }
  }
  return actions;
}

/**
 * Append the run to the converge history — a run that changed something or
 * failed; a converge that found everything in place is not news. Best-effort,
 * like the changelog's failure trace: a history that cannot be written is
 * warned about, never allowed to turn a converge that worked into a failure.
 */
async function recordHistory(deps, options, result, { startedAt, error }) {
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
      ...(error !== undefined ? { error: errorText(error) } : {}),
      ...pickActor(options),
      changed: result.changed,
      actions: historyActions(result),
      ...(result.unstable ? { unstable: result.unstable } : {}),
    });
  } catch (recordError) {
    deps.logger.warn(
      `⚠ Could not record the converge in its history: ${errorText(recordError)}`,
      deps.fields({ error: errorText(recordError) }),
    );
  }
}

/**
 * Undeclared indexes left in place because prune was off — not the ones that
 * back a shard key, which stay under prune too: "converge with prune to drop
 * them" would be wrong advice for those.
 */
function undeclaredKept(result) {
  let kept = 0;
  for (const collection of result.collections) {
    for (const action of collection.actions) {
      if (action.action === 'keep' && action.reason === 'not declared') kept += 1;
    }
  }
  return kept;
}

function counts(result) {
  const out = {};
  for (const collection of result.collections) {
    for (const action of collection.actions) out[action.action] = (out[action.action] ?? 0) + 1;
  }
  return out;
}

/**
 * The read and plan phases: every declared collection's live state (one
 * read for all of them), and its plan. Behind a mongos each live state also
 * carries the collection's shard key, so the plan keeps the index behind it.
 *
 * Returns `{ planFor, live, plans }` — `planFor(definition, live)` plans one
 * collection with the run's options, for the re-plans and the fixed-point
 * check to come.
 */
async function readAndPlan(deps, options) {
  const { db } = deps;
  const { definitions } = options;
  const pruneFor = (definition) => definition.prune ?? options.prune ?? false;
  const server = await readServer(db);
  const capabilities = inPlaceCapabilities(server.version);
  const planFor = (definition, live) =>
    planCollection(definition, live, {
      prune: pruneFor(definition),
      rebuildUnique: options.rebuildUnique === true,
      capabilities,
    });

  const names = definitions.map((definition) => definition.name);
  const live = await readLiveStates(db, names);
  if (server.mongos) {
    const shardKeys = await readShardKeys(deps, names);
    for (const [position, name] of names.entries()) {
      if (shardKeys.has(name)) live[position].shardKey = shardKeys.get(name);
    }
  }
  const plans = definitions.map((definition, position) => planFor(definition, live[position]));
  // `indexes: []` with prune reads as "no indexes here" — every one but _id
  // goes. Legitimate, and easy to write by accident: say it out loud.
  for (const [position, definition] of definitions.entries()) {
    const drops = plans[position].actions.filter((action) => action.action === 'drop');
    if (definition.indexes?.length === 0 && pruneFor(definition) && drops.length > 0) {
      deps.logger.warn(
        `⚠ ${definition.name}: indexes: [] with prune drops every index but _id ` +
          `(${drops.map((action) => action.name).join(', ')})`,
        deps.fields({ collection: definition.name, drops: drops.length }),
      );
    }
  }
  return { planFor, live, plans };
}

/** A dry run's answer: the plan as the result, and one line about it */
function reportPlan(deps, result) {
  finalize(result);
  const total = result.collections.length;
  const line =
    `◎ Planned  ${result.changed} change(s) in ${touched(result)} of ${total} ` + 'collection(s)';
  const fields = deps.fields({ dryRun: true, changed: result.changed, collections: total });
  // A probe that finds nothing to do (a scheduler tick, a CI gate) is not news.
  if (result.inSync) deps.logger.debug(line, fields);
  else deps.logger.info(line, fields);
  return result;
}

/** The guard phase: a plan with any conflict refuses the whole run, before the first write */
function refuseConflicts(result) {
  const conflicts = [];
  for (const collection of result.collections) {
    for (const action of collection.actions) {
      if (action.action !== 'conflict') continue;
      conflicts.push({
        collection: collection.name,
        target: action.target,
        name: action.name,
        reason: action.reason,
        ...(action.liveName !== undefined ? { liveName: action.liveName } : {}),
      });
    }
  }
  if (conflicts.length === 0) return;
  settleRest(result);
  throw new ConvergeFailedError(
    `Converge refused: ${conflicts.length} conflict(s) — ` +
      conflicts
        .map((conflict) =>
          conflict.target === 'collection'
            ? `${conflict.collection} ${conflict.reason}`
            : `${conflict.collection} ${describe(conflict)}: ${conflict.reason}`,
        )
        .join('; '),
    { phase: 'plan', conflicts, converge: result },
  );
}

/**
 * The collection at `position`, planned afresh — the guard again, right
 * before its turn. It may only have become *less* to do: a conflict or a
 * drop/rebuild that the plan the run started from did not have — an index
 * someone created meanwhile — refuses the run here, before this collection is
 * touched, rather than act on what nobody reviewed.
 */
async function replan(run, position) {
  const { deps, definitions, live, plans, result, planFor } = run;
  const definition = definitions[position];
  const fresh = await readLiveState(deps.db, definition.name);
  if (live[position].shardKey) fresh.shardKey = live[position].shardKey;
  const plan = planFor(definition, fresh);
  const known = new Set(
    plans[position].actions.map((action) => `${action.target}:${action.name}:${action.action}`),
  );
  const introduced = plan.actions.filter(
    (action) =>
      (action.action === 'conflict' || isDestructive(action)) &&
      !known.has(`${action.target}:${action.name}:${action.action}`),
  );
  if (introduced.length === 0) return plan;
  result.collections[position].actions = plan.actions;
  settleRest(result);
  throw new ConvergeFailedError(
    `Converge stopped before ${definition.name}: it changed while the run was under way — ` +
      introduced.map((action) => `${describe(action)} now ${action.action}`).join('; '),
    {
      phase: 'replan',
      collection: definition.name,
      introduced: introduced.map(({ target, name, action, reason }) => ({
        target,
        name,
        action,
        ...(reason !== undefined ? { reason } : {}),
      })),
      converge: result,
    },
  );
}

/** A declared index found under another name is kept as it is — say so */
function warnRenamed(deps, plan) {
  for (const action of plan.actions) {
    if (action.liveName !== undefined && action.action === 'unchanged') {
      deps.logger.warn(
        `⚠ ${plan.name}: index "${action.name}" exists as "${action.liveName}" — kept under ` +
          'its current name',
        deps.fields({ collection: plan.name, index: action.name, liveName: action.liveName }),
      );
    }
  }
}

/** Mark a row applied, and say so: the `converge:action` event and its log line */
function settler(deps, collection) {
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
    const what = action.target === 'index' ? `${action.name} on ${collection}` : collection;
    deps.logger.info(
      `${LABELS[action.action]} ${action.target} ${what}   [${durationMs}ms]`,
      deps.fields({
        collection,
        target: action.target,
        name: action.name,
        action: action.action,
        durationMs,
      }),
    );
  };
}

/**
 * The apply phase for one collection: its steps, in order. Returns the
 * indexes the server would not let go of (a shard key's), which the verify
 * phase must not report as unstable. A failed step stops the run.
 */
async function applyCollection(deps, plan, result, signal) {
  const kept = new Set();
  const settle = settler(deps, plan.name);
  for (const step of plan.steps) {
    // Between operations is the only safe place to stop — and never inside
    // a rebuild, which runs its drop and its create back to back.
    try {
      deps.assertNotAborted(signal);
    } catch (error) {
      settleRest(result);
      throw attachConverge(error, result);
    }
    announce(deps, plan.name, step);
    const failure = await runStep(deps.db, plan.name, step, settle);
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
}

/**
 * The verify phase — the fixed-point check: what was just applied must now
 * compare as unchanged. Anything that does not would be "changed" again on
 * every run — a comparison rule that disagrees with this server version — so
 * it is reported in `result.unstable` instead of silently rebuilt forever.
 */
async function verifyFixedPoint(run, position, kept) {
  const { deps, definitions, live, result, planFor } = run;
  const definition = definitions[position];
  const afterLive = await readLiveState(deps.db, definition.name);
  if (live[position].shardKey) afterLive.shardKey = live[position].shardKey;
  const after = planFor(definition, afterLive);
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
    deps.logger.warn(
      `⚠ ${definition.name}: ${describe(action)} still differs after converge` +
        `${action.reason ? ` (${action.reason})` : ''} — it would change again on every run`,
      deps.fields({ collection: definition.name, target: action.target, name: action.name }),
    );
  }
}

/** A converge that ran to the end: its closing lines, its history entry, `converge:end` */
async function reportSuccess(deps, options, result, startedAt) {
  const { logger } = deps;
  const total = result.collections.length;
  settleRest(result);
  finalize(result);
  const durationMs = Date.now() - startedAt;
  const kept = undeclaredKept(result);
  if (result.changed > 0) {
    logger.info(
      `✔ Converged ${result.changed} change(s) in ${touched(result)} of ${total} ` +
        `collection(s) in ${durationMs}ms`,
      deps.fields({ changed: result.changed, collections: total, durationMs }),
    );
  } else {
    logger.info(
      'Collections already match their declarations',
      deps.fields({ collections: total, durationMs }),
    );
  }
  if (kept > 0) {
    logger.info(
      `• Kept ${kept} undeclared index(es) — converge with prune to drop them`,
      deps.fields({ kept }),
    );
  }
  await recordHistory(deps, options, result, { startedAt });
  deps.emit('converge:end', {
    trigger: options.trigger ?? 'converge',
    success: true,
    durationMs,
    changed: result.changed,
    inSync: result.inSync,
    counts: counts(result),
    result,
  });
}

/** A converge that stopped: its history entry and `converge:end` — the error is the caller's */
async function reportFailure(deps, options, result, startedAt, error) {
  finalize(result);
  await recordHistory(deps, options, result, { startedAt, error });
  deps.emit('converge:end', {
    trigger: options.trigger ?? 'converge',
    success: false,
    durationMs: Date.now() - startedAt,
    changed: result.changed,
    inSync: false,
    counts: counts(result),
    error: errorText(error),
    result,
  });
}

/**
 * Plan every declared collection and, unless `dryRun`, carry the plans out:
 * read → plan → guard → (per collection: re-plan → apply → verify) → report.
 *
 * `options`: `{ definitions, prune?, rebuildUnique?, dryRun?, trigger?, requestedBy?,
 * reason? }` —
 * `definitions` normalized (collections.js); `prune` the default for
 * definitions that do not set their own; `rebuildUnique` lets a rebuild drop a
 * unique index it builds back (a conflict otherwise); `trigger` is
 * `'converge'` or `'up'` (the after-up hook), for events and logs.
 *
 * A plan with any conflict refuses the whole run before the first write. A
 * failed step stops the run (`ConvergeFailedError`); an abort between steps
 * stops it with the abort's own error. Either way `context.converge` holds
 * the result so far.
 */
async function runConverge(deps, options, signal) {
  const { definitions, dryRun = false, trigger = 'converge' } = options;
  const startedAt = Date.now();
  const { planFor, live, plans } = await readAndPlan(deps, options);
  const result = {
    dryRun,
    changed: 0,
    inSync: true,
    collections: plans.map(({ name, actions }) => ({ name, actions })),
  };
  if (dryRun) return reportPlan(deps, result);

  const run = { deps, definitions, live, plans, result, planFor };
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
      const kept = await applyCollection(deps, plan, result, signal);
      await verifyFixedPoint(run, position, kept);
    }
    await reportSuccess(deps, options, result, startedAt);
    return result;
  } catch (error) {
    await reportFailure(deps, options, result, startedAt, error);
    throw error;
  }
}

module.exports = { READ_OPTIONS, readLiveState, readLiveStates, runConverge };
