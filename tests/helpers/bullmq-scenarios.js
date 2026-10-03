const assert = require('node:assert/strict');
const os = require('node:os');
const { afterEach, beforeEach, it } = require('node:test');
const { DEFAULT_CONVERGE_SCHEDULER_ID, createMigrationQueue } = require('../../bullmq.js');
const {
  ConfigInvalidError,
  MigrationBlockedError,
  QueueJobFailedError,
} = require('../../src/errors/index.js');
const { failingMigration, insertMigration, makeProject } = require('./project.js');

const LOCK_COLLECTION = '_migronaut_locks';
const CHANGELOG = '_migronaut_migrations';

/** A migration whose up() takes `ms` and records whether its signal was aborted meanwhile */
function slowMigration(collection, value, ms) {
  return `export async function up({ db, signal }) {
  await new Promise((resolve) => setTimeout(resolve, ${ms}));
  await db.collection('${collection}').insertOne({ marker: '${value}', aborted: signal?.aborted ?? null });
}
export async function down({ db }) {
  await db.collection('${collection}').deleteMany({ marker: '${value}' });
}
`;
}

/** A migration whose failure message carries a credentialed URI */
function leakyMigration() {
  return `export async function up() {
  throw new Error('cannot reach mongodb://admin:hunter2@db.internal:27017/app');
}
export async function down() {}
`;
}

/**
 * The adapter's behaviour, written once and run twice: against the in-tree
 * fake BullMQ (always — this is where the coverage comes from) and against the
 * real library on a real Redis (when one is available). Running the same
 * assertions on both is what keeps the fake honest: a scenario that passes
 * here and fails there means the fake models BullMQ wrongly.
 *
 * `harness`:
 * - `fake`            — true for the in-tree double (enables the fake-only scenarios)
 * - `mongo()`         — `{ uri, db }` of the test MongoDB
 * - `dbName`
 * - `bullmq()`        — `{ Queue, Worker, QueueEvents }`
 * - `connection()`    — the `connection` for this test
 * - `prefix()`        — a key prefix unique to this test, or undefined
 * - `logsOf(queue, id)` — a job's log rows
 * - `obliterate(queue)` — drop the queue's keys after the test
 */
function defineBullMQScenarios(harness) {
  let project;
  let connection;
  let prefix;
  const opened = [];

  beforeEach(async () => {
    await harness.mongo().db.dropDatabase();
    project = makeProject();
    connection = harness.connection();
    prefix = harness.prefix();
  });

  afterEach(async () => {
    for (const mq of opened.splice(0)) {
      await harness.obliterate(mq.queue).catch(() => undefined);
      await mq.close({ force: true }).catch(() => undefined);
    }
    project?.cleanup();
  });

  function createQueue(overrides = {}) {
    const { config, ...rest } = overrides;
    const mq = createMigrationQueue({
      config: {
        uri: harness.mongo().uri,
        dbName: harness.dbName,
        migrationsDir: project.dir,
        logger: null,
        // A fix to a migration file must be picked up by the long-lived kit —
        // in production that is a redeploy; here it is the same process.
        reloadMigrations: true,
        ...config,
      },
      bullmq: harness.bullmq(),
      connection,
      ...(prefix !== undefined ? { prefix } : {}),
      lockWait: { lockPollIntervalMs: 20, lockWaitTimeoutMs: 5000 },
      ...rest,
    });
    opened.push(mq);
    return mq;
  }

  const write = (name, body) => project.write(name, body);
  const three = () => {
    write('0001-a.js', insertMigration('things', 'a'));
    write('0002-b.js', insertMigration('things', 'b'));
    write('0003-c.js', insertMigration('things', 'c'));
  };
  const markers = async () =>
    (await harness.mongo().db.collection('things').find().sort({ _id: 1 }).toArray()).map(
      (doc) => doc.marker,
    );
  const records = () => harness.mongo().db.collection(CHANGELOG).find().sort({ name: 1 }).toArray();

  /** Poll until every job has finished, then return their views */
  async function settled(mq, ids, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const views = await Promise.all(ids.map((id) => mq.getJob(id)));
      if (views.every((view) => view && (view.state === 'completed' || view.state === 'failed'))) {
        return views;
      }
      if (Date.now() > deadline) {
        throw new Error(`jobs did not settle: ${views.map((view) => view?.state).join(', ')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  /** A queue whose jobs give up on a block quickly — for scenarios that expect one */
  const QUICK_BLOCK = { lockWait: { lockPollIntervalMs: 20, lockWaitTimeoutMs: 300 } };

  async function holdLock() {
    await harness.mongo().db.collection(LOCK_COLLECTION).insertOne({
      _id: 'migronaut_lock',
      lockedAt: new Date(),
      pid: 999_999,
      host: os.hostname(),
      executedBy: 'peer',
      owner: 'peer-token',
    });
  }
  const releaseLock = () =>
    harness.mongo().db.collection(LOCK_COLLECTION).deleteOne({ _id: 'migronaut_lock' });

  // ─── Applying ──────────────────────────────────────────────────────────────

  it('should apply every pending migration as its own job, in order, under one batch', async () => {
    three();
    const mq = createQueue();
    const expectedBatch = await mq.kit.nextBatch();
    const group = await mq.enqueueUp();

    assert.strictEqual(group.direction, 'up');
    assert.strictEqual(group.batch, expectedBatch);
    assert.strictEqual(group.upToDate, false);
    assert.deepStrictEqual(
      group.jobs.map((job) => [job.migration, job.index]),
      [
        ['0001-a.js', 0],
        ['0002-b.js', 1],
        ['0003-c.js', 2],
      ],
    );
    assert.deepStrictEqual(group.deduplicated, []);
    assert.strictEqual(await harness.mongo().db.collection('things').countDocuments(), 0);

    await mq.startWorker();
    const { results } = await group.wait({ timeoutMs: 10_000 });

    assert.deepStrictEqual(
      results.map((result) => [result.migration, result.status, result.batch]),
      [
        ['0001-a.js', 'applied', expectedBatch],
        ['0002-b.js', 'applied', expectedBatch],
        ['0003-c.js', 'applied', expectedBatch],
      ],
    );
    assert.ok(results.every((result) => typeof result.runId === 'string'));
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
    const changelog = await records();
    assert.deepStrictEqual(
      changelog.map((record) => [record.status, record.batch]),
      [
        ['applied', expectedBatch],
        ['applied', expectedBatch],
        ['applied', expectedBatch],
      ],
    );
    // Each job is its own run: the record's runId is the one the job reported.
    assert.deepStrictEqual(
      changelog.map((record) => record.runId),
      results.map((result) => result.runId),
    );
    assert.deepStrictEqual(await mq.pending(), []);
  });

  it('should give every migration job a single attempt and a readable trail', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue();
    const group = await mq.enqueueUp();
    const live = await mq.queue.getJob(group.jobs[0].id);
    assert.strictEqual(live.opts.attempts, 1);

    await mq.startWorker();
    await group.wait({ timeoutMs: 10_000 });
    const view = await mq.getJob(group.jobs[0].id);
    assert.strictEqual(view.state, 'completed');
    assert.strictEqual(view.name, 'up');
    assert.strictEqual(view.returnvalue.status, 'applied');
    assert.strictEqual(view.progress.phase, 'completed');
    assert.strictEqual(view.data.groupId, group.groupId);
    const logs = await harness.logsOf(mq.queue, group.jobs[0].id);
    assert.ok(
      logs.some((row) => /Applied 0001-a\.js/.test(row)),
      logs.join(' | '),
    );
  });

  it('should mint group ids and run ids in the configured id format', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    write('0002-b.js', insertMigration('things', 'b'));
    let count = 0;
    const mq = createQueue({ config: { generateId: () => `mq_${++count}` } });

    // One generator for the whole deployment: the enqueue call asks the kit…
    const group = await mq.enqueueUp();
    assert.strictEqual(group.groupId, 'mq_1');
    const queued = await mq.getJob(group.jobs[1].id);
    assert.strictEqual(queued.data.groupId, 'mq_1');

    await mq.startWorker();
    const waited = await group.wait({ timeoutMs: 10_000 });
    assert.strictEqual(waited.groupId, 'mq_1');
    // …and so does every job, each being a run of its own.
    assert.deepStrictEqual(
      waited.results.map((result) => result.runId),
      ['mq_2', 'mq_3'],
    );
    assert.deepStrictEqual(
      (await records()).map((record) => record.runId),
      ['mq_2', 'mq_3'],
    );
  });

  it('should refuse to enqueue when the configured generator returns no usable id', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue({ config: { generateId: () => '' } });
    await assert.rejects(mq.enqueueUp(), (error) => {
      assert.strictEqual(error.code, 'CONFIG_INVALID');
      assert.match(error.message, /non-empty string/);
      return true;
    });
    // Refused as a whole — not a group of jobs a worker would reject one by one.
    assert.deepStrictEqual(
      (await mq.pending()).map((row) => row.file),
      ['0001-a.js'],
    );
    assert.deepStrictEqual(await records(), []);
  });

  it('should apply only up to `to`, and one named file on request', async () => {
    three();
    const mq = createQueue();
    await mq.startWorker();
    const upTo = await mq.enqueueUp(undefined, { to: '0002-b.js' });
    assert.deepStrictEqual(
      upTo.jobs.map((job) => job.migration),
      ['0001-a.js', '0002-b.js'],
    );
    await upTo.wait({ timeoutMs: 10_000 });

    const single = await mq.enqueueUp('0003-c.js');
    assert.strictEqual(single.jobs.length, 1);
    await single.wait({ timeoutMs: 10_000 });
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
    // Two enqueues, two batches — a rollback would take only the second.
    assert.notStrictEqual(single.batch, upTo.batch);
  });

  it('should report up to date — and add no job — when nothing is pending', async () => {
    const mq = createQueue();
    const group = await mq.enqueueUp();
    assert.strictEqual(group.upToDate, true);
    assert.deepStrictEqual(group.jobs, []);
    assert.strictEqual(group.batch, null);
    assert.deepStrictEqual((await group.wait()).results, []);
  });

  // ─── Ordering and failure ──────────────────────────────────────────────────

  it('should refuse a single file while an earlier one is still pending', async () => {
    three();
    // An earlier migration that never failed may be in flight on another
    // worker: the job waits for it (within its lock-wait budget), then refuses.
    const mq = createQueue(QUICK_BLOCK);
    await mq.startWorker();
    const group = await mq.enqueueUp('0002-b.js');
    const [view] = await settled(mq, [group.jobs[0].id]);
    const logs = await harness.logsOf(mq.queue, group.jobs[0].id);
    assert.ok(
      logs.some((row) => /not applied yet — waiting/.test(row)),
      logs.join(' | '),
    );

    assert.strictEqual(view.state, 'failed');
    assert.match(view.failedReason, /0002-b\.js is blocked/);
    assert.match(view.failedReason, /0001-a\.js/);
    assert.strictEqual(view.progress.code, 'MIGRATION_BLOCKED');
    assert.deepStrictEqual(await markers(), []);
    assert.deepStrictEqual(await records(), [], 'a blocked job leaves no trace in the changelog');
  });

  it('should let a later job wait for an earlier one still in flight on another worker', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    write('0002-b.js', insertMigration('things', 'b'));
    await holdLock();
    // Two workers that both take a job — no global concurrency — and a lock
    // that frees with the later job polling far more often: it gets there
    // first, finds 0001 not applied (but not failed), and must wait for it.
    const slow = createQueue({
      globalConcurrency: false,
      lockWait: { lockPollIntervalMs: 400, lockWaitTimeoutMs: 10_000 },
    });
    const fast = createQueue({
      globalConcurrency: false,
      lockWait: { lockPollIntervalMs: 20, lockWaitTimeoutMs: 10_000 },
    });
    await slow.startWorker();
    const group = await slow.enqueueUp();
    const [first, second] = group.jobs.map((job) => job.id);
    const deadline = Date.now() + 10_000;
    while ((await slow.getJob(first))?.state !== 'active') {
      if (Date.now() > deadline) throw new Error('the first job never started');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await fast.startWorker();
    while ((await fast.getJob(second))?.progress?.phase !== 'lock-wait') {
      if (Date.now() > deadline) throw new Error('the second job never waited');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await releaseLock();

    const views = await settled(slow, [first, second]);
    assert.deepStrictEqual(
      views.map((view) => view.state),
      ['completed', 'completed'],
    );
    assert.deepStrictEqual(await markers(), ['a', 'b']);
  });

  it('should refuse to apply a file that changed since its job was planned', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue();
    const group = await mq.enqueueUp();
    // A worker from another deploy: same name, other content.
    write('0001-a.js', insertMigration('things', 'a-elsewhere'));
    await mq.startWorker();
    const [view] = await settled(mq, [group.jobs[0].id]);
    assert.strictEqual(view.state, 'failed');
    assert.strictEqual(view.progress.code, 'CHECKSUM_MISMATCH');
    assert.match(view.failedReason, /not the file this run was planned with/);
    assert.deepStrictEqual(await markers(), []);
  });

  it('should run that same file when the job opts out of the order guard', async () => {
    three();
    const mq = createQueue({ allow: { unordered: true } });
    await mq.startWorker();
    const group = await mq.enqueueUp('0002-b.js', { ordered: false });
    await group.wait({ timeoutMs: 10_000 });
    assert.deepStrictEqual(await markers(), ['b']);
  });

  it('should stop the line at a failed migration, then resume once it is fixed', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    write('0002-b.js', failingMigration());
    write('0003-c.js', insertMigration('things', 'c'));
    const mq = createQueue();
    await mq.startWorker();

    const group = await mq.enqueueUp();
    await assert.rejects(group.wait({ timeoutMs: 10_000 }), (error) => {
      assert.ok(error instanceof QueueJobFailedError);
      assert.strictEqual(error.context.migration, '0002-b.js');
      assert.strictEqual(error.context.jobId, group.jobs[1].id);
      assert.strictEqual(error.context.timedOut, false);
      // The cause travels with the message: it is all the queue ever sees.
      assert.match(error.context.failedReason, /intentional failure/);
      // …and the typed code with the error, so a caller branches without parsing.
      assert.strictEqual(error.context.code, 'MIGRATION_EXECUTION_FAILED');
      assert.strictEqual(error.context.results.length, 1);
      assert.strictEqual(error.context.results[0].status, 'applied');
      return true;
    });

    const [first, second, third] = await settled(
      mq,
      group.jobs.map((job) => job.id),
    );
    assert.strictEqual(first.state, 'completed');
    assert.strictEqual(second.state, 'failed');
    assert.strictEqual(second.progress.code, 'MIGRATION_EXECUTION_FAILED');
    assert.strictEqual(second.attemptsMade, 1, 'a failed migration is not retried');
    // The third never ran: it was refused because the second is still pending.
    assert.strictEqual(third.state, 'failed');
    assert.strictEqual(third.progress.code, 'MIGRATION_BLOCKED');
    assert.deepStrictEqual(await markers(), ['a']);
    assert.deepStrictEqual(
      (await mq.status()).map((row) => [row.file, row.status]),
      [
        ['0001-a.js', 'applied'],
        ['0002-b.js', 'failed'],
        ['0003-c.js', 'pending'],
      ],
    );

    write('0002-b.js', insertMigration('things', 'b'));
    const retry = await mq.enqueueUp();
    assert.deepStrictEqual(
      retry.jobs.map((job) => job.migration),
      ['0002-b.js', '0003-c.js'],
    );
    assert.deepStrictEqual(retry.deduplicated, [], 'the failed jobs released their dedup keys');
    assert.notStrictEqual(retry.batch, group.batch);
    const { results } = await retry.wait({ timeoutMs: 10_000 });
    assert.deepStrictEqual(
      results.map((result) => result.status),
      ['applied', 'applied'],
    );
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
  });

  it('should absorb a second enqueue of the same pending files', async () => {
    three();
    const mq = createQueue();
    const first = await mq.enqueueUp();
    const second = await mq.enqueueUp();

    assert.deepStrictEqual(second.deduplicated, ['0001-a.js', '0002-b.js', '0003-c.js']);
    assert.deepStrictEqual(
      second.jobs.map((job) => job.id),
      first.jobs.map((job) => job.id),
      'a deduplicated add points at the job that will do the work',
    );

    await mq.startWorker();
    // Both callers can wait: they are waiting on the same three jobs.
    const [a, b] = await Promise.all([
      first.wait({ timeoutMs: 10_000 }),
      second.wait({ timeoutMs: 10_000 }),
    ]);
    assert.deepStrictEqual(a.results, b.results);
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c'], 'each migration ran exactly once');
    assert.strictEqual((await mq.enqueueUp()).upToDate, true);
  });

  it('should complete a stale duplicate job as skipped instead of re-applying', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue();
    const group = await mq.enqueueUp();
    // Applied by another route (a CLI run) before the worker gets to the job.
    await mq.kit.up();
    await mq.startWorker();
    const { results } = await group.wait({ timeoutMs: 10_000 });
    assert.strictEqual(results[0].status, 'skipped');
    assert.strictEqual(results[0].reason, 'Already applied');
    assert.deepStrictEqual(await markers(), ['a']);
  });

  it('should keep the order with two workers on the same queue', async () => {
    three();
    const one = createQueue();
    const two = createQueue();
    await Promise.all([one.startWorker(), two.startWorker()]);
    const group = await one.enqueueUp();
    const { results } = await group.wait({ timeoutMs: 15_000 });
    assert.deepStrictEqual(
      results.map((result) => result.status),
      ['applied', 'applied', 'applied'],
    );
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
  });

  // ─── The MongoDB lock ──────────────────────────────────────────────────────

  it('should wait for a run that holds the MongoDB lock, then apply', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue();
    await holdLock();
    const group = await mq.enqueueUp();
    await mq.startWorker();
    setTimeout(() => releaseLock().catch(() => undefined), 150);

    const { results } = await group.wait({ timeoutMs: 10_000 });
    assert.strictEqual(results[0].status, 'applied');
    assert.ok(results[0].lockWaitMs > 0, 'the wait is reported on the result');
    const logs = await harness.logsOf(mq.queue, group.jobs[0].id);
    assert.ok(
      logs.some((row) => /waiting/.test(row)),
      logs.join(' | '),
    );
  });

  it('should fail the job — retryably — when the lock never frees', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue({ lockWait: { lockPollIntervalMs: 20, lockWaitTimeoutMs: 120 } });
    await holdLock();
    const group = await mq.enqueueUp();
    await mq.startWorker();
    const [view] = await settled(mq, [group.jobs[0].id]);
    assert.strictEqual(view.state, 'failed');
    assert.strictEqual(view.progress.code, 'LOCK_ALREADY_HELD');
    assert.deepStrictEqual(await markers(), []);
  });

  // ─── Rolling back ──────────────────────────────────────────────────────────

  it('should roll back the last batch newest-first, one job per migration', async () => {
    three();
    const mq = createQueue();
    await mq.startWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 10_000 });

    const group = await mq.enqueueDown();
    assert.strictEqual(group.direction, 'down');
    assert.strictEqual(group.batch, null);
    assert.deepStrictEqual(
      group.jobs.map((job) => job.migration),
      ['0003-c.js', '0002-b.js', '0001-a.js'],
    );
    const { results } = await group.wait({ timeoutMs: 10_000 });
    assert.deepStrictEqual(
      results.map((result) => result.status),
      ['reverted', 'reverted', 'reverted'],
    );
    assert.deepStrictEqual(await markers(), []);
    assert.ok((await records()).every((record) => record.status === 'reverted'));
  });

  it('should roll back the last N steps, and refuse a rollback that skips newer work', async () => {
    three();
    const mq = createQueue();
    await mq.startWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 10_000 });

    await assert.rejects(mq.enqueueDown('0001-a.js'), (error) => {
      assert.ok(error instanceof MigrationBlockedError);
      assert.deepStrictEqual(error.context.blockedBy, ['0003-c.js', '0002-b.js']);
      return true;
    });

    const oneStep = await mq.enqueueDown(undefined, { steps: 1 });
    assert.deepStrictEqual(
      oneStep.jobs.map((job) => job.migration),
      ['0003-c.js'],
    );
    await oneStep.wait({ timeoutMs: 10_000 });
    assert.deepStrictEqual(await markers(), ['a', 'b']);

    const backTo = await mq.enqueueDown(undefined, { to: '0001-a.js' });
    assert.deepStrictEqual(
      backTo.jobs.map((job) => job.migration),
      ['0002-b.js'],
    );
    await backTo.wait({ timeoutMs: 10_000 });
    assert.deepStrictEqual(await markers(), ['a']);
  });

  it('should refuse, on the worker, a rollback job that skips newer work', async () => {
    three();
    const mq = createQueue(QUICK_BLOCK);
    await mq.startWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 10_000 });

    // The same job, hand-added: the producer's own check is not the only guard.
    const job = await mq.queue.add(
      'down',
      { v: 1, direction: 'down', migration: '0001-a.js', groupId: 'manual', index: 0, total: 1 },
      { attempts: 1 },
    );
    const [view] = await settled(mq, [job.id]);
    assert.strictEqual(view.state, 'failed');
    assert.strictEqual(view.progress.code, 'MIGRATION_BLOCKED');
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
  });

  it('should complete a rollback job for a migration that is not applied as skipped', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue();
    await mq.startWorker();
    const job = await mq.queue.add(
      'down',
      { v: 1, direction: 'down', migration: '0001-a.js', groupId: 'manual', index: 0, total: 1 },
      { attempts: 1 },
    );
    const [view] = await settled(mq, [job.id]);
    assert.strictEqual(view.state, 'completed');
    assert.deepStrictEqual(view.returnvalue, {
      migration: '0001-a.js',
      direction: 'down',
      status: 'skipped',
      reason: 'Not applied',
      lockWaitMs: 0,
    });
  });

  it('should refuse a forced or unordered job its worker does not allow', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue();
    await mq.startWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 10_000 });
    // Hand-added, as anything with write access to Redis could.
    const base = {
      v: 1,
      direction: 'up',
      migration: '0001-a.js',
      groupId: 'x',
      index: 0,
      total: 1,
    };
    const forced = await mq.queue.add('up', { ...base, batch: 9, force: true }, { attempts: 1 });
    const unordered = await mq.queue.add(
      'up',
      { ...base, batch: 9, ordered: false },
      { attempts: 1 },
    );
    const views = await settled(mq, [forced.id, unordered.id]);
    for (const view of views) {
      assert.strictEqual(view.state, 'failed');
      assert.strictEqual(view.progress.code, 'QUEUE_JOB_INVALID', 'refused before it ever ran');
      assert.match(view.failedReason, /is not allowed by this worker/);
    }
    assert.deepStrictEqual(await markers(), ['a'], 'nothing was re-run');
  });

  it('should re-run an applied migration when forced', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue({ allow: { force: true } });
    await mq.startWorker();
    await (await mq.enqueueUp()).wait({ timeoutMs: 10_000 });

    assert.strictEqual((await mq.enqueueUp('0001-a.js')).upToDate, true);
    const forced = await mq.enqueueUp('0001-a.js', { force: true });
    const { results } = await forced.wait({ timeoutMs: 10_000 });
    assert.strictEqual(results[0].status, 'applied');
    assert.deepStrictEqual(await markers(), ['a', 'a']);
    const [record] = await records();
    assert.strictEqual(record.batch, forced.batch);
    assert.ok(record.firstAppliedAt <= record.appliedAt);
  });

  // ─── Untrusted payloads, redaction ─────────────────────────────────────────

  it('should refuse a hand-crafted job whose migration is a path', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue();
    await mq.startWorker();
    const traversal = await mq.queue.add(
      'up',
      {
        v: 1,
        direction: 'up',
        migration: '../../etc/passwd',
        groupId: 'x',
        index: 0,
        total: 1,
        batch: 1,
      },
      { attempts: 1 },
    );
    const future = await mq.queue.add(
      'up',
      { v: 2, direction: 'up', migration: '0001-a.js', groupId: 'x', index: 0, total: 1, batch: 1 },
      { attempts: 1 },
    );
    const views = await settled(mq, [traversal.id, future.id]);
    for (const view of views) {
      assert.strictEqual(view.state, 'failed');
      assert.match(view.failedReason, /Invalid migration job/);
    }
    assert.deepStrictEqual(await markers(), []);
    assert.strictEqual(
      await harness.mongo().db.collection(LOCK_COLLECTION).countDocuments(),
      0,
      'an invalid job never reaches the lock',
    );
  });

  it('should not retry a non-retryable failure even when a job was given attempts', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    write('0002-b.js', insertMigration('things', 'b'));
    const mq = createQueue(QUICK_BLOCK);
    await mq.startWorker();
    // Enqueued some other way, with retries: the blocked job must still fail once.
    const job = await mq.queue.add(
      'up',
      { v: 1, direction: 'up', migration: '0002-b.js', groupId: 'x', index: 0, total: 1, batch: 1 },
      { attempts: 3 },
    );
    const [view] = await settled(mq, [job.id]);
    assert.strictEqual(view.state, 'failed');
    assert.strictEqual(view.attemptsMade, 1);
    assert.strictEqual(view.progress.code, 'MIGRATION_BLOCKED');
  });

  it('should keep credentials out of what the queue stores', async () => {
    write('0001-a.js', leakyMigration());
    const mq = createQueue();
    await mq.startWorker();
    const group = await mq.enqueueUp();
    const [view] = await settled(mq, [group.jobs[0].id]);
    assert.strictEqual(view.state, 'failed');
    assert.ok(!view.failedReason.includes('hunter2'), view.failedReason);
    assert.match(view.failedReason, /admin:\*\*\*\*@/);
    const live = await mq.queue.getJob(group.jobs[0].id);
    assert.ok(!JSON.stringify(live.stacktrace ?? []).includes('hunter2'));
    const logs = await harness.logsOf(mq.queue, group.jobs[0].id);
    assert.ok(logs.length > 0);
    assert.ok(
      logs.every((row) => !row.includes('hunter2')),
      logs.join(' | '),
    );
  });

  // ─── sync and scheduling ───────────────────────────────────────────────────

  it('should plan and enqueue everything pending from a sync job', async () => {
    three();
    const mq = createQueue();
    await mq.startWorker();
    const sync = await mq.queue.add('sync', { v: 1, kind: 'sync' }, { attempts: 1 });
    const [view] = await settled(mq, [sync.id]);
    assert.strictEqual(view.state, 'completed');
    assert.strictEqual(view.returnvalue.kind, 'sync');
    assert.strictEqual(view.returnvalue.enqueued, 3);
    assert.deepStrictEqual(view.returnvalue.migrations, ['0001-a.js', '0002-b.js', '0003-c.js']);

    // The migration jobs the sync job added run after it, in the same queue.
    const deadline = Date.now() + 10_000;
    while ((await markers()).length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
    const batches = new Set((await records()).map((record) => record.batch));
    assert.deepStrictEqual([...batches], [view.returnvalue.batch]);

    const again = await mq.queue.add('sync', { v: 1, kind: 'sync' }, { attempts: 1 });
    const [second] = await settled(mq, [again.id]);
    assert.strictEqual(second.returnvalue.upToDate, true);
    assert.strictEqual(second.returnvalue.enqueued, 0);
  });

  it('should mint the group of a sync job in the configured id format', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    let count = 0;
    const mq = createQueue({ config: { generateId: () => `sync_${++count}` } });
    await mq.startWorker();
    // The group is planned inside the worker, so its id comes from the worker's kit.
    const sync = await mq.queue.add('sync', { v: 1, kind: 'sync' }, { attempts: 1 });
    const [view] = await settled(mq, [sync.id]);
    assert.strictEqual(view.returnvalue.groupId, 'sync_1');

    // Wait for the changelog record itself, not the migration's marker: the
    // body writes the marker first and the record after, so the marker being
    // there says nothing yet about the record.
    const deadline = Date.now() + 10_000;
    let written = await records();
    while (written.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      written = await records();
    }
    assert.deepStrictEqual(
      written.map((record) => record.runId),
      ['sync_2'],
    );
  });

  it('should register and remove a schedule', async () => {
    const mq = createQueue();
    await mq.schedule({ every: 3_600_000 });
    await mq.schedule({ every: 3_600_000 });
    assert.strictEqual(await mq.unschedule(), true);
    assert.strictEqual(await mq.unschedule(), false);
  });

  if (harness.fake) {
    it('should migrate on a scheduler tick', async () => {
      three();
      const mq = createQueue();
      await mq.startWorker();
      await mq.schedule({ every: 60_000, to: '0002-b.js' });
      const tick = await mq.queue._tick('migronaut-sync');
      const [view] = await settled(mq, [tick.id]);
      assert.deepStrictEqual(view.returnvalue.migrations, ['0001-a.js', '0002-b.js']);
      const deadline = Date.now() + 10_000;
      while ((await markers()).length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.deepStrictEqual(await markers(), ['a', 'b']);
    });

    it('should make a stalled job harmless: the re-run finds the work done', async () => {
      write('0001-a.js', slowMigration('things', 'a', 60));
      const mq = createQueue();
      const worker = await mq.startWorker();
      const group = await mq.enqueueUp();
      // As if the worker died mid-migration and BullMQ handed the job on.
      await new Promise((resolve) => mq.kit.once('migration:start', resolve));
      worker._simulateStall(group.jobs[0].id);

      const { results } = await group.wait({ timeoutMs: 10_000 });
      assert.strictEqual(results[0].status, 'skipped');
      assert.deepStrictEqual(await markers(), ['a'], 'applied exactly once');
      assert.strictEqual((await records()).length, 1);
    });
  }

  // ─── Converge jobs ─────────────────────────────────────────────────────────

  const CONVERGING = {
    collections: [{ name: 'things', indexes: [{ key: { marker: 1 } }] }],
    convergeAfterUp: true,
  };
  /** The collection's index names — none while the collection does not exist yet */
  const indexNames = async () => {
    const indexes = await harness
      .mongo()
      .db.collection('things')
      .listIndexes()
      .toArray()
      .catch((error) => {
        if (error.code === 26) return [];
        throw error;
      });
    return indexes.map((index) => index.name).filter((name) => name !== '_id_');
  };
  async function eventually(check, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('condition not reached');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  it('should converge after the last migration of a group, and report it from wait()', async () => {
    three();
    const mq = createQueue({ config: CONVERGING });
    const group = await mq.enqueueUp();
    assert.strictEqual(group.jobs.length, 3);
    assert.strictEqual(group.converge.deduplicated, false);
    const live = await mq.queue.getJob(group.converge.id);
    assert.strictEqual(live.name, 'converge');
    assert.strictEqual(live.data.groupId, group.groupId);
    assert.strictEqual(live.opts.attempts, 1);

    await mq.startWorker();
    const waited = await group.wait({ timeoutMs: 10_000 });
    assert.strictEqual(waited.results.length, 3);
    assert.strictEqual(waited.converge.kind, 'converge');
    assert.strictEqual(waited.converge.groupId, group.groupId);
    assert.strictEqual(waited.converge.inSync, true);
    assert.strictEqual(waited.converge.changed, 1);
    assert.strictEqual(typeof waited.converge.runId, 'string');
    assert.deepStrictEqual(await indexNames(), ['marker_1']);
    const logs = await harness.logsOf(mq.queue, group.converge.id);
    assert.ok(
      logs.some((row) => /create index marker_1 on things/.test(row)),
      logs.join(' | '),
    );
  });

  it('should add a converge-only job when nothing is pending but the database differs', async () => {
    const mq = createQueue({ config: CONVERGING });
    await mq.startWorker();
    const drifted = await mq.enqueueUp();
    assert.strictEqual(drifted.upToDate, true);
    assert.deepStrictEqual(drifted.jobs, []);
    assert.ok(drifted.converge);
    const waited = await drifted.wait({ timeoutMs: 10_000 });
    // The collection, then its index.
    assert.strictEqual(waited.converge.changed, 2);
    assert.deepStrictEqual(await indexNames(), ['marker_1']);

    const settledDown = await mq.enqueueUp();
    assert.strictEqual(settledDown.converge, null, 'in step: no job at all');
  });

  it('should not converge after a group that stops short of the head', async () => {
    three();
    const mq = createQueue({ config: CONVERGING });
    assert.strictEqual((await mq.enqueueUp(undefined, { to: '0002-b.js' })).converge, null);
    assert.strictEqual((await mq.enqueueUp('0001-a.js')).converge, null);
    await assert.rejects(
      mq.enqueueUp(undefined, { to: '0002-b.js', converge: true }),
      ConfigInvalidError,
    );
  });

  it('should fail a converge behind a failed migration as blocked, then converge after the fix', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    write('0002-b.js', failingMigration());
    const mq = createQueue({ config: CONVERGING });
    await mq.startWorker();
    const group = await mq.enqueueUp();
    await assert.rejects(group.wait({ timeoutMs: 10_000 }), QueueJobFailedError);
    const [blocked] = await settled(mq, [group.converge.id]);
    assert.strictEqual(blocked.state, 'failed');
    assert.strictEqual(blocked.progress.code, 'MIGRATION_BLOCKED');
    assert.deepStrictEqual(await indexNames(), []);

    write('0002-b.js', insertMigration('things', 'b'));
    const retry = await mq.enqueueUp();
    const waited = await retry.wait({ timeoutMs: 10_000 });
    assert.strictEqual(waited.converge.inSync, true);
    assert.deepStrictEqual(await indexNames(), ['marker_1']);
  });

  it('should absorb a second enqueue of the same group, converge job included', async () => {
    three();
    const mq = createQueue({ config: CONVERGING });
    const first = await mq.enqueueUp();
    const second = await mq.enqueueUp();
    assert.strictEqual(second.converge.id, first.converge.id);
    assert.strictEqual(second.converge.deduplicated, true);
    await mq.startWorker();
    assert.strictEqual((await second.wait({ timeoutMs: 10_000 })).converge.inSync, true);
  });

  it('should converge after the newer of two overlapping deploys', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    write('0002-b.js', insertMigration('things', 'b'));
    const mq = createQueue({ config: CONVERGING });
    const older = await mq.enqueueUp();
    write('0003-c.js', insertMigration('things', 'c'));
    const newer = await mq.enqueueUp();
    // The newer deploy's converge sits behind its own last migration, not
    // folded into the older one's, which runs while 0003 is still pending.
    assert.notStrictEqual(newer.converge.id, older.converge.id);

    await mq.startWorker();
    await assert.rejects(older.wait({ timeoutMs: 10_000 }), QueueJobFailedError);
    const waited = await newer.wait({ timeoutMs: 10_000 });
    assert.strictEqual(waited.converge.inSync, true);
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
    assert.deepStrictEqual(await indexNames(), ['marker_1']);
  });

  it('should run a converge on its own, waiting out a held lock', async () => {
    const mq = createQueue({ config: { collections: CONVERGING.collections } });
    await holdLock();
    await mq.startWorker();
    const handle = await mq.enqueueConverge();
    assert.strictEqual(handle.deduplicated, false);
    setTimeout(() => {
      releaseLock().catch(() => undefined);
    }, 150);
    const result = await handle.wait({ timeoutMs: 10_000 });
    assert.strictEqual(result.inSync, true);
    assert.ok(result.lockWaitMs > 0);
    assert.deepStrictEqual(await indexNames(), ['marker_1']);
  });

  it('should refuse an ordered converge while a migration is pending, unless told not to', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue({
      config: { collections: CONVERGING.collections },
      ...QUICK_BLOCK,
      allow: { unordered: true },
    });
    await mq.startWorker();
    const ordered = await mq.enqueueConverge();
    await assert.rejects(ordered.wait({ timeoutMs: 10_000 }), (error) => {
      assert.ok(error instanceof QueueJobFailedError);
      assert.strictEqual(error.context.kind, 'converge');
      assert.match(error.context.failedReason, /converge is blocked/);
      return true;
    });
    const unordered = await mq.enqueueConverge({ ordered: false });
    assert.strictEqual((await unordered.wait({ timeoutMs: 10_000 })).inSync, true);
  });

  it('should never take prune from a job payload', async () => {
    await harness.mongo().db.collection('things').createIndex({ stray: 1 });
    const mq = createQueue({ config: { collections: CONVERGING.collections } });
    await mq.startWorker();
    const job = await mq.queue.add(
      'converge',
      { v: 1, kind: 'converge', prune: true, ordered: false },
      { attempts: 1 },
    );
    // Refused outright — not run with the prune quietly ignored.
    const [view] = await settled(mq, [job.id]);
    assert.strictEqual(view.state, 'failed');
    assert.match(view.failedReason, /prune is not accepted from a job/);
    assert.deepStrictEqual(await indexNames(), ['stray_1']);
  });

  it('should converge from a sync tick when nothing is pending but the database differs', async () => {
    const mq = createQueue({ config: CONVERGING });
    await mq.startWorker();
    const sync = await mq.queue.add('sync', { v: 1, kind: 'sync' }, { attempts: 1 });
    const [view] = await settled(mq, [sync.id]);
    assert.strictEqual(view.returnvalue.upToDate, true);
    assert.strictEqual(typeof view.returnvalue.converge.jobId, 'string');
    await eventually(async () => (await indexNames()).length === 1);

    // In step now: the next idle tick adds nothing.
    const again = await mq.queue.add('sync', { v: 1, kind: 'sync' }, { attempts: 1 });
    const [quiet] = await settled(mq, [again.id]);
    assert.ok(!('converge' in quiet.returnvalue));
  });

  it('should register and remove a converge schedule', async () => {
    const mq = createQueue({ config: { collections: CONVERGING.collections } });
    await mq.schedule({ job: 'converge', every: 3_600_000 });
    await assert.rejects(
      mq.schedule({ job: 'converge', every: 1000, to: '0001-a.js' }),
      ConfigInvalidError,
    );
    await assert.rejects(mq.schedule({ job: 'migrate', every: 1000 }), ConfigInvalidError);
    assert.strictEqual(await mq.unschedule(DEFAULT_CONVERGE_SCHEDULER_ID), true);
    assert.strictEqual(await mq.unschedule(DEFAULT_CONVERGE_SCHEDULER_ID), false);
  });

  if (harness.fake) {
    it('should converge on a converge scheduler tick', async () => {
      const mq = createQueue({ config: { collections: CONVERGING.collections } });
      await mq.startWorker();
      await mq.schedule({ job: 'converge', every: 60_000 });
      const tick = await mq.queue._tick(DEFAULT_CONVERGE_SCHEDULER_ID);
      const [view] = await settled(mq, [tick.id]);
      assert.strictEqual(view.returnvalue.kind, 'converge');
      assert.strictEqual(view.progress.kind, 'converge');
      assert.deepStrictEqual(await indexNames(), ['marker_1']);
    });
  }

  // ─── Waiting, cancelling, closing ──────────────────────────────────────────

  it('should time out a wait on a paused queue, and say so', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const mq = createQueue();
    await mq.startWorker();
    await mq.pause();
    const group = await mq.enqueueUp();
    await assert.rejects(group.wait({ timeoutMs: 150 }), (error) => {
      assert.ok(error instanceof QueueJobFailedError);
      assert.strictEqual(error.context.timedOut, true);
      return true;
    });
    assert.deepStrictEqual(await markers(), []);

    await mq.resume();
    const { results } = await group.wait({ timeoutMs: 10_000 });
    assert.strictEqual(results[0].status, 'applied');
  });

  it('should need QueueEvents to wait, and accept one at wait time', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    const { Queue, Worker, QueueEvents } = harness.bullmq();
    const mq = createQueue({ bullmq: { Queue, Worker } });
    await mq.startWorker();
    const group = await mq.enqueueUp();
    await assert.rejects(group.wait(), ConfigInvalidError);

    const queueEvents = new QueueEvents(mq.queueName, {
      connection,
      ...(prefix !== undefined ? { prefix } : {}),
    });
    try {
      const { results } = await group.wait({ queueEvents, timeoutMs: 10_000 });
      assert.strictEqual(results[0].status, 'applied');
    } finally {
      await queueEvents.close();
    }
  });

  it('should hand the cancellation to the migration through its signal', async () => {
    write('0001-a.js', slowMigration('things', 'a', 400));
    const mq = createQueue();
    const worker = await mq.startWorker();
    const group = await mq.enqueueUp();
    await new Promise((resolve) => mq.kit.once('migration:start', resolve));
    assert.strictEqual(worker.cancelJob(group.jobs[0].id, 'operator cancelled'), true);

    // A body already running is never interrupted from outside — it is told,
    // through ctx.signal, and finishes on its own terms.
    const { results } = await group.wait({ timeoutMs: 10_000 });
    assert.strictEqual(results[0].status, 'applied');
    const [doc] = await harness.mongo().db.collection('things').find().toArray();
    assert.strictEqual(doc.aborted, true, 'the migration saw its signal abort');
  });

  it('should finish the migration in flight on close, and resume the rest later', async () => {
    write('0001-a.js', insertMigration('things', 'a'));
    write('0002-b.js', slowMigration('things', 'b', 150));
    write('0003-c.js', insertMigration('things', 'c'));
    const mq = createQueue();
    await mq.startWorker();
    const group = await mq.enqueueUp();
    await new Promise((resolve) => {
      mq.kit.on('migration:start', (event) => {
        if (event.migration === '0002-b.js') resolve();
      });
    });
    await mq.close();

    assert.deepStrictEqual(await markers(), ['a', 'b'], 'the second migration was not cut short');
    await assert.rejects(mq.enqueueUp(), /closed/);

    const next = createQueue();
    assert.deepStrictEqual(
      (await next.status()).map((row) => row.status),
      ['applied', 'applied', 'pending'],
    );
    await next.startWorker();
    const [third] = await settled(next, [group.jobs[2].id]);
    assert.strictEqual(third.state, 'completed');
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
    const batches = new Set((await records()).map((record) => record.batch));
    assert.strictEqual(batches.size, 1, 'the group kept its batch across the restart');
  });

  it('should put a job that a shutdown stops before it starts back in line', async () => {
    three();
    await holdLock();
    const mq = createQueue();
    await mq.startWorker();
    const group = await mq.enqueueUp();
    const first = group.jobs[0].id;
    const deadline = Date.now() + 10_000;
    while ((await mq.getJob(first))?.progress?.phase !== 'lock-wait') {
      if (Date.now() > deadline) throw new Error('the first job never waited for the lock');
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await mq.close();

    // Not failed — so the jobs behind it are not blocked for good.
    const next = createQueue();
    assert.strictEqual((await next.getJob(first)).state, 'waiting');
    await releaseLock();
    await next.startWorker();
    const views = await settled(
      next,
      group.jobs.map((job) => job.id),
    );
    assert.deepStrictEqual(
      views.map((view) => view.state),
      ['completed', 'completed', 'completed'],
    );
    assert.deepStrictEqual(await markers(), ['a', 'b', 'c']);
  });

  it('should read status and the lock straight from MongoDB', async () => {
    three();
    const mq = createQueue();
    assert.deepStrictEqual(
      (await mq.pending()).map((row) => row.file),
      ['0001-a.js', '0002-b.js', '0003-c.js'],
    );
    assert.strictEqual(await mq.lockInfo(), null);
    await holdLock();
    assert.strictEqual((await mq.lockInfo()).executedBy, 'peer');
    await releaseLock();
    assert.strictEqual((await mq.audit()).ok, true);
  });
}

module.exports = { defineBullMQScenarios };
