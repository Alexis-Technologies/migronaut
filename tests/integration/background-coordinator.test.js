const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const { ObjectId } = require('mongodb');
const {
  control,
  coordinate,
  finalize,
  jobFor,
  repin,
  runSlice,
  waitForLanes,
} = require('../../src/core/background.js');
const { matchHash, resolveBackgroundSpec } = require('../../src/core/background-spec.js');
const { BackgroundStore } = require('../../src/core/background-store.js');
const { MigrationLock } = require('../../src/core/lock.js');
const { BackgroundConflictError, ChecksumMismatchError } = require('../../src/errors/index.js');
const { silentLogger } = require('../../src/utils/logger.js');
const { startTestMongo } = require('../helpers/mongo.js');

let mongo;
const DB = 'migronaut_background_coordinator_test';
const NAME = '0001-orders.js';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  await mongo.db.collection('orders').createIndex({ __v: 1, _id: 1 });
});

const moveAddress = ({ address, ...doc }) => ({ ...doc, shipping: { address } });

/** What the kit injects, over in-memory "files" */
function makeDeps(files) {
  const events = [];
  const store = new BackgroundStore(mongo.db, '_migronaut_background');
  const deps = {
    db: mongo.db,
    client: mongo.client,
    store,
    events,
    files,
    logger: silentLogger,
    fields: (extra) => extra,
    emit: (event, payload) => events.push([event, payload]),
    lockFor: (name) =>
      new MigrationLock(mongo.db, '_migronaut_locks', 60, {
        id: `background:${name}`,
        label: 'background coordinator lock',
      }),
    load: async (name) => {
      const file = files[name];
      if (file === undefined) {
        throw Object.assign(new Error('gone'), { code: 'MIGRATION_FILE_NOT_FOUND' });
      }
      const { spec, fns } = resolveBackgroundSpec(file.background, { name });
      return { spec, fns, checksum: file.checksum ?? 'c1' };
    },
    ttlMs: 60_000,
    warned: new Set(),
    adaptiveCache: new Map(),
  };
  return deps;
}

async function register(deps, name, status = 'pending') {
  await deps.store.ensureIndexes();
  const { spec } = await deps.load(name);
  return deps.store.register(name, {
    status,
    mode: spec.mode,
    direction: 'forward',
    spec,
    checksum: deps.files[name].checksum ?? 'c1',
    requires: deps.files[name].requires ?? [],
    waitsFor: [],
  });
}

/** Drive a background migration the way a runtime would, until the coordinator is done */
async function drive(deps, name, { lanes = 2, maxSteps = 50 } = {}) {
  for (let step = 0; step < maxSteps; step++) {
    const answer = await coordinate(deps, name);
    if (answer.next === 'done') return answer;
    if (answer.next === 'process') {
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          for (;;) {
            const slice = await runSlice(deps, name, { sliceMs: 60_000 });
            if (slice.outcome !== 'yielded') return slice;
          }
        }),
      );
    } else if (answer.next !== 'wait') {
      throw new Error(`unexpected answer ${JSON.stringify(answer)}`);
    }
  }
  throw new Error('did not finish');
}

async function seed(count, extra = () => ({})) {
  const docs = Array.from({ length: count }, (_, i) => ({
    _id: new ObjectId(),
    __v: 1,
    __rev: 0,
    address: `A${i}`,
    ...extra(i),
  }));
  await mongo.db.collection('orders').insertMany(docs);
  return docs;
}

describe('background coordinator (integration)', () => {
  it('should plan, run lanes in parallel and complete', async () => {
    await seed(3000);
    const deps = makeDeps({
      [NAME]: {
        background: {
          collection: 'orders',
          from: 1,
          to: 2,
          migrate: moveAddress,
          maxParallel: 3,
          batchSize: 200,
          pauseMs: 0,
          partitions: { minPartitionDocs: 100 },
        },
      },
    });
    await register(deps, NAME);
    const done = await drive(deps, NAME, { lanes: 3 });
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(
      await mongo.db.collection('orders').countDocuments({ __v: 2, __rev: 1 }),
      3000,
    );
    const state = await deps.store.get(NAME);
    assert.strictEqual(state.totals.migrated, 3000);
    assert.strictEqual(state.pass, 1);
    assert.ok(state.plan.partitions > 1);
    const names = deps.events.map(([event]) => event);
    assert.ok(names.includes('background:partitioned'));
    assert.ok(names.includes('background:completed'));
    assert.ok(names.includes('background:batch'));
    // The last generation's partitions stay, for status.
    assert.ok((await deps.store.partitions(NAME)).every((p) => p.generation === state.generation));
  });

  it('should take another pass over documents an old writer left in the old shape', async () => {
    const docs = await seed(200);
    let wrote = false;
    const deps = makeDeps({
      [NAME]: {
        background: {
          collection: 'orders',
          from: 1,
          to: 2,
          batchSize: 50,
          pauseMs: 0,
          migrate: async (doc) => {
            if (!wrote) {
              wrote = true;
              // An old pod still inserts version 1 documents.
              await mongo.db
                .collection('orders')
                .insertMany(
                  Array.from({ length: 30 }, (_, i) => ({ __v: 1, __rev: 0, address: `late${i}` })),
                );
            }
            return moveAddress(doc);
          },
        },
      },
    });
    await register(deps, NAME);
    const done = await drive(deps, NAME, { lanes: 1 });
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 1 }), 0);
    const state = await deps.store.get(NAME);
    assert.ok(state.pass >= 1);
    assert.strictEqual(state.totals.migrated, docs.length + 30);
  });

  it('should fail once old-shape documents keep appearing for maxPasses passes', async () => {
    await seed(20);
    const deps = makeDeps({
      [NAME]: {
        background: {
          collection: 'orders',
          from: 1,
          to: 2,
          maxPasses: 2,
          pauseMs: 0,
          migrate: async (doc) => {
            await mongo.db.collection('orders').insertOne({ __v: 1, __rev: 0, address: 'again' });
            return moveAddress(doc);
          },
        },
      },
    });
    await register(deps, NAME);
    const done = await drive(deps, NAME, { lanes: 1 });
    assert.strictEqual(done.status, 'failed');
    assert.match(done.error, /keep appearing after 2 pass/);
    assert.ok(deps.events.some(([event]) => event === 'background:failed'));
  });

  it('should complete at once when nothing matches, and run a step migration', async () => {
    const deps = makeDeps({
      [NAME]: { background: { collection: 'orders', from: 1, to: 2, migrate: moveAddress } },
      '0002-step.js': {
        background: {
          step: async ({ checkpoint }) => ({
            checkpoint: (checkpoint ?? 0) + 1,
            done: checkpoint === 2,
          }),
        },
      },
    });
    await register(deps, NAME);
    assert.strictEqual((await drive(deps, NAME)).status, 'completed');
    await register(deps, '0002-step.js');
    assert.strictEqual((await drive(deps, '0002-step.js', { lanes: 1 })).status, 'completed');
  });

  it('should pause, resume, cancel and retry — the same generation, or from the start', async () => {
    await seed(500);
    const files = {
      [NAME]: {
        background: {
          collection: 'orders',
          from: 1,
          to: 2,
          batchSize: 50,
          pauseMs: 0,
          maxParallel: 2,
          partitions: { minPartitionDocs: 50 },
          migrate: moveAddress,
        },
      },
    };
    const deps = makeDeps(files);
    await register(deps, NAME);
    assert.strictEqual((await coordinate(deps, NAME)).next, 'process');
    assert.deepStrictEqual(await control(deps, NAME, 'pause', { requestedBy: 'ops' }), {
      applied: 'changed',
      status: 'paused',
    });
    assert.strictEqual((await runSlice(deps, NAME)).outcome, 'paused');
    assert.strictEqual((await coordinate(deps, NAME)).next, 'done');
    assert.deepStrictEqual(await control(deps, NAME, 'pause'), {
      applied: 'unchanged',
      status: 'paused',
    });
    assert.deepStrictEqual(await control(deps, NAME, 'resume'), {
      applied: 'changed',
      status: 'running',
    });
    assert.ok(await waitForLanes(deps, NAME, { timeoutMs: 1000 }));

    // A lane gets halfway, then the migration is cancelled and retried.
    const slice = await runSlice(deps, NAME, { sliceMs: 1 });
    assert.ok(['yielded', 'exhausted'].includes(slice.outcome));
    assert.deepStrictEqual(await control(deps, NAME, 'cancel'), {
      applied: 'changed',
      status: 'cancelled',
    });
    assert.strictEqual((await runSlice(deps, NAME)).outcome, 'cancelled');
    await assert.rejects(control(deps, NAME, 'pause'), BackgroundConflictError);
    const before = await deps.store.get(NAME);
    assert.deepStrictEqual(await control(deps, NAME, 'retry'), {
      applied: 'changed',
      status: 'pending',
    });
    assert.strictEqual((await drive(deps, NAME)).status, 'completed');
    const after = await deps.store.get(NAME);
    assert.strictEqual(after.generation, before.generation, 'the same generation went on');
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 1 }), 0);

    // A completed one retried is reopened, over whatever is left.
    await mongo.db.collection('orders').updateMany({}, { $set: { __v: 1 } });
    assert.deepStrictEqual(await control(deps, NAME, 'retry', { fromStart: true }), {
      applied: 'changed',
      status: 'running',
    });
    assert.strictEqual((await drive(deps, NAME)).status, 'completed');
    assert.strictEqual((await deps.store.get(NAME)).reopened, 1);
    await assert.rejects(control(deps, 'nope.js', 'pause'), /not registered/);
  });

  it('should retry from the start with a fresh plan and no bad ids', async () => {
    await seed(50, (i) => ({ bad: i < 2 }));
    const files = {
      [NAME]: {
        background: {
          collection: 'orders',
          from: 1,
          to: 2,
          pauseMs: 0,
          migrate: (doc) => {
            if (doc.bad) throw new Error('bad');
            return moveAddress(doc);
          },
        },
      },
    };
    const deps = makeDeps(files);
    await register(deps, NAME);
    assert.strictEqual((await drive(deps, NAME)).status, 'failed');
    files[NAME].background.maxDocumentErrors = 5;
    files[NAME].checksum = 'c2';
    assert.strictEqual((await runSlice(deps, NAME)).outcome, 'failed');
    await assert.rejects(jobFor(deps, NAME, await deps.store.get(NAME)), ChecksumMismatchError);
    await repin(deps, NAME);
    assert.deepStrictEqual(await control(deps, NAME, 'retry', { fromStart: true }), {
      applied: 'changed',
      status: 'pending',
    });
    const state = await deps.store.get(NAME);
    assert.deepStrictEqual(state.badIds, []);
    assert.strictEqual(state.pass, 0);
    assert.strictEqual((await drive(deps, NAME)).status, 'completed');
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 1 }), 2);
  });

  it('should replan when a repin changes what is matched or how it splits', async () => {
    await seed(100);
    const files = {
      [NAME]: {
        background: { collection: 'orders', from: 1, to: 2, migrate: moveAddress, pauseMs: 0 },
      },
    };
    const deps = makeDeps(files);
    await register(deps, NAME);
    await coordinate(deps, NAME);
    const planned = await deps.store.get(NAME);
    files[NAME] = {
      checksum: 'c2',
      background: {
        ...files[NAME].background,
        maxParallel: 2,
        partitions: { minPartitionDocs: 10 },
      },
    };
    const pinned = await repin(deps, NAME);
    assert.strictEqual(pinned.replan, true);
    assert.strictEqual((await deps.store.get(NAME)).phase, 'replan');
    assert.strictEqual((await drive(deps, NAME)).status, 'completed');
    const done = await deps.store.get(NAME);
    assert.ok(done.generation > planned.generation);
    assert.strictEqual(done.pass, 1, 'a replan is not a new pass');
    const unchanged = await repin(deps, NAME);
    assert.strictEqual(unchanged.replan, false);
  });

  it('should wait out a deploy (file gone or changed) instead of failing', async () => {
    await seed(10);
    const files = {
      [NAME]: { background: { collection: 'orders', from: 1, to: 2, migrate: moveAddress } },
    };
    const deps = makeDeps(files);
    await register(deps, NAME);
    files[NAME].checksum = 'other';
    assert.deepStrictEqual(
      { next: (await coordinate(deps, NAME)).next, reason: (await coordinate(deps, NAME)).reason },
      { next: 'wait', reason: 'checksum' },
    );
    delete files[NAME];
    assert.strictEqual((await coordinate(deps, NAME)).reason, 'checksum');
    assert.deepStrictEqual(await coordinate(deps, 'missing.js'), {
      next: 'done',
      status: 'unregistered',
    });
  });

  it('should let one coordinator step at a time, and the newest BullMQ round win', async () => {
    await seed(10);
    const deps = makeDeps({
      [NAME]: { background: { collection: 'orders', from: 1, to: 2, migrate: moveAddress } },
    });
    await register(deps, NAME);
    const held = deps.lockFor(NAME);
    await held.acquire();
    assert.strictEqual((await coordinate(deps, NAME)).next, 'busy');
    await held.release();
    assert.strictEqual(
      (await coordinate(deps, NAME, { driver: { kind: 'bullmq', ref: 'a', round: 3 } })).next,
      'process',
    );
    assert.deepStrictEqual(
      await coordinate(deps, NAME, { driver: { kind: 'bullmq', ref: 'b', round: 2 } }),
      { next: 'superseded' },
    );
  });

  it('should roll a generation up once, whatever crashes in between', async () => {
    await seed(30);
    const deps = makeDeps({
      [NAME]: { background: { collection: 'orders', from: 1, to: 2, migrate: moveAddress } },
    });
    await register(deps, NAME);
    await coordinate(deps, NAME);
    while ((await runSlice(deps, NAME)).outcome === 'yielded');
    const state = await deps.store.get(NAME);
    const job = await jobFor(deps, NAME, state);
    // Finalize twice — as after a crash between the roll-up and the cleanup.
    await finalize(deps, job, state);
    await deps.store.set(NAME, { status: 'running' });
    await finalize(deps, job, await deps.store.get(NAME));
    assert.strictEqual((await deps.store.get(NAME)).totals.migrated, 30, 'counted once');
    assert.strictEqual(matchHash(job.spec).length, 32);
  });

  it('should not count a lane stopped by its caller as a failed slice', async () => {
    await seed(20);
    const deps = makeDeps({
      [NAME]: {
        background: {
          collection: 'orders',
          from: 1,
          to: 2,
          migrate: moveAddress,
          batchSize: 5,
          // The first batch never waits; the second waits here — and is stopped.
          pauseMs: 60_000,
          maxSliceFailures: 1,
        },
      },
    });
    await register(deps, NAME);
    assert.strictEqual((await coordinate(deps, NAME)).next, 'process');
    for (let round = 1; round <= 3; round++) {
      const controller = new AbortController();
      const batches = deps.events.length;
      const slice = runSlice(deps, NAME, { signal: controller.signal, sliceMs: 600_000 });
      while (!deps.events.slice(batches).some(([event]) => event === 'background:batch')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort(new Error('deploy'));
      assert.strictEqual((await slice).outcome, 'stopped', `round ${round}`);
      const [partition] = await deps.store.partitions(NAME);
      assert.strictEqual(partition.status, 'running');
      assert.strictEqual(partition.failures ?? 0, 0);
      assert.strictEqual(partition.lease, undefined, 'the lease is released');
    }
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 2 }), 15);
  });

  it('should still count a slice that fails on its own', async () => {
    await seed(10);
    const deps = makeDeps({
      [NAME]: {
        background: {
          collection: 'orders',
          from: 1,
          to: 2,
          migrateBatch: () => {
            throw new Error('broken transform');
          },
          pauseMs: 0,
          maxSliceFailures: 1,
        },
      },
    });
    await register(deps, NAME);
    assert.strictEqual((await coordinate(deps, NAME)).next, 'process');
    await assert.rejects(runSlice(deps, NAME, { signal: new AbortController().signal }), /broken/);
    const [partition] = await deps.store.partitions(NAME);
    assert.strictEqual(partition.status, 'failed');
  });

  it('should keep a blocked one blocked until what it requires completes', async () => {
    await seed(10);
    const deps = makeDeps({
      [NAME]: { background: { collection: 'orders', from: 1, to: 2, migrate: moveAddress } },
      '0002-next.js': {
        requires: [NAME],
        background: { collection: 'orders', from: 2, to: 3, migrate: (doc) => doc },
      },
    });
    await register(deps, NAME);
    await register(deps, '0002-next.js', 'blocked');
    assert.deepStrictEqual(await coordinate(deps, '0002-next.js'), {
      next: 'done',
      status: 'blocked',
      waitsFor: [],
    });
    assert.deepStrictEqual((await deps.store.get('0002-next.js')).waitsFor, [NAME]);
    assert.strictEqual((await drive(deps, NAME)).status, 'completed');
    assert.strictEqual((await drive(deps, '0002-next.js')).status, 'completed');
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 3 }), 10);
  });
});
