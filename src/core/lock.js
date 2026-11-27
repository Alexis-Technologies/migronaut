const os = require('node:os');

const {
  LockAlreadyHeldError,
  LockLostError,
  LockReleaseFailedError,
} = require('../errors/index.js');
const { errorText, isDuplicateKey } = require('../utils/error.js');
const { randomId } = require('../utils/id.js');
const { safeUsername } = require('../utils/user.js');
const { BOOKKEEPING_OPTIONS } = require('./server-info.js');

/** Fixed `_id` of the singleton migration lock document */
const LOCK_ID = 'migronaut_lock';

/** What the migration lock is called in messages — another lock passes its own `label` */
const LOCK_LABEL = 'migration lock';

/** `migration lock` → `Migration lock`, for the start of a sentence */
const sentence = (label) => label.charAt(0).toUpperCase() + label.slice(1);

/**
 * Map a raw lock document to the public LockInfo shape. The `nonce` — what
 * proves ownership — never leaves this module. The `owner` is the holder's run
 * id, the same value its events, log lines and changelog records carry, so it
 * is reported as `runId`: "which run holds the lock?" is the first question
 * when one is stuck. `ttlMs` is the holder's own TTL, which paces its
 * heartbeat (written since 2.1; absent from an older holder's document).
 */
const toLockInfo = (doc) => {
  if (!doc) return null;
  return {
    lockedAt: doc.lockedAt,
    pid: doc.pid,
    host: doc.host,
    executedBy: doc.executedBy,
    ...(typeof doc.owner === 'string' ? { runId: doc.owner } : {}),
    ...(typeof doc.ttlMs === 'number' ? { ttlMs: doc.ttlMs } : {}),
  };
};

/**
 * MongoDB-native distributed lock backed by a single document, using an atomic
 * upsert as a test-and-set. A lock older than `ttlSeconds` is considered stale
 * and may be reclaimed.
 *
 * `options.id` is the lock document's `_id` (default: the migration lock's)
 * and `options.label` what messages call it — so other locks (a background
 * migration's coordinator, `background:<name>`) live next to the migration
 * lock in the same collection without ever touching it: `unlock`, the audit
 * and `forceRelease` of the migration lock only see its own document.
 */
class MigrationLock {
  #db;
  #collectionName;
  #ttlSeconds;
  #id;
  #label;
  /** Token naming this instance as the current holder; set on acquire, cleared on release */
  #owner;
  /**
   * Minted here on every acquire and matched alongside `owner`. The owner token
   * is the run id, whose format — and therefore whose uniqueness — a user's
   * `generateId` decides; the nonce is what keeps two holders apart even when
   * that generator hands both the same id.
   */
  #nonce;

  constructor(db, collectionName, ttlSeconds, { id = LOCK_ID, label = LOCK_LABEL } = {}) {
    this.#db = db;
    this.#collectionName = collectionName;
    this.#ttlSeconds = ttlSeconds;
    this.#id = id;
    this.#label = label;
  }

  /** The lock collection, read and written on the primary (see BOOKKEEPING_OPTIONS) */
  #coll() {
    return this.#db.collection(this.#collectionName, BOOKKEEPING_OPTIONS);
  }

  /**
   * How long the server may spend on one operation of this lock: its TTL. An
   * operation that outlasts it is worthless — the lock it was about is stale —
   * and before the lock is held nothing else bounds a stalled one.
   */
  get #timeLimit() {
    return { maxTimeMS: this.ttlMs };
  }

  /** The lock document's `_id` */
  get id() {
    return this.#id;
  }

  /** What messages call this lock */
  get label() {
    return this.#label;
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
    const collection = this.#coll();
    // The caller may supply the run id so the lock document, the changelog
    // records and the log lines of one run all carry the same token.
    const owner = token ?? randomId();
    const nonce = randomId();
    // The replacement document for the taken branch. $literal guards the
    // strings: a pipeline expression would otherwise interpret a leading `$`
    // in a value as a field path.
    const lockDoc = {
      _id: this.#id,
      lockedAt: '$$NOW',
      pid: { $literal: process.pid },
      host: { $literal: os.hostname() },
      executedBy: { $literal: safeUsername() },
      owner: { $literal: owner },
      nonce: { $literal: nonce },
      ttlMs: { $literal: this.ttlMs },
    };

    let result = null;
    try {
      // Upsert on plain `_id` — upserts reject `$expr` filters (server error
      // 224), so the staleness decision lives in the pipeline instead, still
      // in server time: take the lock when no `lockedAt` exists (fresh insert)
      // or the holder is stale; otherwise keep the current document untouched.
      // The read-back below tells those outcomes apart.
      result = await collection.updateOne(
        { _id: this.#id },
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
        { upsert: true, ...this.#timeLimit },
      );
    } catch (error) {
      if (isDuplicateKey(error)) {
        // Two processes raced the very first insert; the loser lands here.
        // The holder is only said in the error: a read that fails must not
        // turn "the lock is held" into a driver error.
        const holder = await collection
          .findOne({ _id: this.#id }, this.#timeLimit)
          .catch(() => null);
        throw new LockAlreadyHeldError(`${sentence(this.#label)} is already held`, {
          context: { holder: toLockInfo(holder) ?? undefined, ttlMs: this.ttlMs },
        });
      }
      throw error;
    }

    // A fresh upsert-insert on the unique `_id` already proves ownership — no
    // other outcome can insert — and it is the common uncontended path, since
    // release() deletes the document after every clean run. Skipping the
    // read-back halves that path's round trips.
    if (result.upsertedCount === 1) {
      this.#owner = owner;
      this.#nonce = nonce;
      return;
    }

    // Confirm we are the holder. A fresh lock left the document untouched, and
    // if two processes raced to reclaim the same stale lock only the last
    // writer's document wins; either way the loser reads a different one here
    // and backs off instead of running concurrently. The nonce is what makes
    // that hold when both carry the same owner token.
    let current = null;
    try {
      current = await collection.findOne({ _id: this.#id }, this.#timeLimit);
    } catch (error) {
      // The update above may have been ours. Left as it is, the document
      // would hold the lock for no one — this instance never learned it owns
      // it, so nothing would renew or release it — until its TTL ran out.
      await collection
        .deleteOne({ _id: this.#id, owner, nonce }, this.#timeLimit)
        .catch(() => undefined);
      throw error;
    }
    if (!current || current.owner !== owner || current.nonce !== nonce) {
      throw new LockAlreadyHeldError(`${sentence(this.#label)} is already held`, {
        context: { holder: toLockInfo(current) ?? undefined, ttlMs: this.ttlMs },
      });
    }
    this.#owner = owner;
    this.#nonce = nonce;
  }

  /**
   * Refresh `lockedAt` so a long-running migration's lock never goes stale and
   * gets reclaimed mid-run. Scoped to our `owner` token and nonce, so it is a
   * no-op if the lock was already lost. Server time, for the same reason as
   * acquire(). Returns true while we still hold the lock.
   */
  async renew() {
    if (!this.#owner) {
      return false;
    }
    const result = await this.#coll().updateOne(
      { _id: this.#id, owner: this.#owner, nonce: this.#nonce },
      [{ $set: { lockedAt: '$$NOW' } }],
      this.#timeLimit,
    );
    return result.matchedCount === 1;
  }

  /** Read the current lock document, or null when no lock is held */
  async inspect() {
    return this.#coll().findOne({ _id: this.#id }, this.#timeLimit);
  }

  /**
   * The lock document with `ageMs`: how long ago it was last renewed, by the
   * server's clock — the one `lockedAt` was stamped with. For a reader that
   * judges staleness: its own clock against another host's stamp is the very
   * comparison acquire() avoids.
   */
  async inspectWithAge() {
    const docs = await this.#coll()
      .aggregate(
        [{ $match: { _id: this.#id } }, { $set: { ageMs: { $subtract: ['$$NOW', '$lockedAt'] } } }],
        this.#timeLimit,
      )
      .toArray();
    return docs[0] ?? null;
  }

  /**
   * Force-delete the lock regardless of who holds it, returning the document
   * that was removed (or null if none). Used by `migronaut unlock` to clear a lock
   * left behind by a crashed run — bypasses the owner scoping of {@link release}.
   */
  async forceRelease() {
    // One operation: read first and delete after, and the document reported
    // could be one run's while the one deleted is another's that took the
    // lock in between. With its metadata, so every supported driver answers
    // in the same shape (5.x has no other).
    const result = await this.#coll().findOneAndDelete(
      { _id: this.#id },
      { includeResultMetadata: true, ...this.#timeLimit },
    );
    return result?.value ?? null;
  }

  /**
   * Release the lock by deleting the lock document. Scoped to our `owner` token
   * and nonce so we never delete a lock that has since been reclaimed by another
   * process — not even one that was handed the same owner token.
   * With no token held this is a no-op — an unscoped delete here would be
   * `forceRelease()` without its deliberate opt-in, and a future caller
   * releasing twice (or before acquiring) must not silently steal a peer's
   * live lock.
   * @throws {LockReleaseFailedError} when the delete operation fails
   */
  async release() {
    if (!this.#owner) return;
    const filter = { _id: this.#id, owner: this.#owner, nonce: this.#nonce };
    try {
      await this.#coll().deleteOne(filter, this.#timeLimit);
      this.#owner = undefined;
      this.#nonce = undefined;
    } catch (error) {
      throw new LockReleaseFailedError(`Failed to release ${this.#label}`, {
        cause: error,
        context: { cause: errorText(error) },
      });
    }
  }
}

/**
 * Run `fn(signal, control)` while holding the migration lock. The lock is
 * always released in a `finally` block. While `fn` runs, a heartbeat renews the
 * lock every `ttlMs/2` so a migration that takes longer than the TTL never lets
 * its lock go stale and get reclaimed by another process.
 *
 * `control.release()` gives the lock up before `fn` returns — once, for a
 * tail of work that only reads (converge waiting for search index builds):
 * the heartbeat stops, the lock document goes, `onLockReleased({ early: true })`
 * fires, and the signal no longer aborts on a lost lock. It resolves to
 * whether the lock was released: one that fails is only warned about (the
 * lock frees itself once its TTL runs out) and tried again at the end. With
 * `noLock` there is nothing to release (`false`).
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
const runWithLock = async (lock, options, fn) => {
  const controller = new AbortController();
  // Any object with acquire/renew/release/ttlMs is a lock here — a partition
  // lease included; `label` names it in the messages.
  const label = typeof lock?.label === 'string' ? lock.label : LOCK_LABEL;

  if (options.noLock) {
    options.logger.warn('⚠ Running without a lock (--no-lock) — concurrent runs are unsafe', {
      noLock: true,
    });
    // Events stay balanced for subscribers even when acquisition is skipped;
    // `skipped: true` tells them apart from a real lock.
    options.onLockAcquired?.({ skipped: true });
    try {
      return await fn(controller.signal, { release: async () => false });
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
  // One lock is lost once, however many timers notice: the heartbeat finds it
  // reclaimed on every tick from then on, and the deadline may fire on top.
  // A run of an hour would say so — and emit `lock:lost` — a hundred times.
  let lost = false;
  // What the last failed renewal said: the cause of a lock lost to the deadline.
  let lastRenewError = null;
  const loseLock = (reason, cause) => {
    if (lost) return;
    lost = true;
    // The most alert-worthy line this module emits — at error level when the
    // run stops on it, a warning under `onLockLost: 'warn'` (what that option
    // asks for) — with structured fields so a JSON sink can trigger on it
    // without parsing the human string.
    const fields = { event: 'lock:lost', reason };
    if (abortOnLoss) options.logger.error(`✖ Lost the ${label} mid-run (${reason})`, fields);
    else options.logger.warn(`⚠ Lost the ${label} mid-run (${reason})`, fields);
    options.onLockLostEvent?.(reason);
    if (abortOnLoss && !controller.signal.aborted) {
      const context =
        cause === null
          ? { reason, aborted: true }
          : { reason, aborted: true, cause: errorText(cause) };
      controller.abort(
        new LockLostError(`Lost the ${label} mid-run`, {
          ...(cause === null ? {} : { cause }),
          context,
        }),
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
  let deadline = null;
  const armDeadline = () => {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => {
        if (!stopped) loseLock('no successful renewal within the TTL', lastRenewError);
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
  let inFlight = null;
  let pending = false;
  const heartbeat = setInterval(() => {
    if (pending) return;
    pending = true;
    inFlight = lock
      .renew()
      .then((held) => {
        consecutiveFailures = 0;
        // A renewal that finds no matching document means someone else owns the
        // lock now — unrecoverable, so it aborts on the first occurrence. And
        // final: that document never matches again, so there is nothing left
        // to renew. (A deadline that fired on failing renewals is different —
        // the document may still be ours, and the heartbeat goes on trying.)
        lastRenewError = null;
        if (!held && !stopped) {
          loseLock('another run reclaimed it', null);
          clearInterval(heartbeat);
          return void clearTimeout(deadline);
        }
        return void armDeadline();
      })
      .catch((error) => {
        if (stopped) return;
        // A failing renewal may just be a blip and is only warned about here.
        // The TTL deadline (armDeadline above) is the sole escalation: it
        // fires strictly before the lock becomes stale-reclaimable, so
        // failures are tolerated exactly as long as they are harmless.
        consecutiveFailures += 1;
        lastRenewError = error;
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

  const stopHeartbeat = async () => {
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    // Let any renewal already in flight settle, so no stray query outlives this
    // call and lands after the caller has closed the client.
    await inFlight;
  };
  let released = false;
  let releasing = null;
  const control = {
    release: () => {
      return (releasing ??= (async () => {
        await stopHeartbeat();
        try {
          await lock.release();
          released = true;
          options.onLockReleased?.({ early: true });
        } catch (releaseError) {
          const message = errorText(releaseError);
          options.logger.warn(
            `⚠ Failed to release the ${label} early: ${message} — it frees itself once ` +
              'its TTL runs out',
            { event: 'lock:release-failed', error: message, early: true },
          );
        }
        return released;
      })());
    },
  };

  let result = undefined;
  let runError = null;
  let failed = false;
  try {
    result = await fn(controller.signal, control);
  } catch (error) {
    failed = true;
    runError = error;
  } finally {
    await releasing;
    await stopHeartbeat();
  }

  if (released) {
    if (failed) throw runError;
    return result;
  }
  try {
    await lock.release();
    options.onLockReleased?.();
  } catch (releaseError) {
    // Never let a release failure replace the reason the run failed: that would
    // report "Failed to release migration lock" instead of the actual migration
    // error. When the run succeeded, the release failure is the only news —
    // but the migrations DID apply, and that list must survive onto the error,
    // or "everything applied, only the lock cleanup failed" (the lock document
    // self-heals via its TTL) is indistinguishable from a failed run.
    if (!failed) {
      if (releaseError instanceof LockReleaseFailedError && Array.isArray(result)) {
        releaseError.context = { ...releaseError.context, results: [...result] };
      }
      throw releaseError;
    }
    const message = errorText(releaseError);
    options.logger.warn(`⚠ Failed to release the ${label}: ${message}`, {
      event: 'lock:release-failed',
      error: message,
    });
  }

  if (failed) throw runError;
  return result;
};

module.exports = { LOCK_ID, LOCK_LABEL, toLockInfo, MigrationLock, runWithLock };
