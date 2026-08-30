const os = require('node:os');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { pendingMigrations, runMigrations } = require('../../src/core/run.js');
const {
  LockAlreadyHeldError,
  MigrationExecutionFailedError,
} = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { failingMigration, insertMigration, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_run_test';
const LOCK_COLLECTION = '_migronaut_locks';

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

afterEach(() => {
  project?.cleanup();
});

/** Base config pointed at the test mongo + project dir, output silenced */
function config() {
  return { uri: mongo.uri, dbName: DB, migrationsDir: project.dir, logger: null };
}

/** Insert a fresh (non-stale) lock document so acquisition is blocked */
async function holdLock() {
  await mongo.db.collection(LOCK_COLLECTION).insertOne({
    _id: 'migronaut_lock',
    lockedAt: new Date(),
    pid: 999_999,
    host: os.hostname(),
    executedBy: 'peer',
    owner: 'peer-token',
  });
}

describe('runMigrations (programmatic entry point)', () => {
  it('should apply all pending migrations and report them', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));

    const summary = await runMigrations(config());

    assert.deepStrictEqual(
      summary.applied.map((r) => r.status),
      ['applied', 'applied'],
    );
    assert.strictEqual(summary.upToDate, false);
    assert.strictEqual(summary.waited, false);
    assert.strictEqual(summary.waitedMs, 0);
    assert.strictEqual(summary.attempts, 1);
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 2);
  });

  it('should report upToDate when nothing is pending', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runMigrations(config());

    const summary = await runMigrations(config());
    assert.deepStrictEqual(summary.applied, []);
    assert.strictEqual(summary.upToDate, true);
  });

  it('should propagate a migration failure and not leak the connection', async () => {
    project = makeProject();
    project.write('0001-bad.ts', failingMigration());

    await assert.rejects(runMigrations(config()), MigrationExecutionFailedError);

    // A follow-up connection-managed call still works — the failed run
    // disconnected cleanly in its finally block (no leaked client).
    const pending = await pendingMigrations(config());
    assert.deepStrictEqual(
      pending.map((row) => row.file),
      ['0001-bad.ts'],
    );
  });

  it('should throw LockAlreadyHeldError by default when the lock is held', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await holdLock();

    await assert.rejects(runMigrations(config()), LockAlreadyHeldError);
    // Nothing applied while another process holds the lock.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
  });

  it('should wait for a held lock to release, then run (onLockHeld: wait)', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await holdLock();

    // Release the peer's lock shortly after we start waiting.
    const release = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await mongo.db.collection(LOCK_COLLECTION).deleteOne({ _id: 'migronaut_lock' });
    })();

    const [summary] = await Promise.all([
      runMigrations(config(), {
        onLockHeld: 'wait',
        lockPollIntervalMs: 40,
        lockWaitTimeoutMs: 5_000,
      }),
      release,
    ]);

    assert.strictEqual(summary.waited, true);
    // The wait is observable, not just a boolean: how long and how many polls.
    assert.ok(summary.waitedMs > 0);
    assert.ok(summary.attempts >= 2);
    assert.deepStrictEqual(
      summary.applied.map((r) => r.status),
      ['applied'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
  });

  it('should give up waiting after the timeout and throw', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await holdLock();

    await assert.rejects(
      runMigrations(config(), {
        onLockHeld: 'wait',
        lockPollIntervalMs: 40,
        lockWaitTimeoutMs: 120,
      }),
      LockAlreadyHeldError,
    );
  });
});

describe('pendingMigrations (readiness probe)', () => {
  it('should return only the not-yet-applied migrations', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await runMigrations(config()); // apply both

    project.write('0003-c.ts', insertMigration('things', 'c'));
    const pending = await pendingMigrations(config());

    assert.deepStrictEqual(
      pending.map((row) => row.file),
      ['0003-c.ts'],
    );
    assert.strictEqual(
      pending.every((row) => row.status === 'pending'),
      true,
    );
  });

  it('should return an empty array when fully migrated', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await runMigrations(config());

    assert.deepStrictEqual(await pendingMigrations(config()), []);
  });
});

describe('runMigrations onKit (integration)', () => {
  it('should hand out the kit before connect, so listeners see every event', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));

    const events = [];
    const summary = await runMigrations(config(), {
      onKit: (kit) => {
        for (const name of ['run:start', 'migration:success', 'run:end', 'lock:acquired']) {
          kit.on(name, (payload) => events.push([name, payload]));
        }
      },
    });

    assert.strictEqual(summary.applied.length, 1);
    const names = events.map(([name]) => name);
    assert.ok(names.includes('run:start'));
    assert.ok(names.includes('migration:success'));
    assert.ok(names.includes('lock:acquired'));
    assert.strictEqual(events.at(-1)[0], 'run:end');
    // The whole point: metrics without parsing log lines.
    const success = events.find(([name]) => name === 'migration:success')[1];
    assert.strictEqual(typeof success.durationMs, 'number');
  });
});
