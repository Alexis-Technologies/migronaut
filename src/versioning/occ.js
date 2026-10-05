const { ConfigInvalidError, RevisionConflictError } = require('../errors/index.js');
const { resolveFieldNames, revisionFilter, revisionOf, stampedUpdate } = require('./document.js');
const { filterTouches, isPlainObject } = require('./internal.js');

/**
 * Optimistic concurrency for a repository layer: a write that only lands if
 * the document is still at the revision the caller read, and bumps it.
 *
 *   await updateWithRevision(orders, { _id }, order.__rev, { $set: { status } });
 *
 * matches `{ _id, __rev: order.__rev }` and adds `$inc: { __rev: 1 }`. When it
 * matches nothing, someone else wrote in between (or the document is gone):
 * a `RevisionConflictError` says which, and the caller re-reads and retries
 * (`retryOnConflict`) or answers its own caller with a conflict.
 *
 * The collection is used structurally — anything with the driver's
 * `updateOne`/`replaceOne`/`findOneAndUpdate`/`findOne`, a Mongoose model's
 * collection included. Nothing here imports the driver.
 */

/** Options of ours, kept away from the driver */
const OWN_OPTIONS = new Set(['field', 'revisionField', 'version', 'verify']);

/** `{ names, version, verify, driverOptions }` from the caller's options */
function splitOptions(options = {}) {
  if (!isPlainObject(options)) throw new ConfigInvalidError('options must be an object');
  const driverOptions = {};
  for (const [key, value] of Object.entries(options)) {
    if (!OWN_OPTIONS.has(key)) driverOptions[key] = value;
  }
  if (driverOptions.upsert === true) {
    throw new ConfigInvalidError(
      'A revision-guarded write cannot upsert: a miss would insert a second document instead ' +
        'of reporting the conflict',
    );
  }
  const w = driverOptions.writeConcern?.w ?? driverOptions.w;
  if (w === 0) {
    throw new ConfigInvalidError(
      'A revision-guarded write needs an acknowledged write concern — with w: 0 a conflict ' +
        'cannot be seen',
    );
  }
  const names = resolveFieldNames({ field: options.field, revisionField: options.revisionField });
  return { names, version: options.version, verify: options.verify !== false, driverOptions };
}

function assertRevision(expected) {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new ConfigInvalidError('expectedRevision must be an integer ≥ 0', {
      expectedRevision: expected,
    });
  }
}

/** The caller's filter, refused if it already constrains the revision, plus ours */
function guardedFilter(filter, names, expected) {
  if (!isPlainObject(filter)) throw new ConfigInvalidError('filter must be an object');
  if (filterTouches(filter, names.revisionField)) {
    throw new ConfigInvalidError(
      `The filter must not constrain "${names.revisionField}" — pass the revision as ` +
        'expectedRevision',
    );
  }
  return { ...filter, ...revisionFilter(names, expected) };
}

/**
 * A miss, explained: read the document without the revision guard and say
 * whether it moved on (`conflict`, with `actual`), is gone (`not-found`), or
 * cannot be told (`unknown` — the read was turned off, or it failed). The
 * filter itself never goes into the error: it may carry PII.
 */
async function conflictError(collection, filter, names, expected, { verify, session }) {
  const context = { expected, reason: 'unknown' };
  if (collection?.collectionName !== undefined) context.collection = collection.collectionName;
  if (verify) {
    try {
      const current = await collection.findOne(filter, {
        projection: { [names.revisionField]: 1 },
        ...(session !== undefined ? { session } : {}),
      });
      if (current === null || current === undefined) {
        context.reason = 'not-found';
      } else {
        const actual = revisionOf(current, names.revisionField);
        // The same revision again means the guard missed on something else.
        if (actual !== expected) {
          context.reason = 'conflict';
          context.actual = actual;
        }
      }
    } catch {
      // `unknown` it stays.
    }
  }
  const what =
    context.reason === 'conflict'
      ? `is at revision ${context.actual}, not ${expected}`
      : context.reason === 'not-found'
        ? 'does not exist'
        : `was not at revision ${expected}, or no longer exists`;
  return new RevisionConflictError(`Revision conflict: the document ${what}`, context);
}

/**
 * `updateOne` guarded by the revision the caller read: `expectedRevision` is
 * `doc.__rev` (0 for a document without one). The update is an operator
 * document or a pipeline; the revision is bumped, and `version` (when given)
 * set. Returns the driver's result plus `revision`, the new one.
 *
 * @throws {RevisionConflictError} when nothing matched
 * @throws {ConfigInvalidError} on an upsert, a `w: 0` write, a filter or an
 *   update that handles the revision itself, or a replacement document
 */
async function updateWithRevision(collection, filter, expectedRevision, update, options) {
  const { names, version, verify, driverOptions } = splitOptions(options);
  assertRevision(expectedRevision);
  const guarded = guardedFilter(filter, names, expectedRevision);
  const stamped = stampedUpdate(names, { to: version, update });
  const result = await collection.updateOne(guarded, stamped, driverOptions);
  if (result.matchedCount === 0) {
    throw await conflictError(collection, filter, names, expectedRevision, {
      verify,
      session: driverOptions.session,
    });
  }
  return { ...result, revision: expectedRevision + 1 };
}

/** A plain document none of whose top-level keys is an operator */
function isReplacement(value) {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) if (key.startsWith('$')) return false;
  return true;
}

/**
 * `replaceOne` guarded by the revision the caller read. The replacement's
 * own revision field (usually the stale one it was read with) is overwritten
 * with the next revision; `version`, when given, sets the version field.
 *
 * @throws {RevisionConflictError} when nothing matched
 */
async function replaceWithRevision(collection, filter, expectedRevision, replacement, options) {
  const { names, version, verify, driverOptions } = splitOptions(options);
  assertRevision(expectedRevision);
  if (!isReplacement(replacement)) {
    throw new ConfigInvalidError(
      'The replacement must be a plain document without update operators',
    );
  }
  const guarded = guardedFilter(filter, names, expectedRevision);
  const document = { ...replacement, [names.revisionField]: expectedRevision + 1 };
  if (version !== undefined) {
    assertRevision(version);
    document[names.field] = version;
  }
  const result = await collection.replaceOne(guarded, document, driverOptions);
  if (result.matchedCount === 0) {
    throw await conflictError(collection, filter, names, expectedRevision, {
      verify,
      session: driverOptions.session,
    });
  }
  return { ...result, revision: expectedRevision + 1 };
}

/**
 * `findOneAndUpdate` guarded by the revision the caller read. Returns the
 * document — after the update by default (`returnDocument: 'before'` to get
 * the old one) — the same way on every driver version: the raw result is
 * always requested with its metadata and unwrapped here.
 *
 * @throws {RevisionConflictError} when nothing matched
 */
async function findOneAndUpdateWithRevision(collection, filter, expectedRevision, update, options) {
  const { names, version, verify, driverOptions } = splitOptions(options);
  assertRevision(expectedRevision);
  const guarded = guardedFilter(filter, names, expectedRevision);
  const stamped = stampedUpdate(names, { to: version, update });
  const result = await collection.findOneAndUpdate(guarded, stamped, {
    returnDocument: 'after',
    ...driverOptions,
    includeResultMetadata: true,
  });
  const value = result?.value ?? null;
  if (value === null) {
    throw await conflictError(collection, filter, names, expectedRevision, {
      verify,
      session: driverOptions.session,
    });
  }
  return value;
}

/** Full-jitter exponential backoff: anywhere up to `min(maxMs, baseMs · 2^attempt)` */
function jitter({ baseMs = 10, maxMs = 1000 } = {}) {
  return (attempt) => Math.random() * Math.min(maxMs, baseMs * 2 ** attempt);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Run `fn(attempt)` — which reads, decides and writes with a revision guard —
 * again after a conflict, up to `attempts` times in all (default 3), with a
 * full-jitter backoff between tries. A `not-found` is never retried: the
 * document is gone, and reading it again will not bring it back. Anything
 * that is not a `RevisionConflictError` is thrown at once.
 *
 * `backoff` is `{ baseMs, maxMs }` (default 10 and 1000) or a function of
 * the attempt number returning milliseconds; `signal` cuts a wait short.
 */
async function retryOnConflict(fn, { attempts = 3, backoff, signal } = {}) {
  if (typeof fn !== 'function') throw new ConfigInvalidError('retryOnConflict needs a function');
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new ConfigInvalidError('attempts must be an integer ≥ 1', { attempts });
  }
  const delay = typeof backoff === 'function' ? backoff : jitter(backoff);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const retryable =
        error instanceof RevisionConflictError && error.context?.reason !== 'not-found';
      if (!retryable || attempt + 1 >= attempts) throw error;
      await sleep(delay(attempt), signal);
    }
  }
}

/**
 * `update` with the revision bumped — for a write that is not guarded by a
 * revision but must still move it. In a collection with revisions every write
 * has to: a write that leaves the revision alone is one an optimistic
 * filter — the application's, or a background migration's — cannot see.
 */
function bumpRevision(update, { revisionField } = {}) {
  return stampedUpdate(resolveFieldNames({ revisionField }), { update });
}

module.exports = {
  bumpRevision,
  findOneAndUpdateWithRevision,
  replaceWithRevision,
  retryOnConflict,
  updateWithRevision,
};
