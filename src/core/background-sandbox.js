const {
  BackgroundFailedError,
  RunAbortedError,
  SandboxRefusedError,
  TransactionsUnsupportedError,
} = require('../errors/index.js');
const { isPlainObject } = require('../utils/canonical.js');
const { errorText } = require('../utils/error.js');
const { toRelaxedEjson } = require('./bson-peer.js');

/**
 * A sandbox for dry runs: user code runs against the real database, inside
 * a transaction that is **always** aborted — there is no path that commits —
 * through proxies that let through only what can run in that transaction,
 * record every operation, and keep before/after images of the documents it
 * touched. What a `step` (or a declarative migration's own side writes)
 * would do is shown on real data, and nothing of it stays.
 *
 * Fail closed: a method not on an allow-list is refused with
 * `SandboxRefusedError` (DDL, admin commands, another session, `$out`,
 * migronaut's own collections, …), and every refusal lands in the report
 * even when the code catches the error.
 *
 * Not a security boundary: code that captured a client of its own, or
 * requires the driver itself, can reach past the proxies. It is a guard
 * against the obvious mistakes.
 */

/** Collection methods that run inside the transaction: reads and writes */
const COLLECTION_READS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'distinct']);
const COLLECTION_WRITES = new Set([
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'bulkWrite',
]);
/** Plain properties of a collection, safe to read */
const COLLECTION_GETTERS = new Set(['collectionName', 'dbName', 'namespace']);

/** Cursor methods: builders return the cursor, terminals run it */
const CURSOR_BUILDERS = new Set([
  'filter',
  'sort',
  'limit',
  'skip',
  'project',
  'hint',
  'batchSize',
  'maxTimeMS',
  'collation',
  'comment',
  'map',
  'addStage',
  'match',
  'group',
  'unwind',
]);
const CURSOR_TERMINALS = new Set(['toArray', 'next', 'hasNext', 'tryNext', 'close']);

/** Aggregation stages that cannot run in the sandbox */
const REFUSED_STAGES = new Set([
  '$out',
  '$merge',
  '$changeStream',
  '$changeStreamSplitLargeEvent',
  '$currentOp',
  '$collStats',
  '$indexStats',
  '$listSessions',
  '$listLocalSessions',
  '$planCacheStats',
  '$listSearchIndexes',
  '$querySettings',
]);

/** Options a sandboxed operation may not set — the sandbox owns them */
const REFUSED_OPTIONS = ['writeConcern', 'readConcern', 'bypassDocumentValidation'];

const DEFAULTS = Object.freeze({ deadlineMs: 50_000, maxDocuments: 20, maxOps: 1000 });

/** How much of a filter a recorded operation keeps */
const MAX_FILTER_BYTES = 2048;

/** How large one recorded document image may be */
const MAX_IMAGE_BYTES = 64 * 1024;

const ATTEMPTS = 3;

const isTransient = (error) =>
  error?.hasErrorLabel?.('TransientTransactionError') === true || error?.code === 112;

/** A value as relaxed EJSON, cut to `bytes` of JSON */
function snapshot(value, bytes) {
  let json;
  try {
    json = toRelaxedEjson(value);
  } catch {
    return { $unserializable: true };
  }
  const text = JSON.stringify(json);
  return text.length > bytes ? { $truncated: true, size: text.length } : json;
}

/**
 * Run `fn(handles)` in the sandbox. `options`: `{ client, db, dbName,
 * forbidden: string[], topology?, deadlineMs, maxDocuments, maxOps }` —
 * `forbidden` the collection names no operation may touch (migronaut's
 * own). Resolves to `{ value, aborted: true, ok, attempts, stoppedBy?,
 * ops, documents, refusals, leakedCursors, truncated, abortedBy?, error? }`.
 *
 * @throws {TransactionsUnsupportedError} on a standalone server
 */
async function runSandbox(options, fn) {
  if (options.topology === 'standalone') {
    throw new TransactionsUnsupportedError(
      'A dry run executes in a transaction that is always aborted — it needs a replica set or ' +
        'a mongos',
      { sandbox: true },
    );
  }
  for (let attempt = 1; ; attempt++) {
    const report = await runOnce(options, fn, attempt);
    if (!report.retry || attempt >= ATTEMPTS) {
      delete report.retry;
      return report;
    }
  }
}

async function runOnce(options, fn, attempt) {
  const { client } = options;
  const deadlineMs = options.deadlineMs ?? DEFAULTS.deadlineMs;
  const maxDocuments = options.maxDocuments ?? DEFAULTS.maxDocuments;
  const maxOps = options.maxOps ?? DEFAULTS.maxOps;
  const session = client.startSession();
  const report = {
    aborted: true,
    ok: true,
    attempts: attempt,
    ops: [],
    documents: [],
    refusals: [],
    leakedCursors: 0,
    truncated: false,
  };
  const state = {
    options,
    session,
    report,
    maxDocuments,
    maxOps,
    seq: 0,
    step: 0,
    queue: Promise.resolve(),
    cursors: new Set(),
    images: new Map(),
    forbidden: new Set(options.forbidden ?? []),
    deadline: Date.now() + deadlineMs,
    failed: undefined,
  };
  let timer;
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' } });
    const handles = {
      db: proxyDb(state, options.db),
      client: proxyClient(state),
      session: (state.sessionProxy = proxySession(state)),
      mongoose: refusedMongoose(state),
      /** For a caller that runs several steps: number the operations by step */
      nextStep: () => {
        state.step += 1;
      },
    };
    const work = Promise.resolve().then(() => fn(handles));
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), Math.max(0, state.deadline - Date.now()));
    });
    const value = await Promise.race([work, deadline]);
    if (value === DEADLINE) {
      report.stoppedBy = 'deadline';
      work.catch(() => undefined);
    } else {
      report.value = value;
    }
  } catch (error) {
    if (state.failed !== undefined) {
      report.abortedBy = errorText(state.failed);
    } else if (isTransient(error)) {
      report.retry = true;
    }
    report.ok = false;
    report.error = errorText(error);
  } finally {
    clearTimeout(timer);
    // Any refusal makes the run not ok — even one the code swallowed.
    if (report.refusals.length > 0) report.ok = false;
    for (const cursor of state.cursors) {
      report.leakedCursors += 1;
      await cursor.close().catch(() => undefined);
    }
    await state.queue.catch(() => undefined);
    await finishImages(state);
    await session.abortTransaction().catch(() => undefined);
    await session.endSession().catch(() => undefined);
  }
  return report;
}

const DEADLINE = Symbol('deadline');

/** Refuse `method`: recorded, then thrown */
function refuse(state, method, reason, collection) {
  const entry = { method, reason, ...(collection !== undefined ? { collection } : {}) };
  state.report.refusals.push(entry);
  return new SandboxRefusedError(`The dry run refused ${method}: ${reason}`, entry);
}

/** Run `work` after every earlier operation — one at a time in one transaction */
function serialized(state, work) {
  const run = state.queue.then(() => {
    if (Date.now() > state.deadline) {
      throw new RunAbortedError('the dry run reached its deadline', { reason: 'deadline' });
    }
    if (state.failed !== undefined) {
      throw new BackgroundFailedError(`the transaction was aborted by ${errorText(state.failed)}`, {
        reason: 'aborted',
      });
    }
    return work();
  });
  state.queue = run.catch(() => undefined);
  return run;
}

/** The caller's options, checked and given the sandbox session */
function sandboxOptions(state, method, collection, options) {
  if (options !== undefined && !isPlainObject(options)) return { session: state.session };
  const out = { ...options };
  if (
    out.session !== undefined &&
    out.session !== state.session &&
    out.session !== state.sessionProxy
  ) {
    throw refuse(state, method, 'it passes another session', collection);
  }
  for (const key of REFUSED_OPTIONS) {
    if (out[key] !== undefined) throw refuse(state, method, `it sets ${key}`, collection);
  }
  const preference = out.readPreference;
  const mode = typeof preference === 'string' ? preference : preference?.mode;
  if (mode !== undefined && mode !== 'primary') {
    throw refuse(state, method, 'it reads from a secondary', collection);
  }
  out.session = state.session;
  return out;
}

/** Refuse a pipeline that writes elsewhere, watches, or reaches a forbidden collection */
function checkPipeline(state, method, collection, pipeline) {
  if (!Array.isArray(pipeline)) return;
  for (const stage of pipeline) {
    if (!isPlainObject(stage)) continue;
    for (const [name, spec] of Object.entries(stage)) {
      if (REFUSED_STAGES.has(name)) {
        throw refuse(state, method, `it uses ${name}`, collection);
      }
      const target =
        name === '$lookup' ? spec?.from : name === '$unionWith' ? (spec?.coll ?? spec) : undefined;
      if (typeof target === 'string' && isForbidden(state, target)) {
        throw refuse(state, method, `it reads ${target}`, collection);
      }
      if (name === '$lookup' || name === '$unionWith') {
        checkPipeline(state, method, collection, spec?.pipeline);
      }
      if (name === '$facet' && isPlainObject(spec)) {
        for (const branch of Object.values(spec)) checkPipeline(state, method, collection, branch);
      }
    }
  }
}

function isForbidden(state, name) {
  return name.startsWith('system.') || state.forbidden.has(name);
}

/** Record an operation, while there is room */
function record(state, entry) {
  if (state.report.ops.length >= state.maxOps) {
    state.report.truncated = true;
    return;
  }
  state.report.ops.push({ seq: ++state.seq, step: state.step, ...entry });
}

/** What a result says, without its documents */
function summarize(result) {
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return { count: result.length };
  if (typeof result !== 'object') return result;
  const summary = {};
  for (const key of [
    'acknowledged',
    'insertedCount',
    'matchedCount',
    'modifiedCount',
    'deletedCount',
    'upsertedCount',
  ]) {
    if (typeof result[key] === 'number' || typeof result[key] === 'boolean') {
      summary[key] = result[key];
    }
  }
  if (Object.keys(summary).length === 0 && '_id' in result) summary.document = true;
  return summary;
}

// ─── Document images ──────────────────────────────────────────────────────────

const imageKey = (collection, id) => `${collection}\u0000${JSON.stringify(snapshot(id, 1024))}`;

/** Before a write: read (in the transaction) what it may change, while there is room */
async function captureBefore(state, raw, method, args) {
  if (state.images.size >= state.maxDocuments) {
    state.report.truncated = state.report.truncated || COLLECTION_WRITES.has(method);
    return;
  }
  const filters = [];
  if (method === 'bulkWrite' && Array.isArray(args[0])) {
    for (const op of args[0]) {
      const body =
        op?.updateOne ?? op?.updateMany ?? op?.replaceOne ?? op?.deleteOne ?? op?.deleteMany;
      if (body?.filter) {
        filters.push({ filter: body.filter, many: Boolean(op.updateMany || op.deleteMany) });
      }
    }
  } else if (method !== 'insertOne' && method !== 'insertMany' && isPlainObject(args[0])) {
    filters.push({ filter: args[0], many: method === 'updateMany' || method === 'deleteMany' });
  }
  for (const { filter, many } of filters) {
    const left = state.maxDocuments - state.images.size;
    if (left <= 0) {
      state.report.truncated = true;
      return;
    }
    const docs = await raw
      .find(filter, { session: state.session, limit: many ? left : 1 })
      .toArray()
      .catch(() => []);
    for (const doc of docs) {
      const key = imageKey(raw.collectionName, doc._id);
      if (!state.images.has(key)) {
        state.images.set(key, { collection: raw.collectionName, id: doc._id, before: doc, raw });
      }
    }
  }
}

/** After a write: note the ids it created, so their after-images are read too */
function noteCreated(state, raw, method, result) {
  const ids = [];
  if (result?.insertedId !== undefined) ids.push(result.insertedId);
  if (result?.insertedIds) ids.push(...Object.values(result.insertedIds));
  if (result?.upsertedId !== undefined && result.upsertedId !== null) ids.push(result.upsertedId);
  if (result?.upsertedIds) ids.push(...Object.values(result.upsertedIds));
  if (method.startsWith('findOneAnd') && result?._id !== undefined) ids.push(result._id);
  for (const id of ids) {
    if (state.images.size >= state.maxDocuments) {
      state.report.truncated = true;
      return;
    }
    const key = imageKey(raw.collectionName, id);
    if (!state.images.has(key)) state.images.set(key, { collection: raw.collectionName, id, raw });
  }
}

/** Read every after-image (still in the transaction) and keep the documents that changed */
async function finishImages(state) {
  for (const image of state.images.values()) {
    let after = null;
    try {
      after = await image.raw.findOne({ _id: image.id }, { session: state.session });
    } catch {
      // The transaction may be gone (a write error aborted it): no after-image.
      after = undefined;
    }
    const before = image.before;
    if (before !== undefined && after !== undefined && after !== null) {
      if (
        JSON.stringify(snapshot(before, Infinity)) === JSON.stringify(snapshot(after, Infinity))
      ) {
        continue;
      }
    }
    const op =
      before === undefined
        ? 'insert'
        : after === null
          ? 'delete'
          : after === undefined
            ? 'unknown'
            : 'update';
    state.report.documents.push({
      collection: image.collection,
      _id: snapshot(image.id, MAX_FILTER_BYTES),
      op,
      ...(before !== undefined ? { before: snapshot(before, MAX_IMAGE_BYTES) } : {}),
      ...(after ? { after: snapshot(after, MAX_IMAGE_BYTES) } : {}),
    });
  }
}

// ─── Proxies ──────────────────────────────────────────────────────────────────

/** Properties every proxy answers without refusing — `then` especially (never thenable) */
const INERT = new Set(['then', 'constructor', 'toJSON', 'inspect']);

function proxyCollection(state, raw) {
  const name = raw.collectionName;
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property === 'symbol' || INERT.has(property)) return undefined;
      if (COLLECTION_GETTERS.has(property)) return raw[property];
      if (property === 'find' || property === 'aggregate') {
        return (...args) => readOp(state, raw, property, args);
      }
      // A promise-returning method refuses with a rejected promise, as the driver fails.
      // `distinct` asks first whether the collection is sharded — where the
      // server refuses it inside a transaction (263); a clearer refusal here.
      if (property === 'distinct') {
        return (...args) =>
          settle(async () => {
            if (await state.options.isSharded?.(name)) {
              throw refuse(
                state,
                property,
                'distinct cannot run in a transaction on a sharded collection',
                name,
              );
            }
            return readOp(state, raw, property, args);
          });
      }
      if (COLLECTION_READS.has(property)) {
        return (...args) => settle(() => readOp(state, raw, property, args));
      }
      if (COLLECTION_WRITES.has(property)) {
        return (...args) => settle(() => writeOp(state, raw, property, args));
      }
      return () => {
        throw refuse(state, `collection.${property}`, 'not available in a dry run', name);
      };
    },
  });
}

/** `fn()` as a promise — a synchronous throw becomes a rejection */
function settle(fn) {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error);
  }
}

function readOp(state, raw, method, args) {
  const name = raw.collectionName;
  if (method === 'aggregate') checkPipeline(state, method, name, args[0]);
  if (method === 'find' || method === 'aggregate') {
    const optionsIndex = 1;
    const options = sandboxOptions(state, method, name, args[optionsIndex]);
    const cursor = raw[method](args[0] ?? (method === 'find' ? {} : []), options);
    record(state, {
      collection: name,
      method,
      filter: snapshot(args[0] ?? null, MAX_FILTER_BYTES),
      result: 'cursor',
    });
    return proxyCursor(state, cursor);
  }
  const optionsIndex = method === 'distinct' ? 2 : 1;
  const call = [...args];
  call[optionsIndex] = sandboxOptions(state, method, name, args[optionsIndex]);
  if (method === 'distinct' && call[1] === undefined) call[1] = {};
  return serialized(state, async () => {
    const started = Date.now();
    try {
      const result = await raw[method](...call);
      record(state, {
        collection: name,
        method,
        filter: snapshot(args[method === 'distinct' ? 1 : 0] ?? null, MAX_FILTER_BYTES),
        result: summarize(result),
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      record(state, { collection: name, method, error: errorText(error) });
      throw error;
    }
  });
}

/** Where a write method takes its options */
const OPTIONS_AT = {
  insertOne: 1,
  insertMany: 1,
  updateOne: 2,
  updateMany: 2,
  replaceOne: 2,
  deleteOne: 1,
  deleteMany: 1,
  findOneAndUpdate: 2,
  findOneAndReplace: 2,
  findOneAndDelete: 1,
  bulkWrite: 1,
};

function writeOp(state, raw, method, args) {
  const name = raw.collectionName;
  if (isForbidden(state, name)) throw refuse(state, method, `${name} is migronaut's own`, name);
  const call = [...args];
  const at = OPTIONS_AT[method];
  call[at] = sandboxOptions(state, method, name, args[at]);
  if (method === 'updateOne' || method === 'updateMany' || method === 'findOneAndUpdate') {
    if (Array.isArray(args[1])) checkPipeline(state, method, name, args[1]);
  }
  return serialized(state, async () => {
    await captureBefore(state, raw, method, args);
    const started = Date.now();
    try {
      const result = await raw[method](...call);
      noteCreated(state, raw, method, result);
      record(state, {
        collection: name,
        method,
        filter: snapshot(method.startsWith('insert') ? null : (args[0] ?? null), MAX_FILTER_BYTES),
        result: summarize(result),
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      // A write error aborts the transaction on the server: nothing after it
      // can run. A transient one (a write conflict) runs the whole sandbox again.
      if (!isTransient(error)) state.failed = error;
      record(state, { collection: name, method, error: errorText(error) });
      throw error;
    }
  });
}

function proxyCursor(state, cursor) {
  state.cursors.add(cursor);
  let closed = false;
  const finish = () => {
    closed = true;
    state.cursors.delete(cursor);
  };
  const terminal =
    (method) =>
    (...args) => {
      if (closed) throw refuse(state, `cursor.${method}`, 'the cursor is closed');
      return serialized(state, async () => {
        const result = await cursor[method](...args);
        if (method === 'toArray' || method === 'close') finish();
        if ((method === 'next' || method === 'tryNext') && result === null) finish();
        return result;
      });
    };
  const proxy = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === Symbol.asyncIterator) {
        return async function* iterate() {
          for (;;) {
            const doc = await terminal('next')();
            if (doc === null) return;
            yield doc;
          }
        };
      }
      if (typeof property === 'symbol' || INERT.has(property)) return undefined;
      if (CURSOR_BUILDERS.has(property)) {
        return (...args) => {
          cursor[property](...args);
          return proxy;
        };
      }
      if (CURSOR_TERMINALS.has(property)) return terminal(property);
      if (property === 'forEach') {
        // Each document is read on its own turn; the callback runs outside the
        // queue, so it may run operations of its own.
        return async (callback) => {
          for (;;) {
            const doc = await terminal('next')();
            if (doc === null) return;
            if ((await callback(doc)) === false) {
              await terminal('close')();
              return;
            }
          }
        };
      }
      return () => {
        throw refuse(state, `cursor.${property}`, 'not available in a dry run');
      };
    },
  });
  return proxy;
}

function proxyDb(state, db) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property === 'symbol' || INERT.has(property)) return undefined;
      if (property === 'databaseName') return db.databaseName;
      if (property === 'collection') {
        return (name) => {
          if (typeof name !== 'string' || isForbidden(state, name)) {
            throw refuse(state, 'db.collection', `${String(name)} cannot be reached`, name);
          }
          return proxyCollection(state, db.collection(name));
        };
      }
      if (property === 'aggregate') {
        return (pipeline, options) => {
          checkPipeline(state, 'db.aggregate', undefined, pipeline);
          const cursor = db.aggregate(
            pipeline,
            sandboxOptions(state, 'db.aggregate', undefined, options),
          );
          record(state, { method: 'db.aggregate', filter: snapshot(pipeline, MAX_FILTER_BYTES) });
          return proxyCursor(state, cursor);
        };
      }
      return () => {
        throw refuse(state, `db.${property}`, 'not available in a dry run');
      };
    },
  });
}

function proxyClient(state) {
  const { db } = state.options;
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property === 'symbol' || INERT.has(property)) return undefined;
      if (property === 'db') {
        return (name) => {
          if (name !== undefined && name !== db.databaseName) {
            throw refuse(state, 'client.db', `only ${db.databaseName} can be reached`);
          }
          return proxyDb(state, db);
        };
      }
      return () => {
        throw refuse(state, `client.${property}`, 'not available in a dry run');
      };
    },
  });
}

function proxySession(state) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property === 'symbol' || INERT.has(property)) return undefined;
      if (property === 'inTransaction') return () => true;
      if (property === 'id') return state.session.id;
      return () => {
        throw refuse(state, `session.${property}`, 'the dry run owns the transaction');
      };
    },
  });
}

/** What a dry run's `ctx.mongoose` is: nothing usable — models bypass the session */
function refusedMongoose(state) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property === 'symbol' || INERT.has(property)) return undefined;
      throw refuse(state, `mongoose.${property}`, 'models do not join the dry-run transaction');
    },
  });
}

module.exports = {
  REFUSED_STAGES,
  SANDBOX_DEFAULTS: DEFAULTS,
  runSandbox,
};
