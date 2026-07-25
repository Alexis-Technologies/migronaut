const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const {
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
  MigrationInvalidNameError,
} = require('../../src/errors/index.js');
const { computeChecksum } = require('../../src/utils/checksum.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');
const { makeRecord } = require('../helpers/records.js');

let mongo;
const DB = 'migronaut_import_test';
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

/** Seed a migrate-mongo style changelog collection */
async function seedChangelog(docs) {
  await mongo.db.collection('changelog').insertMany(docs);
}

function targetRecords() {
  return mongo.db.collection(TARGET).find().sort({ name: 1 }).toArray();
}

describe('MigratorKit.import (integration)', () => {
  it('should reject a path-traversing fileName from the foreign changelog', async () => {
    setup();
    // A compromised/hand-crafted migrate-mongo changelog whose fileName escapes
    // the migrations dir. The checksum step feeds fileName into readFileSync via
    // filepath(); that must reject it before any file is read or record written.
    await seedChangelog([{ fileName: '../../../../etc/passwd', appliedAt: new Date() }]);
    await assert.rejects(migrator.import(), MigrationInvalidNameError);
    assert.strictEqual((await targetRecords()).length, 0);
  });

  it('should map migrate-mongo docs into the migronaut changelog', async () => {
    setup();
    project.write('20260101000000-a.js', insertMigration('things', 'a'));
    await seedChangelog([
      {
        fileName: '20260101000000-a.js',
        appliedAt: new Date('2026-01-01T00:00:00Z'),
        migrationBlock: 100,
      },
    ]);

    const result = await migrator.import();
    assert.strictEqual(result.imported, 1);
    assert.strictEqual(result.source, 'changelog');
    assert.strictEqual(result.target, TARGET);

    const records = await targetRecords();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].name, '20260101000000-a.js');
    assert.strictEqual(records[0].batch, 1);
    assert.strictEqual(records[0].status, 'applied');
    assert.strictEqual(records[0].duration, 0);
    assert.strictEqual(records[0].environment, 'imported');
    assert.strictEqual(records[0].executedBy, 'migronaut-import');
  });

  it('should give every migration a unique sequential batch in apply order', async () => {
    setup();
    await seedChangelog([
      { fileName: 'a.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'b.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'c.js', appliedAt: new Date(), migrationBlock: 200 },
    ]);

    await migrator.import();
    const records = await targetRecords();
    const byName = new Map(records.map((r) => [r.name, r.batch]));
    assert.strictEqual(byName.get('a.js'), 1);
    assert.strictEqual(byName.get('b.js'), 2);
    assert.strictEqual(byName.get('c.js'), 3);
  });

  it('should not duplicate batch ids when all entries share one migrationBlock and files are absent', async () => {
    setup();
    // Reproduces the reported case: a changelog applied in a single migrate-mongo
    // run (one shared migrationBlock), with none of the files present on disk.
    await seedChangelog([
      {
        fileName: 'a.js',
        appliedAt: new Date('2026-06-02T11:35:49.001Z'),
        migrationBlock: 1780400149448,
      },
      {
        fileName: 'b.js',
        appliedAt: new Date('2026-06-02T11:35:49.002Z'),
        migrationBlock: 1780400149448,
      },
      {
        fileName: 'c.js',
        appliedAt: new Date('2026-06-02T11:35:49.003Z'),
        migrationBlock: 1780400149448,
      },
    ]);

    await migrator.import();

    const batches = (await targetRecords()).map((r) => r.batch).sort((a, b) => a - b);
    assert.deepStrictEqual(batches, [1, 2, 3]);
    assert.strictEqual(new Set(batches).size, batches.length);
  });

  it('should make imported migrations skip on a subsequent up()', async () => {
    setup();
    project.write('20260101000000-a.js', insertMigration('things', 'a'));
    await seedChangelog([
      { fileName: '20260101000000-a.js', appliedAt: new Date(), migrationBlock: 100 },
    ]);

    await migrator.import();
    const results = await migrator.up();
    assert.deepStrictEqual(results, []);
    // up() must NOT have re-run the migration
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
  });

  it('should reuse the fileHash when it matches the file on disk', async () => {
    setup();
    const body = insertMigration('things', 'a');
    project.write('20260101000000-a.js', body);
    const realHash = await computeChecksum(`${project.dir}/20260101000000-a.js`);
    await seedChangelog([
      { fileName: '20260101000000-a.js', appliedAt: new Date(), fileHash: realHash },
    ]);

    const result = await migrator.import();
    assert.strictEqual(result.rows[0]?.checksumSource, 'reused');
    assert.strictEqual(result.rows[0]?.checksum, realHash);
  });

  it('should recompute the checksum when no matching fileHash is present', async () => {
    setup();
    project.write('20260101000000-a.js', insertMigration('things', 'a'));
    await seedChangelog([{ fileName: '20260101000000-a.js', appliedAt: new Date() }]);

    const result = await migrator.import();
    assert.strictEqual(result.rows[0]?.checksumSource, 'recomputed');
  });

  it('should still import a record whose file is missing on disk', async () => {
    setup();
    await seedChangelog([{ fileName: 'gone.js', appliedAt: new Date(), fileHash: 'h1' }]);

    const result = await migrator.import();
    assert.strictEqual(result.imported, 1);
    assert.strictEqual(result.rows[0]?.checksumSource, 'reused');
    assert.strictEqual(result.rows[0]?.checksum, 'h1');
  });

  it('should skip source docs without a usable fileName', async () => {
    setup();
    await seedChangelog([{ fileName: 'a.js', appliedAt: new Date() }, { appliedAt: new Date() }]);

    const result = await migrator.import();
    assert.strictEqual(result.imported, 1);
    assert.strictEqual(result.skipped, 1);
  });

  it('should write to a custom target collection when "to" is given', async () => {
    setup();
    await seedChangelog([{ fileName: 'a.js', appliedAt: new Date() }]);

    const result = await migrator.import({ to: 'custom_changelog' });
    assert.strictEqual(result.target, 'custom_changelog');

    assert.strictEqual(await mongo.db.collection('custom_changelog').countDocuments(), 1);
    // The default collection is left empty.
    assert.strictEqual(await mongo.db.collection(TARGET).countDocuments(), 0);
  });

  it('should leave the source collection untouched', async () => {
    setup();
    await seedChangelog([{ fileName: 'a.js', appliedAt: new Date() }]);
    await migrator.import();
    assert.strictEqual(await mongo.db.collection('changelog').countDocuments(), 1);
  });

  it('should not write anything in dry-run mode', async () => {
    setup();
    project.write('a.js', insertMigration('things', 'a'));
    await seedChangelog([{ fileName: 'a.js', appliedAt: new Date() }]);

    const result = await migrator.import({ dryRun: true });
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(await mongo.db.collection(TARGET).countDocuments(), 0);
  });

  it('should refuse a non-empty target without force', async () => {
    setup();
    await seedChangelog([{ fileName: 'a.js', appliedAt: new Date() }]);
    await migrator.import();
    // second seed + import should be blocked
    await mongo.db.collection('changelog').insertOne({ fileName: 'b.js', appliedAt: new Date() });
    await assert.rejects(migrator.import(), ImportTargetNotEmptyError);
  });

  it('should be idempotent when re-run with force', async () => {
    setup();
    await seedChangelog([
      { fileName: 'a.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'b.js', appliedAt: new Date(), migrationBlock: 100 },
    ]);
    await migrator.import();
    await migrator.import({ force: true });
    assert.strictEqual(await mongo.db.collection(TARGET).countDocuments(), 2);
  });

  it('should report nothing to import for an empty source', async () => {
    setup();
    const result = await migrator.import();
    assert.strictEqual(result.imported, 0);
    assert.strictEqual(result.skipped, 0);
    assert.deepStrictEqual(result.rows, []);
  });

  it('should tag imported records with origin=migrate-mongo', async () => {
    setup();
    await seedChangelog([{ fileName: 'a.js', appliedAt: new Date() }]);
    await migrator.import();
    const records = await targetRecords();
    assert.strictEqual(records[0]?.origin, 'migrate-mongo');
  });

  it('should refuse to down a single imported migration and leave it applied', async () => {
    setup();
    // No file on disk on purpose — the guard must fire before any file load/write.
    await seedChangelog([{ fileName: '20260101000000-a.js', appliedAt: new Date() }]);
    await migrator.import();

    await assert.rejects(migrator.down('20260101000000-a.js'), IrreversibleMigrationError);

    // Record must be untouched — still applied, never marked reverted.
    const records = await targetRecords();
    assert.strictEqual(records[0]?.status, 'applied');
    assert.strictEqual(records[0]?.revertedAt, undefined);
  });

  it('should refuse a batch rollback that contains imported migrations', async () => {
    setup();
    await seedChangelog([
      { fileName: 'a.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'b.js', appliedAt: new Date(), migrationBlock: 100 },
    ]);
    await migrator.import();

    await assert.rejects(migrator.down(), IrreversibleMigrationError);
    const records = await targetRecords();
    assert.strictEqual(
      records.every((r) => r.status === 'applied'),
      true,
    );
  });

  it('should refuse redo of an imported migration', async () => {
    setup();
    await seedChangelog([{ fileName: 'a.js', appliedAt: new Date() }]);
    await migrator.import();
    await assert.rejects(migrator.redo('a.js'), IrreversibleMigrationError);
  });

  it('should continue batch numbering when the target already has records', async () => {
    setup();
    // A native migration already applied → batch 1 in the target.
    project.write('0001-native.js', insertMigration('things', 'n1'));
    await migrator.up();

    await seedChangelog([
      { fileName: 'mm-a.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'mm-b.js', appliedAt: new Date(), migrationBlock: 200 },
    ]);
    await migrator.import({ force: true });

    const byName = new Map((await targetRecords()).map((r) => [r.name, r.batch]));
    assert.strictEqual(byName.get('0001-native.js'), 1);
    // Imported batches continue after the existing max (1), not restart at 1.
    assert.strictEqual(byName.get('mm-a.js'), 2);
    assert.strictEqual(byName.get('mm-b.js'), 3);
  });

  it('should never produce duplicate batch numbers, even with prior records for missing files', async () => {
    setup();
    // Simulate already-applied migrations whose files are no longer on disk.
    await mongo.db
      .collection(TARGET)
      .insertMany([
        makeRecord({ name: 'gone-1.js', batch: 1 }),
        makeRecord({ name: 'gone-2.js', batch: 2 }),
      ]);

    await seedChangelog([
      { fileName: 'mm-a.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'mm-b.js', appliedAt: new Date(), migrationBlock: 200 },
    ]);
    await migrator.import({ force: true });

    const batches = (await targetRecords()).map((r) => r.batch).sort((a, b) => a - b);
    assert.deepStrictEqual(batches, [1, 2, 3, 4]);
    // No batch value appears more than once.
    assert.strictEqual(new Set(batches).size, batches.length);
  });

  it('should keep imported batch numbers stable on a forced re-import', async () => {
    setup();
    await seedChangelog([
      { fileName: 'a.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'b.js', appliedAt: new Date(), migrationBlock: 200 },
    ]);
    await migrator.import();
    await migrator.import({ force: true });

    const batches = (await targetRecords()).map((r) => r.batch).sort((a, b) => a - b);
    // Re-importing the same set must not shift batches to 3,4.
    assert.deepStrictEqual(batches, [1, 2]);
  });

  it('should ignore on-disk files that are not in the changelog and leave them pending', async () => {
    setup();
    // In changelog AND on disk:
    project.write('20260101000000-a.js', insertMigration('things', 'a'));
    project.write('20260101000001-b.js', insertMigration('things', 'b'));
    // New files on disk only — NOT in the source changelog:
    project.write('20260201000000-c.js', insertMigration('things', 'c'));
    project.write('20260201000001-d.js', insertMigration('things', 'd'));
    await seedChangelog([
      { fileName: '20260101000000-a.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: '20260101000001-b.js', appliedAt: new Date(), migrationBlock: 100 },
    ]);

    const result = await migrator.import();

    // Only the two changelog files are imported.
    assert.strictEqual(result.imported, 2);
    const importedNames = (await targetRecords()).map((r) => r.name);
    assert.deepStrictEqual(importedNames, ['20260101000000-a.js', '20260101000001-b.js']);

    // The new files show as pending, not applied.
    const pending = (await migrator.list('pending')).map((r) => r.file);
    assert.deepStrictEqual(pending, ['20260201000000-c.js', '20260201000001-d.js']);

    // up() runs only the new files; the imported ones are skipped.
    const upResults = await migrator.up();
    assert.deepStrictEqual(
      upResults.map((r) => r.file),
      ['20260201000000-c.js', '20260201000001-d.js'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
  });
});
