const assert = require('node:assert/strict');
const { after, before, beforeEach, afterEach, describe, it } = require('node:test');
const { LOCK_ID, MigrationLock, runWithLock } = require('../../src/core/lock.js');
const { HookFailedError, LockLostError, RunAbortedError } = require('../../src/errors/index.js');
const { silentLogger } = require('../../src/utils/logger.js');
const { startTestMongo } = require('../helpers/mongo.js');
const {
  failingMigration,
  insertMigration,
  makeMigrator,
  makeProject,
} = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_resilience_test';
const LOCK_COLLECTION = '_migronaut_locks';

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

/** A migration whose up() blocks until `release()` is called via a marker doc */
function slowMigration(collection, value, delayMs = 60) {
  return `export async function up({ db }) {
  await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
  await db.collection('${collection}').insertOne({ marker: '${value}' });
}
export async function down({ db }) {
  await db.collection('${collection}').deleteMany({ marker: '${value}' });
}
`;
}

/**
 * Overwrite the lock's owner token — the state another process leaves behind
 * when it reclaims the lock.
 *
 * Only call this once the locked body is running: acquire() upserts and then
 * reads the token back to confirm ownership, so stealing in between makes
 * acquire itself fail, which is a different scenario than the one under test.
 */
async function stealLock() {
  const result = await mongo.db
    .collection(LOCK_COLLECTION)
    .updateOne({ _id: LOCK_ID }, { $set: { owner: 'someone-else' } });
  assert.strictEqual(result.matchedCount, 1, 'expected a held lock to steal');
}

/** A deferred resolved from inside the locked body, so tests know it started */
function deferred() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

describe('lost lock (integration)', () => {
  it('should abort the run when another process reclaims the lock', async () => {
    // A 2s TTL puts the heartbeat at 1s, so one renewal lands inside the run
    // and finds the lock gone. runWithLock acquires on its own.
    const lock = new MigrationLock(mongo.db, LOCK_COLLECTION, 2);

    let iterations = 0;
    const started = deferred();
    const run = runWithLock(lock, { logger: silentLogger }, async (signal) => {
      started.resolve();
      for (let i = 0; i < 10; i++) {
        if (signal.aborted) throw signal.reason;
        iterations += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return 'completed';
    });

    await started.promise;
    await stealLock();

    await assert.rejects(run, LockLostError);
    // It stopped early rather than running all ten iterations.
    assert.ok(iterations < 10, `expected an early stop, ran ${iterations} iterations`);
  });

  it('should only warn when onLockLost is "warn"', async () => {
    const warnings = [];
    const logger = { ...silentLogger, warn: (msg) => warnings.push(msg) };
    const lock = new MigrationLock(mongo.db, LOCK_COLLECTION, 2);

    const started = deferred();
    const run = runWithLock(lock, { logger, onLockLost: 'warn' }, async (signal) => {
      started.resolve();
      for (let i = 0; i < 6; i++) {
        if (signal.aborted) throw signal.reason;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return 'completed';
    });

    await started.promise;
    await stealLock();

    assert.strictEqual(await run, 'completed');
    assert.ok(warnings.some((msg) => msg.includes('Lost the migration lock')));
  });

  it('should not let a release failure mask the original error', async () => {
    const lock = new MigrationLock(mongo.db, LOCK_COLLECTION, 60);
    // Release blows up; the migration error must still be what surfaces.
    lock.release = () => Promise.reject(new Error('release exploded'));
    await assert.rejects(
      runWithLock(lock, { logger: silentLogger }, () =>
        Promise.reject(new Error('the real failure')),
      ),
      /the real failure/,
    );
  });

  it('should surface a release failure when the run itself succeeded', async () => {
    const lock = new MigrationLock(mongo.db, LOCK_COLLECTION, 60);
    lock.release = () => Promise.reject(new Error('release exploded'));
    await assert.rejects(
      runWithLock(lock, { logger: silentLogger }, () => Promise.resolve('ok')),
      /release exploded/,
    );
  });
});

describe('MigratorKit.stop (integration)', () => {
  it('should finish the running migration, skip the rest, and release the lock', async () => {
    project.write('0001-a.ts', slowMigration('things', 'a', 120));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    project.write('0003-c.ts', insertMigration('things', 'c'));

    // Stop exactly when the first migration starts executing, rather than on a
    // timer that races the connect phase.
    const progress = {
      onStart: (name) => {
        if (name === '0001-a.ts') kit.stop('test stop');
      },
      onStop: () => undefined,
    };
    const kit = makeMigrator(mongo.uri, DB, project.dir, {}, { progress });
    const run = kit.up();

    await assert.rejects(run, (error) => {
      assert.ok(error instanceof RunAbortedError);
      assert.strictEqual(error.code, 'RUN_ABORTED');
      // Partial progress is reported, not thrown away.
      assert.strictEqual(error.context.results.length, 1);
      assert.strictEqual(error.context.results[0].file, '0001-a.ts');
      return true;
    });
    await kit.disconnect();

    // The in-flight migration completed and was recorded; the others did not run.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
    const applied = await mongo.db.collection('_migronaut_migrations').find().toArray();
    assert.deepStrictEqual(
      applied.map((r) => r.name),
      ['0001-a.ts'],
    );
    // Crucially, the lock is gone — a stopped run must not need `migronaut unlock`.
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
  });

  it('should stop a rollback between migrations, mirroring the up() contract', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const seed = migrator();
    await seed.up();
    await seed.disconnect();

    // Stop as the first revert starts: the down() loop must honor the abort
    // signal exactly the way up() does.
    const progress = {
      onStart: (name, direction) => {
        if (direction === 'down' && name === '0002-b.ts') kit.stop('test stop');
      },
      onStop: () => undefined,
    };
    const kit = makeMigrator(mongo.uri, DB, project.dir, {}, { progress });

    await assert.rejects(kit.down(undefined, {}), (error) => {
      assert.ok(error instanceof RunAbortedError);
      // The revert in flight completed; the rest stayed applied.
      assert.strictEqual(error.context.results.length, 1);
      assert.strictEqual(error.context.results[0].file, '0002-b.ts');
      assert.strictEqual(error.context.results[0].status, 'reverted');
      return true;
    });
    await kit.disconnect();
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
  });

  it('should expose the abort signal to a down() migration context', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const seed = migrator();
    await seed.up();
    await seed.disconnect();

    let sawSignal;
    const kit = migrator({
      hooks: {
        beforeEach: async (_name, ctx) => {
          sawSignal = ctx.signal instanceof AbortSignal;
        },
      },
    });
    await kit.down(undefined, {});
    await kit.disconnect();
    // index.d.ts promises ctx.signal whenever the run can be stopping — the
    // rollback path included; it used to be silently absent there.
    assert.strictEqual(sawSignal, true);
  });

  it('should be a no-op when nothing is running', async () => {
    const kit = migrator();
    assert.doesNotThrow(() => kit.stop());
    await kit.disconnect();
  });

  it('should not let a stop from a finished run abort a later one', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const kit = migrator();
    try {
      await kit.up('0001-a.ts');
      // A stop that lands between runs (e.g. racing the previous run's
      // teardown) is aimed at that run — it must not poison an unrelated
      // up() later.
      kit.stop('stale stop');
      const results = await kit.up();
      assert.deepStrictEqual(
        results.map((r) => r.file),
        ['0002-b.ts'],
      );
    } finally {
      await kit.disconnect();
    }
  });
});

describe('hook guarantees (integration)', () => {
  it('should run afterAll even when the run fails', async () => {
    project.write('0001-bad.ts', 'export async function up() { throw new Error("boom"); }\n');
    const calls = [];
    const kit = migrator({
      hooks: {
        beforeAll: async () => {
          calls.push('beforeAll');
        },
        afterAll: async (_ctx, summary) => {
          calls.push(`afterAll:${summary.success}`);
        },
      },
    });
    await assert.rejects(kit.up());
    await kit.disconnect();
    assert.deepStrictEqual(calls, ['beforeAll', 'afterAll:false']);
  });

  it('should not let a throwing afterAll mask the migration failure', async () => {
    project.write('0001-bad.ts', failingMigration());
    const kit = migrator({
      hooks: {
        afterAll: async () => {
          throw new Error('slack notification failed');
        },
      },
    });
    try {
      // The caller must see the migration failure (with its partial results),
      // not the notification hook's own trouble.
      await assert.rejects(kit.up(), (error) => {
        assert.strictEqual(error.code, 'MIGRATION_EXECUTION_FAILED');
        assert.ok(Array.isArray(error.context.results));
        return true;
      });
    } finally {
      await kit.disconnect();
    }
  });

  it('should still surface a throwing afterAll when the run itself succeeded', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator({
      hooks: {
        afterAll: async () => {
          throw new Error('cleanup failed');
        },
      },
    });
    try {
      await assert.rejects(kit.up(), (error) => {
        assert.ok(error instanceof HookFailedError);
        return true;
      });
    } finally {
      await kit.disconnect();
    }
  });

  it('should report success and the applied count to afterAll', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    let summary;
    const kit = migrator({
      hooks: {
        afterAll: async (_ctx, s) => {
          summary = s;
        },
      },
    });
    await kit.up();
    await kit.disconnect();
    assert.deepStrictEqual(summary, { success: true, applied: 2, direction: 'up' });
  });

  it('should not fire beforeEach for a skipped migration', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const first = migrator();
    await first.up();
    await first.disconnect();

    const started = [];
    const finished = [];
    const kit = migrator({
      hooks: {
        beforeEach: async (name) => {
          started.push(name);
        },
        afterEach: async (name) => {
          finished.push(name);
        },
      },
    });
    project.write('0002-b.ts', insertMigration('things', 'b'));
    await kit.up();
    await kit.disconnect();
    // 0001-a is already applied: neither hook owes it a call, so they stay paired.
    assert.deepStrictEqual(started, ['0002-b.ts']);
    assert.deepStrictEqual(finished, ['0002-b.ts']);
  });

  it('should pass direction and position to per-migration hooks', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));
    const seen = [];
    const kit = migrator({
      hooks: {
        beforeEach: async (name, _ctx, info) => {
          seen.push({ name, ...info });
        },
      },
    });
    await kit.up();
    await kit.disconnect();
    assert.deepStrictEqual(seen, [
      { name: '0001-a.ts', direction: 'up', index: 0, total: 2 },
      { name: '0002-b.ts', direction: 'up', index: 1, total: 2 },
    ]);
  });

  it('should wrap a throwing hook in HookFailedError', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const kit = migrator({
      hooks: {
        beforeAll: async () => {
          throw new Error('hook exploded');
        },
      },
    });
    await assert.rejects(kit.up(), (error) => {
      assert.ok(error instanceof HookFailedError);
      assert.strictEqual(error.code, 'HOOK_FAILED');
      assert.strictEqual(error.context.hook, 'beforeAll');
      assert.strictEqual(error.context.cause, 'hook exploded');
      return true;
    });
    await kit.disconnect();
    // The hook failed before anything ran, so nothing was applied.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
  });
});

describe('run correlation (integration)', () => {
  it('should stamp one runId on every record and on the lock that held it', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));

    // Sample the lock's owner while the run is in flight; afterwards the lock
    // is gone, so this is the only chance to compare it with the records.
    let lockOwner;
    const kit = makeMigrator(
      mongo.uri,
      DB,
      project.dir,
      {},
      {
        progress: {
          onStart: () => {
            if (lockOwner === undefined) {
              lockOwner = mongo.db
                .collection(LOCK_COLLECTION)
                .findOne({ _id: LOCK_ID })
                .then((doc) => doc?.owner);
            }
          },
          onStop: () => undefined,
        },
      },
    );
    await kit.up();
    const owner = await lockOwner;
    await kit.disconnect();

    const records = await mongo.db.collection('_migronaut_migrations').find().toArray();
    const runIds = new Set(records.map((r) => r.runId));
    assert.strictEqual(runIds.size, 1, 'all records of one run share a runId');
    // The same token identifies the lock, so a leftover lock can be traced to
    // the exact run (and the migrations) that held it.
    assert.strictEqual([...runIds][0], owner);
  });

  it('should use a different runId for each run', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const first = migrator();
    await first.up();
    await first.disconnect();

    project.write('0002-b.ts', insertMigration('things', 'b'));
    const second = migrator();
    await second.up();
    await second.disconnect();

    const records = await mongo.db.collection('_migronaut_migrations').find().toArray();
    assert.strictEqual(new Set(records.map((r) => r.runId)).size, 2);
  });
});

describe('redo atomicity (integration)', () => {
  it('should hold a single lock across both directions', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const setup = migrator();
    await setup.up();
    await setup.disconnect();

    // Sample the lock document as each phase begins. A release between down and
    // up would show up as a missing document or a fresh owner token, since
    // acquire() mints a new UUID every time.
    const samples = [];
    const reads = [];
    const kit = makeMigrator(
      mongo.uri,
      DB,
      project.dir,
      {},
      {
        progress: {
          onStart: (_name, direction) => {
            reads.push(
              mongo.db
                .collection(LOCK_COLLECTION)
                .findOne({ _id: LOCK_ID })
                .then((doc) => samples.push({ direction, owner: doc?.owner ?? null })),
            );
          },
          onStop: () => undefined,
        },
      },
    );

    const results = await kit.redo();
    await Promise.all(reads);
    await kit.disconnect();

    assert.deepStrictEqual(
      results.map((r) => r.status),
      ['reverted', 'applied'],
    );
    assert.deepStrictEqual(
      samples.map((s) => s.direction),
      ['down', 'up'],
    );
    assert.ok(samples[0].owner, 'no lock was held during the down phase');
    assert.strictEqual(
      samples[1].owner,
      samples[0].owner,
      'the lock was released and re-acquired between down and up',
    );
    // And it is cleaned up once the redo finishes.
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
  });
});
