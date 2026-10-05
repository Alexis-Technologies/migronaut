const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { BackgroundStore } = require('../../src/core/background-store.js');
const {
  IrreversibleMigrationError,
  MigrationInvalidExportError,
} = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_background_register_test';

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

const store = () => new BackgroundStore(mongo.db, '_migronaut_background');

const BACKGROUND = `export const description = 'Move address into shipping';
export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  migrate: ({ address, ...doc }) => ({ ...doc, shipping: { address } }),
  revert: ({ shipping, ...doc }) => ({ ...doc, address: shipping.address }),
};
`;

const ONE_WAY = `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  migrate: (doc) => ({ ...doc, done: true }),
};
`;

describe('background migrations in up and down (integration)', () => {
  it('should register on up — the documents untouched — and record the file as background', async () => {
    const kit = kitWith();
    project.write('0001-orders.js', BACKGROUND);
    await mongo.db.collection('orders').insertOne({ __v: 1, address: 'x' });
    const events = [];
    kit.on('background:registered', (event) => events.push(event));
    const results = await kit.up();
    assert.deepStrictEqual(
      results.map((row) => [row.file, row.status]),
      [['0001-orders.js', 'applied']],
    );
    const state = await store().get('0001-orders.js');
    assert.strictEqual(state.status, 'pending');
    assert.strictEqual(state.direction, 'forward');
    assert.strictEqual(state.spec.collection, 'orders');
    assert.strictEqual(state.description, 'Move address into shipping');
    assert.match(state.checksum, /^[0-9a-f]{64}$/);
    assert.strictEqual(
      (await mongo.db.collection('orders').findOne()).__v,
      1,
      'nothing rewritten yet',
    );
    const record = await mongo.db
      .collection('_migronaut_migrations')
      .findOne({ name: '0001-orders.js' });
    assert.strictEqual(record.kind, 'background');
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(
      { migration: events[0].migration, status: events[0].status, direction: events[0].direction },
      { migration: '0001-orders.js', status: 'pending', direction: 'forward' },
    );
    assert.strictEqual(typeof events[0].runId, 'string');
    const [row] = await kit.status();
    assert.strictEqual(row.kind, 'background');
  });

  it('should register blocked behind what it requires, in a transaction with its record', async () => {
    const kit = kitWith({ useTransaction: true });
    project.write('0001-orders.js', BACKGROUND);
    project.write(
      '0002-orders-v3.js',
      `export const requires = ['0001-orders.js'];
export const background = { collection: 'orders', from: 2, to: 3, migrate: (doc) => doc };
`,
    );
    await kit.up();
    const blocked = await store().get('0002-orders-v3.js');
    assert.strictEqual(blocked.status, 'blocked');
    assert.deepStrictEqual(blocked.waitsFor, ['0001-orders.js']);
    assert.deepStrictEqual(blocked.requires, ['0001-orders.js']);
  });

  it('should refuse a requires that is not a background migration, writing nothing', async () => {
    const kit = kitWith();
    project.write('0001-plain.js', insertMigration('markers', 'a'));
    project.write(
      '0002-bg.js',
      `export const requires = ['0001-plain.js'];
export const background = { collection: 'orders', from: 1, to: 2, migrate: (doc) => doc };
`,
    );
    await assert.rejects(kit.up(), (error) => {
      assert.ok(error instanceof MigrationInvalidExportError);
      assert.match(error.message, /not a background migration/);
      return true;
    });
    assert.strictEqual(await store().get('0002-bg.js'), null);
  });

  it('should refuse an invalid spec, and one that targets a migronaut collection', async () => {
    const kit = kitWith();
    project.write('0001-bad.js', `export const background = { collection: 'orders', from: 1 };\n`);
    await assert.rejects(kit.up(), /Invalid background migration 0001-bad\.js/);
    // Rewritten in place: a fresh import, past the ESM cache.
    const other = kitWith({ reloadMigrations: true });
    project.write(
      '0001-bad.js',
      `export const background = { collection: '_migronaut_locks', from: 1, to: 2, migrate: (d) => d };\n`,
    );
    await assert.rejects(other.up(), /one of migronaut's own collections/);
  });

  it('should take the field names and the version check from the declared collection', async () => {
    const kit = kitWith({
      collections: [{ name: 'orders', versioning: { current: 2, field: 'schemaVersion' } }],
    });
    project.write('0001-orders.js', BACKGROUND);
    await kit.up();
    assert.strictEqual((await store().get('0001-orders.js')).spec.field, 'schemaVersion');
    project.write(
      '0002-too-far.js',
      `export const background = { collection: 'orders', from: 2, to: 3, migrate: (d) => d };\n`,
    );
    await assert.rejects(
      kitWith({ collections: [{ name: 'orders', versioning: { current: 2 } }] }).up(),
      /raise current first/,
    );
  });

  it('should register the way back on down, and register forward again on up --force and redo', async () => {
    const kit = kitWith();
    project.write('0001-orders.js', BACKGROUND);
    await kit.up();
    const first = await store().get('0001-orders.js');
    const reverted = await kit.down();
    assert.deepStrictEqual(
      reverted.map((row) => row.status),
      ['reverted'],
    );
    const back = await store().get('0001-orders.js');
    assert.strictEqual(back.direction, 'revert');
    assert.strictEqual(back.status, 'pending');
    assert.notStrictEqual(back.registration, first.registration);

    await kit.up();
    const again = await store().get('0001-orders.js');
    assert.strictEqual(again.direction, 'forward');
    await kit.up('0001-orders.js', { force: true });
    assert.notStrictEqual((await store().get('0001-orders.js')).registration, again.registration);
    await kit.redo();
    assert.strictEqual((await store().get('0001-orders.js')).direction, 'forward');
  });

  it('should withdraw a one-way background migration on down only while nothing was rewritten', async () => {
    const kit = kitWith();
    project.write('0001-orders.js', ONE_WAY);
    await kit.up();
    await kit.down();
    assert.strictEqual(await store().get('0001-orders.js'), null, 'withdrawn');
    await kit.up();
    // Some documents were rewritten since.
    await mongo.db
      .collection('_migronaut_background')
      .updateOne({ _id: '0001-orders.js' }, { $set: { 'totals.migrated': 5 } });
    await assert.rejects(kit.down(), (error) => {
      assert.ok(
        error instanceof IrreversibleMigrationError ||
          error.cause instanceof IrreversibleMigrationError,
      );
      return true;
    });
    assert.notStrictEqual(await store().get('0001-orders.js'), null);
    const record = await mongo.db
      .collection('_migronaut_migrations')
      .findOne({ name: '0001-orders.js' });
    assert.strictEqual(record.status, 'applied', 'the refused down left it applied');
  });

  it('should refuse a file with both background and up/down', async () => {
    const kit = kitWith();
    project.write(
      '0001-mixed.js',
      `export async function up() {}
export async function down() {}
export const background = { collection: 'orders', from: 1, to: 2, migrate: (d) => d };
`,
    );
    await assert.rejects(kit.up(), /exports no up\(\) or down\(\)/);
  });
});
