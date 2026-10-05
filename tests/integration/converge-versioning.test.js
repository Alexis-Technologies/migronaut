const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { ConvergeFailedError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_converge_versioning_test';

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

function kitWith(overrides = {}) {
  project ??= makeProject();
  const kit = makeMigrator(mongo.uri, DB, project.dir, overrides);
  kits.push(kit);
  return kit;
}

const rows = (result) =>
  result.collections.flatMap((collection) =>
    collection.actions.map(
      (action) => `${collection.name}/${action.target}:${action.name}:${action.action}`,
    ),
  );
const optionsOf = async (collection) =>
  (await mongo.db.listCollections({ name: collection }).toArray())[0]?.options;
const indexNames = async (collection) =>
  (await mongo.db.collection(collection).listIndexes().toArray())
    .map((index) => index.name)
    .filter((name) => name !== '_id_')
    .sort();

/** Converge, then prove the database is at a fixed point: a second plan finds nothing */
async function convergeToFixedPoint(collections, options = {}) {
  const result = await kitWith({ collections }).converge(options);
  assert.strictEqual(result.inSync, true, JSON.stringify(result.unstable));
  const replan = await kitWith({ collections }).converge({ ...options, dryRun: true });
  assert.strictEqual(replan.changed, 0, JSON.stringify(rows(replan)));
  return result;
}

/** Whether the server accepts `doc` into `collection` */
async function accepts(collection, doc) {
  try {
    await mongo.db.collection(collection).insertOne(doc);
    return true;
  } catch (error) {
    if (error.code === 121) return false;
    throw error;
  }
}

describe('converge (integration) — versioning', () => {
  it('should reach a fixed point with a validator synthesized for versioning alone', async () => {
    await convergeToFixedPoint([{ name: 'orders', versioning: { current: 2 } }]);
    const options = await optionsOf('orders');
    assert.strictEqual(options.validationLevel, 'moderate');
    assert.deepStrictEqual(await indexNames('orders'), ['__v_1__id_1']);
    assert.ok(await accepts('orders', { __v: 2, __rev: 0 }));
    assert.ok(await accepts('orders', { __v: 7, __rev: 0 }), 'no maximum: a newer release writes');
    assert.ok(!(await accepts('orders', { __v: 0, __rev: 0 })), 'below min');
    assert.ok(!(await accepts('orders', { __rev: 0 })), 'version required');
    assert.ok(!(await accepts('orders', { __v: 1 })), 'revision required');
    assert.ok(!(await accepts('orders', { __v: 1.5, __rev: 0 })), 'not an int');
  });

  it('should reach a fixed point merged into a declared $jsonSchema', async () => {
    await convergeToFixedPoint([
      {
        name: 'orders',
        versioning: { current: 1, field: 'schemaVersion', revision: false },
        validator: {
          $jsonSchema: { required: ['total'], properties: { total: { bsonType: 'int' } } },
        },
      },
    ]);
    const options = await optionsOf('orders');
    assert.strictEqual(options.validationLevel, 'strict');
    assert.deepStrictEqual(options.validator.$jsonSchema.required, ['total', 'schemaVersion']);
    assert.ok(await accepts('orders', { total: 1, schemaVersion: 1 }));
    assert.ok(!(await accepts('orders', { total: 1 })));
    assert.ok(!(await accepts('orders', { schemaVersion: 1 })));
  });

  it('should reach a fixed point next to query operators — the server combines both', async () => {
    await convergeToFixedPoint([
      {
        name: 'orders',
        versioning: { current: 1 },
        validator: { status: { $in: ['open', 'closed'] } },
      },
    ]);
    assert.ok(await accepts('orders', { status: 'open', __v: 1, __rev: 0 }));
    assert.ok(!(await accepts('orders', { status: 'lost', __v: 1, __rev: 0 })), 'query rule');
    assert.ok(!(await accepts('orders', { status: 'open' })), 'versioning rule');
  });

  it('should keep a legacy document updatable under the synthesized moderate level', async () => {
    await convergeToFixedPoint([{ name: 'orders', versioning: { current: 1 } }]);
    // A document that predates the rules (here: one that bypassed them).
    await mongo.db
      .collection('orders')
      .insertOne({ _id: 1, name: 'legacy' }, { bypassDocumentValidation: true });
    const result = await mongo.db
      .collection('orders')
      .updateOne({ _id: 1 }, { $set: { name: 'still legacy' } });
    assert.strictEqual(result.modifiedCount, 1);
  });

  it('should type the fields without requiring them for min 0', async () => {
    await convergeToFixedPoint([{ name: 'orders', versioning: { current: 1, min: 0 } }]);
    assert.ok(await accepts('orders', { name: 'no version yet' }));
    assert.ok(!(await accepts('orders', { __v: 'one' })));
  });

  it('should leave the other indexes alone under prune when only versioning declares one', async () => {
    await mongo.db.collection('orders').createIndex({ customerId: 1 });
    await mongo.db.collection('orders').createIndex({ createdAt: -1 }, { name: 'recent' });
    const result = await convergeToFixedPoint([{ name: 'orders', versioning: { current: 1 } }], {
      prune: true,
    });
    assert.deepStrictEqual(await indexNames('orders'), ['__v_1__id_1', 'customerId_1', 'recent']);
    assert.ok(!rows(result).some((line) => line.includes(':drop')));
  });

  it('should prune next to the version index when indexes are declared', async () => {
    await mongo.db.collection('orders').createIndex({ customerId: 1 });
    await convergeToFixedPoint(
      [{ name: 'orders', versioning: { current: 1 }, indexes: [{ key: { total: 1 } }] }],
      { prune: true },
    );
    assert.deepStrictEqual(await indexNames('orders'), ['__v_1__id_1', 'total_1']);
  });

  it('should raise the version floor when current and min move forward', async () => {
    await convergeToFixedPoint([{ name: 'orders', versioning: { current: 1, min: 0 } }]);
    await convergeToFixedPoint([{ name: 'orders', versioning: { current: 2, min: 1 } }]);
    const { validator } = await optionsOf('orders');
    assert.strictEqual(validator.$jsonSchema.properties.__v.minimum, 1);
  });

  it('should refuse adopting versioning with min 1 over unversioned documents, writing nothing', async () => {
    await mongo.db.collection('orders').insertMany([{ name: 'a' }, { name: 'b' }]);
    await assert.rejects(
      kitWith({ collections: [{ name: 'orders', versioning: { current: 1 } }] }).converge(),
      (error) => {
        assert.ok(error instanceof ConvergeFailedError);
        assert.strictEqual(error.context.phase, 'plan');
        assert.match(error.message, /documents below version 1 remain/);
        return true;
      },
    );
    assert.strictEqual((await optionsOf('orders')).validator, undefined);
    assert.deepStrictEqual(await indexNames('orders'), []);
  });

  it('should adopt with min 0, then raise min once every document is upgraded', async () => {
    const orders = mongo.db.collection('orders');
    await orders.insertMany([{ name: 'a' }, { name: 'b', __v: 0 }]);
    await convergeToFixedPoint([{ name: 'orders', versioning: { current: 1, min: 0 } }]);

    // `converge --check` is a dry run: a floor that cannot rise yet is drift.
    const check = await kitWith({
      collections: [{ name: 'orders', versioning: { current: 1, min: 1 } }],
    }).converge({ dryRun: true });
    assert.strictEqual(check.inSync, false);
    assert.ok(rows(check).includes('orders/validator:orders:conflict'));

    await orders.updateMany({}, { $set: { __v: 1 }, $inc: { __rev: 1 } });
    await convergeToFixedPoint([{ name: 'orders', versioning: { current: 1, min: 1 } }]);
    assert.ok(!(await accepts('orders', { name: 'c', __v: 0, __rev: 0 })));
  });

  it('should refuse raising min while one document of a large collection lags behind', async () => {
    const orders = mongo.db.collection('orders');
    await convergeToFixedPoint([{ name: 'orders', versioning: { current: 2, min: 1 } }]);
    const docs = [];
    for (let i = 0; i < 500; i++) docs.push({ i, __v: 2, __rev: 0 });
    docs.push({ i: 500, __v: 1, __rev: 3 });
    await orders.insertMany(docs);
    const plan = await kitWith({
      collections: [{ name: 'orders', versioning: { current: 2, min: 2 } }],
    }).converge({ dryRun: true });
    assert.ok(rows(plan).includes('orders/validator:orders:conflict'));
    await orders.updateOne({ i: 500 }, { $set: { __v: 2 }, $inc: { __rev: 1 } });
    await convergeToFixedPoint([{ name: 'orders', versioning: { current: 2, min: 2 } }]);
  });
});
