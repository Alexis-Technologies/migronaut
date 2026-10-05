const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { ConfigInvalidError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_background_dry_run_test';
const NAME = '0001-orders.js';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  await mongo.db
    .collection('orders')
    .insertMany(
      Array.from({ length: 10 }, (_, i) => ({ _id: i, __v: 1, __rev: 0, address: `A${i}`, i })),
    );
  await mongo.db.createCollection('side');
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

const raw = () => mongo.db.collection('orders').find().sort({ _id: 1 }).toArray();

describe('dry runs of background migrations (integration)', () => {
  it('should preview the first documents before and after, for an unregistered file', async () => {
    const kit = kitWith();
    project.write(
      NAME,
      `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  migrate: (doc) => {
    if (doc.i === 1) throw new Error('cannot parse');
    const { address, ...rest } = doc;
    return { ...rest, shipping: { address } };
  },
};
`,
    );
    const before = await raw();
    const preview = await kit.dryRunBackground(NAME, { first: 3 });
    assert.deepStrictEqual(
      { method: preview.method, requested: preview.requested, found: preview.found },
      { method: 'first', requested: 3, found: 3 },
    );
    assert.strictEqual(preview.migrated, 2);
    assert.strictEqual(preview.failed, 1);
    const [first, second] = preview.documents;
    assert.strictEqual(first._id, 0);
    assert.deepStrictEqual(first.after.shipping, { address: 'A0' });
    assert.strictEqual(first.after.__v, 2);
    assert.strictEqual(first.after.__rev, 1);
    assert.strictEqual(first.after.address, undefined);
    assert.deepStrictEqual(first.change.$unset, { address: '' });
    assert.strictEqual(second.error, 'cannot parse');
    const sample = await kit.dryRunBackground(NAME, { sample: 4 });
    assert.strictEqual(sample.method, 'sample');
    assert.strictEqual(sample.found, 4);
    assert.deepStrictEqual(await raw(), before, 'nothing written');
    assert.strictEqual(await mongo.db.collection('_migronaut_background').countDocuments(), 0);
  });

  it('should validate through the real write path — validator refusals per document, side writes rolled back', async () => {
    await mongo.db.command({
      collMod: 'orders',
      validator: { $jsonSchema: { properties: { shipping: { bsonType: 'object' } } } },
    });
    const kit = kitWith();
    project.write(
      NAME,
      `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  transaction: true,
  migrate: async (doc, ctx) => {
    await ctx.db.collection('side').insertOne({ of: doc._id }, { session: ctx.session });
    const { address, ...rest } = doc;
    // Two documents break the validator.
    return { ...rest, shipping: doc.i === 3 || doc.i === 7 ? 'flat' : { address } };
  },
};
`,
    );
    const before = await raw();
    const preview = await kit.dryRunBackground(NAME, { first: 10, validate: true });
    assert.strictEqual(preview.validated, true);
    assert.strictEqual(preview.migrated, 8);
    assert.strictEqual(preview.failed, 2);
    const failed = preview.documents.filter((row) => row.validation === 'failed');
    assert.deepStrictEqual(
      failed.map((row) => row._id),
      [3, 7],
    );
    assert.match(failed[0].error, /failed validation/i);
    const ok = preview.documents.find((row) => row._id === 0);
    assert.strictEqual(ok.validation, 'ok');
    assert.deepStrictEqual(ok.after.shipping, { address: 'A0' });
    assert.strictEqual(ok.after.__v, 2);
    // One sandbox per write failure, not per document.
    assert.ok(preview.attempts <= 3, `sandboxes: ${preview.attempts}`);
    assert.ok(preview.ops.some((op) => op.collection === 'side' && op.method === 'insertOne'));
    assert.ok(preview.sideEffects.some((doc) => doc.collection === 'side' && doc.op === 'insert'));
    assert.strictEqual(
      await mongo.db.collection('side').countDocuments(),
      0,
      'side writes rolled back',
    );
    assert.deepStrictEqual(await raw(), before, 'collection unchanged');
  });

  it('should refuse the wrong kind of dry run and a sample out of range', async () => {
    const kit = kitWith();
    project.write(
      NAME,
      `export const background = { collection: 'orders', from: 1, to: 2, migrate: (d) => d };\n`,
    );
    await assert.rejects(kit.dryRunBackground(NAME, { steps: 2 }), ConfigInvalidError);
    await assert.rejects(kit.dryRunBackground(NAME, { sample: 0 }), /1 to 1000/);
    await assert.rejects(kit.dryRunBackground(NAME, { sample: 2, first: 2 }), /not both/);
    await assert.rejects(kit.dryRunBackground(NAME, { direction: 'revert' }), /no revert/);
    await assert.rejects(kit.dryRunBackground('missing.js'), /not found/i);
  });
});

describe('dry runs of step migrations (integration)', () => {
  const STEP = `export const background = {
  collection: 'orders',
  step: async ({ checkpoint, db }) => {
    const n = checkpoint ?? 0;
    const orders = db.collection('orders');
    // Each step sees what the one before wrote, in the same transaction.
    const seen = await orders.countDocuments({ touched: true });
    await orders.updateOne({ _id: n }, { $set: { touched: true, seen } });
    if (n === 0) {
      await orders.updateMany({ i: { $gte: 8 } }, { $set: { tail: true } });
      await orders.replaceOne({ _id: 5 }, { __v: 2, replaced: true });
      await orders.deleteMany({ i: { $in: [6, 7] } });
      await orders.insertMany([{ _id: 100 }, { _id: 101 }]);
      await orders.bulkWrite([
        { updateOne: { filter: { _id: 4 }, update: { $set: { bulk: 1 } } } },
        { insertOne: { document: { _id: 102 } } },
      ]);
      await orders.findOneAndUpdate({ _id: 3 }, { $set: { found: true } });
      await orders.updateOne({ _id: 200 }, { $set: { upserted: true } }, { upsert: true });
    }
    return { checkpoint: n + 1, done: n === 4, processed: 1 };
  },
};
`;

  it('should chain checkpoints over steps that see their own writes, leaving the collection as it was', async () => {
    const kit = kitWith();
    project.write(NAME, STEP);
    const before = await raw();
    const report = await kit.dryRunBackground(NAME, { steps: 3, maxDocuments: 50 });
    assert.strictEqual(report.mode, 'step');
    assert.strictEqual(report.ok, true, report.error);
    assert.strictEqual(report.stoppedBy, 'steps');
    assert.deepStrictEqual(
      report.steps.map((entry) => [entry.checkpointIn, entry.checkpointOut, entry.done]),
      [
        [null, 1, false],
        [1, 2, false],
        [2, 3, false],
      ],
    );
    const byKey = new Map(report.documents.map((doc) => [JSON.stringify(doc._id), doc]));
    assert.strictEqual(byKey.get('0').op, 'update');
    assert.strictEqual(byKey.get('2').after.seen, 2, 'the third step saw the two before it');
    assert.strictEqual(byKey.get('5').after.replaced, true);
    assert.strictEqual(byKey.get('6').op, 'delete');
    assert.strictEqual(byKey.get('100').op, 'insert');
    assert.strictEqual(byKey.get('102').op, 'insert');
    assert.strictEqual(byKey.get('4').after.bulk, 1);
    assert.strictEqual(byKey.get('3').after.found, true);
    assert.strictEqual(byKey.get('200').after.upserted, true);
    assert.strictEqual(byKey.get('8').after.tail, true);
    assert.deepStrictEqual(await raw(), before, 'byte for byte the same collection');
    const done = await kit.dryRunBackground(NAME, { steps: 10 });
    assert.strictEqual(done.stoppedBy, 'done');
    assert.strictEqual(done.steps.length, 5);
  });

  it('should start from the pinned checkpoint, or from the start', async () => {
    const kit = kitWith();
    project.write(NAME, STEP);
    await kit.up();
    await kit.coordinateBackground(NAME);
    await kit.runBackgroundSlice(NAME, { sliceMs: 1000 });
    const status = await kit.backgroundStatus(NAME);
    assert.strictEqual(status.status, 'running');
    const resumed = await kit.dryRunBackground(NAME);
    assert.notStrictEqual(resumed.steps[0].checkpointIn, null);
    const fresh = await kit.dryRunBackground(NAME, { fromStart: true });
    assert.strictEqual(fresh.steps[0].checkpointIn, null);
  });

  it('should refuse DDL in a step, and stop at a thrown error or the deadline', async () => {
    const kit = kitWith({ reloadMigrations: true });
    project.write(
      NAME,
      `export const background = {
  step: async ({ db }) => {
    await db.collection('orders').createIndex({ i: 1 }).catch(() => undefined);
    return { checkpoint: null, done: true };
  },
};
`,
    );
    const refused = await kit.dryRunBackground(NAME);
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.refusals[0].method, 'collection.createIndex');
    const indexes = await mongo.db.collection('orders').indexes();
    assert.deepStrictEqual(
      indexes.map((index) => index.name),
      ['_id_'],
      'no index was created',
    );

    project.write(
      NAME,
      `export const background = { step: async () => { throw new Error('step broke'); } };\n`,
    );
    const broke = await kit.dryRunBackground(NAME);
    assert.strictEqual(broke.ok, false);
    assert.strictEqual(broke.steps[0].error, 'step broke');

    project.write(
      NAME,
      `export const background = {
  step: () => new Promise((resolve) => setTimeout(() => resolve({ checkpoint: 1, done: false }), 5000)),
};
`,
    );
    const slow = await kit.dryRunBackground(NAME, { deadlineMs: 100 });
    assert.strictEqual(slow.stoppedBy, 'deadline');
    await assert.rejects(kit.dryRunBackground(NAME, { steps: 51 }), /1 to 50/);
    await assert.rejects(kit.dryRunBackground(NAME, { validate: true }), /by steps/);
  });

  it('should run the whole sandbox again after a write conflict', async () => {
    const kit = kitWith();
    project.write(
      NAME,
      `export const background = {
  step: async ({ db }) => {
    const orders = db.collection('orders');
    await orders.findOne({ _id: 0 });
    if (!globalThis.__conflicted) {
      globalThis.__conflicted = true;
      await globalThis.__outside();
    }
    await orders.updateOne({ _id: 0 }, { $set: { inside: true } });
    return { checkpoint: null, done: true };
  },
};
`,
    );
    globalThis.__outside = () =>
      mongo.db.collection('orders').updateOne({ _id: 0 }, { $set: { outside: true } });
    try {
      const report = await kit.dryRunBackground(NAME);
      assert.strictEqual(report.attempts, 2);
      assert.strictEqual(report.ok, true, report.error);
      assert.strictEqual(
        (await mongo.db.collection('orders').findOne({ _id: 0 })).inside,
        undefined,
      );
    } finally {
      delete globalThis.__outside;
      delete globalThis.__conflicted;
    }
  });
});
