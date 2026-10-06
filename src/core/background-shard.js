const { mapLimit } = require('../utils/concurrency.js');
const { sameValue } = require('../versioning/internal.js');
const {
  MAX_TIME_EXPIRED,
  SAMPLE_TIMEOUT_MS,
  largestFirst,
  sampleRequest,
  targetPartitions,
} = require('./background-partition.js');
const { loadBson } = require('./bson-peer.js');
const { READ_OPTIONS } = require('./server-info.js');
const { shardedVersionIndexKey } = require('./versioning-spec.js');

/**
 * The shard-aware partitioner: a sharded collection's documents split along
 * its shard key — a partition per run of adjacent chunks on one shard, so a
 * lane reads from (and, with targeted writes, writes to) one shard, and
 * `shardConcurrency` caps the lanes per shard (`group` = the shard).
 *
 * Its scope is `{ kind: 'key-range', min, max }`: two shard-key documents,
 * `min` inclusive, `max` exclusive, like a chunk's. A batch reads it through
 * the version index of a sharded collection (`{ __v, …shard key, _id }`,
 * converge's) with `min`/`max` — exact index bounds — plus, when both ends of
 * the first key field are finite and of one BSON type, a predicate on it
 * that lets the mongos target the owning shard — and, as a run ends at a
 * chunk boundary, the next chunk's (ARCHITECTURE §6.8: `min`/`max` alone are
 * broadcast, and a `$lt` is inclusive when the mongos picks shards). Writes
 * carry the shard key, so each goes to one shard.
 *
 * A ranged key keeps a keyset cursor (the last index tuple read). A hashed
 * key cannot — the hash of the last document is the server's to compute — so
 * it drains: every batch starts at the range's start, rewritten documents
 * leave it by themselves, and the few that stay (a conflict, a failed
 * document) are excluded by id, up to MAX_STUCK; past that the partition is
 * left to the next pass.
 *
 * Nothing here has to be exact, as with the `_id` partitioner: a gap is
 * found by the final count, an overlap is kept apart by the optimistic guard.
 */

/** Partitions a shard gets at most, whatever its lanes */
const PARTITIONS_PER_SHARD = 8;
/** Documents a draining partition steps over before it leaves them to the next pass */
const MAX_STUCK = 100;
/** Runs sampled at once while a plan is drawn (under the coordinator lock) */
const SAMPLE_CONCURRENCY = 4;
/** A run this many times larger than its sample is sampled collection-first */
const SAMPLE_FIRST_FACTOR = 20;

const HASH_MIN = -(2n ** 63n);
const HASH_END = 2n ** 63n;

const isMinKey = (value) => value?._bsontype === 'MinKey';
const isMaxKey = (value) => value?._bsontype === 'MaxKey';
const isBound = (value) => isMinKey(value) || isMaxKey(value);

/** A value's comparison class — two values of one class compare the way MQL's `$gte`/`$lt` do */
function classOf(value) {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'number':
    case 'bigint':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'bool';
    default:
      break;
  }
  if (value instanceof Date) return 'date';
  switch (value._bsontype) {
    case 'Int32':
    case 'Long':
    case 'Double':
    case 'Decimal128':
      return 'number';
    case 'ObjectId':
    case 'ObjectID':
      return 'objectId';
    case 'Timestamp':
      return 'timestamp';
    default:
      // Objects, arrays, binaries, MinKey/MaxKey: no predicate is drawn on them.
      return undefined;
  }
}

/** A value at a dotted path — the way an index reads it, a missing one as `null` */
function valueAt(doc, path) {
  let value = doc;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return null;
    value = value[part];
  }
  return value === undefined ? null : value;
}

/** The hashed field of a shard key, if it has one */
/**
 * The shard-key fields of a document as a write filter — next to the
 * optimistic filter, they send the write to the one shard that owns the
 * document (and keep it off orphans). `_id` is already in that filter.
 */
function shardKeyFilter(key, doc) {
  const filter = {};
  for (const field of Object.keys(key)) if (field !== '_id') filter[field] = valueAt(doc, field);
  return filter;
}

/**
 * The shard-key guard: a transform that changes a document's shard key is a
 * document error. Nothing else refuses it — with retryable writes the mongos
 * moves the document (ARCHITECTURE §6.8) — and moving documents between
 * shards is not what a background migration is for.
 */
function shardKeyGuard(key, prev, next) {
  const changed = [];
  for (const field of Object.keys(key)) {
    if (!sameKeyValue(valueAt(prev, field), valueAt(next, field))) changed.push(field);
  }
  if (changed.length === 0) return null;
  return {
    reason: 'shard-key-changed',
    fields: changed,
    message:
      `the transform changes the shard key (${changed.join(', ')}) — change a shard key with an ` +
      'ordinary migration in a transaction, or with reshardCollection',
  };
}

/**
 * Whether two shard-key values route the same: numbers by value whatever
 * their type (a Long 5 is an int 5 to a chunk, and to a hash), the rest
 * BSON-aware. A value it cannot prove equal counts as changed.
 */
function sameKeyValue(a, b) {
  if (classOf(a) === 'number' && classOf(b) === 'number') return numberText(a) === numberText(b);
  return sameValue(a, b);
}

const numberText = (value) =>
  typeof value === 'bigint' || value?._bsontype === 'Long' || value?._bsontype === 'Decimal128'
    ? value.toString()
    : String(Number(value));

/** Whether a plan's epoch is not the collection's any more — resharded, or its key refined */
function staleEpoch(planned, current) {
  if (!planned || !current) return false;
  if (bytesOf(planned.uuid) !== bytesOf(current.uuid)) return true;
  return JSON.stringify(planned.key) !== JSON.stringify(current.key);
}

/** A uuid's bytes as hex — the same for a `Binary` and a `UUID` of them */
function bytesOf(uuid) {
  return uuid?.buffer instanceof Uint8Array
    ? Buffer.from(uuid.buffer).toString('hex')
    : String(uuid);
}

/**
 * The `_id` partitioner on a sharded collection whose key is known but whose
 * version index does not carry it: reads stay broadcast, but writes are
 * targeted and the guard holds.
 */
function withShardKey(partitioner, key) {
  return Object.freeze({
    ...partitioner,
    writeFilter: (doc) => shardKeyFilter(key, doc),
    checkTransform: (prev, next) => shardKeyGuard(key, prev, next),
  });
}

function hashedFieldOf(key) {
  for (const [field, value] of Object.entries(key)) if (value === 'hashed') return field;
  return undefined;
}

/** A shard-key document with every field at MinKey (or MaxKey) */
function edge(fields, Bound) {
  const doc = {};
  for (const field of fields) doc[field] = new Bound();
  return doc;
}

/** Runs: maximal sequences of adjacent chunks owned by one shard, in key order */
function runsOf(chunks) {
  const runs = [];
  for (const chunk of chunks) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.shard === chunk.shard) {
      last.max = chunk.max;
      last.chunks += 1;
    } else {
      runs.push({ min: chunk.min, max: chunk.max, shard: chunk.shard, chunks: 1 });
    }
  }
  return runs;
}

/**
 * At most `limit` runs: neighbours merged in even blocks. A block that spans
 * shards has no group — its lane is capped by `maxParallel` alone.
 */
function capRuns(runs, limit) {
  if (runs.length <= limit) return runs;
  const size = Math.ceil(runs.length / limit);
  const merged = [];
  for (let start = 0; start < runs.length; start += size) {
    const end = Math.min(runs.length, start + size);
    let shard = runs[start].shard;
    let chunks = 0;
    for (let i = start; i < end; i++) {
      if (runs[i].shard !== shard) shard = undefined;
      chunks += runs[i].chunks;
    }
    merged.push({ min: runs[start].min, max: runs[end - 1].max, shard, chunks });
  }
  return merged;
}

/** A hash bound as a BigInt — MinKey and MaxKey at the ends of the 64-bit space */
function hashAt(value) {
  if (isMinKey(value)) return HASH_MIN;
  if (isMaxKey(value)) return HASH_END;
  if (typeof value === 'bigint') return value;
  if (value?._bsontype === 'Long') return value.toBigInt();
  return BigInt(Math.trunc(Number(value)));
}

/**
 * Split a run whose first key field is hashed by arithmetic: `parts` equal
 * slices of its hash range. The boundary documents carry MinKey after the
 * hash, so each slice starts before every document of its first hash.
 */
function splitHashed(run, fields, parts) {
  const [first, ...rest] = fields;
  const lo = hashAt(run.min[first]);
  const hi = hashAt(run.max[first]);
  if (hi - lo < BigInt(parts) * 2n) return [run];
  const { Long, MinKey } = loadBson();
  const step = (hi - lo) / BigInt(parts);
  const slices = [];
  let min = run.min;
  for (let i = 1; i < parts; i++) {
    const max = { [first]: Long.fromBigInt(lo + step * BigInt(i)), ...edge(rest, MinKey) };
    slices.push({ ...run, min, max });
    min = max;
  }
  slices.push({ ...run, min, max: run.max });
  return slices;
}

/**
 * Split a ranged run at quantiles of a sample of its shard-key tuples, sorted
 * by the server. Only tuples whose first field lies strictly inside the run
 * are sampled — each is then a valid boundary, whatever the other fields
 * hold. A hashed field further in the key is sampled as its hash, the value
 * the index orders by. A run far larger than its sample is sampled from the
 * collection first (a random cursor, `share` being the run's part of it) and
 * filtered after; a `$match` first would read every document of the run and
 * sort them all at random. Resolves to `{ pieces, degraded? }` — the run
 * whole when it cannot be split (bounds of two types, a sample too small),
 * and `degraded: 'sample-timeout'` when the sample ran out of time.
 */
async function splitSampled(collection, match, run, fields, key, parts, { total, share }) {
  const [first] = fields;
  const lo = run.min[first];
  const hi = run.max[first];
  const condition = {};
  if (!isMinKey(lo)) condition.$gt = lo;
  if (!isMaxKey(hi)) condition.$lt = hi;
  if (!isBound(lo) && !isBound(hi) && classOf(lo) !== classOf(hi)) return { pieces: [run] };
  const projection = { _id: 0 };
  const sort = {};
  for (const field of fields) {
    projection[field] = key[field] === 'hashed' ? { $toHashedIndexKey: `$${field}` } : 1;
    sort[field] = 1;
  }
  const filter = Object.keys(condition).length > 0 ? { [first]: condition } : {};
  const inRun = { $and: [match, filter] };
  const size = Math.min(10_000, 100 * parts);
  const sampleFirst = total !== undefined && total * share > SAMPLE_FIRST_FACTOR * size;
  const pipeline = sampleFirst
    ? [{ $sample: { size: sampleRequest(size, share, total) } }, { $match: inRun }]
    : [{ $match: inRun }, { $sample: { size } }];
  let sample;
  try {
    sample = await collection
      .aggregate([...pipeline, { $project: projection }, { $sort: sort }], {
        maxTimeMS: SAMPLE_TIMEOUT_MS,
        allowDiskUse: true,
        ...READ_OPTIONS,
        promoteLongs: false,
      })
      .toArray();
  } catch (error) {
    if (error?.code === MAX_TIME_EXPIRED) return { pieces: [run], degraded: 'sample-timeout' };
    throw error;
  }
  if (sample.length < parts) return { pieces: [run] };
  const slices = [];
  let min = run.min;
  let previous;
  for (let i = 1; i < parts; i++) {
    const at = sample[Math.floor((i * sample.length) / parts)];
    const max = {};
    for (const field of fields) max[field] = valueAt(at, field);
    if (previous !== undefined && sameTuple(previous, max, fields)) continue;
    slices.push({ ...run, min, max });
    min = max;
    previous = max;
  }
  slices.push({ ...run, min, max: run.max });
  return { pieces: slices };
}

function sameTuple(a, b, fields) {
  for (const field of fields) if (!sameValue(a[field], b[field])) return false;
  return true;
}

/**
 * The shard-aware partitioner of one sharded collection. `options`:
 * `{ key, field, source, readChunks }` — the shard key, the version field,
 * the version a batch reads (`0` reads the missing-or-null region and then
 * the `0` one), and how to read the chunks (`undefined` when config may not
 * be read: the plan then samples the whole key space, ungrouped).
 */
function createShardPartitioner({ key, field, source, readChunks, epoch }) {
  const fields = Object.keys(key);
  const hashed = hashedFieldOf(key);
  const drain = hashed !== undefined;
  const indexKey = shardedVersionIndexKey({ field }, key);
  const trailingId = '_id' in indexKey && !('_id' in key);
  const regions = source === 0 ? [null, 0] : [source];

  /** An index bound: the version region, a shard-key document, then `_id` */
  function bound(region, tuple, id) {
    const doc = { [field]: region };
    for (const name of fields) doc[name] = tuple[name];
    if (trailingId) doc._id = id;
    return doc;
  }

  /**
   * A predicate on the first key field that targets the owning shard — only
   * when both ends are finite and of one class: a one-sided or mixed-type
   * range would leave out every value MQL compares differently.
   */
  function target(scope) {
    const [first] = fields;
    if (first === hashed) return undefined;
    const lo = scope.min[first];
    const hi = scope.max[first];
    if (isBound(lo) || isBound(hi)) return undefined;
    const kind = classOf(lo);
    if (kind === undefined || kind !== classOf(hi)) return undefined;
    // The range ends before `max`: before its first field's value too, when
    // the rest of `max` is MinKey — `$lte` would draw in the next chunk's shard.
    let open = true;
    for (let i = 1; i < fields.length; i++) if (!isMinKey(scope.max[fields[i]])) open = false;
    return { [first]: open ? { $gte: lo, $lt: hi } : { $gte: lo, $lte: hi } };
  }

  async function plan({ collection, match, hint, maxParallel, settings, shardConcurrency = 1 }) {
    const aim = targetPartitions(settings, maxParallel);
    const cap = aim * settings.minPartitionDocs;
    const count = await collection.countDocuments(match, {
      limit: cap,
      ...(hint ? { hint } : {}),
      ...READ_OPTIONS,
    });
    const planned = epoch ? { uuid: epoch.uuid, key } : null;
    if (count === 0) return { epoch: planned, method: 'empty', estimate: 0, partitions: [] };
    const { MaxKey, MinKey } = loadBson();
    const chunks = await readChunks();
    const grouped = chunks !== undefined && chunks.length > 0;
    const allRuns = grouped ? runsOf(chunks) : undefined;
    const runs = grouped
      ? capRuns(allRuns, settings.maxPartitions)
      : [{ min: edge(fields, MinKey), max: edge(fields, MaxKey), shard: undefined, chunks: 1 }];
    // More runs than partitions allowed: blocks were merged across shards, and
    // a merged block has no shard to cap its lanes by.
    let ungrouped = false;
    if (grouped && runs.length < allRuns.length) {
      for (const run of runs) if (run.shard === undefined) ungrouped = true;
    }
    // A few partitions per lane: per shard when the lanes are capped per shard.
    const perShard = grouped
      ? Math.min(PARTITIONS_PER_SHARD, settings.overPartition * shardConcurrency, aim)
      : aim;
    const runsPerShard = new Map();
    let totalChunks = 0;
    for (const run of runs) {
      runsPerShard.set(run.shard, (runsPerShard.get(run.shard) ?? 0) + 1);
      totalChunks += run.chunks;
    }
    const budget = Math.max(runs.length, settings.maxPartitions);
    const wanted = Math.max(1, Math.min(aim, Math.ceil(count / settings.minPartitionDocs)));
    // The collection's size, for a run that is sampled collection-first.
    const total =
      typeof collection.estimatedDocumentCount === 'function'
        ? await collection.estimatedDocumentCount().catch(() => undefined)
        : undefined;
    // Runs are sampled a few at a time: one after another, a plan of many runs
    // would hold the coordinator lock for a sample timeout per run.
    const split = await mapLimit(runs, SAMPLE_CONCURRENCY, async (run) => {
      const parts = Math.min(
        Math.ceil(perShard / runsPerShard.get(run.shard)),
        Math.max(1, Math.floor(budget / runs.length)),
        wanted,
      );
      if (parts <= 1) return { pieces: [run] };
      if (fields[0] === hashed) return { pieces: splitHashed(run, fields, parts) };
      return splitSampled(collection, match, run, fields, key, parts, {
        total,
        share: run.chunks / totalChunks,
      });
    });
    const slices = [];
    let timedOut = false;
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const { pieces, degraded } = split[i];
      if (degraded !== undefined) timedOut = true;
      for (const piece of pieces) {
        slices.push({
          scope: { kind: 'key-range', min: piece.min, max: piece.max },
          ...(piece.shard !== undefined ? { group: piece.shard } : {}),
          estimate: Math.round((count * run.chunks) / totalChunks / pieces.length),
        });
      }
    }
    const degraded = timedOut ? 'sample-timeout' : ungrouped ? 'ungrouped' : undefined;
    return {
      epoch: planned,
      method: grouped ? 'chunks' : 'sampled',
      estimate: count,
      // The count stopped at its limit: there are at least that many.
      ...(count >= cap ? { atLeast: true } : {}),
      ...(degraded !== undefined ? { degraded } : {}),
      partitions: largestFirst(slices),
    };
  }

  /** The batch query of a key range: its index bounds, the targeting predicate, the cursor */
  function batchQuery(scope, cursor, { limit, match, hint }) {
    const { MinKey } = loadBson();
    const region = regions[cursor?.region ?? 0];
    const conditions = [match];
    const targeting = target(scope);
    if (targeting) conditions.push(targeting);
    let min = bound(region, scope.min, new MinKey());
    if (cursor?.tuple !== undefined) {
      // Inclusive: the last tuple read is the start — and its document, if it
      // is still there, is stepped over by id.
      min = bound(region, cursor.tuple, cursor.tuple._id);
      conditions.push({ _id: { $ne: cursor.tuple._id } });
    }
    if (cursor?.stuck?.length > 0) conditions.push({ _id: { $nin: cursor.stuck } });
    return {
      filter: { $and: conditions },
      options: {
        hint: hint ?? indexKey,
        min,
        max: bound(region, scope.max, new MinKey()),
        limit,
        // Through a mongos, several shards answer: sorted, their results merge
        // in index order — which a keyset needs. A hashed key cannot be sorted on.
        ...(drain ? {} : { sort: sortOf(indexKey) }),
        ...READ_OPTIONS,
      },
    };
  }

  /**
   * The cursor after a batch, or `null` once the range is done. `left`: the
   * ids of documents the batch read but did not rewrite — a draining range
   * steps over them from now on.
   */
  function advance(cursor, docs, { limit, left = [] }) {
    const position = cursor?.region ?? 0;
    if (docs.length < limit) {
      return position + 1 < regions.length ? { region: position + 1 } : null;
    }
    return past(cursor, docs, { left });
  }

  /** The cursor just past `docs` — where a batch cut short (or a document stepped over) ends */
  function past(cursor, docs, { left } = {}) {
    const position = cursor?.region ?? 0;
    if (drain) {
      const stuck = [...(cursor?.stuck ?? []), ...(left ?? docs.map((doc) => doc._id))];
      if (stuck.length > MAX_STUCK) {
        return position + 1 < regions.length ? { region: position + 1 } : null;
      }
      return { region: position, stuck };
    }
    const last = docs[docs.length - 1];
    const tuple = { _id: last._id };
    for (const name of fields) tuple[name] = valueAt(last, name);
    return { region: position, tuple };
  }

  return Object.freeze({
    id: 'shard',
    key,
    indexKey,
    plan,
    batchQuery,
    advance,
    past,
    writeFilter: (doc) => shardKeyFilter(key, doc),
    checkTransform: (prev, next) => shardKeyGuard(key, prev, next),
    /** A plan made for another epoch: resharded, or its key refined since */
    stale: (planned) => staleEpoch(planned, epoch ? { uuid: epoch.uuid, key } : undefined),
  });
}

/** A sort on an index key — every field ascending as the index stores it */
function sortOf(indexKey) {
  const sort = {};
  for (const [name, value] of Object.entries(indexKey)) sort[name] = value === -1 ? -1 : 1;
  return sort;
}

module.exports = {
  MAX_STUCK,
  PARTITIONS_PER_SHARD,
  capRuns,
  classOf,
  createShardPartitioner,
  hashAt,
  runsOf,
  shardKeyFilter,
  shardKeyGuard,
  staleEpoch,
  withShardKey,
  splitHashed,
  valueAt,
};
