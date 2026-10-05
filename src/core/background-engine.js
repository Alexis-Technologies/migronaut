const { BackgroundConflictError, BackgroundFailedError } = require('../errors/index.js');
const { canonical, isPlainObject } = require('../utils/canonical.js');
const { errorText } = require('../utils/error.js');
const {
  cloneDocument,
  occFilter,
  revisionOf,
  stampedDiff,
  versionFilter,
  versionOf,
} = require('../versioning/document.js');
const { MAX_CHECKPOINT_BYTES } = require('./background-spec.js');
const { bsonSize } = require('./bson-peer.js');
const { READ_OPTIONS } = require('./server-info.js');

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
 * a transformation changed are written (`stampedDiff`), so every other field
 * keeps its stored BSON type. After each batch the partition's cursor moves
 * forward in one fenced checkpoint.
 *
 * `applyBatch` is the one write path: the slice engine, the live drift
 * watcher and the dry-run sandbox all go through it.
 */

/** Server errors that fail just the document, not the batch */
const DOCUMENT_ERRORS = new Set([
  11000, // duplicate key
  121, // document failed validation
  72, // invalid options — a shard key change through mongos
  66, // immutable field
  17280, // key too large to index
]);

/** A stable string for an `_id`, whatever BSON type it is — a Map key */
const idKey = (id) => JSON.stringify(canonical(id));

/** What one direction of a background migration reads, writes and calls */
function directionOf(spec, fns, direction) {
  const forward = direction !== 'revert';
  return {
    source: forward ? spec.from : spec.to,
    target: forward ? spec.to : spec.from,
    one: forward ? fns.migrate : fns.revert,
    many: forward ? fns.migrateBatch : fns.revertBatch,
  };
}

/** The documents a background migration (still) has to rewrite, in one direction */
function matchOf(spec, direction) {
  const source = direction === 'revert' ? spec.to : spec.from;
  return { ...spec.filter, ...versionFilter(spec, source) };
}

/** What a transformation sees besides the document */
function transformContext(job, extra = {}) {
  return {
    signal: job.signal,
    logger: job.logger,
    direction: job.direction ?? 'forward',
    background: {
      name: job.name,
      generation: job.generation,
      partition: String(job.partitionId ?? ''),
    },
    ...extra,
  };
}

const docError = (doc, error, reason) => ({
  id: doc._id,
  error: errorText(error),
  ...(reason !== undefined ? { reason } : {}),
});

/**
 * Transform `docs` (each on a copy): `[{ doc, next } | { doc, error }]`,
 * aligned. A batch transformation that throws, or returns the wrong number
 * of results, fails the slice — it cannot say which document was at fault.
 */
async function transformAll(job, docs, ctx) {
  const { one, many } = directionOf(job.spec, job.fns, job.direction);
  const results = new Array(docs.length);
  if (typeof many === 'function') {
    const copies = docs.map((doc) => cloneDocument(doc));
    const out = await many(copies, ctx);
    if (!Array.isArray(out) || out.length !== docs.length) {
      throw new BackgroundFailedError(
        `migrateBatch returned ${Array.isArray(out) ? out.length : 'no'} result(s) for ` +
          `${docs.length} document(s) — it must return one per document, in order`,
      );
    }
    for (let i = 0; i < docs.length; i++) {
      results[i] =
        out[i] instanceof Error ? { doc: docs[i], error: out[i] } : { doc: docs[i], next: out[i] };
    }
    return results;
  }
  for (let i = 0; i < docs.length; i++) {
    try {
      results[i] = { doc: docs[i], next: await one(cloneDocument(docs[i]), ctx) };
    } catch (error) {
      results[i] = { doc: docs[i], error };
    }
  }
  return results;
}

/**
 * The guarded operations for transformed documents: `{ ops, owners, errors }`
 * — `owners[i]` the document behind `ops[i]`.
 */
function buildOps(job, transformed) {
  const { source, target } = directionOf(job.spec, job.fns, job.direction);
  const partitioner = job.partitioner;
  const ops = [];
  const owners = [];
  const errors = [];
  for (const { doc, next, error } of transformed) {
    if (error !== undefined) {
      errors.push(docError(doc, error, 'transform'));
      continue;
    }
    const refused = partitioner?.checkTransform?.(doc, next) ?? null;
    if (refused) {
      errors.push(docError(doc, refused.message ?? refused.reason, refused.reason));
      continue;
    }
    let update;
    try {
      update = stampedDiff(doc, next, job.spec, { to: target });
    } catch (stampError) {
      errors.push(docError(doc, stampError, 'shape'));
      continue;
    }
    ops.push({
      updateOne: {
        filter: {
          ...occFilter(doc, job.spec, { from: source }),
          ...(partitioner?.writeFilter?.(doc) ?? {}),
        },
        update,
      },
    });
    owners.push(doc);
  }
  return { ops, owners, errors };
}

/**
 * Write `ops`: `{ matched, failed: Map<index, writeError> }`. Only errors of
 * single documents (a duplicate key, the validator) are taken apart; a write
 * concern error, or anything else, fails the batch — and the slice.
 */
async function writeOps(collection, ops, { writeConcern, session }) {
  const failed = new Map();
  if (ops.length === 0) return { matched: 0, failed };
  try {
    const result = await collection.bulkWrite(ops, {
      ordered: false,
      writeConcern,
      ...(session ? { session } : {}),
    });
    return { matched: result.matchedCount, failed };
  } catch (error) {
    const raw = error?.writeErrors;
    const writeErrors = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (writeErrors.length === 0 || error.err !== undefined) throw error;
    if (error.result?.getWriteConcernError?.()) throw error;
    for (const writeError of writeErrors) {
      if (!DOCUMENT_ERRORS.has(writeError.code)) throw error;
      failed.set(writeError.index, writeError);
    }
    return { matched: error.result?.matchedCount ?? 0, failed };
  }
}

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
async function applyBatch(job, docs, { db, session, ctxExtra, abortOnConflict = false } = {}) {
  const spec = job.spec;
  const collection = db.collection(spec.collection);
  const { source, target } = directionOf(spec, job.fns, job.direction);
  const counts = { migrated: 0, skipped: 0, conflicts: 0, retried: 0, errors: [] };
  const ctx = transformContext(job, ctxExtra);
  let pending = docs;
  for (let round = 0; pending.length > 0; round++) {
    const transformed = await transformAll(job, pending, ctx);
    const { ops, owners, errors } = buildOps(job, transformed);
    counts.errors.push(...errors);
    const { matched, failed } = await writeOps(collection, ops, {
      writeConcern: spec.writeConcern,
      session,
    });
    for (const [index, writeError] of failed) {
      counts.errors.push(docError(owners[index], writeError.errmsg ?? writeError.message, 'write'));
    }
    const written = ops.length - failed.size;
    if (matched === written) {
      counts.migrated += written;
      return counts;
    }
    if (abortOnConflict) {
      throw new BackgroundConflictError('A document changed under the transactional batch', {
        reason: 'write-conflict',
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
      .find({ _id: { $in: candidates.map((doc) => doc._id) } }, { projection, ...readOptions })
      .toArray();
    const byId = new Map();
    for (const doc of current) byId.set(idKey(doc._id), doc);
    const stale = [];
    for (const prev of candidates) {
      const now = byId.get(idKey(prev._id));
      if (now === undefined) {
        counts.skipped += 1;
        continue;
      }
      const version = versionOf(now, spec.field);
      if (version === target) {
        const expected = (revisionOf(prev, spec.revisionField ?? undefined) ?? 0) + 1;
        if (spec.revisionField === null || revisionOf(now, spec.revisionField) === expected) {
          counts.migrated += 1;
        } else {
          // Rewritten by us and touched again since, or upgraded by someone else.
          counts.skipped += 1;
        }
      } else if (version === source) {
        stale.push(prev._id);
      } else {
        counts.skipped += 1;
      }
    }
    if (stale.length === 0) return counts;
    // Still the old shape: read them whole — and still matching the filter,
    // which the server judges.
    const retry = await collection
      .find(
        { $and: [job.match ?? matchOf(spec, job.direction), { _id: { $in: stale } }] },
        readOptions,
      )
      .toArray();
    counts.skipped += stale.length - retry.length;
    if (retry.length === 0) return counts;
    if (round >= spec.maxConflictRetries) {
      counts.conflicts += retry.length;
      return counts;
    }
    counts.retried += retry.length;
    pending = retry;
  }
  return counts;
}

/**
 * The context of a `step` background migration: the database and client
 * (and, in a transaction or a dry run, the session), its last checkpoint,
 * and the deadline it should return by.
 */
function buildStepContext(job, { db, client, session, checkpoint, deadline, dryRun } = {}) {
  return {
    ...transformContext(job),
    db,
    client,
    checkpoint: checkpoint ?? null,
    deadline,
    ...(session ? { session } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
}

/** A step's result, validated: `{ checkpoint, done, processed?, migrated?, total? }` */
function readStepResult(result) {
  if (!isPlainObject(result) || typeof result.done !== 'boolean') {
    throw new BackgroundFailedError('step() must return { checkpoint, done } — done a boolean');
  }
  const checkpoint = result.checkpoint ?? null;
  if (bsonSize({ checkpoint }) > MAX_CHECKPOINT_BYTES) {
    throw new BackgroundFailedError(
      `step() returned a checkpoint larger than ${MAX_CHECKPOINT_BYTES / 1024} KiB — keep a cursor in it, not data`,
    );
  }
  const counters = {};
  for (const key of ['processed', 'migrated']) {
    if (Number.isSafeInteger(result[key]) && result[key] > 0) counters[key] = result[key];
  }
  return {
    checkpoint,
    done: result.done,
    counters,
    ...(Number.isSafeInteger(result.total) ? { total: result.total } : {}),
  };
}

/** Elapsed milliseconds from `start`, by the injected clock */
const since = (now, start) => now() - start;

/** Add `from` into `into`, key by key */
function addCounters(into, from) {
  for (const [key, value] of Object.entries(from)) {
    if (typeof value === 'number') into[key] = (into[key] ?? 0) + value;
  }
}

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
async function processPartition(job, ctx) {
  const { store, lease, partition, db, signal, throttle, readControl } = ctx;
  const now = ctx.now ?? Date.now;
  const spec = job.spec;
  const counters = {};
  let cursor = partition.cursor ?? {};
  for (;;) {
    if (signal?.aborted) return { outcome: 'stopped', counters };
    if (now() >= ctx.deadline) return { outcome: 'yielded', counters, cursor };
    const control = await readControl();
    const stop = controlOutcome(control, job, partition);
    if (stop) return { outcome: stop, counters };
    const batchSize = ctx.batchSize?.() ?? spec.batchSize;
    await throttle.beforeBatch({
      signal,
      generation: job.generation,
      partition: String(partition._id),
      batchSize,
    });
    const started = now();
    let docs;
    let next;
    let batchCounts;
    if (spec.mode === 'step') {
      const result = readStepResult(
        await (job.direction === 'revert' ? job.fns.revertStep : job.fns.step)(
          buildStepContext(job, {
            db,
            client: ctx.client,
            checkpoint: cursor.checkpoint,
            deadline: ctx.deadline,
          }),
        ),
      );
      next = result.done ? null : { checkpoint: result.checkpoint };
      batchCounts = { ...result.counters, batches: 1 };
      await store.checkpoint(lease, {
        cursor: next ?? { checkpoint: result.checkpoint },
        counters: batchCounts,
        done: result.done,
      });
    } else {
      const query = job.partitioner.batchQuery(partition.scope, cursor, {
        limit: batchSize,
        match: job.match,
        hint: job.hint,
      });
      docs = await db.collection(spec.collection).find(query.filter, query.options).toArray();
      const result = await applyBatch(job, docs, { db });
      next = job.partitioner.advance(cursor, docs, { limit: batchSize });
      batchCounts = {
        scanned: docs.length,
        migrated: result.migrated,
        skipped: result.skipped,
        conflicts: result.conflicts,
        retried: result.retried,
        failed: result.errors.length,
        batches: 1,
      };
      await store.checkpoint(lease, {
        cursor: next ?? cursor,
        counters: batchCounts,
        badIds: result.errors.map((entry) => entry.id),
        docErrors: result.errors.map(({ error, reason }) => ({ error, reason, at: new Date() })),
        done: next === null,
        ...(ctx.throttleState ? { throttle: ctx.throttleState() } : {}),
      });
      if (result.errors.length > 0) {
        const total = await store.countBadIds(job.name, job.generation);
        if (total > spec.maxDocumentErrors) {
          const error = new BackgroundFailedError(
            `Background migration ${job.name} failed: ${total} document(s) could not be ` +
              `migrated, more than maxDocumentErrors (${spec.maxDocumentErrors}) — last: ` +
              result.errors[result.errors.length - 1].error,
            {
              migration: job.name,
              failedDocuments: total,
              maxDocumentErrors: spec.maxDocumentErrors,
            },
          );
          addCounters(counters, batchCounts);
          return { outcome: 'failed', counters, error };
        }
      }
    }
    addCounters(counters, batchCounts);
    ctx.onBatch?.({ counters: batchCounts, latencyMs: since(now, started), batchSize });
    if (next === null) return { outcome: 'exhausted', counters };
    cursor = next;
  }
}

/** What the state's controls mean for a lane on this partition — `undefined`: go on */
function controlOutcome(control, job, partition) {
  if (control === null) return 'cancelled';
  if (control.status === 'paused') return 'paused';
  if (control.status === 'cancelled') return 'cancelled';
  if (control.status === 'failed') return 'failed';
  if (control.status !== 'running') return 'stale';
  if (control.generation !== job.generation || control.plan?.token !== partition.plan) {
    return 'stale';
  }
  return undefined;
}

module.exports = {
  DOCUMENT_ERRORS,
  applyBatch,
  buildStepContext,
  controlOutcome,
  directionOf,
  idKey,
  matchOf,
  processPartition,
  readStepResult,
  transformContext,
};
