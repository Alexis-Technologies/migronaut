const { randomUUID } = require('node:crypto');
const os = require('node:os');
const { LockAlreadyHeldError, LockReleaseFailedError } = require('../errors/index.js');

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

  /** TTL in milliseconds — used to size the renewal heartbeat */
  get ttlMs() {
    return this.#ttlSeconds * 1000;
  }

  /**
   * Acquire the lock, reclaiming it if the existing one is stale.
   * @throws {LockAlreadyHeldError} when another process holds a fresh lock
   */
  async acquire() {
    const collection = this.#db.collection(this.#collectionName);
    const staleThreshold = new Date(Date.now() - this.#ttlSeconds * 1000);
    const owner = randomUUID();
    const lockFields = {
      lockedAt: new Date(),
      pid: process.pid,
      host: os.hostname(),
      executedBy: os.userInfo().username,
      owner,
    };

    try {
      // Matches when no fresh lock exists; upsert inserts (no doc) or updates (stale doc).
      // A fresh lock fails the filter, so the upsert collides on _id → duplicate-key error.
      await collection.updateOne(
        { _id: LOCK_ID, lockedAt: { $lt: staleThreshold } },
        { $set: lockFields },
        { upsert: true },
      );
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const holder = await collection.findOne({ _id: LOCK_ID });
        throw new LockAlreadyHeldError('Migration lock is already held', {
          holder: toLockInfo(holder) ?? undefined,
        });
      }
      throw error;
    }

    // Confirm we are the holder. If two processes raced to reclaim the same
    // stale lock, both updates succeed but only the last writer's `owner` wins;
    // the loser reads a different token here and backs off instead of running
    // concurrently.
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
   * lock was already lost. Returns true while we still hold the lock.
   */
  async renew() {
    if (!this.#owner) {
      return false;
    }
    const result = await this.#db
      .collection(this.#collectionName)
      .updateOne({ _id: LOCK_ID, owner: this.#owner }, { $set: { lockedAt: new Date() } });
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
      throw new LockReleaseFailedError('Failed to release migration lock', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Run `fn` while holding the migration lock. The lock is always released in a
 * `finally` block. While `fn` runs, a heartbeat renews the lock every `ttlMs/2`
 * so a migration that takes longer than the TTL never lets its lock go stale
 * and get reclaimed by another process — the original failure mode that made
 * the lock unsafe for long migrations. When `noLock` is true, acquisition is
 * skipped and a loud warning is emitted — intended for local development only.
 */
async function runWithLock(lock, options, fn) {
  if (options.noLock) {
    options.logger.warn('⚠ Running without a lock (--no-lock) — concurrent runs are unsafe');
    return fn();
  }

  await lock.acquire();

  // Renew at half the TTL so the lock is refreshed comfortably before it would
  // be considered stale. unref() keeps the heartbeat from holding the process
  // open on its own.
  const intervalMs = Math.max(1, Math.floor(lock.ttlMs / 2));
  const heartbeat = setInterval(() => {
    lock
      .renew()
      .then((held) => {
        if (!held) {
          options.logger.warn(
            '⚠ Lost the migration lock mid-run (renewal failed) — another run may have started',
          );
        }
      })
      .catch(() => undefined);
  }, intervalMs);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await lock.release();
  }
}

module.exports = { LOCK_ID, MigrationLock, runWithLock, toLockInfo };
