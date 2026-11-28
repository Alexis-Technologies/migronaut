const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Int32 } = require('mongodb');
const {
  isVersioningIndexKey,
  readLiveVersionFloor,
  buildShardedVersionIndexKey,
  explainFloorConflict,
  resolveFloorToCheck,
} = require('../../src/core/converge/versioning-spec.js');
const { resolveVersioning } = require('../../src/versioning/config.js');

const versioning = resolveVersioning({ current: 2 });
const withFloor = (minimum) => ({
  validator: { $jsonSchema: { properties: { __v: { bsonType: 'int', minimum } } } },
});

describe('versioning-spec — the version floor', () => {
  it('should read the floor the live validator enforces', () => {
    assert.strictEqual(readLiveVersionFloor(withFloor(2), versioning), 2);
    assert.strictEqual(readLiveVersionFloor(withFloor(new Int32(1)), versioning), 1);
    assert.strictEqual(readLiveVersionFloor({}, versioning), null);
    assert.strictEqual(readLiveVersionFloor(undefined, versioning), null);
    assert.strictEqual(
      readLiveVersionFloor(
        { validator: { $jsonSchema: { properties: { __v: true } } } },
        versioning,
      ),
      null,
    );
  });

  it('should check the data only when the floor rises on an existing collection', () => {
    const live = (options) => ({ exists: true, options, indexes: [] });
    const definition = { versioning };
    assert.strictEqual(resolveFloorToCheck(definition, live(withFloor(0))), 1);
    assert.strictEqual(resolveFloorToCheck(definition, live({})), 1);
    assert.strictEqual(resolveFloorToCheck(definition, live(withFloor(1))), null);
    assert.strictEqual(resolveFloorToCheck(definition, live(withFloor(3))), null);
    assert.strictEqual(resolveFloorToCheck(definition, { exists: false, indexes: [] }), null);
    assert.strictEqual(
      resolveFloorToCheck(definition, { exists: true, type: 'view', indexes: [] }),
      null,
    );
    assert.strictEqual(
      resolveFloorToCheck({ versioning: resolveVersioning({ current: 1, min: 0 }) }, live({})),
      null,
    );
    assert.strictEqual(resolveFloorToCheck({}, live({})), null);
  });

  it('should explain a refused raise without naming a document', () => {
    assert.strictEqual(explainFloorConflict(undefined), undefined);
    assert.strictEqual(explainFloorConflict({ min: 2, below: false }), undefined);
    assert.match(explainFloorConflict({ min: 2, below: true }), /below version 2 remain/);
    assert.match(
      explainFloorConflict({ min: 2, below: 'unknown', error: 'boom' }),
      /could not check .*\(boom\)/,
    );
  });

  it('should recognise the version index key', () => {
    assert.ok(isVersioningIndexKey({ __v: 1, _id: 1 }, versioning));
    assert.ok(!isVersioningIndexKey({ __v: 1 }, versioning));
    assert.ok(!isVersioningIndexKey({ _id: 1, __v: 1 }, versioning));
    assert.ok(!isVersioningIndexKey(null, versioning));
  });
});

describe('versioning-spec — the version index of a sharded collection', () => {
  it('should put the shard key between the version field and _id', () => {
    assert.deepStrictEqual(buildShardedVersionIndexKey(versioning, { region: 1, at: -1 }), {
      __v: 1,
      region: 1,
      at: -1,
      _id: 1,
    });
    assert.deepStrictEqual(buildShardedVersionIndexKey(versioning, { uid: 'hashed' }), {
      __v: 1,
      uid: 'hashed',
      _id: 1,
    });
    assert.deepStrictEqual(buildShardedVersionIndexKey(versioning, { _id: 'hashed' }), {
      __v: 1,
      _id: 'hashed',
    });
    assert.deepStrictEqual(buildShardedVersionIndexKey(versioning, { _id: 1 }), { __v: 1, _id: 1 });
    assert.deepStrictEqual(buildShardedVersionIndexKey(versioning, { __v: 1, k: 1 }), {
      __v: 1,
      k: 1,
      _id: 1,
    });
  });
});
