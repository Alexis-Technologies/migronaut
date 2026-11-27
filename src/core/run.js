const { ConfigInvalidError, RunAbortedError } = require('../errors/index.js');
const { formatError } = require('../utils/error.js');
const { assertLockWaitOptions, withLockWait } = require('./lock-wait.js');
const { MigratorKit, RECORD_LOCK_WAIT } = require('./migrator.js');
const { assertRunFlags } = require('./options.js');

const runMigrations = async (config = {}, options = {}) => {
  const {
    noLock,
    onBackgroundPending,
    onLockHeld = 'throw',
    // Left undefined unless given: the default then follows the holder's TTL.
    lockWaitTimeoutMs,
    lockPollIntervalMs,
    onKit,
    signal,
    ...kitOptions
  } = options;

  assertRunFlags(options);
  if (onKit !== undefined && typeof onKit !== 'function') {
    throw new ConfigInvalidError('onKit must be a function', { context: { onKit: typeof onKit } });
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new ConfigInvalidError('signal must be an AbortSignal', {
      context: { signal: typeof signal },
    });
  }

  // Validated before anything connects — see assertLockWaitOptions.
  assertLockWaitOptions({ onLockHeld, lockWaitTimeoutMs, lockPollIntervalMs });

  const kit = new MigratorKit(config, kitOptions);
  // Handed out before connect so listeners catch every lifecycle event —
  // this is the metrics/alerting injection point for apps that embed
  // runMigrations and cannot reach the internally-constructed kit otherwise.
  onKit?.(kit);
  // `up` keeps returning the migration rows; with `convergeAfterUp` the
  // converge outcome rides along in the summary, from the kit's own event.
  let converge = null;
  const onConverge = (event) => {
    if (event.trigger === 'up' && event.success) converge = event.result;
  };
  kit.on('converge:end', onConverge);
  // With onBackgroundPending: 'stop', where the run stopped and what for.
  const waiting = [];
  const onWaiting = (event) => {
    waiting.push({ migration: event.migration, waitsFor: event.waitsFor });
  };
  kit.on('background:waiting', onWaiting);

  // An abort reaches the run wherever it is: the wait loop sees the signal
  // between polls, and `up` stops between migrations (one already executing
  // finishes — as stop() always has), its cause the signal's reason.
  try {
    if (signal?.aborted) {
      throw new RunAbortedError('Aborted before the run started', {
        context: { reason: formatError(signal.reason ?? 'aborted'), results: [] },
      });
    }
    await kit.connect();
    const {
      result: applied,
      waited,
      waitedMs,
      attempts,
    } = await withLockWait(
      () => {
        return kit.up(undefined, {
          ...(noLock ? { noLock: true } : {}),
          ...(onBackgroundPending !== undefined ? { onBackgroundPending } : {}),
          ...(signal ? { signal } : {}),
        });
      },
      {
        onLockHeld,
        ...(lockWaitTimeoutMs !== undefined ? { lockWaitTimeoutMs } : {}),
        ...(lockPollIntervalMs !== undefined ? { lockPollIntervalMs } : {}),
        // Resolved AFTER connect, from the kit's own merged config: a `logger:
        // null` in the config file must silence the wait lines too, not only
        // the kit's own.
        logger: kit.logger,
        ...(signal ? { signal } : {}),
        onSettle: (wait) => kit[RECORD_LOCK_WAIT](wait),
      },
    );
    return {
      applied,
      upToDate: applied.length === 0 && waiting.length === 0,
      ...(waiting.length > 0 ? { waiting } : {}),
      waited,
      waitedMs,
      attempts,
      ...(converge ? { converge } : {}),
    };
  } finally {
    // onKit may have handed the kit out: it leaves without this call's listeners.
    kit.off('converge:end', onConverge);
    kit.off('background:waiting', onWaiting);
    await kit.disconnect().catch((error) => {
      // What the call returns or throws is the answer; a failed close is said at debug.
      kit.logger.debug(`Could not disconnect: ${formatError(error)}`);
    });
  }
};

const pendingMigrations = async (config = {}, options = {}) => {
  const kit = new MigratorKit(config, options);
  try {
    await kit.connect();
    return await kit.list('pending');
  } finally {
    await kit.disconnect().catch((error) => {
      // What the call returns or throws is the answer; a failed close is said at debug.
      kit.logger.debug(`Could not disconnect: ${formatError(error)}`);
    });
  }
};

module.exports = { runMigrations, pendingMigrations };
