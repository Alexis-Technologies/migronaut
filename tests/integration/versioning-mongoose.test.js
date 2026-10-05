const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const mongoose = require('mongoose');
const { defineShapes, versioningPlugin } = require('../../versioning.js');
const { startTestMongo } = require('../helpers/mongo.js');

let mongo;
let connection;
const DB = 'migronaut_versioning_mongoose_test';

before(async () => {
  mongo = await startTestMongo(DB);
  connection = await mongoose.createConnection(mongo.uri, { dbName: DB }).asPromise();
});

after(async () => {
  await connection.close();
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
});

let models = 0;
/** A fresh model over `orders` with the plugin — Mongoose refuses to compile one name twice */
function orderModel(definition = { versioning: { current: 2 } }) {
  const schema = new mongoose.Schema({ name: String, tags: [String] });
  schema.plugin(versioningPlugin, definition);
  models += 1;
  return connection.model(`Order${models}`, schema, 'orders');
}

const raw = (filter) => mongo.db.collection('orders').findOne(filter);

describe('versioningPlugin with mongoose (integration)', () => {
  it('should stamp a created document and refuse a stale save', async () => {
    const Order = orderModel();
    const created = await Order.create({ name: 'a' });
    assert.deepStrictEqual(
      {
        __v: (await raw({ _id: created._id })).__v,
        __rev: (await raw({ _id: created._id })).__rev,
      },
      { __v: 2, __rev: 0 },
    );
    const first = await Order.findById(created._id);
    const second = await Order.findById(created._id);
    first.name = 'first';
    await first.save();
    second.name = 'second';
    await assert.rejects(second.save(), (error) => error.name === 'VersionError');
    const stored = await raw({ _id: created._id });
    assert.strictEqual(stored.name, 'first');
    assert.strictEqual(stored.__rev, 1);
  });

  it('should never stamp a legacy document on load and save — and guard its save', async () => {
    const Order = orderModel();
    const { insertedId } = await mongo.db.collection('orders').insertOne({ name: 'legacy' });
    const legacy = await Order.findById(insertedId);
    assert.strictEqual(legacy.get('__v'), undefined);
    legacy.name = 'still legacy';
    await legacy.save();
    const stored = await raw({ _id: insertedId });
    assert.strictEqual(stored.__v, undefined, 'not marked as the current shape');
    assert.strictEqual(stored.__rev, 1);

    // A background migration rewrote it between load and save.
    const { insertedId: other } = await mongo.db.collection('orders').insertOne({ name: 'b' });
    const stale = await Order.findById(other);
    await mongo.db
      .collection('orders')
      .updateOne({ _id: other }, { $set: { __v: 2 }, $inc: { __rev: 1 } });
    stale.name = 'overwrite';
    await assert.rejects(stale.save(), (error) => error.name === 'VersionError');
    assert.strictEqual((await raw({ _id: other })).name, 'b');
  });

  it('should bump the revision of updates and stamp upserted documents', async () => {
    const Order = orderModel();
    const created = await Order.create({ name: 'a' });
    await Order.updateOne({ _id: created._id }, { $set: { name: 'b' } });
    await Order.updateMany({}, { $push: { tags: 'x' } });
    const found = await Order.findOneAndUpdate({ _id: created._id }, { name: 'c' }, { new: true });
    assert.strictEqual(found.__rev, 3);
    await Order.updateOne({ name: 'up' }, { $set: { name: 'up' } }, { upsert: true });
    await Order.findOneAndUpdate({ name: 'up2' }, { name: 'up2' }, { upsert: true });
    for (const name of ['up', 'up2']) {
      const doc = await raw({ name });
      assert.strictEqual(doc.__v, 2, name);
      assert.strictEqual(doc.__rev, 1, name);
    }
    await Order.insertMany([{ name: 'many' }]);
    assert.strictEqual((await raw({ name: 'many' })).__v, 2);
  });

  it('should take the registry form and custom field names', async () => {
    const shapes = defineShapes({
      orders: { versioning: { current: 3, field: 'schemaVersion', revisionField: 'rev' } },
    });
    const schema = new mongoose.Schema({ name: String });
    schema.plugin(shapes.plugin('orders'));
    const Order = connection.model('OrderCustom', schema, 'orders');
    const created = await Order.create({ name: 'a' });
    const stored = await raw({ _id: created._id });
    assert.strictEqual(stored.schemaVersion, 3);
    assert.strictEqual(stored.rev, 0);
    assert.strictEqual(stored.__v, undefined);
  });
});
