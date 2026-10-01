const { setTimeout: delay } = require('node:timers/promises');
const {
  ConfigInvalidError,
  LockAlreadyHeldError,
  MigronautError,
  RunAbortedError,
} = require('../errors/index.js');
const { errorText } = require('../utils/error.js');

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
 * Validate the two wait budgets. A NaN here (or any non-positive value)
 * disables every deadline comparison in the loop — `NaN > deadline` is always
 * false — turning the wait into an unbounded retry storm against the lock
 * collection that never returns and never surfaces the real error.
 */
function assertLockWaitOptions({
  lockWaitTimeoutMs = DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  lockPollIntervalMs = DEFAULT_LOCK_POLL_INTERVAL_MS,
} = {}) {
  if (!Number.isFinite(lockWaitTimeoutMs) || lockWaitTimeoutMs <= 0) {
    throw new ConfigInvalidError('lockWaitTimeoutMs must be a positive finite number', {
      lockWaitTimeoutMs,
    });
  }
  if (!Number.isFinite(lockPollIntervalMs) || lockPollIntervalMs <= 0) {
    throw new ConfigInvalidError('lockPollIntervalMs must be a positive finite number', {
      lockPollIntervalMs,
    });
  }
}

/** The error an aborted wait rejects with — the signal's own typed reason when it has one */
function abortedError(signal, extra) {
  const reason = signal.reason;
  if (reason instanceof MigronautError) return reason;
  return new RunAbortedError('Lock wait aborted', {
    reason: errorText(reason ?? 'aborted'),
    ...extra,
  });
}

/**
 * Run `attempt()`; while it rejects with LockAlreadyHeldError and `onLockHeld`
 * is `'wait'`, poll again. Resolves `{ result, waited, waitedMs, attempts }`.
 *
 * The one wait-for-the-lock loop, shared by `runMigrations` (instances booting
 * together) and the queue processor (a job that finds a CLI run or a peer
 * worker holding the lock). `signal` aborts the wait *between* attempts — it
 * never interrupts an attempt in progress — and `onWait` fires before each
 * sleep, for callers that report progress.
 */
async function withLockWait(attempt, options = {}) {
  const {
    onLockHeld = 'throw',
    lockWaitTimeoutMs = DEFAULT_LOCK_WAIT_TIMEOUT_MS,
    lockPollIntervalMs = DEFAULT_LOCK_POLL_INTERVAL_MS,
    logger,
    signal,
    onWait,
  } = options;
  let waited = false;
  let waitedMs = 0;
  let attempts = 0;
  // The clock starts at the first contention, not before the first attempt —
  // otherwise a slow initial attempt eats the whole waiting budget.
  let deadline;
  // The holder's lockedAt from the last refusal: its heartbeat advances it
  // every TTL/2, so a change between polls is proof of a live, progressing
  // peer.
  let lastHolderLockedAt;

  for (;;) {
    if (signal?.aborted) throw abortedError(signal, { attempts, waitedMs });
    try {
      attempts += 1;
      const result = await attempt(attempts);
      return { result, waited, waitedMs, attempts };
    } catch (error) {
      if (onLockHeld !== 'wait' || !(error instanceof LockAlreadyHeldError)) {
        throw error;
      }
      // The timeout bounds *stall* time, not total wait: while the holder's
      // heartbeat visibly advances, it is healthy and working through its
      // backlog — timing out then would crash-loop every waiting instance
      // on exactly the deploys (a large first backlog) that take longest.
      // Only a holder that stops renewing runs the deadline down.
      const holderLockedAt = error.context?.holder?.lockedAt?.getTime?.();
      const holderAdvanced =
        holderLockedAt !== undefined &&
        lastHolderLockedAt !== undefined &&
        holderLockedAt > lastHolderLockedAt;
      if (deadline === undefined || holderAdvanced) {
        deadline = Date.now() + lockWaitTimeoutMs;
      }
      if (holderLockedAt !== undefined) lastHolderLockedAt = holderLockedAt;
      const nextDelay = jitteredDelay(lockPollIntervalMs);
      if (Date.now() + nextDelay > deadline) {
        throw error;
      }
      if (!waited) {
        logger?.info('Migration lock held by another process — waiting for it to release…');
      }
      waited = true;
      logger?.debug('Migration lock still held — retrying', {
        attempts,
        waitedMs,
        nextDelayMs: nextDelay,
      });
      onWait?.({ attempts, waitedMs, nextDelayMs: nextDelay, holder: error.context?.holder });
      waitedMs += nextDelay;
      try {
        await delay(nextDelay, undefined, signal ? { signal } : undefined);
      } catch (delayError) {
        if (signal?.aborted) throw abortedError(signal, { attempts, waitedMs });
        throw delayError;
      }
    }
  }
}

module.exports = {
  DEFAULT_LOCK_POLL_INTERVAL_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  assertLockWaitOptions,
  jitteredDelay,
  withLockWait,
};
