const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { startBackgroundRunner } = require('../../index.js');
const { ConfigInvalidError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_background_watch_test';
const NAME = '0001-orders.js';
const WATCH = '_migronaut_background_watch';

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
const watchers = [];
let project;

afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher.stop();
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

const spec = ({ from = 1, to = 2, extra = '' } = {}) => `export const background = {
  collection: 'orders',
  from: ${from},
  to: ${to},
  pauseMs: 0,
  migrate: (doc) => ({ ...doc, ['v${to}']: true }),
  ${extra}
};
`;

const FAST = { refreshMs: 200, checkpointMs: 50, leaderRetryMs: 100 };

/** Wait for `check` to hold, polling */
async function until(what, check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A completed background migration v1 → v2 over a few documents, and a watcher on it */
async function watched(overrides = {}, watchOptions = {}) {
  await mongo.db.collection('orders').insertMany([{ __v: 1, __rev: 0, n: 1 }]);
  const kit = kitWith(overrides);
  project.write(NAME, spec());
  await kit.up();
  await kit.runBackground(NAME);
  const states = [];
  kit.on('background:watch', (event) => states.push(event.state));
  const drift = [];
  kit.on('background:drift', (event) => drift.push(event));
  const watcher = await kit.watchBackground({ ...FAST, ...watchOptions });
  watchers.push(watcher);
  await until('the stream', () => states.includes('streaming'));
  return { kit, watcher, states, drift };
}

const orders = () => mongo.db.collection('orders');

describe('live drift watcher (integration)', () => {
  it('should upgrade an old-shape insert moments after it lands, and say so', async () => {
    const { drift, watcher } = await watched();
    const started = Date.now();
    const { insertedId } = await orders().insertOne({ __v: 1, __rev: 0, late: true });
    const doc = await until('the upgrade', () => orders().findOne({ _id: insertedId, __v: 2 }));
    assert.ok(Date.now() - started < 2_000, 'within two seconds');
    assert.strictEqual(doc.v2, true);
    assert.strictEqual(doc.__rev, 1);
    // The event follows the write it reports.
    await until('the drift event', () => drift.length > 0);
    const { runId: _runId, ...event } = drift.at(-1);
    assert.deepStrictEqual(event, {
      migration: NAME,
      collection: 'orders',
      source: 'stream',
      action: 'upgraded',
    });
    const row = await until('the count', () => {
      const [first] = watcher.status();
      return first?.counters.upgraded === 1 ? first : undefined;
    });
    assert.strictEqual(row.leading, true);
  });

  it('should take back a downgrade by an old release, and ignore updates that leave the version', async () => {
    const { watcher } = await watched();
    const doc = await orders().findOne({});
    await orders().updateOne({ _id: doc._id }, { $set: { other: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(watcher.status()[0].counters.events, 0, 'an update off the version');
    await orders().updateOne({ _id: doc._id }, { $set: { __v: 1 } });
    await until('the downgrade undone', () => orders().findOne({ _id: doc._id, __v: 2, __rev: 2 }));
    assert.strictEqual(watcher.status()[0].counters.events, 1);
  });

  it('should report a document no completed background migration can upgrade', async () => {
    const { drift } = await watched();
    const doc = await orders().findOne({});
    await orders().updateOne({ _id: doc._id }, { $unset: { __v: '' } });
    await until('the report', () => drift.some((event) => event.action === 'reported'));
    assert.strictEqual((await orders().findOne({ _id: doc._id })).__v, undefined);
  });

  it('should hand a document it cannot upgrade back to the lanes', async () => {
    const { kit, drift } = await watched();
    // An edited file (a deploy in progress): the watcher cannot load the migration.
    project.write(NAME, spec({ extra: 'batchSize: 7,' }));
    await orders().insertOne({ __v: 1, __rev: 0, late: true });
    await until('the hand-back', () => drift.some((event) => event.action === 'reopened'));
    assert.strictEqual((await kit.backgroundStatus(NAME)).status, 'running');
  });

  it('should take a document up a chain of background migrations', async () => {
    const kit = kitWith();
    await orders().insertOne({ __v: 1, __rev: 0 });
    project.write(NAME, spec());
    project.write('0002-orders.js', spec({ from: 2, to: 3 }));
    await kit.up();
    await kit.runBackground(NAME);
    await kit.runBackground('0002-orders.js');
    const states = [];
    kit.on('background:watch', (event) => states.push(event.state));
    watchers.push(await kit.watchBackground(FAST));
    await until('the stream', () => states.includes('streaming'));
    const { insertedId } = await orders().insertOne({ __v: 1, __rev: 0 });
    const doc = await until('v3', () => orders().findOne({ _id: insertedId, __v: 3 }));
    assert.strictEqual(doc.__rev, 2, 'one write per edge');
    assert.ok(doc.v2 && doc.v3);
  });

  it('should keep one leader per collection, and hand over when it stops', async () => {
    const { kit, watcher } = await watched();
    const second = kitWith();
    const follower = await second.watchBackground(FAST);
    watchers.push(follower);
    await until('the follower', () => follower.status()[0]?.state === 'following');
    assert.strictEqual(watcher.status()[0].leading, true);
    await watcher.stop();
    await until('the handover', () => follower.status()[0]?.state === 'streaming');
    const { insertedId } = await orders().insertOne({ __v: 1, __rev: 0 });
    await until('the upgrade', () => orders().findOne({ _id: insertedId, __v: 2 }));
    const stored = await kit.backgroundWatchStatus('orders');
    assert.strictEqual(stored.state, 'streaming');
    assert.strictEqual(stored.resumeToken, undefined, 'never the token');
    assert.deepStrictEqual(stored.edges, [NAME]);
    assert.strictEqual((await kit.backgroundWatchStatus()).length, 1);
    assert.strictEqual(await kit.backgroundWatchStatus('nothing'), null);
  });

  it('should keep its position while idle, and resume from it', async () => {
    const { kit, watcher } = await watched();
    await until('a saved token', () =>
      mongo.db.collection(WATCH).findOne({ resumeToken: { $exists: true } }),
    );
    await watcher.stop();
    // Written while nobody watched: the next leader resumes from its token.
    const { insertedId } = await orders().insertOne({ __v: 1, __rev: 0 });
    const states = [];
    kit.on('background:watch', (event) => states.push(event.state));
    watchers.push(await kit.watchBackground(FAST));
    await until('the upgrade', () => orders().findOne({ _id: insertedId, __v: 2 }));
    assert.ok(!states.includes('catching-up'), 'resumed, not started over');
  });

  it('should start over from now when its history is lost', async () => {
    const { states } = await watched();
    // The server's own answer when the oplog moved past the stream's position.
    await mongo.client.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['getMore'], errorCode: 286 },
    });
    await until('the loss', () => states.includes('history-lost'));
    await until(
      'the restart',
      () => states.lastIndexOf('streaming') > states.indexOf('history-lost'),
    );
    assert.ok(states.lastIndexOf('catching-up') > states.indexOf('history-lost'), states.join(','));
    const { insertedId } = await orders().insertOne({ __v: 1, __rev: 0 });
    await until('the upgrade', () => orders().findOne({ _id: insertedId, __v: 2 }));
  });

  it('should commit a transactional edge with its side write, exactly once', async () => {
    const kit = kitWith();
    await orders().insertOne({ __v: 1, __rev: 0 });
    project.write(
      NAME,
      spec({
        extra: `transaction: true,
  migrate: async (doc, ctx) => {
    await ctx.db.collection('audit').insertOne({ order: doc._id }, { session: ctx.session });
    return { ...doc, v2: true };
  },`,
      }).replace("  migrate: (doc) => ({ ...doc, ['v2']: true }),\n", ''),
    );
    await kit.up();
    await kit.runBackground(NAME);
    const states = [];
    kit.on('background:watch', (event) => states.push(event.state));
    watchers.push(await kit.watchBackground(FAST));
    await until('the stream', () => states.includes('streaming'));
    const { insertedId } = await orders().insertOne({ __v: 1, __rev: 0 });
    await until('the upgrade', () => orders().findOne({ _id: insertedId, __v: 2 }));
    assert.strictEqual(await mongo.db.collection('audit').countDocuments({ order: insertedId }), 1);
  });

  it('should reopen its background migrations when it falls behind', async () => {
    const { kit, states } = await watched({}, { maxLagMs: 1 });
    await until('the shedding', async () => {
      await orders().insertOne({ __v: 1, __rev: 0 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      return states.includes('overloaded');
    });
    assert.strictEqual((await kit.backgroundStatus(NAME)).status, 'running', 'reopened');
  });

  it('should leave a streaming collection to its watcher when drift is streamed', async () => {
    const { kit } = await watched({ backgroundDrift: 'stream' });
    await until('a fresh record', () =>
      mongo.db.collection(WATCH).findOne({ state: 'streaming', resumeToken: { $exists: true } }),
    );
    const verified = await kit.verifyBackground();
    assert.deepStrictEqual(verified, { checked: 0, skipped: 1, drift: [] });
    const polled = kitWith();
    assert.strictEqual((await polled.verifyBackground()).checked, 1, "'poll' mode probes it");
    assert.strictEqual(await kit.driftMode(), 'stream');
  });

  it('should warn in audit about a watcher left to the poll, or without a leader, for long', async () => {
    const kit = kitWith({ backgroundDrift: 'both' });
    await orders().insertOne({ __v: 1, __rev: 0 });
    project.write(NAME, spec());
    await kit.up();
    await kit.runBackground(NAME);
    const long = new Date(Date.now() - 20 * 60_000);
    await mongo.db.collection(WATCH).insertMany([
      { _id: 'orders', state: 'fallback', updatedAt: long },
      { _id: 'users', state: 'streaming', updatedAt: long },
      { _id: 'fresh', state: 'streaming', updatedAt: new Date() },
    ]);
    const check = (await kit.audit()).checks.find((entry) => entry.name === 'background');
    assert.strictEqual(check.status, 'warn');
    assert.match(check.detail, /drift watcher of orders has fallen back to polling for 20 min/);
    assert.match(check.detail, /drift watcher of users has had no live leader/);
    assert.ok(!check.detail.includes('fresh'));
    const polled = kitWith();
    const quiet = (await polled.audit()).checks.find((entry) => entry.name === 'background');
    assert.strictEqual(quiet.status, 'pass', "'poll' mode does not look at watchers");
  });

  it('should be hosted by the in-process runner when drift is streamed', async () => {
    await orders().insertOne({ __v: 1, __rev: 0 });
    const kit = kitWith({ backgroundDrift: 'both' });
    project.write(NAME, spec());
    await kit.up();
    await kit.runBackground(NAME);
    const states = [];
    kit.on('background:watch', (event) => states.push(event.state));
    const runner = startBackgroundRunner({
      kit,
      pollIntervalMs: 50,
      verifyIntervalMs: false,
      watch: FAST,
    });
    try {
      await until('the stream', () => states.includes('streaming'));
      assert.ok(runner.watcher);
      const { insertedId } = await orders().insertOne({ __v: 1, __rev: 0 });
      await until('the upgrade', () => orders().findOne({ _id: insertedId, __v: 2 }));
    } finally {
      await runner.stop();
    }
    assert.strictEqual(runner.watcher.running, false, 'stopped with the runner');
    const quiet = startBackgroundRunner({
      kit: kitWith(),
      pollIntervalMs: 50,
      verifyIntervalMs: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(quiet.watcher, undefined, "'poll' mode hosts none");
    await quiet.stop();
    assert.throws(() => startBackgroundRunner({ kit, watch: 'yes' }), ConfigInvalidError);
    assert.throws(() => startBackgroundRunner({ kit, watch: { maxLagMs: 0 } }), ConfigInvalidError);
  });

  it('should refuse bad options before connecting', async () => {
    const kit = kitWith();
    for (const bad of [
      { refreshMs: 0 },
      { upgrade: 'yes' },
      { collections: 'orders' },
      { collections: [''] },
      { signal: 1 },
      { onError: 1 },
    ]) {
      await assert.rejects(kit.watchBackground(bad), ConfigInvalidError);
    }
    await assert.rejects(kit.watchBackground(null), ConfigInvalidError);
  });
});

describe('live drift watcher on a standalone server (integration)', () => {
  let standalone;

  before(async () => {
    standalone = await MongoMemoryServer.create();
  });

  after(async () => {
    await standalone.stop();
  });

  it('should refuse to start: there are no change streams', async () => {
    project = makeProject();
    const kit = makeMigrator(standalone.getUri(), 'watch_standalone', project.dir);
    kits.push(kit);
    await assert.rejects(kit.watchBackground(), (error) => {
      assert.ok(error instanceof ConfigInvalidError);
      assert.strictEqual(error.context.key, 'backgroundDrift');
      return true;
    });
  });
});
