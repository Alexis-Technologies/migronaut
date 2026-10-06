const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const {
  assertBackgroundJobOptions,
  assertJobOptions,
  enqueueBackground,
  enqueueConverge,
  enqueueDown,
  enqueueUp,
  planDownJobs,
  planUpJobs,
} = require('../../src/bullmq/producer.js');
const { waitForGroup } = require('../../src/bullmq/wait.js');
const {
  BackgroundPendingError,
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
    assert.strictEqual(plan.groupId, 'id-1');
    assert.strictEqual(kit.generateId.mock.callCount(), 1);
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
        ordered: true,
      },
      opts: { removeOnComplete: 10, attempts: 1, deduplication: { id: 'up-0002-b.js' } },
    });
  });

  it("should carry each file's plan-time checksum, so a worker runs only that version", async () => {
    const digest = 'a'.repeat(64);
    const kit = stubKit({
      dryRun: mock.fn(async () => [
        { ...pendingRow('0001-a.js'), checksum: digest },
        pendingRow('0002-b.js'),
      ]),
    });
    const plan = await planUpJobs(kit);
    assert.strictEqual(plan.jobs[0].data.checksum, digest);
    assert.ok(!('checksum' in plan.jobs[1].data), 'none known, none claimed');
  });

  it('should let an empty group be waited for without QueueEvents', async () => {
    const kit = stubKit({ dryRun: mock.fn(async () => []) });
    const queue = { addBulk: mock.fn(async () => []), getJob: async () => undefined };
    let built = 0;
    const group = await enqueueUp(
      queue,
      kit,
      {},
      { getQueueEvents: () => (built += 1) && undefined },
    );
    assert.strictEqual(group.upToDate, true);
    assert.deepStrictEqual((await group.wait()).results, []);
    assert.strictEqual(built, 0, 'no QueueEvents connection for nothing to wait on');
  });

  it('should mint a new group id for every plan, through the kit', async () => {
    const kit = stubKit({ dryRun: mock.fn(async () => [pendingRow('0001-a.js')]) });
    const first = await planUpJobs(kit);
    const second = await planUpJobs(kit);
    assert.deepStrictEqual([first.groupId, second.groupId], ['id-1', 'id-2']);
    // Asked with no arguments: the kit decides the format, the adapter none of it.
    assert.deepStrictEqual(kit.generateId.mock.calls[0].arguments, []);
  });

  it('should fall back to a random UUID for a kit that cannot mint ids', async () => {
    // A duck-typed kit predating `generateId` — the adapter still needs an id.
    const kit = stubKit({
      dryRun: mock.fn(async () => [pendingRow('0001-a.js')]),
      generateId: undefined,
    });
    const plan = await planUpJobs(kit);
    assert.match(plan.groupId, /^[0-9a-f-]{36}$/);
  });

  // A worker refuses a job whose group id is not a short string, so an id like
  // these has to fail the enqueue call rather than every job it would add.
  for (const [label, value] of [
    ['an empty string', ''],
    ['a string over the limit', 'g'.repeat(129)],
    ['a non-string', 42],
  ]) {
    it(`should refuse ${label} as a group id before planning any job`, async () => {
      const kit = stubKit({
        dryRun: mock.fn(async () => [pendingRow('0001-a.js')]),
        generateId: mock.fn(async () => value),
      });
      await assert.rejects(planUpJobs(kit), ConfigInvalidError);
      assert.strictEqual(kit.nextBatch.mock.callCount(), 0);
    });
  }

  it('should let a failing id generator through as the enqueue error', async () => {
    const failure = new ConfigInvalidError('generateId threw');
    const kit = stubKit({
      dryRun: mock.fn(async () => [pendingRow('0001-a.js')]),
      generateId: mock.fn(async () => {
        throw failure;
      }),
    });
    await assert.rejects(planUpJobs(kit), (error) => error === failure);
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
    assert.deepStrictEqual(kit.list.mock.calls[0].arguments, ['applied', { checksums: false }]);
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

  it('should take the group id from the kit, and put it on every job', async () => {
    const rows = [appliedRow('0001-a.js', 1000), appliedRow('0002-b.js', 2000)];
    const kit = stubKit({
      dryRun: mock.fn(async () => [...rows]),
      list: mock.fn(async () => [...rows]),
    });
    const plan = await planDownJobs(kit);
    assert.strictEqual(plan.groupId, 'id-1');
    assert.deepStrictEqual(
      plan.jobs.map((job) => job.data.groupId),
      ['id-1', 'id-1'],
    );
  });

  it('should refuse an unusable group id, and fall back for a kit that mints none', async () => {
    const rows = [appliedRow('0001-a.js', 1000)];
    const selection = { dryRun: mock.fn(async () => [...rows]), list: mock.fn(async () => rows) };
    await assert.rejects(
      planDownJobs(stubKit({ ...selection, generateId: mock.fn(async () => '') })),
      ConfigInvalidError,
    );
    const plan = await planDownJobs(stubKit({ ...selection, generateId: undefined }));
    assert.match(plan.groupId, /^[0-9a-f-]{36}$/);
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
  const pendingKit = (files = ['0001-a.js', '0002-b.js'], overrides = {}) =>
    stubKit({
      dryRun: mock.fn(async () => files.map(pendingRow)),
      nextBatch: mock.fn(async () => 3),
      ...overrides,
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
    // A peer is another process, and its group id is its own: telling "we
    // added this job" from "it was already there" is a comparison of the two.
    const peer = pendingKit(['0001-a.js', '0002-b.js', '0003-c.js'], {
      generateId: mock.fn(async () => 'peer-enqueue'),
    });
    const second = await enqueueUp(queue, peer);

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

    it("should call a timeout a timeout even when BullMQ's own timer fires first", async () => {
      // A frozen clock: every timer fires while Date.now() is still short of
      // the deadline — what a timer firing a millisecond early looks like.
      const dateNow = mock.method(Date, 'now', () => 1000);
      try {
        const queue = {
          getJob: async () => ({
            // Rejects the way BullMQ does once its ttl runs out.
            waitUntilFinished: (_queueEvents, ttl) =>
              new Promise((_resolve, reject) => {
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        'Job wait m timed out before finishing, no finish notification ' +
                          `arrived after ${ttl}ms (id=1)`,
                      ),
                    ),
                  ttl,
                ).unref();
              }),
          }),
        };
        await assert.rejects(
          waitForGroup({
            queue,
            queueEvents: {},
            groupId: 'g',
            direction: 'up',
            batch: 1,
            jobs: [{ id: '1', migration: 'a.js' }],
            timeoutMs: 20,
          }),
          (error) => {
            assert.strictEqual(error.context.timedOut, true);
            assert.match(error.context.failedReason, /wait timed out after 20ms/);
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

    it('should hold every await to the one budget — a QueueEvents that never connects too', async () => {
      const queue = { getJob: async () => ({ waitUntilFinished: async () => 'never reached' }) };
      const started = Date.now();
      await assert.rejects(
        waitForGroup({
          queue,
          queueEvents: { waitUntilReady: () => new Promise(() => {}) },
          groupId: 'g',
          direction: 'up',
          batch: 1,
          jobs: [{ id: '1', migration: 'a.js' }],
          timeoutMs: 30,
        }),
        (error) => {
          assert.strictEqual(error.context.timedOut, true);
          assert.match(error.context.failedReason, /timed out after 30ms/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 1000);
    });

    it("should carry a failed job's typed code, so callers need not parse the reason", async () => {
      const queue = {
        getJob: async () => ({
          progress: { phase: 'failed', code: 'MIGRATION_BLOCKED' },
          waitUntilFinished: async () => {
            throw new Error('0002-b.js is blocked');
          },
        }),
      };
      await assert.rejects(
        waitForGroup({
          queue,
          queueEvents: {},
          groupId: 'g',
          direction: 'up',
          batch: 1,
          jobs: [{ id: '2', migration: '0002-b.js' }],
        }),
        (error) => error.context.code === 'MIGRATION_BLOCKED' && error.context.timedOut === false,
      );
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

describe('converge jobs from the producer', () => {
  const converging = (files, overrides = {}) =>
    stubKit({
      dryRun: mock.fn(async () => files.map(pendingRow)),
      nextBatch: mock.fn(async () => 3),
      convergesAfterUp: mock.fn(async () => true),
      converge: mock.fn(async () => ({ dryRun: true, changed: 1, inSync: false, collections: [] })),
      ...overrides,
    });

  it('should end a group with a converge job when the kit converges after up', async () => {
    const kit = converging(['0001-a.js', '0002-b.js']);
    const plan = await planUpJobs(kit, { jobOptions: { removeOnComplete: 5 } });
    assert.deepStrictEqual(plan.converge, {
      name: 'converge',
      data: { v: 1, kind: 'converge', groupId: plan.groupId, ordered: true },
      opts: {
        removeOnComplete: 5,
        attempts: 1,
        deduplication: { id: 'converge-after-0002-b.js' },
      },
    });
    assert.strictEqual(plan.jobs.length, 2, 'the migration jobs are untouched');
    assert.strictEqual(kit.converge.mock.callCount(), 0, 'no probe when migrations are pending');
    const unguarded = await planUpJobs(kit, { ordered: false });
    assert.strictEqual(unguarded.converge.data.ordered, false);
  });

  it('should not converge after a filename, a `to`, a kit without the hook, or on request', async () => {
    const kit = converging(['0001-a.js']);
    assert.ok(!('converge' in (await planUpJobs(kit, { filename: '0001-a.js' }))));
    assert.ok(!('converge' in (await planUpJobs(kit, { to: '0001-a.js' }))));
    assert.ok(!('converge' in (await planUpJobs(kit, { converge: false }))));
    const plain = stubKit({ dryRun: mock.fn(async () => [pendingRow('0001-a.js')]) });
    assert.ok(!('converge' in (await planUpJobs(plain))));
    // Explicitly on, without the kit's option.
    const forced = await planUpJobs(plain, { converge: true });
    assert.strictEqual(forced.converge.name, 'converge');
  });

  it('should refuse an explicit converge that cannot follow the group', async () => {
    const kit = converging(['0001-a.js']);
    await assert.rejects(planUpJobs(kit, { converge: true, to: '0001-a.js' }), ConfigInvalidError);
    await assert.rejects(
      planUpJobs(kit, { converge: true, filename: '0001-a.js' }),
      ConfigInvalidError,
    );
    await assert.rejects(planUpJobs(kit, { converge: 'yes' }), ConfigInvalidError);
  });

  it('should plan a converge-only group when nothing is pending, only on drift', async () => {
    const drifted = converging([]);
    const plan = await planUpJobs(drifted);
    assert.deepStrictEqual(plan.jobs, []);
    assert.strictEqual(plan.converge.opts.deduplication.id, 'converge');
    assert.deepStrictEqual(drifted.converge.mock.calls[0].arguments, [{ dryRun: true }]);

    const inSync = converging([], {
      converge: mock.fn(async () => ({ dryRun: true, changed: 0, inSync: true, collections: [] })),
    });
    assert.ok(!('converge' in (await planUpJobs(inSync))));
  });

  it('should add the converge job after the migrations and report it on the handle', async () => {
    const lines = [];
    const kit = converging(['0001-a.js']);
    kit.logger = { ...kit.logger, info: (msg, fields) => lines.push({ msg, fields }) };
    const queue = new FakeQueue('m', { connection: createFakeConnection() });
    const group = await enqueueUp(queue, kit);
    assert.deepStrictEqual(group.converge, { id: '2', deduplicated: false });
    assert.deepStrictEqual(queue._state().wait, ['1', '2']);
    assert.match(lines[0].msg, /Enqueued 1 migration\(s\) \+ converge/);
    assert.strictEqual(lines[0].fields.converge, true);

    const only = converging([]);
    only.logger = kit.logger;
    const tail = await enqueueUp(queue, only);
    assert.strictEqual(tail.upToDate, true);
    assert.match(lines[1].msg, /Enqueued a converge job/);
  });

  it('should enqueue a converge on its own, detect a duplicate, and wait for it', async () => {
    const connection = createFakeConnection();
    const queue = new FakeQueue('m', { connection });
    const queueEvents = new FakeQueueEvents('m', { connection });
    const kit = stubKit();
    const first = await enqueueConverge(queue, kit, { jobOptions: { removeOnFail: 3 } });
    assert.strictEqual(first.deduplicated, false);
    const stored = await queue.getJob(first.jobId);
    assert.deepStrictEqual(stored.data, {
      v: 1,
      kind: 'converge',
      groupId: first.groupId,
      ordered: true,
    });
    assert.strictEqual(stored.opts.removeOnFail, 3);
    const second = await enqueueConverge(queue, kit, { queueEvents });
    assert.strictEqual(second.deduplicated, true);
    assert.strictEqual(second.jobId, first.jobId);

    const worker = new FakeWorker(
      'm',
      async () => ({ kind: 'converge', changed: 0, inSync: true, collections: [], lockWaitMs: 0 }),
      { connection },
    );
    try {
      assert.strictEqual((await second.wait({ timeoutMs: 2000 })).inSync, true);
    } finally {
      await worker.close();
    }
  });

  it('should validate its options and the queue', async () => {
    const kit = stubKit();
    const queue = new FakeQueue('m', { connection: createFakeConnection() });
    await assert.rejects(enqueueConverge(queue, kit, 'x'), ConfigInvalidError);
    await assert.rejects(enqueueConverge(queue, kit, { ordered: 1 }), ConfigInvalidError);
    await assert.rejects(
      enqueueConverge(queue, kit, { jobOptions: { delay: 1 } }),
      ConfigInvalidError,
    );
    await assert.rejects(enqueueConverge({}, kit), ConfigInvalidError);
    await assert.rejects(
      enqueueConverge({ addBulk: async () => [] }, kit),
      /did not return the converge job/,
    );
    const blind = await enqueueConverge({ addBulk: async () => [{ id: 7 }] }, kit, {
      ordered: false,
    });
    assert.deepStrictEqual([blind.jobId, blind.deduplicated], ['7', false]);
  });
});

describe('background on the producer side', () => {
  const NAME = '0001-orders.js';
  const queue = () => new FakeQueue('jobs-background', { connection: createFakeConnection() });

  it('should cut an up plan before a migration that waits for a background one', async () => {
    const kit = stubKit({
      dryRun: mock.fn(async () => [
        { ...pendingRow(NAME), kind: 'background', background: true },
        { ...pendingRow('0002-next.js'), kind: 'background', requires: [NAME], waitsFor: [NAME] },
        { ...pendingRow('0003-contract.js'), requires: [NAME], waitsFor: [NAME] },
        pendingRow('0004-later.js'),
      ]),
      convergesAfterUp: mock.fn(async () => true),
    });
    const plan = await planUpJobs(kit);
    assert.deepStrictEqual(
      plan.migrations,
      [NAME, '0002-next.js'],
      'a background file is not held',
    );
    assert.deepStrictEqual(plan.waiting, { migration: '0003-contract.js', waitsFor: [NAME] });
    assert.strictEqual(plan.converge, undefined, 'a group cut short never converges');
    await assert.rejects(planUpJobs(kit, { filename: '0003-contract.js' }), (error) => {
      assert.ok(error instanceof BackgroundPendingError);
      assert.deepStrictEqual(error.context.waitsFor, [{ migration: NAME }]);
      return true;
    });
    const group = await enqueueUp(queue(), kit);
    assert.strictEqual(group.upToDate, false);
    assert.deepStrictEqual(group.waiting, plan.waiting);
  });

  it('should report a group held at its very first file as not up to date', async () => {
    const kit = stubKit({
      dryRun: mock.fn(async () => [{ ...pendingRow('0003-contract.js'), waitsFor: [NAME] }]),
    });
    const group = await enqueueUp(queue(), kit);
    assert.strictEqual(group.jobs.length, 0);
    assert.strictEqual(group.upToDate, false);
    assert.strictEqual(group.waiting.migration, '0003-contract.js');
  });

  it('should refuse background job options a coordinator or a lane owns', () => {
    assertBackgroundJobOptions(undefined);
    assertBackgroundJobOptions({ keepLogs: 5 });
    assert.throws(() => assertBackgroundJobOptions('x'), /must be an object/);
    for (const key of ['attempts', 'parent', 'failParentOnFailure', 'removeDependencyOnFailure']) {
      assert.throws(() => assertBackgroundJobOptions({ [key]: 1 }), new RegExp(key));
    }
  });

  it('should add a takeover for a running background migration nothing has moved for stallMs', async () => {
    const old = new Date(Date.now() - 60_000);
    const statuses = {
      '0001-a.js': {
        migration: '0001-a.js',
        status: 'running',
        liveLeases: 0,
        registeredAt: old,
        lastProgressAt: old,
        coordinator: { kind: 'bullmq', round: 3, at: old },
      },
      '0002-b.js': {
        migration: '0002-b.js',
        status: 'running',
        liveLeases: 1,
        registeredAt: old,
      },
      '0003-c.js': {
        migration: '0003-c.js',
        status: 'running',
        liveLeases: 0,
        registeredAt: new Date(),
      },
    };
    // The runnable list carries what a stall is told by — no status read per entry.
    const kit = stubKit({
      runnableBackground: mock.fn(async () => [
        ...Object.values(statuses).map((status) => ({ ...status, maxParallel: 1 })),
        { migration: '0004-d.js', status: 'pending', maxParallel: 1, liveLeases: 0 },
        {
          migration: '0005-gone.js',
          status: 'running',
          maxParallel: 1,
          liveLeases: 0,
          registeredAt: new Date(),
        },
      ]),
      backgroundStatus: mock.fn(async () => {
        throw new Error('a heal reads no status');
      }),
    });
    const target = queue();
    const { jobs } = await enqueueBackground(target, kit, { stallMs: 30_000, reason: 'heal' });
    assert.deepStrictEqual(
      jobs.map((job) => [job.migration, job.takeover ?? false]),
      [
        ['0001-a.js', false],
        ['0001-a.js', true],
        ['0002-b.js', false],
        ['0003-c.js', false],
        ['0004-d.js', false],
        ['0005-gone.js', false],
      ],
    );
    const takeover = await target.getJob(jobs[1].id);
    assert.deepStrictEqual(takeover.opts.deduplication, { id: 'bg-0001-a.js-t3' });
    assert.strictEqual(takeover.data.reason, 'heal');
  });

  it('should refuse a bad call, and add nothing when nothing is runnable', async () => {
    const kit = stubKit({
      runnableBackground: mock.fn(async () => []),
      backgroundStatus: mock.fn(async () => null),
    });
    await assert.rejects(enqueueBackground(queue(), kit, 1), /must be an object/);
    await assert.rejects(enqueueBackground({}, kit), /addBulk/);
    await assert.rejects(enqueueBackground(queue(), kit, { stallMs: 5 }), /stallMs/);
    await assert.rejects(enqueueBackground(queue(), kit, { stalMs: 60_000 }), /"stalMs"/);
    await assert.rejects(enqueueBackground(queue(), kit, { migration: '../x.js' }), /./);
    await assert.rejects(enqueueBackground(queue(), kit, { migration: NAME }), /not registered/);
    await assert.rejects(enqueueBackground(queue(), kit, { requestedBy: 5 }), ConfigInvalidError);
    assert.deepStrictEqual(await enqueueBackground(queue(), kit), { jobs: [] });
  });
});
