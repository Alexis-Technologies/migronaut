const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { Decimal128, Int32, Long, MaxKey, MinKey, ObjectId } = require('mongodb');
const { idRangePartitioner } = require('../../src/core/background-partition.js');
const {
  MAX_STUCK,
  capRuns,
  classOf,
  createShardPartitioner,
  hashAt,
  runsOf,
  shardKeyFilter,
  shardKeyGuard,
  splitHashed,
  staleEpoch,
  valueAt,
  withShardKey,
} = require('../../src/core/background-shard.js');
const { partitionerFor, probeHint } = require('../../src/core/background.js');

const MIN = new MinKey();
const MAX = new MaxKey();
const chunk = (min, max, shard) => ({ min: { k: min }, max: { k: max }, shard });
const settings = (overrides = {}) => ({
  overPartition: 4,
  maxPartitions: 256,
  minPartitionDocs: 10,
  sampleSize: 1000,
  ...overrides,
});

describe('background-shard helpers', () => {
  it('should merge adjacent chunks of one shard into runs, in key order', () => {
    const runs = runsOf([
      chunk(MIN, 10, 's1'),
      chunk(10, 20, 's1'),
      chunk(20, 30, 's2'),
      chunk(30, MAX, 's1'),
    ]);
    assert.deepStrictEqual(
      runs.map((run) => [run.min.k, run.max.k, run.shard, run.chunks]),
      [
        [MIN, 20, 's1', 2],
        [20, 30, 's2', 1],
        [30, MAX, 's1', 1],
      ],
    );
  });

  it('should cap runs by merging neighbours, dropping the group across shards', () => {
    const runs = runsOf([
      chunk(MIN, 1, 's1'),
      chunk(1, 2, 's2'),
      chunk(2, 3, 's1'),
      chunk(3, MAX, 's2'),
    ]);
    const capped = capRuns(runs, 2);
    assert.strictEqual(capped.length, 2);
    assert.strictEqual(capped[0].shard, undefined);
    assert.strictEqual(capped[0].min.k, MIN);
    assert.strictEqual(capped[1].max.k, MAX);
    assert.strictEqual(capped[0].chunks + capped[1].chunks, 4);
    assert.strictEqual(capRuns(runs, 10), runs);
  });

  it('should class values the way MQL compares them', () => {
    for (const [value, kind] of [
      [1, 'number'],
      [new Int32(1), 'number'],
      [Long.fromNumber(2), 'number'],
      [Decimal128.fromString('1.5'), 'number'],
      ['a', 'string'],
      [new Date(), 'date'],
      [new ObjectId(), 'objectId'],
      [true, 'bool'],
      [null, 'null'],
      [{ a: 1 }, undefined],
      [MIN, undefined],
    ]) {
      assert.strictEqual(classOf(value), kind, String(value));
    }
  });

  it('should read a dotted path, missing as null', () => {
    assert.strictEqual(valueAt({ a: { b: 3 } }, 'a.b'), 3);
    assert.strictEqual(valueAt({ a: 1 }, 'a.b'), null);
    assert.strictEqual(valueAt({}, 'a'), null);
  });

  it('should split a hashed run into equal slices of the 64-bit space', () => {
    assert.strictEqual(hashAt(MIN), -(2n ** 63n));
    assert.strictEqual(hashAt(MAX), 2n ** 63n);
    assert.strictEqual(hashAt(Long.fromBigInt(5n)), 5n);
    assert.strictEqual(hashAt(7), 7n);
    const run = { min: { h: MIN, r: MIN }, max: { h: MAX, r: MAX }, shard: 's1', chunks: 1 };
    const slices = splitHashed(run, ['h', 'r'], 4);
    assert.strictEqual(slices.length, 4);
    assert.strictEqual(slices[0].min, run.min);
    assert.strictEqual(slices[3].max, run.max);
    assert.strictEqual(slices[1].min.h.toBigInt(), 0n - 2n ** 63n + 2n ** 62n);
    assert.strictEqual(slices[1].min.r._bsontype, 'MinKey');
    for (let i = 1; i < 4; i++) assert.strictEqual(slices[i].min, slices[i - 1].max);
    const narrow = { ...run, min: { h: Long.fromBigInt(0n) }, max: { h: Long.fromBigInt(3n) } };
    assert.deepStrictEqual(splitHashed(narrow, ['h'], 4), [narrow]);
  });
});

describe('createShardPartitioner — batch queries', () => {
  const ranged = createShardPartitioner({ key: { k: 1 }, field: '__v', source: 1 });
  const scope = { kind: 'key-range', min: { k: 10 }, max: { k: 20 } };
  const match = { __v: 1 };

  it('should bound the version index exactly and target the owning shard', () => {
    const query = ranged.batchQuery(scope, {}, { limit: 50, match });
    assert.deepStrictEqual(query.filter, { $and: [match, { k: { $gte: 10, $lt: 20 } }] });
    const compound = createShardPartitioner({ key: { k: 1, j: 1 }, field: '__v', source: 1 });
    const upTo = (j) =>
      compound.batchQuery(
        { kind: 'key-range', min: { k: 10, j: MIN }, max: { k: 20, j } },
        {},
        { limit: 1, match },
      ).filter.$and[1];
    assert.deepStrictEqual(upTo(MIN), { k: { $gte: 10, $lt: 20 } }, 'ends before k: 20');
    assert.deepStrictEqual(upTo(5), { k: { $gte: 10, $lte: 20 } }, 'takes in k: 20, j < 5');
    assert.deepStrictEqual(query.options.hint, { __v: 1, k: 1, _id: 1 });
    assert.deepStrictEqual(Object.keys(query.options.min), ['__v', 'k', '_id']);
    assert.strictEqual(query.options.min.k, 10);
    assert.strictEqual(query.options.min._id._bsontype, 'MinKey');
    assert.strictEqual(query.options.max.k, 20);
    assert.deepStrictEqual(query.options.sort, { __v: 1, k: 1, _id: 1 });
    assert.strictEqual(query.options.limit, 50);
  });

  it('should not draw a predicate across types or on an open end', () => {
    for (const [min, max] of [
      [10, 'a'],
      [MIN, 20],
      [10, MAX],
      [{ a: 1 }, { a: 2 }],
    ]) {
      const query = ranged.batchQuery(
        { kind: 'key-range', min: { k: min }, max: { k: max } },
        {},
        { limit: 5, match },
      );
      assert.deepStrictEqual(query.filter, { $and: [match] }, `${min}..${max}`);
    }
  });

  it('should resume a ranged key after its last tuple, stepping over that document', () => {
    const query = ranged.batchQuery(scope, { tuple: { k: 15, _id: 'x' } }, { limit: 5, match });
    assert.deepStrictEqual(query.options.min, { __v: 1, k: 15, _id: 'x' });
    assert.deepStrictEqual(query.filter.$and.at(-1), { _id: { $ne: 'x' } });
    const next = ranged.advance(
      {},
      [
        { _id: 'a', k: 11 },
        { _id: 'b', k: 12 },
      ],
      { limit: 2 },
    );
    assert.deepStrictEqual(next, { region: 0, tuple: { _id: 'b', k: 12 } });
    assert.strictEqual(ranged.advance({}, [{ _id: 'a', k: 11 }], { limit: 2 }), null);
    assert.deepStrictEqual(ranged.past({}, [{ _id: 'z' }]), {
      region: 0,
      tuple: { _id: 'z', k: null },
    });
  });

  it('should read version 0 in two regions — missing or null, then 0', () => {
    const adapt = createShardPartitioner({ key: { k: 1 }, field: '__v', source: 0 });
    assert.strictEqual(adapt.batchQuery(scope, {}, { limit: 1, match }).options.min.__v, null);
    assert.strictEqual(
      adapt.batchQuery(scope, { region: 1 }, { limit: 1, match }).options.min.__v,
      0,
    );
    assert.deepStrictEqual(adapt.advance({}, [], { limit: 5 }), { region: 1 });
    assert.strictEqual(adapt.advance({ region: 1 }, [], { limit: 5 }), null);
  });

  it('should drain a hashed key: no sort, no keyset, stuck documents stepped over by id', () => {
    const hashed = createShardPartitioner({ key: { uid: 'hashed' }, field: '__v', source: 1 });
    const bounds = { kind: 'key-range', min: { uid: MIN }, max: { uid: Long.fromBigInt(5n) } };
    const first = hashed.batchQuery(bounds, {}, { limit: 3, match });
    assert.strictEqual(first.options.sort, undefined);
    assert.deepStrictEqual(first.options.hint, { __v: 1, uid: 'hashed', _id: 1 });
    assert.deepStrictEqual(first.filter, { $and: [match] }, 'a hash range cannot be targeted');
    const docs = [{ _id: 1 }, { _id: 2 }, { _id: 3 }];
    const next = hashed.advance({}, docs, { limit: 3, left: [2] });
    assert.deepStrictEqual(next, { region: 0, stuck: [2] });
    const again = hashed.batchQuery(bounds, next, { limit: 3, match });
    assert.deepStrictEqual(again.filter.$and.at(-1), { _id: { $nin: [2] } });
    assert.strictEqual(again.options.min.uid._bsontype, 'MinKey', 'always from the start');
    const crowded = { region: 0, stuck: Array.from({ length: MAX_STUCK }, (_, i) => i) };
    assert.strictEqual(hashed.advance(crowded, docs, { limit: 3, left: [7] }), null);
    assert.deepStrictEqual(hashed.past({}, [{ _id: 9 }]), { region: 0, stuck: [9] });
  });

  it('should not repeat _id when the shard key holds it', () => {
    const onId = createShardPartitioner({ key: { tenant: 1, _id: 1 }, field: 'v', source: 2 });
    assert.deepStrictEqual(onId.indexKey, { v: 1, tenant: 1, _id: 1 });
    const query = onId.batchQuery(
      { kind: 'key-range', min: { tenant: 'a', _id: MIN }, max: { tenant: 'c', _id: MIN } },
      { tuple: { tenant: 'b', _id: 5 } },
      { limit: 1, match: {} },
    );
    assert.deepStrictEqual(query.options.min, { v: 2, tenant: 'b', _id: 5 });
    assert.deepStrictEqual(Object.keys(query.options.max), ['v', 'tenant', '_id']);
  });
});

describe('createShardPartitioner — planning', () => {
  function collection({ count = 1000, sample = [] } = {}) {
    return {
      countDocuments: mock.fn(async () => count),
      aggregate: mock.fn(() => ({ toArray: async () => sample })),
    };
  }

  it('should plan nothing when nothing matches', async () => {
    const partitioner = createShardPartitioner({
      key: { k: 1 },
      field: '__v',
      source: 1,
      readChunks: async () => [],
    });
    const plan = await partitioner.plan({
      collection: collection({ count: 0 }),
      match: {},
      maxParallel: 4,
      settings: settings(),
    });
    assert.deepStrictEqual(plan, { epoch: null, method: 'empty', estimate: 0, partitions: [] });
  });

  it('should give each shard its runs as partitions, grouped by shard', async () => {
    const partitioner = createShardPartitioner({
      key: { k: 1 },
      field: '__v',
      source: 1,
      readChunks: async () => [chunk(MIN, 100, 's1'), chunk(100, 200, 's1'), chunk(200, MAX, 's2')],
    });
    const plan = await partitioner.plan({
      collection: collection(),
      match: {},
      maxParallel: 1,
      settings: settings(),
    });
    assert.strictEqual(plan.method, 'chunks');
    assert.deepStrictEqual(
      plan.partitions.map((partition) => [partition.group, partition.scope.kind]),
      [
        ['s1', 'key-range'],
        ['s2', 'key-range'],
      ],
    );
    assert.ok(plan.partitions[0].estimate >= plan.partitions[1].estimate, 'largest first');
  });

  it('should split a shard’s run at sampled quantiles when its lanes want more', async () => {
    const sample = [];
    for (let i = 1; i < 100; i++) sample.push({ k: i });
    const coll = collection({ sample });
    const partitioner = createShardPartitioner({
      key: { k: 1 },
      field: '__v',
      source: 1,
      readChunks: async () => [chunk(MIN, MAX, 's1')],
    });
    const plan = await partitioner.plan({
      collection: coll,
      match: { __v: 1 },
      maxParallel: 4,
      settings: settings(),
      shardConcurrency: 2,
    });
    assert.strictEqual(plan.partitions.length, 8);
    const [pipeline, options] = coll.aggregate.mock.calls[0].arguments;
    assert.deepStrictEqual(pipeline[0], { $match: { $and: [{ __v: 1 }, {}] } });
    assert.strictEqual(options.promoteLongs, false);
    let open = 0;
    for (const partition of plan.partitions) {
      if (partition.scope.min.k?._bsontype === 'MinKey') open += 1;
    }
    assert.strictEqual(open, 1, 'one slice starts at the run’s start, the rest at quantiles');
  });

  it('should sample strictly inside a run, and keep a run whole when it cannot', async () => {
    const coll = collection({ sample: [{ k: 5 }] });
    const partitioner = createShardPartitioner({
      key: { k: 1, t: 'hashed' },
      field: '__v',
      source: 1,
      readChunks: async () => [
        { min: { k: 1, t: MIN }, max: { k: 9, t: MIN }, shard: 's1' },
        { min: { k: 9, t: MIN }, max: { k: 'z', t: MIN }, shard: 's2' },
      ],
    });
    const plan = await partitioner.plan({
      collection: coll,
      match: {},
      maxParallel: 8,
      settings: settings(),
      shardConcurrency: 4,
    });
    assert.strictEqual(plan.partitions.length, 2, 'a sample too small, and mixed-type bounds');
    const [pipeline] = coll.aggregate.mock.calls[0].arguments;
    assert.deepStrictEqual(pipeline[0].$match.$and[1], { k: { $gt: 1, $lt: 9 } });
    assert.deepStrictEqual(pipeline[2].$project, {
      _id: 0,
      k: 1,
      t: { $toHashedIndexKey: '$t' },
    });
    assert.strictEqual(coll.aggregate.mock.callCount(), 1, 'none drawn across types');
  });

  it('should keep a run whole when its sample times out', async () => {
    const coll = {
      countDocuments: async () => 1000,
      aggregate: () => ({
        toArray: async () => {
          throw Object.assign(new Error('time limit'), { code: 50 });
        },
      }),
    };
    const partitioner = createShardPartitioner({
      key: { k: 1 },
      field: '__v',
      source: 1,
      readChunks: async () => [chunk(MIN, MAX, 's1')],
    });
    const plan = await partitioner.plan({
      collection: coll,
      match: {},
      maxParallel: 4,
      settings: settings(),
      shardConcurrency: 4,
    });
    assert.strictEqual(plan.partitions.length, 1);
    assert.strictEqual(plan.degraded, 'sample-timeout', 'said, not silent');
    const broken = {
      countDocuments: async () => 1000,
      aggregate: () => ({
        toArray: async () => {
          throw new Error('down');
        },
      }),
    };
    await assert.rejects(
      partitioner.plan({
        collection: broken,
        match: {},
        maxParallel: 4,
        settings: settings(),
        shardConcurrency: 4,
      }),
      /down/,
    );
  });

  it('should sample a run far larger than its sample collection-first, under the random cursor', async () => {
    const coll = {
      countDocuments: async () => 1000,
      estimatedDocumentCount: async () => 10_000_000,
      aggregate: mock.fn(() => ({
        toArray: async () => Array.from({ length: 400 }, (_, i) => ({ k: i * 10 })),
      })),
    };
    const partitioner = createShardPartitioner({
      key: { k: 1 },
      field: '__v',
      source: 1,
      readChunks: async () => [chunk(MIN, 100, 's1'), chunk(100, MAX, 's2')],
    });
    await partitioner.plan({
      collection: coll,
      match: {},
      maxParallel: 4,
      settings: settings(),
      shardConcurrency: 4,
    });
    for (const call of coll.aggregate.mock.calls) {
      const [first] = call.arguments[0];
      assert.ok(first.$sample, 'the sample first');
      assert.ok(first.$sample.size < 10_000_000 * 0.05, 'within the random cursor');
    }
  });

  it('should say when merged runs span shards (more runs than maxPartitions)', async () => {
    const chunks = [];
    for (let i = 0; i < 6; i++) {
      const min = i === 0 ? MIN : i * 10;
      const max = i === 5 ? MAX : (i + 1) * 10;
      chunks.push(chunk(min, max, i % 2 ? 's2' : 's1'));
    }
    const partitioner = createShardPartitioner({
      key: { k: 1 },
      field: '__v',
      source: 1,
      readChunks: async () => chunks,
    });
    const plan = await partitioner.plan({
      collection: collection(),
      match: {},
      maxParallel: 1,
      settings: { ...settings(), maxPartitions: 2 },
    });
    assert.strictEqual(plan.degraded, 'ungrouped');
  });

  it('should sample the whole key space, ungrouped, when the chunks cannot be read', async () => {
    const partitioner = createShardPartitioner({
      key: { uid: 'hashed' },
      field: '__v',
      source: 1,
      readChunks: async () => undefined,
    });
    const plan = await partitioner.plan({
      collection: collection(),
      match: {},
      maxParallel: 2,
      settings: settings(),
    });
    assert.strictEqual(plan.method, 'sampled');
    assert.strictEqual(plan.partitions.length, 8, 'the hash space split arithmetically');
    for (const partition of plan.partitions) assert.strictEqual(partition.group, undefined);
  });
});

describe('targeted writes and the shard-key guard', () => {
  it('should add the shard key to a write, never _id twice', () => {
    assert.deepStrictEqual(shardKeyFilter({ region: 1, 'a.b': 1 }, { region: 'eu', a: { b: 2 } }), {
      region: 'eu',
      'a.b': 2,
    });
    assert.deepStrictEqual(shardKeyFilter({ region: 1 }, {}), { region: null }, 'missing as null');
    assert.deepStrictEqual(shardKeyFilter({ tenant: 1, _id: 1 }, { _id: 3, tenant: 't' }), {
      tenant: 't',
    });
  });

  it('should refuse a transform that changes the shard key, BSON-aware', () => {
    const key = { region: 1, uid: 'hashed' };
    assert.strictEqual(
      shardKeyGuard(key, { region: 'eu', uid: Long.fromNumber(5) }, { region: 'eu', uid: 5 }),
      null,
      'the same value in another numeric type is no change',
    );
    const refused = shardKeyGuard(key, { region: 'eu', uid: 1 }, { region: 'us', uid: 1 });
    assert.strictEqual(refused.reason, 'shard-key-changed');
    assert.deepStrictEqual(refused.fields, ['region']);
    assert.match(refused.message, /changes the shard key \(region\).*reshardCollection/);
    assert.deepStrictEqual(shardKeyGuard(key, { region: 'eu' }, {}).fields, ['region']);
  });

  it('should find a plan stale once the collection is resharded or its key refined', () => {
    const uuid = new ObjectId();
    const epoch = { uuid: { buffer: new Uint8Array([1, 2]) }, key: { a: 1 } };
    assert.strictEqual(staleEpoch(epoch, { ...epoch }), false);
    assert.strictEqual(
      staleEpoch(epoch, { uuid: { buffer: new Uint8Array([3]) }, key: { a: 1 } }),
      true,
    );
    assert.strictEqual(staleEpoch(epoch, { uuid: epoch.uuid, key: { a: 1, b: 1 } }), true);
    assert.strictEqual(staleEpoch(undefined, epoch), false, 'a plan from before epochs');
    assert.strictEqual(staleEpoch({ uuid, key: {} }, { uuid, key: {} }), false);
  });

  it('should target the writes and guard the key of a shard partitioner — and of _id ranges', () => {
    const epoch = { uuid: { buffer: new Uint8Array([7]) }, key: { region: 1 } };
    const partitioner = createShardPartitioner({
      key: { region: 1 },
      field: '__v',
      source: 1,
      epoch,
    });
    assert.deepStrictEqual(partitioner.writeFilter({ region: 'eu' }), { region: 'eu' });
    assert.strictEqual(
      partitioner.checkTransform({ region: 'eu' }, { region: 'us' }).reason,
      'shard-key-changed',
    );
    assert.strictEqual(
      partitioner.stale({ uuid: { buffer: new Uint8Array([7]) }, key: { region: 1 } }),
      false,
    );
    assert.strictEqual(
      partitioner.stale({ uuid: { buffer: new Uint8Array([8]) }, key: { region: 1 } }),
      true,
    );
    const byId = withShardKey(idRangePartitioner, { region: 1 });
    assert.strictEqual(byId.id, 'id');
    assert.strictEqual(byId.batchQuery, idRangePartitioner.batchQuery);
    assert.deepStrictEqual(byId.writeFilter({ region: 'ap' }), { region: 'ap' });
    assert.strictEqual(byId.checkTransform({ region: 'ap' }, { region: 'ap', x: 1 }), null);
  });
});

describe('partitionerFor — which partitioner a collection gets', () => {
  const spec = { collection: 'orders', field: '__v', from: 1, to: 2, mode: 'declarative' };
  function deps(overrides = {}) {
    const warnings = [];
    const indexes = overrides.indexes ?? [{ key: { _id: 1 } }, { key: { __v: 1, _id: 1 } }];
    return {
      warnings,
      db: {
        collection: () => ({ listIndexes: () => ({ toArray: async () => indexes }) }),
      },
      logger: { warn: (message) => warnings.push(message) },
      fields: (extra) => extra,
      warned: new Set(),
      shardAware: 'auto',
      topology: async () => 'sharded',
      shardKeyOf: async () => ({ key: { region: 1 }, uuid: 'u' }),
      chunksOf: async () => [],
      ...overrides,
    };
  }

  it('should keep _id ranges off a sharded cluster, with shard-awareness off, or for a step', async () => {
    for (const [what, overrides, stepSpec] of [
      ['a replica set', { topology: async () => 'replicaSet' }],
      ['shard-awareness off', { shardAware: 'off' }],
      ['no shard key reader', { shardKeyOf: undefined }],
      ['an unsharded collection', { shardKeyOf: async () => null }],
      ['a step migration', {}, { ...spec, mode: 'step' }],
    ]) {
      const chosen = await partitionerFor(deps(overrides), stepSpec ?? spec, 'forward');
      assert.strictEqual(chosen.partitioner, idRangePartitioner, what);
      assert.strictEqual(chosen.sharding.mode, 'off', what);
    }
  });

  it('should stay untargeted, once said, when the key cannot be read', async () => {
    const d = deps({ shardKeyOf: async () => undefined });
    const chosen = await partitionerFor(d, spec, 'forward');
    assert.strictEqual(chosen.partitioner, idRangePartitioner);
    assert.deepStrictEqual(chosen.hint, { __v: 1, _id: 1 });
    assert.strictEqual(chosen.sharding.mode, 'untargeted');
    await partitionerFor(d, spec, 'forward');
    assert.strictEqual(d.warnings.length, 1);
    assert.match(d.warnings[0], /needs clusterMonitor/);
  });

  it('should target writes and guard the key when the version index lacks the shard key', async () => {
    const d = deps();
    const chosen = await partitionerFor(d, spec, 'forward');
    assert.strictEqual(chosen.partitioner.id, 'id');
    assert.deepStrictEqual(chosen.partitioner.writeFilter({ region: 'eu' }), { region: 'eu' });
    assert.deepStrictEqual(chosen.sharding, { mode: 'untargeted', key: { region: 1 } });
    assert.match(d.warnings[0], /no \{"__v":1,"region":1,"_id":1\} index/);
  });

  it('should split along the shard key, reading the version it starts from', async () => {
    const d = deps({ indexes: [{ key: { __v: 1, region: 1, _id: 1 } }] });
    const forward = await partitionerFor(d, spec, 'forward');
    assert.strictEqual(forward.partitioner.id, 'shard');
    assert.deepStrictEqual(forward.hint, { __v: 1, region: 1, _id: 1 });
    const scope = { kind: 'key-range', min: { region: 'a' }, max: { region: 'b' } };
    const query = (chosen) => chosen.partitioner.batchQuery(scope, {}, { limit: 1, match: {} });
    assert.strictEqual(query(forward).options.min.__v, 1);
    const back = await partitionerFor(d, spec, 'revert');
    assert.strictEqual(query(back).options.min.__v, 2);
  });

  it('should hint a drift probe at the version index, or one led by the version field', async () => {
    assert.deepStrictEqual(await probeHint(deps(), spec), { __v: 1, _id: 1 });
    const sharded = deps({
      indexes: [{ key: { region: 1 } }, { key: { __v: 1, region: 1, _id: 1 } }],
    });
    assert.deepStrictEqual(await probeHint(sharded, spec), { __v: 1, region: 1, _id: 1 });
    const none = deps({ indexes: [{ key: { region: 1 } }] });
    assert.strictEqual(await probeHint(none, spec), undefined);
    assert.match(none.warnings[0], /has no \{ __v: 1, _id: 1 \} index/);
  });
});

describe('sampleRequest — a sample-first pass under the random cursor', () => {
  const { RANDOM_CURSOR_SHARE, sampleRequest } = require('../../src/core/background-partition.js');

  it('should oversample by how little matches, never to 5% of the collection', () => {
    // 100 matches wanted, half the collection matching: 200 asked.
    assert.strictEqual(sampleRequest(100, 0.5, 1_000_000), 200);
    // The default sizing used to land on exactly 5% — a full scan and sort.
    const asked = sampleRequest(2000, (2000 * 20) / 1_000_000, 1_000_000);
    assert.ok(asked < 1_000_000 * 0.05, `asked ${asked}`);
    assert.strictEqual(asked, 1_000_000 * RANDOM_CURSOR_SHARE);
    // The match share is taken as at least 1%; never past the cap, never below one.
    assert.strictEqual(sampleRequest(100, 0.0001, 1e12), 10_000);
    assert.strictEqual(sampleRequest(10_000, 0.05, 1e12), 100_000);
    assert.strictEqual(sampleRequest(1, 1, 10), 1);
  });
});
