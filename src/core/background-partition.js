const { mapLimit } = require('../utils/concurrency.js');
const { sameValue } = require('../versioning/internal.js');
const { ID_BRACKETS, bracketOfType, keysetFilter, scopeFilter } = require('./background-spec.js');
const { READ_CONCURRENCY, READ_OPTIONS } = require('./server-info.js');

/**
 * The default partitioner: a background migration's documents split into
 * `_id` ranges, so several lanes can work one collection at once.
 *
 * A partitioner has one job — spread the work — and nothing rests on it being
 * exact: a document no range covers is found by the final count of what is
 * left and picked up by the next pass, and two lanes that meet over a document
 * are kept apart by the optimistic guard on every write. So the planner may
 * sample, round and degrade freely; it only has to stay cheap.
 *
 * Every partitioner has the same shape (the shard-aware one, D1, too):
 * `{ id, plan(ctx), writeFilter(prev), checkTransform(prev, next), stale(ctx, epoch) }`.
 */

/** Server error: the operation ran out of its `maxTimeMS` */
const MAX_TIME_EXPIRED = 50;

/** How long the sample may take before the plan falls back to one partition per bracket */
const SAMPLE_TIMEOUT_MS = 30_000;

/** Ids sampled at most, whatever the settings say */
const MAX_SAMPLE = 100_000;

/** The number of partitions to aim for: one per lane with no parallelism, a few per lane otherwise */
function targetPartitions(settings, maxParallel) {
  if (maxParallel === 1) return 1;
  const { overPartition, maxPartitions } = settings;
  return Math.max(1, Math.min(overPartition * maxParallel, maxPartitions));
}

const withHint = (hint) => (hint === undefined ? {} : { hint });

/**
 * The brackets the matched documents' `_id`s fall in — one indexed `findOne`
 * each (`_id` is the second key of the version index), no admin rights.
 */
async function presentBrackets(collection, match, hint) {
  const found = await mapLimit(ID_BRACKETS, READ_CONCURRENCY, async (bracket) => {
    const doc = await collection.findOne(
      { $and: [match, { _id: { $type: bracket.aliases } }] },
      { projection: { _id: 1 }, ...withHint(hint), ...READ_OPTIONS },
    );
    return doc === null ? null : bracket.name;
  });
  const names = [];
  for (const name of found) if (name !== null) names.push(name);
  return names;
}

/**
 * A sorted sample of the matched `_id`s with their `$type`: the server sorts
 * them (JavaScript cannot compare BSON across types the way the server does).
 * A large match samples the collection first (a random cursor) and filters
 * after, oversampling by how little of it matches; a small one filters first.
 */
async function sampleIds(collection, match, { size, large, ratio, hint, maxTimeMS }) {
  const project = { $project: { _id: 1, t: { $type: '$_id' } } };
  const sort = { $sort: { _id: 1 } };
  const pipeline = large
    ? [
        { $sample: { size: Math.min(MAX_SAMPLE, Math.ceil(size / Math.max(ratio, 0.01))) } },
        { $match: match },
        project,
        sort,
      ]
    : [{ $match: match }, { $sample: { size } }, project, sort];
  return collection
    .aggregate(pipeline, {
      maxTimeMS,
      allowDiskUse: true,
      ...(large ? {} : withHint(hint)),
      ...READ_OPTIONS,
    })
    .toArray();
}

/**
 * Cut one bracket's sorted sample into `parts` ranges: boundaries at
 * `sample[floor(i·m/parts)]`, duplicates dropped, the outer ranges open-ended.
 * Returns `[{ scope, count }]` — `count` being the samples the range holds.
 */
function sliceBracket(bracket, ids, parts) {
  if (parts <= 1 || ids.length < 2) {
    return [{ scope: { kind: 'id-range', bracket }, count: ids.length }];
  }
  const bounds = [];
  for (let i = 1; i < parts; i++) {
    const position = Math.floor((i * ids.length) / parts);
    const candidate = ids[position];
    const previous = bounds.length > 0 ? bounds[bounds.length - 1].id : ids[0];
    // A boundary equal to the one before (or to the very first id) would
    // make an empty range — skip it.
    if (!sameValue(candidate, previous)) bounds.push({ id: candidate, position });
  }
  const ranges = [];
  let start = 0;
  let lower;
  for (const bound of bounds) {
    ranges.push({
      scope: {
        kind: 'id-range',
        bracket,
        ...(lower !== undefined ? { gte: lower } : {}),
        lt: bound.id,
      },
      count: bound.position - start,
    });
    lower = bound.id;
    start = bound.position;
  }
  ranges.push({
    scope: { kind: 'id-range', bracket, ...(lower !== undefined ? { gte: lower } : {}) },
    count: ids.length - start,
  });
  return ranges;
}

/** One partition per bracket present, no bounds — the plan when sampling is not worth it */
const perBracket = (brackets, estimate) =>
  brackets.map((bracket) => ({
    scope: { kind: 'id-range', bracket },
    estimate: Math.round(estimate / brackets.length),
  }));

/** Largest first: a lane starts on the work that would otherwise finish last */
function largestFirst(partitions) {
  return partitions.sort((a, b) => b.estimate - a.estimate);
}

/**
 * Plan the partitions of one pass. `ctx`:
 * `{ collection, match, hint?, maxParallel, settings: spec.partitions, maxTimeMS? }`.
 * Returns `{ epoch, method, estimate, partitions: [{ scope, estimate }], degraded? }`
 * — `method` says how it was planned (`empty`, `single`, `brackets`,
 * `match-first`, `sample-first`), `degraded: 'sample-timeout'` that the sample
 * ran out of time.
 */
async function planIdRanges({ collection, match, hint, maxParallel, settings, maxTimeMS }) {
  const target = targetPartitions(settings, maxParallel);
  const cap = target * settings.minPartitionDocs;
  const count = await collection.countDocuments(match, {
    limit: cap,
    ...withHint(hint),
    ...READ_OPTIONS,
  });
  if (count === 0) return { epoch: null, method: 'empty', estimate: 0, partitions: [] };
  const parts = Math.max(1, Math.min(target, Math.ceil(count / settings.minPartitionDocs)));
  const brackets = await presentBrackets(collection, match, hint);
  if (brackets.length === 0) {
    // Matched a moment ago, gone now — the next pass will know.
    return { epoch: null, method: 'empty', estimate: 0, partitions: [] };
  }
  if (parts === 1) {
    return {
      epoch: null,
      method: brackets.length === 1 ? 'single' : 'brackets',
      estimate: count,
      partitions: perBracket(brackets, count),
    };
  }

  const large = count >= cap;
  let total = count;
  let ratio = 1;
  if (large) {
    total = Math.max(count, await collection.estimatedDocumentCount());
    ratio = count / total;
  }
  const size = Math.min(settings.sampleSize, 100 * parts);
  let sample;
  try {
    sample = await sampleIds(collection, match, {
      size,
      large,
      ratio,
      hint,
      maxTimeMS: maxTimeMS ?? SAMPLE_TIMEOUT_MS,
    });
  } catch (error) {
    if (error?.code !== MAX_TIME_EXPIRED) throw error;
    return {
      epoch: null,
      method: 'brackets',
      estimate: count,
      degraded: 'sample-timeout',
      partitions: perBracket(brackets, count),
    };
  }
  // How many documents match, as far as the sample can tell: the bounded
  // count when it was not capped, the matched share of the sampled ones when
  // it was.
  const requested = large ? Math.min(MAX_SAMPLE, Math.ceil(size / Math.max(ratio, 0.01))) : 0;
  const estimate = large
    ? Math.max(count, Math.round(total * Math.min(1, sample.length / requested)))
    : count;

  // The sample grouped by bracket, in server order — it arrives sorted.
  const groups = new Map();
  for (const { _id: id, t } of sample) {
    const bracket = bracketOfType(t);
    if (!groups.has(bracket)) groups.set(bracket, []);
    groups.get(bracket).push(id);
  }
  const partitions = [];
  const sampled = Math.max(1, sample.length);
  const present = new Set(brackets);
  for (const bracket of ID_BRACKETS) {
    const ids = groups.get(bracket.name);
    if (ids === undefined) {
      // In the collection but not in the sample: one open partition keeps it covered.
      if (present.has(bracket.name)) {
        partitions.push({ scope: { kind: 'id-range', bracket: bracket.name }, estimate: 0 });
      }
      continue;
    }
    const share = Math.max(1, Math.round((parts * ids.length) / sampled));
    for (const range of sliceBracket(bracket.name, ids, bracket.splittable ? share : 1)) {
      partitions.push({
        scope: range.scope,
        estimate: Math.round((estimate * range.count) / sampled),
      });
    }
  }
  return {
    epoch: null,
    method: large ? 'sample-first' : 'match-first',
    estimate,
    partitions: largestFirst(partitions),
  };
}

/**
 * The batch query of an `_id`-range partition: its scope and the keyset after
 * the last id, sorted by `_id` through the version index.
 */
function idRangeBatchQuery(scope, cursor, { limit, match, hint }) {
  const conditions = [match, scopeFilter(scope)];
  if (cursor?.lastId !== undefined) conditions.push(keysetFilter(cursor.lastId));
  return {
    filter: { $and: conditions },
    options: { sort: { _id: 1 }, limit, ...withHint(hint), ...READ_OPTIONS },
  };
}

/** The cursor after a batch: the last id read — `null` when the partition is done */
function idRangeAdvance(cursor, docs, { limit }) {
  if (docs.length < limit) return null;
  return { ...cursor, lastId: docs[docs.length - 1]._id };
}

const idRangePartitioner = Object.freeze({
  id: 'id',
  plan: planIdRanges,
  batchQuery: idRangeBatchQuery,
  advance: idRangeAdvance,
  /** Nothing to add to the optimistic filter — `_id` is already in it */
  writeFilter: () => ({}),
  /** Every transformation is fine: `_id` is checked by stampedDiff itself */
  checkTransform: () => null,
  /** An `_id` range never goes stale */
  stale: () => false,
});

module.exports = {
  MAX_TIME_EXPIRED,
  idRangePartitioner,
  sliceBracket,
  targetPartitions,
};
