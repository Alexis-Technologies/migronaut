const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it, mock } = require('node:test');
const { LOCK_ID, MigrationLock, runWithLock } = require('../../src/core/lock.js');
const { LockAlreadyHeldError } = require('../../src/errors/index.js');
const { silentLogger } = require('../../src/utils/logger.js');
const { startTestMongo } = require('../helpers/mongo.js');

let mongo;
const COLLECTION = '_migronaut_locks';

before(async () => {
  mongo = await startTestMongo('migronaut_lock_test');
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.collection(COLLECTION).deleteMany({});
});

describe('MigrationLock (integration)', () => {
  it('should acquire a lock successfully', async () => {
    const lock = new MigrationLock(mongo.db, COLLECTION, 60);
    await lock.acquire();
    const doc = await mongo.db.collection(COLLECTION).findOne({ _id: LOCK_ID });
    assert.notStrictEqual(doc, null);
    assert.strictEqual(doc?.pid, process.pid);
  });

  it('should throw LockAlreadyHeldError when a lock is held within TTL', async () => {
    const first = new MigrationLock(mongo.db, COLLECTION, 60);
    await first.acquire();
    const second = new MigrationLock(mongo.db, COLLECTION, 60);
    await assert.rejects(second.acquire(), LockAlreadyHeldError);
  });

  it('should allow a new lock once the previous one is stale', async () => {
    // Insert a lock that is already older than the (tiny) TTL.
    await mongo.db.collection(COLLECTION).insertOne({
      _id: LOCK_ID,
      lockedAt: new Date(Date.now() - 10_000),
      pid: 1,
      host: 'old-host',
      executedBy: 'old-user',
    });
    const lock = new MigrationLock(mongo.db, COLLECTION, 1);
    assert.strictEqual(await lock.acquire(), undefined);
    const doc = await mongo.db.collection(COLLECTION).findOne({ _id: LOCK_ID });
    assert.strictEqual(doc?.pid, process.pid);
  });

  it('should release the lock in finally on success', async () => {
    const lock = new MigrationLock(mongo.db, COLLECTION, 60);
    await runWithLock(lock, { logger: silentLogger }, async () => undefined);
    const doc = await mongo.db.collection(COLLECTION).findOne({ _id: LOCK_ID });
    assert.strictEqual(doc, null);
  });

  it('should release the lock in finally on error', async () => {
    const lock = new MigrationLock(mongo.db, COLLECTION, 60);
    await assert.rejects(
      runWithLock(lock, { logger: silentLogger }, async () => {
        throw new Error('kaboom');
      }),
      /kaboom/,
    );
    const doc = await mongo.db.collection(COLLECTION).findOne({ _id: LOCK_ID });
    assert.strictEqual(doc, null);
  });

  it('should renew a held lock so it survives past its TTL (heartbeat)', async () => {
    // 1s TTL → heartbeat renews every ~500ms. We hold the lock for longer than
    // the TTL; without renewal the lock would have gone stale and been
    // reclaimable, which is the exact bug this fixes.
    const lock = new MigrationLock(mongo.db, COLLECTION, 1);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const run = runWithLock(lock, { logger: silentLogger }, async () => {
      await gate;
    });

    // Wait well past the 1s TTL while the migration is still "running".
    await new Promise((resolve) => setTimeout(resolve, 1400));

    const competitor = new MigrationLock(mongo.db, COLLECTION, 1);
    await assert.rejects(competitor.acquire(), LockAlreadyHeldError);

    release();
    await run;

    // Released cleanly afterwards.
    const doc = await mongo.db.collection(COLLECTION).findOne({ _id: LOCK_ID });
    assert.strictEqual(doc, null);
  });

  it('should not release a lock that was reclaimed by another holder', async () => {
    const first = new MigrationLock(mongo.db, COLLECTION, 1);
    await first.acquire();

    // Let the lock go stale, then a second holder reclaims it.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = new MigrationLock(mongo.db, COLLECTION, 1);
    await second.acquire();

    // The first holder's release is owner-scoped, so it must not delete the
    // second holder's lock.
    await first.release();
    const doc = await mongo.db.collection(COLLECTION).findOne({ _id: LOCK_ID });
    assert.notStrictEqual(doc, null);
  });

  it('should skip acquisition and warn with --no-lock', async () => {
    const lock = new MigrationLock(mongo.db, COLLECTION, 60);
    const warn = mock.fn();
    await runWithLock(lock, { noLock: true, logger: { ...silentLogger, warn } }, async () => {
      const doc = await mongo.db.collection(COLLECTION).findOne({ _id: LOCK_ID });
      assert.strictEqual(doc, null);
    });
    assert.strictEqual(warn.mock.callCount(), 1);
  });
});
