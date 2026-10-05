const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Timestamp } = require('mongodb');
const {
  classifyStreamError,
  edgesOf,
  isEnding,
  lagOf,
  suspendedBy,
  tokenDue,
  watchPipeline,
} = require('../../src/core/background-watch-plan.js');
const { WATCH_DEFAULTS, watchOptions } = require('../../src/core/background-watch.js');
const { ConfigInvalidError } = require('../../src/errors/index.js');

const state = (name, fields) => ({
  _id: name,
  status: 'completed',
  direction: 'forward',
  spec: { collection: 'orders', mode: 'declarative', from: 1, to: 2 },
  ...fields,
});
const withSpec = (name, spec, fields) =>
  state(name, { ...fields, spec: { collection: 'orders', mode: 'declarative', ...spec } });

describe('background-watch-plan — edges and suspension', () => {
  it('should take completed forward declarative migrations of the collection as its edges', () => {
    const { edges, target } = edgesOf(
      [
        withSpec('a.js', { from: 1, to: 2 }),
        withSpec('b.js', { from: 2, to: 3 }),
        withSpec('dup.js', { from: 1, to: 2 }),
        withSpec('running.js', { from: 3, to: 4 }, { status: 'running' }),
        withSpec('revert.js', { from: 4, to: 5 }, { direction: 'revert' }),
        withSpec('step.js', { from: 5, to: 6, mode: 'step' }),
        withSpec('other.js', { from: 0, to: 9, collection: 'users' }),
      ],
      'orders',
    );
    assert.deepStrictEqual([...edges.keys()], [1, 2]);
    assert.strictEqual(edges.get(1).name, 'a.js', 'the first registered wins');
    assert.strictEqual(target, 3);
    assert.deepStrictEqual(edgesOf([], 'orders'), { edges: new Map(), target: undefined });
  });

  it('should stand aside while a revert of the collection is not settled', () => {
    const revert = (status) =>
      withSpec('r.js', { from: 1, to: 2 }, { direction: 'revert', status });
    assert.strictEqual(suspendedBy([revert('running')], 'orders'), 'r.js');
    assert.strictEqual(suspendedBy([revert('paused')], 'orders'), 'r.js');
    assert.strictEqual(suspendedBy([revert('completed')], 'orders'), undefined);
    assert.strictEqual(suspendedBy([revert('running')], 'users'), undefined);
    assert.strictEqual(suspendedBy([state('f.js', { status: 'running' })], 'orders'), undefined);
  });
});

describe('background-watch-plan — the stream', () => {
  it('should ask only for writes that can leave a document below the target', () => {
    const [match, project] = watchPipeline('__v', 3);
    const [inserts, updates, endings] = match.$match.$or;
    assert.deepStrictEqual(inserts.operationType, { $in: ['insert', 'replace'] });
    assert.deepStrictEqual(inserts.$or[0], { 'fullDocument.__v': { $lt: 3 } });
    assert.deepStrictEqual(updates.$or, [
      { 'updateDescription.updatedFields.__v': { $lt: 3 } },
      { 'updateDescription.updatedFields.__v': { $exists: true, $type: 'null' } },
      { 'updateDescription.removedFields': '__v' },
    ]);
    assert.deepStrictEqual(endings.operationType.$in.sort(), [
      'drop',
      'dropDatabase',
      'invalidate',
      'rename',
    ]);
    assert.deepStrictEqual(project, {
      $project: { operationType: 1, documentKey: 1, clusterTime: 1 },
    });
  });

  it('should read stream errors', () => {
    const coded = (code) => Object.assign(new Error('x'), { code });
    for (const code of [286, 280, 136])
      assert.strictEqual(classifyStreamError(coded(code)), 'history-lost');
    assert.strictEqual(classifyStreamError(coded(13)), 'unauthorized');
    assert.strictEqual(classifyStreamError(coded(40573)), 'unsupported');
    assert.strictEqual(classifyStreamError(coded(6)), 'retry');
    assert.strictEqual(classifyStreamError(undefined), 'retry');
    const labelled = Object.assign(new Error('x'), {
      hasErrorLabel: (label) => label === 'NonResumableChangeStreamError',
    });
    assert.strictEqual(classifyStreamError(labelled), 'history-lost');
  });

  it('should tell an ending event, a lag and a due token', () => {
    assert.ok(isEnding({ operationType: 'drop' }));
    assert.ok(!isEnding({ operationType: 'insert' }));
    assert.ok(!isEnding(null));
    assert.strictEqual(lagOf({ clusterTime: new Timestamp({ t: 100, i: 1 }) }, 101_500), 1_500);
    assert.strictEqual(lagOf({ clusterTime: new Timestamp({ t: 200, i: 1 }) }, 100_000), 0);
    assert.strictEqual(lagOf({}, 1), undefined);
    assert.strictEqual(lagOf({ clusterTime: {} }, 1), undefined);
    assert.ok(tokenDue(undefined, 0, 5_000));
    assert.ok(!tokenDue(1_000, 2_000, 5_000));
    assert.ok(tokenDue(1_000, 6_000, 5_000));
    assert.ok(tokenDue(1_000, 1_001, 5_000, { force: true }));
  });
});

describe('watchOptions', () => {
  it('should fill in the defaults and keep a list of collections as a set', () => {
    assert.deepStrictEqual(watchOptions({}), { ...WATCH_DEFAULTS });
    const resolved = watchOptions({ collections: ['orders'], upgrade: false, maxLagMs: 5 });
    assert.ok(resolved.collections.has('orders'));
    assert.strictEqual(resolved.upgrade, false);
    assert.strictEqual(resolved.maxLagMs, 5);
  });

  it('should refuse what it cannot use', () => {
    for (const bad of [
      null,
      { checkpointMs: 1.5 },
      { maxCollections: 0 },
      { upgrade: 1 },
      { collections: [1] },
      { collections: 'orders' },
      { signal: {} },
      { onError: 'x' },
    ]) {
      assert.throws(() => watchOptions(bad), ConfigInvalidError);
    }
  });
});
