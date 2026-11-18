const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MATCH_FIRST_CAP,
  previewSample,
  sampleDocuments,
} = require('../../src/core/background-dry-run.js');
const { SAMPLE_TIMEOUT_MS } = require('../../src/core/background-partition.js');
const { resolveBackgroundSpec } = require('../../src/core/background-spec.js');

const MATCH = { __v: { $in: [null, 1] } };

/**
 * A collection that answers a count, an estimate and each aggregate from a
 * script, and keeps what it was asked. `aggregates`: one answer per call — an
 * array of documents, or an Error to reject with.
 */
function fakeCollection({ count, total = count, aggregates = [], first = [] }) {
  const calls = [];
  let asked = 0;
  return {
    calls,
    countDocuments: async (filter, options) => {
      calls.push(['count', filter, options]);
      if (count instanceof Error) throw count;
      return Math.min(count, options.limit);
    },
    estimatedDocumentCount: async () => total,
    aggregate: (pipeline, options) => ({
      toArray: async () => {
        calls.push(['aggregate', pipeline, options]);
        const answer = aggregates[asked++];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }),
    find: (filter, options) => ({
      toArray: async () => {
        calls.push(['find', filter, options]);
        return first;
      },
    }),
  };
}

const outOfTime = () => Object.assign(new Error('operation exceeded time limit'), { code: 50 });
const docs = (n) => Array.from({ length: n }, (_, i) => ({ _id: i }));
const stages = (call) => call[1].map((stage) => Object.keys(stage)[0]);

describe('sampleDocuments — a random sample that does not scan the collection for it', () => {
  it('should filter first, time-boxed, when few documents match', async () => {
    const collection = fakeCollection({ count: 300, aggregates: [docs(5)] });
    const sampled = await sampleDocuments(collection, MATCH, 5);
    assert.deepStrictEqual(sampled, { docs: docs(5) });
    const [count, aggregate] = collection.calls;
    assert.strictEqual(count[2].limit, MATCH_FIRST_CAP);
    assert.strictEqual(count[2].maxTimeMS, SAMPLE_TIMEOUT_MS);
    assert.deepStrictEqual(stages(aggregate), ['$match', '$sample']);
    assert.strictEqual(aggregate[2].maxTimeMS, SAMPLE_TIMEOUT_MS);
  });

  it('should sample the collection first when most of it matches', async () => {
    const total = 50_000_000;
    const collection = fakeCollection({ count: total, total, aggregates: [docs(5)] });
    const sampled = await sampleDocuments(collection, MATCH, 5);
    assert.deepStrictEqual(sampled, { docs: docs(5) });
    const aggregate = collection.calls[1];
    // Never `$match` then `$sample` here: that reads every matched document
    // and sorts them all at random.
    assert.deepStrictEqual(stages(aggregate), ['$sample', '$match', '$limit']);
    const asked = aggregate[1][0].$sample.size;
    assert.ok(asked >= 5 && asked <= total * 0.04, `sampled ${asked}`);
    assert.strictEqual(aggregate[1][2].$limit, 5);
    assert.strictEqual(aggregate[2].maxTimeMS, SAMPLE_TIMEOUT_MS);
  });

  it('should filter first after all when the sample came back short', async () => {
    const collection = fakeCollection({
      count: MATCH_FIRST_CAP,
      total: 80_000_000,
      aggregates: [docs(1), docs(5)],
    });
    const sampled = await sampleDocuments(collection, MATCH, 5);
    assert.deepStrictEqual(sampled, { docs: docs(5) });
    assert.deepStrictEqual(stages(collection.calls[2]), ['$match', '$sample']);
  });

  it('should take the first documents by _id, and say so, when a read runs out of time', async () => {
    for (const script of [
      { count: outOfTime() },
      { count: 300, aggregates: [outOfTime()] },
      { count: 9e7, total: 9e7, aggregates: [outOfTime()] },
      { count: MATCH_FIRST_CAP, total: 9e7, aggregates: [docs(1), outOfTime()] },
    ]) {
      const collection = fakeCollection({ ...script, first: docs(5) });
      const sampled = await sampleDocuments(collection, MATCH, 5);
      assert.deepStrictEqual(sampled, { docs: docs(5), degraded: 'sample-timeout' });
      const find = collection.calls.at(-1);
      assert.strictEqual(find[0], 'find');
      assert.deepStrictEqual(find[2].sort, { _id: 1 });
      assert.strictEqual(find[2].limit, 5);
      assert.strictEqual(find[2].maxTimeMS, SAMPLE_TIMEOUT_MS);
    }
  });

  it('should throw what is not a timeout', async () => {
    const collection = fakeCollection({ count: 300, aggregates: [new Error('not authorized')] });
    await assert.rejects(sampleDocuments(collection, MATCH, 5), /not authorized/);
  });
});

describe('previewSample — what a real run would refuse', () => {
  const background = {
    collection: 'orders',
    from: 1,
    to: 2,
    // Moves every order to another region: on a collection sharded by it,
    // that is a change of the shard key.
    migrate: (doc) => ({ ...doc, region: 'eu' }),
  };
  const loaded = resolveBackgroundSpec(background, { name: 'm.js' });
  const orders = [
    { _id: 1, __v: 1, region: 'us' },
    { _id: 2, __v: 1, region: 'eu' },
  ];
  const deps = (overrides = {}) => ({
    db: { collection: () => fakeCollection({ count: 2, first: orders }) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    topology: async () => 'sharded',
    shardKeyOf: async () => ({ key: { region: 1 }, uuid: 'u' }),
    ...overrides,
  });

  it('should fail a document whose transformation changes the shard key', async () => {
    const preview = await previewSample(deps(), 'm.js', loaded, { first: 2 });
    assert.strictEqual(preview.method, 'first');
    assert.strictEqual(preview.migrated, 1);
    assert.strictEqual(preview.failed, 1);
    assert.match(preview.documents[0].error, /changes the shard key \(region\)/);
    assert.strictEqual(preview.documents[1].error, undefined);
  });

  it('should judge by _id alone where there is no shard key to guard', async () => {
    for (const overrides of [
      { topology: async () => 'replicaSet' },
      { shardKeyOf: async () => null },
      { shardKeyOf: async () => undefined },
      { shardKeyOf: undefined },
    ]) {
      const preview = await previewSample(deps(overrides), 'm.js', loaded, { first: 2 });
      assert.strictEqual(preview.failed, 0);
      assert.strictEqual(preview.migrated, 2);
    }
  });

  it('should say when a sample fell back to the first documents', async () => {
    const collection = fakeCollection({ count: outOfTime(), first: orders });
    const preview = await previewSample(
      deps({ db: { collection: () => collection }, topology: async () => 'replicaSet' }),
      'm.js',
      loaded,
      { sample: 2 },
    );
    assert.strictEqual(preview.method, 'first');
    assert.strictEqual(preview.degraded, 'sample-timeout');
    assert.strictEqual(preview.found, 2);
  });
});
