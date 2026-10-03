const path = require('node:path');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { ConfigInvalidError, ConvergeFailedError } = require('../../src/errors/index.js');
const { runMigrations } = require('../../src/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_converge_after_up_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
});

let project;
let migrator;

afterEach(async () => {
  await migrator?.disconnect();
  migrator = undefined;
  project?.cleanup();
});

const COLLECTIONS = [{ name: 'things', indexes: [{ key: { marker: 1 }, unique: true }] }];

function setup(overrides = {}) {
  project = makeProject();
  project.write('0001-a.js', insertMigration('things', 'a'));
  project.write('0002-b.js', insertMigration('things', 'b'));
  migrator = makeMigrator(mongo.uri, DB, project.dir, {
    collections: COLLECTIONS,
    convergeAfterUp: true,
    ...overrides,
  });
  return migrator;
}

const indexNames = async (collection) =>
  (await mongo.db.collection(collection).listIndexes().toArray())
    .map((index) => index.name)
    .filter((name) => name !== '_id_');
const appliedNames = async () =>
  (await mongo.db.collection('_migronaut_migrations').find({ status: 'applied' }).toArray())
    .map((record) => record.name)
    .sort();

function recordEvents(kit) {
  const events = [];
  for (const name of ['run:start', 'run:end', 'converge:start', 'converge:end']) {
    kit.on(name, (payload) => events.push([name, payload]));
  }
  return events;
}

describe('convergeAfterUp (integration)', () => {
  it('should converge after the migrations, under the same run and lock', async () => {
    const kit = setup();
    const events = recordEvents(kit);
    const results = await kit.up();
    // up() still returns exactly the migration rows.
    assert.deepStrictEqual(
      results.map((row) => row.status),
      ['applied', 'applied'],
    );
    assert.deepStrictEqual(await indexNames('things'), ['marker_1']);
    assert.deepStrictEqual(
      events.map(([name]) => name),
      ['run:start', 'converge:start', 'converge:end', 'run:end'],
    );
    const runId = events[0][1].runId;
    assert.ok(events.every(([, payload]) => payload.runId === runId));
    assert.strictEqual(events[1][1].trigger, 'up');
    assert.strictEqual(events.at(-1)[1].applied, 2);
  });

  it('should converge even when nothing was pending', async () => {
    const kit = setup();
    await kit.up(undefined, { converge: false });
    assert.deepStrictEqual(await indexNames('things'), []);
    assert.deepStrictEqual(await kit.up(), []);
    assert.deepStrictEqual(await indexNames('things'), ['marker_1']);
  });

  it('should keep the migrations applied when the converge fails, and retry on the next up', async () => {
    const kit = setup({
      collections: [{ name: 'things', indexes: [{ key: { kind: 1 }, unique: true }] }],
    });
    // Both migrations insert a document without `kind`: a unique index over
    // two missing values fails to build.
    await assert.rejects(kit.up(), (error) => {
      assert.ok(error instanceof ConvergeFailedError);
      assert.deepStrictEqual(
        error.context.results.map((row) => row.file),
        ['0001-a.js', '0002-b.js'],
      );
      assert.strictEqual(error.context.mongoCode, 11000);
      return true;
    });
    assert.deepStrictEqual(await appliedNames(), ['0001-a.js', '0002-b.js']);

    await mongo.db.collection('things').updateOne({ marker: 'b' }, { $set: { kind: 'b' } });
    await mongo.db.collection('things').updateOne({ marker: 'a' }, { $set: { kind: 'a' } });
    assert.deepStrictEqual(await kit.up(), []);
    assert.deepStrictEqual(await indexNames('things'), ['kind_1']);
  });

  it('should count the applied migrations in run:end when the converge fails', async () => {
    const kit = setup({
      collections: [{ name: 'things', indexes: [{ key: { kind: 1 }, unique: true }] }],
    });
    const events = recordEvents(kit);
    await assert.rejects(kit.up(), ConvergeFailedError);
    const end = events.find(([name]) => name === 'run:end')[1];
    assert.strictEqual(end.success, false);
    assert.strictEqual(end.applied, 2);
  });

  it('should never converge after a single-file up, an up --to, or a redo', async () => {
    const kit = setup();
    await kit.up('0001-a.js');
    await kit.up(undefined, { to: '0002-b.js' });
    await kit.redo();
    assert.deepStrictEqual(await indexNames('things'), []);
  });

  it('should converge on request without convergeAfterUp', async () => {
    const kit = setup({ convergeAfterUp: false });
    await kit.up(undefined, { converge: true });
    assert.deepStrictEqual(await indexNames('things'), ['marker_1']);
  });

  it('should fail before any migration when a definition file is broken', async () => {
    project = makeProject();
    project.write('0001-a.js', insertMigration('things', 'a'));
    const dir = path.join(project.dir, 'collections');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'things.json'), '{ nope');
    migrator = makeMigrator(mongo.uri, DB, project.dir, {
      collectionsDir: dir,
      convergeAfterUp: true,
    });
    await assert.rejects(migrator.up(), ConfigInvalidError);
    assert.deepStrictEqual(await appliedNames(), []);
  });

  it('should not even read a broken collectionsDir for a plain up', async () => {
    project = makeProject();
    project.write('0001-a.js', insertMigration('things', 'a'));
    migrator = makeMigrator(mongo.uri, DB, project.dir, {
      collectionsDir: path.join(project.dir, 'does-not-exist'),
    });
    assert.strictEqual((await migrator.up()).length, 1);
  });

  it('should point a bulk up preview at converge instead of guessing', async () => {
    const lines = [];
    const logger = {
      debug() {},
      info: (message) => lines.push(message),
      warn() {},
      error() {},
    };
    const kit = setup({ logger });
    await kit.dryRun('up');
    assert.ok(lines.some((line) => /Converge after up is not previewed/.test(line)));
    lines.length = 0;
    await kit.dryRun('up', undefined, { to: '0001-a.js' });
    assert.ok(!lines.some((line) => /Converge after up/.test(line)));
  });

  it('should hand the converge result to runMigrations callers', async () => {
    project = makeProject();
    project.write('0001-a.js', insertMigration('things', 'a'));
    const summary = await runMigrations({
      uri: mongo.uri,
      dbName: DB,
      migrationsDir: project.dir,
      logger: null,
      collections: COLLECTIONS,
      convergeAfterUp: true,
    });
    assert.strictEqual(summary.applied.length, 1);
    assert.strictEqual(summary.converge.inSync, true);
    assert.strictEqual(summary.converge.changed, 1);
    const plain = await runMigrations({
      uri: mongo.uri,
      dbName: DB,
      migrationsDir: project.dir,
      logger: null,
    });
    assert.ok(!('converge' in plain));
  });
});
