const { ConfigInvalidError, RunAbortedError } = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { jitter, sleep } = require('./background-throttle.js');
const { assertSliceMs } = require('./background-spec.js');
const { watchOptions } = require('./background-watch.js');
const { MigratorKit } = require('./migrator.js');

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

function readOptions(options) {
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new ConfigInvalidError('concurrency must be an integer from 1 to 64', { concurrency });
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new ConfigInvalidError('pollIntervalMs must be an integer ≥ 10', { pollIntervalMs });
  }
  const verifyIntervalMs = options.verifyIntervalMs ?? DEFAULTS.verifyIntervalMs;
  if (
    verifyIntervalMs !== false &&
    (!Number.isSafeInteger(verifyIntervalMs) || verifyIntervalMs < 100)
  ) {
    throw new ConfigInvalidError('verifyIntervalMs must be false or an integer ≥ 100', {
      verifyIntervalMs,
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
}

/**
 * Start the runner. `options`: `{ kit | config, kitOptions?, concurrency?,
 * pollIntervalMs?, sliceMs?, verifyIntervalMs?, signal?, onError? }`.
 * Returns `{ kit, running, stop() }` — `stop()` resolves once every lane
 * has released its lease (at the next batch) and, when the runner made the
 * kit, the kit is disconnected.
 */
function startBackgroundRunner(options = {}) {
  const { concurrency, pollIntervalMs, verifyIntervalMs } = readOptions(options);
  const kit = options.kit ?? new MigratorKit(options.config ?? {}, options.kitOptions ?? {});
  const ownsKit = options.kit === undefined;
  const controller = new AbortController();
  const signal = controller.signal;
  const onOuterAbort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (options.signal?.aborted) controller.abort(options.signal.reason);

  const report = (error, migration) => {
    try {
      options.onError?.(error, migration);
    } catch {
      // A throwing onError is its own problem.
    }
    kit.logger.warn(
      `⚠ Background runner${migration ? ` (${migration})` : ''}: ${errorText(error)}`,
      { ...(migration ? { background: migration } : {}), error: errorText(error) },
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
  async function runnable() {
    if (Date.now() - shared.refreshedAt < pollIntervalMs) return shared.runnable;
    shared.refreshing ??= kit
      .runnableBackground()
      .then((list) => {
        shared.runnable = list;
        shared.refreshedAt = Date.now();
      })
      .finally(() => {
        shared.refreshing = undefined;
      });
    await shared.refreshing;
    return shared.runnable;
  }

  const forget = () => {
    shared.refreshedAt = -Infinity;
  };

  /** The next background migration a lane may take, round-robin, or `undefined` */
  function pick(list) {
    const now = Date.now();
    for (let i = 0; i < list.length; i++) {
      const entry = list[(shared.next + i) % list.length];
      if ((shared.backoff.get(entry.migration) ?? 0) > now) continue;
      if ((shared.active.get(entry.migration) ?? 0) >= entry.maxParallel) continue;
      shared.next = (shared.next + i + 1) % list.length;
      return entry;
    }
    return undefined;
  }

  const backOff = (migration, ms) => shared.backoff.set(migration, Date.now() + jitter(ms));

  async function lane() {
    while (!signal.aborted) {
      let entry;
      try {
        entry = pick(await runnable());
      } catch (error) {
        report(error);
        await sleep(pollIntervalMs, signal).catch(() => undefined);
        continue;
      }
      if (entry === undefined) {
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
        backOff(name, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failures));
      } finally {
        shared.active.set(name, shared.active.get(name) - 1);
      }
    }
  }

  /** One turn on one background migration: a slice, and the coordinator when it is needed */
  async function turn(name) {
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
        backOff(name, slice.retryAfterMs ?? pollIntervalMs);
        return;
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
  }

  async function verifier() {
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
  }

  /** The live drift watcher, when this runner hosts one — it never throws either */
  async function watcher() {
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
  }

  const watching = watcher();
  const work = Promise.all([...Array.from({ length: concurrency }, () => lane()), verifier()]);
  let stopping;
  let hosted;
  watching.then((started) => {
    hosted = started;
  });
  return {
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
      if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)) {
        return Promise.reject(
          new ConfigInvalidError('timeoutMs must be an integer ≥ 0', { timeoutMs }),
        );
      }
      stopping ??= (async () => {
        if (!signal.aborted) {
          controller.abort(
            new RunAbortedError('Background runner stopped', {
              reason: 'Background runner stopped',
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
          let timer;
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
        options.signal?.removeEventListener('abort', onOuterAbort);
        if (ownsKit) await kit.disconnect().catch(() => undefined);
      })();
      return stopping;
    },
  };
}

module.exports = { BACKGROUND_RUNNER_DEFAULTS: DEFAULTS, startBackgroundRunner };
