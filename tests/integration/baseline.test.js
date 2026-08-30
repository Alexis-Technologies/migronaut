const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const {
  IrreversibleMigrationError,
  MigrationFileNotFoundError,
} = require('../../src/errors/index.js');
const { computeChecksum } = require('../../src/utils/checksum.js');
const path = require('node:path');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_baseline_test';
const TARGET = '_migronaut_migrations';

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

function records() {
  return mongo.db.collection(TARGET).find().sort({ name: 1 }).toArray();
}

describe('MigratorKit.baseline (integration)', () => {
  it('should mark files as applied without executing them', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));

    const summary = await migrator.baseline();
    assert.deepStrictEqual(summary.baselined, ['0001-a.ts', '0002-b.ts']);
    assert.strictEqual(summary.skipped, 0);
    assert.strictEqual(typeof summary.batch, 'number');

    // Nothing executed: the marker collection stays empty.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);

    const docs = await records();
    assert.strictEqual(docs.length, 2);
    for (const doc of docs) {
      assert.strictEqual(doc.status, 'applied');
      assert.strictEqual(doc.origin, 'baseline');
      assert.strictEqual(doc.batch, summary.batch);
      assert.strictEqual(doc.duration, 0);
      assert.ok(doc.appliedAt instanceof Date);
      assert.strictEqual(doc.checksum, await computeChecksum(path.join(project.dir, doc.name)));
    }
  });

  it('should make a subsequent up() a no-op', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.baseline();
    const results = await migrator.up();
    assert.deepStrictEqual(results, []);
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
  });

  it('should refuse down/redo on baselined records (forward-only)', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.baseline();
    await assert.rejects(migrator.down('0001-a.ts'), IrreversibleMigrationError);
    await assert.rejects(migrator.redo('0001-a.ts'), IrreversibleMigrationError);
  });

  it('should truncate at --to and skip already-applied files', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));

    const first = await migrator.baseline({ to: '0002-b.ts' });
    assert.deepStrictEqual(first.baselined, ['0001-a.ts', '0002-b.ts']);

    // Idempotent: a re-run skips the already-baselined names.
    const second = await migrator.baseline();
    assert.deepStrictEqual(second.baselined, ['0003-c.ts']);
    assert.strictEqual(second.skipped, 2);
    assert.strictEqual((await records()).length, 3);
  });

  it('should reject an unknown --to target', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await assert.rejects(migrator.baseline({ to: 'nope.ts' }), MigrationFileNotFoundError);
    assert.strictEqual((await records()).length, 0);
  });

  it('should report nothing to baseline on an already-covered project', async () => {
    setup();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await migrator.up();
    const summary = await migrator.baseline();
    assert.deepStrictEqual(summary, { baselined: [], skipped: 1, batch: null });
  });
});
