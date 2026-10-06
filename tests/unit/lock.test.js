const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { LOCK_ID, MigrationLock, runWithLock, toLockInfo } = require('../../src/core/lock.js');
const { LockAlreadyHeldError, LockReleaseFailedError } = require('../../src/errors/index.js');
const { silentLogger } = require('../../src/utils/logger.js');
const { keepEventLoopAlive } = require('../helpers/event-loop.js');

// The ownership fields an acquire() update would store, or undefined for any
// other update (a renew() only re-stamps lockedAt). acquire() sends a
// $replaceWith/$cond pipeline (server-time `$$NOW` stamping) whose taken-branch
// document carries the `$literal`-wrapped owner token and nonce.
function heldFromUpdate(update) {
  const stage = Array.isArray(update) ? update[0] : update;
  const doc = stage?.$replaceWith?.$cond?.[1];
  return doc ? { owner: doc.owner.$literal, nonce: doc.nonce.$literal } : undefined;
}

function makeDb() {
  // acquire() upserts with an `owner` token and a nonce, then reads them back
  // to confirm ownership. The mock captures both from the update and echoes
  // them from findOne so a successful acquire resolves.
  let held;
  const collection = {
    updateOne: mock.fn((_filter, update) => {
      const taken = heldFromUpdate(update);
      if (taken) {
        held = taken;
      }
      return Promise.resolve({ matchedCount: 1 });
    }),
    findOne: mock.fn(() =>
      Promise.resolve(held ? { _id: LOCK_ID, ...held, pid: process.pid } : null),
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

  it('should report the holder by run id, never by nonce, in the LockAlreadyHeldError context', async () => {
    const { db, collection } = makeDb();
    // eslint-disable-next-line prefer-promise-reject-errors -- simulates MongoDB's plain-object duplicate-key error
    collection.updateOne.mock.mockImplementationOnce(() => Promise.reject({ code: 11000 }));
    const lockedAt = new Date();
    collection.findOne.mock.mockImplementationOnce(() =>
      Promise.resolve({
        _id: LOCK_ID,
        owner: 'run-7',
        nonce: 'secret-nonce',
        lockedAt,
        pid: 999,
        host: 'ci-runner',
        executedBy: 'deploy',
        ttlMs: 120_000,
      }),
    );
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire(), (error) => {
      assert.deepStrictEqual(error.context.holder, {
        lockedAt,
        pid: 999,
        host: 'ci-runner',
        executedBy: 'deploy',
        runId: 'run-7',
        ttlMs: 120_000,
      });
      // This process's own TTL, for a waiter whose holder predates ttlMs.
      assert.strictEqual(error.context.ttlMs, 60_000);
      assert.ok(!JSON.stringify(error.context).includes('secret-nonce'));
      return true;
    });
  });

  it('should not leak the nonce when losing the stale-reclaim race', async () => {
    const { db, collection } = makeDb();
    collection.findOne.mock.mockImplementationOnce(() =>
      Promise.resolve({ _id: LOCK_ID, owner: 'other-writer', nonce: 'their-nonce', pid: 7 }),
    );
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire(), (error) => {
      assert.ok(!JSON.stringify(error.context).includes('their-nonce'));
      assert.strictEqual(error.context.holder.pid, 7);
      assert.strictEqual(error.context.holder.runId, 'other-writer');
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

  it('should store the supplied token as the owner', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await lock.acquire('run-1');
    assert.strictEqual(
      heldFromUpdate(collection.updateOne.mock.calls[0].arguments[1]).owner,
      'run-1',
    );
    assert.strictEqual(lock.owner, 'run-1');
  });

  it('should throw when the holder carries the same owner token under another nonce', async () => {
    const { db, collection } = makeDb();
    // The owner token is the run id, and a user's `generateId` decides whether
    // two runs can share one. The lock must not: the read-back matching on the
    // token alone would let both run at once.
    collection.findOne.mock.mockImplementationOnce(() =>
      Promise.resolve({ _id: LOCK_ID, owner: 'run-1', nonce: 'the-other-holder', pid: 7 }),
    );
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire('run-1'), (error) => {
      assert.ok(error instanceof LockAlreadyHeldError);
      assert.ok(!JSON.stringify(error.context).includes('the-other-holder'));
      return true;
    });
    assert.strictEqual(lock.owner, undefined);
  });

  it('should throw when the holder is a document written without a nonce', async () => {
    const { db, collection } = makeDb();
    // What a pre-nonce release leaves in the collection — a peer, never us.
    collection.findOne.mock.mockImplementationOnce(() =>
      Promise.resolve({ _id: LOCK_ID, owner: 'run-1' }),
    );
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(lock.acquire('run-1'), LockAlreadyHeldError);
  });

  it('should mint a new nonce for every acquire, whatever the token', async () => {
    const first = makeDb();
    const second = makeDb();
    await new MigrationLock(first.db, '_migronaut_locks', 60).acquire('run-1');
    await new MigrationLock(second.db, '_migronaut_locks', 60).acquire('run-1');
    const nonces = [first, second].map(
      ({ collection }) => heldFromUpdate(collection.updateOne.mock.calls[0].arguments[1]).nonce,
    );
    assert.ok(nonces.every((nonce) => typeof nonce === 'string' && nonce.length > 0));
    assert.notStrictEqual(nonces[0], nonces[1]);
  });
});

describe('toLockInfo', () => {
  it('should strip the nonce and _id, and report the owner as the run id', () => {
    const lockedAt = new Date();
    assert.deepStrictEqual(
      toLockInfo({
        _id: LOCK_ID,
        owner: 'run-42',
        nonce: 'secret-nonce',
        lockedAt,
        pid: 42,
        host: 'box',
        executedBy: 'alex',
        ttlMs: 60_000,
      }),
      { lockedAt, pid: 42, host: 'box', executedBy: 'alex', runId: 'run-42', ttlMs: 60_000 },
    );
    // A hand-written or pre-2.1 document: only what it has.
    assert.deepStrictEqual(
      toLockInfo({ _id: LOCK_ID, lockedAt, pid: 1, host: 'h', executedBy: 'u' }),
      {
        lockedAt,
        pid: 1,
        host: 'h',
        executedBy: 'u',
      },
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

  it('should scope the renewal to the held owner token and nonce', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await lock.acquire('run-1');
    const held = heldFromUpdate(collection.updateOne.mock.calls[0].arguments[1]);
    await lock.renew();
    assert.deepStrictEqual(collection.updateOne.mock.calls[1].arguments[0], {
      _id: LOCK_ID,
      owner: 'run-1',
      nonce: held.nonce,
    });
  });
});

describe('MigrationLock.release', () => {
  it('should delete the lock document scoped to the held owner token', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await lock.acquire();
    await lock.release();
    const [filter] = collection.deleteOne.mock.calls[0].arguments;
    assert.strictEqual(filter._id, LOCK_ID);
    assert.strictEqual(filter.owner, lock.owner ?? filter.owner);
    assert.ok(typeof filter.owner === 'string' && filter.owner.length > 0);
  });

  it('should scope the delete to the nonce as well, so a same-token peer is never released', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await lock.acquire('run-1');
    const held = heldFromUpdate(collection.updateOne.mock.calls[0].arguments[1]);
    await lock.release();
    assert.deepStrictEqual(collection.deleteOne.mock.calls[0].arguments, [
      { _id: LOCK_ID, owner: 'run-1', nonce: held.nonce },
    ]);
  });

  it('should be a no-op when no owner token is held', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    // An unscoped delete here would be forceRelease() without its opt-in —
    // releasing twice (or before acquiring) must never steal a peer's lock.
    await lock.release();
    assert.strictEqual(collection.deleteOne.mock.callCount(), 0);
  });

  it('should throw LockReleaseFailedError when delete fails', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await lock.acquire();
    collection.deleteOne.mock.mockImplementationOnce(() => Promise.reject(new Error('boom')));
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

  it('should give the lock up early, once, and not again at the end', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    const events = [];
    const result = await runWithLock(
      lock,
      {
        logger: silentLogger,
        onLockAcquired: () => events.push(['acquired']),
        onLockReleased: (extra) => events.push(['released', extra]),
      },
      async (_signal, control) => {
        const released = await Promise.all([control.release(), control.release()]);
        assert.deepStrictEqual(released, [true, true]);
        assert.strictEqual(collection.deleteOne.mock.callCount(), 1, 'gone before fn returns');
        assert.strictEqual(await control.release(), true);
        return 'waited';
      },
    );
    assert.strictEqual(result, 'waited');
    assert.strictEqual(collection.deleteOne.mock.callCount(), 1);
    assert.deepStrictEqual(events, [['acquired'], ['released', { early: true }]]);
  });

  it('should stop renewing once released early, so a lost lock no longer aborts', async () => {
    const { db, collection } = makeDb();
    // 40ms TTL → a renewal every 20ms, a deadline at 30ms — none must fire.
    const lock = new MigrationLock(db, '_migronaut_locks', 0.04);
    const keepAlive = keepEventLoopAlive();
    try {
      await runWithLock(lock, { logger: silentLogger }, async (signal, control) => {
        await control.release();
        const renewals = collection.updateOne.mock.callCount();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(collection.updateOne.mock.callCount(), renewals, 'no renewal');
        assert.strictEqual(signal.aborted, false);
      });
    } finally {
      keepAlive();
    }
  });

  it('should warn when an early release fails, go on, and release at the end', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    let deletes = 0;
    collection.deleteOne.mock.mockImplementation(() => {
      deletes += 1;
      return deletes === 1 ? Promise.reject(new Error('network blip')) : Promise.resolve({});
    });
    const warn = mock.fn();
    const events = [];
    const result = await runWithLock(
      lock,
      {
        logger: { ...silentLogger, warn },
        onLockReleased: (extra) => events.push(extra),
      },
      async (_signal, control) => {
        assert.strictEqual(await control.release(), false);
        return 'ok';
      },
    );
    assert.strictEqual(result, 'ok');
    assert.strictEqual(deletes, 2);
    assert.match(warn.mock.calls[0].arguments[0], /Failed to release the migration lock early/);
    assert.deepStrictEqual(events, [undefined], 'released once — at the end');
  });

  it('should have nothing to release early when noLock is true', async () => {
    const { db } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await runWithLock(lock, { noLock: true, logger: silentLogger }, async (_signal, control) => {
      assert.strictEqual(await control.release(), false);
    });
  });

  it('should still throw what the function threw after an early release', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60);
    await assert.rejects(
      runWithLock(lock, { logger: silentLogger }, async (_signal, control) => {
        await control.release();
        throw new Error('wait failed');
      }),
      /wait failed/,
    );
    assert.strictEqual(collection.deleteOne.mock.callCount(), 1);
  });

  it('should abort via the TTL deadline when renewals keep failing', async () => {
    const { db, collection } = makeDb();
    // 200ms TTL → renew every 100ms, hard deadline at 150ms. Every renewal
    // fails; the deadline is the sole escalation and must fire strictly
    // before the lock becomes stale-reclaimable at 1×TTL.
    const lock = new MigrationLock(db, '_migronaut_locks', 0.2);
    let held;
    collection.updateOne.mock.mockImplementation((_filter, update) => {
      // acquire() carries the owner token; renew() only re-stamps lockedAt.
      const taken = heldFromUpdate(update);
      if (taken) {
        held = taken;
        return Promise.resolve({ matchedCount: 1 });
      }
      return Promise.reject(new Error('network blip'));
    });
    collection.findOne.mock.mockImplementation(() => Promise.resolve({ _id: LOCK_ID, ...held }));
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
    let held;
    let renewCalls = 0;
    let stuck = true;
    const pending = [];
    collection.updateOne.mock.mockImplementation((_filter, update) => {
      const taken = heldFromUpdate(update);
      if (taken) {
        held = taken;
        return Promise.resolve({ matchedCount: 1 });
      }
      renewCalls += 1;
      if (!stuck) return Promise.resolve({ matchedCount: 1 });
      // A renewal slower than the whole interval — the exact condition the
      // heartbeat exists to survive.
      return new Promise((resolve) => pending.push(() => resolve({ matchedCount: 1 })));
    });
    collection.findOne.mock.mockImplementation(() => Promise.resolve({ _id: LOCK_ID, ...held }));
    let callsWhileStuck;
    await runWithLock(
      lock,
      { logger: silentLogger },
      () =>
        new Promise((resolve) => {
          // Long enough for at least three ticks (~100/200/300ms, later on a
          // coarse timer like Windows') while the first renewal stays stuck.
          // Then every renewal is let go — one started by a late tick too, or
          // the release would wait on it forever.
          setTimeout(() => {
            callsWhileStuck = renewCalls;
            stuck = false;
            for (const release of pending.splice(0)) release();
            setTimeout(resolve, 5);
          }, 350);
        }),
    );
    assert.strictEqual(callsWhileStuck, 1);
  });
});

describe('MigrationLock — id and label', () => {
  it("should keep the migration lock's id and messages by default", async () => {
    const lock = new MigrationLock(makeDb().db, '_migronaut_locks', 60);
    assert.strictEqual(lock.id, LOCK_ID);
    assert.strictEqual(lock.label, 'migration lock');
    const { db, collection } = makeDb();
    // eslint-disable-next-line prefer-promise-reject-errors -- simulates MongoDB's plain-object duplicate-key error
    collection.updateOne.mock.mockImplementationOnce(() => Promise.reject({ code: 11000 }));
    await assert.rejects(
      new MigrationLock(db, '_migronaut_locks', 60).acquire(),
      (error) => error.message === 'Migration lock is already held',
    );
  });

  it('should use its own document id and name itself in messages', async () => {
    const { db, collection } = makeDb();
    const lock = new MigrationLock(db, '_migronaut_locks', 60, {
      id: 'background:0001-orders.js',
      label: 'background coordinator lock',
    });
    await lock.acquire();
    assert.strictEqual(
      collection.updateOne.mock.calls[0].arguments[0]._id,
      'background:0001-orders.js',
    );
    await lock.inspect();
    assert.deepStrictEqual(collection.findOne.mock.calls.at(-1).arguments[0], {
      _id: 'background:0001-orders.js',
    });
    collection.deleteOne.mock.mockImplementationOnce(() => Promise.reject(new Error('down')));
    await assert.rejects(lock.release(), /Failed to release background coordinator lock/);
    // eslint-disable-next-line prefer-promise-reject-errors -- simulates MongoDB's plain-object duplicate-key error
    collection.updateOne.mock.mockImplementationOnce(() => Promise.reject({ code: 11000 }));
    await assert.rejects(
      new MigrationLock(db, '_migronaut_locks', 60, { label: 'watch lock' }).acquire(),
      /Watch lock is already held/,
    );
  });
});

describe('runWithLock — any lock-shaped object', () => {
  it('should run, renew and release a duck-typed lock, naming it in its messages', async () => {
    const calls = [];
    let held = true;
    const lease = {
      label: 'partition lease',
      ttlMs: 40,
      acquire: async () => calls.push('acquire'),
      renew: async () => {
        calls.push('renew');
        return held;
      },
      release: async () => calls.push('release'),
    };
    const warnings = [];
    const logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    // Once the 50ms timer fires, the unref'ed heartbeat is the only pending
    // handle — see tests/helpers/event-loop.js.
    const release = keepEventLoopAlive();
    let result;
    try {
      result = await runWithLock(lease, { logger }, async (signal) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        held = false;
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          signal.addEventListener('abort', resolve, { once: true });
        });
        return signal.reason;
      });
    } finally {
      release();
    }
    assert.strictEqual(result.code, 'LOCK_LOST');
    assert.strictEqual(result.message, 'Lost the partition lease mid-run');
    assert.ok(warnings.some((line) => line.includes('Lost the partition lease mid-run')));
    assert.deepStrictEqual([calls[0], calls.at(-1)], ['acquire', 'release']);
    assert.ok(calls.includes('renew'));
  });
});
