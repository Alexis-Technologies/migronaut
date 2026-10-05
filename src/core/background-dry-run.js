const { ConfigInvalidError } = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { cloneDocument, stampedDiff } = require('../versioning/document.js');
const {
  applyBatch,
  idKey,
  matchOf,
  transformAll,
  transformContext,
} = require('./background-engine.js');
const { idRangePartitioner } = require('./background-partition.js');
const { runSandbox } = require('./background-sandbox.js');
const { toRelaxedEjson } = require('./bson-peer.js');
const { READ_OPTIONS } = require('./server-info.js');

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

/** `value` as relaxed EJSON — what a person (or `--json`) can read */
const ejson = (value) => {
  try {
    return toRelaxedEjson(value);
  } catch {
    return { $unserializable: true };
  }
};

function sampleSize({ sample, first }) {
  const n = first ?? sample ?? 5;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_SAMPLE) {
    throw new ConfigInvalidError(`The sample must be 1 to ${MAX_SAMPLE} documents`, { sample: n });
  }
  if (sample !== undefined && first !== undefined) {
    throw new ConfigInvalidError('Take either a random sample or the first documents, not both');
  }
  return n;
}

/** The job a dry run works with — no partition, no lease */
function dryJob(name, loaded, direction, logger) {
  return {
    name,
    spec: loaded.spec,
    fns: loaded.fns,
    direction,
    partitioner: idRangePartitioner,
    generation: 0,
    partitionId: 'dry-run',
    match: matchOf(loaded.spec, direction),
    logger,
  };
}

/**
 * Preview a declarative background migration on a sample. `deps`:
 * `{ db, client, topology, forbidden, logger }`; `loaded`: `{ spec, fns }`.
 */
async function previewSample(deps, name, loaded, options = {}) {
  const { spec } = loaded;
  if (spec.mode !== 'declarative') {
    throw new ConfigInvalidError(
      `${name} is a step background migration — dry-run it by steps, not on a sample`,
      { migration: name },
    );
  }
  const direction = options.direction === 'revert' ? 'revert' : 'forward';
  if (direction === 'revert' && !spec.reversible) {
    throw new ConfigInvalidError(`${name} declares no revert`, { migration: name });
  }
  const n = sampleSize(options);
  const job = dryJob(name, loaded, direction, deps.logger);
  const collection = deps.db.collection(spec.collection);
  const docs =
    options.first !== undefined
      ? await collection.find(job.match, { sort: { _id: 1 }, limit: n, ...READ_OPTIONS }).toArray()
      : await collection
          .aggregate([{ $match: job.match }, { $sample: { size: n } }], READ_OPTIONS)
          .toArray();
  const base = {
    mode: 'declarative',
    migration: name,
    direction,
    method: options.first !== undefined ? 'first' : 'sample',
    requested: n,
    found: docs.length,
  };
  if (!options.validate) {
    const rows = await transformRows(job, docs);
    return { ...base, ...tally(rows), documents: rows };
  }
  return { ...base, ...(await validateRows(deps, job, docs)) };
}

/** Each document before, and after its transformation as it would be written */
async function transformRows(job, docs) {
  const ctx = transformContext(job, { dryRun: true });
  const transformed = await transformAll(job, docs, ctx);
  const target = job.direction === 'revert' ? job.spec.from : job.spec.to;
  const rows = [];
  for (const { doc, next, error } of transformed) {
    const row = { _id: ejson(doc._id), before: ejson(doc) };
    if (error !== undefined) {
      row.error = errorText(error);
    } else {
      try {
        const update = stampedDiff(doc, next, job.spec, { to: target });
        row.change = ejson(update);
        row.after = ejson(applyLocally(doc, update));
      } catch (shapeError) {
        row.error = errorText(shapeError);
      }
    }
    rows.push(row);
  }
  return rows;
}

/** `doc` with a stamped operator update applied, top-level only — a preview, not the server */
function applyLocally(doc, update) {
  const out = cloneDocument(doc);
  for (const [key, value] of Object.entries(update.$set ?? {})) out[key] = value;
  for (const key of Object.keys(update.$unset ?? {})) delete out[key];
  for (const [key, value] of Object.entries(update.$inc ?? {})) out[key] = (out[key] ?? 0) + value;
  return out;
}

function tally(rows) {
  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.error === undefined) migrated += 1;
    else failed += 1;
  }
  return { migrated, failed };
}

/**
 * Each document through the real write path in the sandbox, one at a time.
 * A write error aborts the sandbox's transaction on the server — so the rest
 * go on in a fresh sandbox, one transaction per failure, not per document.
 */
async function validateRows(deps, job, docs) {
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
          const row = { _id: ejson(doc._id), before: ejson(doc) };
          const [failure] = result.errors;
          if (failure !== undefined) {
            row.error = failure.error;
            row.validation = 'failed';
          } else if (result.migrated === 1) {
            const stored = await handles.db
              .collection(job.spec.collection)
              .findOne({ _id: doc._id });
            row.after = ejson(stored);
            row.validation = 'ok';
          } else {
            row.validation = 'skipped';
          }
          rows.set(idKey(doc._id), row);
          done += 1;
          // A failed write ended the transaction: the rest go to a new sandbox.
          if (failure?.reason === 'write') return;
        }
      },
    );
    attempts += report.attempts;
    ops.push(...report.ops);
    refusals.push(...report.refusals);
    for (const document of report.documents) {
      if (document.collection !== job.spec.collection) sideEffects.push(document);
    }
    if (report.error !== undefined && done < remaining.length) {
      // The sandbox stopped on something else (a refusal, the deadline): say so on the next row.
      const doc = remaining[done];
      rows.set(idKey(doc._id), {
        _id: ejson(doc._id),
        before: ejson(doc),
        error: report.error,
        validation: 'failed',
      });
      done += 1;
    }
    remaining = remaining.slice(Math.max(1, done));
  }
  const documents = docs.map((doc) => rows.get(idKey(doc._id)));
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
}

module.exports = { MAX_SAMPLE, previewSample };
