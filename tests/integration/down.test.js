const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { Changelog } = require('../../src/core/changelog.js');
const {
  ConfigInvalidError,
  MigrationInvalidNameError,
  NotAppliedError,
} = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');
const { makeRecord } = require('../helpers/records.js');

let mongo;
const DB = 'migronaut_down_test';

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
  project?.cleanup();
});

function setup() {
  project = makeProject();
  migrator = makeMigrator(mongo.uri, DB, project.dir);
}

describe('MigratorKit.down (integration)', () => {
  it('should refuse a path-traversing name even from a crafted applied record', async () => {
    setup();
    // Simulate a tampered changelog record whose name escapes the migrations dir.
    // The down preflight must reject it before loading/executing any file.
    const collection = new Changelog('_migronaut_migrations');
    await migrator.connect();
    await collection.markApplied(mongo.db, makeRecord({ name: '../../evil.js', batch: 1 }));
    await assert.rejects(migrator.down('../../evil.js'), MigrationInvalidNameError);
  });

  it('should revert the last batch', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await migrator.up();
    const results = await migrator.down();
    assert.strictEqual(
      results.every((r) => r.status === 'reverted'),
      true,
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
  });

  it('should revert a single file by name', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await migrator.up();
    const results = await migrator.down('0001-a.ts');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.file, '0001-a.ts');
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should throw NotAppliedError when reverting an unapplied file', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await assert.rejects(migrator.down('0001-a.ts'), NotAppliedError);
  });

  it('should mark records reverted while preserving history', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    await migrator.down('0001-a.ts');
    const changelog = new Changelog('_migronaut_migrations');
    const record = await changelog.getByName(mongo.db, '0001-a.ts');
    assert.strictEqual(record?.status, 'reverted');
    assert.ok(record?.revertedAt instanceof Date);
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 1);
  });

  it('should report nothing to rollback when no batch is applied', async () => {
    setup();
    const results = await migrator.down();
    assert.deepStrictEqual(results, []);
  });

  it('should revert the last N migrations with steps, newest first, ignoring batches', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));
    // Two separate runs → batch 1 holds a, batch 2 holds b+c.
    await migrator.up('0001-a.ts');
    await migrator.up();
    const results = await migrator.down(undefined, { steps: 2 });
    assert.deepStrictEqual(
      results.map((r) => r.file),
      ['0003-c.ts', '0002-b.ts'],
    );
    // 0001-a.ts (batch 1) is untouched even though steps crossed into batch 2.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should revert just the last applied file with steps=1', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await migrator.up();
    const results = await migrator.down(undefined, { steps: 1 });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.file, '0002-b.ts');
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should clamp steps to the number of applied migrations', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    const results = await migrator.down(undefined, { steps: 5 });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
  });

  it('should reject steps combined with a filename', async () => {
    setup();
    await assert.rejects(migrator.down('0001-a.ts', { steps: 1 }), ConfigInvalidError);
  });

  it('should reject steps combined with batch', async () => {
    setup();
    await assert.rejects(migrator.down(undefined, { steps: 1, batch: 1 }), ConfigInvalidError);
  });

  it('should reject a non-positive steps value', async () => {
    setup();
    await assert.rejects(migrator.down(undefined, { steps: 0 }), ConfigInvalidError);
  });
});
