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
/**
 * The longest a waiter sleeps between two polls, however long it has waited.
 * Polls back off from `lockPollIntervalMs` up to this, so a hundred instances
 * waiting out a long deploy do not hammer the one lock document — while a
 * released lock is still noticed within a few seconds.
 */
const MAX_LOCK_POLL_INTERVAL_MS = 5000;
/** The longest delay a Node timer honours — anything above it fires after 1ms */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** ±25% jitter so N instances booting together stop polling in lockstep */
const POLL_JITTER_RATIO = 0.25;
/**
 * How much longer than the holder's TTL a waiter is patient by default: the
 * holder's heartbeat moves `lockedAt` every TTL/2, and a crashed holder's lock
 * is only reclaimable after a full TTL — a default below that would give up
 * on healthy holders, or before a dead one could be replaced.
 */
const TTL_PATIENCE_FACTOR = 1.5;

function jitteredDelay(baseMs) {
  const spread = baseMs * POLL_JITTER_RATIO;
  return Math.max(1, Math.round(baseMs - spread + Math.random() * spread * 2));
}

/** Polls that must fit in one wait budget: enough to see a live holder's heartbeat move */
const POLLS_PER_BUDGET = 4;

/**
 * The sleep before poll number `attempt` (1-based): doubling from `baseMs`,
 * jittered, and capped — at `MAX_LOCK_POLL_INTERVAL_MS`, and at a quarter of
 * the wait budget, so a long sleep can never outlast the budget and make a
 * live holder look stalled. Never below `baseMs`.
 */
function backoffDelay(baseMs, attempt, budgetMs = Number.POSITIVE_INFINITY) {
  const cap = Math.max(baseMs, Math.min(MAX_LOCK_POLL_INTERVAL_MS, budgetMs / POLLS_PER_BUDGET));
  const grown = Math.min(cap, baseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
  return Math.min(jitteredDelay(grown), MAX_TIMER_MS);
}

/**
 * Validate the wait options. A NaN here (or any non-positive value) disables
 * every deadline comparison in the loop — `NaN > deadline` is always false —
 * turning the wait into an unbounded retry storm against the lock collection
 * that never returns and never surfaces the real error. An interval above the
 * largest timer would fire after 1ms: the same storm. `lockWaitTimeoutMs` may
 * be left out — the default then follows the holder's TTL.
 */
function assertLockWaitOptions({
  onLockHeld,
  lockWaitTimeoutMs,
  lockPollIntervalMs = DEFAULT_LOCK_POLL_INTERVAL_MS,
} = {}) {
  if (onLockHeld !== undefined && onLockHeld !== 'wait' && onLockHeld !== 'throw') {
    throw new ConfigInvalidError("onLockHeld must be 'wait' or 'throw'", { onLockHeld });
  }
  if (
    lockWaitTimeoutMs !== undefined &&
    (!Number.isFinite(lockWaitTimeoutMs) || lockWaitTimeoutMs <= 0)
  ) {
    throw new ConfigInvalidError('lockWaitTimeoutMs must be a positive finite number', {
      lockWaitTimeoutMs,
    });
  }
  if (
    !Number.isFinite(lockPollIntervalMs) ||
    lockPollIntervalMs <= 0 ||
    lockPollIntervalMs > MAX_TIMER_MS
  ) {
    throw new ConfigInvalidError(
      `lockPollIntervalMs must be a positive number of milliseconds, at most ${MAX_TIMER_MS}`,
      { lockPollIntervalMs },
    );
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
 * The wait budget: the caller's, or — left out — the default, stretched to
 * outlast the holder's heartbeat and its stale-reclaim window. The holder's
 * TTL comes from its lock document (written since 2.1), else this process's.
 */
function waitBudget(lockWaitTimeoutMs, error) {
  if (lockWaitTimeoutMs !== undefined) return lockWaitTimeoutMs;
  const ttlMs = error.context?.holder?.ttlMs ?? error.context?.ttlMs;
  return Number.isFinite(ttlMs)
    ? Math.max(DEFAULT_LOCK_WAIT_TIMEOUT_MS, Math.round(ttlMs * TTL_PATIENCE_FACTOR))
    : DEFAULT_LOCK_WAIT_TIMEOUT_MS;
}

/**
 * Run `attempt()`; while it rejects with LockAlreadyHeldError and `onLockHeld`
 * is `'wait'`, poll again. Resolves `{ result, waited, waitedMs, attempts }`.
 *
 * The one wait-for-the-lock loop, shared by `runMigrations` (instances booting
 * together) and the queue processor (a job that finds a CLI run or a peer
 * worker holding the lock). `signal` aborts the wait *between* attempts — it
 * never interrupts an attempt in progress — and `onWait` fires before each
 * sleep, for callers that report progress. `isTransient(error)` widens what is
 * waited out beyond a held lock (the queue's "an earlier job is still in
 * flight"); `onSettle({ waitedMs, attempts, outcome })` fires once when a wait
 * that happened ends — `'acquired'`, `'timeout'` or `'aborted'`.
 */
async function withLockWait(attempt, options = {}) {
  const {
    onLockHeld = 'throw',
    lockWaitTimeoutMs,
    lockPollIntervalMs = DEFAULT_LOCK_POLL_INTERVAL_MS,
    logger,
    signal,
    onWait,
    onSettle,
    isTransient = (error) => error instanceof LockAlreadyHeldError,
  } = options;
  let waited = false;
  let attempts = 0;
  // The clock starts at the first contention, not before the first attempt —
  // otherwise a slow initial attempt eats the whole waiting budget.
  let firstRefusalAt;
  let deadline;
  // The holder's lockedAt from the last refusal: its heartbeat advances it
  // every TTL/2, so a change between polls is proof of a live, progressing
  // peer.
  let lastHolderLockedAt;
  let warnedShortBudget = false;
  const waitedMs = () => (firstRefusalAt === undefined ? 0 : Date.now() - firstRefusalAt);
  const settle = (outcome) => {
    if (!waited) return;
    try {
      onSettle?.({ waitedMs: waitedMs(), attempts, outcome });
    } catch {
      // A reporting callback must never change how the wait ends.
    }
  };

  for (;;) {
    if (signal?.aborted) {
      settle('aborted');
      throw abortedError(signal, { attempts, waitedMs: waitedMs() });
    }
    try {
      attempts += 1;
      const result = await attempt(attempts);
      const total = waitedMs();
      settle('acquired');
      return { result, waited, waitedMs: total, attempts };
    } catch (error) {
      if (onLockHeld !== 'wait' || !isTransient(error)) {
        throw error;
      }
      firstRefusalAt ??= Date.now();
      const budget = waitBudget(lockWaitTimeoutMs, error);
      const holderTtlMs = error.context?.holder?.ttlMs ?? error.context?.ttlMs;
      if (
        !warnedShortBudget &&
        lockWaitTimeoutMs !== undefined &&
        Number.isFinite(holderTtlMs) &&
        lockWaitTimeoutMs <= holderTtlMs / 2
      ) {
        warnedShortBudget = true;
        logger?.warn(
          `⚠ lockWaitTimeoutMs (${lockWaitTimeoutMs}ms) is no longer than the holder's heartbeat ` +
            `(${holderTtlMs / 2}ms) — a healthy holder may look stalled and the wait give up`,
          { lockWaitTimeoutMs, holderTtlMs },
        );
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
        deadline = Date.now() + budget;
      }
      if (holderLockedAt !== undefined) lastHolderLockedAt = holderLockedAt;
      const nextDelay = backoffDelay(lockPollIntervalMs, attempts, budget);
      if (Date.now() + nextDelay > deadline) {
        settle('timeout');
        if (error instanceof MigronautError) {
          // Copy-on-write: the context may be shared with whoever threw it.
          error.context = { ...error.context, attempts, waitedMs: waitedMs(), timedOut: true };
        }
        throw error;
      }
      if (!waited) {
        logger?.info(
          error instanceof LockAlreadyHeldError
            ? 'Migration lock held by another process — waiting for it to release…'
            : `Waiting: ${errorText(error)}`,
        );
      }
      waited = true;
      logger?.debug('Migration lock still held — retrying', {
        attempts,
        waitedMs: waitedMs(),
        nextDelayMs: nextDelay,
      });
      try {
        onWait?.({
          attempts,
          waitedMs: waitedMs(),
          nextDelayMs: nextDelay,
          holder: error.context?.holder,
          code: error.code,
        });
      } catch {
        // Progress reporting must never end the wait.
      }
      try {
        await delay(nextDelay, undefined, signal ? { signal } : undefined);
      } catch (delayError) {
        if (signal?.aborted) {
          settle('aborted');
          throw abortedError(signal, { attempts, waitedMs: waitedMs() });
        }
        throw delayError;
      }
    }
  }
}

module.exports = {
  DEFAULT_LOCK_POLL_INTERVAL_MS,
  DEFAULT_LOCK_WAIT_TIMEOUT_MS,
  MAX_LOCK_POLL_INTERVAL_MS,
  assertLockWaitOptions,
  backoffDelay,
  jitteredDelay,
  waitBudget,
  withLockWait,
};
