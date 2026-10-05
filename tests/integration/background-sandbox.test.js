const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const { runSandbox } = require('../../src/core/background-sandbox.js');
const { SandboxRefusedError, TransactionsUnsupportedError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');

let mongo;
const DB = 'migronaut_background_sandbox_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  await mongo.db.collection('orders').insertMany([
    { _id: 1, status: 'new', total: 5 },
    { _id: 2, status: 'new', total: 7 },
    { _id: 3, status: 'paid', total: 9 },
  ]);
  await mongo.db.createCollection('audit');
});

const sandbox = (fn, options = {}) =>
  runSandbox(
    {
      client: mongo.client,
      db: mongo.db,
      forbidden: ['_migronaut_migrations', '_migronaut_background'],
      ...options,
    },
    fn,
  );

const snapshotOf = async () => mongo.db.collection('orders').find().sort({ _id: 1 }).toArray();

describe('dry-run sandbox (integration)', () => {
  it('should run writes in a transaction that is always aborted, recording them', async () => {
    const before = await snapshotOf();
    const report = await sandbox(async ({ db }) => {
      const orders = db.collection('orders');
      await orders.updateMany({ status: 'new' }, { $set: { status: 'open' } });
      await orders.insertOne({ _id: 4, status: 'open', total: 1 });
      await orders.deleteOne({ _id: 3 });
      await db.collection('audit').insertOne({ note: 'side write' });
      // Every write is visible inside — the reads join the transaction.
      return orders.countDocuments({ status: 'open' });
    });
    assert.strictEqual(report.value, 3);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.aborted, true);
    assert.deepStrictEqual(await snapshotOf(), before, 'nothing stayed');
    assert.strictEqual(await mongo.db.collection('audit').countDocuments(), 0);
    assert.deepStrictEqual(
      report.ops.map((op) => `${op.collection}.${op.method}`),
      [
        'orders.updateMany',
        'orders.insertOne',
        'orders.deleteOne',
        'audit.insertOne',
        'orders.countDocuments',
      ],
    );
    assert.deepStrictEqual(report.ops[0].result, {
      acknowledged: true,
      matchedCount: 2,
      modifiedCount: 2,
      upsertedCount: 0,
    });
    const byOp = {};
    for (const doc of report.documents) byOp[`${doc.collection}:${JSON.stringify(doc._id)}`] = doc;
    assert.strictEqual(byOp['orders:1'].op, 'update');
    assert.deepStrictEqual(byOp['orders:1'].before.status, 'new');
    assert.deepStrictEqual(byOp['orders:1'].after.status, 'open');
    assert.strictEqual(byOp['orders:4'].op, 'insert');
    assert.strictEqual(byOp['orders:3'].op, 'delete');
    assert.ok(report.documents.some((doc) => doc.collection === 'audit' && doc.op === 'insert'));
  });

  it('should refuse what cannot run in the transaction — and report it even when caught', async () => {
    const attempts = [
      ({ db }) => db.collection('orders').createIndex({ total: 1 }),
      ({ db }) => db.collection('orders').drop(),
      ({ db }) => db.collection('orders').estimatedDocumentCount(),
      ({ db }) => db.collection('orders').watch(),
      ({ db }) => db.command({ ping: 1 }),
      ({ db }) => db.admin(),
      ({ db }) => db.collection('_migronaut_migrations').findOne({}),
      ({ db }) => db.collection('system.users').findOne({}),
      ({ client }) => client.startSession(),
      ({ client }) => client.db('admin'),
      ({ session }) => session.commitTransaction(),
      ({ session }) => session.endSession(),
      ({ db }) => db.collection('orders').aggregate([{ $out: 'copy' }]),
      ({ db }) => db.collection('orders').aggregate([{ $facet: { a: [{ $merge: 'x' }] } }]),
      ({ db }) =>
        db
          .collection('orders')
          .aggregate([{ $lookup: { from: '_migronaut_background', as: 'x', pipeline: [] } }]),
      ({ db }) =>
        db.collection('orders').updateOne({}, { $set: { a: 1 } }, { writeConcern: { w: 0 } }),
      ({ db }) => db.collection('orders').find({}, { readPreference: 'secondary' }),
      ({ db }) => db.collection('orders').insertOne({}, { bypassDocumentValidation: true }),
      ({ db }) => db.collection('orders').find({}).explain(),
      ({ mongoose }) => mongoose.model,
    ];
    for (const attempt of attempts) {
      const report = await sandbox(async (handles) => {
        try {
          await attempt(handles);
        } catch (error) {
          // Swallowed on purpose: the report must still say so.
          assert.ok(error instanceof SandboxRefusedError, String(error));
        }
        return 'done';
      });
      assert.strictEqual(report.value, 'done');
      assert.strictEqual(report.ok, false, `refused: ${attempt}`);
      assert.strictEqual(report.refusals.length, 1, `one refusal for ${attempt}`);
    }
    const foreign = mongo.client.startSession();
    try {
      const report = await sandbox(({ db }) =>
        db
          .collection('orders')
          .findOne({}, { session: foreign })
          .catch(() => 'refused'),
      );
      assert.strictEqual(report.value, 'refused');
      assert.match(report.refusals[0].reason, /another session/);
    } finally {
      await foreign.endSession();
    }
  });

  it('should serialize concurrent operations and never be thenable', async () => {
    const report = await sandbox(async (handles) => {
      const same = await handles.db;
      assert.strictEqual(typeof same.collection, 'function');
      const orders = handles.db.collection('orders');
      const results = await Promise.all([
        orders.updateOne({ _id: 1 }, { $inc: { total: 1 } }),
        orders.updateOne({ _id: 2 }, { $inc: { total: 1 } }),
        orders.findOne({ _id: 1 }),
        orders.find({}).sort({ _id: -1 }).limit(2).toArray(),
        orders.distinct('status'),
      ]);
      const seen = [];
      for await (const doc of orders.find({ status: 'new' })) seen.push(doc._id);
      await orders.find({}).forEach((doc) => {
        seen.push(doc.total);
      });
      return { results, seen };
    });
    assert.strictEqual(report.ok, true, report.error);
    assert.strictEqual(report.value.results[3].length, 2);
    assert.deepStrictEqual(report.value.seen.slice(0, 2), [1, 2]);
  });

  it('should close cursors left open, and keep its records within limits', async () => {
    const report = await sandbox(
      async ({ db }) => {
        const cursor = db.collection('orders').find({});
        await cursor.next();
        for (let i = 0; i < 5; i++) {
          await db.collection('orders').updateMany({}, { $inc: { total: 1 } });
        }
      },
      { maxOps: 3, maxDocuments: 2 },
    );
    assert.strictEqual(report.leakedCursors, 1);
    assert.strictEqual(report.ops.length, 3);
    assert.strictEqual(report.documents.length, 2);
    assert.strictEqual(report.truncated, true);
  });

  it('should stop at a write error — the server aborted the transaction — and at the deadline', async () => {
    const report = await sandbox(async ({ db }) => {
      await db
        .collection('orders')
        .insertOne({ _id: 1 })
        .catch(() => undefined);
      return db.collection('orders').findOne({ _id: 2 });
    });
    assert.strictEqual(report.ok, false);
    assert.match(report.abortedBy, /duplicate key/);
    const slow = await sandbox(() => new Promise((resolve) => setTimeout(resolve, 2000)), {
      deadlineMs: 100,
    });
    assert.strictEqual(slow.stoppedBy, 'deadline');
  });

  it('should refuse a standalone server', async () => {
    await assert.rejects(
      sandbox(() => undefined, { topology: 'standalone' }),
      TransactionsUnsupportedError,
    );
  });
});
