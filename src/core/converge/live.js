const { mapLimit } = require('../../utils/concurrency.js');
const { errorText } = require('../../utils/error.js');
const { belowVersionFilter } = require('../../versioning/document.js');
const { isVersioningIndexKey, versionFloorToCheck } = require('./versioning-spec.js');
const { NAMESPACE_NOT_FOUND, READ_CONCURRENCY, READ_OPTIONS } = require('../server-info.js');

/**
 * What converge reads of the live database: each declared collection's
 * state (one read for all of them), the shard keys behind a mongos, and the
 * version floor probe — mechanism only, decisions are the planner's.
 */

/**
 * How long the version floor probe may scan. With the version index it reads
 * one key; without it (the index is created by the same converge that raises
 * the floor) it may have to scan the collection — bounded, and a timeout
 * refuses the raise rather than risk it.
 */
const FLOOR_PROBE_TIMEOUT_MS = 60_000;

/**
 * Before converge raises `versioning.min`: is any document still below it?
 * Sets `live.versionFloor` to `{ min, below }` (`below: 'unknown'` with
 * `error` when the probe failed) for the planner to refuse the raise on. One
 * `findOne` with only `_id` projected — nothing about the document is kept.
 */
const probeVersionFloor = async (db, definition, live) => {
  const min = versionFloorToCheck(definition, live);
  if (min === null) return;
  const { versioning } = definition;
  let hint = '';
  for (const index of live.indexes) {
    if (isVersioningIndexKey(index.key, versioning)) {
      hint = index.name;
      break;
    }
  }
  try {
    const found = await db
      .collection(definition.name)
      .findOne(belowVersionFilter(versioning, min), {
        projection: { _id: 1 },
        maxTimeMS: FLOOR_PROBE_TIMEOUT_MS,
        ...(hint !== '' ? { hint } : {}),
        ...READ_OPTIONS,
      });
    live.versionFloor = { min, below: found !== null };
  } catch (error) {
    live.versionFloor = { min, below: 'unknown', error: errorText(error) };
  }
};

/** Probe every versioned collection whose floor would rise — a few at a time */
const probeVersionFloors = async (db, definitions, live) => {
  await mapLimit(definitions, READ_CONCURRENCY, (definition, position) =>
    probeVersionFloor(db, definition, live[position]),
  );
};

/** Shard key of each named collection, behind a mongos — when `config.collections` may be read */
const readShardKeys = async (deps, names) => {
  const keys = new Map();
  if (typeof deps.shardKeyOf !== 'function') return keys;
  // A few at a time, like the live states: one after another, a few hundred
  // declared collections were a few hundred round trips through the mongos
  // before the first decision.
  const found = await mapLimit(names, READ_CONCURRENCY, async (name) => {
    try {
      return await deps.shardKeyOf(name);
    } catch {
      // Not readable (privileges): a refused drop is caught when it happens.
      return undefined;
    }
  });
  for (let i = 0; i < names.length; i++) {
    if (found[i]) keys.set(names[i], found[i]);
  }
  return keys;
};

/** The server's refusal to drop the index that backs a shard key */
const isShardKeyRefusal = (error) => {
  return /shard key/i.test(errorText(error));
};

/**
 * Every named collection's live state, in order: one `listCollections` for
 * all of them, then their `listIndexes` a few at a time — not two sequential
 * round trips per collection, which for a few hundred declared collections
 * is the better part of a minute before the first decision.
 */
const readLiveStates = async (db, names) => {
  const infos = await db
    .listCollections({ name: { $in: names } }, { nameOnly: false, ...READ_OPTIONS })
    .toArray();
  const byName = new Map();
  for (const info of infos) byName.set(info.name, info);
  return mapLimit(names, READ_CONCURRENCY, (name) => liveStateOf(db, name, byName.get(name)));
};

/**
 * One collection's live state: `{ exists, type?, options?, indexes }`. A view
 * or a time-series collection is reported by type (the planner refuses it)
 * without listing indexes.
 */
const readLiveState = async (db, name) => {
  const states = await readLiveStates(db, [name]);
  return states[0];
};

const liveStateOf = async (db, name, info) => {
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
};

module.exports = {
  FLOOR_PROBE_TIMEOUT_MS,
  probeVersionFloor,
  probeVersionFloors,
  readShardKeys,
  isShardKeyRefusal,
  readLiveStates,
  readLiveState,
};
