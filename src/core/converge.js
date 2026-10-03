const { ConvergeFailedError, MigronautError } = require('../errors/index.js');
const { mapLimit } = require('../utils/concurrency.js');
const { errorText } = require('../utils/error.js');
const { CHANGE_ACTIONS, planCollection, summarize } = require('./converge-plan.js');

/**
 * Converge: bring the declared collections' indexes and validators to their
 * declared state. Stateless — every run reads `listCollections` and
 * `listIndexes`, plans against what it finds (converge-plan.js), and carries
 * the plan out one operation at a time. Nothing is recorded: the declaration
 * is the only source of truth, and the database is checked against it afresh
 * each time.
 *
 * Pure orchestration over capabilities the MigratorKit injects (`deps`):
 * `{db, logger, fields, emit, assertNotAborted}`.
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
};

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
    } else if (step.op === 'createIndexes') {
      // One command, one pass over the collection for all of them — and all
      // or nothing: a build that fails leaves none of the batch behind.
      await db.collection(collection).createIndexes(step.specs);
    } else {
      await dropIndex(db, collection, step.name);
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

function counts(result) {
  const out = {};
  for (const collection of result.collections) {
    for (const action of collection.actions) out[action.action] = (out[action.action] ?? 0) + 1;
  }
  return out;
}

/**
 * Plan every declared collection and, unless `dryRun`, carry the plans out.
 *
 * `options`: `{ definitions, prune?, rebuildUnique?, dryRun?, trigger? }` —
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
  const { db, logger } = deps;
  const { definitions, dryRun = false, trigger = 'converge' } = options;
  const startedAt = Date.now();
  const pruneFor = (definition) => definition.prune ?? options.prune ?? false;
  const planOptions = (definition) => ({
    prune: pruneFor(definition),
    rebuildUnique: options.rebuildUnique === true,
  });

  const live = await readLiveStates(
    db,
    definitions.map((definition) => definition.name),
  );
  const plans = definitions.map((definition, position) =>
    planCollection(definition, live[position], planOptions(definition)),
  );
  // `indexes: []` with prune reads as "no indexes here" — every one but _id
  // goes. Legitimate, and easy to write by accident: say it out loud.
  for (const [position, definition] of definitions.entries()) {
    const drops = plans[position].actions.filter((action) => action.action === 'drop');
    if (definition.indexes?.length === 0 && pruneFor(definition) && drops.length > 0) {
      logger.warn(
        `⚠ ${definition.name}: indexes: [] with prune drops every index but _id ` +
          `(${drops.map((action) => action.name).join(', ')})`,
        deps.fields({ collection: definition.name, drops: drops.length }),
      );
    }
  }
  const result = {
    dryRun,
    changed: 0,
    inSync: true,
    collections: plans.map(({ name, actions }) => ({ name, actions })),
  };

  if (dryRun) {
    finalize(result);
    const line =
      `◎ Planned  ${result.changed} change(s) in ${touched(result)} of ${plans.length} ` +
      'collection(s)';
    const fields = deps.fields({
      dryRun: true,
      changed: result.changed,
      collections: plans.length,
    });
    // A probe that finds nothing to do (a scheduler tick, a CI gate) is not news.
    if (result.inSync) logger.debug(line, fields);
    else logger.info(line, fields);
    return result;
  }

  deps.emit('converge:start', { trigger, collections: definitions.length });
  try {
    const conflicts = [];
    for (const plan of plans) {
      for (const action of plan.actions) {
        if (action.action !== 'conflict') continue;
        conflicts.push({
          collection: plan.name,
          target: action.target,
          name: action.name,
          reason: action.reason,
          ...(action.liveName !== undefined ? { liveName: action.liveName } : {}),
        });
      }
    }
    if (conflicts.length > 0) {
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

    for (const [position, plan] of plans.entries()) {
      for (const action of plan.actions) {
        if (action.liveName !== undefined && action.action === 'unchanged') {
          logger.warn(
            `⚠ ${plan.name}: index "${action.name}" exists as "${action.liveName}" — kept under ` +
              'its current name',
            deps.fields({ collection: plan.name, index: action.name, liveName: action.liveName }),
          );
        }
      }
      if (plan.steps.length === 0) continue;
      const settle = (action, durationMs) => {
        action.status = 'applied';
        action.durationMs = durationMs;
        deps.emit('converge:action', {
          collection: plan.name,
          target: action.target,
          name: action.name,
          action: action.action,
          status: 'applied',
          durationMs,
          ...(action.reason !== undefined ? { reason: action.reason } : {}),
        });
        const what = action.target === 'index' ? `${action.name} on ${plan.name}` : plan.name;
        logger.info(
          `${LABELS[action.action]} ${action.target} ${what}   [${durationMs}ms]`,
          deps.fields({
            collection: plan.name,
            target: action.target,
            name: action.name,
            action: action.action,
            durationMs,
          }),
        );
      };
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
        const failure = await runStep(db, plan.name, step, settle);
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

      // The fixed-point check: what was just applied must now compare as
      // unchanged. Anything that does not would be "changed" again on every
      // run — a comparison rule that disagrees with this server version — so
      // it is reported instead of silently rebuilt forever.
      const definition = definitions[position];
      const after = planCollection(
        definition,
        await readLiveState(db, definition.name),
        planOptions(definition),
      );
      for (const action of after.actions) {
        if (!CHANGE_ACTIONS.has(action.action)) continue;
        (result.unstable ??= []).push({
          collection: plan.name,
          target: action.target,
          name: action.name,
          action: action.action,
          ...(action.reason !== undefined ? { reason: action.reason } : {}),
        });
        logger.warn(
          `⚠ ${plan.name}: ${describe(action)} still differs after converge` +
            `${action.reason ? ` (${action.reason})` : ''} — it would change again on every run`,
          deps.fields({ collection: plan.name, target: action.target, name: action.name }),
        );
      }
    }

    settleRest(result);
    finalize(result);
    const durationMs = Date.now() - startedAt;
    const kept = counts(result).keep ?? 0;
    if (result.changed > 0) {
      logger.info(
        `✔ Converged ${result.changed} change(s) in ${touched(result)} of ${plans.length} ` +
          `collection(s) in ${durationMs}ms`,
        deps.fields({ changed: result.changed, collections: plans.length, durationMs }),
      );
    } else {
      logger.info(
        'Collections already match their declarations',
        deps.fields({ collections: plans.length, durationMs }),
      );
    }
    if (kept > 0) {
      logger.info(
        `• Kept ${kept} undeclared index(es) — converge with prune to drop them`,
        deps.fields({ kept }),
      );
    }
    deps.emit('converge:end', {
      trigger,
      success: true,
      durationMs,
      changed: result.changed,
      inSync: result.inSync,
      counts: counts(result),
      result,
    });
    return result;
  } catch (error) {
    finalize(result);
    deps.emit('converge:end', {
      trigger,
      success: false,
      durationMs: Date.now() - startedAt,
      changed: result.changed,
      inSync: false,
      counts: counts(result),
      error: errorText(error),
      result,
    });
    throw error;
  }
}

module.exports = { READ_OPTIONS, readLiveState, readLiveStates, runConverge };
