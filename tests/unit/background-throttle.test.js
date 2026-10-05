const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createThrottle,
  excludedMembers,
  replicationLagMs,
  sleep,
} = require('../../src/core/background-throttle.js');

const at = (ms) => new Date(ms);
const status = (secondaries) => ({
  members: [
    { name: 'p:1', stateStr: 'PRIMARY', optimeDate: at(100_000) },
    ...secondaries.map(([name, time]) => ({ name, stateStr: 'SECONDARY', optimeDate: at(time) })),
    { name: 'a:1', stateStr: 'ARBITER' },
  ],
});

/** A fake clock and a sleep that only advances it */
function fakeTime() {
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
}

function logger() {
  const lines = [];
  const log = (level) => (message) => lines.push([level, message]);
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

describe('replication lag', () => {
  it('should measure the worst secondary that counts', () => {
    assert.strictEqual(
      replicationLagMs(
        status([
          ['s:1', 99_000],
          ['s:2', 97_000],
        ]),
        new Set(),
      ),
      3000,
    );
    assert.strictEqual(
      replicationLagMs(
        status([
          ['s:1', 99_000],
          ['s:2', 10_000],
        ]),
        new Set(['s:2']),
      ),
      1000,
    );
    assert.strictEqual(replicationLagMs({ members: [] }, new Set()), 0);
    assert.strictEqual(replicationLagMs(undefined, new Set()), 0);
    assert.deepStrictEqual(
      excludedMembers({
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
