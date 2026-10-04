const assert = require('node:assert/strict');
const { after, before, beforeEach, afterEach, describe, it } = require('node:test');
const { LOCK_ID, MigrationLock, runWithLock } = require('../../src/core/lock.js');
const {
  ConfigInvalidError,
  HookFailedError,
  LockAlreadyHeldError,
  LockLostError,
  RunAbortedError,
} = require('../../src/errors/index.js');
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

describe('custom id format — generateId (integration)', () => {
  /** The lock document, sampled once while a run holds it */
  function lockSampler() {
    let sample;
    return {
      progress: {
        onStart: () => {
          sample ??= mongo.db.collection(LOCK_COLLECTION).findOne({ _id: LOCK_ID });
        },
        onStop: () => undefined,
      },
      read: () => sample,
    };
  }

  it('should mint the run id through generateId — records, lock, events and status', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    project.write('0002-b.ts', insertMigration('things', 'b'));

    let count = 0;
    const sampler = lockSampler();
    const kit = makeMigrator(
      mongo.uri,
      DB,
      project.dir,
      { generateId: () => `run_${++count}` },
      { progress: sampler.progress },
    );
    const events = [];
    for (const name of ['run:start', 'lock:acquired', 'migration:success', 'run:end']) {
      kit.on(name, (event) => events.push({ name, runId: event.runId, owner: event.owner }));
    }

    const results = await kit.up();
    const lockDoc = await sampler.read();

    assert.strictEqual(results.length, 2);
    assert.ok(events.length >= 5);
    assert.ok(events.every((event) => event.runId === 'run_1'));
    assert.strictEqual(events.find((event) => event.name === 'lock:acquired').owner, 'run_1');

    assert.strictEqual(lockDoc.owner, 'run_1');
    // The lock's own token: never the user's id, and never taken from its generator.
    assert.match(lockDoc.nonce, /^[0-9a-f-]{36}$/);
    assert.strictEqual(count, 1, 'one run mints exactly one id');

    const records = await mongo.db.collection('_migronaut_migrations').find().toArray();
    assert.deepStrictEqual(
      records.map((record) => record.runId),
      ['run_1', 'run_1'],
    );
    const status = await kit.status();
    assert.deepStrictEqual(
      status.map((row) => row.runId),
      ['run_1', 'run_1'],
    );

    // The next run on the same kit asks the generator again.
    project.write('0003-c.ts', insertMigration('things', 'c'));
    await kit.up();
    await kit.disconnect();
    const third = await mongo.db.collection('_migronaut_migrations').findOne({ name: '0003-c.ts' });
    assert.strictEqual(third.runId, 'run_2');
  });

  it('should stamp reverted, failed and baselined records with the custom id too', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    let count = 0;
    const kit = migrator({ generateId: () => `run_${++count}` });
    const changelog = mongo.db.collection('_migronaut_migrations');

    await kit.baseline();
    assert.strictEqual((await changelog.findOne({ name: '0001-a.ts' })).runId, 'run_1');

    project.write('0002-b.ts', insertMigration('things', 'b'));
    await kit.up();
    await kit.down();
    assert.strictEqual((await changelog.findOne({ name: '0002-b.ts' })).status, 'reverted');

    project.write('0003-c.ts', failingMigration());
    await assert.rejects(kit.up('0003-c.ts'));
    await kit.disconnect();
    const failed = await changelog.findOne({ name: '0003-c.ts' });
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.runId, 'run_4');
  });

  it('should refuse the run when the generator throws, then run cleanly once it recovers', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    let broken = true;
    const kit = migrator({
      generateId: () => {
        if (broken) throw new Error('entropy pool closed');
        return 'run_recovered';
      },
    });
    const started = [];
    kit.on('run:start', (event) => started.push(event.runId));

    await assert.rejects(kit.up(), (error) => {
      assert.ok(error instanceof ConfigInvalidError);
      assert.strictEqual(error.message, 'generateId threw');
      assert.strictEqual(error.cause.message, 'entropy pool closed');
      return true;
    });
    // Refused before any run state existed: no event, no lock, nothing applied.
    assert.deepStrictEqual(started, []);
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);

    // And nothing was left behind that would make the kit think a run is in flight.
    broken = false;
    const results = await kit.up();
    await kit.disconnect();
    assert.deepStrictEqual(
      results.map((row) => row.status),
      ['applied'],
    );
    assert.deepStrictEqual(started, ['run_recovered']);
  });

  for (const [label, generateId, message] of [
    ['an empty id', () => '', /non-empty string/],
    ['an id over 128 characters', () => 'r'.repeat(129), /at most 128 characters/],
    ['a non-string id', () => 42, /non-empty string/],
    ['a promise', async () => 'too-late', /must be synchronous/],
  ]) {
    it(`should refuse the run when the generator returns ${label}`, async () => {
      project.write('0001-a.ts', insertMigration('things', 'a'));
      const kit = migrator({ generateId });
      await assert.rejects(kit.up(), (error) => {
        assert.strictEqual(error.code, 'CONFIG_INVALID');
        assert.match(error.message, message);
        return true;
      });
      await kit.disconnect();
      assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
      assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
    });
  }

  it('should keep two runs apart even when their generator hands both the same id', async () => {
    // `generateId: () => process.env.DEPLOY_ID`, or a counter that starts at 1
    // in every process: both runs get one owner token. The owner readback alone
    // would then tell the second run it holds the lock.
    project.write('0001-slow.ts', slowMigration('things', 'a', 400));
    const generateId = () => 'same-for-everyone';
    const started = deferred();
    const first = makeMigrator(
      mongo.uri,
      DB,
      project.dir,
      { generateId },
      { progress: { onStart: () => started.resolve(), onStop: () => undefined } },
    );
    const second = migrator({ generateId });

    const running = first.up();
    let results;
    try {
      await started.promise;
      const held = await mongo.db.collection(LOCK_COLLECTION).findOne({ _id: LOCK_ID });
      assert.strictEqual(held.owner, 'same-for-everyone');

      await assert.rejects(second.up(), LockAlreadyHeldError);
      // The refused run must not have released the lock on its way out either.
      const after = await mongo.db.collection(LOCK_COLLECTION).findOne({ _id: LOCK_ID });
      assert.strictEqual(after.nonce, held.nonce);
      results = await running;
    } finally {
      // Open clients would keep a failing run of this test from ever exiting.
      await running.catch(() => undefined);
      await first.disconnect();
      await second.disconnect();
    }
    assert.deepStrictEqual(
      results.map((row) => row.status),
      ['applied'],
    );
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
  });

  it('should not let a same-id run reclaim-and-release under a live holder', async () => {
    // The direct form of the hazard, on the lock itself: two holders, one token.
    const holder = new MigrationLock(mongo.db, LOCK_COLLECTION, 60);
    const peer = new MigrationLock(mongo.db, LOCK_COLLECTION, 60);
    await holder.acquire('same-for-everyone');
    await assert.rejects(peer.acquire('same-for-everyone'), LockAlreadyHeldError);
    assert.strictEqual(await peer.renew(), false);
    await peer.release();
    assert.strictEqual(await holder.renew(), true, 'the holder lost its lock to a same-id peer');
    await holder.release();
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
  });
});

describe('redo atomicity (integration)', () => {
  it('should hold a single lock across both directions', async () => {
    project.write('0001-a.ts', insertMigration('things', 'a'));
    const setup = migrator();
    await setup.up();
    await setup.disconnect();

    // Sample the lock document as each phase begins. A release between down and
    // up would show up as a missing document or a fresh nonce, since acquire()
    // mints a new one every time (the owner token alone would not tell: it is
    // the run id, and one redo is one run).
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
                .then((doc) =>
                  samples.push({ direction, owner: doc?.owner ?? null, nonce: doc?.nonce ?? null }),
                ),
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
    assert.strictEqual(samples[1].owner, samples[0].owner);
    assert.ok(samples[0].nonce, 'the lock document carries no nonce');
    assert.strictEqual(
      samples[1].nonce,
      samples[0].nonce,
      'the lock was released and re-acquired between down and up',
    );
    // And it is cleaned up once the redo finishes.
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
  });
});
