const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { createMigrationQueue } = require('../../src/bullmq/service.js');
const { ConfigInvalidError } = require('../../src/errors/index.js');
const { FakeQueue, createFakeConnection, fakeBullmq } = require('../helpers/fake-bullmq.js');
const { stubKit } = require('../helpers/stub-kit.js');

const NAME = '0001-orders.js';

function backgroundKit(overrides = {}) {
  return stubKit({
    driftMode: mock.fn(async () => 'poll'),
    watchBackground: mock.fn(async () => ({
      running: true,
      status: () => [],
      stop: mock.fn(async () => {}),
    })),
    backgroundStatus: mock.fn(async () => null),
    coordinateBackground: mock.fn(async () => ({ next: 'done', status: 'completed' })),
    runBackgroundSlice: mock.fn(async () => ({ outcome: 'exhausted', counters: {} })),
    runnableBackground: mock.fn(async () => []),
    verifyBackground: mock.fn(async () => ({ checked: 0, skipped: 0, drift: [] })),
    ...overrides,
  });
}

function make(overrides = {}) {
  const connection = createFakeConnection();
  const kit = overrides.kit ?? backgroundKit();
  const mq = createMigrationQueue({
    bullmq: fakeBullmq(),
    connection,
    kit,
    background: true,
    ...overrides,
  });
  return { mq, kit, connection };
}

describe('createMigrationQueue background option', () => {
  for (const [what, background, pattern, bullmq, extra = {}] of [
    ['a string', 'yes', /true or an object/],
    ['an unknown key', { concurrency: 2 }, /background\.concurrency is not a known option/],
    ['a queue that is not one', { queue: {} }, /background\.queue must be a Queue instance/],
    ['the migration queue name', { queueName: 'migronaut' }, /must differ/],
    ['a colon in the name', { queueName: 'a:b' }, /background\.queueName/],
    ['non-object worker options', { workerOptions: 1 }, /workerOptions must be an object/],
    ['a zero concurrency', { workerOptions: { concurrency: 0 } }, /positive integer/],
    ['a tiny verify interval', { verifyIntervalMs: 5 }, /verifyIntervalMs/],
    ['a bad processor option', { children: 'never' }, /children/],
    ['a bad job option', { jobOptions: { parent: {} } }, /jobOptions\.parent/],
    [
      'an injected queue on another name than queueName',
      {
        queueName: 'bg',
        queue: new FakeQueue('elsewhere', { connection: createFakeConnection() }),
      },
      /background\.queue is on queue "elsewhere", not "bg"/,
    ],
    [
      'an injected queue on another prefix',
      {
        queue: new FakeQueue('elsewhere', { connection: createFakeConnection(), prefix: 'other' }),
      },
      /background\.queue uses prefix "other", not "mine"/,
      () => ({ ...fakeBullmq() }),
      { prefix: 'mine' },
    ],
    [
      'a Queue instance with no background queue',
      true,
      /bullmq\.Queue as a class/,
      () => {
        const queue = new FakeQueue('migronaut', { connection: createFakeConnection() });
        return { Queue: queue };
      },
    ],
  ]) {
    it(`should refuse ${what}`, () => {
      assert.throws(
        () =>
          createMigrationQueue({
            bullmq: bullmq ? bullmq() : fakeBullmq(),
            connection: createFakeConnection(),
            kit: backgroundKit(),
            background,
            ...extra,
          }),
        (error) => {
          assert.ok(error instanceof ConfigInvalidError);
          assert.match(error.message, pattern);
          return true;
        },
      );
    });
  }

  it('should build `<queueName>-background` with its processor, or use an injected queue', async () => {
    const { mq } = make({ queueName: 'jobs' });
    assert.ok(mq.backgroundQueue instanceof FakeQueue);
    assert.strictEqual(mq.backgroundQueue.name, 'jobs-background');
    assert.strictEqual(typeof mq.backgroundProcessor, 'function');
    assert.strictEqual(mq.backgroundWorker, undefined);
    await mq.close();
    assert.strictEqual(mq.backgroundQueue.closed, true, 'a queue it built, it closes');

    const connection = createFakeConnection();
    const injected = new FakeQueue('elsewhere', { connection });
    const own = make({ connection, background: { queue: injected } }).mq;
    assert.strictEqual(own.backgroundQueue, injected);
    await own.close();
    assert.strictEqual(injected.closed, false, 'an injected queue stays open');
  });

  it('should have no background side by default, and say so when asked for one', async () => {
    const { mq } = make({ background: undefined });
    assert.strictEqual(mq.backgroundQueue, undefined);
    assert.strictEqual(mq.backgroundProcessor, undefined);
    await assert.rejects(mq.enqueueBackground(), /needs the background queue/);
    await assert.rejects(mq.startBackgroundWorker(), /needs the background queue/);
    await assert.rejects(
      mq.schedule({ job: 'background-verify', every: 60_000 }),
      /needs the background queue/,
    );
    assert.deepStrictEqual(await mq.verifyBackground(), { checked: 0, skipped: 0, drift: [] });
    await mq.close();
  });

  it('should start the background worker once: schedule the drift watch, heal', async () => {
    const kit = backgroundKit({
      runnableBackground: mock.fn(async () => [
        { migration: NAME, status: 'pending', maxParallel: 1 },
      ]),
    });
    const { mq } = make({ kit, background: { verifyIntervalMs: 120_000 } });
    const worker = await mq.startBackgroundWorker({ autorun: false });
    assert.strictEqual(await mq.startBackgroundWorker(), worker);
    assert.strictEqual(mq.backgroundWorker, worker);
    assert.strictEqual(worker.concurrency, 2);
    assert.strictEqual(worker.name, 'migronaut-background');
    const [scheduler] = await mq.backgroundQueue.getJobSchedulers();
    assert.strictEqual(scheduler.id, 'migronaut-background-verify');
    assert.deepStrictEqual(scheduler.repeat, { every: 120_000 });
    const job = await mq.backgroundQueue.getJob(mq.backgroundQueue._state().wait[0]);
    assert.strictEqual(job.name, 'background');
    assert.strictEqual(job.data.migration, NAME);
    await mq.close();
    assert.strictEqual(worker.closed, true);
  });

  it('should keep a drift-watch schedule set with schedule(), unless an interval is given', async () => {
    const { mq } = make();
    await mq.schedule({ job: 'background-verify', pattern: '0 3 * * *' });
    await mq.startBackgroundWorker({ autorun: false });
    const [kept] = await mq.backgroundQueue.getJobSchedulers();
    assert.deepStrictEqual(kept.repeat, { pattern: '0 3 * * *' });
    await mq.close();

    const connection = createFakeConnection();
    const first = createMigrationQueue({
      bullmq: fakeBullmq(),
      connection,
      kit: backgroundKit(),
      background: true,
    });
    await first.schedule({ job: 'background-verify', pattern: '0 3 * * *' });
    await first.close();
    const second = createMigrationQueue({
      bullmq: fakeBullmq(),
      connection,
      kit: backgroundKit(),
      background: { verifyIntervalMs: 60_000, maxLaneRetries: 2 },
    });
    await second.startBackgroundWorker({ autorun: false });
    const [replaced] = await second.backgroundQueue.getJobSchedulers();
    assert.deepStrictEqual(replaced.repeat, { every: 60_000 }, 'said explicitly, it wins');
    await second.close();
  });

  it('should refuse a background worker it cannot build', async () => {
    const { mq } = make({ bullmq: { Queue: fakeBullmq().Queue } });
    await assert.rejects(mq.startBackgroundWorker(), /needs the Worker class/);
    await assert.rejects(mq.startBackgroundWorker(1), /must be an object/);
    await assert.rejects(mq.startBackgroundWorker({ concurrency: 0 }), /positive integer/);
    await assert.rejects(mq.enqueueBackground(NAME, 1), /must be an object/);
    await mq.close();
  });

  it('should register no drift-watch schedule with verifyIntervalMs: false, and retry a failed start', async () => {
    let failures = 1;
    const kit = backgroundKit({
      connect: mock.fn(async () => {
        if (failures-- > 0) throw new Error('mongo down');
      }),
    });
    const { mq } = make({ kit, background: { verifyIntervalMs: false } });
    await assert.rejects(mq.startBackgroundWorker(), /mongo down/);
    await mq.startBackgroundWorker({ autorun: false, concurrency: 3 });
    assert.strictEqual(mq.backgroundWorker.concurrency, 3);
    assert.deepStrictEqual(await mq.backgroundQueue.getJobSchedulers(), []);
    await mq.close();
  });

  it('should schedule and unschedule the drift watch on the background queue', async () => {
    const { mq } = make();
    await mq.schedule({ job: 'background-verify', pattern: '0 3 * * *' });
    const [scheduler] = await mq.backgroundQueue.getJobSchedulers();
    assert.strictEqual(scheduler.id, 'migronaut-background-verify');
    assert.strictEqual(scheduler.template.name, 'background-verify');
    await assert.rejects(
      mq.schedule({ job: 'background-verify', every: 60_000, to: 'a.js' }),
      /to only applies to a sync schedule/,
    );
    assert.strictEqual(await mq.unschedule('migronaut-background-verify'), true);
    assert.deepStrictEqual(await mq.backgroundQueue.getJobSchedulers(), []);
    assert.strictEqual(await mq.unschedule('migronaut-background-verify'), false);
    await mq.close();
  });

  it('should enqueue coordinators — one, or every runnable one — and after a reopening watch', async () => {
    const kit = backgroundKit({
      backgroundStatus: mock.fn(async (name) =>
        name === NAME ? { migration: NAME, status: 'pending' } : null,
      ),
      runnableBackground: mock.fn(async () => [
        { migration: NAME, status: 'pending', maxParallel: 1 },
      ]),
      verifyBackground: mock.fn(async () => ({
        checked: 1,
        skipped: 0,
        drift: [{ migration: NAME, collection: 'orders', action: 'reopened' }],
      })),
    });
    const { mq } = make({ kit });
    const one = await mq.enqueueBackground(NAME, { requestedBy: 'ops' });
    assert.strictEqual(one.jobs[0].migration, NAME);
    const stored = await mq.backgroundQueue.getJob(one.jobs[0].id);
    assert.strictEqual(stored.data.requestedBy, 'ops');
    await assert.rejects(mq.enqueueBackground('0009-none.js'), /not registered/);
    // The coordinator alive absorbs both of these.
    assert.strictEqual((await mq.enqueueBackground()).jobs[0].id, one.jobs[0].id);
    await mq.verifyBackground();
    assert.strictEqual(mq.backgroundQueue._state().wait.length, 1);
    assert.deepStrictEqual(await mq.backgroundStatus(NAME), { migration: NAME, status: 'pending' });
    await mq.close();
  });
});

describe('createMigrationQueue background watcher', () => {
  it('should refuse a watch option that is neither a boolean nor options', () => {
    assert.throws(
      () =>
        createMigrationQueue({
          bullmq: fakeBullmq(),
          connection: createFakeConnection(),
          kit: backgroundKit(),
          background: { watch: 'yes' },
        }),
      /background\.watch must be a boolean or the watcher options/,
    );
  });

  it('should host a watcher when told to — or when drift is streamed — and stop it first on close', async () => {
    const told = make({ background: { watch: { refreshMs: 1000 }, verifyIntervalMs: false } });
    await told.mq.startBackgroundWorker({ autorun: false });
    const [options] = told.kit.watchBackground.mock.calls[0].arguments;
    assert.strictEqual(options.refreshMs, 1000);
    assert.strictEqual(typeof options.onError, 'function');
    const watcher = told.mq.backgroundWatcher;
    assert.ok(watcher);
    await told.mq.close();
    assert.strictEqual(watcher.stop.mock.callCount(), 1);

    const streamed = make({
      kit: backgroundKit({ driftMode: mock.fn(async () => 'both') }),
      background: { verifyIntervalMs: false },
    });
    await streamed.mq.startBackgroundWorker({ autorun: false });
    assert.strictEqual(streamed.kit.watchBackground.mock.callCount(), 1);
    await streamed.mq.close();

    const polled = make({ background: { verifyIntervalMs: false } });
    await polled.mq.startBackgroundWorker({ autorun: false });
    assert.strictEqual(polled.kit.watchBackground.mock.callCount(), 0);
    assert.strictEqual(polled.mq.backgroundWatcher, undefined);
    await polled.mq.close();
  });

  it('should start the worker anyway when the watcher cannot start, and say so', async () => {
    const kit = backgroundKit({
      watchBackground: mock.fn(async () => {
        throw new Error('no change streams here');
      }),
    });
    const warnings = [];
    kit.logger = { ...kit.logger, warn: (message) => warnings.push(message) };
    const { mq } = make({ kit, background: { watch: true, verifyIntervalMs: false } });
    const worker = await mq.startBackgroundWorker({ autorun: false });
    assert.ok(worker);
    assert.strictEqual(mq.backgroundWatcher, undefined);
    assert.match(warnings[0], /live drift watcher did not start: no change streams here/);
    await mq.close();
  });
});
