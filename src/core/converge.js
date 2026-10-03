const { ConvergeFailedError, MigronautError } = require('../errors/index.js');
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
 * One collection's live state: `{ exists, type?, options?, indexes }`. A view
 * or a time-series collection is reported by type (the planner refuses it)
 * without listing indexes.
 */
async function readLiveState(db, name) {
  const [info] = await db.listCollections({ name }, { nameOnly: false, ...READ_OPTIONS }).toArray();
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

function wrapFailure(error, collection, action, result, extra = {}) {
  if (error instanceof MigronautError) return attachConverge(error, result);
  const mongoCode = typeof error?.code === 'number' ? error.code : undefined;
  const hint = mongoCode !== undefined ? HINTS[mongoCode] : undefined;
  const cause = errorText(error);
  return new ConvergeFailedError(
    `Could not ${VERBS[action.action] ?? action.action} ${describe(action)} on ${collection}: ` +
      `${cause}${hint ? ` — ${hint}` : ''}`,
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
      let restored = true;
      for (const drop of dropped) {
        if (created.has(drop.name)) continue;
        try {
          await db.collection(collection).createIndexes([drop.restore]);
        } catch {
          restored = false;
        }
      }
      return { error, action, extra: { restored, dropped: dropped.map((drop) => drop.name) } };
    }
    created.add(spec.name);
    settle(action, Date.now() - startedAt);
  }
  return undefined;
}

/** Carry out one planned step; returns a failure descriptor (see runRebuild) or undefined */
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
    } else if (step.op === 'createIndex') {
      await db.collection(collection).createIndexes([step.spec]);
    } else {
      await dropIndex(db, collection, step.name);
    }
    const durationMs = Date.now() - startedAt;
    for (const action of step.actions) settle(action, durationMs);
    return undefined;
  } catch (error) {
    return { error, action: step.actions[0], extra: {} };
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
 * `options`: `{ definitions, prune?, dryRun?, trigger? }` — `definitions`
 * normalized (collections.js); `prune` the default for definitions that do
 * not set their own; `trigger` is `'converge'` or `'up'` (the after-up hook),
 * for events and logs.
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

  const plans = [];
  for (const definition of definitions) {
    plans.push(
      planCollection(definition, await readLiveState(db, definition.name), {
        prune: pruneFor(definition),
      }),
    );
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
        const failure = await runStep(db, plan.name, step, settle);
        if (failure) {
          const { error, action, extra } = failure;
          action.status = 'failed';
          deps.emit('converge:action', {
            collection: plan.name,
            target: action.target,
            name: action.name,
            action: action.action,
            status: 'failed',
            error: errorText(error),
          });
          settleRest(result);
          throw wrapFailure(error, plan.name, action, result, extra);
        }
      }

      // The fixed-point check: what was just applied must now compare as
      // unchanged. Anything that does not would be "changed" again on every
      // run — a comparison rule that disagrees with this server version — so
      // it is reported instead of silently rebuilt forever.
      const definition = definitions[position];
      const after = planCollection(definition, await readLiveState(db, definition.name), {
        prune: pruneFor(definition),
      });
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

module.exports = { READ_OPTIONS, readLiveState, runConverge };
