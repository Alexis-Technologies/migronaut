const assert = require('node:assert/strict');
const { afterEach, beforeEach, it } = require('node:test');
const { createMigrationQueue } = require('../../bullmq.js');
const { BackgroundPendingError } = require('../../src/errors/index.js');
const { insertMigration, makeProject } = require('./project.js');

const NAME = '0001-orders.js';
const PARTITIONS = '_migronaut_background_partitions';

/** A background migration over `orders`, v1 → v2, `delayMs` per batch */
function spec({ delayMs = 5, extra = '', collection = 'orders' } = {}) {
  return `export const background = {
  collection: '${collection}',
  from: 1,
  to: 2,
  pauseMs: 0,
  batchSize: 25,
  maxParallel: 2,
  partitions: { minPartitionDocs: 25 },
  migrateBatch: async (docs) => {
    await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
    return docs.map((doc) => ({ ...doc, done: true }));
  },
  ${extra}
};
`;
}

/**
 * Background migrations on the queue — the coordinator job, its lanes as
 * children, the heals — written once and run against the in-tree fake and
 * (in the opt-in file) the real library. Every scenario waits until the
 * background migration is where it expects in MongoDB AND the background
 * queue holds nothing waiting, active, delayed or waiting for children:
 * `afterEach` force-closes, and a lane still in flight would write into the
 * next scenario's database.
 *
 * `harness`: the object `defineBullMQScenarios` takes.
 */
function defineBullMQBackgroundScenarios(harness) {
  let project;
  let connection;
  let prefix;
  const opened = [];

  beforeEach(async () => {
    const { db } = harness.mongo();
    await db.dropDatabase();
    await db.collection('orders').createIndex({ __v: 1, _id: 1 });
    project = makeProject();
    connection = harness.connection();
    prefix = harness.prefix();
  });

  afterEach(async () => {
    for (const mq of opened.splice(0)) {
      await harness.obliterate(mq.queue).catch(() => undefined);
      if (mq.backgroundQueue) await harness.obliterate(mq.backgroundQueue).catch(() => undefined);
      await mq.close({ force: true }).catch(() => undefined);
    }
    project?.cleanup();
  });

  function createQueue({ background, config, bullmq } = {}) {
    const mq = createMigrationQueue({
      config: {
        uri: harness.mongo().uri,
        dbName: harness.dbName,
        migrationsDir: project.dir,
        logger: null,
        // Leases and the coordinator lock expire in 2s: a busy coordinator
        // looks again after 1s, a dead lane's lease is reclaimed after 2s.
        lockTTLSeconds: 2,
        ...config,
      },
      bullmq: bullmq ?? harness.bullmq(),
      connection,
      ...(prefix !== undefined ? { prefix } : {}),
      lockWait: { lockPollIntervalMs: 20, lockWaitTimeoutMs: 10_000 },
      background: { verifyIntervalMs: false, pollIntervalMs: 50, sliceMs: 100, ...background },
    });
    opened.push(mq);
    return mq;
  }

  async function seed(count, collection = 'orders') {
    await harness
      .mongo()
      .db.collection(collection)
      .insertMany(Array.from({ length: count }, (_, i) => ({ __v: 1, __rev: 0, i })));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function until(what, check, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  }

  /** The background migration reached `status` */
  const reached = (mq, status, name = NAME, timeoutMs) =>
    until(
      `${name} to be ${status}`,
      async () => {
        const state = await mq.backgroundStatus(name);
        return state?.status === status ? state : undefined;
      },
      timeoutMs,
    );

  /** Nothing left on the background queue but finished jobs */
  async function drained(mq, timeoutMs = 30_000) {
    let last;
    await until(
      'the background queue to drain',
      async () => {
        const counts = await mq.backgroundQueue.getJobCounts();
        last = counts;
        let open = 0;
        for (const key of ['waiting', 'active', 'delayed', 'waiting-children', 'paused']) {
          open += counts[key] ?? 0;
        }
        return open === 0;
      },
      timeoutMs,
    ).catch((error) => {
      throw new Error(`${error.message}: ${JSON.stringify(last)}`);
    });
  }

  /** Sample the leases held at once until stopped — the maxParallel check */
  function sampleLeases() {
    const sampling = { on: true, peak: 0 };
    sampling.done = (async () => {
      while (sampling.on) {
        const leased = await harness
          .mongo()
          .db.collection(PARTITIONS)
          .countDocuments({ lease: { $exists: true } });
        sampling.peak = Math.max(sampling.peak, leased);
        await sleep(5);
      }
    })();
    return sampling;
  }

  const migrated = (collection = 'orders') =>
    harness.mongo().db.collection(collection).countDocuments({ __v: 2, __rev: 1, done: true });

  it('[background] should register on up, start its coordinator, and finish it with two lanes', async () => {
    await seed(400);
    project.write(NAME, spec());
    const mq = createQueue();
    await mq.startWorker();
    await mq.startBackgroundWorker();
    const sampling = sampleLeases();
    const group = await mq.enqueueUp();
    const { results } = await group.wait({ timeoutMs: 20_000 });
    assert.strictEqual(results[0].status, 'applied');
    assert.strictEqual(results[0].background.length, 1);
    const coordinator = results[0].background[0].jobId;
    const status = await reached(mq, 'completed');
    await drained(mq);
    sampling.on = false;
    await sampling.done;
    assert.ok(sampling.peak <= 2, `at most maxParallel leases, saw ${sampling.peak}`);
    assert.strictEqual(status.totals.migrated, 400);
    assert.strictEqual(await migrated(), 400);
    const finished = await mq.backgroundQueue.getJob(coordinator);
    assert.strictEqual(finished.returnvalue.status, 'completed');
    assert.ok(finished.returnvalue.round >= 1);
    assert.strictEqual(status.coordinator.kind, 'bullmq');
  });

  it('[background] should finalize as failed when a partition fails', async () => {
    await seed(60);
    project.write(
      NAME,
      `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  maxSliceFailures: 1,
  migrateBatch: async () => {
    throw new Error('cannot migrate these');
  },
};
`,
    );
    const mq = createQueue();
    await mq.startWorker();
    await mq.startBackgroundWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 20_000 });
    const status = await reached(mq, 'failed');
    await drained(mq);
    assert.match(status.lastError, /cannot migrate these/);
    assert.strictEqual(await migrated(), 0);
  });

  it('[background] should stop its lanes on pause, and go on from there on resume', async () => {
    await seed(400);
    project.write(NAME, spec({ delayMs: 20 }));
    const mq = createQueue();
    await mq.startWorker();
    await mq.startBackgroundWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 20_000 });
    await until('some progress', async () => (await migrated()) > 0);
    await mq.kit.pauseBackground(NAME);
    await reached(mq, 'paused');
    await drained(mq);
    const atPause = await migrated();
    assert.ok(atPause < 400, `paused midway: ${atPause}`);
    await sleep(100);
    assert.strictEqual(await migrated(), atPause, 'no lane runs while paused');
    await mq.kit.resumeBackground(NAME);
    await mq.enqueueBackground(NAME);
    await reached(mq, 'completed');
    await drained(mq);
    assert.strictEqual(await migrated(), 400);
  });

  it('[background] should hold maxParallel across two facades on the same queue', async () => {
    await seed(600);
    project.write(NAME, spec({ delayMs: 10 }));
    const first = createQueue();
    const second = createQueue();
    await first.startWorker();
    await first.startBackgroundWorker();
    await second.startBackgroundWorker({ concurrency: 4 });
    const sampling = sampleLeases();
    await (await first.enqueueUp()).wait({ timeoutMs: 20_000 });
    // Both pods heal — the coordinator chain alive absorbs the second.
    await second.enqueueBackground();
    await reached(first, 'completed');
    await drained(first);
    sampling.on = false;
    await sampling.done;
    assert.ok(sampling.peak <= 2, `at most maxParallel leases, saw ${sampling.peak}`);
    assert.strictEqual(await migrated(), 600);
  });

  it('[background] should start a dependent background migration once the one it requires completes', async () => {
    await seed(100);
    await seed(100, 'customers');
    await harness.mongo().db.collection('customers').createIndex({ __v: 1, _id: 1 });
    project.write(NAME, spec());
    project.write(
      '0002-customers.js',
      `export const requires = ['${NAME}'];\n${spec({ collection: 'customers' })}`,
    );
    const mq = createQueue();
    await mq.startWorker();
    await mq.startBackgroundWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 20_000 });
    await reached(mq, 'completed');
    await reached(mq, 'completed', '0002-customers.js');
    await drained(mq);
    assert.strictEqual(await migrated('customers'), 100);
  });

  it('[background] should hold back a migration that requires a background one, then enqueue it from a sync tick', async () => {
    await seed(100);
    project.write(NAME, spec());
    project.write(
      '0002-contract.js',
      `export const requires = ['${NAME}'];\n${insertMigration('things', 'contract')}`,
    );
    const mq = createQueue();
    await mq.startWorker();
    await mq.startBackgroundWorker();
    const group = await mq.enqueueUp();
    assert.deepStrictEqual(group.migrations ?? group.jobs.map((job) => job.migration), [NAME]);
    assert.deepStrictEqual(group.waiting, { migration: '0002-contract.js', waitsFor: [NAME] });
    assert.strictEqual(group.upToDate, false);
    await group.wait({ timeoutMs: 20_000 });
    await assert.rejects(mq.enqueueUp('0002-contract.js'), BackgroundPendingError);
    await reached(mq, 'completed');
    await drained(mq);
    const sync = await mq.queue.add('sync', { v: 1, kind: 'sync' });
    await until('the contract migration', () =>
      harness.mongo().db.collection('things').findOne({ marker: 'contract' }),
    );
    const done = await until('the sync job', async () => {
      const view = await mq.getJob(String(sync.id));
      return view?.state === 'completed' ? view : undefined;
    });
    assert.deepStrictEqual(done.returnvalue.migrations, ['0002-contract.js']);
    assert.strictEqual(done.returnvalue.background.enqueued, 0);
  });

  it('[background] should reopen and finish again from a drift-watch tick', async () => {
    await seed(50);
    project.write(NAME, spec());
    const mq = createQueue();
    await mq.startWorker();
    await mq.startBackgroundWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 20_000 });
    await reached(mq, 'completed');
    await drained(mq);
    await harness.mongo().db.collection('orders').insertOne({ __v: 1, __rev: 0, late: true });
    const tick = await mq.backgroundQueue.add('background-verify', {
      v: 1,
      kind: 'background-verify',
    });
    await until('the late document', async () =>
      harness.mongo().db.collection('orders').findOne({ late: true, __v: 2 }),
    );
    const status = await reached(mq, 'completed');
    await drained(mq);
    assert.ok(status.pass >= 2);
    const verify = await mq.backgroundQueue.getJob(String(tick.id));
    assert.strictEqual(verify.returnvalue.drift[0].action, 'reopened');
    assert.ok(verify.returnvalue.enqueued >= 1);
  });

  it('[background] should hand a lane to another worker when its worker closes mid-slice', async () => {
    await seed(400);
    project.write(
      NAME,
      spec({ delayMs: 15, extra: 'maxParallel: 1,' }).replace('maxParallel: 2,', ''),
    );
    const first = createQueue();
    const second = createQueue();
    await first.startWorker();
    await first.startBackgroundWorker();
    await (await first.enqueueUp()).wait({ timeoutMs: 20_000 });
    await until('some progress', async () => (await migrated()) > 0);
    await first.close();
    const atClose = await migrated();
    assert.ok(atClose < 400, `closed midway: ${atClose}`);
    const leases = await harness
      .mongo()
      .db.collection(PARTITIONS)
      .countDocuments({ lease: { $exists: true } });
    assert.strictEqual(leases, 0, 'the lane released its lease at the batch boundary');
    await second.startBackgroundWorker();
    await reached(second, 'completed');
    await drained(second);
    assert.strictEqual(await migrated(), 400, 'every document migrated exactly once');
  });

  it('[background] should heal from MongoDB after the background queue is lost', async () => {
    await seed(400);
    project.write(NAME, spec({ delayMs: 15 }));
    const mq = createQueue();
    await mq.startWorker();
    await mq.startBackgroundWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 20_000 });
    await until('some progress', async () => (await migrated()) > 0);
    await harness.obliterate(mq.backgroundQueue);
    assert.notStrictEqual((await mq.backgroundStatus(NAME)).status, 'completed');
    const healed = await mq.enqueueBackground();
    assert.strictEqual(healed.jobs[0].migration, NAME);
    await reached(mq, 'completed');
    await drained(mq);
    assert.strictEqual(await migrated(), 400);
  });

  it('[background] should poll MongoDB instead of waiting for children with children: false', async () => {
    await seed(200);
    project.write(NAME, spec());
    const mq = createQueue({ background: { children: false } });
    await mq.startWorker();
    await mq.startBackgroundWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 20_000 });
    await reached(mq, 'completed');
    await drained(mq);
    assert.strictEqual(await migrated(), 200);
    assert.strictEqual((await mq.backgroundQueue.getJobCounts())['waiting-children'] ?? 0, 0);
  });

  it('[background] should host one drift-watcher leader across two workers, and hand it over on close', async () => {
    await seed(50);
    project.write(NAME, spec());
    const watch = { refreshMs: 200, leaderRetryMs: 100, checkpointMs: 50 };
    const first = createQueue({ background: { watch } });
    const second = createQueue({ background: { watch } });
    await first.startWorker();
    await first.startBackgroundWorker();
    await second.startBackgroundWorker();
    await (await first.enqueueUp()).wait({ timeoutMs: 20_000 });
    await reached(first, 'completed');
    await drained(first);
    const roles = (mq) => mq.backgroundWatcher.status()[0]?.state;
    await until('one leader and one follower', () => {
      const states = [roles(first), roles(second)].sort();
      return states[0] === 'following' && states[1] === 'streaming';
    });
    const [leader, follower] = roles(first) === 'streaming' ? [first, second] : [second, first];
    await leader.close();
    await until('the handover', () => roles(follower) === 'streaming');
    const { insertedId } = await harness
      .mongo()
      .db.collection('orders')
      .insertOne({ __v: 1, __rev: 0, late: true });
    await until('the upgrade', () =>
      harness.mongo().db.collection('orders').findOne({ _id: insertedId, __v: 2 }),
    );
    await drained(follower);
  });

  if (!harness.fake) return;

  // ─── What only the fake can stage ──────────────────────────────────────────

  it('[background, fake] should fall back to polling on a BullMQ without parents', async () => {
    const { fakeBullmq } = require('./fake-bullmq.js');
    await seed(100);
    project.write(NAME, spec());
    const mq = createQueue({ bullmq: fakeBullmq({ flows: false }) });
    await mq.startWorker();
    await mq.startBackgroundWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 20_000 });
    await reached(mq, 'completed');
    await drained(mq);
    assert.strictEqual(await migrated(), 100);
  });

  it('[background, fake] should take over from a coordinator stranded waiting for lanes that are gone', async () => {
    await seed(400);
    project.write(NAME, spec({ delayMs: 15 }));
    const mq = createQueue({ background: { stallMs: 1000 } });
    await mq.startWorker();
    await mq.startBackgroundWorker();
    const { results } = await (await mq.enqueueUp()).wait({ timeoutMs: 20_000 });
    const stranded = results[0].background[0].jobId;
    await until('some progress', async () => (await migrated()) > 0);
    // A partial loss: every lane job disappears, and nothing will ever wake
    // their coordinator. The worker is paused first, so each lane ends its
    // slice and moves to delayed — where it can be removed.
    const worker = mq.backgroundWorker;
    await worker.pause();
    const lanes = async () => {
      const open = [];
      for (const job of await mq.backgroundQueue.getJobs()) {
        if (job.name !== 'background-lane') continue;
        const state = await job.getState();
        if (state !== 'completed' && state !== 'failed') open.push([job, state]);
      }
      return open;
    };
    await until('no lane active', async () => (await lanes()).every(([, s]) => s !== 'active'));
    for (const [job] of await lanes()) await job.remove();
    worker.resume();
    assert.strictEqual(
      await (await mq.backgroundQueue.getJob(stranded)).getState(),
      'waiting-children',
    );
    const left = await migrated();
    assert.ok(left < 400, `stranded midway: ${left}`);
    // Nothing moves for stallMs; then any heal adds a takeover.
    await sleep(1200);
    const healed = await mq.enqueueBackground();
    assert.ok(healed.jobs.some((job) => job.takeover));
    const status = await reached(mq, 'completed');
    assert.ok(status.coordinator.round >= 2, 'the takeover took a newer round');
    await (await mq.backgroundQueue.getJob(stranded)).remove();
    await drained(mq);
    assert.strictEqual(await migrated(), 400);
  });
}

module.exports = { defineBullMQBackgroundScenarios };
