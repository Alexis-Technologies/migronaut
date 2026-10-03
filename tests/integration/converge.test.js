const path = require('node:path');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const {
  ConfigInvalidError,
  ConvergeFailedError,
  LockAlreadyHeldError,
  MigrationBlockedError,
} = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_converge_test';

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

function kitWith(overrides = {}, kitOptions = {}) {
  project ??= makeProject();
  const kit = makeMigrator(mongo.uri, DB, project.dir, overrides, kitOptions);
  kits.push(kit);
  return kit;
}

const indexesOf = async (collection) =>
  (await mongo.db.collection(collection).listIndexes().toArray()).filter(
    (index) => index.name !== '_id_',
  );
const indexNames = async (collection) => (await indexesOf(collection)).map((index) => index.name);
const optionsOf = async (collection) =>
  (await mongo.db.listCollections({ name: collection }).toArray())[0]?.options;
const rows = (result) =>
  result.collections.flatMap((collection) =>
    collection.actions.map(
      (action) => `${collection.name}/${action.target}:${action.name}:${action.action}`,
    ),
  );

/** Converge, then prove the database is at a fixed point: a second plan finds nothing */
async function convergeToFixedPoint(collections, options = {}) {
  const result = await kitWith({ collections }).converge(options);
  assert.strictEqual(result.inSync, true, JSON.stringify(result.unstable));
  const replan = await kitWith({ collections }).converge({ ...options, dryRun: true });
  assert.strictEqual(replan.changed, 0, JSON.stringify(rows(replan)));
  assert.strictEqual(replan.inSync, true);
  return result;
}

describe('converge (integration) — every kind of index reaches a fixed point', () => {
  const kinds = [
    ['plain', { key: { email: 1 } }, 'email_1'],
    ['compound, dotted, descending', { key: { 'a.b': 1, c: -1 } }, 'a.b_1_c_-1'],
    ['unique', { key: { u: 1 }, unique: true }, 'u_1'],
    ['sparse', { key: { s: 1 }, sparse: true }, 's_1'],
    ['explicitly not unique', { key: { n: 1 }, unique: false, sparse: false }, 'n_1'],
    ['TTL', { key: { createdAt: 1 }, expireAfterSeconds: 3600 }, 'createdAt_1'],
    ['TTL of zero', { key: { expiresAt: 1 }, expireAfterSeconds: 0 }, 'expiresAt_1'],
    ['partial', { key: { p: 1 }, partialFilterExpression: { p: { $exists: true } } }, 'p_1'],
    ['collated', { key: { name: 1 }, collation: { locale: 'en', strength: 2 } }, 'name_1'],
    ['hidden', { key: { h: 1 }, hidden: true }, 'h_1'],
    ['text', { key: { title: 'text' } }, 'title_text'],
    [
      'weighted compound text',
      {
        key: { tag: 1, title: 'text', body: 'text' },
        weights: { title: 5 },
        default_language: 'none',
      },
      'tag_1_title_text_body_text',
    ],
    ['hashed', { key: { hashedField: 'hashed' } }, 'hashedField_hashed'],
    ['2dsphere', { key: { loc: '2dsphere' } }, 'loc_2dsphere'],
    ['2d', { key: { flat: '2d' }, bits: 26, min: -180, max: 180 }, 'flat_2d'],
    [
      'wildcard with a projection',
      { key: { '$**': 1 }, wildcardProjection: { secret: 0 } },
      '$**_1',
    ],
    ['wildcard on a path', { key: { 'meta.$**': 1 } }, 'meta.$**_1'],
    ['named', { key: { x: 1 }, name: 'custom_name' }, 'custom_name'],
    [
      'keyed by a Map',
      {
        key: new Map([
          ['z', 1],
          ['a', -1],
        ]),
      },
      'z_1_a_-1',
    ],
  ];

  for (const [label, index, expectedName] of kinds) {
    it(`should create a ${label} index under MongoDB's own name and then leave it alone`, async () => {
      const result = await convergeToFixedPoint([{ name: 'things', indexes: [index] }]);
      assert.deepStrictEqual(rows(result), [
        'things/collection:things:create',
        `things/index:${expectedName}:create`,
      ]);
      assert.deepStrictEqual(await indexNames('things'), [expectedName]);
    });
  }

  it('should name an index exactly as the driver would when left to choose', async () => {
    const keys = [{ q: 1, r: -1 }, { s: 'hashed' }, { 'm.$**': 1 }];
    for (const key of keys) await mongo.db.collection('driver').createIndex(key);
    const driverNames = await indexNames('driver');
    await convergeToFixedPoint([{ name: 'ours', indexes: keys.map((key) => ({ key })) }]);
    assert.deepStrictEqual(await indexNames('ours'), driverNames);
  });

  it("should leave an index alone that carries the collection's default collation", async () => {
    await mongo.db.createCollection('french', { collation: { locale: 'fr' } });
    await convergeToFixedPoint([
      {
        name: 'french',
        indexes: [{ key: { a: 1 } }, { key: { b: 1 }, collation: { locale: 'simple' } }],
      },
    ]);
    const indexes = await indexesOf('french');
    assert.strictEqual(indexes[0].collation.locale, 'fr');
    assert.strictEqual(indexes[1].collation, undefined);
  });

  it('should leave the clustered index of a clustered collection out of everything', async () => {
    await mongo.db.createCollection('clustered', {
      clusteredIndex: { key: { _id: 1 }, unique: true, name: 'cluster' },
    });
    const result = await convergeToFixedPoint(
      [{ name: 'clustered', indexes: [{ key: { a: 1 } }] }],
      { prune: true },
    );
    assert.deepStrictEqual(rows(result), ['clustered/index:a_1:create']);
  });
});

describe('converge (integration) — changes', () => {
  const base = { key: { t: 1 }, expireAfterSeconds: 3600 };

  it('should change a TTL and a hidden flag in place', async () => {
    await convergeToFixedPoint([{ name: 'c', indexes: [base, { key: { h: 1 } }] }]);
    const result = await convergeToFixedPoint([
      {
        name: 'c',
        indexes: [
          { ...base, expireAfterSeconds: 60 },
          { key: { h: 1 }, hidden: true },
        ],
      },
    ]);
    assert.deepStrictEqual(rows(result), ['c/index:t_1:modify', 'c/index:h_1:modify']);
    const [ttl, hidden] = await indexesOf('c');
    assert.strictEqual(ttl.expireAfterSeconds, 60);
    assert.strictEqual(hidden.hidden, true);
  });

  it('should rebuild an index whose options changed', async () => {
    await convergeToFixedPoint([{ name: 'c', indexes: [{ key: { a: 1 } }] }]);
    const result = await convergeToFixedPoint([
      { name: 'c', indexes: [{ key: { a: 1 }, unique: true }] },
    ]);
    assert.deepStrictEqual(rows(result), ['c/index:a_1:recreate']);
    assert.strictEqual((await indexesOf('c'))[0].unique, true);
  });

  it('should put the old index back when a unique rebuild meets duplicates', async () => {
    await mongo.db.collection('dups').insertMany([{ x: 1 }, { x: 1 }]);
    await mongo.db.collection('dups').createIndex({ x: 1 });
    const kit = kitWith({
      collections: [{ name: 'dups', indexes: [{ key: { x: 1 }, unique: true }] }],
    });
    await assert.rejects(kit.converge(), (error) => {
      assert.ok(error instanceof ConvergeFailedError);
      assert.strictEqual(error.context.mongoCode, 11000);
      assert.strictEqual(error.context.restored, true);
      assert.match(error.context.hint, /deduplicate/);
      return true;
    });
    const [restored] = await indexesOf('dups');
    assert.strictEqual(restored.name, 'x_1');
    assert.strictEqual(restored.unique, undefined);
  });

  it('should restore a text index from the form the server reports', async () => {
    await mongo.db.collection('docs').createIndex({ k: 1, body: 'text' }, { name: 'search' });
    // Valid to migronaut, refused by the server — after the old index is gone.
    const kit = kitWith({
      collections: [
        {
          name: 'docs',
          indexes: [{ key: { k: 1, body: 'text' }, name: 'search', default_language: 'klingon' }],
        },
      ],
    });
    await assert.rejects(kit.converge(), (error) => {
      assert.strictEqual(error.context.action, 'recreate');
      assert.strictEqual(error.context.restored, true);
      return true;
    });
    const [restored] = await indexesOf('docs');
    assert.deepStrictEqual(
      [restored.name, restored.key, restored.default_language],
      ['search', { k: 1, _fts: 'text', _ftsx: 1 }, 'english'],
    );
  });

  it('should keep undeclared indexes without prune and drop them with it', async () => {
    await mongo.db.collection('c').createIndex({ stray: 1 });
    const collections = [{ name: 'c', indexes: [{ key: { a: 1 } }] }];
    const kept = await convergeToFixedPoint(collections);
    assert.deepStrictEqual(rows(kept), ['c/index:a_1:create', 'c/index:stray_1:keep']);
    const pruned = await convergeToFixedPoint(collections, { prune: true });
    assert.deepStrictEqual(rows(pruned), ['c/index:a_1:unchanged', 'c/index:stray_1:drop']);
    assert.deepStrictEqual(await indexNames('c'), ['a_1']);
  });

  it("should let a definition's own prune win over the call's", async () => {
    await mongo.db.collection('c').createIndex({ stray: 1 });
    await convergeToFixedPoint([{ name: 'c', indexes: [], prune: false }], { prune: true });
    assert.deepStrictEqual(await indexNames('c'), ['stray_1']);
  });

  it('should accept an identical index under another name, and rename it only with prune', async () => {
    await mongo.db.collection('c').createIndex({ email: 1 }, { name: 'by_email', unique: true });
    const collections = [{ name: 'c', indexes: [{ key: { email: 1 }, unique: true }] }];
    const kept = await convergeToFixedPoint(collections);
    assert.deepStrictEqual(rows(kept), ['c/index:email_1:unchanged']);
    assert.deepStrictEqual(await indexNames('c'), ['by_email']);
    await convergeToFixedPoint(collections, { prune: true });
    assert.deepStrictEqual(await indexNames('c'), ['email_1']);
  });

  it('should refuse a conflict without touching the database', async () => {
    await mongo.db.collection('c').createIndex({ email: 1 }, { name: 'by_email' });
    await mongo.db.collection('c').createIndex({ stray: 1 });
    const kit = kitWith({
      collections: [
        { name: 'c', indexes: [{ key: { email: 1 }, unique: true }, { key: { b: 1 } }] },
      ],
    });
    await assert.rejects(kit.converge(), (error) => {
      assert.ok(error instanceof ConvergeFailedError);
      assert.strictEqual(error.context.phase, 'plan');
      return true;
    });
    assert.deepStrictEqual(await indexNames('c'), ['by_email', 'stray_1']);
    // With prune the conflict is resolved by replacing the undeclared index —
    // after the plain create, since a rebuild runs after every create.
    await convergeToFixedPoint(
      [{ name: 'c', indexes: [{ key: { email: 1 }, unique: true }, { key: { b: 1 } }] }],
      { prune: true },
    );
    assert.deepStrictEqual(await indexNames('c'), ['b_1', 'email_1']);
  });

  it('should swap two indexes that trade keys', async () => {
    await convergeToFixedPoint([
      {
        name: 'c',
        indexes: [
          { key: { a: 1 }, name: 'x' },
          { key: { b: 1 }, name: 'y' },
        ],
      },
    ]);
    await convergeToFixedPoint([
      {
        name: 'c',
        indexes: [
          { key: { b: 1 }, name: 'x' },
          { key: { a: 1 }, name: 'y' },
        ],
      },
    ]);
    const [x, y] = await indexesOf('c');
    assert.deepStrictEqual([x.name, x.key], ['x', { b: 1 }]);
    assert.deepStrictEqual([y.name, y.key], ['y', { a: 1 }]);
  });
});

describe('converge (integration) — validators', () => {
  const schema = { $jsonSchema: { bsonType: 'object', required: ['email'] } };

  it('should create a collection with its validator, then change and remove it', async () => {
    const created = await convergeToFixedPoint([{ name: 'v', validator: schema }]);
    assert.deepStrictEqual(rows(created), ['v/collection:v:create', 'v/validator:v:create']);
    await assert.rejects(
      mongo.db.collection('v').insertOne({ other: 1 }),
      /Document failed validation/,
    );

    const changed = await convergeToFixedPoint([
      { name: 'v', validator: schema, validationLevel: 'moderate', validationAction: 'warn' },
    ]);
    assert.deepStrictEqual(rows(changed), ['v/validator:v:modify']);
    const options = await optionsOf('v');
    assert.strictEqual(options.validationLevel, 'moderate');
    assert.strictEqual(options.validationAction, 'warn');

    const removed = await convergeToFixedPoint([{ name: 'v', validator: null }]);
    assert.deepStrictEqual(rows(removed), ['v/validator:v:drop']);
    assert.strictEqual((await optionsOf('v')).validator, undefined);
    await mongo.db.collection('v').insertOne({ other: 1 });
  });

  it('should add a validator to an existing collection and leave an unmanaged one alone', async () => {
    await mongo.db.createCollection('existing', { validator: { a: { $exists: true } } });
    await convergeToFixedPoint([{ name: 'existing', indexes: [{ key: { a: 1 } }] }]);
    assert.deepStrictEqual((await optionsOf('existing')).validator, { a: { $exists: true } });
    await convergeToFixedPoint([{ name: 'existing', validator: schema }]);
    assert.deepStrictEqual((await optionsOf('existing')).validator, schema);
  });

  it('should refuse a view and a time-series collection', async () => {
    await mongo.db.createCollection('base');
    await mongo.db.createCollection('view', { viewOn: 'base', pipeline: [] });
    await mongo.db.createCollection('series', { timeseries: { timeField: 't' } });
    const kit = kitWith({
      collections: [
        { name: 'view', indexes: [] },
        { name: 'series', validator: null },
      ],
    });
    const plan = await kit.converge({ dryRun: true });
    assert.deepStrictEqual(rows(plan), [
      'view/collection:view:conflict',
      'series/collection:series:conflict',
    ]);
    assert.strictEqual(plan.inSync, false);
    await assert.rejects(kit.converge(), ConvergeFailedError);
  });
});

describe('converge (integration) — the run', () => {
  const collections = [{ name: 'c', indexes: [{ key: { a: 1 } }] }];

  it('should leave no lock and change nothing in a dry run', async () => {
    const kit = kitWith({ collections });
    const plan = await kit.converge({ dryRun: true });
    assert.deepStrictEqual(rows(plan), ['c/collection:c:create', 'c/index:a_1:create']);
    assert.strictEqual(plan.dryRun, true);
    assert.deepStrictEqual(await mongo.db.listCollections({ name: 'c' }).toArray(), []);
    assert.strictEqual(await mongo.db.collection('_migronaut_locks').countDocuments(), 0);
  });

  it('should hold the migration lock and announce itself as a converge run', async () => {
    const kit = kitWith({ collections });
    const events = [];
    for (const name of [
      'run:start',
      'run:end',
      'converge:start',
      'converge:end',
      'lock:acquired',
    ]) {
      kit.on(name, (payload) => events.push([name, payload]));
    }
    await kit.converge();
    assert.deepStrictEqual(
      events.map(([name]) => name),
      ['run:start', 'lock:acquired', 'converge:start', 'converge:end', 'run:end'],
    );
    assert.strictEqual(events[0][1].command, 'converge');
    assert.strictEqual(events[2][1].runId, events[0][1].runId);
    assert.strictEqual(events.at(-1)[1].success, true);
  });

  it('should be refused while another run holds the lock', async () => {
    await mongo.db.collection('_migronaut_locks').insertOne({
      _id: 'migronaut_lock',
      lockedAt: new Date(),
      pid: 4242,
      host: 'elsewhere',
      executedBy: 'other',
      owner: 'someone-else',
    });
    await assert.rejects(kitWith({ collections }).converge(), LockAlreadyHeldError);
    // A dry run takes no lock, so it still works.
    assert.strictEqual((await kitWith({ collections }).converge({ dryRun: true })).changed, 2);
  });

  it('should refuse an ordered converge while a migration is pending', async () => {
    project = makeProject();
    project.write('0001-a.js', insertMigration('things', 'a'));
    const kit = kitWith({ collections });
    await assert.rejects(kit.converge({ ordered: true }), (error) => {
      assert.ok(error instanceof MigrationBlockedError);
      assert.deepStrictEqual(error.context.blockedBy, ['0001-a.js']);
      return true;
    });
    await kit.up();
    assert.strictEqual((await kit.converge({ ordered: true })).changed, 2);
  });

  it('should stop between steps when stopped', async () => {
    const kit = kitWith({
      collections: [
        { name: 'c', indexes: [{ key: { a: 1 } }, { key: { b: 1 } }, { key: { d: 1 } }] },
      ],
    });
    kit.once('converge:action', () => kit.stop('enough'));
    await assert.rejects(kit.converge(), (error) => {
      assert.strictEqual(error.code, 'RUN_ABORTED');
      const statuses = error.context.converge.collections[0].actions.map((action) => action.status);
      assert.deepStrictEqual(statuses, ['applied', 'skipped', 'skipped', 'skipped']);
      return true;
    });
    assert.deepStrictEqual(await indexNames('c'), []);
  });

  it('should load definitions from collectionsDir next to the inline ones', async () => {
    project = makeProject();
    const dir = path.join(project.dir, 'collections');
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, 'orders.json'),
      JSON.stringify({ indexes: [{ key: { total: -1 } }] }),
    );
    writeFileSync(
      path.join(dir, 'audit.js'),
      "export default { name: 'audit.events', validator: { at: { $exists: true } } };\n",
    );
    const result = await kitWith({ collections, collectionsDir: dir }).converge();
    assert.deepStrictEqual(
      result.collections.map((collection) => collection.name),
      ['c', 'audit.events', 'orders'],
    );
    assert.deepStrictEqual(await indexNames('orders'), ['total_-1']);
    assert.deepStrictEqual((await optionsOf('audit.events')).validator, { at: { $exists: true } });
  });

  it('should refuse a definition file that does not validate, before taking the lock', async () => {
    project = makeProject();
    const dir = path.join(project.dir, 'collections');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ indexes: [{ key: {} }] }));
    const kit = kitWith({ collectionsDir: dir });
    await assert.rejects(kit.converge(), (error) => {
      assert.ok(error instanceof ConfigInvalidError);
      assert.deepStrictEqual(
        error.context.issues.map((issue) => issue.path),
        ['bad.json: indexes[0].key'],
      );
      return true;
    });
    assert.strictEqual(await mongo.db.collection('_migronaut_locks').countDocuments(), 0);
  });
});
