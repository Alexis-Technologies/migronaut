const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const {
  ChecksumMismatchError,
  NotAppliedError,
  RunAbortedError,
} = require('../../src/errors/index.js');
const { retryOnConflict, updateWithRevision } = require('../../versioning.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_background_kit_test';
const NAME = '0001-orders.js';
const childPath = path.join(__dirname, '..', 'helpers', 'background-child.js');

before(async () => {
  mongo = await startTestMongo(DB, { dedicated: true });
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  await mongo.db.collection('orders').createIndex({ __v: 1, _id: 1 });
});

const kits = [];
let project;

afterEach(async () => {
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

const spec = (body) => `export const background = {
  collection: 'orders',
  from: 1,
  to: 2,
  pauseMs: 0,
  ${body}
};
`;

async function seed(count) {
  const batch = [];
  for (let i = 0; i < count; i++) batch.push({ __v: 1, __rev: 0, address: `A${i}`, i });
  for (let i = 0; i < batch.length; i += 5000) {
    await mongo.db.collection('orders').insertMany(batch.slice(i, i + 5000));
  }
}

const partitions = () => mongo.db.collection('_migronaut_background_partitions');

describe('background migrations through the kit (integration)', () => {
  it('should keep two kits with four lanes each to maxParallel, rewriting every document once', async () => {
    await seed(20_000);
    const first = kitWith();
    project.write(
      NAME,
      spec(`maxParallel: 2,
  batchSize: 500,
  partitions: { minPartitionDocs: 500 },
  migrate: ({ address, ...doc }) => ({ ...doc, shipping: { address } }),`),
    );
    await first.up();
    const second = kitWith();
    let active = 0;
    let peak = 0;
    for (const kit of [first, second]) {
      kit.on('background:slice:start', () => {
        active += 1;
        peak = Math.max(peak, active);
      });
      kit.on('background:slice:end', () => {
        active -= 1;
      });
    }
    let sampled = 0;
    const sampling = { on: true };
    const sampler = (async () => {
      while (sampling.on) {
        const leased = await partitions().countDocuments({ lease: { $exists: true } });
        sampled = Math.max(sampled, leased);
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    })();
    const [a, b] = await Promise.all([
      first.runBackground(NAME, { concurrency: 4 }),
      second.runBackground(NAME, { concurrency: 4 }),
    ]);
    sampling.on = false;
    await sampler;
    assert.strictEqual(a.status, 'completed');
    assert.strictEqual(b.status, 'completed');
    assert.ok(peak <= 2, `at most 2 slices at once, saw ${peak}`);
    assert.ok(sampled <= 2, `at most 2 leases at once, saw ${sampled}`);
    assert.strictEqual(
      await mongo.db.collection('orders').countDocuments({ __v: 2, __rev: 1 }),
      20_000,
    );
    const status = await first.backgroundStatus(NAME);
    assert.strictEqual(status.totals.migrated, 20_000);
    assert.strictEqual(status.partitions.done, status.partitions.total);
    assert.strictEqual(status.liveLeases, 0);
  });

  it('should finish what a killed process left, from its last checkpoint', async () => {
    await seed(3000);
    const kit = kitWith({ lockTTLSeconds: 2 });
    project.write(
      NAME,
      spec(`batchSize: 100,
  migrateBatch: async (docs) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return docs.map(({ address, ...doc }) => ({ ...doc, shipping: { address } }));
  },`),
    );
    await kit.up();
    const child = spawn(process.execPath, [childPath, mongo.uri, DB, project.dir, NAME], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      let batches = 0;
      child.stdout.on('data', (chunk) => {
        for (const line of String(chunk).trim().split('\n')) {
          if (JSON.parse(line).event === 'batch' && ++batches === 3) {
            child.kill('SIGKILL');
            resolve();
          }
        }
      });
      child.on('exit', (code) =>
        code === 0 ? reject(new Error('child finished first')) : undefined,
      );
    });
    await new Promise((resolve) => child.on('exit', resolve));
    const status = await kit.runBackground(NAME, { concurrency: 1 });
    assert.strictEqual(status.status, 'completed');
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ __v: 2 }), 3000);
    assert.strictEqual(
      await mongo.db.collection('orders').countDocuments({ __rev: { $gt: 1 } }),
      0,
    );
    const [partition] = await kit.backgroundPartitions(NAME);
    assert.ok(partition.reclaims >= 1, "the dead lane's lease was reclaimed");
  });

  it('should never lose a write the application makes while documents are rewritten', async () => {
    await seed(2000);
    const kit = kitWith();
    project.write(
      NAME,
      spec(`batchSize: 100,
  maxParallel: 2,
  partitions: { minPartitionDocs: 100 },
  migrate: async ({ address, ...doc }) => {
    await new Promise((resolve) => setImmediate(resolve));
    return { ...doc, shipping: { address } };
  },`),
    );
    await kit.up();
    const orders = mongo.db.collection('orders');
    const written = new Map();
    const storming = { on: true };
    const storm = (async () => {
      let n = 0;
      while (storming.on) {
        const i = Math.floor(Math.random() * 2000);
        n += 1;
        const marker = n;
        await retryOnConflict(
          async () => {
            const doc = await orders.findOne({ i });
            return updateWithRevision(orders, { _id: doc._id }, doc.__rev ?? 0, {
              $set: { marker },
            });
          },
          { attempts: 50, backoff: { baseMs: 1, maxMs: 10 } },
        );
        written.set(i, marker);
      }
    })();
    const status = await kit.runBackground(NAME, { concurrency: 2 });
    storming.on = false;
    await storm;
    assert.strictEqual(status.status, 'completed');
    assert.ok(written.size > 20, `the storm wrote ${written.size} documents`);
    for (const [i, marker] of written) {
      const doc = await orders.findOne({ i });
      assert.strictEqual(doc.marker, marker, `document ${i} kept the application's write`);
      assert.strictEqual(doc.__v, 2);
      assert.deepStrictEqual(doc.shipping, { address: `A${i}` });
    }
    assert.strictEqual(await orders.countDocuments({ __v: 1 }), 0);
  });

  it('should fence a lane whose lease was taken, without counting its batch twice', async () => {
    await seed(300);
    const kit = kitWith();
    const other = kitWith();
    project.write(
      NAME,
      spec(`batchSize: 300,
  migrate: async ({ address, ...doc }) => {
    if (doc.i === 0 && !globalThis.__stolen) {
      globalThis.__stolen = true;
      await globalThis.__steal();
    }
    return { ...doc, shipping: { address } };
  },`),
    );
    await kit.up();
    await kit.coordinateBackground(NAME);
    globalThis.__steal = async () => {
      // The holder stalls past its TTL; another kit reclaims and finishes.
      await partitions().updateMany({}, { $set: { 'lease.renewedAt': new Date(0) } });
      await other.runBackground(NAME);
    };
    const slice = await kit.runBackgroundSlice(NAME);
    delete globalThis.__steal;
    delete globalThis.__stolen;
    assert.strictEqual(slice.outcome, 'lost');
    const status = await kit.backgroundStatus(NAME);
    assert.strictEqual(status.status, 'completed');
    assert.strictEqual(status.totals.migrated, 300, 'counted once');
    assert.strictEqual(
      await mongo.db.collection('orders').countDocuments({ __rev: 1, __v: 2 }),
      300,
    );
  });

  it('should pause and wait for its lanes, then resume to the end', async () => {
    await seed(2000);
    const kit = kitWith();
    project.write(
      NAME,
      spec(`batchSize: 50,
  migrateBatch: async (docs) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return docs.map(({ address, ...doc }) => ({ ...doc, shipping: { address } }));
  },`),
    );
    await kit.up();
    const firstBatch = new Promise((resolve) => kit.once('background:batch', resolve));
    const driving = kit.runBackground(NAME);
    await firstBatch;
    const paused = await kit.pauseBackground(NAME, { wait: true, requestedBy: 'ops' });
    assert.deepStrictEqual(paused, { applied: 'changed', status: 'paused', stopped: true });
    const stoppedAt = await driving;
    assert.strictEqual(stoppedAt.status, 'paused');
    const left = await mongo.db.collection('orders').countDocuments({ __v: 1 });
    assert.ok(left > 0 && left < 2000, `stopped midway: ${left} left`);
    assert.deepStrictEqual(await kit.resumeBackground(NAME), {
      applied: 'changed',
      status: 'running',
    });
    assert.strictEqual((await kit.runBackground(NAME)).status, 'completed');
  });

  it('should refuse a file changed since it was registered, until it is repinned', async () => {
    await seed(10);
    const kit = kitWith({ reloadMigrations: true });
    project.write(NAME, spec(`migrate: (doc) => ({ ...doc, a: 1 }),`));
    await kit.up();
    await kit.coordinateBackground(NAME);
    project.write(NAME, spec(`migrate: (doc) => ({ ...doc, b: 2 }),`));
    await assert.rejects(kit.runBackgroundSlice(NAME), ChecksumMismatchError);
    assert.strictEqual((await kit.coordinateBackground(NAME)).reason, 'checksum');
    const pinned = await kit.repinBackground(NAME);
    assert.strictEqual(pinned.replan, false);
    const record = await mongo.db.collection('_migronaut_migrations').findOne({ name: NAME });
    assert.strictEqual(record.checksum, pinned.checksum);
    assert.strictEqual((await kit.runBackground(NAME)).status, 'completed');
    assert.strictEqual((await mongo.db.collection('orders').findOne()).b, 2);
  });

  it('should work again after disconnect and connect', async () => {
    await seed(10);
    const kit = kitWith();
    project.write(NAME, spec('migrate: (doc) => ({ ...doc, done: true }),'));
    await kit.up();
    assert.strictEqual((await kit.backgroundStatus(NAME)).status, 'pending');
    await kit.disconnect();
    await kit.connect();
    assert.strictEqual((await kit.runBackground(NAME)).status, 'completed');
    assert.strictEqual(await mongo.db.collection('orders').countDocuments({ done: true }), 10);
  });

  it('should return after one round even when its slice fails', async () => {
    await seed(10);
    const kit = kitWith();
    project.write(
      NAME,
      spec(`maxSliceFailures: 5,
  migrateBatch: () => {
    throw new Error('broken transform');
  },`),
    );
    await kit.up();
    const status = await kit.runBackground(NAME, { untilDone: false });
    assert.strictEqual(status.status, 'running');
    assert.strictEqual((await partitions().findOne({})).failures, 1);
  });

  it('should refuse to run inline a file changed since it was registered', async () => {
    await seed(10);
    // Registered by one deploy, not run yet…
    const first = kitWith();
    project.write(NAME, spec('migrate: (doc) => ({ ...doc, done: true }),'));
    await first.up();
    // …and edited before the next one, which runs it inline.
    const kit = kitWith({ backgroundInline: true });
    project.write(NAME, spec('migrate: (doc) => ({ ...doc, done: 2 }),'));
    project.write(
      '0002-contract.js',
      `export const requires = ['${NAME}'];
export async function up() {}
export async function down() {}
`,
    );
    await assert.rejects(kit.up(), (error) => {
      const cause = error instanceof ChecksumMismatchError ? error : error.cause;
      assert.ok(cause instanceof ChecksumMismatchError, String(error));
      return true;
    });
  });

  it('should refuse a slice length that would never make progress', async () => {
    const kit = kitWith();
    for (const sliceMs of [0, -1, Number.NaN, '1000', 3_600_001]) {
      await assert.rejects(kit.runBackground(NAME, { sliceMs }), /sliceMs/);
      await assert.rejects(kit.runBackgroundSlice(NAME, { sliceMs }), /sliceMs/);
    }
  });

  it('should stop driving on a signal, and refuse control of what is not registered', async () => {
    await seed(500);
    const kit = kitWith();
    project.write(
      NAME,
      spec(`batchSize: 20,
  migrateBatch: async (docs) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return docs.map((doc) => ({ ...doc, done: true }));
  },`),
    );
    await kit.up();
    const controller = new AbortController();
    kit.once('background:batch', () => controller.abort());
    await assert.rejects(kit.runBackground(NAME, { signal: controller.signal }), RunAbortedError);
    await assert.rejects(kit.pauseBackground('nope.js'), NotAppliedError);
    assert.strictEqual(await kit.backgroundStatus('nope.js'), null);
    assert.deepStrictEqual(
      (await kit.runnableBackground()).map((row) => row.migration),
      [NAME],
    );
    const unlocked = await kit.unlockBackground(NAME);
    assert.strictEqual(typeof unlocked.leases, 'number');
    assert.strictEqual((await kit.runBackground(NAME, { concurrency: 3 })).status, 'completed');
    assert.strictEqual((await kit.backgroundStatus()).length, 1);
  });
});
