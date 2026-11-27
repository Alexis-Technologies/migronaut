const { errorText } = require('../../utils/error.js');
const { SEARCH_UNAVAILABLE_REASON } = require('./plan.js');
const { SEARCH_STEPS, isSearchUnavailable, runSearchStep } = require('./search.js');
const { INDEX_NOT_FOUND } = require('../server-info.js');
const { isShardKeyRefusal } = require('./live.js');
const { isConnectionTrouble, NAMESPACE_EXISTS } = require('./failure.js');

/**
 * Carrying out one planned step against the server — create, drop, rebuild,
 * convert to unique, a search index — and what it left behind on failure.
 */

const dropIndex = async (db, collection, name) => {
  try {
    await db.collection(collection).dropIndex(name);
  } catch (error) {
    // Already gone is the state this step wanted.
    if (error?.code !== INDEX_NOT_FOUND) throw error;
  }
};

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
const runRebuild = async (db, collection, step, settle) => {
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
      const droppedNames = [];
      for (let i = 0; i < dropped.length; i++) droppedNames.push(dropped[i].name);
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
};

/**
 * Make an index unique in place (MongoDB 7.0+): `prepareUnique` first — from
 * then on no new duplicate can be written — then `unique`, which checks the
 * existing documents. If they hold duplicates, `prepareUnique` is taken back
 * off, so the index is exactly as it was before. Never a window without the
 * index, and no rebuild of a large collection.
 *
 * Returns undefined, or `{ error, left }` when the conversion failed —
 * `left`: `prepareUnique` could not be taken back off either (a failover
 * between the two commands). The index then refuses new duplicates while
 * `listIndexes` still says it is not unique; the error says so, and the next
 * plan finds the flag and takes it off (index-spec.js `compareIndex`).
 */
const convertToUnique = async (db, collection, step) => {
  await db.command({ collMod: collection, index: { name: step.name, prepareUnique: true } });
  try {
    await db.command({ collMod: collection, index: { name: step.name, unique: true } });
  } catch (error) {
    let left = false;
    await db
      .command({ collMod: collection, index: { name: step.name, prepareUnique: false } })
      .catch(() => {
        left = true;
      });
    return { error, left };
  }
  if (Object.keys(step.rest).length > 0) {
    await db.command({ collMod: collection, index: { name: step.name, ...step.rest } });
  }
  return undefined;
};

/**
 * Carry out one planned step; returns `{ error, actions, extra }` on failure,
 * `{ kept }` / `{ skipped }` for a step the server turned down in a way the
 * run can go on from, else undefined. `search` is the run's search state.
 */
const runStep = async (db, collection, step, settle, search) => {
  try {
    if (step.op === 'rebuild') return await runRebuild(db, collection, step, settle);
    const startedAt = Date.now();
    if (SEARCH_STEPS.has(step.op)) {
      try {
        await runSearchStep(db, collection, step);
      } catch (error) {
        // The probe said Search was there, the server says otherwise: with
        // onSearchUnavailable 'skip' that is what the configuration expects.
        if (search?.onUnavailable !== 'skip' || !isSearchUnavailable(error)) throw error;
        for (const action of step.actions) {
          action.action = 'skip';
          action.reason = SEARCH_UNAVAILABLE_REASON;
        }
        return { skipped: true };
      }
    } else if (step.op === 'createCollection') {
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
      const failed = await convertToUnique(db, collection, step);
      if (failed) {
        return {
          error: failed.error,
          actions: [step.actions[0]],
          extra: failed.left ? { prepareUniqueLeft: true } : {},
        };
      }
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
    // One command for several indexes fails (or succeeds) for all of them.
    const together = step.op === 'createIndexes' || step.op === 'createSearchIndexes';
    return { error, actions: together ? step.actions : [step.actions[0]], extra: {} };
  }
};

module.exports = {
  runStep,
};
