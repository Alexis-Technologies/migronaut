const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { Long } = require('mongodb');
const {
  RevisionConflictError,
  defineShapes,
  findOneAndUpdateWithRevision,
  replaceWithRevision,
  retryOnConflict,
  updateWithRevision,
} = require('../../versioning.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_versioning_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
});

const kits = [];
let project;

afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.disconnect();
  project?.cleanup();
  project = undefined;
});

describe('optimistic concurrency (integration)', () => {
  it('should let exactly one of two writers holding the same revision win', async () => {
    const orders = mongo.db.collection('orders');
    await orders.insertOne({ _id: 1, status: 'new', __v: 1, __rev: 0 });
    const read = await orders.findOne({ _id: 1 });
    const outcomes = await Promise.allSettled([
      updateWithRevision(orders, { _id: 1 }, read.__rev, { $set: { status: 'paid' } }),
      updateWithRevision(orders, { _id: 1 }, read.__rev, { $set: { status: 'cancelled' } }),
    ]);
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.strictEqual(won.length, 1);
    assert.strictEqual(lost.length, 1);
    assert.ok(lost[0].reason instanceof RevisionConflictError);
    assert.strictEqual(lost[0].reason.context.reason, 'conflict');
    assert.strictEqual(lost[0].reason.context.actual, 1);
    assert.strictEqual(lost[0].reason.context.collection, 'orders');
    const stored = await orders.findOne({ _id: 1 });
    assert.strictEqual(stored.__rev, 1);
    assert.strictEqual(won[0].value.revision, 1);
  });

  it('should treat a legacy document without a revision as revision 0', async () => {
    const orders = mongo.db.collection('orders');
    await orders.insertOne({ _id: 1, status: 'legacy' });
    await updateWithRevision(
      orders,
      { _id: 1 },
      0,
      { $set: { status: 'touched' } },
      { version: 2 },
    );
    assert.deepStrictEqual(await orders.findOne({ _id: 1 }), {
      _id: 1,
      status: 'touched',
      __v: 2,
      __rev: 1,
    });
    await assert.rejects(
      updateWithRevision(orders, { _id: 1 }, 0, { $set: { status: 'stale' } }),
      (error) => error.context.reason === 'conflict' && error.context.actual === 1,
    );
    await assert.rejects(
      updateWithRevision(orders, { _id: 2 }, 0, { $set: { status: 'x' } }),
      (error) => error.context.reason === 'not-found',
    );
  });

  it('should serialize concurrent read-modify-writes through retryOnConflict', async () => {
    const counters = mongo.db.collection('counters');
    await counters.insertOne({ _id: 'c', value: 0 });
    const increment = () =>
      retryOnConflict(
        async () => {
          const doc = await counters.findOne({ _id: 'c' });
          return updateWithRevision(counters, { _id: 'c' }, doc.__rev ?? 0, {
            $set: { value: doc.value + 1 },
          });
        },
        { attempts: 50, backoff: { baseMs: 1, maxMs: 20 } },
      );
    await Promise.all(Array.from({ length: 10 }, increment));
    const doc = await counters.findOne({ _id: 'c' });
    assert.strictEqual(doc.value, 10, 'no increment was lost');
    assert.strictEqual(doc.__rev, 10);
  });

  it('should update with a pipeline, replace, and find-and-update under the guard', async () => {
    const orders = mongo.db.collection('orders');
    await orders.insertOne({ _id: 1, items: 2, __rev: 4 });
    await updateWithRevision(orders, { _id: 1 }, 4, [{ $set: { items: { $add: ['$items', 1] } } }]);
    assert.deepStrictEqual(await orders.findOne({ _id: 1 }), { _id: 1, items: 3, __rev: 5 });

    const read = await orders.findOne({ _id: 1 });
    await replaceWithRevision(
      orders,
      { _id: 1 },
      read.__rev,
      { ...read, items: 9 },
      { version: 3 },
    );
    assert.deepStrictEqual(await orders.findOne({ _id: 1 }), {
      _id: 1,
      items: 9,
      __rev: 6,
      __v: 3,
    });

    const after = await findOneAndUpdateWithRevision(orders, { _id: 1 }, 6, {
      $set: { items: 10 },
    });
    assert.strictEqual(after.items, 10);
    assert.strictEqual(after.__rev, 7);
    const before = await findOneAndUpdateWithRevision(
      orders,
      { _id: 1 },
      7,
      { $set: { items: 11 } },
      { returnDocument: 'before' },
    );
    assert.strictEqual(before.items, 10);
    await assert.rejects(
      findOneAndUpdateWithRevision(orders, { _id: 1 }, 7, { $set: { items: 12 } }),
      (error) => error.context.reason === 'conflict' && error.context.actual === 8,
    );
  });

  it('should keep counting once the revision outgrows int32', async () => {
    const orders = mongo.db.collection('orders');
    await orders.insertOne({ _id: 1, __rev: 2 ** 31 - 1 });
    await updateWithRevision(orders, { _id: 1 }, 2 ** 31 - 1, { $set: { a: 1 } });
    const raw = await orders.findOne({ _id: 1 }, { promoteLongs: false });
    assert.ok(raw.__rev instanceof Long);
    await updateWithRevision(orders, { _id: 1 }, 2 ** 31, { $set: { a: 2 } });
    assert.strictEqual((await orders.findOne({ _id: 1 })).__rev, 2 ** 31 + 1);
  });

  it('should stamp documents the converged validator accepts', async () => {
    const definitions = { orders: { versioning: { current: 2 } } };
    project = makeProject();
    const kit = makeMigrator(mongo.uri, DB, project.dir, {
      collections: [{ name: 'orders', ...definitions.orders }],
    });
    kits.push(kit);
    await kit.converge();
    const shapes = defineShapes(definitions);
    const orders = mongo.db.collection('orders');
    await orders.insertOne(shapes.stamp('orders', { _id: 1, total: 5 }));
    await orders.insertMany(shapes.onInsert('orders', [{ _id: 2 }, { _id: 3 }]));
    await orders.updateOne({ _id: 4 }, shapes.stampUpsert('orders', { $set: { total: 1 } }), {
      upsert: true,
    });
    assert.deepStrictEqual(await orders.findOne({ _id: 4 }), {
      _id: 4,
      total: 1,
      __v: 2,
      __rev: 1,
    });
    await assert.rejects(orders.insertOne({ _id: 5 }), (error) => error.code === 121);
  });
});
