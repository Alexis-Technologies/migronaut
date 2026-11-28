const {
  BackgroundConflictError,
  BackgroundFailedError,
  LockLostError,
} = require('../../errors/index.js');
const { canonicalize, isPlainObject } = require('../../utils/canonical.js');
const {
  DUPLICATE_KEY,
  formatDocumentError,
  formatError,
  isTransientTransaction,
} = require('../../utils/error.js');
const {
  cloneDocument,
  buildOccFilter,
  readRevision,
  buildStampedDiff,
  buildVersionFilter,
  readVersion,
} = require('../../versioning/document.js');
const { MAX_CHECKPOINT_BYTES } = require('./spec.js');
const { measureBsonSize } = require('./bson-peer.js');
const { sleep } = require('./throttle.js');
const { READ_OPTIONS } = require('../server-info.js');

/** The counters a step result may report */
const STEP_COUNTERS = Object.freeze(['processed', 'migrated']);

/**
 * The batch engine: one background migration's documents rewritten, batch
 * by batch, inside one partition a lane holds the lease of.
 *
 * A batch is read through the version index, transformed (on copies), and
 * written as one unordered `bulkWrite` of operator updates — each guarded by
 * the document's `_id`, its exact old version and (with revisions) its exact
 * revision. A document the application wrote in between matches nothing:
 * it is read again and transformed again, up to `maxConflictRetries` rounds,
 * and whatever is still in the way is left for the next pass. Only the fields
 * a transformation changed are written (`buildStampedDiff`), so every other field
 * keeps its stored BSON type. After each batch the partition's cursor moves
 * forward in one fenced checkpoint.
 *
 * `applyBatch` is the one write path: the slice engine, the live drift
 * watcher and the dry-run sandbox all go through it.
 */

/** Server errors that fail just the document, not the batch */
const DOCUMENT_ERRORS = new Set([
  DUPLICATE_KEY,
  121, // document failed validation
  72, // invalid options — a shard key change through mongos
  66, // immutable field
  17280, // key too large to index
]);

/** A transaction's retry backoff: full jitter, up to 50 ms · 2ⁿ, never past 2 s */
const TXN_BACKOFF_BASE_MS = 50;

const TXN_BACKOFF_MAX_MS = 2_000;

/** A transactional batch halved on trouble grows back ×1.5 after this many clean ones */
const CLEAN_BATCHES_TO_GROW = 5;

const BATCH_GROWTH = 1.5;

/** The server's ceiling on what one batch reads into a transaction — well under 16 MiB */
const MAX_TRANSACTION_BYTES = 8 * 1024 * 1024;

/** Errors that mean "the batch took too long or grew too big" — halve it and retry */
const TIME_OR_SIZE = new Set([50, 262, 290, 334, 10334, 17419]);

/** What the state's controls mean for a lane on this partition — `undefined`: go on */
/** What a lane does when its state is not `running` any more: stop as the state says */
const STOPPED_OUTCOMES = {
  __proto__: null,
  paused: 'paused',
  cancelled: 'cancelled',
  failed: 'failed',
};

/** A stable string for an `_id`, whatever BSON type it is — a Map key */
const toIdKey = (id) => JSON.stringify(canonicalize(id));

/** What one direction of a background migration reads, writes and calls */
const resolveDirection = (spec, functions, direction) => {
  const isForward = direction !== 'revert';
  return {
    source: isForward ? spec.from : spec.to,
    target: isForward ? spec.to : spec.from,
    one: isForward ? functions.migrate : functions.revert,
    many: isForward ? functions.migrateBatch : functions.revertBatch,
  };
};

/** The documents a background migration (still) has to rewrite, in one direction */
const matchOf = (spec, direction) => {
  const source = direction === 'revert' ? spec.to : spec.from;
  return { ...spec.filter, ...buildVersionFilter(spec, source) };
};

/** `match` without the documents that failed — left out of later passes and of the final count */
const excludeBadIds = (match, badIds = []) => {
  return badIds.length > 0 ? { $and: [match, { _id: { $nin: badIds } }] } : match;
};

/**
 * `ctx.background`: which background migration, generation and partition —
 * and, for `ctx.logger` and `migration:log`, the lane (`runId`, its owner),
 * the queue job working it (and its group, when a run drives it inline) and
 * the transaction attempt. Frozen, like an ordinary migration's `ctx.run`.
 */
const buildBackgroundInfo = (job, attempt) => {
  return Object.freeze({
    name: job.name,
    generation: job.generation,
    partition: `${job.partitionId ?? ''}`,
    ...(job.runId !== undefined ? { runId: job.runId } : {}),
    ...(job.jobId !== undefined ? { jobId: job.jobId } : {}),
    ...(job.groupId !== undefined ? { groupId: job.groupId } : {}),
    attempt,
  });
};

/**
 * What a transformation sees besides the document. `attempt` counts the
 * transactions a transactional batch or step went through — each one runs the
 * user's code again — and is 1 everywhere else. `job.logs` binds a logger to
 * `ctx.background`; a job without it (a test's) gets the plain logger.
 */
const transformContext = (job, extra = {}, attempt = 1) => {
  const direction = job.direction ?? 'forward';
  const background = buildBackgroundInfo(job, attempt);
  return {
    signal: job.signal,
    logger: job.logs ? job.logs(background, direction) : job.logger,
    direction,
    background,
    ...extra,
  };
};

/**
 * `filter` (a fresh object of the caller's) with the partitioner's write
 * filter for `doc` laid onto it — the shard key, on a sharded collection. Key
 * by key, not a spread: it runs once for every document written.
 */
const withWriteFilter = (filter, partitioner, doc) => {
  const extra = partitioner?.writeFilter?.(doc);
  if (extra === undefined || extra === null) return filter;
  const keys = Object.keys(extra);
  for (let i = 0; i < keys.length; i++) filter[keys[i]] = extra[keys[i]];
  return filter;
};

const toDocumentError = (doc, error, reason) => {
  return {
    id: doc._id,
    error: formatDocumentError(error),
    ...(reason !== undefined ? { reason } : {}),
  };
};

/**
 * Transform `docs` (each on a copy): `[{ doc, next, error }]`, aligned — one
 * shape for both outcomes, `error` null when the document transformed.
 * Every result is read once more, per document, by the write path. A batch transformation that
 * throws, or returns the wrong number of results, fails the slice — it cannot say which document
 * was at fault.
 */
const transformAll = async (job, docs, ctx) => {
  const { one, many } = resolveDirection(job.spec, job.fns, job.direction);
  const results = [];
  if (typeof many === 'function') {
    const copies = [];
    for (let i = 0; i < docs.length; i++) copies.push(cloneDocument(docs[i]));
    const out = await many(copies, ctx);
    if (!Array.isArray(out) || out.length !== docs.length) {
      throw new BackgroundFailedError(
        `migrateBatch returned ${Array.isArray(out) ? out.length : 'no'} result(s) for ` +
          `${docs.length} document(s) — it must return one per document, in order`,
      );
    }
    for (let i = 0; i < docs.length; i++) {
      const hasFailed = out[i] instanceof Error;
      results.push({
        doc: docs[i],
        next: hasFailed ? undefined : out[i],
        error: hasFailed ? out[i] : null,
      });
    }
    return results;
  }
  for (let i = 0; i < docs.length; i++) {
    try {
      const next = await one(cloneDocument(docs[i]), ctx);
      results.push({ doc: docs[i], next, error: null });
    } catch (error) {
      // A side write that hit a transient transaction error is the batch's,
      // not the document's: the whole transaction is retried.
      if (isTransientTransaction(error)) throw error;
      results.push({ doc: docs[i], next: undefined, error });
    }
  }
  return results;
};

/**
 * The guarded operations for transformed documents: `{ ops, owners, errors }`
 * — `owners[i]` the document behind `ops[i]`.
 */
const buildOps = (job, transformed) => {
  const { source, target } = resolveDirection(job.spec, job.fns, job.direction);
  const partitioner = job.partitioner;
  // The same two option objects for every document of the batch.
  const fromSource = { from: source };
  const toTarget = { to: target };
  const ops = [];
  const owners = [];
  const errors = [];
  for (const { doc, next, error } of transformed) {
    if (error !== null) {
      errors.push(toDocumentError(doc, error, 'transform'));
      continue;
    }
    const refused = partitioner?.checkTransform?.(doc, next) ?? null;
    if (refused) {
      errors.push(toDocumentError(doc, refused.message ?? refused.reason, refused.reason));
      continue;
    }
    let update = null;
    try {
      update = buildStampedDiff(doc, next, job.spec, toTarget);
    } catch (stampError) {
      errors.push(toDocumentError(doc, stampError, 'shape'));
      continue;
    }
    const filter = withWriteFilter(buildOccFilter(doc, job.spec, fromSource), partitioner, doc);
    ops.push({ updateOne: { filter, update } });
    owners.push(doc);
  }
  return { ops, owners, errors };
};

/**
 * Inside a transaction the transaction's write concern is the one that
 * counts; in the sandbox (`bare`) the proxy supplies the session.
 */
const buildBulkOptions = (bare, session, writeConcern) => {
  if (bare) return { ordered: false };
  if (session) return { ordered: false, session };
  return { ordered: false, writeConcern };
};

/** A driver's `writeErrors`: a list, one error, or none */
const listOf = (raw) => {
  if (Array.isArray(raw)) return raw;
  return raw ? [raw] : [];
};

/**
 * Write `ops`: `{ matched, failed: Map<index, writeError> }`. Only errors of
 * single documents (a duplicate key, the validator) are taken apart; a write
 * concern error, or anything else, fails the batch — and the slice.
 */
const writeOps = async (collection, ops, { writeConcern, session, bare = false }) => {
  const failed = new Map();
  if (ops.length === 0) return { matched: 0, failed };
  try {
    const result = await collection.bulkWrite(ops, buildBulkOptions(bare, session, writeConcern));
    return { matched: result.matchedCount, failed };
  } catch (error) {
    const writeErrors = listOf(error?.writeErrors);
    if (writeErrors.length === 0 || error.err !== undefined) throw error;
    if (error.result?.getWriteConcernError?.()) throw error;
    for (const writeError of writeErrors) {
      if (!DOCUMENT_ERRORS.has(writeError.code)) throw error;
      failed.set(writeError.index, writeError);
    }
    return { matched: error.result?.matchedCount ?? 0, failed };
  }
};

/**
 * A filter for these documents: by `_id` — and, on a sharded collection,
 * each with its shard key (an `$or` of the write filters), so the mongos
 * reads them from their own shards instead of asking every one.
 */
const byIds = (docs, partitioner) => {
  const ids = [];
  const branches = [];
  let isKeyed = false;
  for (const doc of docs) {
    ids.push(doc._id);
    const branch = withWriteFilter({ _id: doc._id }, partitioner, doc);
    if (!isKeyed && Object.keys(branch).length > 1) isKeyed = true;
    branches.push(branch);
  }
  return isKeyed ? { $or: branches } : { _id: { $in: ids } };
};

/**
 * Transform and write one batch, retrying documents a concurrent write moved
 * under it. Returns `{ migrated, skipped, conflicts, retried, errors }` —
 * `errors` the documents that failed (`{ id, error, reason }`), `conflicts`
 * the ones still in the way after every retry (the next pass takes them).
 *
 * `options`: `{ db, session?, writeConcern?, signal? }`; with a `session`
 * every write joins it (the transactional mode, the sandbox) and a document
 * a concurrent write moved aborts the batch instead (`abortOnConflict`).
 */
const applyBatch = async (job, docs, options = {}) => {
  const { db, session, ctxExtra, attempt } = options;
  const abortOnConflict = options.abortOnConflict ?? false;
  const strict = options.strict ?? false;
  const bare = options.bare ?? false;

  const spec = job.spec;
  const collection = db.collection(spec.collection);
  const { source, target } = resolveDirection(spec, job.fns, job.direction);
  // `left`: documents read and not rewritten — a draining partition steps over them.
  const counts = { migrated: 0, skipped: 0, conflicts: 0, retried: 0, errors: [], left: [] };
  const ctx = transformContext(job, ctxExtra, attempt);
  let pending = docs;
  for (let round = 0; pending.length > 0; round++) {
    const transformed = await transformAll(job, pending, ctx);
    const { ops, owners, errors } = buildOps(job, transformed);
    // Strict (a transaction): one bad document aborts the batch, to be retried
    // without it — its side writes must not commit with the others.
    if (strict && errors.length > 0) throw createDocumentError(errors[0]);
    for (let i = 0; i < errors.length; i++) counts.errors.push(errors[i]);
    const { matched, failed } = await writeOps(collection, ops, {
      writeConcern: spec.writeConcern,
      session,
      bare,
    });
    if (strict && failed.size > 0) {
      const first = failed.entries().next().value;
      const writeError = first[1];
      throw createDocumentError(
        toDocumentError(owners[first[0]], writeError.errmsg ?? writeError.message, 'write'),
      );
    }
    for (const entry of failed) {
      const writeError = entry[1];
      counts.errors.push(
        toDocumentError(owners[entry[0]], writeError.errmsg ?? writeError.message, 'write'),
      );
    }
    const written = ops.length - failed.size;
    if (matched === written) {
      counts.migrated += written;
      return counts;
    }
    if (abortOnConflict) {
      throw new BackgroundConflictError('A document changed under the transactional batch', {
        context: { reason: 'write-conflict' },
      });
    }
    // Some writes matched nothing: see what those documents are now.
    const candidates = [];
    for (let i = 0; i < owners.length; i++) if (!failed.has(i)) candidates.push(owners[i]);
    const readOptions = { ...READ_OPTIONS, ...(session ? { session } : {}) };
    const projection = {
      [spec.field]: 1,
      ...(spec.revisionField ? { [spec.revisionField]: 1 } : {}),
    };
    const current = await collection
      .find(byIds(candidates, job.partitioner), { projection, ...readOptions })
      .toArray();
    const byId = new Map();
    for (const doc of current) byId.set(toIdKey(doc._id), doc);
    const stale = [];
    for (const prev of candidates) {
      const now = byId.get(toIdKey(prev._id));
      if (now === undefined) {
        counts.skipped += 1;
        continue;
      }
      const version = readVersion(now, spec.field);
      if (version === target) {
        const expected = (readRevision(prev, spec.revisionField ?? undefined) ?? 0) + 1;
        if (spec.revisionField === null || readRevision(now, spec.revisionField) === expected) {
          counts.migrated += 1;
        } else {
          // Rewritten by us and touched again since, or upgraded by someone else.
          counts.skipped += 1;
        }
      } else if (version === source) {
        stale.push(prev);
      } else {
        counts.skipped += 1;
      }
    }
    if (stale.length === 0) return counts;
    // Still the old shape: read them whole — and still matching the filter,
    // which the server judges.
    const retry = await collection
      .find(
        { $and: [job.match ?? matchOf(spec, job.direction), byIds(stale, job.partitioner)] },
        readOptions,
      )
      .toArray();
    counts.skipped += stale.length - retry.length;
    if (retry.length === 0) return counts;
    if (round >= spec.maxConflictRetries) {
      counts.conflicts += retry.length;
      for (const doc of retry) counts.left.push(doc._id);
      return counts;
    }
    counts.retried += retry.length;
    pending = retry;
  }
  return counts;
};

/** A document that fails a strict (transactional) batch — caught by writeTransactionalBatch */
const createDocumentError = (entry) => {
  return new BackgroundFailedError(`A document failed: ${entry.error}`, {
    context: { reason: 'document', document: entry },
  });
};

/**
 * The context of a `step` background migration: the database and client
 * (and, in a transaction or a dry run, the session), its last checkpoint,
 * and the deadline it should return by.
 */
const buildStepContext = (job, options = {}) => {
  const { db, client, session, checkpoint, deadline, dryRun, attempt } = options;

  return {
    ...transformContext(job, {}, attempt),
    db,
    client,
    checkpoint: checkpoint ?? null,
    deadline,
    ...(session ? { session } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
};

/** A step's result, validated: `{ checkpoint, done, processed?, migrated?, total? }` */
const readStepResult = (result) => {
  if (!isPlainObject(result) || typeof result.done !== 'boolean') {
    throw new BackgroundFailedError('step() must return { checkpoint, done } — done a boolean');
  }
  const checkpoint = result.checkpoint ?? null;
  if (measureBsonSize({ checkpoint }) > MAX_CHECKPOINT_BYTES) {
    throw new BackgroundFailedError(
      `step() returned a checkpoint larger than ${MAX_CHECKPOINT_BYTES / 1024} KiB — keep a cursor in it, not data`,
    );
  }
  const counters = {};
  for (const key of STEP_COUNTERS) {
    if (Number.isSafeInteger(result[key]) && result[key] > 0) counters[key] = result[key];
  }
  return {
    checkpoint,
    done: result.done,
    counters,
    ...(Number.isSafeInteger(result.total) ? { total: result.total } : {}),
  };
};

/**
 * How every transaction of a background migration starts: a snapshot read
 * on the primary, the spec's write concern (majority by default), and the
 * spec's time limit on the commit.
 */
const buildTransactionOptions = (spec) => {
  return {
    readConcern: { level: 'snapshot' },
    writeConcern: spec.writeConcern ?? { w: 'majority' },
    readPreference: 'primary',
    ...(spec.transaction?.timeoutMs !== undefined
      ? { maxCommitTimeMS: spec.transaction.timeoutMs }
      : {}),
  };
};

/** A write that failed for want of capacity, not for a fault of the data */
const isOverload = (error) => {
  if (error?.err !== undefined || error?.writeConcernError !== undefined) return true;
  if (error?.result?.getWriteConcernError?.()) return true;
  if (error?.hasErrorLabel?.('TransientTransactionError') === true) return true;
  if (error?.hasErrorLabel?.('RetryableWriteError') === true) return true;
  // MaxTimeMSExpired, ExceededTimeLimit.
  return error?.code === 50 || error?.code === 262;
};

/** Elapsed milliseconds from `start`, by the injected clock */
const measureElapsedMs = (now, start) => now() - start;

/**
 * Wind a transaction's session down on the way out: what failed there is said
 * at debug, never thrown over the outcome the batch is reporting (the server
 * aborts an abandoned transaction on its own).
 */
const settleSession = async (job, step, what) => {
  try {
    await step;
  } catch (error) {
    job.logger?.debug(`Background migration: could not ${what} — ${formatError(error)}`);
  }
};

/** Add `from` into `into`, key by key */
const addCounters = (into, from) => {
  const keys = Object.keys(from);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = from[key];
    if (typeof value === 'number') into[key] = (into[key] ?? 0) + value;
  }
};

/**
 * One call of a step migration and its checkpoint — in one transaction when
 * the spec asks for it (the step's writes take `ctx.session` and commit with
 * the checkpoint; a transient error runs the step again, up to `maxRetries`).
 */
const runStep = async (job, ctx, cursor) => {
  const { store, lease, db, client, signal } = ctx;
  const userStep = job.direction === 'revert' ? job.fns.revertStep : job.fns.step;
  const save = async (result, session) => {
    const next = result.done ? null : { checkpoint: result.checkpoint };
    const counts = { ...result.counters, batches: 1 };
    await store.checkpoint(
      lease,
      { cursor: next ?? { checkpoint: result.checkpoint }, counters: counts, done: result.done },
      session ? { session } : {},
    );
    return { next, counts };
  };
  const stepContext = (session, attempt) => {
    return buildStepContext(job, {
      db,
      client,
      checkpoint: cursor.checkpoint,
      deadline: ctx.deadline,
      attempt,
      ...(session ? { session } : {}),
    });
  };
  if (!job.spec.transaction) return save(readStepResult(await userStep(stepContext(undefined, 1))));
  for (let attempt = 0; ; attempt++) {
    const session = client.startSession();
    try {
      session.startTransaction(buildTransactionOptions(job.spec));
      const result = await userStep(stepContext(session, attempt + 1));
      const saved = await save(readStepResult(result), session);
      await commit(session);
      lease.touch();
      return saved;
    } catch (error) {
      await settleSession(job, session.abortTransaction(), 'abort a transaction');
      if (!isTransientTransaction(error) || attempt >= job.spec.transaction.maxRetries) throw error;
      await sleep(computeBackoffMs(attempt + 1), signal);
    } finally {
      await settleSession(job, session.endSession(), 'end a session');
    }
  }
};

/** The counters of one written batch */
const countBatch = (docs, result, extra = {}) => {
  return {
    scanned: docs.length,
    migrated: result.migrated,
    skipped: result.skipped,
    conflicts: result.conflicts,
    retried: result.retried,
    failed: result.errors.length,
    batches: 1,
    ...extra,
  };
};

/**
 * A batch's failed documents, in one pass: their ids (`badIds`, and on the
 * `left` list a draining partition steps over) and their error entries.
 */
const collectErrors = (errors, left = []) => {
  const badIds = [];
  const docErrors = [];
  const at = new Date();
  for (const { id, error, reason } of errors) {
    badIds.push(id);
    left.push(id);
    docErrors.push({ error, reason, at });
  }
  return { badIds, docErrors, left };
};

/**
 * One batch without a transaction: read, transform, write, then the fenced
 * checkpoint — a crash between the writes and the checkpoint replays the
 * batch, which the version filter makes a no-op. The adaptive throttle judges
 * the write.
 */
const writePlainBatch = async (job, ctx, cursor, batchSize) => {
  const { store, lease, partition, db, throttle } = ctx;
  const now = ctx.now ?? Date.now;
  const adaptive = ctx.adaptive;
  const query = job.partitioner.batchQuery(partition.scope, cursor, {
    limit: batchSize,
    match: job.match,
    hint: job.hint,
  });
  const docs = await db.collection(job.spec.collection).find(query.filter, query.options).toArray();
  const writeStarted = now();
  let result = null;
  try {
    result = await applyBatch(job, docs, { db });
  } catch (error) {
    // A write concern timeout or a transient error is overload — back off before failing.
    if (isOverload(error)) {
      adaptive?.record({ latencyMs: measureElapsedMs(now, writeStarted), overloaded: true });
    }
    throw error;
  }
  const change = adaptive?.record({
    latencyMs: measureElapsedMs(now, writeStarted),
    overloaded: throttle.takeLagged?.() === true,
  });
  if (change) ctx.onThrottle?.(change);
  const { badIds, docErrors, left } = collectErrors(result.errors, [...result.left]);
  const next = job.partitioner.advance(cursor, docs, { limit: batchSize, left });
  const counts = countBatch(docs, result);
  await store.checkpoint(lease, {
    cursor: next ?? cursor,
    counters: counts,
    badIds,
    docErrors,
    done: next === null,
    ...(adaptive ? { throttle: adaptive.state() } : {}),
  });
  return { result, next, counts };
};

const computeBackoffMs = (attempt) => {
  return Math.random() * Math.min(TXN_BACKOFF_MAX_MS, TXN_BACKOFF_BASE_MS * 2 ** attempt);
};

const isUnknownCommit = (error) => {
  return error?.hasErrorLabel?.('UnknownTransactionCommitResult') === true;
};

/** The leading documents of `docs` whose BSON fits in `bytes` — at least one */
const takeFitting = (docs, bytes) => {
  let total = 0;
  for (let i = 0; i < docs.length; i++) {
    total += measureBsonSize(docs[i]);
    if (total > bytes && i > 0) return docs.slice(0, i);
  }
  return docs;
};

const commit = async (session) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (error) {
      // The commit may have landed: commit again — it is idempotent — after
      // the same jittered pause a transaction retry takes: an unknown result
      // is most often a failover, which a commit at once only runs into.
      if (!isUnknownCommit(error) || attempt >= 2) throw error;
      await sleep(computeBackoffMs(attempt + 1));
    }
  }
};

/**
 * One batch in a transaction: the read (snapshot), the transformations —
 * with `ctx.session` for their own side writes — the guarded writes and the
 * fenced checkpoint all commit together, or not at all. So the counters are
 * exact, a stale lease holder cannot commit (its checkpoint matches nothing),
 * and a side write happens once per document that is migrated.
 *
 * A document that fails (its transformation, the validator, a duplicate key)
 * aborts the batch, which is retried without it; a document a concurrent
 * write moved aborts it too, and is read again in the retry. Transient
 * transaction errors back off (full jitter, 50 ms · 2ⁿ up to 2 s) up to
 * `maxRetries`, halving the batch after half of them; a batch that ran out of
 * time or room is halved at once. Alone in a batch, a conflicting document is
 * skipped (the next pass takes it) and one too big or too slow is a document
 * error. Clean batches grow back ×1.5.
 */
const writeTransactionalBatch = async (job, ctx, cursor, batchSize) => {
  const { store, lease, partition, db, client, signal } = ctx;
  const spec = job.spec;
  const { timeoutMs, maxRetries } = spec.transaction;
  const collection = db.collection(spec.collection);
  ctx.txn ??= { size: batchSize, clean: 0 };
  let size = Math.min(ctx.txn.size, batchSize);
  let attempts = 0;
  let txnRetries = 0;
  // Every turn of the loop is a transaction of its own that runs the
  // transformations again: what they log says which one it was.
  let transactions = 0;
  const excluded = new Map();
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    transactions += 1;
    const session = client.startSession();
    let docs = [];
    try {
      session.startTransaction(buildTransactionOptions(spec));
      const query = job.partitioner.batchQuery(partition.scope, cursor, {
        limit: size,
        match: job.match,
        hint: job.hint,
      });
      const fetched = await collection
        .find(query.filter, { ...query.options, session, maxTimeMS: timeoutMs })
        .toArray();
      docs = takeFitting(fetched, MAX_TRANSACTION_BYTES);
      const work = [];
      for (const doc of docs) if (!excluded.has(toIdKey(doc._id))) work.push(doc);
      const result =
        work.length > 0
          ? await applyBatch(job, work, {
              db,
              session,
              ctxExtra: { session, db, client },
              abortOnConflict: true,
              strict: true,
              attempt: transactions,
            })
          : { migrated: 0, skipped: 0, conflicts: 0, retried: 0, errors: [], left: [] };
      // Only the failed documents this transaction read: one excluded while
      // the batch was larger lies past it now, and is met again by the batch
      // that reaches it — recorded here too, it was counted once per commit.
      const errors = [];
      for (const doc of docs) {
        const entry = excluded.get(toIdKey(doc._id));
        if (entry !== undefined) errors.push(entry);
      }
      result.errors = errors;
      const { badIds, docErrors, left } = collectErrors(errors);
      const next =
        docs.length < fetched.length
          ? job.partitioner.past(cursor, docs, { left })
          : job.partitioner.advance(cursor, fetched, { limit: size, left });
      const counts = countBatch(docs, result, txnRetries > 0 ? { txnRetries } : {});
      // The last write of the transaction: only the lease holder's commits.
      await store.checkpoint(
        lease,
        {
          cursor: next ?? cursor,
          counters: counts,
          badIds,
          docErrors,
          done: next === null,
        },
        { session },
      );
      await commit(session);
      lease.touch();
      ctx.txn.clean += 1;
      if (ctx.txn.clean >= CLEAN_BATCHES_TO_GROW && size < batchSize) {
        ctx.txn.size = Math.min(batchSize, Math.ceil(size * BATCH_GROWTH));
        ctx.txn.clean = 0;
      } else {
        ctx.txn.size = size;
      }
      if (txnRetries > 0) ctx.onTransactionRetries?.(txnRetries);
      return { result, next, counts };
    } catch (error) {
      await settleSession(job, session.abortTransaction(), 'abort a transaction');
      if (error instanceof LockLostError) throw error;
      if (error?.context?.reason === 'document') {
        const entry = error.context.document;
        excluded.set(toIdKey(entry.id), entry);
        continue;
      }
      const isConflict = error?.context?.reason === 'write-conflict';
      const isTimeOrSize = TIME_OR_SIZE.has(error?.code);
      if (!isConflict && !isTimeOrSize && !isTransientTransaction(error)) throw error;
      txnRetries += 1;
      ctx.txn.clean = 0;
      if (size === 1 && docs.length === 1) {
        const doc = docs[0];
        if (isTimeOrSize) {
          excluded.set(toIdKey(doc._id), toDocumentError(doc, error, 'transaction'));
          continue;
        }
        if (isConflict) {
          // Alone and still in the way: past it — the next pass takes it. A
          // draining range with too many stepped over is done here (`null`):
          // closed like any other, or the partition would stay open with no
          // cursor and be worked again from its start.
          const next = job.partitioner.past(cursor, [doc], { left: [doc._id] });
          const counts = { scanned: 1, conflicts: 1, batches: 1, txnRetries };
          await store.checkpoint(lease, {
            cursor: next ?? cursor,
            counters: counts,
            done: next === null,
          });
          ctx.onTransactionRetries?.(txnRetries);
          return {
            result: { migrated: 0, skipped: 0, conflicts: 1, retried: 0, errors: [] },
            next,
            counts,
          };
        }
      }
      // Too slow or too big: halve the batch at once. At one document that
      // is not the answer any more (the read itself ran out of time — a
      // filter the index does not cover): it is retried like a transient
      // error, with a backoff, and fails the slice after maxRetries.
      if (isTimeOrSize && size > 1) {
        size = Math.max(1, Math.floor(size / 2));
        continue;
      }
      attempts += 1;
      if (attempts > maxRetries) throw error;
      if (attempts > maxRetries / 2) size = Math.max(1, Math.floor(size / 2));
      await sleep(computeBackoffMs(attempts), signal);
    } finally {
      await settleSession(job, session.endSession(), 'end a session');
    }
  }
};

/**
 * Work one partition until it is done, the slice's deadline passes, a
 * control or a new plan says stop, or the lease is lost. `ctx`:
 * `{ store, lease, partition, db, client, signal, deadline, throttle,
 * readControl, onBatch?, now? }` — `readControl()` resolves to the state's
 * `{ status, generation, plan }`; `onBatch(info)` hears every batch.
 *
 * Resolves to `{ outcome, counters }` — `outcome` one of `exhausted` (the
 * partition is done), `yielded` (the slice ended), `paused`, `cancelled`,
 * `failed` (the state failed, or the error budget ran out — with `error`),
 * `stale` (another plan took over) or `stopped` (the signal). A lost lease
 * throws LockLostError; a failure of the slice itself throws.
 */
const processPartition = async (job, ctx) => {
  const { store, partition, signal, throttle, readControl } = ctx;
  const now = ctx.now ?? Date.now;
  const spec = job.spec;
  const counters = {};
  let cursor = partition.cursor ?? {};
  let batches = 0;
  for (;;) {
    if (signal?.aborted) return { outcome: 'stopped', counters };
    // At least one batch per partition claimed, however short the slice.
    if (batches > 0 && now() >= ctx.deadline) return { outcome: 'yielded', counters, cursor };
    const control = await readControl();
    const stop = resolveControlOutcome(control, job, partition);
    if (stop) return { outcome: stop, counters };
    const adaptive = ctx.adaptive;
    // Never past the author's batchSize, whatever a controller learned under
    // another one.
    const batchSize = Math.min(adaptive?.batchSize() ?? spec.batchSize, spec.batchSize);
    const waited = await throttle.beforeBatch({
      signal,
      generation: job.generation,
      partition: `${partition._id}`,
      batchSize,
      extraPauseMs: adaptive?.pauseMs() ?? 0,
      deadline: ctx.deadline,
      onLag: ctx.onThrottle,
    });
    // A secondary lagged for the rest of the slice: nothing was read.
    if (waited?.expired) return { outcome: 'yielded', counters, cursor };
    const started = now();
    let next = null;
    let batchCounts = null;
    if (spec.mode === 'step') {
      const stepped = await runStep(job, ctx, cursor);
      next = stepped.next;
      batchCounts = stepped.counts;
    } else {
      const batch = spec.transaction
        ? await writeTransactionalBatch(job, ctx, cursor, batchSize)
        : await writePlainBatch(job, ctx, cursor, batchSize);
      const { result } = batch;
      next = batch.next;
      batchCounts = batch.counts;
      if (result.errors.length > 0) {
        const total = await store.countBadIds(job.name, job.generation);
        if (total > spec.maxDocumentErrors) {
          const error = new BackgroundFailedError(
            `Background migration ${job.name} failed: ${total} document(s) could not be ` +
              `migrated, more than maxDocumentErrors (${spec.maxDocumentErrors}) — last: ` +
              result.errors[result.errors.length - 1].error,
            {
              context: {
                migration: job.name,
                failedDocuments: total,
                maxDocumentErrors: spec.maxDocumentErrors,
              },
            },
          );
          addCounters(counters, batchCounts);
          return { outcome: 'failed', counters, error };
        }
      }
    }
    addCounters(counters, batchCounts);
    batches += 1;
    ctx.onBatch?.({ counters: batchCounts, latencyMs: measureElapsedMs(now, started), batchSize });
    if (next === null) return { outcome: 'exhausted', counters };
    cursor = next;
  }
};

const resolveControlOutcome = (control, job, partition) => {
  if (control === null) return 'cancelled';
  if (control.status !== 'running') return STOPPED_OUTCOMES[control.status] ?? 'stale';
  const isCurrent = control.generation === job.generation && control.plan?.token === partition.plan;
  return isCurrent ? undefined : 'stale';
};

module.exports = {
  DOCUMENT_ERRORS,
  toIdKey,
  resolveDirection,
  matchOf,
  excludeBadIds,
  transformContext,
  transformAll,
  applyBatch,
  buildStepContext,
  readStepResult,
  buildTransactionOptions,
  isOverload,
  addCounters,
  processPartition,
  resolveControlOutcome,
};
