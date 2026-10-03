const { ConfigInvalidError } = require('../errors/index.js');
const {
  DEFAULT_LOCK_POLL_INTERVAL_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  assertLockWaitOptions,
  withLockWait,
} = require('./lock-wait.js');
const { MigratorKit } = require('./migrator.js');

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
 * Running several kits against several databases in ONE process: pass
 * `envFile: false` and supply `uri`/`dbName` directly. `.env` loading mutates
 * the shared process.env (dotenv semantics, override: false), so two kits
 * with different env files would otherwise leak `MIGRONAUT_*` values into each
 * other's config resolution.
 *
 * @example
 * ```js
 * const { runMigrations } = require('@alexify/migronaut');
 *
 * const { applied, upToDate } = await runMigrations(
 *   { uri: process.env.MIGRONAUT_URI, dbName: 'my_app' },
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
    onKit,
    ...kitOptions
  } = options;

  if (onKit !== undefined && typeof onKit !== 'function') {
    throw new ConfigInvalidError('onKit must be a function', { onKit: typeof onKit });
  }

  // Validated before anything connects — see assertLockWaitOptions.
  assertLockWaitOptions({ lockWaitTimeoutMs, lockPollIntervalMs });

  const kit = new MigratorKit(config, kitOptions);
  // Handed out before connect so listeners catch every lifecycle event —
  // this is the metrics/alerting injection point for apps that embed
  // runMigrations and cannot reach the internally-constructed kit otherwise.
  onKit?.(kit);
  // `up` keeps returning the migration rows; with `convergeAfterUp` the
  // converge outcome rides along in the summary, from the kit's own event.
  let converge;
  kit.on('converge:end', (event) => {
    if (event.trigger === 'up' && event.success) converge = event.result;
  });

  try {
    await kit.connect();
    const {
      result: applied,
      waited,
      waitedMs,
      attempts,
    } = await withLockWait(() => kit.up(undefined, noLock ? { noLock: true } : {}), {
      onLockHeld,
      lockWaitTimeoutMs,
      lockPollIntervalMs,
      // Resolved AFTER connect, from the kit's own merged config: a `logger:
      // null` in the config file must silence the wait lines too, not only
      // the kit's own.
      logger: kit.logger,
    });
    return {
      applied,
      upToDate: applied.length === 0,
      waited,
      waitedMs,
      attempts,
      ...(converge ? { converge } : {}),
    };
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
