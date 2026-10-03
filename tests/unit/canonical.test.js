const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Decimal128, Double, Int32, Long, ObjectId, Timestamp } = require('mongodb');
const { canonical, deepEqual, isPlainObject, toWire } = require('../../src/utils/canonical.js');

describe('canonical / deepEqual', () => {
  it('should ignore object key order but not array order', () => {
    assert.ok(deepEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }));
    assert.ok(!deepEqual({ required: ['a', 'b'] }, { required: ['b', 'a'] }));
  });

  it('should drop undefined properties, like a client with ignoreUndefined', () => {
    assert.ok(deepEqual({ a: 1, b: undefined }, { a: 1 }));
    // …but an undefined array slot is what BSON stores as null.
    assert.deepStrictEqual(canonical([undefined]), [null]);
  });

  it('should treat BSON number wrappers as the plain numbers they stand for', () => {
    assert.ok(deepEqual({ n: new Int32(5) }, { n: 5 }));
    assert.ok(deepEqual({ n: new Double(1.5) }, { n: 1.5 }));
    assert.ok(deepEqual({ n: Long.fromNumber(7) }, { n: 7 }));
    assert.ok(deepEqual({ n: 7n }, { n: 7 }));
    assert.ok(deepEqual(-0, 0));
  });

  it('should keep a Long or BigInt beyond the safe range exact', () => {
    const big = Long.fromString('9007199254740993');
    assert.deepStrictEqual(canonical(big), { $long: '9007199254740993' });
    assert.deepStrictEqual(canonical(9007199254740993n), { $long: '9007199254740993' });
    assert.ok(!deepEqual(big, Long.fromString('9007199254740994')));
  });

  it('should tag non-finite numbers instead of collapsing them to null', () => {
    assert.deepStrictEqual(canonical(Number.NaN), { $number: 'NaN' });
    assert.deepStrictEqual(canonical(Number.POSITIVE_INFINITY), { $number: 'Infinity' });
    assert.deepStrictEqual(canonical(Number.NEGATIVE_INFINITY), { $number: '-Infinity' });
  });

  it('should compare dates, regular expressions and ObjectIds by value', () => {
    assert.ok(deepEqual(new Date('2026-01-01T00:00:00Z'), new Date(Date.UTC(2026, 0, 1))));
    assert.deepStrictEqual(canonical(new Date('nope')), { $date: 'invalid' });
    // Flags in another order, built at runtime: the formatter sorts a literal's.
    const flags = ['m', 'i'].join('');
    assert.ok(deepEqual(new RegExp('^a', flags), /^a/im));
    assert.ok(!deepEqual(/^a/i, /^a/));
    const id = new ObjectId();
    assert.ok(deepEqual({ id }, { id: new ObjectId(id.toHexString()) }));
  });

  it('should tag the remaining BSON values by type', () => {
    assert.deepStrictEqual(canonical(Decimal128.fromString('1.10')), { $decimal: '1.10' });
    const ts = canonical(new Timestamp({ t: 1, i: 2 }));
    assert.strictEqual(ts.$bson, 'Timestamp');
  });

  it('should read a Map like an object and refuse to equate class instances', () => {
    assert.ok(
      deepEqual(
        new Map([
          ['b', 1],
          ['a', 2],
        ]),
        { a: 2, b: 1 },
      ),
    );
    class Thing {}
    assert.deepStrictEqual(canonical(new Thing()), { $opaque: 'object' });
    assert.deepStrictEqual(
      canonical(() => 1),
      { $opaque: 'function' },
    );
  });
});

describe('toWire', () => {
  it('should strip undefined properties at every depth and keep everything else', () => {
    const date = new Date();
    const wire = toWire({ a: undefined, b: { c: undefined, d: [1, { e: undefined }] }, date });
    assert.deepStrictEqual(wire, { b: { d: [1, {}] }, date });
    assert.strictEqual(wire.date, date);
  });

  it('should pass non-plain values through untouched', () => {
    const map = new Map();
    assert.strictEqual(toWire(map), map);
    assert.strictEqual(toWire(5), 5);
  });
});

describe('isPlainObject', () => {
  it('should accept object literals and null-prototype objects only', () => {
    assert.ok(isPlainObject({}));
    assert.ok(isPlainObject(Object.create(null)));
    assert.ok(!isPlainObject([]));
    assert.ok(!isPlainObject(new Date()));
    assert.ok(!isPlainObject(null));
  });
});
