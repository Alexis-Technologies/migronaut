const os = require('node:os');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { pendingMigrations, runMigrations } = require('../../src/core/run.js');
const {
  LockAlreadyHeldError,
  MigrationExecutionFailedError,
  RunAbortedError,
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

    // Release the peer's lock once we have been refused at least once — a
    // timer alone races a slow connect, which would find the lock free.
    let release;
    const summary = await runMigrations(config(), {
      onLockHeld: 'wait',
      lockPollIntervalMs: 40,
      lockWaitTimeoutMs: 5_000,
      onKit: (kit) =>
        kit.once('run:end', () => {
          release = mongo.db.collection(LOCK_COLLECTION).deleteOne({ _id: 'migronaut_lock' });
        }),
    });
    await release;

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

describe('runMigrations signal (integration)', () => {
  it('should stop waiting for a held lock as soon as its signal aborts', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await holdLock();
    const controller = new AbortController();
    setTimeout(() => controller.abort('SIGTERM'), 80);
    const started = Date.now();
    await assert.rejects(
      runMigrations(config(), {
        onLockHeld: 'wait',
        lockPollIntervalMs: 2000,
        lockWaitTimeoutMs: 60_000,
        signal: controller.signal,
      }),
      (error) => {
        assert.ok(error instanceof RunAbortedError);
        assert.strictEqual(error.context.reason, 'SIGTERM');
        return true;
      },
    );
    assert.ok(Date.now() - started < 1500, 'the 2s poll sleep was cut short');
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
  });

  it('should not even connect for a signal that is already aborted', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    await assert.rejects(
      runMigrations(config(), { signal: AbortSignal.abort('too late') }),
      RunAbortedError,
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
    await assert.rejects(runMigrations(config(), { signal: 'stop' }), /AbortSignal/);
  });

  it('should load collection definitions once while it waits for the lock', async () => {
    project = makeProject();
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const counter = `${project.dir}/definition-loads.txt`;
    require('node:fs').mkdirSync(`${project.dir}/collections`);
    // ESM: a reload query string re-evaluates it (a CommonJS file would be
    // served from require.cache whatever the URL says).
    project.write(
      'collections/things.mjs',
      "import { appendFileSync } from 'node:fs';\n" +
        `appendFileSync(${JSON.stringify(counter)}, 'x');\n` +
        'export default { indexes: [{ key: { marker: 1 } }] };\n',
    );
    await holdLock();
    // Freed after a few refusals, whatever the machine's speed.
    let refusals = 0;
    let release;
    const summary = await runMigrations(
      {
        ...config(),
        collectionsDir: `${project.dir}/collections`,
        fileExtensions: ['.ts', '.mjs'],
        convergeAfterUp: true,
        // Each load is a fresh evaluation — what made every poll cost a module.
        reloadMigrations: true,
      },
      {
        onLockHeld: 'wait',
        lockPollIntervalMs: 20,
        lockWaitTimeoutMs: 5000,
        onKit: (kit) =>
          kit.on('run:end', () => {
            refusals += 1;
            if (refusals === 3) {
              release = mongo.db.collection(LOCK_COLLECTION).deleteOne({ _id: 'migronaut_lock' });
            }
          }),
      },
    );
    await release;
    assert.ok(summary.attempts > 2, `it polled: ${summary.attempts}`);
    assert.strictEqual(summary.converge.inSync, true);
    assert.strictEqual(require('node:fs').readFileSync(counter, 'utf8'), 'x');
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
