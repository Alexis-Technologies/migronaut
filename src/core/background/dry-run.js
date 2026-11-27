const { ConfigInvalidError } = require('../../errors/index.js');
const { formatError } = require('../../utils/error.js');
const { cloneDocument, buildStampedDiff } = require('../../versioning/document.js');
const {
  applyBatch,
  buildStepContext,
  toIdKey,
  matchOf,
  readStepResult,
  transformAll,
  transformContext,
} = require('./engine.js');
const {
  MAX_TIME_EXPIRED,
  SAMPLE_TIMEOUT_MS,
  idRangePartitioner,
  sampleRequest,
} = require('./partition.js');
const { runSandbox } = require('./sandbox.js');
const { withShardKey } = require('./shard.js');
const { toRelaxedEjson } = require('./bson-peer.js');
const { createBackgroundLogs } = require('../migration-logger.js');
const { READ_OPTIONS } = require('../server-info.js');

/**
 * Dry runs of a background migration — what it would do, on real documents,
 * with nothing written. Works for a file that is not registered yet: the
 * point is to look before `up`.
 *
 * - On a sample (`$sample`, or the `first` n by `_id`): each document before
 *   and after its transformation — the transformation alone.
 * - With `validate`: the real write path (`applyBatch` — the guarded write,
 *   the diff, the side writes) inside the always-aborted sandbox, so what
 *   comes back is what the server would have stored, and what the validator
 *   or a unique index would have refused.
 *
 * Nothing here logs a document: they are the application's data.
 */

const MAX_SAMPLE = 1000;

/** A match of this many documents or more is sampled collection-first — see sampleDocuments */
const MATCH_FIRST_CAP = 20_000;

/**
 * Each document through the real write path in the sandbox, one at a time.
 * A write error aborts the sandbox's transaction on the server — so the rest
 * go on in a fresh sandbox, one transaction per failure, not per document.
 */
/** The longest a sandbox runs — under the server's 60-second transaction limit */
const MAX_DEADLINE_MS = 50_000;

const MAX_STEPS = 50;

/** `value` as relaxed EJSON — what a person (or `--json`) can read */
const toEjson = (value) => {
  try {
    return toRelaxedEjson(value);
  } catch {
    return { $unserializable: true };
  }
};

const sampleSize = ({ sample, first }) => {
  const count = first ?? sample ?? 5;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SAMPLE) {
    throw new ConfigInvalidError(`The sample must be 1 to ${MAX_SAMPLE} documents`, {
      context: { sample: count },
    });
  }
  if (sample !== undefined && first !== undefined) {
    throw new ConfigInvalidError('Take either a random sample or the first documents, not both');
  }
  return count;
};

/**
 * `ctx.logger` in a dry run: the lines say `dryRun: true`, and nothing is
 * emitted — a preview's logs are not the application's to keep.
 */
const createDryLogs = (logger) => createBackgroundLogs({ sink: logger, dryRun: true });

/**
 * The partitioner a dry run judges a transformation by: on a sharded
 * collection whose key can be read, the one that guards it — a real run
 * refuses a transformation that changes the shard key (`shard-key-changed`),
 * and a preview that said nothing of it would promise what `up` cannot do.
 */
const chooseDryPartitioner = async (deps, collection) => {
  if (typeof deps.shardKeyOf !== 'function' || (await deps.topology()) !== 'sharded') {
    return idRangePartitioner;
  }
  const sharding = await deps.shardKeyOf(collection);
  return sharding ? withShardKey(idRangePartitioner, sharding.key) : idRangePartitioner;
};

/** The job a dry run works with — no partition, no lease */
const buildDryJob = (name, loaded, direction, logger, partitioner) => {
  return {
    name,
    spec: loaded.spec,
    fns: loaded.fns,
    direction,
    partitioner,
    generation: 0,
    partitionId: 'dry-run',
    match: matchOf(loaded.spec, direction),
    logger,
    logs: createDryLogs(logger),
  };
};

/**
 * Whether a collection is sharded, for the sandbox — asked only behind a
 * mongos; a key that cannot be read is left to the server to judge.
 */
const createShardedCheck = (deps) => {
  return async (name) => {
    return (await deps.topology()) === 'sharded' && Boolean(await deps.shardKeyOf?.(name));
  };
};

/** The first `n` matched documents by `_id` */
const readFirstDocuments = (collection, match, count, extra = {}) => {
  return collection
    .find(match, { sort: { _id: 1 }, limit: count, ...extra, ...READ_OPTIONS })
    .toArray();
};

/**
 * `n` matched documents at random, at a cost that follows `n` rather than the
 * collection. `$match` then `$sample` reads every matched document and sorts
 * them all at random: fine for thousands, a scan and a sort of a production
 * collection when most of it still holds the old shape — which is when a dry
 * run is asked for. Past `MATCH_FIRST_CAP` matches the collection is sampled
 * first (a random cursor, oversampled by how little of it matches) and
 * filtered after, the way the partitioner plans; a sample that came back
 * short is taken match-first after all. Every read is time-boxed: out of
 * time, the first `n` by `_id` stand in — `{ docs, degraded }`.
 */
const sampleDocuments = async (collection, match, wanted) => {
  const options = { maxTimeMS: SAMPLE_TIMEOUT_MS, ...READ_OPTIONS };
  const matchFirst = () => {
    return collection
      .aggregate([{ $match: match }, { $sample: { size: wanted } }], options)
      .toArray();
  };
  try {
    const count = await collection.countDocuments(match, { limit: MATCH_FIRST_CAP, ...options });
    if (count < MATCH_FIRST_CAP) return { docs: await matchFirst() };
    const total = Math.max(count, await collection.estimatedDocumentCount());
    const size = sampleRequest(wanted, count / total, total);
    const docs = await collection
      .aggregate([{ $sample: { size } }, { $match: match }, { $limit: wanted }], options)
      .toArray();
    return { docs: docs.length < wanted ? await matchFirst() : docs };
  } catch (error) {
    if (error?.code !== MAX_TIME_EXPIRED) throw error;
    return {
      docs: await readFirstDocuments(collection, match, wanted, { maxTimeMS: SAMPLE_TIMEOUT_MS }),
      degraded: 'sample-timeout',
    };
  }
};

/**
 * Preview a declarative background migration on a sample. `deps`:
 * `{ db, client, topology, forbidden, logger, shardKeyOf? }`; `loaded`: `{ spec, fns }`.
 */
const previewSample = async (deps, name, loaded, options = {}) => {
  const { spec } = loaded;
  if (spec.mode !== 'declarative') {
    throw new ConfigInvalidError(
      `${name} is a step background migration — dry-run it by steps, not on a sample`,
      { context: { migration: name } },
    );
  }
  const direction = options.direction === 'revert' ? 'revert' : 'forward';
  if (direction === 'revert' && !spec.reversible) {
    throw new ConfigInvalidError(`${name} declares no revert`, { context: { migration: name } });
  }
  const count = sampleSize(options);
  const partitioner = await chooseDryPartitioner(deps, spec.collection);
  const job = buildDryJob(name, loaded, direction, deps.logger, partitioner);
  const collection = deps.db.collection(spec.collection);
  const { docs, degraded } =
    options.first !== undefined
      ? { docs: await readFirstDocuments(collection, job.match, count) }
      : await sampleDocuments(collection, job.match, count);
  const base = {
    mode: 'declarative',
    migration: name,
    direction,
    // A sample that ran out of time is the first documents instead, and says so.
    method: options.first !== undefined || degraded !== undefined ? 'first' : 'sample',
    ...(degraded !== undefined ? { degraded } : {}),
    requested: count,
    found: docs.length,
  };
  if (!options.validate) {
    const rows = await transformRows(job, docs);
    return { ...base, ...tally(rows), documents: rows };
  }
  return {
    ...base,
    ...(await validateRows(deps, job, docs, { deadlineMs: resolveDeadline(options) })),
  };
};

/** Each document before, and after its transformation as it would be written */
const transformRows = async (job, docs) => {
  const ctx = transformContext(job, { dryRun: true });
  const transformed = await transformAll(job, docs, ctx);
  const target = job.direction === 'revert' ? job.spec.from : job.spec.to;
  const rows = [];
  for (const { doc, next, error } of transformed) {
    const row = { _id: toEjson(doc._id), before: toEjson(doc) };
    // What the write path would refuse before it wrote: a changed shard key.
    const refused = error === null ? job.partitioner.checkTransform(doc, next) : null;
    if (error !== null) {
      row.error = formatError(error);
    } else if (refused) {
      row.error = refused.message;
    } else {
      try {
        const update = buildStampedDiff(doc, next, job.spec, { to: target });
        row.change = toEjson(update);
        row.after = toEjson(applyLocally(doc, update));
      } catch (shapeError) {
        row.error = formatError(shapeError);
      }
    }
    rows.push(row);
  }
  return rows;
};

/** `doc` with a stamped operator update applied, top-level only — a preview, not the server */
const applyLocally = (doc, update) => {
  const out = cloneDocument(doc);
  const set = update.$set ?? {};
  const setKeys = Object.keys(set);
  for (let i = 0; i < setKeys.length; i++) out[setKeys[i]] = set[setKeys[i]];
  for (const key of Object.keys(update.$unset ?? {})) delete out[key];
  const inc = update.$inc ?? {};
  const incKeys = Object.keys(inc);
  for (let i = 0; i < incKeys.length; i++) {
    const key = incKeys[i];
    out[key] = (out[key] ?? 0) + inc[key];
  }
  return out;
};

const tally = (rows) => {
  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.error === undefined) migrated += 1;
    else failed += 1;
  }
  return { migrated, failed };
};

/** `deadlineMs`, checked: 1 to 50 000 (the default) */
const resolveDeadline = (options) => {
  const deadlineMs = options.deadlineMs ?? MAX_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) {
    throw new ConfigInvalidError(`deadlineMs must be an integer from 1 to ${MAX_DEADLINE_MS}`, {
      context: { deadlineMs },
    });
  }
  return deadlineMs;
};

const validateRows = async (deps, job, docs, { deadlineMs } = {}) => {
  const rows = new Map();
  const ops = [];
  const refusals = [];
  const sideEffects = [];
  let remaining = docs;
  let attempts = 0;
  while (remaining.length > 0) {
    let done = 0;
    const report = await runSandbox(
      {
        client: deps.client,
        db: deps.db,
        forbidden: deps.forbidden,
        topology: await deps.topology(),
        isSharded: createShardedCheck(deps),
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      },
      async (handles) => {
        for (const doc of remaining) {
          const result = await applyBatch(job, [doc], {
            db: handles.db,
            bare: true,
            ctxExtra: {
              db: handles.db,
              client: handles.client,
              session: handles.session,
              dryRun: true,
            },
          });
          const row = { _id: toEjson(doc._id), before: toEjson(doc) };
          const failure = result.errors[0];
          if (failure !== undefined) {
            row.error = failure.error;
            row.validation = 'failed';
          } else if (result.migrated === 1) {
            const stored = await handles.db
              .collection(job.spec.collection)
              .findOne({ _id: doc._id });
            row.after = toEjson(stored);
            row.validation = 'ok';
          } else {
            row.validation = 'skipped';
          }
          rows.set(toIdKey(doc._id), row);
          done += 1;
          // A failed write ended the transaction: the rest go to a new sandbox.
          if (failure?.reason === 'write') return;
        }
      },
    );
    attempts += report.attempts;
    for (let i = 0; i < report.ops.length; i++) ops.push(report.ops[i]);
    for (let i = 0; i < report.refusals.length; i++) refusals.push(report.refusals[i]);
    for (const document of report.documents) {
      if (document.collection !== job.spec.collection) sideEffects.push(document);
    }
    const stopped =
      report.error ??
      (report.stoppedBy === 'deadline' ? 'the dry run reached its deadline' : undefined);
    if (stopped !== undefined && done < remaining.length) {
      // The sandbox stopped on something else (a refusal, the deadline): say so on the next row.
      const doc = remaining[done];
      rows.set(toIdKey(doc._id), {
        _id: toEjson(doc._id),
        before: toEjson(doc),
        error: stopped,
        validation: 'failed',
      });
      done += 1;
    }
    remaining = remaining.slice(Math.max(1, done));
  }
  const documents = [];
  for (let i = 0; i < docs.length; i++) documents.push(rows.get(toIdKey(docs[i]._id)));
  return {
    validated: true,
    aborted: true,
    ...tally(documents),
    documents,
    ops,
    refusals,
    sideEffects,
    attempts,
  };
};

/**
 * Dry-run a step migration: up to `steps` calls of `step` in one sandbox —
 * one transaction, always aborted — each handed the checkpoint the one
 * before returned, so a step sees what the earlier ones wrote. It starts
 * from the checkpoint the background migration is at (`checkpoint`), or
 * from none (`fromStart`, or not registered). No lock, no lease, no state.
 */
const previewSteps = async (deps, name, loaded, options = {}) => {
  const { spec, fns } = loaded;
  const direction = options.direction === 'revert' ? 'revert' : 'forward';
  const runStep = direction === 'revert' ? fns.revertStep : fns.step;
  if (typeof runStep !== 'function') {
    throw new ConfigInvalidError(`${name} declares no revertStep`, {
      context: { migration: name },
    });
  }
  if (options.validate || options.sample !== undefined || options.first !== undefined) {
    throw new ConfigInvalidError(
      `${name} is a step background migration — dry-run it by steps, not on a sample`,
      { context: { migration: name } },
    );
  }
  const steps = options.steps ?? 1;
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_STEPS) {
    throw new ConfigInvalidError(`steps must be 1 to ${MAX_STEPS}`, { context: { steps } });
  }
  const job = {
    name,
    spec,
    fns,
    direction,
    generation: 0,
    partitionId: 'dry-run',
    logger: deps.logger,
    logs: createDryLogs(deps.logger),
  };
  const log = [];
  let stoppedBy = 'steps';
  const deadlineMs = resolveDeadline(options);
  const report = await runSandbox(
    {
      client: deps.client,
      db: deps.db,
      forbidden: deps.forbidden,
      topology: await deps.topology(),
      isSharded: createShardedCheck(deps),
      deadlineMs,
      ...(options.maxDocuments !== undefined ? { maxDocuments: options.maxDocuments } : {}),
    },
    async (handles) => {
      let checkpoint = options.fromStart ? null : (options.checkpoint ?? null);
      log.length = 0;
      for (let step = 1; step <= steps; step++) {
        handles.nextStep();
        const entry = { step, checkpointIn: toEjson(checkpoint) };
        log.push(entry);
        const ctx = {
          ...buildStepContext(job, {
            db: handles.db,
            client: handles.client,
            session: handles.session,
            checkpoint,
            deadline: Date.now() + deadlineMs,
            dryRun: true,
          }),
          mongoose: handles.mongoose,
        };
        let result = null;
        try {
          result = readStepResult(await runStep(ctx));
        } catch (error) {
          entry.error = formatError(error);
          throw error;
        }
        entry.checkpointOut = toEjson(result.checkpoint);
        entry.done = result.done;
        if (result.counters.processed !== undefined) entry.processed = result.counters.processed;
        if (result.counters.migrated !== undefined) entry.migrated = result.counters.migrated;
        if (result.done) {
          stoppedBy = 'done';
          return;
        }
        checkpoint = result.checkpoint;
      }
    },
  );
  const { value: _value, ...rest } = report;
  return {
    mode: 'step',
    migration: name,
    direction,
    ...rest,
    stoppedBy: report.stoppedBy ?? stoppedBy,
    steps: log,
  };
};

module.exports = {
  MAX_SAMPLE,
  MATCH_FIRST_CAP,
  MAX_STEPS,
  sampleDocuments,
  previewSample,
  previewSteps,
};
