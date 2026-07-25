const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const {
  ChecksumMismatchError,
  MigrationExecutionFailedError,
  MigrationInvalidNameError,
} = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const {
  failingMigration,
  insertMigration,
  makeMigrator,
  makeProject,
} = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_up_test';

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

describe('MigratorKit.up (integration)', () => {
  it('should reject a path-traversing filename instead of loading outside the dir', async () => {
    setup();
    // A real secret a traversal could try to read/execute; it must never be touched.
    await assert.rejects(migrator.up('../../etc/passwd'), MigrationInvalidNameError);
    await assert.rejects(migrator.up('sub/dir/0001-a.ts'), MigrationInvalidNameError);
    await assert.rejects(migrator.up('..'), MigrationInvalidNameError);
  });

  it('should run all pending migrations', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const results = await migrator.up();
    assert.deepStrictEqual(
      results.map((r) => r.status),
      ['applied', 'applied'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
  });

  it('should share one batch number across a run', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const results = await migrator.up();
    assert.strictEqual(results[0]?.batch, 1);
    assert.strictEqual(results[1]?.batch, 1);
  });

  it('should give each file its own batch with step=true', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));
    const results = await migrator.up(undefined, { step: true });
    assert.deepStrictEqual(
      results.map((r) => r.batch),
      [1, 2, 3],
    );
  });

  it('should continue step batch numbering after an earlier run', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));
    const results = await migrator.up(undefined, { step: true });
    assert.deepStrictEqual(
      results.map((r) => r.batch),
      [2, 3],
    );
  });

  it('should run a single file by name', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const results = await migrator.up('0001-a.ts');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.file, '0001-a.ts');
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should skip already-applied migrations on a second run', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    const second = await migrator.up();
    assert.deepStrictEqual(second, []);
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should re-run an already-applied migration when force is true', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);

    const results = await migrator.up('0001-a.ts', { force: true });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]?.status, 'applied');
    // up() inserts again, so the marker doc count grows — proof it re-ran
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
  });

  it('should re-run with force (not skip) even when the file checksum changed', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    project.tamper('0001-a.ts');

    // strict=false would normally skip an applied file with a changed checksum;
    // force overrides that and re-applies it instead.
    const results = await migrator.up('0001-a.ts', { force: true });
    assert.strictEqual(results[0]?.status, 'applied');
  });

  it('should warn and skip on checksum mismatch when strict=false', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    project.tamper('0001-a.ts');
    const results = await migrator.up('0001-a.ts');
    assert.strictEqual(results[0]?.status, 'skipped');
  });

  it('should throw on checksum mismatch when strict=true', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    await migrator.disconnect();
    project.tamper('0001-a.ts');
    const strict = makeMigrator(mongo.uri, DB, project.dir, { strict: true });
    await assert.rejects(strict.up('0001-a.ts'), ChecksumMismatchError);
    await strict.disconnect();
  });

  it('should stop the batch on the first error', async () => {
    setup();
    project.write('0001-ok.ts', insertMigration('things', 'ok'));
    project.write('0002-bad.ts', failingMigration());
    project.write('0003-never.ts', insertMigration('things', 'never'));
    await assert.rejects(migrator.up(), MigrationExecutionFailedError);
    // first applied, third never ran
    const applied = await migrator.list('applied');
    assert.deepStrictEqual(
      applied.map((r) => r.file),
      ['0001-ok.ts'],
    );
  });

  it('should fire hooks in the correct order', async () => {
    project = makeProject();
    const calls = [];
    migrator = makeMigrator(mongo.uri, DB, project.dir, {
      hooks: {
        beforeAll: async () => {
          calls.push('beforeAll');
        },
        beforeEach: async (name) => {
          calls.push(`beforeEach:${name}`);
        },
        afterEach: async (name) => {
          calls.push(`afterEach:${name}`);
        },
        afterAll: async () => {
          calls.push('afterAll');
        },
      },
    });
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    assert.deepStrictEqual(calls, [
      'beforeAll',
      'beforeEach:0001-a.ts',
      'afterEach:0001-a.ts',
      'afterAll',
    ]);
  });
});
