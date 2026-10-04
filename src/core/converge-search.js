const { mapLimit } = require('../utils/concurrency.js');
const { errorText } = require('../utils/error.js');
const {
  isSearchIndexReady,
  normalizeLiveSearchIndex,
  searchBuild,
  searchBuildState,
} = require('./search-index-spec.js');

/**
 * Atlas Search for converge: the commands that create, update, list and drop
 * search indexes, the probe that tells whether a server has Search at all,
 * and what the server's errors mean. A mechanism module — it returns
 * outcomes, and converge.js decides what they do to a run.
 *
 * Raw commands rather than the driver's helpers: the helpers exist only from
 * driver 5.6 (`type: 'vectorSearch'` from 6.6), and migronaut supports every
 * driver from 5.0. The commands are the same on Atlas, an Atlas CLI local
 * deployment and a self-managed `mongot`.
 */

const NAMESPACE_NOT_FOUND = 26;
const INDEX_NOT_FOUND = 27;
const INVALID_OPTIONS = 72;
const UNKNOWN_FIELD = 40415;

/**
 * The server saying it has no Atlas Search, by version: SearchNotEnabled
 * (7.3+), CommandNotSupported and "only allowed on MongoDB Atlas" (6.0/7.0),
 * "no such command" and an unknown `$listSearchIndexes` stage (older still).
 */
const SEARCH_UNAVAILABLE_CODES = new Set([31082, 115, 6047401, 59, 40324]);
const SEARCH_UNAVAILABLE_MESSAGE = new RegExp(
  [
    'SearchNotEnabled',
    'requires additional configuration',
    'only (?:allowed|supported) (?:on|with) (?:MongoDB )?Atlas',
    "Unrecognized pipeline stage name: '\\$listSearchIndexes'",
    "no such command: '(?:createSearchIndexes|updateSearchIndex|dropSearchIndex)'",
  ].join('|'),
  'i',
);

/** What to do about a server without Search — shown with every refusal it causes */
const SEARCH_UNAVAILABLE_HINT =
  'use Atlas, an Atlas CLI local deployment (the mongodb/mongodb-atlas-local image) or MongoDB ' +
  "8.3+ with mongot — or set onSearchUnavailable: 'skip' to converge everything else";

/** The error a self-managed `mongot` gives for a vector index updated without its type */
const NEEDS_TYPE = /\bmappings\b.*\brequired\b/i;

/**
 * Why a vector index could not be updated where `mongot` wants the type the
 * server will not pass on (an Atlas CLI local deployment on MongoDB 8.0
 * refuses `updateSearchIndex` either way) — and the way that works everywhere.
 */
const VECTOR_UPDATE_HINT =
  'this server cannot update a vector search index in place (Atlas can) — declare the changed ' +
  'index under a new name, converge, then remove the old declaration and converge with prune';

/** Whether an error from a search command means the server has no Atlas Search */
function isSearchUnavailable(error) {
  if (SEARCH_UNAVAILABLE_CODES.has(error?.code)) return true;
  if (error?.codeName === 'SearchNotEnabled') return true;
  return SEARCH_UNAVAILABLE_MESSAGE.test(errorText(error));
}

/** What usually fixes the server error behind a failed search index command */
function searchHint(error) {
  if (isSearchUnavailable(error)) return SEARCH_UNAVAILABLE_HINT;
  const text = errorText(error);
  if (NEEDS_TYPE.test(text)) return VECTOR_UPDATE_HINT;
  if (error?.code === 13) {
    return (
      'not authorized — search indexes need the createSearchIndexes, updateSearchIndex, ' +
      'dropSearchIndex and listSearchIndexes actions (readWrite on Atlas)'
    );
  }
  if (/\b(?:limit|maximum|quota|exceed)/i.test(text) && /\bindex/i.test(text)) {
    return (
      'the cluster has as many search indexes as its tier allows (Free: 3, Flex: 10, search and ' +
      'vector together) — drop one, or move to a larger tier'
    );
  }
  if (error?.code === 68 || /already exists|duplicate/i.test(text)) {
    return (
      'a search index with this name already exists, or is still being deleted — converge again ' +
      'in a moment'
    );
  }
  return undefined;
}

/** A collection's search indexes, as `$listSearchIndexes` reports them — none for a missing one */
async function listSearchIndexes(db, collection, readOptions) {
  try {
    return await db
      .collection(collection)
      .aggregate([{ $listSearchIndexes: {} }], readOptions)
      .toArray();
  } catch (error) {
    if (error?.code === NAMESPACE_NOT_FOUND) return [];
    throw error;
  }
}

/** Whether `version` (`{ major, minor, patch? }`) is at least `major.minor.patch` */
function atLeast(version, major, minor, patch) {
  if (version === undefined) return false;
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return (version.patch ?? 0) >= patch;
}

/**
 * Whether the server is wired to a search index manager — the setting every
 * search command checks first. `undefined` when it will not say (Atlas
 * restricts `getParameter`); `false` for an empty setting, or a server that
 * has no such setting at all.
 */
async function searchManagement(db) {
  if (typeof db.admin !== 'function') return undefined;
  try {
    const reply = await db
      .admin()
      .command({ getParameter: 1, searchIndexManagementHostAndPort: 1 });
    const value = reply?.searchIndexManagementHostAndPort;
    return typeof value === 'string' ? value.length > 0 : undefined;
  } catch (error) {
    // "no option found to get" — with its code on 7.0, without one on 5.0/6.0.
    const unknown = error?.code === INVALID_OPTIONS || /no option found/i.test(errorText(error));
    return unknown ? false : undefined;
  }
}

/**
 * Whether the server has Atlas Search, asked by listing the search indexes of
 * `collection` (a declared one, preferably existing — its list is handed back
 * for reuse). Returns `{ available, evidence, reason?, listed? }`:
 *
 * - a server older than 6.0 has no search commands — not asked;
 * - an "unavailable" error is the answer; any other error is rethrown;
 * - a non-empty list, or an empty one from 7.2.1+, means available;
 * - an empty list from an older server proves nothing (a plain `mongod` of
 *   that age answered some lists with `[]` instead of an error), so the
 *   server's search index manager setting decides — or, where the server
 *   will not say, Search is assumed and a refusal at apply time reports it.
 */
async function probeSearch(db, server, { collection, readOptions }) {
  const { version } = server;
  if (version !== undefined && version.major < 6) {
    return {
      available: false,
      evidence: 'version',
      reason: `MongoDB ${version.major}.${version.minor} has no search index commands`,
    };
  }
  let listed;
  try {
    listed = await listSearchIndexes(db, collection, readOptions);
  } catch (error) {
    if (!isSearchUnavailable(error)) throw error;
    return { available: false, evidence: 'error', reason: errorText(error) };
  }
  if (listed.length > 0 || atLeast(version, 7, 2, 1)) {
    return { available: true, evidence: 'listed', listed };
  }
  const managed = await searchManagement(db);
  if (managed === false) {
    return {
      available: false,
      evidence: 'parameter',
      reason: 'the server has no search index manager configured',
    };
  }
  return { available: true, evidence: managed ? 'parameter' : 'assumed', listed };
}

/**
 * Update a search index in place. A self-managed `mongot` needs the type of a
 * vector index restated, where Atlas infers it (and the documented command
 * has no type) — so it is sent once more with the type, only on that error.
 */
async function updateSearchIndex(db, collection, step) {
  const command = { updateSearchIndex: collection, name: step.name, definition: step.definition };
  try {
    await db.command(command);
  } catch (error) {
    if (step.type !== 'vectorSearch' || !NEEDS_TYPE.test(errorText(error))) throw error;
    try {
      await db.command({ ...command, type: step.type });
    } catch (retryError) {
      // A server that does not know the field at all (MongoDB 8.0): the
      // first refusal is the one that says what is wrong.
      if (retryError?.code === UNKNOWN_FIELD || /unknown field/i.test(errorText(retryError))) {
        throw error;
      }
      throw retryError;
    }
  }
}

/** Drop a search index — already gone (or its collection) is the state this step wanted */
async function dropSearchIndex(db, collection, name) {
  try {
    await db.command({ dropSearchIndex: collection, name });
  } catch (error) {
    if (error?.code === NAMESPACE_NOT_FOUND || error?.code === INDEX_NOT_FOUND) return;
    if (/not found|does not exist/i.test(errorText(error))) return;
    throw error;
  }
}

/** The search index step ops converge.js hands over */
const SEARCH_STEPS = new Set(['createSearchIndexes', 'updateSearchIndex', 'dropSearchIndex']);

/**
 * Carry out one search index step. The server only accepts the work here —
 * a created or updated index builds in the background, so this returns in
 * moments whatever the size of the collection.
 */
async function runSearchStep(db, collection, step) {
  if (step.op === 'createSearchIndexes') {
    await db.command({ createSearchIndexes: collection, indexes: step.specs });
  } else if (step.op === 'updateSearchIndex') {
    await updateSearchIndex(db, collection, step);
  } else {
    await dropSearchIndex(db, collection, step.name);
  }
}

/** Search index lists read at once while waiting — one per collection */
const WAIT_READ_CONCURRENCY = 8;

/** Failed reads in a row a wait rides out — when each is a connection or failover blip */
const WAIT_READ_ATTEMPTS = 3;

/**
 * Server codes of a read worth trying again: the retryable-read set of the
 * drivers' specification (host unreachable, primary stepped down, shutdown,
 * a time limit…).
 */
const TRANSIENT_CODES = new Set([
  6, 7, 89, 91, 134, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436,
]);
const TRANSIENT_NAMES = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoPoolClearedError',
]);
const TRANSIENT_LABELS = ['ResetPool', 'RetryableWriteError', 'PoolRequstedRetry'];

/**
 * Whether a failed read is a blip — a network error, a failover, a node
 * shutting down — rather than an answer: the error itself, or what it wraps.
 * Duck-typed on the driver's error names, codes and labels.
 */
function isTransientError(error) {
  for (let current = error, depth = 0; current && depth < 3; depth += 1) {
    if (TRANSIENT_NAMES.has(current.name) || TRANSIENT_CODES.has(current.code)) return true;
    if (
      typeof current.hasErrorLabel === 'function' &&
      TRANSIENT_LABELS.some((label) => current.hasErrorLabel(label))
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * The pause before the next poll: from a second, half as long again each
 * time, never more than ten seconds — nor more than the budget has left.
 */
function nextPollDelay(attempt, remainingMs) {
  return Math.max(0, Math.round(Math.min(1000 * 1.5 ** attempt, 10_000, remainingMs)));
}

/** Every target collection's search indexes, read once: `"collection\0name"` → live index */
async function readAll(collections, read) {
  const live = new Map();
  await mapLimit(collections, WAIT_READ_CONCURRENCY, async (collection) => {
    for (const raw of await read(collection)) {
      const index = normalizeLiveSearchIndex(raw);
      live.set(`${collection}\u0000${index.name}`, index);
    }
  });
  return live;
}

/**
 * Poll until every target serves its latest definition (READY, queryable,
 * nothing newer building — and, for one updated at `sinceVersion`, past that
 * version), one of them FAILED, or `timeoutMs` (undefined: no limit) runs
 * out. A STALE or missing index keeps the wait going: only FAILED ends it
 * early.
 *
 * A target with `touched: false` (one the run did not create or change) that
 * is FAILED or STALE does not hold the wait: converge does not resubmit an
 * unchanged definition, so waiting on it could only time out. It is handed
 * back in `preexisting` instead. One still building is waited for.
 *
 * A read that fails with a blip (see {@link isTransientError}) is retried at
 * the next poll, up to {@link WAIT_READ_ATTEMPTS} in a row; any other failure
 * — or the last of those — is thrown.
 *
 * `targets`: `[{ collection, name, sinceVersion?, touched? }]`;
 * `read(collection)` the collection's `$listSearchIndexes` documents;
 * `beforePoll()` may throw to stop (an abort); `onPoll(live)` sees every
 * poll's `Map` of `"collection\0name"` → normalized live index;
 * `onReadError(error, inARow)` every read failure ridden out. Returns
 * `{ outcome: 'ready' | 'timeout' | 'failed', notReady, preexisting,
 * waitedMs }`, `notReady` holding `{ collection, name, ...build }` (the
 * failed ones first).
 */
async function awaitSearchIndexes({
  targets,
  read,
  timeoutMs,
  sleep,
  now = Date.now,
  beforePoll = () => undefined,
  onPoll = () => undefined,
  onReadError = () => undefined,
}) {
  const startedAt = now();
  const collections = [...new Set(targets.map((target) => target.collection))];
  const remaining = () => (timeoutMs === undefined ? Infinity : timeoutMs - (now() - startedAt));
  let failedReads = 0;
  for (let attempt = 0; ; attempt++) {
    beforePoll();
    let live;
    try {
      live = await readAll(collections, read);
      failedReads = 0;
    } catch (error) {
      failedReads += 1;
      if (!isTransientError(error) || failedReads >= WAIT_READ_ATTEMPTS || remaining() <= 0) {
        throw error;
      }
      onReadError(error, failedReads);
      await sleep(nextPollDelay(attempt, remaining()));
      continue;
    }
    onPoll(live);
    const failed = [];
    const notReady = [];
    const preexisting = [];
    for (const target of targets) {
      const index = live.get(`${target.collection}\u0000${target.name}`);
      const entry = {
        collection: target.collection,
        name: target.name,
        ...(index ? searchBuild(index) : { status: 'UNKNOWN', queryable: false }),
      };
      const state = index ? searchBuildState(index) : 'building';
      if (target.touched === false && (state === 'failed' || state === 'stale')) {
        preexisting.push(entry);
      } else if (state === 'failed') {
        failed.push(entry);
      } else if (!index || !isSearchIndexReady(index, { sinceVersion: target.sinceVersion })) {
        notReady.push(entry);
      }
    }
    const waitedMs = now() - startedAt;
    if (failed.length > 0) {
      return { outcome: 'failed', notReady: [...failed, ...notReady], preexisting, waitedMs };
    }
    if (notReady.length === 0) return { outcome: 'ready', notReady, preexisting, waitedMs };
    const remainingMs = remaining();
    if (remainingMs <= 0) return { outcome: 'timeout', notReady, preexisting, waitedMs };
    await sleep(nextPollDelay(attempt, remainingMs));
  }
}

module.exports = {
  SEARCH_STEPS,
  SEARCH_UNAVAILABLE_HINT,
  awaitSearchIndexes,
  isSearchUnavailable,
  isTransientError,
  listSearchIndexes,
  nextPollDelay,
  probeSearch,
  runSearchStep,
  searchHint,
};
