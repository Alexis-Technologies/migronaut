const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const {
  assertJobOptions,
  enqueueDown,
  enqueueUp,
  planDownJobs,
  planUpJobs,
} = require('../../src/bullmq/producer.js');
const { waitForGroup } = require('../../src/bullmq/wait.js');
const {
  ConfigInvalidError,
  MigrationBlockedError,
  MigrationInvalidNameError,
  QueueJobFailedError,
} = require('../../src/errors/index.js');
const {
  FakeQueue,
  FakeQueueEvents,
  FakeWorker,
  createFakeConnection,
} = require('../helpers/fake-bullmq.js');
const { stubKit } = require('../helpers/stub-kit.js');

const pendingRow = (file) => ({ file, status: 'pending', batch: null, appliedAt: null });
const appliedRow = (file, appliedAt, batch = 1) => ({
  file,
  status: 'applied',
  batch,
  appliedAt: new Date(appliedAt),
});

describe('assertJobOptions', () => {
  it('should accept nothing, and retention knobs', () => {
    assertJobOptions(undefined);
    assertJobOptions({ removeOnComplete: { count: 100 }, removeOnFail: false, keepLogs: 50 });
  });

  it('should reject anything that is not an options object', () => {
    for (const value of ['x', 5, null, []]) {
      assert.throws(() => assertJobOptions(value), ConfigInvalidError);
    }
  });

  // Each of these reorders, delays or re-runs a job — the queue is FIFO with a
  // single attempt on purpose, so the caller is told rather than overridden.
  for (const key of [
    'attempts',
    'backoff',
    'delay',
    'priority',
    'lifo',
    'jobId',
    'deduplication',
    'repeat',
    'parent',
  ]) {
    it(`should refuse jobOptions.${key} by name`, () => {
      assert.throws(
        () => assertJobOptions({ [key]: 1 }),
        (error) => error instanceof ConfigInvalidError && error.context.key === key,
      );
    });
  }
});

describe('planUpJobs', () => {
  it('should plan every pending file, in order, under one peeked batch', async () => {
    const kit = stubKit({
      dryRun: mock.fn(async () => [pendingRow('0001-a.js'), pendingRow('0002-b.js')]),
      nextBatch: mock.fn(async () => 7),
    });
    const plan = await planUpJobs(kit, { jobOptions: { removeOnComplete: 10 } });

    assert.deepStrictEqual(kit.dryRun.mock.calls[0].arguments, ['up', undefined, {}]);
    assert.strictEqual(plan.direction, 'up');
    assert.strictEqual(plan.batch, 7);
    assert.deepStrictEqual(plan.migrations, ['0001-a.js', '0002-b.js']);
    assert.match(plan.groupId, /^[0-9a-f-]{36}$/);
    assert.deepStrictEqual(plan.jobs[1], {
      name: 'up',
      data: {
        v: 1,
        direction: 'up',
        migration: '0002-b.js',
        groupId: plan.groupId,
        index: 1,
        total: 2,
        batch: 7,
      },
      opts: { removeOnComplete: 10, attempts: 1, deduplication: { id: 'up-0002-b.js' } },
    });
  });

  it('should pass `to` and a filename through to the same selection a real run makes', async () => {
    const kit = stubKit({ dryRun: mock.fn(async () => [pendingRow('0002-b.js')]) });
    await planUpJobs(kit, { to: '0002-b.js' });
    await planUpJobs(kit, { filename: '0002-b.js' });
    assert.deepStrictEqual(kit.dryRun.mock.calls[0].arguments, [
      'up',
      undefined,
      { to: '0002-b.js' },
    ]);
    assert.deepStrictEqual(kit.dryRun.mock.calls[1].arguments, ['up', '0002-b.js', {}]);
  });

  it('should return an empty plan — and peek no batch — when nothing is pending', async () => {
    const kit = stubKit();
    const plan = await planUpJobs(kit);
    assert.deepStrictEqual(plan.jobs, []);
    assert.deepStrictEqual(plan.migrations, []);
    assert.strictEqual(plan.batch, null);
    assert.strictEqual(kit.nextBatch.mock.callCount(), 0);
  });

  it('should leave an already-applied file out, unless forced', async () => {
    const kit = stubKit({ dryRun: mock.fn(async () => [appliedRow('0001-a.js', 1000)]) });
    assert.deepStrictEqual((await planUpJobs(kit, { filename: '0001-a.js' })).jobs, []);
    const forced = await planUpJobs(kit, { filename: '0001-a.js', force: true });
    assert.strictEqual(forced.jobs.length, 1);
    assert.strictEqual(forced.jobs[0].data.force, true);
  });

  it('should mark an unguarded plan on its jobs', async () => {
    const kit = stubKit({ dryRun: mock.fn(async () => [pendingRow('0001-a.js')]) });
    const plan = await planUpJobs(kit, { filename: '0001-a.js', ordered: false });
    assert.strictEqual(plan.jobs[0].data.ordered, false);
  });

  it('should validate before reading anything', async () => {
    const kit = stubKit();
    await assert.rejects(planUpJobs(kit, { filename: '../x.js' }), MigrationInvalidNameError);
    await assert.rejects(planUpJobs(kit, { to: 'a/b.js' }), MigrationInvalidNameError);
    await assert.rejects(planUpJobs(kit, { force: true }), /force requires a filename/);
    await assert.rejects(planUpJobs(kit, { force: 'yes' }), ConfigInvalidError);
    await assert.rejects(planUpJobs(kit, { ordered: 1 }), ConfigInvalidError);
    await assert.rejects(planUpJobs(kit, { jobOptions: { attempts: 2 } }), ConfigInvalidError);
    assert.strictEqual(kit.dryRun.mock.callCount(), 0);
  });

  it("should let the kit's own refusals through, enqueuing nothing", async () => {
    const refusal = new ConfigInvalidError('Cannot combine a filename with --to');
    const kit = stubKit({
      dryRun: mock.fn(async () => {
        throw refusal;
      }),
    });
    await assert.rejects(
      planUpJobs(kit, { filename: 'a.js', to: 'b.js' }),
      (error) => error === refusal,
    );
  });
});

describe('planDownJobs', () => {
  it('should order an ordered rollback newest-applied first, not by name', async () => {
    // 0001 was merged late and applied last: by name it would revert last,
    // but its effects are the newest and must be undone first.
    const kit = stubKit({
      dryRun: mock.fn(async () => [
        appliedRow('0003-c.js', 2000, 2),
        appliedRow('0001-a.js', 3000, 2),
      ]),
      list: mock.fn(async () => [
        appliedRow('0001-a.js', 3000, 2),
        appliedRow('0002-b.js', 1000, 1),
        appliedRow('0003-c.js', 2000, 2),
      ]),
    });
    const plan = await planDownJobs(kit);
    assert.deepStrictEqual(plan.migrations, ['0001-a.js', '0003-c.js']);
    assert.strictEqual(plan.batch, null);
    assert.strictEqual(plan.jobs[0].data.batch, 2, 'the record batch rides along for information');
    assert.deepStrictEqual(plan.jobs[0].opts.deduplication, { id: 'down-0001-a.js' });
    assert.deepStrictEqual(kit.list.mock.calls[0].arguments, ['applied']);
  });

  it('should break appliedAt ties by name, descending', async () => {
    const rows = [appliedRow('0001-a.js', 1000), appliedRow('0002-b.js', 1000)];
    const kit = stubKit({
      dryRun: mock.fn(async () => [...rows]),
      list: mock.fn(async () => [...rows]),
    });
    assert.deepStrictEqual((await planDownJobs(kit)).migrations, ['0002-b.js', '0001-a.js']);
  });

  it('should pass the selection options through', async () => {
    const kit = stubKit();
    await planDownJobs(kit, { steps: 2 });
    await planDownJobs(kit, { batch: 3 });
    await planDownJobs(kit, { to: '0001-a.js' });
    await planDownJobs(kit, { filename: '0002-b.js' });
    const calls = kit.dryRun.mock.calls.map((call) => call.arguments);
    assert.deepStrictEqual(calls, [
      ['down', undefined, { steps: 2 }],
      ['down', undefined, { batch: 3 }],
      ['down', undefined, { to: '0001-a.js' }],
      ['down', '0002-b.js', {}],
    ]);
  });

  it('should return an empty plan when there is nothing to roll back', async () => {
    const kit = stubKit();
    const plan = await planDownJobs(kit);
    assert.deepStrictEqual(plan.jobs, []);
    assert.strictEqual(kit.list.mock.callCount(), 0);
  });

  it('should refuse a rollback that is not the top of the applied stack', async () => {
    const kit = stubKit({
      dryRun: mock.fn(async () => [appliedRow('0001-a.js', 1000)]),
      list: mock.fn(async () => [
        appliedRow('0001-a.js', 1000),
        appliedRow('0002-b.js', 2000),
        appliedRow('0003-c.js', 3000),
      ]),
    });
    await assert.rejects(planDownJobs(kit, { filename: '0001-a.js' }), (error) => {
      assert.ok(error instanceof MigrationBlockedError);
      assert.deepStrictEqual(error.context.blockedBy, ['0003-c.js', '0002-b.js']);
      assert.deepStrictEqual(error.context.names, ['0001-a.js']);
      assert.strictEqual(error.context.direction, 'down');
      return true;
    });
  });

  it('should skip the stack check — and keep the kit order — when unguarded', async () => {
    const kit = stubKit({
      dryRun: mock.fn(async () => [appliedRow('0001-a.js', 1000), appliedRow('0002-b.js', 9000)]),
    });
    const plan = await planDownJobs(kit, { ordered: false });
    assert.deepStrictEqual(plan.migrations, ['0001-a.js', '0002-b.js']);
    assert.strictEqual(plan.jobs[0].data.ordered, false);
    assert.strictEqual(kit.list.mock.callCount(), 0);
  });

  it('should treat a record without appliedAt as the oldest', async () => {
    const legacy = { file: '0000-legacy.js', status: 'applied', batch: 1, appliedAt: null };
    const kit = stubKit({
      dryRun: mock.fn(async () => [legacy, appliedRow('0001-a.js', 1000)]),
      list: mock.fn(async () => [legacy, appliedRow('0001-a.js', 1000)]),
    });
    assert.deepStrictEqual((await planDownJobs(kit)).migrations, ['0001-a.js', '0000-legacy.js']);
  });

  it('should validate before reading anything', async () => {
    const kit = stubKit();
    await assert.rejects(planDownJobs(kit, { filename: '..' }), MigrationInvalidNameError);
    await assert.rejects(planDownJobs(kit, { to: '' }), MigrationInvalidNameError);
    await assert.rejects(planDownJobs(kit, { ordered: 'no' }), ConfigInvalidError);
    await assert.rejects(planDownJobs(kit, { jobOptions: { delay: 5 } }), ConfigInvalidError);
    assert.strictEqual(kit.dryRun.mock.callCount(), 0);
  });
});

describe('enqueueUp / enqueueDown on a queue you own', () => {
  const pendingKit = (files = ['0001-a.js', '0002-b.js']) =>
    stubKit({
      dryRun: mock.fn(async () => files.map(pendingRow)),
      nextBatch: mock.fn(async () => 3),
    });

  it('should add the whole group and hand back its handle', async () => {
    const connection = createFakeConnection();
    const queue = new FakeQueue('m', { connection });
    const group = await enqueueUp(queue, pendingKit());

    assert.strictEqual(group.direction, 'up');
    assert.strictEqual(group.batch, 3);
    assert.strictEqual(group.upToDate, false);
    assert.deepStrictEqual(group.jobs, [
      { id: '1', migration: '0001-a.js', index: 0 },
      { id: '2', migration: '0002-b.js', index: 1 },
    ]);
    assert.deepStrictEqual(group.deduplicated, []);
    assert.deepStrictEqual(queue._state().wait, ['1', '2']);
    const stored = await queue.getJob('2');
    assert.strictEqual(stored.data.groupId, group.groupId);
    assert.strictEqual(stored.opts.attempts, 1);
  });

  it('should report files a peer already queued, pointing at the existing jobs', async () => {
    const connection = createFakeConnection();
    const queue = new FakeQueue('m', { connection });
    const first = await enqueueUp(queue, pendingKit());
    const second = await enqueueUp(queue, pendingKit(['0001-a.js', '0002-b.js', '0003-c.js']));

    assert.deepStrictEqual(second.deduplicated, ['0001-a.js', '0002-b.js']);
    assert.deepStrictEqual(
      second.jobs.map((job) => job.id),
      [first.jobs[0].id, first.jobs[1].id, '3'],
    );
    assert.deepStrictEqual(queue._state().wait, ['1', '2', '3'], 'nothing was added twice');
  });

  it('should add nothing for an empty plan', async () => {
    const queue = { addBulk: mock.fn(async () => []) };
    const group = await enqueueUp(queue, stubKit());
    assert.strictEqual(group.upToDate, true);
    assert.deepStrictEqual(group.jobs, []);
    assert.strictEqual(queue.addBulk.mock.callCount(), 0);
    // Nothing to wait for — but waiting must still be a well-formed call.
    assert.deepStrictEqual(await group.wait({ queueEvents: {} }), {
      groupId: group.groupId,
      direction: 'up',
      batch: null,
      results: [],
    });
  });

  it('should log what it enqueued through the kit logger', async () => {
    const lines = [];
    const kit = pendingKit();
    kit.logger = { ...kit.logger, info: (msg, fields) => lines.push({ msg, fields }) };
    const group = await enqueueUp(new FakeQueue('m', { connection: createFakeConnection() }), kit);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0].msg, /Enqueued 2 migration\(s\)\s+\[up, batch 3\]/);
    assert.deepStrictEqual(lines[0].fields, {
      groupId: group.groupId,
      direction: 'up',
      batch: 3,
      count: 2,
      deduplicated: 0,
    });
  });

  it('should enqueue a rollback, newest first, with no shared batch', async () => {
    const rows = [appliedRow('0001-a.js', 1000), appliedRow('0002-b.js', 2000)];
    const kit = stubKit({
      dryRun: mock.fn(async () => [...rows]),
      list: mock.fn(async () => [...rows]),
    });
    const lines = [];
    kit.logger = { ...kit.logger, info: (msg) => lines.push(msg) };
    const queue = new FakeQueue('m', { connection: createFakeConnection() });
    const group = await enqueueDown(queue, kit);
    assert.strictEqual(group.direction, 'down');
    assert.strictEqual(group.batch, null);
    assert.deepStrictEqual(
      group.jobs.map((job) => job.migration),
      ['0002-b.js', '0001-a.js'],
    );
    assert.match(lines[0], /\[down\]/);
  });

  it('should refuse a queue that cannot take a bulk add', async () => {
    await assert.rejects(enqueueUp({}, pendingKit()), ConfigInvalidError);
    await assert.rejects(enqueueUp(undefined, pendingKit()), ConfigInvalidError);
  });

  it('should refuse a queue whose bulk add returns the wrong shape', async () => {
    await assert.rejects(
      enqueueUp({ addBulk: async () => [{ id: '1' }] }, pendingKit()),
      /did not return one job per migration/,
    );
    await assert.rejects(
      enqueueUp({ addBulk: async () => undefined }, pendingKit()),
      ConfigInvalidError,
    );
  });

  it('should work with a queue that cannot read jobs back', async () => {
    const queue = { addBulk: async (specs) => specs.map((_spec, index) => ({ id: index + 10 })) };
    const group = await enqueueUp(queue, pendingKit());
    assert.deepStrictEqual(group.deduplicated, []);
    assert.deepStrictEqual(
      group.jobs.map((job) => job.id),
      ['10', '11'],
    );
  });

  describe('group.wait()', () => {
    function harness() {
      const connection = createFakeConnection();
      const queue = new FakeQueue('m', { connection });
      const queueEvents = new FakeQueueEvents('m', { connection });
      return { connection, queue, queueEvents };
    }

    it('should need QueueEvents from somewhere', async () => {
      const { queue } = harness();
      const group = await enqueueUp(queue, pendingKit());
      await assert.rejects(group.wait(), (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.match(error.message, /QueueEvents/);
        return true;
      });
    });

    it('should resolve every result in group order — passed at enqueue or at wait', async () => {
      const { connection, queue, queueEvents } = harness();
      const viaOptions = await enqueueUp(queue, pendingKit(), { queueEvents });
      const worker = new FakeWorker('m', async (job) => `done ${job.data.migration}`, {
        connection,
      });
      const waited = await viaOptions.wait({ timeoutMs: 2000 });
      assert.deepStrictEqual(waited, {
        groupId: viaOptions.groupId,
        direction: 'up',
        batch: 3,
        results: ['done 0001-a.js', 'done 0002-b.js'],
      });

      const viaWait = await enqueueUp(queue, pendingKit());
      assert.strictEqual((await viaWait.wait({ queueEvents })).results.length, 2);
      await worker.close();
    });

    it('should prefer the facade-supplied QueueEvents getter when nothing else is given', async () => {
      const { connection, queue, queueEvents } = harness();
      const getQueueEvents = mock.fn(() => queueEvents);
      const group = await enqueueUp(queue, pendingKit(), {}, { getQueueEvents });
      const worker = new FakeWorker('m', async () => 'ok', { connection });
      await group.wait();
      await worker.close();
      assert.strictEqual(getQueueEvents.mock.callCount(), 1);
    });

    it('should reject at the first failed job, keeping what finished before it', async () => {
      const { connection, queue, queueEvents } = harness();
      const group = await enqueueUp(queue, pendingKit(['0001-a.js', '0002-b.js', '0003-c.js']), {
        queueEvents,
      });
      const worker = new FakeWorker(
        'm',
        async (job) => {
          if (job.data.index === 1) throw new Error('boom at mongodb://u:secret@h/db');
          return 'ok';
        },
        { connection },
      );
      await assert.rejects(group.wait(), (error) => {
        assert.ok(error instanceof QueueJobFailedError);
        assert.strictEqual(error.code, 'QUEUE_JOB_FAILED');
        assert.match(error.message, /0002-b\.js/);
        assert.deepStrictEqual(error.context, {
          groupId: group.groupId,
          jobId: '2',
          migration: '0002-b.js',
          direction: 'up',
          failedReason: 'boom at mongodb://u:****@h/db',
          timedOut: false,
          results: ['ok'],
        });
        return true;
      });
      await worker.close();
    });

    it('should time the whole group out, and say so', async () => {
      const { queue, queueEvents } = harness();
      const group = await enqueueUp(queue, pendingKit(), { queueEvents });
      // No worker: nothing ever finishes.
      await assert.rejects(group.wait({ timeoutMs: 20 }), (error) => {
        assert.ok(error instanceof QueueJobFailedError);
        assert.strictEqual(error.context.timedOut, true);
        assert.strictEqual(error.context.jobId, '1');
        return true;
      });
    });

    it('should not start waiting on a job once the budget is spent', async () => {
      const queueEvents = {};
      let now = 1000;
      const dateNow = mock.method(Date, 'now', () => now);
      try {
        const queue = {
          getJob: async (id) => ({
            waitUntilFinished: async () => {
              now += 500;
              return `done ${id}`;
            },
          }),
        };
        await assert.rejects(
          waitForGroup({
            queue,
            queueEvents,
            groupId: 'g',
            direction: 'up',
            batch: 1,
            jobs: [
              { id: '1', migration: 'a.js' },
              { id: '2', migration: 'b.js' },
            ],
            timeoutMs: 100,
          }),
          (error) => {
            assert.strictEqual(error.context.timedOut, true);
            assert.strictEqual(error.context.migration, 'b.js');
            assert.deepStrictEqual(error.context.results, ['done 1']);
            return true;
          },
        );
      } finally {
        dateNow.mock.restore();
      }
    });

    it('should fail clearly when a job was removed before it could be read', async () => {
      const { queue, queueEvents } = harness();
      const group = await enqueueUp(queue, pendingKit(), { queueEvents });
      await (await queue.getJob('1')).remove();
      await assert.rejects(group.wait(), (error) => {
        assert.ok(error instanceof QueueJobFailedError);
        assert.match(error.context.failedReason, /job not found/);
        assert.strictEqual(error.context.timedOut, false);
        return true;
      });
    });

    it('should reject a non-positive or non-finite timeout', async () => {
      const { queue, queueEvents } = harness();
      const group = await enqueueUp(queue, pendingKit(), { queueEvents });
      for (const timeoutMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '50']) {
        await assert.rejects(group.wait({ timeoutMs }), ConfigInvalidError);
      }
    });

    it('should describe a rejection that is not an Error', async () => {
      const queue = {
        getJob: async () => ({
          waitUntilFinished: async () => {
            // eslint-disable-next-line no-throw-literal -- intentionally a non-Error rejection
            throw 'plain string';
          },
        }),
      };
      await assert.rejects(
        waitForGroup({
          queue,
          queueEvents: { waitUntilReady: async () => {} },
          groupId: 'g',
          direction: 'down',
          batch: null,
          jobs: [{ id: '1', migration: 'a.js' }],
        }),
        (error) => error.context.failedReason === 'plain string',
      );
    });
  });
});
