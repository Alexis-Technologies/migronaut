const { setTimeout: delay } = require('node:timers/promises');
const { LockAlreadyHeldError } = require('../errors/index.js');
const { MigratorKit } = require('./migrator.js');

/**
 * Longer than the default 60s lock TTL on purpose: with a shorter budget, a peer
 * migration that outlives it makes every waiting instance fail to boot, even
 * though the peer is healthy and still holding a valid lock.
 */
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 90_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 500;
/** ±25% jitter so N instances booting together stop polling in lockstep */
const POLL_JITTER_RATIO = 0.25;

function jitteredDelay(baseMs) {
  const spread = baseMs * POLL_JITTER_RATIO;
  return Math.max(1, Math.round(baseMs - spread + Math.random() * spread * 2));
}

/**
 * Run all pending migrations and return a summary — the blessed one-call entry
 * point for application startup, deploy hooks, serverless cold starts, and test
 * setup.
 *
 * Unlike driving MigratorKit by hand, this opens its own connection,
 * runs pending `up` migrations, and **always disconnects in a `finally`** so a
 * failure never leaks a MongoDB connection. Migration errors propagate
 * unchanged (as MigronautError subclasses with a typed `code`) so a broken
 * migration aborts your boot sequence instead of starting the app against a
 * half-migrated database.
 *
 * For multi-instance deploys, set `onLockHeld: 'wait'` so instances that lose
 * the race to acquire the lock block until the migrating peer finishes, then
 * confirm there is nothing left to apply.
 *
 * @example
 * ```js
 * const { runMigrations } = require('@alexify/migronaut');
 *
 * const { applied, upToDate } = await runMigrations(
 *   { uri: process.env.MONGO_URI, dbName: 'my_app' },
 *   { onLockHeld: 'wait' },
 * );
 * if (!upToDate) console.log(`Applied ${applied.length} migration(s)`);
 * ```
 */
async function runMigrations(config = {}, options = {}) {
  const {
    noLock,
    onLockHeld = 'throw',
    lockWaitTimeoutMs = DEFAULT_LOCK_WAIT_TIMEOUT_MS,
    lockPollIntervalMs = DEFAULT_LOCK_POLL_INTERVAL_MS,
    ...kitOptions
  } = options;

  const kit = new MigratorKit(config, kitOptions);
  let waited = false;

  try {
    await kit.connect();
    // Resolved AFTER connect, from the kit's own merged config: a `logger:
    // null` in the config file must silence this module's lines too, not only
    // the kit's own.
    const logger = kit.logger;
    // The clock starts at the first contention, not before the first attempt —
    // otherwise a slow initial attempt eats the whole waiting budget.
    let deadline;

    for (;;) {
      try {
        const applied = await kit.up(undefined, noLock ? { noLock: true } : {});
        return { applied, upToDate: applied.length === 0, waited };
      } catch (error) {
        if (onLockHeld !== 'wait' || !(error instanceof LockAlreadyHeldError)) {
          throw error;
        }
        deadline ??= Date.now() + lockWaitTimeoutMs;
        const nextDelay = jitteredDelay(lockPollIntervalMs);
        if (Date.now() + nextDelay > deadline) {
          throw error;
        }
        if (!waited) {
          logger.info('Migration lock held by another process — waiting for it to release…');
        }
        waited = true;
        await delay(nextDelay);
      }
    }
  } finally {
    await kit.disconnect().catch(() => undefined);
  }
}

/**
 * Return the migrations that have not yet been applied — a connection-managed
 * readiness probe. Opens its own connection and always disconnects in a
 * `finally`. Use it to fail a deploy/health check when the database is behind
 * (`(await pendingMigrations(config)).length === 0`) without running anything.
 *
 * @example
 * ```js
 * const { pendingMigrations } = require('@alexify/migronaut');
 *
 * const pending = await pendingMigrations({ uri, dbName: 'my_app' });
 * if (pending.length > 0) {
 *   throw new Error(`Database is behind by ${pending.length} migration(s)`);
 * }
 * ```
 */
async function pendingMigrations(config = {}, options = {}) {
  const kit = new MigratorKit(config, options);
  try {
    await kit.connect();
    return await kit.list('pending');
  } finally {
    await kit.disconnect().catch(() => undefined);
  }
}

module.exports = { runMigrations, pendingMigrations };
