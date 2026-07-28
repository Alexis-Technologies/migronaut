const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { MigratorKit } = require('../../src/core/migrator.js');
const { pendingMigrations } = require('../../src/core/run.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_perf_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

let project;

beforeEach(async () => {
  await mongo.db.dropDatabase();
  project = makeProject();
});

afterEach(() => {
  project?.cleanup();
});

function migrator(overrides = {}) {
  return makeMigrator(mongo.uri, DB, project.dir, overrides);
}

describe('changelog indexes (integration)', () => {
  it('should create the indexes the read paths use', async () => {
    const kit = migrator();
    await kit.connect();
    await kit.disconnect();

    const indexes = await mongo.db.collection('_migronaut_migrations').indexes();
    const byName = new Map(indexes.map((index) => [index.name, index]));
    assert.deepStrictEqual(byName.get('name_unique')?.key, { name: 1 });
    assert.strictEqual(byName.get('name_unique')?.unique, true);
    assert.deepStrictEqual(byName.get('status_batch')?.key, { status: 1, batch: -1 });
    assert.deepStrictEqual(byName.get('batch')?.key, { batch: 1 });
    assert.deepStrictEqual(byName.get('status_appliedAt_name')?.key, {
      status: 1,
      appliedAt: -1,
      name: -1,
    });
  });

  it('should serve the newest-applied lookup from an index, not a blocking sort', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    await kit.up();
    await kit.disconnect();

    // The exact query shape of getNewestApplied (redo) and getLastAppliedN
    // (down --steps): without the status_appliedAt_name index the server
    // fetches every applied record and runs an in-memory SORT stage.
    const plan = await mongo.db
      .collection('_migronaut_migrations')
      .find({ status: 'applied' })
      .sort({ appliedAt: -1, name: -1 })
      .limit(1)
      .explain();
    assert.ok(!JSON.stringify(plan.queryPlanner.winningPlan).includes('"SORT"'));
  });

  it('should push the down --to selection onto the status_name index', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    await kit.up();
    await kit.disconnect();

    // The exact query shape of getAppliedAfter: predicate and order both
    // covered — no client-side filter over the full applied history.
    const plan = await mongo.db
      .collection('_migronaut_migrations')
      .find({ status: 'applied', name: { $gt: '0001-a.ts' } })
      .sort({ name: 1 })
      .explain();
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    assert.ok(!winning.includes('"SORT"'));
    assert.ok(!winning.includes('COLLSCAN'));
  });

  it('should serve the highest-batch lookup from an index, not a collection scan', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    await kit.up();
    await kit.disconnect();

    const plan = await mongo.db
      .collection('_migronaut_migrations')
      .find({})
      .sort({ batch: -1 })
      .limit(1)
      .explain();
    // A blocking in-memory SORT stage is what the index exists to avoid; it is
    // also what hits the 32 MB sort limit once the history is large.
    assert.ok(!JSON.stringify(plan.queryPlanner.winningPlan).includes('"SORT"'));
  });

  it('should skip index creation when ensureIndexes is false', async () => {
    const kit = migrator({ ensureIndexes: false });
    await kit.connect();
    await kit.disconnect();
    // Only the implicit _id index exists.
    const indexes = await mongo.db
      .collection('_migronaut_migrations')
      .indexes()
      .catch(() => []);
    assert.ok(!indexes.some((index) => index.name === 'status_batch'));
  });
});

describe('batch numbering (integration)', () => {
  it('should keep batch numbers monotonic across a rollback', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const first = migrator();
    await first.up();
    await first.down();
    await first.disconnect();

    project.write('0002-b.ts', insertMigration('things', 'b'));
    const second = migrator();
    await second.up();
    await second.disconnect();

    const records = await mongo.db
      .collection('_migronaut_migrations')
      .find()
      .sort({ name: 1 })
      .toArray();
    // 0001 was reverted, so the second run re-applies it alongside 0002 — both
    // in batch 2. The point is that the reverted batch 1 did not hand its
    // number back: getMaxBatch counts reverted records, so numbering only ever
    // moves forward.
    assert.deepStrictEqual(
      records.map((r) => [r.name, r.batch]),
      [
        ['0001-a.ts', 2],
        ['0002-b.ts', 2],
      ],
    );
    assert.ok(
      records.every((r) => r.batch > 1),
      'a reverted batch number must never be reused',
    );
  });
});

describe('pendingMigrations readiness probe (integration)', () => {
  it('should not read or hash applied migration files', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const kit = migrator();
    await kit.up();
    await kit.disconnect();

    project.write('0003-c.ts', insertMigration('things', 'c'));

    // Reading an applied file is what the probe must avoid; make it impossible
    // to do so silently by watching every read of the migrations dir.
    const fsPromises = require('node:fs/promises');
    const originalReadFile = fsPromises.readFile;
    const readFiles = [];
    fsPromises.readFile = (file, ...rest) => {
      readFiles.push(String(file));
      return originalReadFile(file, ...rest);
    };
    try {
      const pending = await pendingMigrations({
        uri: mongo.uri,
        dbName: DB,
        migrationsDir: project.dir,
        logger: null,
      });
      assert.deepStrictEqual(
        pending.map((row) => row.file),
        ['0003-c.ts'],
      );
      assert.ok(!readFiles.some((file) => file.includes('0001-a.ts')));
      assert.ok(!readFiles.some((file) => file.includes('0002-b.ts')));
    } finally {
      fsPromises.readFile = originalReadFile;
    }
  });

  it('should return an empty list when fully migrated', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    await kit.up();
    await kit.disconnect();

    const pending = await pendingMigrations({
      uri: mongo.uri,
      dbName: DB,
      migrationsDir: project.dir,
      logger: null,
    });
    assert.deepStrictEqual(pending, []);
  });

  it('should still report checksum drift through status()', async () => {
    // The fast pending path skips checksums; the full status must not.
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    await kit.up();
    project.tamper('0001-a.ts');
    const rows = await kit.status();
    await kit.disconnect();
    assert.strictEqual(rows[0].checksumOk, false);
  });
});

describe('offline create (integration)', () => {
  it('should not resolve a failing config factory when creating a file', async () => {
    // Mimics a secret-manager config: the factory throws when the manager is
    // unreachable. `create` writes a file and needs no connection, so it must
    // degrade rather than fail.
    const cwd = path.join(project.dir, 'app');
    mkdirSync(cwd);
    writeFileSync(
      path.join(cwd, 'migronaut.config.js'),
      [
        'export default async () => {',
        "  throw new Error('secret manager unreachable');",
        '};',
        '',
      ].join('\n'),
    );

    const kit = new MigratorKit(
      { migrationsDir: project.dir, logger: null },
      { configPath: path.join(cwd, 'migronaut.config.js') },
    );
    const filepath = await kit.create('add index');
    assert.match(path.basename(filepath), /-add-index\.js$/);
  });

  it('should still surface a failing factory for commands that need the database', async () => {
    const cwd = path.join(project.dir, 'app2');
    mkdirSync(cwd);
    writeFileSync(
      path.join(cwd, 'migronaut.config.js'),
      [
        'export default async () => {',
        "  throw new Error('secret manager unreachable');",
        '};',
        '',
      ].join('\n'),
    );

    const kit = new MigratorKit(
      { migrationsDir: project.dir, logger: null },
      { configPath: path.join(cwd, 'migronaut.config.js') },
    );
    await assert.rejects(kit.status(), (error) => {
      assert.strictEqual(error.code, 'CONFIG_INVALID');
      return true;
    });
  });
});
