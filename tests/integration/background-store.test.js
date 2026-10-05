const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const { ObjectId } = require('mongodb');
const { BackgroundStore, STATE_SCHEMA } = require('../../src/core/background-store.js');
const { runWithLock } = require('../../src/core/lock.js');
const { LockLostError } = require('../../src/errors/index.js');
const { silentLogger } = require('../../src/utils/logger.js');
const { startTestMongo } = require('../helpers/mongo.js');

let mongo;
let store;
const DB = 'migronaut_background_store_test';
const NAME = '0001-orders.js';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  store = new BackgroundStore(mongo.db, '_migronaut_background');
  await store.ensureIndexes();
});

const partitionsOf = (count) =>
  Array.from({ length: count }, (_, i) => ({
    scope: { kind: 'id-range', bracket: 'number', gte: i * 10, lt: (i + 1) * 10 },
    estimate: 100 - i,
  }));

/** Register and commit a first plan of `count` partitions */
async function planned(count, name = NAME) {
  await store.register(name, { status: 'pending', mode: 'declarative', direction: 'forward' });
  return store.commitPlan(name, {
    generation: 0,
    plan: { partitioner: 'id', method: 'match-first', estimate: count * 10 },
    partitions: partitionsOf(count),
    fields: { status: 'running' },
  });
}

const claimArgs = (state, extra = {}) => ({
  generation: state.generation,
  plan: state.plan.token,
  maxParallel: 3,
  ttlMs: 60_000,
  ...extra,
});

describe('BackgroundStore — registration and state (integration)', () => {
  it('should register a fresh state and drop the partitions of the old one', async () => {
    const first = await planned(2);
    assert.strictEqual(first.generation, 1);
    assert.strictEqual(first.phase, 'process');
    assert.strictEqual((await store.partitions(NAME)).length, 2);
    const again = await store.register(NAME, { status: 'blocked' });
    assert.notStrictEqual(again.registration, first.registration);
    assert.strictEqual(again.schema, STATE_SCHEMA);
    assert.strictEqual((await store.partitions(NAME)).length, 0);
    const stored = await store.get(NAME);
    assert.strictEqual(stored.status, 'blocked');
    assert.deepStrictEqual(
      stored.history.map((entry) => entry.to),
      ['blocked'],
    );
  });

  it('should move a state only from the expected statuses, keeping its history', async () => {
    await store.register(NAME, { status: 'pending' });
    const paused = await store.move(NAME, {
      from: ['pending', 'running'],
      to: 'paused',
      action: 'pause',
      by: '$ops',
      reason: 'night',
      fields: { control: { action: 'pause' } },
    });
    assert.strictEqual(paused.status, 'paused');
    assert.deepStrictEqual(paused.control, { action: 'pause' });
    const last = paused.history.at(-1);
    assert.deepStrictEqual(
      { action: last.action, from: last.from, to: last.to, by: last.by, reason: last.reason },
      { action: 'pause', from: 'pending', to: 'paused', by: '$ops', reason: 'night' },
    );
    assert.strictEqual(
      await store.move(NAME, { from: ['running'], to: 'completed', action: 'complete' }),
      null,
    );
    for (let i = 0; i < 60; i++) {
      await store.move(NAME, {
        from: ['paused', 'pending'],
        to: i % 2 ? 'paused' : 'pending',
        action: 'x',
      });
    }
    assert.strictEqual((await store.get(NAME)).history.length, 50);
    assert.ok(await store.set(NAME, { note: 1 }));
    assert.ok(!(await store.set('missing.js', { note: 1 })));
    assert.deepStrictEqual(
      (await store.list({ status: 'paused' })).map((doc) => doc._id),
      [NAME],
    );
    assert.ok(await store.remove(NAME));
    assert.strictEqual(await store.get(NAME), null);
  });

  it("should let only one of two racing plans commit, removing the loser's partitions", async () => {
    const state = await planned(2);
    const [a, b] = await Promise.all([
      store.commitPlan(NAME, {
        generation: state.generation,
        previousToken: state.plan.token,
        plan: { partitioner: 'id' },
        partitions: partitionsOf(3),
      }),
      store.commitPlan(NAME, {
        generation: state.generation,
        previousToken: state.plan.token,
        plan: { partitioner: 'id' },
        partitions: partitionsOf(4),
      }),
    ]);
    const winner = a ?? b;
    assert.ok((a === null) !== (b === null), 'exactly one plan commits');
    assert.strictEqual(winner.generation, 2);
    const current = await store.partitions(NAME, { generation: 2 });
    assert.ok(current.every((partition) => partition.plan === winner.plan.token));
    assert.strictEqual(current.length, winner.plan.partitions);
  });
});

describe('BackgroundStore — leases and slots (integration)', () => {
  it('should hand out at most maxParallel leases to 30 concurrent claims', async () => {
    const state = await planned(12);
    const results = await Promise.all(
      Array.from({ length: 30 }, () => store.claim(NAME, claimArgs(state))),
    );
    const leased = results.filter((result) => result.partition);
    assert.strictEqual(leased.length, 3);
    assert.deepStrictEqual(leased.map((result) => result.partition.lease.slot).sort(), [0, 1, 2]);
    assert.ok(results.every((result) => result.partition || result.busy));
    const counts = await store.partitionCounts(NAME, {
      generation: state.generation,
      plan: state.plan.token,
    });
    assert.strictEqual(counts.leased, 3);
    assert.strictEqual(counts.running, 3);
    assert.strictEqual(counts.pending, 9);
    // The largest partitions are taken first.
    assert.deepStrictEqual(leased.map((result) => result.partition.seq).sort(), [0, 1, 2]);
  });

  it('should resume a started partition first and report exhaustion', async () => {
    const state = await planned(2);
    const first = await store.claim(NAME, claimArgs(state));
    await store.checkpoint(first.lease, { cursor: { lastId: 5 }, counters: { migrated: 3 } });
    await first.lease.release();
    const again = await store.claim(NAME, claimArgs(state));
    assert.strictEqual(String(again.partition._id), String(first.partition._id));
    assert.deepStrictEqual(again.partition.cursor, { lastId: 5 });
    await store.checkpoint(again.lease, { done: true });
    const second = await store.claim(NAME, claimArgs(state));
    await store.checkpoint(second.lease, { done: true });
    assert.deepStrictEqual(await store.claim(NAME, claimArgs(state)), { exhausted: true });
  });

  it('should reap a lease not renewed within its TTL, in server time, and fence its holder', async () => {
    const state = await planned(1);
    const claimed = await store.claim(NAME, claimArgs(state, { ttlMs: 1000 }));
    // The holder stalls past its TTL (a GC pause, a dead pod).
    await mongo.db
      .collection('_migronaut_background_partitions')
      .updateOne({ _id: claimed.partition._id }, { $set: { 'lease.renewedAt': new Date(0) } });
    const taken = await store.claim(NAME, claimArgs(state));
    assert.ok(taken.partition, 'reclaimed');
    assert.strictEqual(taken.partition.reclaims, 1);
    await assert.rejects(
      store.checkpoint(claimed.lease, { cursor: { lastId: 1 } }),
      (error) => error instanceof LockLostError && error.context.lease === true,
    );
    assert.strictEqual(await claimed.lease.renew(), true, 'skipped: touched a moment ago');
    // Nothing of the stale holder landed; the new holder goes on.
    await store.checkpoint(taken.lease, { cursor: { lastId: 2 } });
    const [stored] = await store.partitions(NAME);
    assert.deepStrictEqual(stored.cursor, { lastId: 2 });
    assert.deepStrictEqual(await store.leases(NAME), { held: 1, live: 1 });
  });

  it('should heartbeat a lease through runWithLock and release it at the end', async () => {
    const state = await planned(1);
    const claimed = await store.claim(NAME, claimArgs(state, { ttlMs: 400 }));
    await runWithLock(claimed.lease, { logger: silentLogger }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    const [stored] = await store.partitions(NAME);
    assert.strictEqual(stored.lease, undefined);
    assert.strictEqual(stored.reclaims, 0, 'renewed in time, never reaped');
  });

  it('should stop handing out slots above a lowered maxParallel', async () => {
    const state = await planned(6);
    for (let i = 0; i < 3; i++) await store.claim(NAME, claimArgs(state));
    assert.ok((await store.claim(NAME, claimArgs(state, { maxParallel: 2 }))).busy);
    const leased = await store.partitions(NAME, { 'lease.slot': { $exists: true } });
    const high = leased.find((partition) => partition.lease.slot === 2);
    await store.lease(high._id, high.lease.token, 60_000).release();
    assert.ok(
      (await store.claim(NAME, claimArgs(state, { maxParallel: 2 }))).busy,
      'slots 0 and 1 still held',
    );
    assert.deepStrictEqual(await store.leases(NAME), { held: 2, live: 2 });
    assert.strictEqual(await store.unlockAll(NAME), 2);
    assert.ok((await store.claim(NAME, claimArgs(state, { maxParallel: 2 }))).partition);
  });

  it('should cap the leases per group (shard)', async () => {
    await store.register(NAME, { status: 'pending' });
    const state = await store.commitPlan(NAME, {
      generation: 0,
      plan: { partitioner: 'shard' },
      partitions: [
        { scope: { kind: 'step' }, group: 'shardA' },
        { scope: { kind: 'step' }, group: 'shardA' },
        { scope: { kind: 'step' }, group: 'shardB' },
      ],
    });
    const args = claimArgs(state, { shardConcurrency: 1 });
    const first = await store.claim(NAME, args);
    const second = await store.claim(NAME, args);
    assert.notStrictEqual(first.partition.group, second.partition.group);
    assert.match(first.partition.lease.groupSlot, /^shard[AB]#0$/);
    assert.deepStrictEqual(await store.claim(NAME, args), { exhausted: true });
  });

  it('should answer racing claims on full shards as exhausted, not busy', async () => {
    await store.register(NAME, { status: 'pending' });
    const partitions = [];
    for (let i = 0; i < 4; i++) partitions.push({ scope: { kind: 'step' }, group: 'shardA' });
    for (let i = 0; i < 4; i++) partitions.push({ scope: { kind: 'step' }, group: 'shardB' });
    const state = await store.commitPlan(NAME, {
      generation: 0,
      plan: { partitioner: 'shard' },
      partitions,
    });
    const args = claimArgs(state, { maxParallel: 6, shardConcurrency: 1 });
    const results = await Promise.all(Array.from({ length: 6 }, () => store.claim(NAME, args)));
    const groups = new Set();
    let exhausted = 0;
    for (const result of results) {
      if (result.partition) groups.add(result.partition.group);
      else if (result.exhausted) exhausted += 1;
      else assert.fail(`unexpected ${JSON.stringify(result)}`);
    }
    assert.deepStrictEqual([...groups].sort(), ['shardA', 'shardB']);
    assert.strictEqual(exhausted, 4);
  });

  it('should share one set of group slots among partitions with no group', async () => {
    await store.register(NAME, { status: 'pending' });
    const state = await store.commitPlan(NAME, {
      generation: 0,
      plan: { partitioner: 'shard' },
      partitions: [{ scope: { kind: 'step' } }, { scope: { kind: 'step' } }],
    });
    const args = claimArgs(state, { shardConcurrency: 1 });
    const first = await store.claim(NAME, args);
    assert.strictEqual(first.partition.lease.groupSlot, '#0');
    assert.deepStrictEqual(await store.claim(NAME, args), { exhausted: true });
  });
});

describe('BackgroundStore — checkpoints, failures and roll-up (integration)', () => {
  it('should add counters, keep bad ids and errors, and close a done partition', async () => {
    const state = await planned(1);
    const { lease } = await store.claim(NAME, claimArgs(state));
    const bad = new ObjectId();
    await store.checkpoint(lease, {
      cursor: { lastId: '$weird' },
      counters: { scanned: 10, migrated: 8, conflicts: 2, failed: 0 },
      badIds: [bad],
      docErrors: [{ error: 'boom' }],
      throttle: { batchSize: 250, pauseMs: 200 },
    });
    await store.checkpoint(lease, {
      counters: { scanned: 5, migrated: 5 },
      badIds: [bad],
      done: true,
    });
    const [partition] = await store.partitions(NAME);
    assert.strictEqual(partition.status, 'done');
    assert.strictEqual(partition.lease, undefined);
    assert.deepStrictEqual(partition.cursor, { lastId: '$weird' });
    assert.deepStrictEqual(partition.counters, { scanned: 15, migrated: 13, conflicts: 2 });
    assert.strictEqual(partition.badIds.length, 1);
    assert.deepStrictEqual(partition.throttle, { batchSize: 250, pauseMs: 200 });
    const rolled = await store.generationTotals(NAME, state.generation);
    assert.strictEqual(rolled.totals.migrated, 13);
    assert.strictEqual(rolled.totals.failedPartitions, 0);
    assert.strictEqual(rolled.badIds.length, 1);
    assert.deepStrictEqual(rolled.docErrors, [{ error: 'boom' }]);
    assert.strictEqual(await store.generationTotals(NAME, 99), null);
  });

  it('should count a failed slice after its lease was released, but not a fenced one', async () => {
    const state = await planned(1);
    const first = await store.claim(NAME, claimArgs(state));
    await first.lease.release();
    assert.strictEqual(
      await store.failSlice(first.lease, { error: 'x', maxSliceFailures: 1 }),
      true,
    );
    await store.setOpenPartitions(NAME, {
      generation: state.generation,
      plan: state.plan.token,
      from: ['failed'],
      status: 'pending',
    });
    const stale = await store.claim(NAME, claimArgs(state));
    await stale.lease.release();
    const current = await store.claim(NAME, claimArgs(state));
    // Another lane holds it now: the stale lane's failure is not the partition's.
    assert.strictEqual(
      await store.failSlice(stale.lease, { error: 'y', maxSliceFailures: 1 }),
      false,
    );
    assert.strictEqual((await store.partitions(NAME))[0].status, 'running');
    await current.lease.release();
  });

  it('should fail a partition after maxSliceFailures failed slices', async () => {
    const state = await planned(1);
    for (let i = 1; i <= 3; i++) {
      const { lease } = await store.claim(NAME, claimArgs(state));
      const failed = await store.failSlice(lease, { error: `slice ${i}`, maxSliceFailures: 3 });
      assert.strictEqual(failed, i === 3);
    }
    const [partition] = await store.partitions(NAME);
    assert.strictEqual(partition.status, 'failed');
    assert.strictEqual(partition.lastError, 'slice 3');
    assert.deepStrictEqual(await store.claim(NAME, claimArgs(state)), { exhausted: true });
    // A retry puts it back in play.
    assert.strictEqual(
      await store.setOpenPartitions(NAME, {
        generation: state.generation,
        plan: state.plan.token,
        from: ['failed'],
        status: 'pending',
      }),
      1,
    );
    const { lease } = await store.claim(NAME, claimArgs(state));
    await store.failPartition(lease, { error: 'budget' });
    assert.strictEqual((await store.partitions(NAME))[0].status, 'failed');
  });

  it('should supersede open partitions and drop old generations and foreign plans', async () => {
    const state = await planned(3);
    const { lease } = await store.claim(NAME, claimArgs(state));
    await store.checkpoint(lease, { done: true });
    assert.strictEqual(
      await store.supersede(NAME, { generation: state.generation, plan: state.plan.token }),
      2,
    );
    const next = await store.commitPlan(NAME, {
      generation: state.generation,
      previousToken: state.plan.token,
      plan: { partitioner: 'id' },
      partitions: partitionsOf(1),
    });
    assert.strictEqual(await store.dropForeignPlans(NAME, next.plan.token), 2);
    assert.strictEqual(
      await store.dropGenerations(NAME, next.generation, { keep: next.generation }),
      1,
    );
    assert.deepStrictEqual(
      (await store.partitions(NAME)).map((partition) => partition.generation),
      [2],
    );
  });
});
