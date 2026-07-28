const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_status_test';

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

describe('MigratorKit.status (integration)', () => {
  it('should report checksumOk=true for unchanged applied files', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    const rows = await migrator.status();
    assert.strictEqual(rows[0]?.status, 'applied');
    assert.strictEqual(rows[0]?.checksumOk, true);
  });

  it('should report checksumOk=false for tampered applied files', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    project.tamper('0001-a.ts');
    const rows = await migrator.status();
    assert.strictEqual(rows[0]?.checksumOk, false);
  });

  it('should report checksumOk=null for pending files', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const rows = await migrator.status();
    assert.strictEqual(rows[0]?.status, 'pending');
    assert.strictEqual(rows[0]?.checksumOk, null);
  });

  it('should filter applied and pending via list()', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await migrator.up('0001-a.ts');
    assert.deepStrictEqual(
      (await migrator.list('applied')).map((r) => r.file),
      ['0001-a.ts'],
    );
    assert.deepStrictEqual(
      (await migrator.list('pending')).map((r) => r.file),
      ['0002-b.ts'],
    );
    assert.strictEqual((await migrator.list('all')).length, 2);
  });
});
