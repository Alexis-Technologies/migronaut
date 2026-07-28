const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it, mock } = require('node:test');
const { MigrationExecutionFailedError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const {
  failingMigration,
  insertMigration,
  makeMigrator,
  makeProject,
} = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_hooks_test';

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

describe('lifecycle hooks (integration)', () => {
  it('should fire onError when a migration fails', async () => {
    project = makeProject();
    const onError = mock.fn(() => Promise.resolve(undefined));
    migrator = makeMigrator(mongo.uri, DB, project.dir, { hooks: { onError } });
    project.write('0001-bad.ts', failingMigration());
    await assert.rejects(migrator.up(), MigrationExecutionFailedError);
    assert.strictEqual(onError.mock.callCount(), 1);
    assert.strictEqual(onError.mock.calls[0]?.arguments[0], '0001-bad.ts');
  });

  it('should revert a specific batch with down({ batch })', async () => {
    project = makeProject();
    migrator = makeMigrator(mongo.uri, DB, project.dir);
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await migrator.up();
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
    const results = await migrator.down(undefined, { batch: 1 });
    assert.deepStrictEqual(
      results.map((r) => r.file),
      ['0001-a.ts'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should skip the lock when noLock is true', async () => {
    project = makeProject();
    migrator = makeMigrator(mongo.uri, DB, project.dir);
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up(undefined, { noLock: true });
    assert.strictEqual(await mongo.db.collection('_migronaut_locks').countDocuments(), 0);
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });
});
