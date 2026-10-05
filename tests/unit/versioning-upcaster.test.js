const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ObjectId } = require('mongodb');
const { ConfigInvalidError, ShapeVersionError } = require('../../src/errors/index.js');
const { defineShapes, upcaster } = require('../../src/versioning/index.js');

const orders = { name: 'orders', versioning: { current: 3 } };
const steps = {
  1: ({ address, ...doc }) => ({ ...doc, shipping: { address } }),
  2: (doc) => ({ ...doc, currency: doc.currency ?? 'EUR' }),
};

const shapeError = (reason) => (error) => {
  assert.ok(error instanceof ShapeVersionError);
  assert.strictEqual(error.code, 'SHAPE_VERSION_UNSUPPORTED');
  assert.strictEqual(error.context.reason, reason);
  return true;
};

describe('upcaster', () => {
  it('should lift a document step by step, stamping each version', () => {
    const seen = [];
    const traced = upcaster(orders, {
      1: (doc) => {
        seen.push(doc.__v);
        return steps[1](doc);
      },
      2: (doc) => {
        seen.push(doc.__v);
        return steps[2](doc);
      },
    });
    const id = new ObjectId();
    const doc = { _id: id, address: 'Main St', __v: 1, __rev: 4 };
    assert.deepStrictEqual(traced.upcast(doc), {
      _id: id,
      __v: 3,
      __rev: 4,
      shipping: { address: 'Main St' },
      currency: 'EUR',
    });
    assert.deepStrictEqual(seen, [1, 2]);
    assert.deepStrictEqual(doc, { _id: id, address: 'Main St', __v: 1, __rev: 4 }, 'not mutated');
  });

  it('should return a current document as it is', () => {
    const doc = { __v: 3 };
    assert.strictEqual(upcaster(orders, steps).upcast(doc), doc);
    assert.ok(!upcaster(orders, steps).needsUpcast(doc));
    assert.ok(upcaster(orders, steps).needsUpcast({ __v: 2 }));
    assert.ok(!upcaster(orders, steps).needsUpcast('x'));
  });

  it('should refuse a newer document unless told to keep it', () => {
    const doc = { __v: 4 };
    assert.throws(() => upcaster(orders, steps).upcast(doc), shapeError('newer'));
    assert.strictEqual(upcaster(orders, steps, { newer: 'keep' }).upcast(doc), doc);
    assert.throws(
      () => upcaster(orders, steps).upcast(doc),
      (error) => error.context.collection === 'orders' && error.context.version === 4,
    );
  });

  it('should refuse a document below min without a step, and an invalid version', () => {
    assert.throws(() => upcaster(orders, steps).upcast({}), shapeError('below-min'));
    assert.throws(() => upcaster(orders, steps).upcast({ __v: 'x' }), shapeError('invalid'));
    assert.throws(() => upcaster(orders, steps).upcast(null), shapeError('invalid'));
    // A step below min is history kept on purpose: it still lifts.
    const withHistory = upcaster(orders, { 0: (doc) => ({ ...doc, address: '?' }), ...steps });
    assert.strictEqual(withHistory.upcast({}).__v, 3);
  });

  it('should refuse a step that returns a promise or not a document', () => {
    assert.throws(
      () => upcaster(orders, { ...steps, 2: () => Promise.resolve({}) }).upcast({ __v: 2 }),
      shapeError('invalid'),
    );
    assert.throws(
      () => upcaster(orders, { ...steps, 2: () => null }).upcast({ __v: 2 }),
      shapeError('invalid'),
    );
  });

  it('should check the steps cover min to current when it is made', () => {
    const refuse = (definition, list, pattern) =>
      assert.throws(
        () => upcaster(definition, list),
        (error) => error instanceof ConfigInvalidError && pattern.test(error.message),
      );
    refuse(orders, { 1: steps[1] }, /no step from version 2/);
    refuse(orders, { ...steps, 3: steps[2] }, /goes past the current version 3/);
    refuse(orders, { ...steps, x: steps[2] }, /"x" is not a version/);
    refuse(orders, { ...steps, '01': steps[2] }, /"01" is not a version/);
    refuse(orders, { ...steps, 2: 'nope' }, /must be a function/);
    refuse(orders, { ...steps, 2: async (doc) => doc }, /async/);
    refuse(orders, null, /steps must be an object/);
    assert.throws(() => upcaster(null, steps), /collection definition/);
    assert.throws(() => upcaster(orders, steps, { newer: 'drop' }), /newer must be/);
  });

  it('should take a bare versioning block, and min 0', () => {
    const adopt = upcaster({ current: 1, min: 0 }, { 0: (doc) => ({ ...doc, tags: [] }) });
    assert.deepStrictEqual(adopt.upcast({ a: 1 }), { a: 1, tags: [], __v: 1 });
    assert.strictEqual(adopt.min, 0);
    assert.strictEqual(adopt.field, '__v');
  });

  it('should hand out a step, or a range of them, as a background migrate', () => {
    const shapes = upcaster(orders, steps);
    const one = shapes.step(1);
    assert.deepStrictEqual(one({ _id: 1, address: 'x', __v: 1 }), {
      _id: 1,
      __v: 2,
      shipping: { address: 'x' },
    });
    assert.strictEqual(shapes.step(1, 3)({ address: 'x', __v: 1 }).currency, 'EUR');
    assert.throws(() => shapes.step(2, 2), /not a forward range/);
    assert.throws(() => shapes.step(-1), /not a forward range/);
    assert.throws(() => shapes.step(2, 4), /goes past 3/);
    assert.throws(() => shapes.step(0), /no step from version 0/);
  });

  it('should be reachable through defineShapes, named in its errors', () => {
    const registry = defineShapes({ orders });
    const lifted = registry.upcaster('orders', steps);
    assert.strictEqual(lifted.upcast({ address: 'x', __v: 1 }).__v, 3);
    assert.throws(
      () => registry.upcaster('orders', { 1: steps[1] }),
      /upcaster\(orders\): no step from version 2/,
    );
  });
});
