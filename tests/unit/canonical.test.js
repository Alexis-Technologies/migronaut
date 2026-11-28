const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Decimal128, Double, Int32, Long, ObjectId, Timestamp } = require('mongodb');
const {
  canonicalize,
  isDeepEqual,
  isPlainObject,
  toWire,
} = require('../../src/utils/canonical.js');

describe('canonical / isDeepEqual', () => {
  it('should ignore object key order but not array order', () => {
    assert.ok(isDeepEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }));
    assert.ok(!isDeepEqual({ required: ['a', 'b'] }, { required: ['b', 'a'] }));
  });

  it('should drop undefined properties, like a client with ignoreUndefined', () => {
    assert.ok(isDeepEqual({ a: 1, b: undefined }, { a: 1 }));
    // …but an undefined array slot is what BSON stores as null.
    assert.deepStrictEqual(canonicalize([undefined]), [null]);
  });

  it('should treat BSON number wrappers as the plain numbers they stand for', () => {
    assert.ok(isDeepEqual({ n: new Int32(5) }, { n: 5 }));
    assert.ok(isDeepEqual({ n: new Double(1.5) }, { n: 1.5 }));
    assert.ok(isDeepEqual({ n: Long.fromNumber(7) }, { n: 7 }));
    assert.ok(isDeepEqual({ n: 7n }, { n: 7 }));
    assert.ok(isDeepEqual(-0, 0));
  });

  it('should keep a Long or BigInt beyond the safe range exact', () => {
    const big = Long.fromString('9007199254740993');
    assert.deepStrictEqual(canonicalize(big), { $long: '9007199254740993' });
    assert.deepStrictEqual(canonicalize(9007199254740993n), { $long: '9007199254740993' });
    assert.ok(!isDeepEqual(big, Long.fromString('9007199254740994')));
  });

  it('should tag non-finite numbers instead of collapsing them to null', () => {
    assert.deepStrictEqual(canonicalize(Number.NaN), { $number: 'NaN' });
    assert.deepStrictEqual(canonicalize(Number.POSITIVE_INFINITY), { $number: 'Infinity' });
    assert.deepStrictEqual(canonicalize(Number.NEGATIVE_INFINITY), { $number: '-Infinity' });
  });

  it('should compare dates, regular expressions and ObjectIds by value', () => {
    assert.ok(isDeepEqual(new Date('2026-01-01T00:00:00Z'), new Date(Date.UTC(2026, 0, 1))));
    assert.deepStrictEqual(canonicalize(new Date('nope')), { $date: 'invalid' });
    // Flags in another order, built at runtime: the formatter sorts a literal's.
    const flags = ['m', 'i'].join('');
    assert.ok(isDeepEqual(new RegExp('^a', flags), /^a/im));
    assert.ok(!isDeepEqual(/^a/i, /^a/));
    const id = new ObjectId();
    assert.ok(isDeepEqual({ id }, { id: new ObjectId(id.toHexString()) }));
  });

  it('should tag the remaining BSON values by type', () => {
    assert.deepStrictEqual(canonicalize(Decimal128.fromString('1.10')), { $decimal: '1.10' });
    const ts = canonicalize(new Timestamp({ t: 1, i: 2 }));
    assert.strictEqual(ts.$bson, 'Timestamp');
  });

  it('should read a Map like an object and refuse to equate class instances', () => {
    assert.ok(
      isDeepEqual(
        new Map([
          ['b', 1],
          ['a', 2],
        ]),
        { a: 2, b: 1 },
      ),
    );
    class Thing {}
    assert.deepStrictEqual(canonicalize(new Thing()), { $opaque: 'object' });
    assert.deepStrictEqual(
      canonicalize(() => 1),
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

  it('should leave the holes of a sparse array where they were', () => {
    const declared = [{ a: undefined, b: 1 }];
    declared[2] = 'c';
    declared.length = 4;
    const wire = toWire(declared);
    assert.strictEqual(wire.length, 4);
    assert.ok(!(1 in wire) && !(3 in wire), 'a hole is not turned into undefined');
    assert.deepStrictEqual(Object.keys(wire), ['0', '2']);
    assert.deepStrictEqual(wire[0], { b: 1 });
    assert.ok(isDeepEqual(wire, declared));
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

describe('canonical — what survives the trip to the server', () => {
  const { BSONRegExp } = require('mongodb');
  const { checkRegExp } = require('../../src/utils/canonical.js');

  it('should compare a RegExp by the options the driver stores', () => {
    // i and m as they are; the driver writes g as dotAll (s), and reads s back as g.
    assert.ok(isDeepEqual(/x/i, /x/i));
    assert.ok(isDeepEqual(new BSONRegExp('x', 's'), /x/g));
    assert.ok(!isDeepEqual(/x/i, /x/m));
  });

  it('should refuse RegExp flags the driver changes or drops, and accept the rest', () => {
    assert.strictEqual(checkRegExp({ a: /x/i, b: [/y/m] }), null);
    assert.strictEqual(checkRegExp({ a: new BSONRegExp('x', 'sx') }), null);
    for (const regExp of [/x/g, /x/s, /x/u, /x/y]) {
      assert.match(checkRegExp({ $and: [{ a: regExp }] }), /cannot be stored as written/);
    }
  });

  it('should keep a __proto__ key a key — in comparison and on the wire', () => {
    const declared = JSON.parse('{"__proto__": {"a": 1}, "b": 2}');
    assert.deepStrictEqual(Object.keys(canonicalize(declared)), ['__proto__', 'b']);
    assert.ok(!isDeepEqual(declared, { b: 2 }), 'the key is not silently lost');
    const wire = toWire(declared);
    assert.deepStrictEqual(Object.keys(wire), ['__proto__', 'b']);
    assert.strictEqual(Object.getPrototypeOf(wire), Object.prototype);
  });
});
