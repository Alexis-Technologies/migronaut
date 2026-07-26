const { MigrationExecutionFailedError } = require('../errors/index.js');

/**
 * Execute a single migration's `up` or `down` safely.
 *
 * When `useTransaction` is true the call runs inside `session.withTransaction()`,
 * which commits on success, aborts on failure, and — unlike a hand-rolled
 * start/commit pair — retries `TransientTransactionError` and
 * `UnknownTransactionCommitResult` per the driver's documented commit protocol.
 *
 * `onSuccess(duration, session)` runs inside the same transaction, right after
 * the migration body. That is what makes the changelog write atomic with the
 * migration itself: a crash between the two can no longer leave a migration
 * applied but unrecorded (which would silently re-run it on the next `up`).
 *
 * On any error the `onError` hook is invoked before a
 * MigrationExecutionFailedError is thrown — the error is never swallowed, and a
 * throwing hook cannot mask the original failure.
 */
async function runMigration(params) {
  const { name, migration, direction, context, useTransaction, hooks, onSuccess, logger } = params;
  const fn = direction === 'up' ? migration.up : migration.down;

  const start = Date.now();
  let session;
  let runtimeContext = context;
  let duration = 0;

  try {
    if (useTransaction) {
      session = context.client.startSession();
      runtimeContext = { ...context, session };
      // withTransaction may run the body more than once when the driver retries
      // a transient failure, so duration is re-measured on each attempt.
      await session.withTransaction(async () => {
        const attemptStart = Date.now();
        await fn(runtimeContext);
        duration = Date.now() - attemptStart;
        await onSuccess?.(duration, session);
      });
    } else {
      await fn(runtimeContext);
      duration = Date.now() - start;
      await onSuccess?.(duration, undefined);
    }

    return { duration };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    if (hooks?.onError) {
      // A throwing onError hook must not replace the real cause.
      try {
        await hooks.onError(name, err, runtimeContext);
      } catch (hookError) {
        const message = hookError instanceof Error ? hookError.message : String(hookError);
        logger?.warn(`⚠ onError hook failed for ${name}: ${message}`);
      }
    }

    throw new MigrationExecutionFailedError(
      `Migration ${direction} failed: ${name}`,
      // The message is duplicated into context because that is what survives
      // JSON serialization; `cause` keeps the real Error (and its stack).
      { name, direction, cause: err.message },
      { cause: err },
    );
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}

module.exports = { runMigration };
