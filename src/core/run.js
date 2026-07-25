const { setTimeout: delay } = require('node:timers/promises');
const { LockAlreadyHeldError } = require('../errors/index.js');
const { resolveLogger } = require('../utils/logger.js');
const { MigratorKit } = require('./migrator.js');

const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 500;

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
  const logger = resolveLogger(config.logger);
  let waited = false;

  try {
    await kit.connect();
    const deadline = Date.now() + lockWaitTimeoutMs;

    for (;;) {
      try {
        const applied = await kit.up(undefined, noLock ? { noLock: true } : {});
        return { applied, upToDate: applied.length === 0, waited };
      } catch (error) {
        const canWait =
          onLockHeld === 'wait' &&
          error instanceof LockAlreadyHeldError &&
          Date.now() + lockPollIntervalMs <= deadline;
        if (!canWait) {
          throw error;
        }
        if (!waited) {
          logger.info('Migration lock held by another process — waiting for it to release…');
        }
        waited = true;
        await delay(lockPollIntervalMs);
      }
    }
  } finally {
    await kit.disconnect();
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
    await kit.disconnect();
  }
}

module.exports = { runMigrations, pendingMigrations };
