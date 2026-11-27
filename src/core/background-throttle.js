const { addAbortListener } = require('node:events');

const { errorText } = require('../utils/error.js');
const { isUnauthorized } = require('./shard-info.js');

/**
 * Pacing a background migration: it rewrites a production collection while
 * the application uses it, so it must yield to it — before every batch:
 *
 * - the author's pause between batches (`pauseMs`);
 * - the author's own `throttle(ctx)` hook (a returned number is extra pause);
 * - replication lag: on a replica set, wait while a secondary that counts
 *   (not hidden, not delayed) lags more than `maxReplicationLagMs` — the
 *   status read at most every 5 s, and switched off quietly where it cannot
 *   be read (standalone, mongos) or with one warning where it may not be
 *   (no `clusterMonitor`).
 *
 * The latency-driven batch sizing (AIMD) lives here too.
 * Clock and sleep are injected, so every rule is tested without waiting.
 */

/** How often the replication status is read, at most */
const LAG_CHECK_INTERVAL_MS = 5_000;

/** How often the replica set config (hidden and delayed members) is read, at most */
const CONFIG_CHECK_INTERVAL_MS = 60_000;

/** How long to wait between two looks at a lag that is too high */
const LAG_WAIT_MS = 1_000;

/** How long lanes wait for a secondary before it is said aloud, and how often after that */
const LAG_WARN_AFTER_MS = 60_000;
const LAG_WARN_EVERY_MS = 300_000;

/** How often a lag wait is reported (the event, the metric), at most, per process and migration */
const LAG_REPORT_INTERVAL_MS = 10_000;

/**
 * The longest pause a throttle hook gets in one go. A timer past 2³¹−1 ms —
 * or `Infinity` — is not a long wait in Node: it fires after 1 ms, so a hook
 * that meant "back off a lot" would switch the throttle off. The hook is
 * asked again before every batch, so an hour at a time loses nothing.
 */
const MAX_HOOK_PAUSE_MS = 3_600_000;

/** Errors that mean "no replication status here" — not a replica set member */
const NO_REPLICATION = new Set([
  59, // CommandNotFound (mongos)
  76, // NoReplicationEnabled (standalone)
  115, // CommandNotSupported
]);

/** Sleep `ms`, cut short (rejecting with the reason) when `signal` aborts */
const sleep = (ms, signal) => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return void reject(signal.reason);
    if (ms <= 0) return void resolve();
    let listening = null;
    const timer = setTimeout(() => {
      listening?.[Symbol.dispose]();
      resolve();
    }, ms);
    if (signal === undefined || signal === null) return;
    listening = addAbortListener(signal, () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
};

/**
 * The worst lag of a secondary that counts, in ms — or 0. Hidden and delayed
 * members are left out: a delayed one lags on purpose, and a hidden one
 * serves no reads.
 */
const replicationLagMs = (status, excluded) => {
  const members = Array.isArray(status?.members) ? status.members : [];
  let primary = null;
  for (const member of members) {
    if (member.stateStr === 'PRIMARY') primary = member;
  }
  if (primary?.optimeDate === undefined) return 0;
  const primaryTime = new Date(primary.optimeDate).getTime();
  let worst = 0;
  for (const member of members) {
    if (member.stateStr !== 'SECONDARY' || excluded.has(member.name)) continue;
    if (member.optimeDate === undefined) continue;
    const lag = primaryTime - new Date(member.optimeDate).getTime();
    if (lag > worst) worst = lag;
  }
  return worst;
};

/** Hidden or delayed member hosts, from the replica set config */
const excludedMembers = (config) => {
  const hosts = new Set();
  for (const member of config?.config?.members ?? []) {
    const delay = member.secondaryDelaySecs ?? member.slaveDelay ?? 0;
    if (member.hidden === true || Number(delay) > 0) hosts.add(member.host);
  }
  return hosts;
};

/**
 * A throttle for one lane. `options`: `{ spec, db, logger, name, now?,
 * sleep?, signal?, lagWaits? }`. `beforeBatch(ctx)` waits as the rules say;
 * it rejects only when `signal` aborts, and resolves to `{ expired: true }`
 * when a lagging secondary outlasted the slice (`ctx.deadline`).
 *
 * `lagWaits` is the process's memory of the waits in progress, per migration
 * (`Map<name, { since, warnedAt, reportedAt }>`): a wait goes on across the
 * slices and the lanes of a process, and is said once for all of them.
 */
const createThrottle = ({
  spec,
  db,
  logger,
  name,
  now = Date.now,
  wait = sleep,
  warned,
  lagWaits = new Map(),
}) => {
  const maxLag = spec.maxReplicationLagMs;
  let lagEnabled = maxLag !== false && typeof db?.admin === 'function';
  let lastLagCheck = -Infinity;
  let lastConfigCheck = -Infinity;
  let excluded = new Set();
  let first = true;
  // Set when the last wait was for a lagging secondary — an overload signal.
  let lagged = false;
  // One warning per process for a lag that cannot be read for lack of rights.
  const warnings = warned ?? new Set();

  const currentLag = async () => {
    const admin = db.admin();
    if (now() - lastConfigCheck >= CONFIG_CHECK_INTERVAL_MS) {
      lastConfigCheck = now();
      try {
        excluded = excludedMembers(await admin.command({ replSetGetConfig: 1 }));
      } catch {
        // Without the config every secondary counts — the cautious reading.
      }
    }
    return replicationLagMs(await admin.command({ replSetGetStatus: 1 }), excluded);
  };

  /**
   * A lag wait made visible: an event and a metric point at most every 10 s
   * (`onLag`), and a warning once it has lasted a minute, then every five —
   * a lane that holds its lease and writes nothing looks healthy to every
   * other check there is.
   */
  const reportLag = (lag, onLag) => {
    const at = now();
    let entry = lagWaits.get(name);
    if (entry === undefined) {
      entry = { since: at, warnedAt: -Infinity, reportedAt: -Infinity };
      lagWaits.set(name, entry);
    }
    const waitedMs = at - entry.since;
    if (at - entry.reportedAt >= LAG_REPORT_INTERVAL_MS) {
      entry.reportedAt = at;
      onLag?.({ reason: 'lag', lagMs: lag, waitedMs });
    }
    if (waitedMs >= LAG_WARN_AFTER_MS && at - entry.warnedAt >= LAG_WARN_EVERY_MS) {
      entry.warnedAt = at;
      logger.warn(
        `⚠ ${name}: a secondary lags ${lag}ms (maxReplicationLagMs ${maxLag}) — its lanes ` +
          `have been waiting for ${Math.round(waitedMs / 1000)}s and write nothing meanwhile`,
        { background: name, lagMs: lag, waitedMs },
      );
    }
  };

  /** Wait while a secondary lags too far; resolves to whether the slice ran out meanwhile */
  const waitForLag = async (signal, { deadline, onLag } = {}) => {
    if (!lagEnabled || now() - lastLagCheck < LAG_CHECK_INTERVAL_MS) return false;
    for (;;) {
      lastLagCheck = now();
      let lag = 0;
      try {
        lag = await currentLag();
      } catch (error) {
        lagEnabled = false;
        if (isUnauthorized(error) && !warnings.has('lag')) {
          warnings.add('lag');
          logger.warn(
            '⚠ Background migrations cannot read the replication lag (replSetGetStatus needs ' +
              'the clusterMonitor role) — they no longer wait for secondaries',
            { background: name, error: errorText(error) },
          );
        } else if (!NO_REPLICATION.has(error?.code)) {
          logger.debug(`Replication lag unreadable — not waiting for it: ${errorText(error)}`, {
            background: name,
          });
        }
        return false;
      }
      if (lag <= maxLag) {
        lagWaits.delete(name);
        return false;
      }
      lagged = true;
      logger.debug(`Replication lag ${lag}ms > ${maxLag}ms — waiting`, {
        background: name,
        lagMs: lag,
      });
      reportLag(lag, onLag);
      await wait(LAG_WAIT_MS, signal);
      // The slice is over: the lane gives its slot back and reads its
      // controls again, instead of holding both through a lag of hours — a
      // pause or a cancel would otherwise wait for the secondary too.
      if (deadline !== undefined && now() >= deadline) return true;
    }
  };

  return {
    /** Whether the last `beforeBatch` waited for a lagging secondary — read once */
    takeLagged() {
      const was = lagged;
      lagged = false;
      return was;
    },
    /**
     * Everything a lane waits for before reading its next batch. `deadline`
     * (the slice's, epoch ms) ends a wait for a lagging secondary —
     * `{ expired: true }`; `onLag(change)` hears of that wait.
     */
    async beforeBatch({
      signal,
      generation,
      partition,
      batchSize,
      extraPauseMs = 0,
      deadline,
      onLag,
    }) {
      const pause = (first ? 0 : spec.pauseMs) + extraPauseMs;
      if (pause > 0) await wait(pause, signal);
      first = false;
      if (typeof spec.throttle === 'function') {
        const extra = await spec.throttle({
          name,
          ...(spec.collection !== undefined ? { collection: spec.collection } : {}),
          generation,
          partition,
          batchSize,
          signal,
        });
        if (typeof extra === 'number' && extra > 0) {
          await wait(Math.min(extra, MAX_HOOK_PAUSE_MS), signal);
        }
      }
      return { expired: await waitForLag(signal, { deadline, onLag }) };
    },
  };
};

// ─── Adaptive batch sizing (AIMD) ─────────────────────────────────────────────

/** How often a throttle change is reported, at most, per controller */
const THROTTLE_REPORT_INTERVAL_MS = 10_000;

/** The first extra pause once the batch is as small as it gets */
const FIRST_BACKOFF_MS = 100;

/**
 * A latency-driven batch size, additive-increase / multiplicative-decrease —
 * TCP's answer to "how fast may I go without knowing the capacity": every
 * batch written within `targetLatencyMs` grows the next one a little; one
 * slower, or a sign of overload (a write concern timeout, a transient error,
 * a lagging secondary), halves it — at most once per round trip, so one slow
 * moment is not punished twice. At `minBatchSize` it backs off in time
 * instead: an extra pause that doubles up to `maxPauseMs` and halves again as
 * things recover. The first batch only warms up.
 *
 * Works on every topology — behind a mongos and on a standalone it is the
 * only signal there is. `settings` is the resolved `spec.adaptive`;
 * `initial` the state saved on the partition (`{ batchSize, pauseMs }`).
 */
const createAdaptive = (settings, { initial, now = Date.now } = {}) => {
  const { targetLatencyMs, minBatchSize, maxBatchSize, maxPauseMs } = settings;
  const increase = Math.max(1, Math.floor(maxBatchSize / 20));
  let size = clamp(initial?.batchSize ?? maxBatchSize, minBatchSize, maxBatchSize);
  let pause = clamp(initial?.pauseMs ?? 0, 0, maxPauseMs);
  let warm = initial !== undefined;
  let lastDecrease = -Infinity;
  let lastReport = -Infinity;
  let pendingReason = '';

  return {
    batchSize: () => size,
    pauseMs: () => pause,
    state: () => ({ batchSize: size, pauseMs: pause }),
    /**
     * Judge one batch: `{ latencyMs, overloaded? }`. Returns the change to
     * report — `{ reason, batchSize, pauseMs }` with `reason` `'slow'`,
     * `'overload'` or `'recover'` — at most every 10 s, else `undefined`.
     */
    record({ latencyMs, overloaded = false }) {
      if (!warm) {
        warm = true;
        return undefined;
      }
      const slow = latencyMs > targetLatencyMs;
      let reason = '';
      if (overloaded || slow) {
        // Once per round trip: the batch that saw the last decrease does not count twice.
        if (now() - lastDecrease < Math.max(latencyMs, 1)) return undefined;
        lastDecrease = now();
        reason = overloaded ? 'overload' : 'slow';
        if (size > minBatchSize) size = Math.max(minBatchSize, Math.floor(size / 2));
        else pause = Math.min(maxPauseMs, Math.max(FIRST_BACKOFF_MS, pause * 2));
      } else if (pause > 0 || size < maxBatchSize) {
        reason = 'recover';
        if (pause > 0) pause = Math.floor(pause / 2);
        else size = Math.min(maxBatchSize, size + increase);
      }
      if (reason === '') return undefined;
      pendingReason = pendingReason === 'recover' || pendingReason === '' ? reason : pendingReason;
      if (now() - lastReport < THROTTLE_REPORT_INTERVAL_MS) return undefined;
      lastReport = now();
      const report = { reason: pendingReason, batchSize: size, pauseMs: pause };
      pendingReason = '';
      return report;
    },
  };
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

module.exports = {
  LAG_CHECK_INTERVAL_MS,
  LAG_WARN_AFTER_MS,
  LAG_WARN_EVERY_MS,
  MAX_HOOK_PAUSE_MS,
  THROTTLE_REPORT_INTERVAL_MS,
  createAdaptive,
  createThrottle,
  excludedMembers,
  replicationLagMs,
  sleep,
};
