const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { BackgroundFailedError } = require('../../src/errors/index.js');
const { updateWithRevision } = require('../../versioning.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_background_transaction_test';
const NAME = '0001-orders.js';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  await mongo.db.collection('orders').createIndex({ __v: 1, _id: 1 });
  // Collections a transaction writes to must exist before it starts on older servers.
  await mongo.db.createCollection('side');
});

const kits = [];
let project;

afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.disconnect();
  project?.cleanup();
  project = undefined;
  for (const key of ['__txnHook']) delete globalThis[key];
});

function kitWith(uri = mongo.uri, dbName = DB, overrides = {}) {
  project ??= makeProject();
  const kit = makeMigrator(uri, dbName, project.dir, overrides);
  kits.push(kit);
  return kit;
}

const TRANSACTIONAL = `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  pauseMs: 0,
  transaction: { timeoutMs: 5000, maxRetries: 8 },
  batchSize: 50,
  maxDocumentErrors: 100,
  migrate: async (doc, ctx) => {
    await ctx.db.collection('side').insertOne({ of: doc._id }, { session: ctx.session });
    await globalThis.__txnHook?.(doc, ctx);
    const { address, ...rest } = doc;
    return { ...rest, shipping: { address } };
  },
};
`;

async function seed(count) {
  await mongo.db
    .collection('orders')
    .insertMany(
      Array.from({ length: count }, (_, i) => ({ __v: 1, __rev: 0, address: `A${i}`, i })),
    );
}

const transient = () =>
  Object.assign(new Error('injected transient error'), {
    errorLabels: ['TransientTransactionError'],
    hasErrorLabel: (label) => label === 'TransientTransactionError',
  });

describe('transactional background migrations (integration)', () => {
  it('should count exactly and write each side effect once, through retries and a write storm', async () => {
    await seed(400);
    const kit = kitWith();
    project.write(NAME, TRANSACTIONAL);
    await kit.up();
    const thrown = new Set();
    globalThis.__txnHook = async (doc) => {
      // After the side write: the whole batch must roll back with it.
      if (doc.i % 37 === 5 && !thrown.has(doc.i)) {
        thrown.add(doc.i);
        throw transient();
      }
    };
    const orders = mongo.db.collection('orders');
    const storming = { on: true };
    const storm = (async () => {
      while (storming.on) {
        const doc = await orders.findOne({ i: Math.floor(Math.random() * 400) });
        await updateWithRevision(orders, { _id: doc._id }, doc.__rev ?? 0, {
          $set: { touched: true },
        }).catch(() => undefined);
      }
    })();
    const status = await kit.runBackground(NAME);
    storming.on = false;
    await storm;
    assert.strictEqual(status.status, 'completed');
    assert.strictEqual(status.totals.migrated, 400, 'exactly once');
    assert.ok(status.totals.txnRetries >= thrown.size, `retries: ${status.totals.txnRetries}`);
    assert.strictEqual(await mongo.db.collection('side').countDocuments(), 400);
    assert.strictEqual(
      (await mongo.db.collection('side').distinct('of')).length,
      400,
      'one side write per document',
    );
    assert.strictEqual(await orders.countDocuments({ __v: 2 }), 400);
  });

  it('should retry a batch a concurrent write conflicted with', async () => {
    await seed(60);
    const kit = kitWith();
    project.write(NAME, TRANSACTIONAL);
    await kit.up();
    let hit = false;
    globalThis.__txnHook = async (doc) => {
      if (!hit && doc.i === 3) {
        hit = true;
        // The application writes the document the transaction already read.
        await mongo.db.collection('orders').updateOne({ _id: doc._id }, { $inc: { __rev: 1 } });
      }
    };
    const status = await kit.runBackground(NAME);
    assert.strictEqual(status.status, 'completed');
    assert.ok(status.totals.txnRetries > 0);
    assert.strictEqual(await mongo.db.collection('side').countDocuments(), 60);
    const doc = await mongo.db.collection('orders').findOne({ i: 3 });
    assert.strictEqual(doc.__rev, 2, 'the application write and ours, both');
  });

  it('should commit nothing for a lane that lost its lease mid-transaction', async () => {
    await seed(30);
    const kit = kitWith();
    project.write(NAME, TRANSACTIONAL);
    await kit.up();
    await kit.coordinateBackground(NAME);
    globalThis.__txnHook = async () => {
      await mongo.db
        .collection('_migronaut_background_partitions')
        .updateMany({}, { $unset: { lease: '' } });
    };
    const slice = await kit.runBackgroundSlice(NAME);
    assert.strictEqual(slice.outcome, 'lost');
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 2 }), 0);
    assert.strictEqual(await mongo.db.collection('side').countDocuments(), 0);
    delete globalThis.__txnHook;
    assert.strictEqual((await kit.runBackground(NAME)).status, 'completed');
    assert.strictEqual(await mongo.db.collection('side').countDocuments(), 30);
  });

  it('should fail a document alone, its side write rolled back, and the rest commit', async () => {
    await seed(40);
    const kit = kitWith();
    project.write(NAME, TRANSACTIONAL);
    await kit.up();
    globalThis.__txnHook = async (doc) => {
      if (doc.i === 10) throw new Error('bad document');
    };
    const status = await kit.runBackground(NAME);
    assert.strictEqual(status.status, 'completed');
    assert.strictEqual(status.failedDocuments, 1);
    assert.strictEqual(status.totals.migrated, 39);
    assert.strictEqual(await mongo.db.collection('side').countDocuments(), 39);
    assert.strictEqual((await mongo.db.collection('orders').findOne({ i: 10 })).__v, 1);
  });

  it('should halve a batch that runs out of time and go on', async () => {
    await seed(200);
    const kit = kitWith(mongo.uri, DB);
    project.write(NAME, TRANSACTIONAL);
    await kit.up();
    // The engine's reads time out twice, then the server recovers.
    const slow = new MongoClient(mongo.uri, { appName: 'txn-slow' });
    await slow.connect();
    await kitWith().coordinateBackground(NAME);
    await mongo.client.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 2 },
      data: {
        failCommands: ['find'],
        errorCode: 50,
        appName: 'txn-slow',
        namespace: `${DB}.orders`,
      },
    });
    try {
      // A kit on that client: its finds are the ones that fail.
      const throughSlow = makeMigrator(undefined, DB, project.dir, { client: slow });
      kits.push(throughSlow);
      const status = await throughSlow.runBackground(NAME);
      assert.strictEqual(status.status, 'completed');
      assert.ok(status.totals.txnRetries >= 2);
      assert.ok(status.totals.batches > 200 / 50, `smaller batches: ${status.totals.batches}`);
    } finally {
      await mongo.client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
      await slow.close();
    }
  });

  it('should run a step migration in a transaction with its checkpoint', async () => {
    const kit = kitWith();
    project.write(
      NAME,
      `export const background = {
  collection: 'side',
  transaction: true,
  step: async ({ checkpoint, db, session }) => {
    const n = checkpoint ?? 0;
    await db.collection('side').insertOne({ n }, { session });
    return { checkpoint: n + 1, done: n === 4, processed: 1 };
  },
};
`,
    );
    await kit.up();
    const status = await kit.runBackground(NAME);
    assert.strictEqual(status.status, 'completed');
    assert.strictEqual(await mongo.db.collection('side').countDocuments(), 5);
  });
});

describe('transactional background migrations on a standalone server (integration)', () => {
  let standalone;
  let client;

  before(async () => {
    standalone = await MongoMemoryServer.create();
    client = new MongoClient(standalone.getUri());
    await client.connect();
  });

  after(async () => {
    await client.close();
    await standalone.stop();
  });

  it('should fail with TRANSACTIONS_UNSUPPORTED, writing nothing', async () => {
    const db = client.db('standalone_bg');
    await db.collection('orders').insertMany([{ __v: 1, address: 'x' }]);
    const kit = kitWith(standalone.getUri(), 'standalone_bg');
    project.write(NAME, TRANSACTIONAL);
    await kit.up();
    await assert.rejects(kit.runBackground(NAME), (error) => {
      assert.ok(error instanceof BackgroundFailedError);
      assert.match(error.message, /need a replica set or a mongos/);
      return true;
    });
    assert.strictEqual((await db.collection('orders').findOne()).__v, 1);
    const status = await kit.backgroundStatus(NAME);
    assert.strictEqual(status.status, 'failed');
    assert.match(status.lastError, /standalone/);
  });
});
