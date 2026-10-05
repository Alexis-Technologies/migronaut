const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const { Decimal128, Double, Int32, Long, MongoClient, ObjectId } = require('mongodb');
const {
  applyBatch,
  controlOutcome,
  matchOf,
  processPartition,
  readStepResult,
} = require('../../src/core/background-engine.js');
const { idRangePartitioner } = require('../../src/core/background-partition.js');
const { resolveBackgroundSpec } = require('../../src/core/background-spec.js');
const { BackgroundStore } = require('../../src/core/background-store.js');
const { BackgroundFailedError, LockLostError } = require('../../src/errors/index.js');
const { silentLogger } = require('../../src/utils/logger.js');
const { updateWithRevision } = require('../../versioning.js');
const { startTestMongo } = require('../helpers/mongo.js');

let mongo;
let store;
const DB = 'migronaut_background_engine_test';
const NAME = '0001-orders.js';
const HINT = { __v: 1, _id: 1 };

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  store = new BackgroundStore(mongo.db, '_migronaut_background');
  await store.ensureIndexes();
  await mongo.db.collection('orders').createIndex(HINT);
});

const moveAddress = ({ address, ...doc }) => ({ ...doc, shipping: { address } });

/** A job and one claimed partition over the whole collection */
async function setUp(
  raw,
  { partitions = [{ scope: { kind: 'id-range', bracket: 'objectId' } }] } = {},
) {
  const { spec, fns } = resolveBackgroundSpec({ collection: 'orders', from: 1, to: 2, ...raw });
  await store.register(NAME, { status: 'pending', spec });
  const state = await store.commitPlan(NAME, {
    generation: 0,
    plan: { partitioner: 'id' },
    partitions,
    fields: { status: 'running' },
  });
  const claimed = await store.claim(NAME, {
    generation: state.generation,
    plan: state.plan.token,
    maxParallel: spec.maxParallel,
    ttlMs: 60_000,
  });
  const job = {
    name: NAME,
    spec,
    fns,
    direction: 'forward',
    partitioner: idRangePartitioner,
    generation: state.generation,
    partitionId: claimed.partition._id,
    match: matchOf(spec, 'forward'),
    hint: HINT,
    logger: silentLogger,
  };
  return { job, state, ...claimed };
}

const noThrottle = { beforeBatch: async () => {} };

/** Run a claimed partition to an outcome */
function run({ job, lease, partition }, overrides = {}) {
  return processPartition(job, {
    store,
    lease,
    partition,
    db: overrides.db ?? mongo.db,
    client: mongo.client,
    deadline: Date.now() + 60_000,
    throttle: noThrottle,
    readControl: () => store.get(NAME),
    ...overrides,
  });
}

describe('background engine (integration)', () => {
  it('should keep the stored BSON type of every field it does not change', async () => {
    const _id = new ObjectId();
    await mongo.db.collection('orders').insertOne({
      _id,
      __v: 1,
      __rev: 0,
      address: 'Main St',
      ratio: new Double(1),
      count: new Int32(7),
      big: Long.fromString('9007199254740993'),
      small: Long.fromNumber(5),
      price: Decimal128.fromString('9.990'),
      at: new Date(1000),
    });
    // Through a client that would hand back BSON wrappers: the engine reads
    // with its own options, and writes back only what changed.
    const raw = new MongoClient(mongo.uri, { promoteValues: false, promoteLongs: false });
    await raw.connect();
    try {
      const setup = await setUp({ migrate: moveAddress });
      const result = await run(setup, { db: raw.db(DB) });
      assert.strictEqual(result.outcome, 'exhausted');
      assert.strictEqual(result.counters.migrated, 1);
    } finally {
      await raw.close();
    }
    const stored = await mongo.db
      .collection('orders')
      .findOne({ _id }, { promoteValues: false, promoteLongs: false });
    assert.strictEqual(stored.ratio._bsontype, 'Double');
    assert.strictEqual(stored.count._bsontype, 'Int32');
    assert.strictEqual(stored.big.toString(), '9007199254740993');
    assert.strictEqual(stored.small._bsontype, 'Long');
    assert.strictEqual(stored.price.toString(), '9.990');
    assert.deepStrictEqual(stored.shipping, { address: 'Main St' });
    assert.strictEqual(stored.address, undefined);
    assert.strictEqual(Number(stored.__v), 2);
    assert.strictEqual(Number(stored.__rev), 1);
  });

  it('should retry a document the application wrote mid-batch, keeping its change', async () => {
    const orders = mongo.db.collection('orders');
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const { insertedId } = await orders.insertOne({
        __v: 1,
        __rev: 0,
        address: `A${i}`,
        status: 'new',
      });
      ids.push(insertedId);
    }
    let interfered = false;
    const setup = await setUp({
      migrate: async (doc) => {
        if (!interfered && doc._id.equals(ids[3])) {
          interfered = true;
          // The application pays the order between our read and our write.
          await updateWithRevision(orders, { _id: doc._id }, doc.__rev, {
            $set: { status: 'paid' },
          });
        }
        return moveAddress(doc);
      },
    });
    const result = await run(setup);
    assert.strictEqual(result.outcome, 'exhausted');
    assert.strictEqual(result.counters.migrated, 10);
    assert.strictEqual(result.counters.retried, 1);
    const doc = await orders.findOne({ _id: ids[3] });
    assert.strictEqual(doc.status, 'paid', 'the application write survived');
    assert.deepStrictEqual(doc.shipping, { address: 'A3' });
    assert.strictEqual(doc.__v, 2);
    assert.strictEqual(doc.__rev, 2);
  });

  it('should leave a document still in the way after every retry for the next pass', async () => {
    const orders = mongo.db.collection('orders');
    const { insertedId } = await orders.insertOne({ __v: 1, __rev: 0, address: 'x' });
    const setup = await setUp({
      maxConflictRetries: 1,
      migrate: async (doc) => {
        await orders.updateOne({ _id: doc._id }, { $inc: { __rev: 1 } });
        return moveAddress(doc);
      },
    });
    const result = await run(setup);
    assert.strictEqual(result.counters.conflicts, 1);
    assert.strictEqual(result.counters.migrated, 0);
    assert.strictEqual((await orders.findOne({ _id: insertedId })).__v, 1);
  });

  it('should fail documents, not the batch, within the error budget — and fail beyond it', async () => {
    const orders = mongo.db.collection('orders');
    await orders.insertMany(
      Array.from({ length: 6 }, (_, i) => ({
        __v: 1,
        __rev: 0,
        address: `A${i}`,
        bad: i % 2 === 0,
      })),
    );
    const migrate = (doc) => {
      if (doc.bad) throw new Error('cannot read this address');
      return moveAddress(doc);
    };
    const within = await setUp({ migrate, maxDocumentErrors: 3 });
    const ok = await run(within);
    assert.strictEqual(ok.outcome, 'exhausted');
    assert.strictEqual(ok.counters.failed, 3);
    assert.strictEqual(ok.counters.migrated, 3);
    const [partition] = await store.partitions(NAME);
    assert.strictEqual(partition.badIds.length, 3);
    assert.strictEqual(partition.lastDocErrors[0].error, 'cannot read this address');
    assert.strictEqual(partition.lastDocErrors[0].id, undefined, 'no ids in the error list');
    assert.strictEqual(await orders.countDocuments({ __v: 1 }), 3);

    await orders.updateMany({}, { $set: { __v: 1 } });
    const beyond = await setUp({ migrate, maxDocumentErrors: 2 });
    const failed = await run(beyond);
    assert.strictEqual(failed.outcome, 'failed');
    assert.ok(failed.error instanceof BackgroundFailedError);
    assert.match(failed.error.message, /3 document\(s\) could not be migrated/);
  });

  it('should fail a document the validator refuses, and one that changes its _id', async () => {
    await mongo.db.command({
      collMod: 'orders',
      validator: { $jsonSchema: { properties: { shipping: { bsonType: 'object' } } } },
    });
    const orders = mongo.db.collection('orders');
    await orders.insertMany([
      { __v: 1, __rev: 0, address: 'ok' },
      { __v: 1, __rev: 0, address: 'string-shipping' },
      { __v: 1, __rev: 0, address: 'new-id' },
    ]);
    const setup = await setUp({
      maxDocumentErrors: 5,
      migrate: (doc) => {
        if (doc.address === 'string-shipping') return { ...doc, shipping: 'nope' };
        if (doc.address === 'new-id') return { ...moveAddress(doc), _id: new ObjectId() };
        return moveAddress(doc);
      },
    });
    const result = await run(setup);
    assert.strictEqual(result.counters.migrated, 1);
    assert.strictEqual(result.counters.failed, 2);
    const [partition] = await store.partitions(NAME);
    assert.deepStrictEqual(partition.lastDocErrors.map((entry) => entry.reason).sort(), [
      'shape',
      'write',
    ]);
  });

  it('should take aligned results from migrateBatch, an Error failing one document', async () => {
    const orders = mongo.db.collection('orders');
    await orders.insertMany(
      Array.from({ length: 5 }, (_, i) => ({ __v: 1, __rev: 0, address: `A${i}`, i })),
    );
    const setup = await setUp({
      batchSize: 2,
      maxDocumentErrors: 1,
      migrateBatch: async (docs) =>
        docs.map((doc) => (doc.i === 2 ? new Error('bad row') : moveAddress(doc))),
    });
    const result = await run(setup);
    assert.strictEqual(result.outcome, 'exhausted');
    assert.strictEqual(result.counters.migrated, 4);
    assert.strictEqual(result.counters.batches, 3);
    // A batch transformation that returns the wrong count fails the slice.
    await orders.updateMany({}, { $set: { __v: 1 } });
    const broken = await setUp({ migrateBatch: async () => [] });
    await assert.rejects(run(broken), /must return one per document/);
  });

  it('should stop at the deadline, on a control, on a new plan, and on a lost lease', async () => {
    await mongo.db
      .collection('orders')
      .insertMany(Array.from({ length: 30 }, (_, i) => ({ __v: 1, __rev: 0, address: `A${i}` })));
    const setup = await setUp({ migrate: moveAddress, batchSize: 10 });
    let batches = 0;
    const yielded = await run(setup, {
      deadline: Date.now() + 60_000,
      onBatch: () => {
        batches += 1;
      },
      now: () => (batches >= 1 ? Number.MAX_SAFE_INTEGER : Date.now()),
    });
    assert.strictEqual(yielded.outcome, 'yielded');
    assert.strictEqual(yielded.counters.migrated, 10);
    const paused = await run(setup, { readControl: async () => ({ status: 'paused' }) });
    assert.strictEqual(paused.outcome, 'paused');
    assert.strictEqual(controlOutcome(null, setup.job, setup.partition), 'cancelled');
    assert.strictEqual(controlOutcome({ status: 'failed' }, setup.job, setup.partition), 'failed');
    assert.strictEqual(
      controlOutcome({ status: 'running', generation: 9 }, setup.job, setup.partition),
      'stale',
    );
    const stopped = await run(setup, { signal: AbortSignal.abort() });
    assert.strictEqual(stopped.outcome, 'stopped');
    await store.unlockAll(NAME);
    await assert.rejects(run(setup), LockLostError);
  });

  it('should run a step migration as one partition, from checkpoint to checkpoint', async () => {
    const seen = [];
    const { spec, fns } = resolveBackgroundSpec({
      collection: 'orders',
      step: async ({ checkpoint, db }) => {
        seen.push(checkpoint);
        const n = checkpoint?.n ?? 0;
        await db.collection('log').insertOne({ n });
        return { checkpoint: { n: n + 1 }, done: n === 2, processed: 1 };
      },
    });
    await store.register(NAME, { status: 'pending', spec });
    const state = await store.commitPlan(NAME, {
      generation: 0,
      plan: { partitioner: 'step' },
      partitions: [{ scope: { kind: 'step' } }],
      fields: { status: 'running' },
    });
    const claimed = await store.claim(NAME, {
      generation: state.generation,
      plan: state.plan.token,
      maxParallel: 1,
      ttlMs: 60_000,
    });
    const job = { name: NAME, spec, fns, generation: state.generation, logger: silentLogger };
    const result = await run({ job, ...claimed });
    assert.strictEqual(result.outcome, 'exhausted');
    assert.deepStrictEqual(seen, [null, { n: 1 }, { n: 2 }]);
    assert.strictEqual(result.counters.processed, 3);
    assert.strictEqual(await mongo.db.collection('log').countDocuments(), 3);
    assert.throws(() => readStepResult({ done: 'yes' }), /done a boolean/);
    assert.throws(
      () => readStepResult({ done: false, checkpoint: { blob: 'x'.repeat(70_000) } }),
      /larger than 64 KiB/,
    );
  });

  it('should write through one shared path that a session can join', async () => {
    const orders = mongo.db.collection('orders');
    await orders.insertOne({ __v: 1, __rev: 0, address: 'x' });
    const { spec, fns } = resolveBackgroundSpec({
      collection: 'orders',
      from: 1,
      to: 2,
      migrate: moveAddress,
    });
    const job = {
      name: NAME,
      spec,
      fns,
      generation: 1,
      logger: silentLogger,
      partitioner: idRangePartitioner,
    };
    const session = mongo.client.startSession();
    let result;
    try {
      session.startTransaction();
      const docs = await orders.find({ __v: 1 }, { session }).toArray();
      result = await applyBatch(job, docs, { db: mongo.db, session });
      assert.strictEqual((await orders.findOne({}, { session })).__v, 2, 'visible inside');
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }
    assert.strictEqual(result.migrated, 1);
    assert.strictEqual((await orders.findOne({})).__v, 1, 'rolled back with the session');
  });
});
