const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { MigrationQueue, createMigrationQueue } = require('../../src/bullmq/service.js');
const { MigratorKit } = require('../../src/core/migrator.js');
const { ConfigInvalidError, MigrationBlockedError } = require('../../src/errors/index.js');
const {
  FakeQueue,
  FakeQueueEvents,
  FakeWorker,
  createFakeConnection,
  fakeBullmq,
} = require('../helpers/fake-bullmq.js');
const { stubKit } = require('../helpers/stub-kit.js');

/** A connection token that would notice being closed — the adapter never owns it */
function spiedConnection() {
  const connection = createFakeConnection();
  connection.quit = mock.fn();
  connection.disconnect = mock.fn();
  connection.close = mock.fn();
  return connection;
}

function make(overrides = {}) {
  const connection = overrides.connection ?? spiedConnection();
  const kit = overrides.kit ?? stubKit();
  const mq = createMigrationQueue({ bullmq: fakeBullmq(), connection, kit, ...overrides });
  return { mq, kit, connection };
}

/** Capture what the kit's logger is told */
function recordingLogger(kit) {
  const lines = [];
  const record = (level) => (msg, fields) => lines.push({ level, msg, fields });
  kit.logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  return lines;
}

const pendingRows = (...files) =>
  files.map((file) => ({ file, status: 'pending', appliedAt: null }));

describe('createMigrationQueue', () => {
  it('should return a MigrationQueue wired to the injected classes', async () => {
    const { mq, kit, connection } = make();
    assert.ok(mq instanceof MigrationQueue);
    assert.ok(mq.queue instanceof FakeQueue);
    assert.strictEqual(mq.kit, kit);
    assert.strictEqual(mq.queueName, 'migronaut');
    assert.strictEqual(mq.worker, undefined);
    assert.strictEqual(mq.queueEvents, undefined);
    assert.strictEqual(typeof mq.processor, 'function');
    assert.strictEqual(mq.processor.kit, kit);
    assert.deepStrictEqual(mq.queue.opts, { connection });
    await mq.close();
  });

  it('should build its own kit from config', async () => {
    const mq = createMigrationQueue({
      bullmq: fakeBullmq(),
      connection: createFakeConnection(),
      config: { uri: 'mongodb://127.0.0.1:1/never', dbName: 'never', logger: null },
      kitOptions: { cwd: '/tmp' },
    });
    assert.ok(mq.kit instanceof MigratorKit);
    const disconnect = mock.method(mq.kit, 'disconnect', async () => {});
    await mq.close();
    assert.strictEqual(disconnect.mock.callCount(), 1, 'a kit it created is its to disconnect');
  });

  it('should fall back to an empty config, resolved from the environment later', async () => {
    const mq = createMigrationQueue({ bullmq: fakeBullmq(), connection: createFakeConnection() });
    assert.ok(mq.kit instanceof MigratorKit);
    mock.method(mq.kit, 'disconnect', async () => {});
    await mq.close();
  });

  it('should pass queueName and prefix to everything it constructs', async () => {
    const { mq, connection } = make({ queueName: 'billing', prefix: 'app' });
    assert.strictEqual(mq.queue.name, 'billing');
    assert.deepStrictEqual(mq.queue.opts, { connection, prefix: 'app' });
    const worker = await mq.startWorker();
    assert.strictEqual(worker.name, 'billing');
    assert.strictEqual(worker.opts.prefix, 'app');
    await mq.close();
  });

  describe('bullmq.telemetry', () => {
    // BullMQ's own telemetry object. The fake does nothing with it, which is
    // all this needs: the adapter's job is to hand it over untouched.
    const telemetry = { tracer: {}, contextManager: {} };

    it('should hand it to the Queue and the Worker it constructs', async () => {
      const connection = spiedConnection();
      const { mq } = make({ connection, bullmq: { ...fakeBullmq(), telemetry } });
      assert.deepStrictEqual(mq.queue.opts, { connection, telemetry });
      assert.strictEqual(mq.queue.opts.telemetry, telemetry);
      const worker = await mq.startWorker();
      assert.strictEqual(worker.opts.telemetry, telemetry);
      await mq.close();
    });

    it('should leave QueueEvents without it — BullMQ takes none there', async () => {
      const kit = stubKit({
        dryRun: mock.fn(async () => pendingRows('0001-a.js')),
        nextBatch: mock.fn(async () => 2),
      });
      const { mq } = make({ kit, bullmq: { ...fakeBullmq(), telemetry } });
      const group = await mq.enqueueUp();
      await mq.startWorker();
      // Waiting is what builds it.
      await group.wait({ timeoutMs: 2000 });
      assert.ok(mq.queueEvents instanceof FakeQueueEvents);
      assert.ok(!('telemetry' in mq.queueEvents.opts));
      await mq.close();
    });

    it('should let the worker options, then startWorker, override it for the worker', async () => {
      const fromOptions = { name: 'workerOptions' };
      const first = make({
        bullmq: { ...fakeBullmq(), telemetry },
        workerOptions: { telemetry: fromOptions },
      });
      assert.strictEqual((await first.mq.startWorker()).opts.telemetry, fromOptions);
      assert.strictEqual(first.mq.queue.opts.telemetry, telemetry, 'the queue keeps its own');
      await first.mq.close();

      const fromCall = { name: 'startWorker' };
      const second = make({
        bullmq: { ...fakeBullmq(), telemetry },
        workerOptions: { telemetry: fromOptions },
      });
      assert.strictEqual(
        (await second.mq.startWorker({ telemetry: fromCall })).opts.telemetry,
        fromCall,
      );
      await second.mq.close();
    });

    it('should reach only the worker when the Queue is an injected instance', async () => {
      const connection = spiedConnection();
      const { Worker } = fakeBullmq();
      const queue = new FakeQueue('migronaut', { connection });
      const mq = createMigrationQueue({
        bullmq: { Queue: queue, Worker, telemetry },
        connection,
        kit: stubKit(),
      });
      assert.deepStrictEqual(
        queue.opts,
        { connection },
        'an instance keeps what it was built with',
      );
      assert.strictEqual((await mq.startWorker()).opts.telemetry, telemetry);
      await mq.close();
      await queue.close();
    });
  });

  describe('option validation — before anything is constructed', () => {
    const connection = createFakeConnection();
    const { Queue, Worker, QueueEvents } = fakeBullmq();
    const invalid = [
      ['no options', undefined],
      ['options that are not an object', 'nope'],
      ['no bullmq', { connection }],
      ['a bullmq that is not an object', { bullmq: 'bullmq', connection }],
      ['no Queue', { bullmq: { Worker }, connection }],
      ['a Queue that is neither a class nor a queue', { bullmq: { Queue: {} }, connection }],
      ['a Worker instance', { bullmq: { Queue, Worker: {} }, connection }],
      [
        'a QueueEvents that is neither class nor instance',
        { bullmq: { Queue, QueueEvents: {} }, connection },
      ],
      ['classes without a connection', { bullmq: { Queue } }],
      ['a null connection', { bullmq: { Queue }, connection: null }],
      ['an empty queueName', { bullmq: { Queue }, connection, queueName: '' }],
      ['a queueName with a colon', { bullmq: { Queue }, connection, queueName: 'a:b' }],
      ['a non-string queueName', { bullmq: { Queue }, connection, queueName: 5 }],
      ['a prefix with a colon', { bullmq: { Queue }, connection, prefix: 'a:b' }],
      ['job options that retry', { bullmq: { Queue }, connection, jobOptions: { attempts: 3 } }],
      [
        'job options with a backoff',
        { bullmq: { Queue }, connection, jobOptions: { backoff: 100 } },
      ],
      ['workerOptions that is not an object', { bullmq: { Queue }, connection, workerOptions: 2 }],
      ['a telemetry that is not an object', { bullmq: { Queue, telemetry: 'otel' }, connection }],
      ['a null telemetry', { bullmq: { Queue, telemetry: null }, connection }],
      [
        'a worker concurrency above 1',
        { bullmq: { Queue }, connection, workerOptions: { concurrency: 4 } },
      ],
      ['a non-boolean globalConcurrency', { bullmq: { Queue }, connection, globalConcurrency: 1 }],
      ['both kit and config', { bullmq: { Queue }, connection, kit: stubKit(), config: {} }],
      ['a kit that is not a kit', { bullmq: { Queue }, connection, kit: {} }],
      [
        'a bad lockWait budget',
        { bullmq: { Queue }, connection, lockWait: { lockWaitTimeoutMs: 0 } },
      ],
      [
        'an unknown onLockHeld',
        { bullmq: { Queue }, connection, lockWait: { onLockHeld: 'retry' } },
      ],
      [
        'an instance Queue with a Worker class but no connection',
        { bullmq: { Queue: new Queue('m', { connection }), Worker } },
      ],
      [
        'an instance Queue with a QueueEvents class but no connection',
        { bullmq: { Queue: new Queue('m', { connection }), QueueEvents } },
      ],
    ];

    for (const [label, options] of invalid) {
      it(`should reject ${label}`, () => {
        assert.throws(() => createMigrationQueue(options), ConfigInvalidError);
      });
    }

    it('should not have opened a queue when validation fails late', () => {
      // A Queue opens a Redis connection: constructing one and then throwing
      // would leak it, with nobody holding a reference to close.
      let constructed = 0;
      class CountingQueue extends FakeQueue {
        constructor(...args) {
          super(...args);
          constructed += 1;
        }
      }
      assert.throws(
        () =>
          createMigrationQueue({
            bullmq: { Queue: CountingQueue },
            connection,
            lockWait: { onLockHeld: 'retry' },
          }),
        ConfigInvalidError,
      );
      assert.strictEqual(constructed, 0);
    });
  });

  describe('injected instances', () => {
    it('should use a Queue instance as-is, take its name, and never close it', async () => {
      const connection = createFakeConnection();
      const queue = new FakeQueue('tenant-a', { connection });
      const mq = createMigrationQueue({ bullmq: { Queue: queue }, kit: stubKit() });
      assert.strictEqual(mq.queue, queue);
      assert.strictEqual(mq.queueName, 'tenant-a');
      await mq.close();
      assert.strictEqual(queue.closed, false);
    });

    it('should use a QueueEvents instance as-is and never close it', async () => {
      const connection = createFakeConnection();
      const queueEvents = new FakeQueueEvents('migronaut', { connection });
      const { mq } = make({ connection, bullmq: { ...fakeBullmq(), QueueEvents: queueEvents } });
      assert.strictEqual(mq.queueEvents, queueEvents);
      await mq.close();
      assert.strictEqual(queueEvents.closed, false);
    });

    it("should build its worker on an injected Queue's own prefix", async () => {
      const connection = createFakeConnection();
      const queue = new FakeQueue('tenant-a', { connection, prefix: 'acme' });
      const { Worker, QueueEvents } = fakeBullmq();
      const mq = createMigrationQueue({
        bullmq: { Queue: queue, Worker, QueueEvents },
        connection,
        kit: stubKit({ dryRun: mock.fn(async () => pendingRows('0001-a.js')) }),
      });
      const worker = await mq.startWorker();
      assert.strictEqual(worker.opts.prefix, 'acme');
      const { results } = await (await mq.enqueueUp()).wait({ timeoutMs: 5000 });
      assert.strictEqual(results[0].status, 'applied', 'the worker listened to the same keys');
      await mq.close();
    });

    it('should refuse an injected Queue or QueueEvents on another name or prefix', () => {
      const connection = createFakeConnection();
      const queue = new FakeQueue('tenant-a', { connection, prefix: 'acme' });
      const { Worker, QueueEvents } = fakeBullmq();
      const build = (options) =>
        createMigrationQueue({
          bullmq: { Queue: queue, Worker },
          connection,
          kit: stubKit(),
          ...options,
        });
      assert.throws(() => build({ queueName: 'tenant-b' }), /on queue "tenant-a", not "tenant-b"/);
      assert.throws(() => build({ prefix: 'other' }), /uses prefix "acme", not "other"/);
      assert.throws(
        () =>
          createMigrationQueue({
            bullmq: {
              Queue: queue,
              Worker,
              QueueEvents: new QueueEvents('tenant-b', { connection, prefix: 'acme' }),
            },
            connection,
            kit: stubKit(),
          }),
        /QueueEvents is on queue "tenant-b"/,
      );
    });

    it('should work with a bare queue object that is not an emitter', async () => {
      const queue = { name: 'bare', addBulk: async () => [], getJob: async () => undefined };
      const mq = createMigrationQueue({ bullmq: { Queue: queue }, kit: stubKit() });
      assert.strictEqual(mq.queueName, 'bare');
      await mq.close();
    });

    it('should never close the connection or an injected kit', async () => {
      const { mq, kit, connection } = make();
      await mq.startWorker();
      await mq.close();
      for (const method of ['quit', 'disconnect', 'close']) {
        assert.strictEqual(connection[method].mock.callCount(), 0, `connection.${method}`);
      }
      assert.strictEqual(kit.disconnect.mock.callCount(), 0);
      assert.strictEqual(kit.listenerCount('migration:start'), 0, 'but it detaches from the kit');
    });
  });

  describe('startWorker', () => {
    it('should start one single-concurrency worker on the shared processor', async () => {
      const { mq, connection } = make();
      const worker = await mq.startWorker();
      assert.ok(worker instanceof FakeWorker);
      assert.strictEqual(mq.worker, worker);
      assert.deepStrictEqual(worker.opts, {
        connection,
        lockDuration: 60_000,
        maxStalledCount: 1,
        concurrency: 1,
      });
      assert.strictEqual(await mq.queue.getGlobalConcurrency(), 1);
      await mq.close();
    });

    it('should resolve the same worker when called again, even concurrently', async () => {
      const { mq } = make();
      const [first, second] = await Promise.all([mq.startWorker(), mq.startWorker()]);
      assert.strictEqual(first, second);
      assert.strictEqual(await mq.startWorker(), first);
      await mq.close();
    });

    it('should layer workerOptions and per-call options, but never concurrency', async () => {
      const { mq } = make({
        workerOptions: { lockDuration: 120_000, stalledInterval: 5000, concurrency: 1 },
      });
      const worker = await mq.startWorker({ maxStalledCount: 0, concurrency: 1 });
      assert.strictEqual(worker.opts.lockDuration, 120_000);
      assert.strictEqual(worker.opts.stalledInterval, 5000);
      assert.strictEqual(worker.opts.maxStalledCount, 0);
      assert.strictEqual(worker.opts.concurrency, 1);
      await mq.close();
    });

    it('should refuse any concurrency other than 1', async () => {
      const { mq } = make();
      await assert.rejects(mq.startWorker({ concurrency: 2 }), ConfigInvalidError);
      await assert.rejects(mq.startWorker('fast'), ConfigInvalidError);
      await mq.close();
    });

    it('should need the Worker class', async () => {
      const { Queue } = fakeBullmq();
      const { mq } = make({ bullmq: { Queue } });
      await assert.rejects(mq.startWorker(), /needs the Worker class/);
      await mq.close();
    });

    it('should leave global concurrency alone when asked to', async () => {
      const { mq } = make({ globalConcurrency: false });
      await mq.startWorker();
      assert.strictEqual(await mq.queue.getGlobalConcurrency(), null);
      await mq.close();
    });

    it('should work on a BullMQ too old to have global concurrency or readiness', async () => {
      class OldQueue extends FakeQueue {}
      OldQueue.prototype.setGlobalConcurrency = undefined;
      class OldWorker extends FakeWorker {}
      OldWorker.prototype.waitUntilReady = undefined;
      const { mq } = make({ bullmq: { Queue: OldQueue, Worker: OldWorker } });
      assert.ok((await mq.startWorker()) instanceof OldWorker);
      await mq.close();
    });

    it('should route worker trouble to the logger instead of crashing the process', async () => {
      const { mq, kit } = make();
      const lines = recordingLogger(kit);
      const worker = await mq.startWorker();
      // Without a listener, an emitter's 'error' event is an uncaught exception.
      worker.emit('error', new Error('redis: mongodb://u:secret@h/db unreachable'));
      worker.emit(
        'failed',
        { id: 7, data: { groupId: 'g-1', migration: '0002-b.js', direction: 'up' } },
        new MigrationBlockedError('blocked', { runId: 'run-2' }),
      );
      worker.emit('failed', undefined, new Error('job vanished'));
      worker.emit('stalled', '7', 'active');

      assert.deepStrictEqual(
        lines.map((line) => line.level),
        ['error', 'warn', 'warn', 'warn'],
      );
      assert.ok(!lines[0].msg.includes('secret'));
      assert.deepStrictEqual(lines[1].fields, {
        queue: 'migronaut',
        jobId: '7',
        groupId: 'g-1',
        migration: '0002-b.js',
        direction: 'up',
        runId: 'run-2',
        code: 'MIGRATION_BLOCKED',
        error: 'blocked',
      });
      assert.deepStrictEqual(lines[2].fields, { queue: 'migronaut', error: 'job vanished' });
      assert.match(lines[3].msg, /stalled \(7\)/);
      await mq.close();
    });

    it('should route queue trouble to the logger too', async () => {
      const { mq, kit } = make();
      const lines = recordingLogger(kit);
      mq.queue.emit('error', new Error('connection lost'));
      assert.strictEqual(lines[0].level, 'error');
      assert.match(lines[0].msg, /queue error: connection lost/);
      await mq.close();
    });
  });

  describe('enqueue and read', () => {
    it('should enqueue pending migrations with the configured job options', async () => {
      const kit = stubKit({
        dryRun: mock.fn(async () => pendingRows('0001-a.js', '0002-b.js')),
        nextBatch: mock.fn(async () => 5),
      });
      const { mq } = make({ kit, jobOptions: { removeOnComplete: 25 } });
      const group = await mq.enqueueUp(undefined, { to: '0002-b.js' });
      assert.deepStrictEqual(kit.dryRun.mock.calls[0].arguments, [
        'up',
        undefined,
        { to: '0002-b.js' },
      ]);
      assert.strictEqual(group.batch, 5);
      assert.strictEqual(group.jobs.length, 2);
      const stored = await mq.queue.getJob(group.jobs[0].id);
      assert.strictEqual(stored.opts.removeOnComplete, 25);
      assert.strictEqual(stored.opts.attempts, 1);
      await mq.close();
    });

    it('should enqueue a single file and a rollback', async () => {
      const kit = stubKit({
        dryRun: mock.fn(async (direction, filename) => [
          {
            file: filename ?? '0001-a.js',
            status: direction === 'up' ? 'pending' : 'applied',
            appliedAt: new Date(1),
            batch: 1,
          },
        ]),
        list: mock.fn(async () => [
          { file: '0001-a.js', status: 'applied', appliedAt: new Date(1) },
        ]),
      });
      const { mq } = make({ kit, allow: { unordered: true } });
      const up = await mq.enqueueUp('0003-c.js', { ordered: false });
      assert.strictEqual(up.jobs[0].migration, '0003-c.js');
      const down = await mq.enqueueDown(undefined, { steps: 1 });
      assert.strictEqual(down.direction, 'down');
      assert.deepStrictEqual(kit.dryRun.mock.calls[1].arguments, ['down', undefined, { steps: 1 }]);
      await mq.close();
    });

    it("should refuse at enqueue what its own workers' policy would refuse", async () => {
      const { mq, kit } = make();
      await assert.rejects(mq.enqueueUp('0003-c.js', { force: true }), /allow\.force/);
      await assert.rejects(mq.enqueueUp('0003-c.js', { ordered: false }), /allow\.unordered/);
      await assert.rejects(mq.enqueueConverge({ ordered: false }), /allow\.unordered/);
      assert.strictEqual(kit.dryRun.mock.callCount(), 0, 'refused before planning');
      const strict = make({ allow: { down: false } });
      await assert.rejects(strict.mq.enqueueDown(), /allow\.down/);
      assert.throws(() => make({ allow: { everything: true } }), ConfigInvalidError);
      await mq.close();
      await strict.mq.close();
    });

    it('should read status straight from the kit', async () => {
      const lock = { lockedAt: new Date(), pid: 1, host: 'h', executedBy: 'u' };
      const kit = stubKit({
        status: mock.fn(async () => [{ file: 'a.js', status: 'applied' }]),
        list: mock.fn(async () => pendingRows('b.js')),
        lockInfo: mock.fn(async () => lock),
      });
      const { mq } = make({ kit });
      assert.deepStrictEqual(await mq.status(), [{ file: 'a.js', status: 'applied' }]);
      assert.deepStrictEqual(await mq.pending(), pendingRows('b.js'));
      assert.deepStrictEqual(kit.list.mock.calls[0].arguments, ['pending']);
      assert.strictEqual((await mq.audit()).ok, true);
      assert.strictEqual(await mq.lockInfo(), lock);
      await mq.close();
    });

    it('should pause and resume the queue', async () => {
      const { mq } = make();
      await mq.pause();
      assert.strictEqual(await mq.queue.isPaused(), true);
      await mq.resume();
      assert.strictEqual(await mq.queue.isPaused(), false);
      await mq.close();
    });

    it('should return a job as plain, redacted data', async () => {
      const { mq } = make();
      const added = await mq.queue.add('up', { v: 1, note: 'mongodb://u:secret@h/db' });
      const stored = await mq.queue.getJob(added.id);
      stored.failedReason = 'cannot reach mongodb://u:secret@h/db';
      stored.processedOn = 5;
      stored.finishedOn = 9;

      const view = await mq.getJob(added.id);
      assert.deepStrictEqual(Object.keys(view), [
        'id',
        'name',
        'data',
        'state',
        'progress',
        'failedReason',
        'attemptsMade',
        'timestamp',
        'processedOn',
        'finishedOn',
      ]);
      assert.strictEqual(view.state, 'waiting');
      assert.strictEqual(view.data.note, 'mongodb://u:****@h/db');
      assert.strictEqual(view.failedReason, 'cannot reach mongodb://u:****@h/db');
      assert.strictEqual(typeof view.log, 'undefined', 'no live Job methods leak out');

      stored.returnvalue = { status: 'applied' };
      assert.deepStrictEqual((await mq.getJob(added.id)).returnvalue, { status: 'applied' });
      await mq.close();
    });

    it('should resolve null for a job that does not exist, and reject a non-id', async () => {
      const { mq } = make();
      assert.strictEqual(await mq.getJob('404'), null);
      for (const id of ['', 5, undefined, { $ne: null }]) {
        await assert.rejects(mq.getJob(id), ConfigInvalidError);
      }
      await mq.close();
    });

    it('should never show a finished job without its outcome', async () => {
      // BullMQ reads a job and its state separately: here the job fails
      // between the two reads, so the first read has no failedReason yet.
      const reads = [
        { id: '1', name: 'up', data: {}, attemptsMade: 0 },
        { id: '1', name: 'up', data: {}, attemptsMade: 1, failedReason: 'boom' },
      ];
      let read = 0;
      const queue = {
        name: 'torn',
        addBulk: async () => [],
        getJob: async () => ({
          ...reads[Math.min(read++, reads.length - 1)],
          getState: async () => 'failed',
        }),
      };
      const mq = createMigrationQueue({ bullmq: { Queue: queue }, kit: stubKit() });
      const view = await mq.getJob('1');
      assert.deepStrictEqual(
        [view.state, view.failedReason, view.attemptsMade],
        ['failed', 'boom', 1],
      );
      await mq.close();
    });

    it('should describe a job from a queue with a thinner Job', async () => {
      const queue = {
        name: 'thin',
        addBulk: async () => [],
        getJob: async () => ({ id: 3, name: 'up', data: {} }),
      };
      const mq = createMigrationQueue({ bullmq: { Queue: queue }, kit: stubKit() });
      assert.deepStrictEqual(await mq.getJob('3'), {
        id: '3',
        name: 'up',
        data: {},
        state: 'unknown',
        progress: undefined,
        attemptsMade: 0,
      });
      await mq.close();
    });
  });

  describe('wait()', () => {
    const kitWithPending = () =>
      stubKit({
        dryRun: mock.fn(async () => pendingRows('0001-a.js')),
        nextBatch: mock.fn(async () => 2),
      });

    it('should build QueueEvents lazily from the class, and close it on close()', async () => {
      const { mq, connection } = make({ kit: kitWithPending(), prefix: 'app' });
      const group = await mq.enqueueUp();
      assert.strictEqual(mq.queueEvents, undefined, 'not built until someone waits');
      await mq.startWorker();
      const waited = await group.wait({ timeoutMs: 2000 });
      assert.strictEqual(waited.results[0].status, 'applied');
      const queueEvents = mq.queueEvents;
      assert.ok(queueEvents instanceof FakeQueueEvents);
      assert.deepStrictEqual(queueEvents.opts, { connection, prefix: 'app' });
      await group.wait();
      assert.strictEqual(mq.queueEvents, queueEvents, 'built once');
      await mq.close();
      assert.strictEqual(queueEvents.closed, true);
    });

    it('should reject when no QueueEvents was provided', async () => {
      const { Queue, Worker } = fakeBullmq();
      const { mq } = make({ kit: kitWithPending(), bullmq: { Queue, Worker } });
      const group = await mq.enqueueUp();
      await assert.rejects(group.wait(), /needs QueueEvents/);
      await mq.close();
    });

    it('should log trouble on the QueueEvents it built', async () => {
      const kit = kitWithPending();
      const { mq } = make({ kit });
      const group = await mq.enqueueUp();
      await mq.startWorker();
      await group.wait();
      const lines = recordingLogger(kit);
      mq.queueEvents.emit('error', new Error('stream closed'));
      assert.match(lines[0].msg, /queue events error: stream closed/);
      await mq.close();
    });
  });

  describe('schedule / unschedule', () => {
    it('should upsert a scheduler that replays the sync job', async () => {
      const { mq } = make();
      await mq.schedule({ every: 60_000 });
      await mq.schedule({ id: 'nightly', pattern: '0 3 * * *', tz: 'UTC', to: '0005-x.js' });
      const schedulers = await mq.queue.getJobSchedulers();
      assert.deepStrictEqual(schedulers[0], {
        id: 'migronaut-sync',
        repeat: { every: 60_000 },
        template: {
          name: 'sync',
          data: { v: 1, kind: 'sync' },
          opts: {
            removeOnComplete: { count: 100 },
            removeOnFail: { count: 500 },
            attempts: 1,
            telemetry: { omitContext: true },
          },
        },
        runs: 0,
      });
      assert.deepStrictEqual(schedulers[1].repeat, { pattern: '0 3 * * *', tz: 'UTC' });
      assert.strictEqual(schedulers[1].template.data.to, '0005-x.js');
      await mq.close();
    });

    it("should hand the queue's job options to every tick", async () => {
      const { mq } = make({ jobOptions: { removeOnComplete: 10, removeOnFail: 20 } });
      await mq.schedule({ every: 60_000 });
      await mq.schedule({ job: 'converge', every: 60_000 });
      for (const { template } of await mq.queue.getJobSchedulers()) {
        assert.strictEqual(template.opts.removeOnComplete, 10);
        assert.strictEqual(template.opts.removeOnFail, 20);
      }
      await mq.close();
    });

    it('should report whether a schedule existed when removing it', async () => {
      const { mq } = make();
      await mq.schedule({ every: 1000 });
      assert.strictEqual(await mq.unschedule(), true);
      assert.strictEqual(await mq.unschedule(), false);
      assert.strictEqual(await mq.unschedule('never-existed'), false);
      await mq.close();
    });

    const invalid = [
      ['neither every nor pattern', {}],
      ['both every and pattern', { every: 1000, pattern: '* * * * *' }],
      ['a non-positive every', { every: 0 }],
      ['an every below a second', { every: 999 }],
      ['a non-numeric every', { every: '1000' }],
      ['an empty pattern', { pattern: '' }],
      ['a non-string pattern', { pattern: 5 }],
      ['an empty tz', { every: 1000, tz: '' }],
      ['an id with a colon', { every: 1000, id: 'a:b' }],
      ['a target that is not a filename', { every: 1000, to: '../x.js' }],
      ['options that are not an object', 'hourly'],
    ];
    for (const [label, options] of invalid) {
      it(`should reject ${label}`, async () => {
        const { mq } = make();
        await assert.rejects(mq.schedule(options), ConfigInvalidError);
        await mq.close();
      });
    }

    it('should say which BullMQ is needed when job schedulers are missing', async () => {
      class OldQueue extends FakeQueue {}
      OldQueue.prototype.upsertJobScheduler = undefined;
      OldQueue.prototype.removeJobScheduler = undefined;
      const { mq } = make({ bullmq: { Queue: OldQueue } });
      await assert.rejects(mq.schedule({ every: 1000 }), /BullMQ 5\.16/);
      await assert.rejects(mq.unschedule(), /BullMQ 5\.16/);
      await assert.rejects(mq.unschedule('a:b'), ConfigInvalidError);
      await mq.close();
    });
  });

  describe('close', () => {
    it('should shut down in dependency order', async () => {
      const order = [];
      const { Queue, Worker, QueueEvents } = fakeBullmq();
      const tracked = (Base, label) =>
        class extends Base {
          async close(...args) {
            order.push(label);
            return super.close(...args);
          }
        };
      const kit = stubKit({
        dryRun: mock.fn(async () => pendingRows('0001-a.js')),
      });
      const mq = createMigrationQueue({
        bullmq: {
          Queue: tracked(Queue, 'queue'),
          Worker: tracked(Worker, 'worker'),
          QueueEvents: tracked(QueueEvents, 'queueEvents'),
        },
        connection: createFakeConnection(),
        config: { uri: 'mongodb://127.0.0.1:1/never', dbName: 'never', logger: null },
      });
      mock.method(mq.kit, 'dryRun', kit.dryRun);
      mock.method(mq.kit, 'nextBatch', async () => 1);
      mock.method(mq.kit, 'connect', async () => {});
      mock.method(mq.kit, 'up', async (name) => [{ file: name, status: 'applied' }]);
      mock.method(mq.kit, 'disconnect', async () => order.push('kit'));

      const group = await mq.enqueueUp();
      await mq.startWorker();
      await group.wait();
      await mq.close();
      assert.deepStrictEqual(order, ['worker', 'queueEvents', 'queue', 'kit']);
    });

    it('should be idempotent and refuse further work', async () => {
      const { mq } = make();
      const worker = await mq.startWorker();
      const closeWorker = mock.method(worker, 'close');
      await Promise.all([mq.close(), mq.close()]);
      await mq.close();
      assert.strictEqual(closeWorker.mock.callCount(), 1);
      assert.strictEqual(mq.queue.closed, true);
      await assert.rejects(mq.enqueueUp(), /closed/);
      await assert.rejects(mq.enqueueDown(), /closed/);
      await assert.rejects(mq.startWorker(), /closed/);
      await assert.rejects(mq.schedule({ every: 1000 }), /closed/);
      // Nothing reopens a connection that close() already let go of.
      for (const call of [
        () => mq.status(),
        () => mq.pending(),
        () => mq.audit(),
        () => mq.lockInfo(),
        () => mq.getJob('1'),
        () => mq.pause(),
        () => mq.resume(),
        () => mq.unschedule(),
      ]) {
        await assert.rejects(call(), /closed/);
      }
    });

    it('should pass force through to the worker', async () => {
      const { mq } = make();
      const worker = await mq.startWorker();
      const closeWorker = mock.method(worker, 'close');
      await mq.close({ force: true });
      assert.deepStrictEqual(closeWorker.mock.calls[0].arguments, [true]);
    });

    it('should not wait on a forced close, yet disconnect its own kit only once the job ends', async () => {
      const mq = createMigrationQueue({
        bullmq: fakeBullmq(),
        connection: spiedConnection(),
        config: { uri: 'mongodb://127.0.0.1:1/never', dbName: 'never', logger: null },
      });
      let release;
      let started;
      const running = new Promise((resolve) => (started = resolve));
      mock.method(mq.kit, 'connect', async () => {});
      mock.method(mq.kit, 'dryRun', async () => pendingRows('0001-a.js'));
      mock.method(mq.kit, 'nextBatch', async () => 1);
      mock.method(
        mq.kit,
        'up',
        (name) =>
          new Promise((resolve) => {
            release = () => resolve([{ file: name, status: 'applied' }]);
            started();
          }),
      );
      const disconnect = mock.method(mq.kit, 'disconnect', async () => {});
      await mq.startWorker();
      await mq.enqueueUp();
      await running;
      await mq.close({ force: true });
      assert.strictEqual(disconnect.mock.callCount(), 0, 'the running migration keeps its client');
      release();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.strictEqual(disconnect.mock.callCount(), 1);
    });

    it('should attempt every step and rethrow the first failure', async () => {
      const { mq } = make();
      const worker = await mq.startWorker();
      mock.method(worker, 'close', async () => {
        throw new Error('worker would not stop');
      });
      await assert.rejects(mq.close(), /worker would not stop/);
      assert.strictEqual(mq.queue.closed, true, 'the queue was still closed');
    });

    it('should not build a worker once close has begun', async () => {
      const { mq } = make();
      const starting = mq.startWorker();
      await mq.close();
      await assert.rejects(starting, /closed/);
      assert.strictEqual(mq.worker, undefined);
    });

    it('should let a failed start be retried', async () => {
      const kit = stubKit();
      let attempts = 0;
      kit.connect = mock.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('mongo briefly down');
      });
      const { mq } = make({ kit });
      await assert.rejects(mq.startWorker(), /briefly down/);
      const worker = await mq.startWorker();
      assert.ok(worker);
      await mq.close();
    });

    it('should put a job waiting on the lock back in the queue', async () => {
      const { LockAlreadyHeldError } = require('../../src/errors/index.js');
      const kit = stubKit({
        dryRun: mock.fn(async () => pendingRows('0001-a.js')),
        up: mock.fn(async () => {
          throw new LockAlreadyHeldError('held', { holder: { lockedAt: new Date(0) } });
        }),
      });
      const { mq } = make({
        kit,
        lockWait: { lockPollIntervalMs: 5000, lockWaitTimeoutMs: 60_000 },
      });
      const worker = await mq.startWorker();
      let failed = false;
      worker.on('failed', () => {
        failed = true;
      });
      const group = await mq.enqueueUp();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await mq.close();
      // Not failed for good — back at the head, for the next worker.
      assert.strictEqual(failed, false);
      assert.deepStrictEqual(mq.queue._state().wait, [group.jobs[0].id]);
    });
  });
});
