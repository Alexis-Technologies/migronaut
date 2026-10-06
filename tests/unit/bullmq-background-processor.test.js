const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const {
  createBackgroundProcessor,
  resolveBackgroundProcessorOptions,
} = require('../../src/bullmq/background-processor.js');
const {
  ConfigInvalidError,
  LockLostError,
  QueueJobInvalidError,
} = require('../../src/errors/index.js');
const { stubKit } = require('../helpers/stub-kit.js');

const NAME = '0001-orders.js';

/**
 * A coordinator step's answer as the kit gives it: the round it hands a new
 * chain (the one after the last, 4), or the chain's own; and, to process, the
 * registration the lanes are named after.
 */
const answering = (answer) =>
  mock.fn(async (_name, { driver }) => ({
    ...answer,
    ...(answer.next === 'process' ? { registration: 'reg-1' } : {}),
    ...(answer.next === 'superseded' || answer.status === 'unregistered'
      ? {}
      : { round: driver.round ?? 5 }),
  }));

/** A kit whose background methods answer what each test scripts */
function backgroundKit(overrides = {}) {
  return stubKit({
    backgroundStatus: mock.fn(async () => ({
      migration: NAME,
      status: 'running',
      registration: 'reg-1',
      liveLeases: 0,
      coordinator: { kind: 'bullmq', round: 4, at: new Date() },
    })),
    coordinateBackground: answering({ next: 'done', status: 'completed' }),
    runBackgroundSlice: mock.fn(async () => ({ outcome: 'exhausted', counters: { migrated: 3 } })),
    runnableBackground: mock.fn(async () => []),
    verifyBackground: mock.fn(async () => ({ checked: 2, skipped: 0, drift: [] })),
    ...overrides,
  });
}

function fakeQueue({ qualifiedName = 'bull:migronaut-background' } = {}) {
  const added = [];
  return {
    added,
    qualifiedName,
    addBulk: mock.fn(async (specs) => {
      added.push(...specs);
      return specs.map((spec, index) => ({
        id: spec.opts?.jobId ?? `job-${added.length + index}`,
      }));
    }),
  };
}

/** A job as a Worker hands it over — with the moves a background job makes */
function fakeJob(name, data, { waits = [], attempts } = {}) {
  const job = {
    id: '42',
    name,
    data: { v: 1, kind: name, ...data },
    opts: attempts !== undefined ? { attempts } : {},
    logs: [],
    delayedUntil: undefined,
    log: mock.fn(async (row) => job.logs.push(row)),
    updateData: mock.fn(async (next) => {
      job.data = next;
    }),
    moveToDelayed: mock.fn(async (timestamp) => {
      job.delayedUntil = timestamp;
    }),
    moveToWaitingChildren: mock.fn(async () => waits.shift() ?? false),
  };
  return job;
}

const coordinatorJob = (data = {}, options) =>
  fakeJob('background', { migration: NAME, ...data }, options);
const laneJob = (data = {}) =>
  fakeJob('background-lane', {
    migration: NAME,
    registration: 'reg-1',
    generation: 1,
    round: 1,
    spawn: 1,
    lane: 0,
    ...data,
  });

/** Run the processor and return what it threw — a move is thrown, by name */
async function moved(processor, job, token = 'token') {
  try {
    await processor(job, token);
  } catch (error) {
    return error;
  }
  assert.fail('expected the job to be moved');
}

describe('createBackgroundProcessor options', () => {
  const queue = fakeQueue();
  for (const [what, options, pattern] of [
    ['a non-object', 1, /must be an object/],
    ['kit and config', { kit: backgroundKit(), config: {}, queue }, /either `kit` or `config`/],
    ['a kit without background methods', { kit: {}, queue }, /MigratorKit/],
    ['no queue', { kit: backgroundKit() }, /queue is required/],
    ['an unknown option (a typo)', { kit: backgroundKit(), queue, stalMs: 5000 }, /"stalMs"/],
    [
      'a slice past the kit maximum',
      { kit: backgroundKit(), queue, sliceMs: 3_600_001 },
      /sliceMs/,
    ],
    ['a zero sliceMs', { queue, sliceMs: 0 }, /sliceMs/],
    ['an unknown children mode', { queue, children: true }, /children/],
    ['a tiny poll interval', { queue, pollIntervalMs: 1 }, /pollIntervalMs/],
    ['a tiny stallMs', { queue, stallMs: 10 }, /stallMs/],
    ['too many lane retries', { queue, maxLaneRetries: 101 }, /maxLaneRetries/],
    ['a parent in jobOptions', { queue, jobOptions: { parent: {} } }, /parent/],
    [
      'a child-failure policy in jobOptions',
      { queue, jobOptions: { continueParentOnFailure: true } },
      /continueParentOnFailure/,
    ],
  ]) {
    it(`should refuse ${what}`, () => {
      assert.throws(
        () => resolveBackgroundProcessorOptions(options),
        (error) => {
          assert.ok(error instanceof ConfigInvalidError);
          assert.match(error.message, pattern);
          return true;
        },
      );
    });
  }

  it('should declare three parameters and build its own kit from config', async () => {
    const processor = createBackgroundProcessor({
      config: { uri: 'mongodb://127.0.0.1:1/never', dbName: 'never', logger: null },
      queue: fakeQueue(),
    });
    assert.strictEqual(processor.length, 3);
    assert.strictEqual(typeof processor.kit.coordinateBackground, 'function');
    await processor.close();
  });
});

describe('background coordinator jobs', () => {
  it('should finish an unregistered background migration at once', async () => {
    const kit = backgroundKit({
      coordinateBackground: answering({ next: 'done', status: 'unregistered' }),
    });
    const processor = createBackgroundProcessor({ kit, queue: fakeQueue() });
    assert.deepStrictEqual(await processor(coordinatorJob(), 'token'), {
      kind: 'background',
      migration: NAME,
      status: 'unregistered',
    });
    assert.strictEqual(kit.coordinateBackground.mock.callCount(), 1);
    assert.strictEqual(kit.backgroundStatus.mock.callCount(), 0, 'no status read per wake');
  });

  it('should take the round the kit hands out, drive as bullmq, and heal once completed', async () => {
    const queue = fakeQueue();
    const kit = backgroundKit({
      runnableBackground: mock.fn(async () => [
        { migration: '0002-next.js', status: 'pending', maxParallel: 1 },
      ]),
    });
    const processor = createBackgroundProcessor({ kit, queue });
    const result = await processor(coordinatorJob(), 'token');
    assert.deepStrictEqual(result, {
      kind: 'background',
      migration: NAME,
      status: 'completed',
      round: 5,
    });
    // A new chain asks without a round: only the kit, under its lock, hands one out.
    const [, options] = kit.coordinateBackground.mock.calls[0].arguments;
    assert.deepStrictEqual(options.driver, { kind: 'bullmq', ref: '42' });
    assert.strictEqual(queue.added[0].data.migration, '0002-next.js', 'the dependent is started');
  });

  it('should keep its own round, and finish when a newer one took over', async () => {
    const kit = backgroundKit({ coordinateBackground: answering({ next: 'superseded' }) });
    const processor = createBackgroundProcessor({ kit, queue: fakeQueue() });
    const result = await processor(coordinatorJob({ round: 2 }), 'token');
    assert.strictEqual(result.status, 'superseded');
    assert.strictEqual(result.round, 2);
  });

  it('should survive a heal that fails', async () => {
    const kit = backgroundKit({
      runnableBackground: mock.fn(async () => {
        throw new Error('mongo blip');
      }),
    });
    const warnings = [];
    kit.logger = { ...kit.logger, warn: (message) => warnings.push(message) };
    const processor = createBackgroundProcessor({ kit, queue: fakeQueue() });
    assert.strictEqual((await processor(coordinatorJob(), 'token')).status, 'completed');
    assert.match(warnings[0], /heal \(completed\) failed: mongo blip/);
  });

  it('should come back later when it must wait — moved with a token, reported without one', async () => {
    const kit = backgroundKit({
      coordinateBackground: answering({ next: 'wait', retryAfterMs: 700 }),
    });
    const processor = createBackgroundProcessor({ kit, queue: fakeQueue() });
    const outside = await processor(coordinatorJob(), undefined);
    assert.deepStrictEqual(outside, {
      kind: 'background',
      migration: NAME,
      status: 'wait',
      round: 5,
      retryAfterMs: 700,
    });
    const job = coordinatorJob();
    const before = Date.now();
    const error = await moved(processor, job);
    assert.strictEqual(error.name, 'DelayedError');
    assert.ok(job.delayedUntil >= before + 700);
    assert.strictEqual(job.data.round, 5, 'the round is kept for the next run');
  });

  it('should spawn its lanes as children and wait for them', async () => {
    const queue = fakeQueue();
    const kit = backgroundKit({
      coordinateBackground: answering({ next: 'process', lanes: 2, generation: 3 }),
    });
    const processor = createBackgroundProcessor({ kit, queue, jobOptions: { keepLogs: 5 } });
    const job = coordinatorJob({}, { waits: [true] });
    const error = await moved(processor, job);
    assert.strictEqual(error.name, 'WaitingChildrenError');
    assert.strictEqual(job.data.spawn, 1);
    assert.strictEqual(queue.added.length, 2);
    const [first, second] = queue.added;
    assert.deepStrictEqual(first.opts.parent, { id: '42', queue: 'bull:migronaut-background' });
    assert.strictEqual(first.opts.jobId, 'bgl-0001-orders.js-reg-1-g3-r5-s1-l0');
    assert.strictEqual(second.data.lane, 1);
    assert.strictEqual(first.opts.keepLogs, 5);
    assert.match(job.logs.at(-1), /2 lane\(s\) for generation 3/);
  });

  it('should look again in-process when its lanes are already done, then yield', async () => {
    const queue = fakeQueue();
    const kit = backgroundKit({
      coordinateBackground: answering({ next: 'process', lanes: 1, generation: 1 }),
    });
    const processor = createBackgroundProcessor({ kit, queue });
    const job = coordinatorJob();
    const error = await moved(processor, job);
    assert.strictEqual(error.name, 'DelayedError');
    assert.strictEqual(kit.coordinateBackground.mock.callCount(), 6);
    assert.strictEqual(queue.added.length, 5, 'one spawn per inline step, each with new ids');
    assert.strictEqual(new Set(queue.added.map((spec) => spec.opts.jobId)).size, 5);
  });

  it('should add lanes on their own and poll without children', async () => {
    for (const [what, options, queue] of [
      ['children: false', { children: false, pollIntervalMs: 250 }, fakeQueue()],
      [
        'a queue without qualifiedName',
        { pollIntervalMs: 250 },
        fakeQueue({ qualifiedName: null }),
      ],
    ]) {
      const kit = backgroundKit({
        coordinateBackground: answering({ next: 'process', lanes: 2, generation: 1 }),
      });
      const processor = createBackgroundProcessor({ kit, queue, ...options });
      const job = coordinatorJob();
      const before = Date.now();
      const error = await moved(processor, job);
      assert.strictEqual(error.name, 'DelayedError', what);
      assert.ok(job.delayedUntil >= before + 250, what);
      assert.strictEqual(queue.added[0].opts.parent, undefined, what);
      assert.deepStrictEqual(queue.added[0].opts.deduplication, {
        id: 'bgl-0001-orders.js-reg-1-g1-l0',
      });
      assert.strictEqual(job.moveToWaitingChildren.mock.callCount(), 0, what);
    }
  });

  it('should wait out a round with nothing to spawn', async () => {
    const queue = fakeQueue();
    const kit = backgroundKit({
      coordinateBackground: mock.fn(async () => ({
        next: 'process',
        lanes: 0,
        generation: 1,
        retryAfterMs: 300,
      })),
    });
    const processor = createBackgroundProcessor({ kit, queue });
    const job = coordinatorJob();
    const before = Date.now();
    assert.strictEqual((await moved(processor, job)).name, 'DelayedError');
    assert.ok(job.delayedUntil >= before + 300);
    assert.strictEqual(queue.added.length, 0);
  });

  it('should rename a failure no retry fixes when the job has attempts, and redact it', async () => {
    const kit = backgroundKit({
      coordinateBackground: mock.fn(async () => {
        throw new Error('cannot reach mongodb://admin:hunter2@db:27017');
      }),
    });
    const processor = createBackgroundProcessor({ kit, queue: fakeQueue() });
    const unknown = await moved(processor, coordinatorJob({}, { attempts: 3 }));
    assert.strictEqual(unknown.name, 'Error', 'an unknown failure stays retryable');
    assert.ok(!unknown.message.includes('hunter2'));
    const invalid = await moved(
      processor,
      coordinatorJob({ migration: '../x.js' }, { attempts: 3 }),
    );
    assert.ok(invalid instanceof QueueJobInvalidError);
    assert.strictEqual(invalid.name, 'UnrecoverableError');
  });
});

describe('background lane jobs', () => {
  it('should continue itself between slices, resetting its retries', async () => {
    const kit = backgroundKit({
      runBackgroundSlice: mock.fn(async () => ({ outcome: 'yielded', counters: {} })),
    });
    const processor = createBackgroundProcessor({ kit, queue: fakeQueue(), sliceMs: 50 });
    const job = laneJob({ retry: 2 });
    assert.strictEqual((await moved(processor, job)).name, 'DelayedError');
    assert.strictEqual(job.data.retry, 0);
    assert.strictEqual(kit.runBackgroundSlice.mock.calls[0].arguments[1].sliceMs, 50);
    const fresh = laneJob();
    await moved(processor, fresh);
    assert.strictEqual(fresh.updateData.mock.callCount(), 0, 'nothing to reset');
  });

  it('should back off while every slot is held', async () => {
    const kit = backgroundKit({
      runBackgroundSlice: mock.fn(async () => ({ outcome: 'busy', retryAfterMs: 900 })),
    });
    const processor = createBackgroundProcessor({ kit, queue: fakeQueue() });
    const job = laneJob();
    const before = Date.now();
    await moved(processor, job);
    assert.ok(job.delayedUntil >= before + 900);
  });

  it('should finish once nothing is left to claim', async () => {
    const processor = createBackgroundProcessor({ kit: backgroundKit(), queue: fakeQueue() });
    assert.deepStrictEqual(await processor(laneJob(), 'token'), {
      kind: 'background-lane',
      migration: NAME,
      outcome: 'exhausted',
      counters: { migrated: 3 },
    });
  });

  it('should back off after a failed slice, then give up after maxLaneRetries', async () => {
    const kit = backgroundKit({
      runBackgroundSlice: mock.fn(async () => {
        throw new LockLostError('lease lost', {});
      }),
    });
    const processor = createBackgroundProcessor({ kit, queue: fakeQueue(), maxLaneRetries: 2 });
    const job = laneJob({ retry: 1 });
    const before = Date.now();
    assert.strictEqual((await moved(processor, job)).name, 'DelayedError');
    assert.strictEqual(job.data.retry, 2);
    assert.ok(job.delayedUntil >= before + 2000, 'the backoff doubles');
    const last = laneJob({ retry: 2 });
    assert.deepStrictEqual(await processor(last, 'token'), {
      kind: 'background-lane',
      migration: NAME,
      outcome: 'gave-up',
      code: 'LOCK_LOST',
    });
    assert.match(last.logs.at(-1), /gave up after 2 retries/);
  });

  it('should go back to the queue on shutdown — before it starts, or once its slice stops', async () => {
    let stopNow;
    const kit = backgroundKit({
      runBackgroundSlice: mock.fn(
        () =>
          new Promise((resolve, reject) => {
            stopNow = () => reject(new Error('interrupted'));
          }),
      ),
    });
    const processor = createBackgroundProcessor({ kit, queue: fakeQueue() });
    const running = moved(processor, laneJob());
    await new Promise((resolve) => setImmediate(resolve));
    processor.shutdown();
    stopNow();
    assert.strictEqual((await running).name, 'DelayedError');
    for (const job of [laneJob(), coordinatorJob(), fakeJob('background-verify', {})]) {
      assert.strictEqual((await moved(processor, job)).name, 'DelayedError');
    }
    assert.strictEqual(kit.runBackgroundSlice.mock.callCount(), 1);
    await processor.close();
  });

  it('should bow a coordinator out when the shutdown comes between its steps', async () => {
    const processor = createBackgroundProcessor({ kit: backgroundKit(), queue: fakeQueue() });
    const kit = processor.kit;
    kit.coordinateBackground.mock.mockImplementation(async () => {
      processor.shutdown();
      return { next: 'process', lanes: 1, generation: 1, registration: 'reg-1', round: 5 };
    });
    const job = coordinatorJob();
    assert.strictEqual((await moved(processor, job)).name, 'DelayedError');
    assert.strictEqual(kit.coordinateBackground.mock.callCount(), 1);
  });
});

describe('background verify jobs', () => {
  it('should run the drift watch and heal', async () => {
    const queue = fakeQueue();
    const kit = backgroundKit({
      verifyBackground: mock.fn(async () => ({
        checked: 1,
        skipped: 0,
        drift: [{ migration: NAME, collection: 'orders', action: 'reopened' }],
      })),
      runnableBackground: mock.fn(async () => [
        { migration: NAME, status: 'running', maxParallel: 1 },
      ]),
    });
    const processor = createBackgroundProcessor({ kit, queue });
    const result = await processor(fakeJob('background-verify', {}), 'token');
    assert.strictEqual(result.kind, 'background-verify');
    assert.strictEqual(result.drift[0].action, 'reopened');
    assert.strictEqual(result.enqueued, 1);
    assert.deepStrictEqual((await processor.heal()).jobs.length, 1);
  });
});
