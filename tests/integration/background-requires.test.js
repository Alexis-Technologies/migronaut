const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { runMigrations } = require('../../src/core/run.js');
const { BackgroundPendingError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_background_requires_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  await mongo.db.collection('orders').createIndex({ __v: 1, _id: 1 });
  await mongo.db
    .collection('orders')
    .insertMany(Array.from({ length: 50 }, (_, i) => ({ __v: 1, __rev: 0, address: `A${i}` })));
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

const V2 = `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  pauseMs: 0,
  migrate: ({ address, ...doc }) => ({ ...doc, shipping: { address } }),
};
`;
const V3 = `export const requires = ['0001-orders-v2.js'];
export const background = {
  collection: 'orders',
  from: 2,
  to: 3,
  pauseMs: 0,
  migrate: (doc) => ({ ...doc, v3: true }),
};
`;
const CONTRACT = `export const requires = ['0001-orders-v2.js'];
export async function up({ db }) {
  await db.collection('orders').updateMany({}, { $unset: { legacy: '' } });
  await db.collection('contracted').insertOne({ at: new Date() });
}
export async function down() {}
`;

const changelog = () => mongo.db.collection('_migronaut_migrations');

describe('requires — a migration waits for background migrations (integration)', () => {
  it('should refuse a contract migration before its hooks run, leaving no trace', async () => {
    const hooks = [];
    const kit = kitWith({
      hooks: { beforeEach: async (name) => hooks.push(name) },
    });
    project.write('0001-orders-v2.js', V2);
    project.write('0002-contract.js', CONTRACT);
    await assert.rejects(kit.up(), (error) => {
      assert.ok(error instanceof BackgroundPendingError);
      assert.strictEqual(error.code, 'BACKGROUND_PENDING');
      assert.deepStrictEqual(error.context.waitsFor, [
        { migration: '0001-orders-v2.js', status: 'pending' },
      ]);
      assert.deepStrictEqual(
        error.context.results.map((row) => row.file),
        ['0001-orders-v2.js'],
      );
      return true;
    });
    assert.deepStrictEqual(hooks, ['0001-orders-v2.js'], 'no beforeEach for the contract');
    assert.strictEqual(
      await changelog().findOne({ name: '0002-contract.js' }),
      null,
      'no failed trace',
    );
    assert.strictEqual(await mongo.db.collection('contracted').countDocuments(), 0);

    await kit.runBackground('0001-orders-v2.js');
    const results = await kit.up();
    assert.deepStrictEqual(
      results.map((row) => row.file),
      ['0002-contract.js'],
    );
    assert.strictEqual(await mongo.db.collection('contracted').countDocuments(), 1);
  });

  it('should stop the line cleanly with onBackgroundPending: stop', async () => {
    project = makeProject();
    project.write('0001-orders-v2.js', V2);
    project.write('0002-contract.js', CONTRACT);
    project.write('0003-after.js', insertMigration('markers', 'after'));
    const summary = await runMigrations(
      { uri: mongo.uri, dbName: DB, migrationsDir: project.dir, logger: null },
      { onBackgroundPending: 'stop' },
    );
    assert.deepStrictEqual(
      summary.applied.map((row) => row.file),
      ['0001-orders-v2.js'],
    );
    assert.strictEqual(summary.upToDate, false);
    assert.deepStrictEqual(summary.waiting, [
      {
        migration: '0002-contract.js',
        waitsFor: [{ migration: '0001-orders-v2.js', status: 'pending' }],
      },
    ]);
    assert.strictEqual(
      await mongo.db.collection('markers').countDocuments(),
      0,
      'nothing after it',
    );
  });

  it('should register a background migration blocked behind another and unblock it on completion', async () => {
    const kit = kitWith();
    project.write('0001-orders-v2.js', V2);
    project.write('0002-orders-v3.js', V3);
    await kit.up();
    assert.strictEqual((await kit.backgroundStatus('0002-orders-v3.js')).status, 'blocked');
    assert.deepStrictEqual(
      (await kit.runnableBackground()).map((row) => row.migration),
      ['0001-orders-v2.js'],
    );
    await kit.runBackground('0001-orders-v2.js');
    assert.strictEqual((await kit.backgroundStatus('0002-orders-v3.js')).status, 'pending');
    await kit.runBackground('0002-orders-v3.js');
    assert.strictEqual(
      await mongo.db.collection('orders').countDocuments({ __v: 3, v3: true }),
      50,
    );
  });

  it('should reopen a completed one whose collection holds old shapes again, and wait for it', async () => {
    const kit = kitWith();
    project.write('0001-orders-v2.js', V2);
    await kit.up();
    await kit.runBackground('0001-orders-v2.js');
    // An old pod wrote the old shape after completion.
    await mongo.db.collection('orders').insertOne({ __v: 1, __rev: 0, address: 'late' });
    project.write('0002-contract.js', CONTRACT);
    const drift = [];
    kit.on('background:drift', (event) => drift.push(event));
    await assert.rejects(kit.up(), (error) => {
      assert.deepStrictEqual(error.context.waitsFor, [
        { migration: '0001-orders-v2.js', status: 'running' },
      ]);
      return true;
    });
    assert.strictEqual(drift[0].action, 'reopened');
    assert.strictEqual((await kit.backgroundStatus('0001-orders-v2.js')).status, 'running');
    await kit.runBackground('0001-orders-v2.js');
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 1 }), 0);
    await kit.up();
  });

  it('should run background migrations to the end inside up, in inline mode', async () => {
    const kit = kitWith({ backgroundInline: true });
    project.write('0001-orders-v2.js', V2);
    project.write('0002-orders-v3.js', V3);
    project.write(
      '0003-contract.js',
      CONTRACT.replace("'0001-orders-v2.js'", "'0002-orders-v3.js'"),
    );
    const results = await kit.up();
    assert.deepStrictEqual(
      results.map((row) => row.file),
      ['0001-orders-v2.js', '0002-orders-v3.js', '0003-contract.js'],
    );
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 3 }), 50);
    assert.strictEqual((await kit.backgroundStatus('0002-orders-v3.js')).status, 'completed');
    assert.strictEqual(await mongo.db.collection('contracted').countDocuments(), 1);
  });

  it('should let a baselined record satisfy requires', async () => {
    const kit = kitWith();
    project.write('0001-orders-v2.js', V2);
    project.write('0002-contract.js', CONTRACT);
    await kit.baseline({ to: '0001-orders-v2.js' });
    const results = await kit.up();
    assert.deepStrictEqual(
      results.map((row) => row.file),
      ['0002-contract.js'],
    );
  });

  it('should preview background files and what each waits for, writing nothing', async () => {
    const kit = kitWith();
    project.write('0001-orders-v2.js', V2);
    project.write('0002-contract.js', CONTRACT);
    const rows = await kit.dryRun('up');
    assert.deepStrictEqual(
      rows.map((row) => ({
        file: row.file,
        kind: row.kind,
        requires: row.requires,
        waitsFor: row.waitsFor,
      })),
      [
        { file: '0001-orders-v2.js', kind: 'background', requires: undefined, waitsFor: undefined },
        {
          file: '0002-contract.js',
          kind: undefined,
          requires: ['0001-orders-v2.js'],
          waitsFor: ['0001-orders-v2.js'],
        },
      ],
    );
    assert.strictEqual(await mongo.db.collection('_migronaut_background').countDocuments(), 0);
  });
});
