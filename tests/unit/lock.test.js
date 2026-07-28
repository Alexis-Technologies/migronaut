const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { LOCK_ID, MigrationLock, runWithLock, toLockInfo } = require('../../src/core/lock.js');
const { LockAlreadyHeldError, LockReleaseFailedError } = require('../../src/errors/index.js');
const { silentLogger } = require('../../src/utils/logger.js');
const { keepEventLoopAlive } = require('../helpers/event-loop.js');

// The owner token an acquire() or renew() update would store, or undefined.
// acquire() sends a $replaceWith/$cond pipeline (server-time `$$NOW` stamping)
// whose taken-branch document carries the `$literal`-wrapped owner.
function ownerFromUpdate(update) {
  const stage = Array.isArray(update) ? update[0] : update;
  const raw = stage?.$replaceWith?.$cond?.[1]?.owner ?? stage?.$set?.owner;
  return raw && typeof raw === 'object' ? raw.$literal : raw;
}

function makeDb() {
  // acquire() upserts with a random `owner` token, then reads it back to confirm
  // ownership. The mock captures the token from the update and echoes it from
  // findOne so a successful acquire resolves.
  let storedOwner;
  const collection = {
    updateOne: mock.fn((_filter, update) => {
      const owner = ownerFromUpdate(update);
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

  it('should not leak the owner token in the LockAlreadyHeldError context', async () => {
    const { db, collection } = makeDb();
    // eslint-disable-next-line prefer-promise-reject-errors -- simulates MongoDB's plain-object duplicate-key error
    collection.updateOne.mock.mockImplementationOnce(() => Promise.reject({ code: 11000 }));
    const lockedAt = new Date();
    collection.findOne.mock.mockImplementationOnce(() =>
      Promise.resolve({
        _id: LOCK_ID,
        owner: 'secret-owner-token',
        lockedAt,
        pid: 999,
        host: 'ci-runner',
        executedBy: 'deploy',
      }),
    );
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire(), (error) => {
      assert.deepStrictEqual(error.context.holder, {
        lockedAt,
        pid: 999,
        host: 'ci-runner',
        executedBy: 'deploy',
      });
      assert.ok(!JSON.stringify(error.context).includes('secret-owner-token'));
      return true;
    });
  });

  it('should not leak the owner token when losing the stale-reclaim race', async () => {
    const { db, collection } = makeDb();
    collection.findOne.mock.mockImplementationOnce(() =>
      Promise.resolve({ _id: LOCK_ID, owner: 'other-writer', pid: 7 }),
    );
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire(), (error) => {
      assert.ok(!JSON.stringify(error.context).includes('other-writer'));
      assert.strictEqual(error.context.holder.pid, 7);
      return true;
    });
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

describe('toLockInfo', () => {
  it('should strip the owner token and _id from a lock document', () => {
    const lockedAt = new Date();
    assert.deepStrictEqual(
      toLockInfo({
        _id: LOCK_ID,
        owner: 'secret-owner-token',
        lockedAt,
        pid: 42,
        host: 'box',
        executedBy: 'alex',
      }),
      { lockedAt, pid: 42, host: 'box', executedBy: 'alex' },
    );
  });

  it('should return null for a missing document', () => {
    assert.strictEqual(toLockInfo(null), null);
    assert.strictEqual(toLockInfo(undefined), null);
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

  it('should emit balanced acquired/released events with skipped when noLock is true', async () => {
    const { db } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    const events = [];
    await runWithLock(
      lock,
      {
        noLock: true,
        logger: silentLogger,
        onLockAcquired: (extra) => events.push(['acquired', extra]),
        onLockReleased: (extra) => events.push(['released', extra]),
      },
      async () => 'ok',
    );
    assert.deepStrictEqual(events, [
      ['acquired', { skipped: true }],
      ['released', { skipped: true }],
    ]);
  });

  it('should abort via the TTL deadline when renewals keep failing', async () => {
    const { db, collection } = makeDb();
    // 200ms TTL → renew every 100ms, hard deadline at 150ms. Every renewal
    // fails; the deadline is the sole escalation and must fire strictly
    // before the lock becomes stale-reclaimable at 1×TTL.
    const lock = new MigrationLock(db, '_migronaut_locks', 0.2);
    let owner;
    collection.updateOne.mock.mockImplementation((_filter, update) => {
      // acquire() carries the owner token; renew() only re-stamps lockedAt.
      const raw = ownerFromUpdate(update);
      if (raw) {
        owner = raw;
        return Promise.resolve({ matchedCount: 1 });
      }
      return Promise.reject(new Error('network blip'));
    });
    collection.findOne.mock.mockImplementation(() => Promise.resolve({ _id: LOCK_ID, owner }));
    const started = Date.now();
    // The mocked driver does no I/O, so the unref'ed deadline timer is the only
    // pending handle — see tests/helpers/event-loop.js.
    const release = keepEventLoopAlive();
    try {
      await assert.rejects(
        runWithLock(
          lock,
          { logger: silentLogger },
          (signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        ),
        (error) => {
          assert.strictEqual(error.code, 'LOCK_LOST');
          return true;
        },
      );
    } finally {
      release();
    }
    // Aborted around the deadline (~150ms) — strictly before 1×TTL (200ms)
    // plus scheduling slack.
    assert.ok(Date.now() - started < 280);
  });

  it('should report ttlMs and acquisition latency on lock:acquired', async () => {
    const { db } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    let extra;
    await runWithLock(
      lock,
      { logger: silentLogger, onLockAcquired: (e) => (extra = e) },
      async () => 'ok',
    );
    assert.strictEqual(extra.ttlMs, 60_000);
    assert.strictEqual(typeof extra.acquireMs, 'number');
    assert.ok(extra.acquireMs >= 0);
  });

  it('should not start a second renewal while one is still in flight', async () => {
    const { db, collection } = makeDb();
    // 200ms TTL → tick every 100ms. The first renewal never settles until we
    // let it; without the re-entrancy guard, every later tick would overwrite
    // `inFlight` and fire its own overlapping renewal.
    const lock = new MigrationLock(db, '_migronaut_locks', 0.2);
    let owner;
    let renewCalls = 0;
    let releaseRenewal;
    collection.updateOne.mock.mockImplementation((_filter, update) => {
      const raw = ownerFromUpdate(update);
      if (raw) {
        owner = raw;
        return Promise.resolve({ matchedCount: 1 });
      }
      renewCalls += 1;
      // A renewal slower than the whole interval — the exact condition the
      // heartbeat exists to survive.
      return new Promise((resolve) => {
        releaseRenewal = () => resolve({ matchedCount: 1 });
      });
    });
    collection.findOne.mock.mockImplementation(() => Promise.resolve({ _id: LOCK_ID, owner }));
    await runWithLock(
      lock,
      { logger: silentLogger },
      () =>
        new Promise((resolve) => {
          // Ticks land at ~100/200/300ms; the renewal started at ~100ms stays
          // stuck through the 200/300 ticks, then the run ends at ~325ms —
          // comfortably before the 400ms tick could start a second renewal.
          setTimeout(() => {
            releaseRenewal?.();
            setTimeout(resolve, 5);
          }, 320);
        }),
    );
    assert.strictEqual(renewCalls, 1);
  });
});
