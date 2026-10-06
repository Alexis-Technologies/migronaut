const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const { Binary, Decimal128, Long, ObjectId } = require('mongodb');
const { idRangePartitioner, sliceBracket } = require('../../src/core/background-partition.js');
const { scopeFilter } = require('../../src/core/background-spec.js');
const { startTestMongo } = require('../helpers/mongo.js');

let mongo;
const DB = 'migronaut_background_partition_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
});

const settings = (overrides = {}) => ({
  overPartition: 4,
  maxPartitions: 256,
  minPartitionDocs: 50,
  sampleSize: 2000,
  ...overrides,
});

const MATCH = { __v: 1 };
const HINT = { __v: 1, _id: 1 };

async function seed(ids, extra = {}) {
  const docs = ids.map((id, i) => ({ _id: id, __v: 1, i, ...extra }));
  await mongo.db.collection('things').insertMany(docs);
  await mongo.db.collection('things').createIndex(HINT);
  return docs;
}

const plan = (overrides = {}) =>
  idRangePartitioner.plan({
    collection: mongo.db.collection('things'),
    match: MATCH,
    hint: HINT,
    maxParallel: 4,
    settings: settings(),
    ...overrides,
  });

/** How many documents each partition's scope matches — and their sum */
async function coverage(partitions) {
  const counts = [];
  for (const { scope } of partitions) {
    counts.push(
      await mongo.db.collection('things').countDocuments({ $and: [MATCH, scopeFilter(scope)] }),
    );
  }
  return { counts, total: counts.reduce((sum, count) => sum + count, 0) };
}

describe('idRangePartitioner (integration)', () => {
  it('should split ObjectIds into disjoint ranges that cover every document once', async () => {
    const docs = await seed(Array.from({ length: 2000 }, () => new ObjectId()));
    const result = await plan({ settings: settings({ minPartitionDocs: 200 }) });
    assert.strictEqual(result.method, 'match-first');
    assert.strictEqual(result.estimate, 2000);
    assert.ok(result.partitions.length >= 8 && result.partitions.length <= 16);
    const { counts, total } = await coverage(result.partitions);
    assert.strictEqual(total, docs.length, 'every document in exactly one partition');
    assert.ok(Math.max(...counts) < 2000 / 4, `balanced enough: ${counts}`);
    // Largest first.
    for (let i = 1; i < result.partitions.length; i++) {
      assert.ok(result.partitions[i - 1].estimate >= result.partitions[i].estimate);
    }
  });

  it('should cover mixed _id types, never splitting objects', async () => {
    const ids = [];
    for (let i = 0; i < 300; i++) ids.push(`key-${String(i).padStart(4, '0')}`);
    for (let i = 0; i < 300; i++) ids.push(i * 1.5);
    ids.push(Long.fromString('9007199254740993'), Long.fromString('9007199254740995'));
    ids.push(Decimal128.fromString('12345678901234567890.5'));
    for (let i = 0; i < 200; i++) ids.push(new Date(Date.UTC(2020, 0, 1) + i * 86_400_000));
    for (let i = 0; i < 100; i++) ids.push({ tenant: i % 3, n: i });
    for (let i = 0; i < 100; i++) ids.push(new Binary(Buffer.from([i, 1, 2])));
    ids.push(true, false);
    for (let i = 0; i < 300; i++) ids.push(new ObjectId());
    await seed(ids);
    const result = await plan({ maxParallel: 8, settings: settings({ minPartitionDocs: 20 }) });
    const { total } = await coverage(result.partitions);
    assert.strictEqual(total, ids.length);
    const objects = result.partitions.filter((partition) => partition.scope.bracket === 'object');
    assert.strictEqual(objects.length, 1);
    assert.deepStrictEqual(Object.keys(objects[0].scope).sort(), ['bracket', 'kind']);
    const brackets = new Set(result.partitions.map((partition) => partition.scope.bracket));
    for (const name of ['string', 'number', 'date', 'object', 'binData', 'bool', 'objectId']) {
      assert.ok(brackets.has(name), `bracket ${name} planned`);
    }
    assert.ok(
      result.partitions.filter((partition) => partition.scope.bracket === 'number').length > 1,
      'numbers split across ranges',
    );
  });

  it('should plan one partition without parallelism, and none for nothing', async () => {
    await seed(Array.from({ length: 300 }, () => new ObjectId()));
    const single = await plan({ maxParallel: 1 });
    assert.strictEqual(single.method, 'single');
    // Counted up to one partition's worth (50) of 300: said to be at least that.
    assert.strictEqual(single.estimate, 50);
    assert.strictEqual(single.atLeast, true);
    const all = await plan({ maxParallel: 1, settings: settings({ minPartitionDocs: 1000 }) });
    assert.strictEqual(all.estimate, 300);
    assert.strictEqual(all.atLeast, undefined, 'counted in full');
    assert.deepStrictEqual(
      single.partitions.map((p) => p.scope),
      [{ kind: 'id-range', bracket: 'objectId' }],
    );
    const empty = await plan({ match: { __v: 7 } });
    assert.deepStrictEqual(empty, { epoch: null, method: 'empty', estimate: 0, partitions: [] });
  });

  it('should see only what is left on a second pass', async () => {
    await seed(Array.from({ length: 1000 }, () => new ObjectId()));
    await mongo.db.collection('things').updateMany({ i: { $lt: 900 } }, { $set: { __v: 2 } });
    const result = await plan();
    assert.strictEqual(result.estimate, 100);
    const { total } = await coverage(result.partitions);
    assert.strictEqual(total, 100);
  });

  it('should sample the collection first when the match is large', async () => {
    await seed(Array.from({ length: 3000 }, () => new ObjectId()));
    const result = await plan({ settings: settings({ minPartitionDocs: 20 }) });
    assert.strictEqual(result.method, 'sample-first');
    assert.ok(result.estimate >= 320, `estimate ${result.estimate}`);
    const { total } = await coverage(result.partitions);
    assert.strictEqual(total, 3000);
  });

  it('should fall back to one partition per bracket when the sample times out', async () => {
    await seed(Array.from({ length: 1000 }, () => new ObjectId()));
    // countDocuments is an aggregate too: let it through, fail the sample.
    await mongo.client.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { skip: 1 },
      data: { failCommands: ['aggregate'], errorCode: 50 },
    });
    let result;
    try {
      result = await plan();
    } finally {
      await mongo.client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
    assert.strictEqual(result.degraded, 'sample-timeout');
    assert.strictEqual(result.partitions.length, 1);
    const { total } = await coverage(result.partitions);
    assert.strictEqual(total, 1000);
  });

  it('should scan a batch through the version index, bounded by its limit', async () => {
    await seed(Array.from({ length: 2000 }, () => new ObjectId()));
    const result = await plan();
    const [{ scope }] = result.partitions;
    const query = idRangePartitioner.batchQuery(
      scope,
      { lastId: undefined },
      {
        limit: 50,
        match: MATCH,
        hint: HINT,
      },
    );
    const explained = await mongo.db
      .collection('things')
      .find(query.filter, query.options)
      .explain('executionStats');
    const stats = explained.executionStats;
    assert.strictEqual(stats.nReturned, 50);
    assert.ok(stats.totalKeysExamined <= 51, `keys examined: ${stats.totalKeysExamined}`);
    assert.ok(stats.totalDocsExamined <= 50);
    const docs = await mongo.db.collection('things').find(query.filter, query.options).toArray();
    const next = idRangePartitioner.advance({}, docs, { limit: 50 });
    assert.ok(next.lastId.equals(docs[49]._id));
    assert.strictEqual(idRangePartitioner.advance({}, docs.slice(0, 10), { limit: 50 }), null);
  });
});

describe('sliceBracket', () => {
  it('should cut a sorted sample at quantiles, skipping duplicate bounds', () => {
    const ranges = sliceBracket('number', [1, 1, 1, 1, 2, 3, 4, 5], 4);
    assert.deepStrictEqual(
      ranges.map((range) => [range.scope.gte, range.scope.lt, range.count]),
      [
        // floor(i·8/4) = 2, 4, 6: ids[2] equals the first id and is skipped.
        [undefined, 2, 4],
        [2, 4, 2],
        [4, undefined, 2],
      ],
    );
    assert.deepStrictEqual(sliceBracket('number', [1], 4), [
      { scope: { kind: 'id-range', bracket: 'number' }, count: 1 },
    ]);
    assert.deepStrictEqual(idRangePartitioner.writeFilter({ _id: 1 }), {});
    assert.strictEqual(idRangePartitioner.checkTransform({}, {}), null);
    assert.strictEqual(idRangePartitioner.stale(), false);
  });
});
