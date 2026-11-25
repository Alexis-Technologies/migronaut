const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { processPartition } = require('../../src/core/background-engine.js');
const { idRangePartitioner } = require('../../src/core/background-partition.js');
const { MAX_STUCK, createShardPartitioner } = require('../../src/core/background-shard.js');
const { resolveBackgroundSpec } = require('../../src/core/background-spec.js');

const NAME = '0001-orders.js';

/** A job over `orders`, one document per transaction, split along a hashed shard key */
const drainingJob = () => {
  const { spec, fns } = resolveBackgroundSpec(
    {
      collection: 'orders',
      from: 1,
      to: 2,
      migrate: (doc) => ({ ...doc, moved: true }),
      transaction: { timeoutMs: 1000, maxRetries: 2 },
      batchSize: 1,
      pauseMs: 0,
      adaptive: false,
    },
    { name: NAME },
  );
  return {
    name: NAME,
    spec,
    fns,
    direction: 'forward',
    match: { __v: 1 },
    generation: 1,
    partitionId: 'p1',
    partitioner: createShardPartitioner({ key: { region: 'hashed' }, field: '__v', source: 1 }),
  };
};

/** What a lane hands the engine, over a collection that reads `docs` and whose writes match nothing */
const laneContext = ({ docs, cursor }) => {
  const checkpoints = [];
  const retries = [];
  const session = {
    startTransaction() {},
    commitTransaction: async () => undefined,
    abortTransaction: async () => undefined,
    endSession: async () => undefined,
  };
  return {
    checkpoints,
    retries,
    store: {
      checkpoint: async (_lease, update) => {
        checkpoints.push(update);
      },
      countBadIds: async () => 0,
    },
    lease: { touch() {} },
    partition: { _id: 'p1', plan: 't1', scope: { kind: 'key-range', min: {}, max: {} }, cursor },
    db: {
      collection: () => ({
        find: () => ({ toArray: async () => docs }),
        // The application wrote the document the transaction read: the
        // guarded write matches nothing, every time.
        bulkWrite: async () => ({ matchedCount: 0 }),
      }),
    },
    client: { startSession: () => session },
    deadline: Date.now() + 60_000,
    throttle: { beforeBatch: async () => undefined },
    readControl: async () => ({ status: 'running', generation: 1, plan: { token: 't1' } }),
    onTransactionRetries: (count) => retries.push(count),
  };
};

describe('processPartition — a failed document past a batch that was halved', () => {
  it('should record it once, with the batch that reaches it', async () => {
    const { spec, fns } = resolveBackgroundSpec(
      {
        collection: 'orders',
        from: 1,
        to: 2,
        migrate: (doc) => {
          if (doc._id === 'd2') throw new Error('bad document');
          return { ...doc, moved: true };
        },
        transaction: { timeoutMs: 1000, maxRetries: 4 },
        batchSize: 2,
        pauseMs: 0,
        adaptive: false,
        maxDocumentErrors: 10,
      },
      { name: NAME },
    );
    const job = {
      name: NAME,
      spec,
      fns,
      direction: 'forward',
      match: { __v: 1 },
      generation: 1,
      partitionId: 'p1',
      partitioner: idRangePartitioner,
    };
    const all = [
      { _id: 'd1', __v: 1 },
      { _id: 'd2', __v: 1 },
    ];
    const done = new Set();
    const ctx = laneContext({ docs: all, cursor: undefined });
    ctx.partition.scope = { kind: 'id-range', bracket: 'string' };
    ctx.store.checkpoint = async (_lease, update) => {
      ctx.checkpoints.push(update);
      for (const id of update.badIds ?? []) done.add(id);
    };
    let tooBig = true;
    ctx.db = {
      collection: () => ({
        find: (_filter, options) => ({
          toArray: async () => all.filter((doc) => !done.has(doc._id)).slice(0, options.limit),
        }),
        bulkWrite: async (ops) => {
          // Once: the transaction grew too big — the batch is halved, and d2
          // (already known to fail) is no longer part of it.
          if (tooBig) {
            tooBig = false;
            throw Object.assign(new Error('transaction too large'), { code: 334 });
          }
          for (const op of ops) done.add(op.updateOne.filter._id);
          return { matchedCount: ops.length };
        },
      }),
    };
    const result = await processPartition(job, ctx);
    assert.strictEqual(result.outcome, 'exhausted');
    // d1 alone, then d2 alone: d2's failure belongs to the second commit only.
    const recorded = ctx.checkpoints.map((update) => [update.badIds, update.counters.failed]);
    assert.deepStrictEqual(recorded.slice(0, 2), [
      [[], 0],
      [['d2'], 1],
    ]);
    assert.strictEqual(result.counters.failed, 1);
    assert.strictEqual(result.counters.migrated, 1);
  });
});

describe('processPartition — a secondary that lags for the rest of the slice', () => {
  it('should yield without reading a batch, and hand the wait to onThrottle', async () => {
    const ctx = laneContext({ docs: [{ _id: 'd1', __v: 1, region: 'eu' }], cursor: undefined });
    const asked = [];
    const heard = [];
    ctx.onThrottle = (change) => heard.push(change);
    ctx.throttle = {
      beforeBatch: async (options) => {
        asked.push(options);
        options.onLag({ reason: 'lag', lagMs: 9000, waitedMs: 0 });
        return { expired: true };
      },
    };
    const result = await processPartition(drainingJob(), ctx);
    assert.strictEqual(result.outcome, 'yielded');
    assert.deepStrictEqual(result.counters, {});
    assert.strictEqual(ctx.checkpoints.length, 0, 'nothing was read or written');
    assert.strictEqual(asked[0].deadline, ctx.deadline);
    assert.deepStrictEqual(heard, [{ reason: 'lag', lagMs: 9000, waitedMs: 0 }]);
  });
});

describe('processPartition — a transactional batch of one, still in the way', () => {
  const doc = { _id: 'd-last', __v: 1, region: 'eu' };

  it('should close a draining partition that has nothing left to step over', async () => {
    // One more than a draining range may carry: `past` answers "done".
    const stuck = Array.from({ length: MAX_STUCK }, (_, i) => `d${i}`);
    const cursor = { region: 0, stuck };
    const ctx = laneContext({ docs: [doc], cursor });
    const result = await processPartition(drainingJob(), ctx);
    assert.strictEqual(result.outcome, 'exhausted');
    assert.strictEqual(ctx.checkpoints.length, 1);
    const [checkpoint] = ctx.checkpoints;
    // It used to write `cursor: null` and leave the partition running: the
    // next lane started it again from its first document.
    assert.strictEqual(checkpoint.done, true);
    assert.deepStrictEqual(checkpoint.cursor, cursor);
    assert.deepStrictEqual(checkpoint.counters, {
      scanned: 1,
      conflicts: 1,
      batches: 1,
      txnRetries: 1,
    });
    assert.deepStrictEqual(ctx.retries, [1]);
  });

  it('should step over it and go on while the range may still carry more', async () => {
    const ctx = laneContext({ docs: [doc], cursor: { region: 0, stuck: ['d0'] } });
    // One batch, then the slice ends.
    let batches = 0;
    ctx.onBatch = () => {
      batches += 1;
      ctx.deadline = 0;
    };
    const result = await processPartition(drainingJob(), ctx);
    assert.strictEqual(result.outcome, 'yielded');
    assert.strictEqual(batches, 1);
    const [checkpoint] = ctx.checkpoints;
    assert.strictEqual(checkpoint.done, false);
    assert.deepStrictEqual(checkpoint.cursor, { region: 0, stuck: ['d0', 'd-last'] });
  });
});
