const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ConfigInvalidError } = require('../../src/errors/index.js');
const { defineShapes, versioningPlugin } = require('../../src/versioning/index.js');

/** Just enough of a Mongoose schema to see what the plugin does to it */
function fakeSchema({ versionKey = '__v', paths = {} } = {}) {
  const options = { versionKey };
  const hooks = [];
  return {
    options,
    hooks,
    paths,
    set: (key, value) => {
      options[key] = value;
    },
    get: (key) => options[key],
    add: (definition) => Object.assign(paths, definition),
    path: (name) => paths[name],
    pre: (hook, fn) => hooks.push([hook, fn]),
    run(hook, self) {
      for (const [names, fn] of hooks) {
        if (names === hook || (Array.isArray(names) && names.includes(hook))) fn.call(self);
      }
    },
  };
}

/** A Mongoose query's `this` for the update hooks */
function fakeQuery(update, options = {}) {
  return {
    update,
    getUpdate() {
      return this.update;
    },
    setUpdate(next) {
      this.update = next;
    },
    getOptions: () => options,
  };
}

/** A Mongoose document's `this` for the document hooks */
function fakeDoc(fields, { isNew = true, where } = {}) {
  return {
    isNew,
    fields: { ...fields },
    $where: where,
    get(name) {
      return this.fields[name];
    },
    set(name, value) {
      this.fields[name] = value;
    },
  };
}

const orders = { versioning: { current: 2 } };

describe('versioningPlugin', () => {
  it('should make the revision the version key, with optimistic concurrency', () => {
    const schema = fakeSchema();
    versioningPlugin(schema, orders);
    assert.strictEqual(schema.options.versionKey, '__rev');
    assert.strictEqual(schema.options.optimisticConcurrency, true);
    assert.deepStrictEqual(schema.paths.__v, { type: Number });
    assert.strictEqual(schema.paths.__v.default, undefined, 'no default: loads stay unstamped');
  });

  it('should stamp a new document only, and only when it has no version', () => {
    const schema = fakeSchema();
    versioningPlugin(schema, orders);
    const created = fakeDoc({});
    schema.run('validate', created);
    assert.strictEqual(created.fields.__v, 2);
    const explicit = fakeDoc({ __v: 1 });
    schema.run('save', explicit);
    assert.strictEqual(explicit.fields.__v, 1);
    const loaded = fakeDoc({}, { isNew: false });
    schema.run('save', loaded);
    assert.strictEqual(loaded.fields.__v, undefined, 'a loaded legacy document is not stamped');
  });

  it('should guard the save of a document loaded without a revision', () => {
    const schema = fakeSchema();
    versioningPlugin(schema, orders);
    const legacy = fakeDoc({}, { isNew: false, where: { tenant: 't' } });
    schema.run('save', legacy);
    assert.deepStrictEqual(legacy.$where, { tenant: 't', __rev: { $in: [null, 0] } });
    legacy.fields.__rev = 1;
    schema.run('save', legacy);
    assert.deepStrictEqual(legacy.$where, { tenant: 't' }, 'Mongoose guards it from now on');
    const created = fakeDoc({});
    schema.run('save', created);
    assert.strictEqual(created.$where, undefined);
  });

  it('should bump the revision of every update, and stamp an upsert', () => {
    const schema = fakeSchema();
    versioningPlugin(schema, orders);
    const update = fakeQuery({ $set: { a: 1 } });
    schema.run('updateOne', update);
    assert.deepStrictEqual(update.update, { $set: { a: 1 }, $inc: { __rev: 1 } });

    // Mongoose adds `$setOnInsert: { versionKey: 0 }` to an upsert itself.
    const upsert = fakeQuery({ name: 'x', $setOnInsert: { __rev: 0 } }, { upsert: true });
    schema.run('findOneAndUpdate', upsert);
    assert.deepStrictEqual(upsert.update, {
      name: 'x',
      $inc: { __rev: 1 },
      $setOnInsert: { __v: 2 },
    });

    const mongooseOnly = fakeQuery({ $set: { a: 1 }, $setOnInsert: { __rev: 0 } });
    schema.run('updateMany', mongooseOnly);
    assert.deepStrictEqual(mongooseOnly.update, { $set: { a: 1 }, $inc: { __rev: 1 } });
  });

  it('should leave alone updates that handle the revision, set the version, or are pipelines', () => {
    const schema = fakeSchema();
    versioningPlugin(schema, orders);
    for (const update of [
      { $inc: { __rev: 5 } },
      { $setOnInsert: { __rev: 3 } },
      { $rename: { a: '__rev' } },
      [{ $set: { a: 1 } }],
    ]) {
      const query = fakeQuery(update);
      schema.run('updateOne', query);
      assert.strictEqual(query.update, update);
    }
    const versioned = fakeQuery({ $set: { __v: 3 } }, { upsert: true });
    schema.run('updateOne', versioned);
    assert.deepStrictEqual(versioned.update, { $set: { __v: 3 }, $inc: { __rev: 1 } });
    const nothing = fakeQuery(null);
    schema.run('updateOne', nothing);
    assert.strictEqual(nothing.update, null);
  });

  it('should only stamp, and turn Mongoose versioning off its field, without revisions', () => {
    const schema = fakeSchema();
    versioningPlugin(schema, { current: 1, revision: false });
    assert.strictEqual(schema.options.versionKey, false);
    assert.strictEqual(schema.options.optimisticConcurrency, undefined);
    assert.deepStrictEqual(
      schema.hooks.map(([hook]) => hook),
      ['validate', 'save'],
    );
    const other = fakeSchema({ versionKey: '__version' });
    versioningPlugin(other, { current: 1, revision: false });
    assert.strictEqual(other.options.versionKey, '__version');
  });

  it('should keep an existing version path without a default, and refuse one with', () => {
    const kept = fakeSchema({ paths: { __v: { defaultValue: undefined } } });
    versioningPlugin(kept, orders);
    assert.deepStrictEqual(kept.paths.__v, { defaultValue: undefined });
    assert.throws(
      () => versioningPlugin(fakeSchema({ paths: { __v: { defaultValue: 1 } } }), orders),
      (error) => error instanceof ConfigInvalidError && /gives "__v" a default/.test(error.message),
    );
  });

  it('should refuse what is not a schema or a definition', () => {
    assert.throws(() => versioningPlugin({}, orders), /takes a Mongoose schema/);
    assert.throws(
      () => versioningPlugin(fakeSchema(), undefined),
      /needs the collection definition/,
    );
    assert.throws(
      () => versioningPlugin(fakeSchema(), { versioning: { current: 0 } }),
      ConfigInvalidError,
    );
  });

  it('should be reachable through defineShapes', () => {
    const schema = fakeSchema();
    defineShapes({ orders: { versioning: { current: 3, revisionField: 'rev' } } }).plugin('orders')(
      schema,
    );
    assert.strictEqual(schema.options.versionKey, 'rev');
    const created = fakeDoc({});
    schema.run('validate', created);
    assert.strictEqual(created.fields.__v, 3);
  });
});
