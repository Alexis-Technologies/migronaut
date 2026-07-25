const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { ConfigInvalidError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_dryrun_test';

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

describe('MigratorKit.dryRun (integration)', () => {
  it('should list pending migrations for up without touching the DB', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const rows = await migrator.dryRun('up');
    assert.deepStrictEqual(
      rows.map((r) => r.file),
      ['0001-a.ts', '0002-b.ts'],
    );
    assert.strictEqual(
      rows.every((r) => r.status === 'pending'),
      true,
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 0);
  });

  it('should list the last batch for down', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    const rows = await migrator.dryRun('down');
    assert.deepStrictEqual(
      rows.map((r) => r.file),
      ['0001-a.ts'],
    );
  });

  it('should preview the last N migrations for down with steps, newest first', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));
    await migrator.up('0001-a.ts');
    await migrator.up();
    const rows = await migrator.dryRun('down', undefined, { steps: 2 });
    assert.deepStrictEqual(
      rows.map((r) => r.file),
      ['0003-c.ts', '0002-b.ts'],
    );
    // preview only — nothing reverted
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 3);
  });

  it('should reject dry-run down --steps combined with a filename', async () => {
    setup();
    await assert.rejects(migrator.dryRun('down', '0001-a.ts', { steps: 1 }), ConfigInvalidError);
  });

  it('should leave DB state unchanged after a dry-run', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    const before = await mongo.db.collection('things').countDocuments();
    await migrator.dryRun('up');
    await migrator.dryRun('down');
    const after = await mongo.db.collection('things').countDocuments();
    assert.strictEqual(after, before);
  });
});
