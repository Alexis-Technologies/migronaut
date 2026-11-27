const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createThrottle,
  listExcludedMembers,
  measureReplicationLagMs,
  sleep,
  MAX_HOOK_PAUSE_MS,
} = require('../../src/core/background/throttle.js');

const at = (ms) => new Date(ms);
const status = (secondaries) => ({
  members: [
    { name: 'p:1', stateStr: 'PRIMARY', optimeDate: at(100_000) },
    ...secondaries.map(([name, time]) => ({ name, stateStr: 'SECONDARY', optimeDate: at(time) })),
    { name: 'a:1', stateStr: 'ARBITER' },
  ],
});

/** A fake clock and a sleep that only advances it */
const fakeTime = () => {
  let now = 0;
  const waits = [];
  return {
    now: () => now,
    waits,
    wait: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason;
      waits.push(ms);
      now += ms;
    },
  };
};

const logger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push([level, message]);
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
};

describe('replication lag', () => {
  it('should measure the worst secondary that counts', () => {
    assert.strictEqual(
      measureReplicationLagMs(
        status([
          ['s:1', 99_000],
          ['s:2', 97_000],
        ]),
        new Set(),
      ),
      3000,
    );
    assert.strictEqual(
      measureReplicationLagMs(
        status([
          ['s:1', 99_000],
          ['s:2', 10_000],
        ]),
        new Set(['s:2']),
      ),
      1000,
    );
    assert.strictEqual(measureReplicationLagMs({ members: [] }, new Set()), 0);
    assert.strictEqual(measureReplicationLagMs(undefined, new Set()), 0);
    assert.deepStrictEqual(
      listExcludedMembers({
        config: {
          members: [
            { host: 'a', hidden: true },
            { host: 'b', secondaryDelaySecs: 3600 },
            { host: 'c', slaveDelay: 10 },
            { host: 'd' },
          ],
        },
      }),
      new Set(['a', 'b', 'c']),
    );
  });
});

describe('getAdaptive — the controller a process keeps per migration and group', () => {
  const { getAdaptive } = require('../../src/core/background/lane.js');
  const settings = { targetLatencyMs: 100, minBatchSize: 10, maxBatchSize: 500, maxPauseMs: 5000 };
  const partition = { group: 'shard-a' };

  it('should share one controller between the lanes of a migration and group', () => {
    const deps = { adaptiveCache: new Map() };
    const first = getAdaptive(deps, 'm.js', partition, settings);
    assert.strictEqual(getAdaptive(deps, 'm.js', partition, { ...settings }), first);
    assert.notStrictEqual(getAdaptive(deps, 'm.js', { group: 'shard-b' }, settings), first);
    assert.notStrictEqual(getAdaptive(deps, 'other.js', partition, settings), first);
  });

  it('should follow settings that changed, keeping what was learned within the new bounds', () => {
    const deps = { adaptiveCache: new Map() };
    const before = getAdaptive(deps, 'm.js', partition, settings);
    assert.strictEqual(before.batchSize(), 500);
    // A repin that lowers batchSize: a runner up for days must not go on
    // writing batches of 500.
    const lowered = { ...settings, maxBatchSize: 50 };
    const after = getAdaptive(deps, 'm.js', partition, lowered);
    assert.notStrictEqual(after, before);
    assert.strictEqual(after.batchSize(), 50);
    assert.strictEqual(getAdaptive(deps, 'm.js', partition, lowered), after);
  });

  it('should start a new process where the partition says the last one stopped', () => {
    const saved = { group: 'shard-a', throttle: { batchSize: 40, pauseMs: 200 } };
    const controller = getAdaptive({ adaptiveCache: new Map() }, 'm.js', saved, settings);
    assert.deepStrictEqual(controller.state(), { batchSize: 40, pauseMs: 200 });
    // No cache (a caller that keeps none): a controller of its own each time.
    assert.notStrictEqual(getAdaptive({}, 'm.js', saved, settings), controller);
  });
});

describe('createThrottle', () => {
  const spec = { pauseMs: 100, maxReplicationLagMs: 2000 };

  it('should pause between batches, not before the first, and call the hook', async () => {
    const time = fakeTime();
    const calls = [];
    const throttle = createThrottle({
      spec: {
        ...spec,
        collection: 'orders',
        maxReplicationLagMs: false,
        throttle: (ctx) => {
          calls.push(ctx);
          return 50;
        },
      },
      db: {},
      logger: logger(),
      name: 'm.js',
      now: time.now,
      wait: time.wait,
    });
    await throttle.beforeBatch({ generation: 1, partition: 'p', batchSize: 10 });
    await throttle.beforeBatch({ generation: 1, partition: 'p', batchSize: 10 });
    assert.deepStrictEqual(time.waits, [50, 100, 50]);
    assert.strictEqual(calls[0].name, 'm.js');
    assert.strictEqual(calls[0].collection, 'orders');
  });

  it('should cap what the hook asks for — a timer past 2^31 ms would fire at once', async () => {
    for (const [asked, waited] of [
      [Infinity, [MAX_HOOK_PAUSE_MS]],
      [3e9, [MAX_HOOK_PAUSE_MS]],
      [MAX_HOOK_PAUSE_MS + 1, [MAX_HOOK_PAUSE_MS]],
      [250, [250]],
      // Not a pause at all: nothing is waited.
      [Number.NaN, []],
      [-5, []],
      ['2000', []],
    ]) {
      const time = fakeTime();
      const throttle = createThrottle({
        spec: { pauseMs: 0, maxReplicationLagMs: false, throttle: () => asked },
        db: {},
        logger: logger(),
        name: 'm.js',
        now: time.now,
        wait: time.wait,
      });
      await throttle.beforeBatch({ generation: 1, partition: 'p', batchSize: 10 });
      assert.deepStrictEqual(time.waits, waited, String(asked));
    }
  });

  it('should wait while a secondary lags too far, reading at most every 5 s', async () => {
    const time = fakeTime();
    const lags = [5000, 3000, 1000, 1000];
    let reads = 0;
    const db = {
      admin: () => ({
        command: async (command) => {
          if (command.replSetGetConfig) return { config: { members: [] } };
          reads += 1;
          return status([['s:1', 100_000 - lags[Math.min(reads - 1, lags.length - 1)]]]);
        },
      }),
    };
    const throttle = createThrottle({
      spec,
      db,
      logger: logger(),
      name: 'm',
      now: time.now,
      wait: time.wait,
    });
    await throttle.beforeBatch({});
    assert.strictEqual(reads, 3, 'waited through two high readings');
    assert.deepStrictEqual(time.waits, [1000, 1000]);
    await throttle.beforeBatch({});
    assert.strictEqual(reads, 3, 'not read again within 5 s');
  });

  /** A replica set whose one secondary lags `lagMs()` behind */
  const laggingDb = (lagMs) => ({
    admin: () => ({
      command: async (command) =>
        command.replSetGetConfig
          ? { config: { members: [] } }
          : status([['s:1', 100_000 - lagMs()]]),
    }),
  });

  it('should make a long lag wait visible: an event every 10 s, a warning after a minute', async () => {
    const time = fakeTime();
    const log = logger();
    const lagWaits = new Map();
    const changes = [];
    // Lagging for 400 s, then caught up.
    const throttle = createThrottle({
      spec,
      db: laggingDb(() => (time.now() < 400_000 ? 9000 : 0)),
      logger: log,
      name: 'm.js',
      now: time.now,
      wait: time.wait,
      lagWaits,
    });
    const waited = await throttle.beforeBatch({ onLag: (change) => changes.push(change) });
    assert.deepStrictEqual(waited, { expired: false });
    assert.strictEqual(time.now(), 400_000);
    // The first reading, then at most one every 10 s.
    assert.strictEqual(changes.length, 40);
    assert.deepStrictEqual(changes[0], { reason: 'lag', lagMs: 9000, waitedMs: 0 });
    assert.deepStrictEqual(changes[1], { reason: 'lag', lagMs: 9000, waitedMs: 10_000 });
    // Said aloud a minute in, then every five: at 60 s and at 360 s.
    const warnings = log.lines.filter(([level]) => level === 'warn');
    assert.strictEqual(warnings.length, 2);
    assert.match(warnings[0][1], /m\.js: a secondary lags 9000ms .* waiting for 60s/);
    assert.match(warnings[1][1], /waiting for 360s/);
    // Caught up: the wait is forgotten, and the next one starts from zero.
    assert.strictEqual(lagWaits.size, 0);
  });

  it('should end a lag wait when the slice does, after waiting at least once', async () => {
    const time = fakeTime();
    const changes = [];
    const throttle = createThrottle({
      spec,
      db: laggingDb(() => 9000),
      logger: logger(),
      name: 'm.js',
      now: time.now,
      wait: time.wait,
    });
    // A deadline already passed still waits once: a slice of 1 ms must not
    // turn a lag into a loop of claims.
    const waited = await throttle.beforeBatch({
      deadline: 0,
      onLag: (change) => changes.push(change),
    });
    assert.deepStrictEqual(waited, { expired: true });
    assert.deepStrictEqual(time.waits, [1000]);
    assert.strictEqual(changes.length, 1);
  });

  it('should go on with one wait across the slices and lanes of a process', async () => {
    const time = fakeTime();
    const log = logger();
    const lagWaits = new Map();
    const changes = [];
    const lane = () =>
      createThrottle({
        spec: { ...spec, pauseMs: 0 },
        db: laggingDb(() => 9000),
        logger: log,
        name: 'm.js',
        now: time.now,
        wait: time.wait,
        lagWaits,
      });
    // Slices of 30 s, each with a throttle of its own, as a lane makes them.
    for (let slice = 0; slice < 3; slice++) {
      const waited = await lane().beforeBatch({
        deadline: time.now() + 30_000,
        onLag: (change) => changes.push(change),
      });
      assert.deepStrictEqual(waited, { expired: true });
    }
    assert.strictEqual(time.now(), 90_000);
    // Not one report per slice, and the minute is counted over all of them.
    assert.strictEqual(changes.length, 9);
    assert.strictEqual(changes.at(-1).waitedMs, 80_000);
    assert.strictEqual(log.lines.filter(([level]) => level === 'warn').length, 1);
  });

  it('should warn once without the rights, and go quiet where there is no replica set', async () => {
    const time = fakeTime();
    const log = logger();
    const warned = new Set();
    const denied = {
      admin: () => ({
        command: async () => {
          throw Object.assign(new Error('not authorized'), { code: 13 });
        },
      }),
    };
    for (let i = 0; i < 2; i++) {
      const throttle = createThrottle({
        spec,
        db: denied,
        logger: log,
        name: 'm',
        now: time.now,
        wait: time.wait,
        warned,
      });
      await throttle.beforeBatch({});
    }
    assert.strictEqual(log.lines.filter(([level]) => level === 'warn').length, 1);
    assert.match(log.lines[0][1], /clusterMonitor/);
    const standalone = {
      admin: () => ({
        command: async () => {
          throw Object.assign(new Error('not running with --replSet'), { code: 76 });
        },
      }),
    };
    const quiet = logger();
    await createThrottle({
      spec,
      db: standalone,
      logger: quiet,
      name: 'm',
      now: time.now,
      wait: time.wait,
    }).beforeBatch({});
    assert.deepStrictEqual(quiet.lines, []);
    const odd = {
      admin: () => ({
        command: async () => {
          throw Object.assign(new Error('weird'), { code: 1 });
        },
      }),
    };
    const debug = logger();
    await createThrottle({
      spec,
      db: odd,
      logger: debug,
      name: 'm',
      now: time.now,
      wait: time.wait,
    }).beforeBatch({});
    assert.strictEqual(debug.lines[0][0], 'debug');
  });

  it('should sleep for real, and stop at an abort', async () => {
    await sleep(0);
    await sleep(1);
    await assert.rejects(sleep(10, AbortSignal.abort(new Error('stop'))), /stop/);
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort(new Error('later'));
    await assert.rejects(pending, /later/);
  });
});

describe('createAdaptive (AIMD)', () => {
  const {
    createAdaptive,
    THROTTLE_REPORT_INTERVAL_MS,
  } = require('../../src/core/background/throttle.js');
  const settings = { targetLatencyMs: 100, minBatchSize: 10, maxBatchSize: 200, maxPauseMs: 1000 };

  it('should warm up, halve on a slow batch and grow back additively', () => {
    let now = 0;
    const adaptive = createAdaptive(settings, { now: () => now });
    assert.strictEqual(adaptive.batchSize(), 200);
    assert.strictEqual(adaptive.record({ latencyMs: 5000 }), undefined, 'first batch warms up');
    now += 1000;
    const slow = adaptive.record({ latencyMs: 300 });
    assert.deepStrictEqual(slow, { reason: 'slow', batchSize: 100, pauseMs: 0 });
    // Not twice within one round trip.
    now += 100;
    adaptive.record({ latencyMs: 300 });
    assert.strictEqual(adaptive.batchSize(), 100);
    now += 400;
    adaptive.record({ latencyMs: 300 });
    assert.strictEqual(adaptive.batchSize(), 50);
    for (let i = 0; i < 5; i++) {
      now += 50;
      adaptive.record({ latencyMs: 20 });
    }
    assert.strictEqual(adaptive.batchSize(), 100, '+10 per good batch');
    assert.deepStrictEqual(adaptive.state(), { batchSize: 100, pauseMs: 0 });
  });

  it('should back off in time at the smallest batch, and recover the pause first', () => {
    let now = 0;
    const adaptive = createAdaptive(settings, {
      now: () => now,
      initial: { batchSize: 10, pauseMs: 0 },
    });
    for (const expected of [100, 200, 400, 800, 1000, 1000]) {
      now += 2000;
      adaptive.record({ latencyMs: 10, overloaded: true });
      assert.strictEqual(adaptive.pauseMs(), expected);
    }
    now += 10;
    adaptive.record({ latencyMs: 10 });
    assert.strictEqual(adaptive.pauseMs(), 500);
    assert.strictEqual(adaptive.batchSize(), 10, 'the pause recovers before the size');
  });

  it('should report at most every 10 s, the worst reason since the last report', () => {
    let now = 0;
    const adaptive = createAdaptive(settings, { now: () => now, initial: { batchSize: 100 } });
    assert.strictEqual(adaptive.record({ latencyMs: 10 }).reason, 'recover');
    now += 1000;
    assert.strictEqual(adaptive.record({ latencyMs: 500 }), undefined, 'held back');
    now += 1000;
    assert.strictEqual(adaptive.record({ latencyMs: 10 }), undefined);
    now += THROTTLE_REPORT_INTERVAL_MS;
    assert.strictEqual(adaptive.record({ latencyMs: 10 }).reason, 'slow');
    // Full speed and no pause: nothing to say.
    const idle = createAdaptive(settings, { now: () => now, initial: { batchSize: 200 } });
    assert.strictEqual(idle.record({ latencyMs: 10 }), undefined);
  });
});

describe('isOverload', () => {
  const { isOverload } = require('../../src/core/background/engine.js');
  it('should tell capacity trouble from data trouble', () => {
    assert.ok(isOverload({ err: {} }));
    assert.ok(isOverload({ writeConcernError: {} }));
    assert.ok(isOverload({ result: { getWriteConcernError: () => ({}) } }));
    assert.ok(isOverload({ hasErrorLabel: (label) => label === 'TransientTransactionError' }));
    assert.ok(isOverload({ hasErrorLabel: (label) => label === 'RetryableWriteError' }));
    assert.ok(isOverload({ code: 50 }));
    assert.ok(!isOverload({ code: 11000 }));
    assert.ok(!isOverload(undefined));
  });
});
