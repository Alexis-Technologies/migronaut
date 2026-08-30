const {
  MigrationExecutionFailedError,
  MigrationTimeoutError,
  TransactionsUnsupportedError,
} = require('../errors/index.js');
const { errorText } = require('../utils/error.js');

/**
 * True when the driver refused to start a transaction because the deployment
 * cannot run one (standalone server; code 20 = IllegalOperation). Matched on
 * the message too, since older servers phrase it without the code.
 */
function isTransactionsUnsupported(error) {
  if (typeof error !== 'object' || error === null) return false;
  return (
    error.code === 20 ||
    (typeof error.message === 'string' &&
      error.message.includes('Transaction numbers are only allowed'))
  );
}

/**
 * Race a migration against its timeout.
 *
 * Best-effort by design: JavaScript cannot cancel a running function, so the
 * migration keeps executing in the background after this rejects. What the
 * timeout buys is the *run* stopping instead of hanging forever — which also
 * lets the lock's TTL expire, so a wedged migration no longer blocks every
 * other instance indefinitely. Migrations that need real cancellation should
 * watch `ctx.signal`, which `onTimeout` aborts when the timer fires.
 */
async function withTimeout(promise, timeoutMs, name, direction, onTimeout) {
  if (!timeoutMs) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          // The body keeps running after this rejects (see docblock), and its
          // eventual rejection — e.g. MongoExpiredSessionError once the caller
          // ends the session — would otherwise surface as an
          // unhandledRejection long after the run already reported the
          // timeout. Swallow it: the timeout is the reported failure.
          Promise.resolve(promise).catch(() => {});
          const timeoutError = new MigrationTimeoutError(
            `Migration ${direction} timed out after ${timeoutMs}ms: ${name}`,
            {
              name,
              direction,
              timeoutMs,
            },
          );
          // Told, not just abandoned: the caller aborts the context's signal
          // with this error, so a body that watches ctx.signal can stop
          // writing instead of racing whoever acquires the lock next.
          onTimeout?.(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
 * throwing hook cannot mask the original failure. The one exception: when the
 * body succeeded and only the (non-transactional) changelog write failed, the
 * error carries `context.phase = 'changelog-write'` and `onError` is not fired —
 * the migration itself did not fail.
 */
async function runMigration(params) {
  const { name, migration, direction, context, useTransaction, hooks, onSuccess, logger } = params;
  const fn = direction === 'up' ? migration.up : migration.down;
  // A per-file `export const timeoutMs` overrides the global setting.
  const timeoutMs = migration.timeoutMs ?? params.timeoutMs;

  const start = Date.now();
  let session;
  // JavaScript cannot cancel a running body, but it can tell it to stop: this
  // controller feeds the context's signal, so the documented "watch ctx.signal"
  // advice covers the migration's own timeout too — not only lock loss and
  // stop(). Without it a timed-out body keeps writing after the lock is
  // released, racing whoever acquires it next.
  const timedOut = new AbortController();
  const signal = context.signal
    ? AbortSignal.any([context.signal, timedOut.signal])
    : timedOut.signal;
  let runtimeContext = { ...context, signal };
  const onTimeout = (timeoutError) => timedOut.abort(timeoutError);
  let duration = 0;
  // 'body' while the migration's own code runs; 'changelog' once it committed
  // and only the record write remains. The two failures need different
  // reporting: a changelog failure after a committed body must not read as
  // "the migration failed" — that invites a re-run of already-applied writes.
  let phase = 'body';

  try {
    if (useTransaction) {
      session = context.client.startSession();
      runtimeContext = { ...runtimeContext, session };
      // withTransaction may run the body more than once when the driver retries
      // a transient failure, so duration is re-measured on each attempt. The
      // changelog write stays inside the transaction, so a failure there
      // aborts the body's writes too — 'body' phase is accurate throughout.
      await session.withTransaction(async () => {
        const attemptStart = Date.now();
        await withTimeout(fn(runtimeContext), timeoutMs, name, direction, onTimeout);
        duration = Date.now() - attemptStart;
        await onSuccess?.(duration, session);
      });
    } else {
      await withTimeout(fn(runtimeContext), timeoutMs, name, direction, onTimeout);
      duration = Date.now() - start;
      phase = 'changelog';
      await onSuccess?.(duration, undefined);
    }

    return { duration };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // Failures deserve timing data as much as successes — a slow-then-failing
    // migration is exactly what an operator alerts on.
    const elapsed = Date.now() - start;

    // Without a transaction the body's writes are already committed when the
    // changelog write fails — say exactly that, instead of the generic
    // "migration failed" that would invite re-running committed writes. The
    // onError hook is for migration failures, so it does not fire here.
    if (phase === 'changelog') {
      throw new MigrationExecutionFailedError(
        `Migration ${direction} succeeded but recording it in the changelog failed: ${name} — ` +
          'its own writes are committed; verify the changelog before re-running',
        {
          name,
          direction,
          phase: 'changelog-write',
          bodySucceeded: true,
          durationMs: elapsed,
          cause: err.message,
        },
        { cause: err },
      );
    }

    if (hooks?.onError) {
      // A throwing onError hook must not replace the real cause.
      try {
        await hooks.onError(name, err, runtimeContext);
      } catch (hookError) {
        const message = errorText(hookError);
        logger?.warn(`⚠ onError hook failed for ${name}: ${message}`);
      }
    }

    if (err instanceof MigrationTimeoutError) {
      err.context = { durationMs: elapsed, ...err.context };
      throw err;
    }
    // A standalone deployment refusing the transaction is a topology problem,
    // not a bug in the migration — say so instead of blaming the file.
    if (useTransaction && isTransactionsUnsupported(err)) {
      throw new TransactionsUnsupportedError(
        `Cannot run ${name} in a transaction — this deployment is standalone. ` +
          'Set useTransaction: false, or run against a replica set / mongos.',
        { name, direction, durationMs: elapsed, cause: err.message },
        { cause: err },
      );
    }
    throw new MigrationExecutionFailedError(
      `Migration ${direction} failed: ${name}`,
      // The message is duplicated into context because that is what survives
      // JSON serialization; `cause` keeps the real Error (and its stack).
      { name, direction, durationMs: elapsed, cause: err.message },
      { cause: err },
    );
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}

module.exports = { runMigration };
