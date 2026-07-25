const { MigrationExecutionFailedError } = require('../errors/index.js');

/**
 * Execute a single migration's `up` or `down` safely.
 *
 * When `useTransaction` is true the call is wrapped in a MongoDB session +
 * transaction, committed on success and aborted on failure. On any error the
 * `onError` hook is invoked before a MigrationExecutionFailedError is
 * thrown — the error is never swallowed.
 */
async function runMigration(params) {
  const { name, migration, direction, context, useTransaction, hooks } = params;
  const fn = direction === 'up' ? migration.up : migration.down;

  const start = Date.now();
  let session;
  let runtimeContext = context;

  try {
    if (useTransaction) {
      session = context.client.startSession();
      session.startTransaction();
      runtimeContext = { ...context, session };
    }

    await fn(runtimeContext);

    if (session) {
      await session.commitTransaction();
    }

    return { duration: Date.now() - start };
  } catch (error) {
    if (session) {
      // Abort the transaction; do not let an abort failure mask the original error.
      await session.abortTransaction().catch(() => undefined);
    }

    const err = error instanceof Error ? error : new Error(String(error));

    if (hooks?.onError) {
      await hooks.onError(name, err, runtimeContext);
    }

    throw new MigrationExecutionFailedError(`Migration ${direction} failed: ${name}`, {
      name,
      direction,
      cause: err.message,
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}

module.exports = { runMigration };
