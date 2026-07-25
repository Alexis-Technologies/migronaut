const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { LOCK_ID, MigrationLock, runWithLock } = require('../../src/core/lock.js');
const { LockAlreadyHeldError, LockReleaseFailedError } = require('../../src/errors/index.js');
const { silentLogger } = require('../../src/utils/logger.js');

function makeDb() {
  // acquire() upserts with a random `owner` token, then reads it back to confirm
  // ownership. The mock captures the token from the update and echoes it from
  // findOne so a successful acquire resolves.
  let storedOwner;
  const collection = {
    updateOne: mock.fn((_filter, update) => {
      const owner = update?.$set?.owner;
      if (owner) {
        storedOwner = owner;
      }
      return Promise.resolve({ matchedCount: 1 });
    }),
    findOne: mock.fn(() =>
      Promise.resolve(storedOwner ? { _id: LOCK_ID, owner: storedOwner, pid: process.pid } : null),
    ),
    deleteOne: mock.fn(() => Promise.resolve({})),
  };
  const db = { collection: () => collection };
  return { db, collection };
}

describe('MigrationLock.acquire', () => {
  it('should upsert the lock document with the configured _id', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await lock.acquire();
    assert.strictEqual(collection.updateOne.mock.callCount(), 1);
    const [filter, , options] = collection.updateOne.mock.calls[0].arguments;
    assert.strictEqual(filter._id, LOCK_ID);
    assert.deepStrictEqual(options, { upsert: true });
  });

  it('should throw LockAlreadyHeldError on a duplicate-key error', async () => {
    const { db, collection } = makeDb();
    // eslint-disable-next-line prefer-promise-reject-errors -- simulates MongoDB's plain-object duplicate-key error
    collection.updateOne.mock.mockImplementationOnce(() => Promise.reject({ code: 11000 }));
    collection.findOne.mock.mockImplementationOnce(() =>
      Promise.resolve({ _id: LOCK_ID, pid: 999 }),
    );
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire(), LockAlreadyHeldError);
  });

  it('should rethrow non-duplicate-key errors', async () => {
    const { db, collection } = makeDb();
    collection.updateOne.mock.mockImplementationOnce(() =>
      Promise.reject(new Error('network down')),
    );
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire(), /network down/);
  });

  it('should throw when another writer won the stale-reclaim race', async () => {
    const { db, collection } = makeDb();
    // Upsert succeeds, but the read-back shows a different owner token.
    collection.findOne.mock.mockImplementationOnce(() =>
      Promise.resolve({ _id: LOCK_ID, owner: 'other-writer' }),
    );
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire(), LockAlreadyHeldError);
  });

  it('should throw when the lock document is missing after upsert', async () => {
    const { db, collection } = makeDb();
    collection.findOne.mock.mockImplementationOnce(() => Promise.resolve(null));
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire(), LockAlreadyHeldError);
  });
});

describe('MigrationLock.inspect / forceRelease', () => {
  it('should return the current lock document from inspect', async () => {
    const { db, collection } = makeDb();
    const doc = { _id: LOCK_ID, owner: 'abc', pid: 1 };
    collection.findOne.mock.mockImplementationOnce(() => Promise.resolve(doc));
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    assert.strictEqual(await lock.inspect(), doc);
  });

  it('should delete and return the existing doc from forceRelease', async () => {
    const { db, collection } = makeDb();
    const doc = { _id: LOCK_ID, owner: 'abc' };
    collection.findOne.mock.mockImplementationOnce(() => Promise.resolve(doc));
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    assert.strictEqual(await lock.forceRelease(), doc);
    assert.deepStrictEqual(collection.deleteOne.mock.calls[0].arguments, [{ _id: LOCK_ID }]);
  });

  it('should return null from forceRelease when no lock exists', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    assert.strictEqual(await lock.forceRelease(), null);
    assert.deepStrictEqual(collection.deleteOne.mock.calls[0].arguments, [{ _id: LOCK_ID }]);
  });
});

describe('MigrationLock.renew', () => {
  it('should return false before the lock is acquired', async () => {
    const { db } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    assert.strictEqual(await lock.renew(), false);
  });

  it('should return true while the lock is still held', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await lock.acquire();
    collection.updateOne.mock.mockImplementationOnce(() => Promise.resolve({ matchedCount: 1 }));
    assert.strictEqual(await lock.renew(), true);
  });

  it('should return false when the lock has been lost', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await lock.acquire();
    collection.updateOne.mock.mockImplementationOnce(() => Promise.resolve({ matchedCount: 0 }));
    assert.strictEqual(await lock.renew(), false);
  });
});

describe('MigrationLock.release', () => {
  it('should delete the lock document', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await lock.release();
    assert.deepStrictEqual(collection.deleteOne.mock.calls[0].arguments, [{ _id: LOCK_ID }]);
  });

  it('should throw LockReleaseFailedError when delete fails', async () => {
    const { db, collection } = makeDb();
    collection.deleteOne.mock.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.release(), LockReleaseFailedError);
  });
});

describe('runWithLock', () => {
  it('should acquire then release around the function on success', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    const result = await runWithLock(lock, { logger: silentLogger }, async () => 'ok');
    assert.strictEqual(result, 'ok');
    assert.strictEqual(collection.updateOne.mock.callCount(), 1);
    assert.strictEqual(collection.deleteOne.mock.callCount(), 1);
  });

  it('should release the lock even when the function throws', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(
      runWithLock(lock, { logger: silentLogger }, async () => {
        throw new Error('migration failed');
      }),
      /migration failed/,
    );
    assert.strictEqual(collection.deleteOne.mock.callCount(), 1);
  });

  it('should skip acquisition and warn when noLock is true', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    const warn = mock.fn();
    await runWithLock(lock, { noLock: true, logger: { ...silentLogger, warn } }, async () => 'ok');
    assert.strictEqual(collection.updateOne.mock.callCount(), 0);
    assert.strictEqual(collection.deleteOne.mock.callCount(), 0);
    assert.strictEqual(warn.mock.callCount(), 1);
  });
});
