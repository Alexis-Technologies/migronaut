const { writeFileSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { MigratorKit } = require('../../src/core/migrator.js');
const {
  ConfigInvalidError,
  MigrationFileNotFoundError,
  MigrationTimeoutError,
  NotAppliedError,
} = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const {
  failingMigration,
  insertMigration,
  makeMigrator,
  makeProject,
} = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_features_test';

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

/** Write three migrations named so their sort order is obvious */
function writeThree() {
  project.write('0001-a.ts', insertMigration('things', 'a'));
  project.write('0002-b.ts', insertMigration('things', 'b'));
  project.write('0003-c.ts', insertMigration('things', 'c'));
}

describe('injected MongoClient (integration)', () => {
  it('should reuse the caller’s client and leave it open on disconnect', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = new MigratorKit({
      client: mongo.client,
      dbName: DB,
      migrationsDir: project.dir,
      logger: null,
    });

    await kit.up();
    await kit.disconnect();

    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
    // The client still works: migronaut must not close what it did not open.
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 1);
  });

  it('should not require a uri when a client is supplied', async () => {
    const kit = new MigratorKit({
      client: mongo.client,
      dbName: DB,
      migrationsDir: project.dir,
      logger: null,
    });
    await kit.connect();
    await kit.disconnect();
  });

  it('should still require a uri without a client', async () => {
    // An explicit configPath, because the repo's own migronaut.config.ts would
    // otherwise be discovered from the working directory and supply a uri.
    const configPath = path.join(project.dir, 'no-uri.config.json');
    writeFileSync(configPath, JSON.stringify({ dbName: DB }));
    const kit = new MigratorKit({ migrationsDir: project.dir, logger: null }, { configPath });
    await assert.rejects(kit.connect(), ConfigInvalidError);
  });
});

describe('up --to / down --to (integration)', () => {
  it('should apply pending migrations up to and including the target', async () => {
    writeThree();
    const kit = migrator();
    const results = await kit.up(undefined, { to: '0002-b.ts' });
    await kit.disconnect();

    assert.deepStrictEqual(
      results.map((r) => r.file),
      ['0001-a.ts', '0002-b.ts'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
  });

  it('should be idempotent when the target is already applied', async () => {
    writeThree();
    const kit = migrator();
    await kit.up(undefined, { to: '0002-b.ts' });
    const second = await kit.up(undefined, { to: '0002-b.ts' });
    await kit.disconnect();
    assert.deepStrictEqual(second, []);
  });

  it('should reject an --to target that does not exist', async () => {
    writeThree();
    const kit = migrator();
    await assert.rejects(kit.up(undefined, { to: '9999-nope.ts' }), MigrationFileNotFoundError);
    await kit.disconnect();
  });

  it('should revert everything applied after the target, keeping the target', async () => {
    writeThree();
    const kit = migrator();
    await kit.up();
    const results = await kit.down(undefined, { to: '0001-a.ts' });
    await kit.disconnect();

    assert.deepStrictEqual(
      results.map((r) => r.file),
      // Newest first, and 0001-a is untouched.
      ['0003-c.ts', '0002-b.ts'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should round-trip: up --to X then down --to X returns to the same state', async () => {
    writeThree();
    const kit = migrator();
    await kit.up(undefined, { to: '0003-c.ts' });
    await kit.down(undefined, { to: '0001-a.ts' });
    await kit.up(undefined, { to: '0003-c.ts' });
    const applied = await kit.list('applied');
    await kit.disconnect();
    assert.deepStrictEqual(
      applied.map((row) => row.file),
      ['0001-a.ts', '0002-b.ts', '0003-c.ts'],
    );
  });

  it('should reject a down --to target that is not applied', async () => {
    writeThree();
    const kit = migrator();
    await kit.up(undefined, { to: '0001-a.ts' });
    await assert.rejects(kit.down(undefined, { to: '0003-c.ts' }), NotAppliedError);
    await kit.disconnect();
  });

  it('should refuse --to combined with the other target selectors', async () => {
    writeThree();
    const kit = migrator();
    await assert.rejects(kit.up('0001-a.ts', { to: '0002-b.ts' }), ConfigInvalidError);
    await assert.rejects(kit.down(undefined, { to: '0001-a.ts', steps: 1 }), ConfigInvalidError);
    await assert.rejects(kit.down(undefined, { to: '0001-a.ts', batch: 1 }), ConfigInvalidError);
    await kit.disconnect();
  });
});

describe('lifecycle events (integration)', () => {
  it('should emit run and migration events with a shared runId', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    const events = [];
    for (const name of [
      'run:start',
      'run:end',
      'migration:start',
      'migration:success',
      'lock:acquired',
      'lock:released',
    ]) {
      kit.on(name, (payload) => events.push([name, payload]));
    }

    await kit.up();
    await kit.disconnect();

    const names = events.map(([name]) => name);
    assert.deepStrictEqual(names, [
      'run:start',
      'lock:acquired',
      'migration:start',
      'migration:success',
      'lock:released',
      'run:end',
    ]);

    const runIds = new Set(events.map(([, payload]) => payload.runId));
    assert.strictEqual(runIds.size, 1, 'every event of one run shares its runId');
    const success = events.find(([name]) => name === 'migration:success')[1];
    assert.strictEqual(success.migration, '0001-a.ts');
    assert.strictEqual(success.direction, 'up');
    assert.strictEqual(typeof success.durationMs, 'number');
    assert.strictEqual(events.find(([name]) => name === 'run:end')[1].success, true);
  });

  it('should emit migration:error and a failed run:end when a migration throws', async () => {
    // Both up and down must exist, or the failure happens at load time and the
    // migration never starts — a different path than the one under test.
    project.write('0001-bad.ts', failingMigration());
    const kit = migrator();
    const seen = [];
    kit.on('migration:error', (event) => seen.push(event));
    kit.on('run:end', (event) => seen.push(event));

    await assert.rejects(kit.up());
    await kit.disconnect();

    assert.strictEqual(seen[0].migration, '0001-bad.ts');
    // A redacted string, never the raw Error: a driver message can echo the
    // credentialed URI, and subscribers ship this payload as-is.
    assert.strictEqual(typeof seen[0].error, 'string');
    assert.strictEqual(seen[1].success, false);
    assert.strictEqual(typeof seen[1].error, 'string');
    // The failure path still reports counts — "how far did it get?" is
    // exactly the question when success is false.
    assert.strictEqual(seen[1].total, 1);
    assert.strictEqual(seen[1].applied, 0);
  });

  it('should count the migrations that landed before a mid-run failure', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-bad.ts', failingMigration());
    const kit = migrator();
    let end;
    kit.on('run:end', (event) => (end = event));

    await assert.rejects(kit.up());
    await kit.disconnect();

    assert.strictEqual(end.success, false);
    assert.strictEqual(end.applied, 1);
    assert.strictEqual(end.total, 2);
  });

  it('should carry ttlMs and acquireMs on lock:acquired and owner on lock events', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    let acquired;
    kit.on('lock:acquired', (event) => (acquired = event));

    await kit.up();
    await kit.disconnect();

    assert.strictEqual(acquired.ttlMs, 60_000);
    assert.strictEqual(typeof acquired.acquireMs, 'number');
    assert.strictEqual(acquired.owner, acquired.runId);
  });

  it('should contain a throwing listener rather than failing the run', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    kit.on('migration:success', () => {
      throw new Error('listener exploded');
    });
    // Observability must never be able to break a migration.
    const results = await kit.up();
    await kit.disconnect();
    assert.strictEqual(results[0].status, 'applied');
  });
});

describe('per-migration timeout (integration)', () => {
  const slow = `export async function up() {
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
export async function down() {}
`;

  it('should abort a migration that exceeds the configured timeout', async () => {
    project.write('0001-slow.ts', slow);
    const kit = migrator({ timeoutMs: 100 });
    await assert.rejects(kit.up(), (error) => {
      assert.ok(error instanceof MigrationTimeoutError);
      assert.strictEqual(error.code, 'MIGRATION_TIMEOUT');
      assert.strictEqual(error.context.timeoutMs, 100);
      return true;
    });
    await kit.disconnect();
    // Never recorded as applied — but the failed attempt leaves its trace, so
    // post-incident forensics no longer depend on captured process logs.
    const docs = await mongo.db.collection('_migronaut_migrations').find().toArray();
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].status, 'failed');
    assert.match(docs[0].error, /timed out/);
    assert.ok(docs[0].failedAt instanceof Date);
  });

  it('should let a per-file timeoutMs override the global one', async () => {
    project.write('0001-slow.ts', `export const timeoutMs = 100;\n${slow}`);
    const kit = migrator({ timeoutMs: 60_000 });
    await assert.rejects(kit.up(), MigrationTimeoutError);
    await kit.disconnect();
  });

  it('should not interfere with a migration that finishes in time', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator({ timeoutMs: 30_000 });
    const results = await kit.up();
    await kit.disconnect();
    assert.strictEqual(results[0].status, 'applied');
  });

  it('should release the lock after a timeout', async () => {
    project.write('0001-slow.ts', slow);
    const kit = migrator({ timeoutMs: 100 });
    await assert.rejects(kit.up());
    await kit.disconnect();
    // A wedged migration must not leave the lock behind for its full TTL.
    assert.strictEqual(await mongo.db.collection('_migronaut_locks').countDocuments(), 0);
  });
});

describe('audit (integration)', () => {
  it('should pass every check on a healthy setup', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    await kit.up();
    const report = await kit.audit();
    await kit.disconnect();

    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.failed, 0);
    const byName = new Map(report.checks.map((check) => [check.name, check]));
    assert.strictEqual(byName.get('config').status, 'pass');
    assert.strictEqual(byName.get('connection').status, 'pass');
    // The test server is a replica set, so transactions are available.
    assert.strictEqual(byName.get('transactions').status, 'pass');
    assert.strictEqual(byName.get('indexes').status, 'pass');
    assert.strictEqual(byName.get('lock').status, 'pass');
    assert.strictEqual(byName.get('checksums').status, 'pass');
  });

  it('should fail the checksum check when an applied file was edited', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    await kit.up();
    project.tamper('0001-a.ts');
    const report = await kit.audit();
    await kit.disconnect();

    assert.strictEqual(report.ok, false);
    const checksums = report.checks.find((check) => check.name === 'checksums');
    assert.strictEqual(checksums.status, 'fail');
    assert.match(checksums.detail, /0001-a\.ts/);
  });

  it('should warn about pending migrations without failing', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator();
    const report = await kit.audit();
    await kit.disconnect();

    const pending = report.checks.find((check) => check.name === 'pending');
    assert.strictEqual(pending.status, 'warn');
    // A pending migration is normal before a deploy — it must not be a failure.
    assert.strictEqual(report.ok, true);
  });

  it('should report a configuration failure without attempting to connect', async () => {
    const configPath = path.join(project.dir, 'bad.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({ uri: 'mongodb://x:27017', dbName: DB, lockTTLSeconds: -1 }),
    );
    const kit = new MigratorKit({ migrationsDir: project.dir, logger: null }, { configPath });
    const report = await kit.audit();
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.checks[0].name, 'config');
    assert.strictEqual(report.checks[0].status, 'fail');
    // It stops there rather than reporting a cascade of unrelated failures.
    assert.strictEqual(report.checks.length, 1);
  });

  it('should warn when a stale lock is left behind', async () => {
    const kit = migrator({ lockTTLSeconds: 1 });
    await kit.connect();
    await mongo.db.collection('_migronaut_locks').insertOne({
      _id: 'migronaut_lock',
      lockedAt: new Date(Date.now() - 60_000),
      pid: 999,
      host: 'crashed-runner',
      executedBy: 'ci',
      owner: 'stale',
    });
    const report = await kit.audit();
    await kit.disconnect();

    const lock = report.checks.find((check) => check.name === 'lock');
    assert.strictEqual(lock.status, 'warn');
    assert.match(lock.detail, /migronaut unlock/);
  });
});

describe('out-of-order detection (integration)', () => {
  const { OutOfOrderMigrationError } = require('../../src/errors/index.js');

  /** Apply the newer file first, then merge an older one from a "branch" */
  async function applyNewerThenMergeOlder(overrides = {}) {
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const kit = migrator(overrides);
    await kit.up();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    return kit;
  }

  it('should warn by default and still apply the late arrival', async () => {
    const warns = [];
    const kit = await applyNewerThenMergeOlder({
      logger: { debug: () => {}, info: () => {}, error: () => {}, warn: (m) => warns.push(m) },
    });
    const results = await kit.up();
    await kit.disconnect();
    assert.strictEqual(results[0].file, '0001-a.ts');
    assert.strictEqual(results[0].status, 'applied');
    assert.ok(
      warns.some((m) => m.includes('Out-of-order') && m.includes('0001-a.ts')),
      'expected an out-of-order warning naming the late file',
    );
  });

  it('should refuse the run under onOutOfOrder: error', async () => {
    const kit = await applyNewerThenMergeOlder({ onOutOfOrder: 'error' });
    await assert.rejects(kit.up(), (error) => {
      assert.ok(error instanceof OutOfOrderMigrationError);
      assert.strictEqual(error.code, 'MIGRATION_OUT_OF_ORDER');
      assert.deepStrictEqual(error.context.names, ['0001-a.ts']);
      return true;
    });
    await kit.disconnect();
    // Nothing ran.
    assert.strictEqual(await mongo.db.collection('things').countDocuments({ marker: 'a' }), 0);
  });

  it('should apply silently under onOutOfOrder: allow', async () => {
    const warns = [];
    const kit = await applyNewerThenMergeOlder({
      onOutOfOrder: 'allow',
      logger: { debug: () => {}, info: () => {}, error: () => {}, warn: (m) => warns.push(m) },
    });
    const results = await kit.up();
    await kit.disconnect();
    assert.strictEqual(results[0].status, 'applied');
    assert.ok(!warns.some((m) => m.includes('Out-of-order')));
  });

  it('should mark late-arriving pending rows in status()', async () => {
    const kit = await applyNewerThenMergeOlder();
    const rows = await kit.status();
    await kit.disconnect();
    const late = rows.find((row) => row.file === '0001-a.ts');
    const applied = rows.find((row) => row.file === '0002-b.ts');
    assert.strictEqual(late.outOfOrder, true);
    assert.strictEqual(applied.outOfOrder, undefined);
  });

  it('should never flag a normal down-then-up cycle', async () => {
    const warns = [];
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const kit = migrator({
      logger: { debug: () => {}, info: () => {}, error: () => {}, warn: (m) => warns.push(m) },
    });
    await kit.up();
    await kit.down();
    const results = await kit.up();
    await kit.disconnect();
    assert.strictEqual(results.length, 2);
    assert.ok(!warns.some((m) => m.includes('Out-of-order')));
  });
});

describe('failed-attempt trace (integration)', () => {
  it('should record a status:failed trace when a migration throws', async () => {
    project.write('0001-boom.ts', failingMigration());
    const kit = migrator();
    try {
      await assert.rejects(kit.up());
    } finally {
      await kit.disconnect();
    }

    const doc = await mongo.db
      .collection('_migronaut_migrations')
      .findOne({ name: '0001-boom.ts' });
    assert.strictEqual(doc.status, 'failed');
    assert.match(doc.error, /intentional failure/);
    assert.ok(doc.failedAt instanceof Date);
    assert.strictEqual(typeof doc.runId, 'string');
  });

  it('should surface the failed row in status() while keeping it pending for runs', async () => {
    project.write('0001-boom.ts', failingMigration());
    const kit = migrator();
    try {
      await assert.rejects(kit.up());
      const rows = await kit.status();
      assert.strictEqual(rows[0].status, 'failed');
      assert.match(rows[0].error, /intentional failure/);
      // Still pending work: the readiness probe counts it.
      const pending = await kit.list('pending');
      assert.strictEqual(pending.length, 1);
    } finally {
      await kit.disconnect();
    }
  });

  it('should overwrite the failed trace once the migration finally applies', async () => {
    project.write('0001-flaky.ts', failingMigration());
    // reloadMigrations: Node caches dynamic import() by path, and this test
    // rewrites the SAME filename mid-run — the documented cache gotcha.
    const kit = migrator({ reloadMigrations: true });
    try {
      await assert.rejects(kit.up());
      // The author fixes the file; the next up applies it cleanly.
      project.write('0001-flaky.ts', insertMigration('things', 'fixed'));
      const results = await kit.up();
      assert.strictEqual(results[0].status, 'applied');
    } finally {
      await kit.disconnect();
    }
    const doc = await mongo.db
      .collection('_migronaut_migrations')
      .findOne({ name: '0001-flaky.ts' });
    assert.strictEqual(doc.status, 'applied');
    assert.strictEqual(doc.error, undefined);
    assert.strictEqual(doc.failedAt, undefined);
  });

  it('should never demote an applied record when a forced re-run fails', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    // reloadMigrations, so the sabotaged rewrite below actually executes
    // instead of the cached original module.
    const kit = migrator({ reloadMigrations: true });
    try {
      await kit.up();
      // Sabotage the file, then force a re-run that fails.
      project.write('0001-a.ts', failingMigration());
      await assert.rejects(kit.up('0001-a.ts', { force: true }));
    } finally {
      await kit.disconnect();
    }
    const doc = await mongo.db.collection('_migronaut_migrations').findOne({ name: '0001-a.ts' });
    assert.strictEqual(doc.status, 'applied');
  });
});
