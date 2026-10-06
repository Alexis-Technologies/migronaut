const assert = require('node:assert/strict');
const { afterEach, beforeEach, it } = require('node:test');

/**
 * The BullMQ semantics the background queue builds on — delayed jobs, parents
 * waiting for their children — checked on bare Queue/Worker objects, with no
 * adapter in between. Run against the in-tree fake and (in the opt-in file)
 * the real library: a scenario that passes on one and fails on the other
 * means the fake models BullMQ wrongly, and every adapter scenario built on it
 * proves nothing.
 *
 * `harness`: the same object `defineBullMQScenarios` takes (`fake`,
 * `bullmq()`, `connection()`, `prefix()`, `obliterate(queue)`).
 */
function defineBullMQFidelityScenarios(harness) {
  let connection;
  let prefix;
  const queues = [];
  const workers = [];

  beforeEach(() => {
    connection = harness.connection();
    prefix = harness.prefix();
  });

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
    for (const queue of queues.splice(0)) {
      await harness.obliterate(queue).catch(() => undefined);
      await queue.close();
    }
  });

  const options = () => ({ connection, ...(prefix !== undefined ? { prefix } : {}) });

  function queue(name, bullmq = harness.bullmq()) {
    const created = new bullmq.Queue(name, options());
    queues.push(created);
    return created;
  }

  function worker(name, processor, bullmq = harness.bullmq()) {
    const created = new bullmq.Worker(name, processor, options());
    workers.push(created);
    return created;
  }

  /** What a processor throws after moving its own job — matched by name, as BullMQ does */
  const moved = (name) => Object.assign(new Error(name), { name });

  /** A job not added yet is `missing` */
  async function stateOf(target, id) {
    const job = await target.getJob(id);
    return job ? job.getState() : 'missing';
  }

  async function until(target, id, wanted, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await stateOf(target, id);
      if (state === wanted) return target.getJob(id);
      if (Date.now() > deadline) throw new Error(`job ${id} is ${state}, not ${wanted}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  it('[fidelity] should hold a delayed job, and rerun one moved to delayed with its updated data', async () => {
    const jobs = queue('delays');
    const runs = [];
    worker('delays', async (job, token) => {
      const step = job.data.step ?? 0;
      runs.push([job.id, step]);
      if (step < 2) {
        await job.updateData({ step: step + 1 });
        await job.moveToDelayed(Date.now() + 30, token);
        throw moved('DelayedError');
      }
      if (job.id === 'flaky' && step === 2) {
        await job.updateData({ step: 3 });
        throw new Error('once');
      }
      return step;
    });
    await jobs.add('later', {}, { jobId: 'later', delay: 150 });
    assert.strictEqual(await stateOf(jobs, 'later'), 'delayed');
    // Two moves, then a failure: the moves used none of its two attempts.
    await jobs.add('flaky', {}, { jobId: 'flaky', attempts: 2 });
    const done = await until(jobs, 'later', 'completed');
    const flaky = await until(jobs, 'flaky', 'completed');
    const stepsOf = (id) => runs.filter(([run]) => run === id).map(([, step]) => step);
    assert.deepStrictEqual(stepsOf('later'), [0, 1, 2]);
    assert.strictEqual(done.returnvalue, 2);
    assert.strictEqual(done.attemptsMade, 1, 'the moves used no attempt, the finish did');
    assert.strictEqual(done.attemptsStarted, 3);
    assert.deepStrictEqual(stepsOf('flaky'), [0, 1, 2, 3]);
    assert.strictEqual(flaky.attemptsMade, 2);
  });

  it('[fidelity] should wake a parent once every child is done, ignoring a failed one when told to', async () => {
    const parents = queue('parents');
    const children = queue('children');
    const finishedAt = new Map();
    worker('children', async (job) => {
      if (job.name === 'slow') await sleep(250);
      finishedAt.set(job.id, Date.now());
      if (job.name === 'bad') throw new Error('child failed');
      return `${job.name}-ok`;
    });
    const parentRuns = [];
    worker('parents', async (job, token) => {
      parentRuns.push(Date.now());
      if (job.data.spawned !== true) {
        await job.updateData({ spawned: true });
        const parent = { id: job.id, queue: parents.qualifiedName };
        await children.addBulk(
          ['fast', 'bad', 'slow'].map((name) => ({
            name,
            data: {},
            opts: { jobId: `${job.id}-${name}`, parent, ignoreDependencyOnFailure: true },
          })),
        );
        if (await job.moveToWaitingChildren(token)) throw moved('WaitingChildrenError');
        throw new Error('the children cannot all be done already');
      }
      return {
        values: await job.getChildrenValues(),
        failures: await job.getIgnoredChildrenFailures(),
        counts: await job.getDependenciesCount(),
      };
    });
    await parents.add('coordinator', {}, { jobId: 'p1' });
    const parent = await until(parents, 'p1', 'completed');
    const key = (name) => `${children.qualifiedName}:p1-${name}`;
    assert.strictEqual(parentRuns.length, 2);
    assert.ok(parentRuns[1] >= finishedAt.get('p1-slow'), 'not before the slowest sibling');
    assert.deepStrictEqual(parent.returnvalue.values, {
      [key('fast')]: 'fast-ok',
      [key('slow')]: 'slow-ok',
    });
    assert.deepStrictEqual(parent.returnvalue.failures, { [key('bad')]: 'child failed' });
    assert.deepStrictEqual(parent.returnvalue.counts, {
      processed: 2,
      unprocessed: 0,
      ignored: 1,
      failed: 0,
    });
  });

  it('[fidelity] should let a parent go on when moveToWaitingChildren finds nothing to wait for', async () => {
    const parents = queue('parents');
    worker('parents', async (job, token) => job.moveToWaitingChildren(token));
    await parents.add('alone', {}, { jobId: 'p1' });
    const done = await until(parents, 'p1', 'completed');
    assert.strictEqual(done.returnvalue, false);
  });

  it('[fidelity] should wake a parent at once after its children, even one delayed before', async () => {
    const parents = queue('parents');
    const children = queue('children');
    const childDone = new Map();
    worker('children', async (job) => {
      await sleep(50);
      childDone.set(job.id, Date.now());
      return 'ok';
    });
    const woke = new Map();
    worker('parents', async (job, token) => {
      const step = job.data.step ?? 0;
      if (step === 0) {
        await job.updateData({ step: 1 });
        await job.moveToDelayed(Date.now() + 600, token);
        throw moved('DelayedError');
      }
      if (step === 1) {
        await job.updateData({ step: 2 });
        const parent = { id: job.id, queue: parents.qualifiedName };
        await children.add('lane', {}, { jobId: `${job.id}-c`, parent });
        if (await job.moveToWaitingChildren(token)) throw moved('WaitingChildrenError');
      }
      woke.set(job.id, Date.now());
      return 'done';
    });
    await parents.add('moved', {}, { jobId: 'p1' });
    await parents.add('added', { step: 1 }, { jobId: 'p2', delay: 600 });
    await until(parents, 'p1', 'completed');
    await until(parents, 'p2', 'completed');
    for (const id of ['p1', 'p2']) {
      const gap = woke.get(id) - childDone.get(`${id}-c`);
      assert.ok(gap < 400, `${id} woke ${gap}ms after its child — its old delay came back`);
    }
  });

  it('[fidelity] should leave a still-delayed parent delayed when its child is done', async () => {
    const parents = queue('parents');
    const children = queue('children');
    worker('children', async () => 'ok');
    await parents.add('held', {}, { jobId: 'p1', delay: 60_000 });
    await children.add(
      'lane',
      {},
      { jobId: 'c1', parent: { id: 'p1', queue: parents.qualifiedName } },
    );
    await until(children, 'c1', 'completed');
    await sleep(100);
    assert.strictEqual(await stateOf(parents, 'p1'), 'delayed');
  });

  it('[fidelity] should strand a parent whose child failed with no failure option', async () => {
    const parents = queue('parents');
    const children = queue('children');
    worker('children', async () => {
      throw new Error('child failed');
    });
    let runs = 0;
    worker('parents', async (job, token) => {
      runs += 1;
      if (runs === 1) {
        const parent = { id: job.id, queue: parents.qualifiedName };
        await children.add('lane', {}, { jobId: 'c1', parent });
      }
      if (await job.moveToWaitingChildren(token)) throw moved('WaitingChildrenError');
      return 'woke';
    });
    await parents.add('coordinator', {}, { jobId: 'p1' });
    await until(children, 'c1', 'failed');
    await sleep(200);
    assert.strictEqual(await stateOf(parents, 'p1'), 'waiting-children');
    assert.strictEqual(runs, 1);
  });

  it('[fidelity] should drop the dependency of a failed child with removeDependencyOnFailure', async () => {
    const parents = queue('parents');
    const children = queue('children');
    worker('children', async () => {
      throw new Error('child failed');
    });
    worker('parents', async (job, token) => {
      if (job.data.spawned !== true) {
        await job.updateData({ spawned: true });
        const parent = { id: job.id, queue: parents.qualifiedName };
        await children.add('lane', {}, { jobId: 'c1', parent, removeDependencyOnFailure: true });
        if (await job.moveToWaitingChildren(token)) throw moved('WaitingChildrenError');
      }
      return job.getDependenciesCount();
    });
    await parents.add('coordinator', {}, { jobId: 'p1' });
    const done = await until(parents, 'p1', 'completed');
    assert.deepStrictEqual(done.returnvalue, {
      processed: 0,
      unprocessed: 0,
      ignored: 0,
      failed: 0,
    });
  });

  it('[fidelity] should refuse a child with no parent, with deduplication, or moved to another parent', async () => {
    const parents = queue('parents');
    const children = queue('children');
    const parent = (id) => ({ id, queue: parents.qualifiedName });
    assert.strictEqual(parents.qualifiedName, `${prefix ?? 'bull'}:parents`);
    await assert.rejects(
      children.add('lane', {}, { jobId: 'c0', parent: parent('nope') }),
      new RegExp(`Missing key for parent job ${parents.qualifiedName}:nope`),
    );
    await parents.add('one', {}, { jobId: 'p1', delay: 60_000 });
    await parents.add('two', {}, { jobId: 'p2', delay: 60_000 });
    await assert.rejects(
      children.add('lane', {}, { parent: parent('p1'), deduplication: { id: 'd' } }),
      /Deduplication and parent options cannot be used together/,
    );
    const first = await children.add('lane', {}, { jobId: 'c1', parent: parent('p1') });
    const again = await children.add('lane', {}, { jobId: 'c1', parent: parent('p1') });
    assert.strictEqual(again.id, first.id);
    assert.deepStrictEqual(await (await parents.getJob('p1')).getDependenciesCount(), {
      processed: 0,
      unprocessed: 1,
      ignored: 0,
      failed: 0,
    });
    await assert.rejects(
      children.add('lane', {}, { jobId: 'c1', parent: parent('p2') }),
      new RegExp(`The parent job ${parents.qualifiedName}:p2 cannot be replaced`),
    );
  });

  it('[fidelity] should bind a finished job re-added under a parent as already processed', async () => {
    const parents = queue('parents');
    const children = queue('children');
    worker('children', async () => 'ok');
    await children.add('lane', {}, { jobId: 'c1' });
    await until(children, 'c1', 'completed');
    await parents.add('late', {}, { jobId: 'p1', delay: 60_000 });
    const bound = await children.add(
      'lane',
      {},
      {
        jobId: 'c1',
        parent: { id: 'p1', queue: parents.qualifiedName },
      },
    );
    assert.strictEqual(bound.id, 'c1');
    assert.deepStrictEqual(await (await parents.getJob('p1')).getDependenciesCount(), {
      processed: 1,
      unprocessed: 0,
      ignored: 0,
      failed: 0,
    });
  });

  if (!harness.fake) return;

  // ─── The fake's own switches ───────────────────────────────────────────────

  it('[fake] should offer no parent support with { flows: false }', async () => {
    const { fakeBullmq } = require('./fake-bullmq.js');
    const bare = fakeBullmq({ flows: false });
    const jobs = queue('bare', bare);
    let seen;
    worker(
      'bare',
      async (job) => {
        seen = typeof job.moveToWaitingChildren;
        return 'ok';
      },
      bare,
    );
    assert.strictEqual(jobs.qualifiedName, undefined);
    const added = await jobs.add('one', {});
    await until(jobs, added.id, 'completed');
    assert.strictEqual(seen, 'undefined');
  });

  it('[fake] should lose every key of the fake server, and refuse the unmodelled failure options', async () => {
    const parents = queue('parents');
    const children = queue('children');
    await parents.add('one', {}, { jobId: 'p1', delay: 60_000 });
    await children.add('two', {}, { jobId: 'c1' });
    parents._promoteDelayed();
    assert.deepStrictEqual(parents._state().wait, ['p1']);
    parents._loseRedis();
    assert.strictEqual(await parents.getJob('p1'), undefined);
    assert.strictEqual(await children.getJob('c1'), undefined);
    for (const option of ['failParentOnFailure', 'continueParentOnFailure']) {
      await assert.rejects(children.add('x', {}, { [option]: true }), /is not modelled/);
    }
  });
}

module.exports = { defineBullMQFidelityScenarios };
