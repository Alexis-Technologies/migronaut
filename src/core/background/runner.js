const { addAbortListener } = require('node:events');

const { ConfigInvalidError, RunAbortedError } = require('../../errors/index.js');
const { MAX_TIMER_MS, jitter } = require('../../utils/concurrency.js');
const { FATAL_SLICE_CODES, formatError } = require('../../utils/error.js');
const { sleep } = require('./throttle.js');
const { assertSliceMs } = require('./spec.js');
const { watchOptions } = require('./watch.js');
const { MigratorKit } = require('../migrator.js');

/**
 * The in-process runner: background migrations driven from inside the
 * application, with no queue — `concurrency` lane loops shared by every
 * runnable background migration, round-robin, each taking a slice at a time
 * (never more than a migration's `maxParallel` here; the leases cap it
 * across every process). Run several application instances and they share
 * the work through the same leases.
 *
 * A lane loop never throws: a failed slice goes to `onError` and that
 * migration backs off. The drift watch runs every `verifyIntervalMs`; the
 * live drift watcher (change streams) runs alongside when `watch` says so —
 * by default when `backgroundDrift` is `'stream'` or `'both'`.
 */

const DEFAULTS = Object.freeze({
  concurrency: 1,
  pollIntervalMs: 5_000,
  verifyIntervalMs: 600_000,
});

/** The longest a failing migration backs off for */
const MAX_BACKOFF_MS = 60_000;

/** What `stopOnSignal` does until the runner exists */
const doNothing = () => undefined;

const readOptions = (options) => {
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new ConfigInvalidError('concurrency must be an integer from 1 to 64', {
      context: { concurrency },
    });
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const isBadPoll =
    !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > MAX_TIMER_MS;
  if (isBadPoll) {
    throw new ConfigInvalidError(`pollIntervalMs must be an integer from 10 to ${MAX_TIMER_MS}`, {
      context: { pollIntervalMs },
    });
  }
  const verifyIntervalMs = options.verifyIntervalMs ?? DEFAULTS.verifyIntervalMs;
  const isBadVerify =
    verifyIntervalMs !== false &&
    (!Number.isSafeInteger(verifyIntervalMs) ||
      verifyIntervalMs < 100 ||
      verifyIntervalMs > MAX_TIMER_MS);
  if (isBadVerify) {
    const message = `verifyIntervalMs must be false or an integer from 100 to ${MAX_TIMER_MS}`;
    throw new ConfigInvalidError(message, {
      context: { verifyIntervalMs },
    });
  }
  if (options.sliceMs !== undefined) assertSliceMs(options.sliceMs);
  if (options.onError !== undefined && typeof options.onError !== 'function') {
    throw new ConfigInvalidError('onError must be a function');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new ConfigInvalidError('signal must be an AbortSignal');
  }
  if (options.kit !== undefined && !(options.kit instanceof MigratorKit)) {
    throw new ConfigInvalidError('kit must be a MigratorKit');
  }
  const { watch } = options;
  if (watch !== undefined && typeof watch !== 'boolean') {
    if (watch === null || typeof watch !== 'object') {
      throw new ConfigInvalidError('watch must be a boolean or the watcher options');
    }
    watchOptions(watch);
  }
  return { concurrency, pollIntervalMs, verifyIntervalMs };
};

/**
 * Start the runner. `options`: `{ kit | config, kitOptions?, concurrency?,
 * pollIntervalMs?, sliceMs?, verifyIntervalMs?, signal?, onError? }`.
 * Returns `{ kit, running, stop() }` — `stop()` resolves once every lane
 * has released its lease (at the next batch) and, when the runner made the
 * kit, the kit is disconnected. Aborting `signal` is a `stop()`.
 */
const startBackgroundRunner = (options = {}) => {
  const { concurrency, pollIntervalMs, verifyIntervalMs } = readOptions(options);
  const kit = options.kit ?? new MigratorKit(options.config ?? {}, options.kitOptions ?? {});
  const isKitOwned = options.kit === undefined;
  const controller = new AbortController();
  const signal = controller.signal;
  // Set once the runner exists: what its `signal` ends like — see stop().
  let stopOnSignal = doNothing;
  const onOuterAbort = () => {
    controller.abort(options.signal.reason);
    stopOnSignal();
  };
  const outer = options.signal ? addAbortListener(options.signal, onOuterAbort) : null;
  if (options.signal?.aborted) controller.abort(options.signal.reason);

  const report = (error, migration) => {
    try {
      options.onError?.(error, migration);
    } catch {
      // A throwing onError is its own problem.
    }
    kit.logger.warn(
      `⚠ Background runner${migration ? ` (${migration})` : ''}: ${formatError(error)}`,
      { ...(migration ? { background: migration } : {}), error: formatError(error) },
    );
  };

  const shared = {
    runnable: [],
    refreshedAt: -Infinity,
    refreshing: undefined,
    next: 0,
    active: new Map(),
    backoff: new Map(),
    failures: new Map(),
  };

  /** The runnable list, refreshed at most every poll interval — by one lane at a time */
  const runnable = async () => {
    if (Date.now() - shared.refreshedAt < pollIntervalMs) return shared.runnable;
    shared.refreshing ??= kit
      .runnableBackground()
      .then((list) => {
        shared.runnable = list;
        shared.refreshedAt = Date.now();
        return undefined;
      })
      .finally(() => {
        shared.refreshing = undefined;
      });
    await shared.refreshing;
    return shared.runnable;
  };

  const forget = () => {
    shared.refreshedAt = -Infinity;
  };

  /** The next background migration a lane may take, round-robin, or `null` */
  const pick = (list) => {
    const now = Date.now();
    for (let i = 0; i < list.length; i++) {
      const entry = list[(shared.next + i) % list.length];
      if ((shared.backoff.get(entry.migration) ?? 0) > now) continue;
      if ((shared.active.get(entry.migration) ?? 0) >= entry.maxParallel) continue;
      shared.next = (shared.next + i + 1) % list.length;
      return entry;
    }
    return null;
  };

  const backOff = (migration, delayMs) =>
    shared.backoff.set(migration, Date.now() + jitter(delayMs));

  const lane = async () => {
    while (!signal.aborted) {
      let entry = null;
      try {
        entry = pick(await runnable());
      } catch (error) {
        report(error);
        await sleep(pollIntervalMs, signal).catch(() => undefined);
        continue;
      }
      if (entry === null) {
        await sleep(pollIntervalMs, signal).catch(() => undefined);
        continue;
      }
      const name = entry.migration;
      shared.active.set(name, (shared.active.get(name) ?? 0) + 1);
      try {
        await turn(name);
        shared.failures.delete(name);
      } catch (error) {
        if (signal.aborted) break;
        const failures = (shared.failures.get(name) ?? 0) + 1;
        shared.failures.set(name, failures);
        report(error, name);
        // A failure no retry fixes waits at the longest from the first: it is
        // the next deploy that fixes it, and the runner keeps watching for it.
        const isFatal = FATAL_SLICE_CODES.has(error?.code);
        backOff(name, isFatal ? MAX_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures));
      } finally {
        shared.active.set(name, shared.active.get(name) - 1);
      }
    }
  };

  /** One turn on one background migration: a slice, and the coordinator when it is needed */
  const turn = async (name) => {
    const slice = await kit.runBackgroundSlice(name, {
      signal,
      ...(options.sliceMs !== undefined ? { sliceMs: options.sliceMs } : {}),
    });
    switch (slice.outcome) {
      case 'yielded':
      case 'lost':
      case 'stopped':
        return;
      case 'busy':
        return void backOff(name, slice.retryAfterMs ?? pollIntervalMs);
      case 'paused':
      case 'cancelled':
      case 'failed':
        forget();
        return;
      default: {
        // Stale (no plan yet) or exhausted (nothing left to claim): the coordinator decides.
        const answer = await kit.coordinateBackground(name, { signal, driver: { kind: 'runner' } });
        if (answer.next === 'done') forget();
        else if (answer.next !== 'process') backOff(name, answer.retryAfterMs ?? pollIntervalMs);
        // Every partition is held by a lane elsewhere: look again later, not at once.
        else if (slice.outcome === 'exhausted') backOff(name, pollIntervalMs);
      }
    }
  };

  const verifier = async () => {
    if (verifyIntervalMs === false) return;
    while (!signal.aborted) {
      try {
        await sleep(verifyIntervalMs, signal);
      } catch {
        return;
      }
      try {
        const result = await kit.verifyBackground();
        if (result.drift.length > 0) forget();
      } catch (error) {
        report(error);
      }
    }
  };

  /** The live drift watcher, when this runner hosts one — it never throws either */
  const watcher = async () => {
    let wanted = options.watch;
    try {
      wanted ??= (await kit.driftMode()) !== 'poll';
      if (wanted === false || signal.aborted) return undefined;
      return await kit.watchBackground({
        ...(typeof wanted === 'object' ? wanted : {}),
        signal,
        onError: (error, collection) => report(error, collection),
      });
    } catch (error) {
      if (!signal.aborted) report(error);
      return undefined;
    }
  };

  const watching = watcher();
  const loops = [];
  for (let i = 0; i < concurrency; i++) loops.push(lane());
  loops.push(verifier());
  const work = Promise.all(loops);
  let stopping = null;
  let hosted = undefined;
  watching.then((started) => {
    hosted = started;
    return undefined;
  });
  const runner = {
    kit,
    get running() {
      return !signal.aborted;
    },
    /** The live drift watcher this runner hosts, once started — or undefined */
    get watcher() {
      return hosted;
    },
    /**
     * Stop: each lane at its next batch boundary, releasing its lease.
     * `timeoutMs`: stop waiting for a lane stuck in its transformation (its
     * lease expires on its own, and the next lane resumes from the last
     * checkpoint) — so a shutdown is never held for good.
     */
    stop({ timeoutMs } = {}) {
      const isBadTimeout =
        timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS);
      if (isBadTimeout) {
        const message = `timeoutMs must be an integer from 0 to ${MAX_TIMER_MS}`;
        return Promise.reject(new ConfigInvalidError(message, { context: { timeoutMs } }));
      }
      stopping ??= (async () => {
        if (!signal.aborted) {
          controller.abort(
            new RunAbortedError('Background runner stopped', {
              context: { reason: 'Background runner stopped' },
            }),
          );
        }
        const settled = (async () => {
          await (await watching)?.stop();
          await work;
        })();
        if (timeoutMs === undefined) {
          await settled;
        } else {
          let timer = null;
          const timedOut = await Promise.race([
            settled.then(() => false),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(true), timeoutMs);
            }),
          ]);
          clearTimeout(timer);
          if (timedOut) {
            kit.logger.warn(
              `⚠ Background runner: lanes still at work after ${timeoutMs}ms — not waiting ` +
                'for them (their leases expire, and the work resumes from the last checkpoint)',
              { timeoutMs },
            );
          }
        }
        outer?.[Symbol.dispose]();
        if (isKitOwned) {
          await kit.disconnect().catch((error) => {
            // The stop is done either way; a failed close is said at debug.
            kit.logger.debug(`Background runner: could not disconnect — ${formatError(error)}`);
          });
        }
      })();
      return stopping;
    },
  };
  // The signal stops the runner as stop() does — the watcher stopped, the
  // lanes waited for, a kit this runner made disconnected. Aborting only the
  // lanes left that kit's connection open, and the process alive with it.
  stopOnSignal = () => {
    runner.stop().catch(() => undefined);
  };
  if (options.signal?.aborted) stopOnSignal();
  return runner;
};

module.exports = { BACKGROUND_RUNNER_DEFAULTS: DEFAULTS, startBackgroundRunner };
