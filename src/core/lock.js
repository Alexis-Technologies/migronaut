const { randomUUID } = require('node:crypto');
const os = require('node:os');
const {
  LockAlreadyHeldError,
  LockLostError,
  LockReleaseFailedError,
} = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { safeUsername } = require('../utils/user.js');

/** Fixed `_id` of the singleton lock document */
const LOCK_ID = 'migronaut_lock';

/** Returns true when an error is a MongoDB duplicate-key error (code 11000) */
function isDuplicateKeyError(error) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

/**
 * Map a raw lock document to the public LockInfo shape. Strips internal fields —
 * most importantly the `owner` token, which proves lock ownership and must never
 * leak into error context or CLI output.
 */
function toLockInfo(doc) {
  if (!doc) return null;
  return { lockedAt: doc.lockedAt, pid: doc.pid, host: doc.host, executedBy: doc.executedBy };
}

/**
 * MongoDB-native distributed lock backed by a single document, using an atomic
 * upsert as a test-and-set. A lock older than `ttlSeconds` is considered stale
 * and may be reclaimed.
 */
class MigrationLock {
  #db;
  #collectionName;
  #ttlSeconds;
  /** Token proving this instance is the current holder; set on acquire, cleared on release */
  #owner;

  constructor(db, collectionName, ttlSeconds) {
    this.#db = db;
    this.#collectionName = collectionName;
    this.#ttlSeconds = ttlSeconds;
  }

  /** The token identifying this holder, or undefined when the lock is not held */
  get owner() {
    return this.#owner;
  }

  /** TTL in milliseconds — used to size the renewal heartbeat */
  get ttlMs() {
    return this.#ttlSeconds * 1000;
  }

  /**
   * Acquire the lock, reclaiming it if the existing one is stale.
   *
   * Staleness is judged and `lockedAt` stamped in **server time** (`$$NOW` via
   * an aggregation-pipeline update): comparing one host's clock against a
   * timestamp another host wrote means a pod running 90s fast steals every
   * healthy lock, and one running slow never reclaims a dead one.
   *
   * @throws {LockAlreadyHeldError} when another process holds a fresh lock
   */
  async acquire(token) {
    const collection = this.#db.collection(this.#collectionName);
    // The caller may supply the run id so the lock document, the changelog
    // records and the log lines of one run all carry the same token.
    const owner = token ?? randomUUID();
    // The replacement document for the taken branch. $literal guards the
    // strings: a pipeline expression would otherwise interpret a leading `$`
    // in a value as a field path.
    const lockDoc = {
      _id: LOCK_ID,
      lockedAt: '$$NOW',
      pid: { $literal: process.pid },
      host: { $literal: os.hostname() },
      executedBy: { $literal: safeUsername() },
      owner: { $literal: owner },
    };

    try {
      // Upsert on plain `_id` — upserts reject `$expr` filters (server error
      // 224), so the staleness decision lives in the pipeline instead, still
      // in server time: take the lock when no `lockedAt` exists (fresh insert)
      // or the holder is stale; otherwise keep the current document untouched.
      // The read-back below tells those outcomes apart.
      await collection.updateOne(
        { _id: LOCK_ID },
        [
          {
            $replaceWith: {
              $cond: [
                {
                  $lt: [
                    { $ifNull: ['$lockedAt', new Date(0)] },
                    { $subtract: ['$$NOW', this.ttlMs] },
                  ],
                },
                lockDoc,
                '$$ROOT',
              ],
            },
          },
        ],
        { upsert: true },
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        // Two processes raced the very first insert; the loser lands here.
        const holder = await collection.findOne({ _id: LOCK_ID });
        throw new LockAlreadyHeldError('Migration lock is already held', {
          holder: toLockInfo(holder) ?? undefined,
        });
      }
      throw error;
    }

    // Confirm we are the holder. A fresh lock left the document untouched, and
    // if two processes raced to reclaim the same stale lock only the last
    // writer's `owner` wins; either way the loser reads a different token here
    // and backs off instead of running concurrently.
    const current = await collection.findOne({ _id: LOCK_ID });
    if (!current || current.owner !== owner) {
      throw new LockAlreadyHeldError('Migration lock is already held', {
        holder: toLockInfo(current) ?? undefined,
      });
    }
    this.#owner = owner;
  }

  /**
   * Refresh `lockedAt` so a long-running migration's lock never goes stale and
   * gets reclaimed mid-run. Scoped to our `owner` token, so it is a no-op if the
   * lock was already lost. Server time, for the same reason as acquire().
   * Returns true while we still hold the lock.
   */
  async renew() {
    if (!this.#owner) {
      return false;
    }
    const result = await this.#db
      .collection(this.#collectionName)
      .updateOne({ _id: LOCK_ID, owner: this.#owner }, [{ $set: { lockedAt: '$$NOW' } }]);
    return result.matchedCount === 1;
  }

  /** Read the current lock document, or null when no lock is held */
  async inspect() {
    return this.#db.collection(this.#collectionName).findOne({ _id: LOCK_ID });
  }

  /**
   * Force-delete the lock regardless of who holds it, returning the document
   * that was removed (or null if none). Used by `migronaut unlock` to clear a lock
   * left behind by a crashed run — bypasses the owner scoping of {@link release}.
   */
  async forceRelease() {
    const collection = this.#db.collection(this.#collectionName);
    const existing = await collection.findOne({ _id: LOCK_ID });
    await collection.deleteOne({ _id: LOCK_ID });
    return existing;
  }

  /**
   * Release the lock by deleting the lock document. Scoped to our `owner` token
   * (when held) so we never delete a lock that has since been reclaimed by
   * another process.
   * @throws {LockReleaseFailedError} when the delete operation fails
   */
  async release() {
    const filter = this.#owner ? { _id: LOCK_ID, owner: this.#owner } : { _id: LOCK_ID };
    try {
      await this.#db.collection(this.#collectionName).deleteOne(filter);
      this.#owner = undefined;
    } catch (error) {
      throw new LockReleaseFailedError(
        'Failed to release migration lock',
        { error: errorText(error) },
        { cause: error },
      );
    }
  }
}

/**
 * Run `fn(signal)` while holding the migration lock. The lock is always
 * released in a `finally` block. While `fn` runs, a heartbeat renews the lock
 * every `ttlMs/2` so a migration that takes longer than the TTL never lets its
 * lock go stale and get reclaimed by another process.
 *
 * If the lock is nonetheless lost — another process reclaimed it, or the
 * heartbeat cannot reach the database — the `signal` is aborted with a
 * LockLostError. `fn` is expected to check it between migrations and stop:
 * continuing would mean two processes migrating the same database at once.
 * Set `onLockLost: 'warn'` to keep going with only a warning.
 *
 * When `noLock` is true, acquisition is skipped and a loud warning is emitted —
 * intended for local development only.
 */
async function runWithLock(lock, options, fn) {
  const controller = new AbortController();

  if (options.noLock) {
    options.logger.warn('⚠ Running without a lock (--no-lock) — concurrent runs are unsafe', {
      noLock: true,
    });
    // Events stay balanced for subscribers even when acquisition is skipped;
    // `skipped: true` tells them apart from a real lock.
    options.onLockAcquired?.({ skipped: true });
    try {
      return await fn(controller.signal);
    } finally {
      options.onLockReleased?.({ skipped: true });
    }
  }

  const acquireStart = Date.now();
  await lock.acquire(options.owner);
  // ttlMs and the acquisition latency give a subscriber enough to alert on
  // ("acquire took 4s — the lock collection is contended") without a log parse.
  options.onLockAcquired?.({ ttlMs: lock.ttlMs, acquireMs: Date.now() - acquireStart });

  const abortOnLoss = (options.onLockLost ?? 'abort') === 'abort';
  const loseLock = (reason) => {
    // The most alert-worthy line this module emits — structured fields so a
    // JSON sink can trigger on it without parsing the human string.
    options.logger.warn(`⚠ Lost the migration lock mid-run (${reason})`, {
      event: 'lock:lost',
      reason,
    });
    options.onLockLostEvent?.(reason);
    if (abortOnLoss && !controller.signal.aborted) {
      controller.abort(
        new LockLostError('Lost the migration lock mid-run', { reason, aborted: true }),
      );
    }
  };

  // Renew at half the TTL so the lock is refreshed comfortably before it would
  // be considered stale. unref() keeps the heartbeat from holding the process
  // open on its own.
  const intervalMs = Math.max(1, Math.floor(lock.ttlMs / 2));
  let consecutiveFailures = 0;
  let stopped = false;

  // The hard deadline is the single failure escalation: renewal errors are
  // tolerated (warned about below) exactly as long as the lock cannot be
  // reclaimed yet. The lock goes stale-reclaimable at 1×TTL — the deadline
  // aborts strictly before that window opens, and each successful renewal
  // re-arms it. (A consecutive-failure counter used to sit alongside this,
  // but firing at 1.5×TTL it could mathematically never beat the deadline.)
  const deadlineMarginMs = Math.min(Math.floor(intervalMs / 2), 5000);
  let deadline;
  const armDeadline = () => {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => {
        if (!stopped) loseLock('no successful renewal within the TTL');
      },
      Math.max(1, lock.ttlMs - deadlineMarginMs),
    );
    deadline.unref?.();
  };
  armDeadline();

  // Tracked so the caller never returns with a renewal still in flight: a
  // stray query landing after disconnect() fails against a closed client.
  // `pending` guards re-entrancy — when the DB is slow enough that a renewal
  // spans a whole interval (the exact condition the heartbeat exists to
  // survive), overlapping ticks would otherwise overwrite `inFlight` and let
  // an earlier, still-unsettled renewal escape the final await.
  let inFlight;
  let pending = false;
  const heartbeat = setInterval(() => {
    if (pending) return;
    pending = true;
    inFlight = lock
      .renew()
      .then((held) => {
        consecutiveFailures = 0;
        // A renewal that finds no matching document means someone else owns the
        // lock now — unrecoverable, so it aborts on the first occurrence.
        if (!held && !stopped) {
          loseLock('another run reclaimed it');
          return;
        }
        armDeadline();
      })
      .catch((error) => {
        if (stopped) return;
        // A failing renewal may just be a blip and is only warned about here.
        // The TTL deadline (armDeadline above) is the sole escalation: it
        // fires strictly before the lock becomes stale-reclaimable, so
        // failures are tolerated exactly as long as they are harmless.
        consecutiveFailures += 1;
        const message = errorText(error);
        options.logger.warn(`⚠ Lock renewal failed (${consecutiveFailures} in a row): ${message}`, {
          event: 'lock:renew-failed',
          consecutiveFailures,
          error: message,
        });
      })
      .finally(() => {
        pending = false;
      });
  }, intervalMs);
  heartbeat.unref?.();

  let result;
  let runError;
  let failed = false;
  try {
    result = await fn(controller.signal);
  } catch (error) {
    failed = true;
    runError = error;
  } finally {
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    // Let any renewal already in flight settle, so no stray query outlives this
    // call and lands after the caller has closed the client.
    await inFlight;
  }

  try {
    await lock.release();
    options.onLockReleased?.();
  } catch (releaseError) {
    // Never let a release failure replace the reason the run failed: that would
    // report "Failed to release migration lock" instead of the actual migration
    // error. When the run succeeded, the release failure is the only news.
    if (!failed) throw releaseError;
    const message = errorText(releaseError);
    options.logger.warn(`⚠ Failed to release the migration lock: ${message}`, {
      event: 'lock:release-failed',
      error: message,
    });
  }

  if (failed) throw runError;
  return result;
}

module.exports = { LOCK_ID, MigrationLock, runWithLock, toLockInfo };
