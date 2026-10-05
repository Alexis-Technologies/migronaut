const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { startBackgroundRunner } = require('../../index.js');
const { ConfigInvalidError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_background_runner_test';
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

const kits = [];
const runners = [];
let project;

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const kit of kits.splice(0)) await kit.disconnect();
  project?.cleanup();
  project = undefined;
});

function kitWith(overrides = {}) {
  project ??= makeProject();
  const kit = makeMigrator(mongo.uri, DB, project.dir, overrides);
  kits.push(kit);
  return kit;
}

const config = () => ({ uri: mongo.uri, dbName: DB, migrationsDir: project.dir, logger: null });

function runnerWith(options) {
  const runner = startBackgroundRunner({ pollIntervalMs: 50, verifyIntervalMs: false, ...options });
  runners.push(runner);
  return runner;
}

async function seed(count) {
  await mongo.db
    .collection('orders')
    .insertMany(Array.from({ length: count }, (_, i) => ({ __v: 1, __rev: 0, i })));
}

const SPEC = `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  pauseMs: 0,
  batchSize: 50,
  maxParallel: 2,
  partitions: { minPartitionDocs: 50 },
  migrateBatch: async (docs) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return docs.map((doc) => ({ ...doc, done: true }));
  },
};
`;

/** Resolve once the background migration completed */
async function completed(kit, name = NAME, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const status = await kit.backgroundStatus(name);
    if (status?.status === 'completed') return status;
    if (Date.now() > until) throw new Error(`still ${status?.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('in-process background runner (integration)', () => {
  it('should share the work between two runners without exceeding maxParallel', async () => {
    await seed(2000);
    const kit = kitWith();
    project.write(NAME, SPEC);
    await kit.up();
    let peak = 0;
    const sampling = { on: true };
    const sampler = (async () => {
      while (sampling.on) {
        const leased = await mongo.db
          .collection('_migronaut_background_partitions')
          .countDocuments({ lease: { $exists: true } });
        peak = Math.max(peak, leased);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    const slices = [];
    for (let i = 0; i < 2; i++) {
      const runner = runnerWith({ config: config(), concurrency: 3 });
      runner.kit.on('background:slice:start', (event) => slices.push(event.runId));
    }
    const status = await completed(kit);
    sampling.on = false;
    await sampler;
    assert.ok(peak <= 2, `at most 2 leases at once, saw ${peak}`);
    assert.strictEqual(status.totals.migrated, 2000);
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ done: true }), 2000);
    assert.ok(new Set(slices).size >= 2);
  });

  it('should work alongside a CLI-style driver on the same background migration', async () => {
    await seed(1000);
    const kit = kitWith();
    project.write(NAME, SPEC);
    await kit.up();
    runnerWith({ config: config(), concurrency: 2 });
    const driver = kitWith();
    const status = await driver.runBackground(NAME, { concurrency: 2 });
    assert.strictEqual(status.status, 'completed');
    assert.strictEqual(
      await mongo.db.collection('orders').countDocuments({ __v: 2, __rev: 1 }),
      1000,
    );
  });

  it('should stop mid-slice, releasing its lease, and let a new runner finish', async () => {
    await seed(1500);
    const kit = kitWith();
    project.write(NAME, SPEC.replace('maxParallel: 2', 'maxParallel: 1'));
    await kit.up();
    const first = startBackgroundRunner({
      config: config(),
      pollIntervalMs: 50,
      verifyIntervalMs: false,
    });
    await new Promise((resolve) => first.kit.once('background:batch', resolve));
    await first.stop();
    assert.strictEqual(first.running, false);
    const leases = await mongo.db
      .collection('_migronaut_background_partitions')
      .countDocuments({ lease: { $exists: true } });
    assert.strictEqual(leases, 0, 'released at the batch boundary');
    const left = await mongo.db.collection('orders').countDocuments({ __v: 1 });
    assert.ok(left > 0, 'stopped before the end');
    runnerWith({ config: config() });
    await completed(kit);
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 1 }), 0);
  });

  it('should catch drift with its periodic watch', async () => {
    await seed(100);
    const kit = kitWith();
    project.write(NAME, SPEC);
    await kit.up();
    await kit.runBackground(NAME);
    const drift = [];
    const runner = runnerWith({ kit: kitWith(), verifyIntervalMs: 100 });
    runner.kit.on('background:drift', (event) => drift.push(event));
    await mongo.db.collection('orders').insertOne({ __v: 1, __rev: 0, late: true });
    const until = Date.now() + 20_000;
    while (await mongo.db.collection('orders').countDocuments({ __v: 1 })) {
      if (Date.now() > until) throw new Error('drift was not caught');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.strictEqual(drift[0].action, 'reopened');
    assert.strictEqual((await completed(kit)).status, 'completed');
  });

  it('should report failed slices to onError and never throw; and refuse bad options', async () => {
    const kit = kitWith();
    project.write(
      NAME,
      `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  maxSliceFailures: 100,
  migrateBatch: async () => { throw new Error('boom'); },
};
`,
    );
    await seed(5);
    await kit.up();
    const errors = [];
    const runner = runnerWith({
      kit: kitWith(),
      onError: (error, name) => errors.push([name, error.message]),
    });
    const until = Date.now() + 10_000;
    while (errors.length === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepStrictEqual(errors[0], [NAME, 'boom']);
    assert.strictEqual(runner.running, true);
    for (const bad of [
      { concurrency: 0 },
      { pollIntervalMs: 1 },
      { verifyIntervalMs: 5 },
      { onError: 1 },
      { signal: 1 },
      { kit: {} },
    ]) {
      assert.throws(() => startBackgroundRunner(bad), ConfigInvalidError);
    }
    const controller = new AbortController();
    const stopped = runnerWith({ kit: kitWith(), signal: controller.signal });
    controller.abort();
    await stopped.stop();
    assert.strictEqual(stopped.running, false);
  });
});
