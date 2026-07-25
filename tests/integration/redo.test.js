const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { Changelog } = require('../../src/core/changelog.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_redo_test';

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

describe('MigratorKit.redo (integration)', () => {
  it('should redo the last applied migration', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await migrator.up();
    const results = await migrator.redo();
    assert.deepStrictEqual(
      results.map((r) => r.status),
      ['reverted', 'applied'],
    );
    assert.strictEqual(
      results.every((r) => r.file === '0002-b.ts'),
      true,
    );
    // still applied afterwards
    const changelog = new Changelog('_migronaut_migrations');
    const record = await changelog.getByName(mongo.db, '0002-b.ts');
    assert.strictEqual(record?.status, 'applied');
  });

  it('should redo a specific file', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    const results = await migrator.redo('0001-a.ts');
    assert.deepStrictEqual(
      results.map((r) => r.status),
      ['reverted', 'applied'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should report nothing to redo when no migrations are applied', async () => {
    setup();
    const results = await migrator.redo();
    assert.deepStrictEqual(results, []);
  });
});
