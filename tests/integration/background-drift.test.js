const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { ObjectId } = require('mongodb');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_background_drift_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  await mongo.db.collection('orders').createIndex({ __v: 1, _id: 1 });
  await mongo.db
    .collection('orders')
    .insertMany(Array.from({ length: 20 }, (_, i) => ({ __v: 1, __rev: 0, i })));
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

const step = (from, to, extra = '') => `export const background = {
  collection: 'orders',
  from: ${from},
  to: ${to},
  pauseMs: 0,
  migrate: (doc) => ({ ...doc, ['v${to}']: true }),
  ${extra}
};
`;

const orders = () => mongo.db.collection('orders');

describe('drift watch (integration)', () => {
  it('should reopen a completed migration when the old shape reappears — a new generation, not a reset', async () => {
    const kit = kitWith();
    project.write('0001-v2.js', step(1, 2));
    await kit.up();
    await kit.runBackground('0001-v2.js');
    const completed = await kit.backgroundStatus('0001-v2.js');
    assert.deepStrictEqual(await kit.verifyBackground(), { checked: 1, skipped: 0, drift: [] });

    await orders().insertOne({ __v: 1, __rev: 0, late: true });
    const events = [];
    kit.on('background:drift', (event) => events.push(event));
    const found = await kit.verifyBackground();
    assert.deepStrictEqual(found.drift, [
      { migration: '0001-v2.js', collection: 'orders', action: 'reopened' },
    ]);
    assert.strictEqual(events[0].source, 'poll');
    assert.strictEqual(events[0]._id, undefined, 'no document id');
    const reopened = await kit.backgroundStatus('0001-v2.js');
    assert.strictEqual(reopened.status, 'running');
    await kit.runBackground('0001-v2.js');
    const again = await kit.backgroundStatus('0001-v2.js');
    assert.strictEqual(again.status, 'completed');
    assert.ok(again.generation > completed.generation);
    assert.strictEqual(again.pass, completed.pass + 1, 'a pass more, not a reset');
    assert.strictEqual(again.totals.migrated, 21);
  });

  it('should only report with onDrift: report — from the config too', async () => {
    const kit = kitWith({ backgroundOnDrift: 'report' });
    project.write('0001-v2.js', step(1, 2));
    await kit.up();
    await kit.runBackground('0001-v2.js');
    await orders().insertOne({ __v: 1, __rev: 0 });
    const found = await kit.verifyBackground();
    assert.strictEqual(found.drift[0].action, 'reported');
    assert.strictEqual((await kit.backgroundStatus('0001-v2.js')).status, 'completed');
    assert.strictEqual(
      (await kit.verifyBackground({ onDrift: 'reopen' })).drift[0].action,
      'reopened',
    );
    await assert.rejects(kit.verifyBackground({ onDrift: 'ignore' }), /onDrift/);
  });

  it('should let a chain v1 → v2 → v3 converge on its own', async () => {
    const kit = kitWith();
    project.write('0001-v2.js', step(1, 2));
    project.write('0002-v3.js', `export const requires = ['0001-v2.js'];\n${step(2, 3)}`);
    await kit.up();
    await kit.runBackground('0001-v2.js');
    await kit.runBackground('0002-v3.js');
    await orders().insertOne({ __v: 1, __rev: 0, late: true });
    assert.deepStrictEqual(
      (await kit.verifyBackground()).drift.map((entry) => entry.migration),
      ['0001-v2.js'],
    );
    await kit.runBackground('0001-v2.js');
    assert.deepStrictEqual(
      (await kit.verifyBackground()).drift.map((entry) => entry.migration),
      ['0002-v3.js'],
    );
    await kit.runBackground('0002-v3.js');
    assert.strictEqual(await orders().countDocuments({ __v: 3 }), 21);
    assert.deepStrictEqual((await kit.verifyBackground()).drift, []);
  });

  it('should skip what the validator guards, what is still at work, and what has no index', async () => {
    const kit = kitWith({
      collections: [{ name: 'orders', versioning: { current: 2, min: 2 } }],
    });
    project.write('0001-v2.js', step(1, 2));
    await kit.up();
    await kit.runBackground('0001-v2.js');
    await orders().insertOne({ __v: 1, __rev: 0 }, { bypassDocumentValidation: true });
    assert.deepStrictEqual(await kit.verifyBackground(), { checked: 0, skipped: 1, drift: [] });

    const other = kitWith({ reloadMigrations: true });
    project.write('0002-again.js', step(2, 3, 'maxPasses: 2,'));
    await other.up();
    // 0002 is pending on the same collection: 0001's drift waits.
    const busy = await other.verifyBackground({ collections: ['orders'] });
    assert.strictEqual(busy.checked, 0);
    assert.deepStrictEqual(await other.verifyBackground({ collections: ['users'] }), {
      checked: 0,
      skipped: 0,
      drift: [],
    });
  });
});

describe('audit — background migrations (integration)', () => {
  const checkOf = async (kit) =>
    (await kit.audit()).checks.find((check) => check.name === 'background');

  it('should say nothing without background migrations, and pass when all is well', async () => {
    const kit = kitWith();
    project.write('0001-v2.js', step(1, 2));
    assert.strictEqual(await checkOf(kit), undefined);
    await kit.up();
    await kit.runBackground('0001-v2.js');
    const check = await checkOf(kit);
    assert.strictEqual(check.status, 'pass');
    assert.match(check.detail, /1 background migration\(s\): 1 completed/);
  });

  it('should fail on a failed one, and warn on stalls, drift, failed partitions, old plans and missing files', async () => {
    const kit = kitWith();
    project.write('0001-v2.js', step(1, 2));
    project.write(
      '0002-broken.js',
      `export const background = {
  collection: 'things',
  from: 0,
  to: 1,
  pauseMs: 0,
  migrate: () => { throw new Error('nope'); },
};
`,
    );
    await mongo.db.collection('things').insertOne({ a: 1 });
    await kit.up();
    await kit.runBackground('0001-v2.js');
    await assert.rejects(kit.runBackground('0002-broken.js'));
    await orders().insertOne({ __v: 1, __rev: 0 });
    const failing = await checkOf(kit);
    assert.strictEqual(failing.status, 'fail');
    assert.match(failing.detail, /0002-broken\.js failed/);
    assert.match(failing.detail, /holds old-shape documents again/);
    assert.strictEqual(
      (await kit.backgroundStatus('0001-v2.js')).status,
      'completed',
      'audit wrote nothing',
    );

    await mongo.db.collection('_migronaut_background').deleteOne({ _id: '0002-broken.js' });
    const states = mongo.db.collection('_migronaut_background');
    await states.updateOne(
      { _id: '0001-v2.js' },
      { $set: { status: 'running', lastProgressAt: new Date(0), checksum: 'old' } },
    );
    const state = await states.findOne({ _id: '0001-v2.js' });
    await mongo.db.collection('_migronaut_background_partitions').insertMany([
      {
        background: '0001-v2.js',
        generation: state.generation,
        plan: 'stale-plan',
        status: 'pending',
      },
      {
        background: '0001-v2.js',
        generation: state.generation,
        plan: state.plan.token,
        status: 'failed',
        seq: 9,
        _id: new ObjectId(),
      },
    ]);
    const warning = await checkOf(kit);
    assert.strictEqual(warning.status, 'warn');
    for (const pattern of [
      /running but stalled/,
      /1 failed partition/,
      /partition\(s\) of an old plan/,
      /changed on disk/,
      /0002-broken\.js is applied but its background migration is not registered/,
    ]) {
      assert.match(warning.detail, pattern);
    }
  });
});
