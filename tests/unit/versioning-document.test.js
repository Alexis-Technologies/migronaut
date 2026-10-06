const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} = require('mongodb');
const { ConfigInvalidError, ShapeVersionError } = require('../../src/errors/index.js');
const {
  VERSIONING_DEFAULTS,
  resolveVersioning,
  versioningIssues,
  versioningOf,
} = require('../../src/versioning/config.js');
const {
  belowVersionFilter,
  cloneDocument,
  fieldNameIssue,
  isVersion,
  nextRevision,
  occFilter,
  resolveFieldNames,
  revisionFilter,
  revisionOf,
  stampDocument,
  stampedDiff,
  stampedUpdate,
  versionFilter,
  versionIndexKey,
  versionOf,
} = require('../../src/versioning/document.js');
const {
  filterTouches,
  sameValue,
  toCount,
  touchedFields,
} = require('../../src/versioning/internal.js');

const names = { field: '__v', revisionField: '__rev' };
const noRevision = { field: '__v', revisionField: null };

describe('versioning internals', () => {
  it('should read every integer form the driver can hand back as a count', () => {
    for (const [value, expected] of [
      [0, 0],
      [3, 3],
      [new Int32(4), 4],
      [new Double(5), 5],
      [Long.fromNumber(6), 6],
      [7n, 7],
      [-1, null],
      [1.5, null],
      [new Double(1.5), null],
      [Long.fromNumber(-2), null],
      [Long.fromString('9007199254740993'), null],
      [2n ** 60n, null],
      [-1n, null],
      ['1', null],
      [null, null],
      [{}, null],
    ]) {
      assert.strictEqual(toCount(value), expected, `toCount(${String(value)})`);
    }
  });

  it('should compare BSON values by class and content', () => {
    const id = new ObjectId();
    const equal = [
      [1, 1],
      [NaN, NaN],
      ['a', 'a'],
      [null, null],
      [new ObjectId(id.toHexString()), id],
      [Long.fromNumber(5), Long.fromNumber(5)],
      [new Timestamp({ t: 1, i: 2 }), new Timestamp({ t: 1, i: 2 })],
      [new Int32(3), new Int32(3)],
      [new Double(1), new Double(1)],
      [Decimal128.fromString('1.5'), Decimal128.fromString('1.5')],
      [new Binary(Buffer.from('ab'), 0), new Binary(Buffer.from('ab'), 0)],
      [
        new UUID('a8098c1a-f86e-11da-bd1a-00112444be1e'),
        new UUID('a8098c1a-f86e-11da-bd1a-00112444be1e'),
      ],
      [new BSONRegExp('x', 'i'), new BSONRegExp('x', 'i')],
      [new BSONSymbol('s'), new BSONSymbol('s')],
      [new MinKey(), new MinKey()],
      [new MaxKey(), new MaxKey()],
      [new Code('f()', { a: 1 }), new Code('f()', { a: 1 })],
      [new DBRef('c', id), new DBRef('c', id)],
      [new Date(5), new Date(5)],
      [/x/i, /x/i],
      [new Uint8Array([1, 2]), new Uint8Array([1, 2])],
      [
        [1, { a: 2 }],
        [1, { a: 2 }],
      ],
      [
        { a: 1, b: { c: 2 } },
        { a: 1, b: { c: 2 } },
      ],
    ];
    for (const [a, b] of equal) assert.ok(sameValue(a, b), `${String(a)} should equal`);
    const different = [
      [0, -0],
      [1, '1'],
      [1, new Int32(1)],
      [new Int32(1), new Double(1)],
      [Long.fromNumber(5), Long.fromNumber(6)],
      [Long.fromNumber(5), new Timestamp({ t: 0, i: 5 })],
      [Decimal128.fromString('1.0'), Decimal128.fromString('1.00')],
      [new Binary(Buffer.from('ab'), 0), new Binary(Buffer.from('ab'), 4)],
      [new BSONRegExp('x', 'i'), new BSONRegExp('x', 'm')],
      [new MinKey(), new MaxKey()],
      [new Code('f()'), new Code('g()')],
      [new DBRef('c', id), new DBRef('d', id)],
      [new Date(5), new Date(6)],
      [new Date(5), 5],
      [/x/i, /x/g],
      [/x/, 'x'],
      [new Uint8Array([1]), new Uint16Array([1])],
      [new Uint8Array([1]), [1]],
      [
        [1, 2],
        [2, 1],
      ],
      [[1], { 0: 1 }],
      [{ 0: 1 }, [1]],
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      [{ a: 1 }, { a: 1, b: 2 }],
      [null, {}],
      [{ _bsontype: 'Unknown' }, { _bsontype: 'Unknown' }],
      [new Map(), new Map()],
    ];
    for (const [a, b] of different) assert.ok(!sameValue(a, b), `${String(a)} should differ`);
  });

  it('should clone plain structure and dates but share BSON values', () => {
    const id = new ObjectId();
    const source = { id, at: new Date(1), nested: { list: [1, { x: 2 }] } };
    const copy = cloneDocument(source);
    assert.notStrictEqual(copy.nested, source.nested);
    assert.notStrictEqual(copy.nested.list[1], source.nested.list[1]);
    assert.notStrictEqual(copy.at, source.at);
    assert.strictEqual(copy.at.getTime(), 1);
    assert.strictEqual(copy.id, id);
    assert.ok(sameValue(copy, source));
  });

  it('should list the top-level fields an update writes', () => {
    assert.deepStrictEqual(touchedFields({ a: 1, b: 2 }), {
      fields: new Set(['a', 'b']),
      whole: true,
    });
    assert.deepStrictEqual(
      touchedFields({ $set: { 'a.b': 1 }, $inc: { c: 1 }, $rename: { d: 'e.f' }, $comment: 'x' }),
      { fields: new Set(['a', 'c', 'd', 'e']), whole: false },
    );
    assert.deepStrictEqual(
      touchedFields([{ $set: { x: 1 } }, { $unset: ['y', 'z.w'] }, { $unset: 'q' }, 'bogus']),
      { fields: new Set(['x', 'y', 'z', 'q']), whole: false },
    );
    assert.strictEqual(touchedFields([{ $replaceWith: '$doc' }]).whole, true);
    assert.deepStrictEqual(touchedFields([{ $project: { a: 1 } }]), {
      fields: new Set(['a']),
      whole: true,
    });
    assert.deepStrictEqual(touchedFields('nope'), { fields: new Set(), whole: false });
  });

  it('should find a field in a filter through logical operators and $expr', () => {
    assert.ok(filterTouches({ __rev: 1 }, '__rev'));
    assert.ok(filterTouches({ 'a.b': 1 }, 'a'));
    assert.ok(filterTouches({ $and: [{ x: 1 }, { $or: [{ __rev: 2 }] }] }, '__rev'));
    assert.ok(filterTouches({ $expr: { $eq: ['$__rev', 1] } }, '__rev'));
    assert.ok(filterTouches({ $expr: { $eq: ['$__rev.n', 1] } }, '__rev'));
    assert.ok(!filterTouches({ $expr: { $eq: ['$__revision', 1] } }, '__rev'));
    assert.ok(!filterTouches({ $expr: null }, '__rev'));
    assert.ok(!filterTouches({ __revision: 1, $comment: '__rev' }, '__rev'));
    assert.ok(!filterTouches(null, '__rev'));
  });
});

describe('versioning settings', () => {
  it('should fill the defaults and freeze the result', () => {
    const resolved = resolveVersioning({ current: 2 });
    assert.deepStrictEqual(resolved, {
      current: 2,
      min: 1,
      field: '__v',
      revision: true,
      revisionField: '__rev',
      index: true,
    });
    assert.ok(Object.isFrozen(resolved));
    assert.strictEqual(VERSIONING_DEFAULTS.field, '__v');
  });

  it('should null the revision field when revisions are off', () => {
    assert.strictEqual(resolveVersioning({ current: 1, revision: false }).revisionField, null);
    assert.strictEqual(
      resolveVersioning({ current: 3, min: 0, field: 'schemaVersion', revisionField: 'rev' })
        .revisionField,
      'rev',
    );
  });

  it('should report every problem with its path', () => {
    const issues = versioningIssues(
      {
        current: 0,
        min: -1,
        field: '$v',
        revision: 'yes',
        revisionField: 'a.b',
        index: 1,
        extra: true,
      },
      'collections[0].versioning',
    );
    const byPath = Object.fromEntries(issues.map((issue) => [issue.path, issue.message]));
    assert.match(byPath['collections[0].versioning.extra'], /not a versioning key/);
    assert.match(byPath['collections[0].versioning.current'], /integer ≥ 1/);
    assert.match(byPath['collections[0].versioning.min'], /integer ≥ 0/);
    assert.match(byPath['collections[0].versioning.field'], /'\$'/);
    assert.match(byPath['collections[0].versioning.revision'], /boolean/);
    assert.match(byPath['collections[0].versioning.revisionField'], /top-level/);
    assert.match(byPath['collections[0].versioning.index'], /boolean/);
  });

  it('should refuse min above current, a missing current and clashing names', () => {
    const messages = (value) =>
      versioningIssues(value).map((issue) => `${issue.path} ${issue.message}`);
    assert.match(messages({ current: 2, min: 3 })[0], /min must not exceed current \(2\)/);
    assert.match(messages({})[0], /current is required/);
    assert.match(messages({ current: 1, field: '__rev' })[0], /must differ/);
    assert.match(messages({ current: 1, revision: false, revisionField: 'r' })[0], /no effect/);
    assert.deepStrictEqual(messages({ current: 1, field: 'x', revision: false }), []);
    assert.match(messages([])[0], /must be an object/);
    assert.throws(() => resolveVersioning({ current: 'two' }), ConfigInvalidError);
  });

  it('should validate system field names', () => {
    assert.strictEqual(fieldNameIssue('__v'), null);
    for (const bad of ['', 1, '$v', 'a.b', '_id', 'a\0b', 'x'.repeat(65)]) {
      assert.notStrictEqual(fieldNameIssue(bad), null, String(bad));
    }
  });

  it('should find a collection versioning in a list or a map', () => {
    const orders = { name: 'orders', versioning: { current: 2 } };
    assert.strictEqual(versioningOf([{ name: 'users' }, orders], 'orders').current, 2);
    assert.strictEqual(
      versioningOf({ orders: { versioning: { current: 3 } } }, 'orders').current,
      3,
    );
    assert.strictEqual(versioningOf([{ name: 'users' }], 'orders'), null);
    assert.strictEqual(versioningOf([{ name: 'orders' }], 'orders'), null);
    assert.strictEqual(versioningOf({}, 'orders'), null);
    assert.strictEqual(versioningOf(null, 'orders'), null);
    assert.throws(
      () => versioningOf({ orders: { versioning: { current: 0 } } }, 'orders'),
      (error) => error instanceof ConfigInvalidError && /orders\.versioning/.test(error.message),
    );
  });
});

describe('document versions and revisions', () => {
  it('should read a missing or null field as 0', () => {
    assert.strictEqual(versionOf({}), 0);
    assert.strictEqual(versionOf({ __v: null }), 0);
    assert.strictEqual(versionOf({ __v: new Int32(2) }), 2);
    assert.strictEqual(versionOf({ __v: Long.fromNumber(3) }), 3);
    assert.strictEqual(versionOf({ __v: 4n }), 4);
    assert.strictEqual(versionOf({ v: 5 }, 'v'), 5);
    assert.strictEqual(versionOf({ __v: 'x' }), null);
    assert.strictEqual(versionOf({ __v: -1 }), null);
    assert.strictEqual(versionOf(null), null);
    assert.strictEqual(revisionOf({}), 0);
    assert.strictEqual(revisionOf({ __rev: Long.fromNumber(2 ** 40) }), 2 ** 40);
    assert.strictEqual(nextRevision(4), 5);
    assert.strictEqual(nextRevision(undefined), 1);
  });

  it('should resolve system field names with defaults', () => {
    assert.deepStrictEqual(resolveFieldNames(), names);
    assert.deepStrictEqual(resolveFieldNames({ revision: false }), noRevision);
    assert.deepStrictEqual(resolveFieldNames({ field: 'v', revisionField: 'r' }), {
      field: 'v',
      revisionField: 'r',
    });
    assert.throws(() => resolveFieldNames({ field: 'a.b' }), ConfigInvalidError);
    assert.throws(() => resolveFieldNames({ field: 'x', revisionField: 'x' }), /must differ/);
  });

  it('should match version 0 as missing, null or 0', () => {
    assert.deepStrictEqual(versionFilter(names, 0), { __v: { $in: [null, 0] } });
    assert.deepStrictEqual(versionFilter(names, 2), { __v: 2 });
    assert.deepStrictEqual(revisionFilter(names, 0), { __rev: { $in: [null, 0] } });
    assert.deepStrictEqual(revisionFilter(names, 7), { __rev: 7 });
    assert.deepStrictEqual(belowVersionFilter(names, 2), { __v: { $not: { $gte: 2 } } });
    assert.strictEqual(belowVersionFilter(names, 0), null);
    assert.deepStrictEqual(versionIndexKey({ field: 'v' }), { v: 1, _id: 1 });
    assert.throws(() => versionFilter(names, -1), ConfigInvalidError);
    assert.throws(() => revisionFilter(names, 1.5), ConfigInvalidError);
  });

  it('should build the optimistic-concurrency filter from what was read', () => {
    const id = new ObjectId();
    assert.deepStrictEqual(occFilter({ _id: id, __v: 1, __rev: 4 }, names), {
      _id: id,
      __v: 1,
      __rev: 4,
    });
    assert.deepStrictEqual(occFilter({ _id: id }, names, { from: 0 }), {
      _id: id,
      __v: { $in: [null, 0] },
      __rev: { $in: [null, 0] },
    });
    assert.deepStrictEqual(occFilter({ _id: id, __v: 1 }, noRevision), { _id: id, __v: 1 });
    // A field that is not a count is matched exactly as it was read — as a
    // value, never as an operator, even when it looks like one.
    assert.deepStrictEqual(occFilter({ _id: id, __v: 'x', __rev: 'y' }, names), {
      _id: id,
      __v: { $eq: 'x' },
      __rev: { $eq: 'y' },
    });
    assert.deepStrictEqual(occFilter({ _id: id, __v: { $ne: null } }, noRevision), {
      _id: id,
      __v: { $eq: { $ne: null } },
    });
  });

  it('should stamp only what a document does not carry yet', () => {
    assert.deepStrictEqual(stampDocument({ a: 1 }, names, 2), { a: 1, __v: 2, __rev: 0 });
    assert.deepStrictEqual(stampDocument({ a: 1, __v: 1, __rev: 3 }, names, 2), {
      a: 1,
      __v: 1,
      __rev: 3,
    });
    assert.deepStrictEqual(stampDocument({ a: 1 }, noRevision, 2), { a: 1, __v: 2 });
    const doc = { a: 1 };
    stampDocument(doc, names, 1);
    assert.deepStrictEqual(doc, { a: 1 }, 'the input is not mutated');
    assert.throws(() => stampDocument([], names, 1), ConfigInvalidError);
  });
});

describe('stampedDiff', () => {
  const id = new ObjectId();

  it('should leave unchanged fields out of $set, so their BSON types survive', () => {
    const at = new Date(1000);
    const prev = {
      _id: id,
      ref: new ObjectId(id.toHexString()),
      at,
      amount: Decimal128.fromString('9.99'),
      big: Long.fromString('9007199254740993'),
      nested: { a: [1, 2], b: { c: 'x' } },
      ratio: 1,
      address: 'Main St',
      __v: 1,
      __rev: 2,
    };
    const next = cloneDocument(prev);
    next.shipping = { address: next.address };
    delete next.address;
    assert.deepStrictEqual(stampedDiff(prev, next, names, { to: 2 }), {
      $set: { shipping: { address: 'Main St' }, __v: 2 },
      $unset: { address: '' },
      $inc: { __rev: 1 },
    });
  });

  it('should rewrite a whole top-level subdocument when something inside it changed', () => {
    const prev = { _id: id, nested: { a: 1, b: 2 }, __v: 1 };
    const next = { _id: id, nested: { a: 1, b: 3 } };
    assert.deepStrictEqual(stampedDiff(prev, next, names, { to: 2 }).$set, {
      nested: { a: 1, b: 3 },
      __v: 2,
    });
  });

  it('should unset a field set to undefined, and the version for to: 0', () => {
    const prev = { _id: id, a: 1, b: 2, __v: 1, __rev: 1 };
    assert.deepStrictEqual(
      stampedDiff(prev, { ...prev, a: undefined, c: undefined }, names, { to: 0 }),
      {
        $unset: { a: '', __v: '' },
        $inc: { __rev: 1 },
      },
    );
    assert.deepStrictEqual(stampedDiff({ _id: id }, { _id: id }, noRevision, { to: 1 }), {
      $set: { __v: 1 },
    });
  });

  it('should ignore the system fields a transformation returns', () => {
    const prev = { _id: id, a: 1, __v: 1, __rev: 5 };
    assert.deepStrictEqual(stampedDiff(prev, { a: 1, __v: 9, __rev: 0 }, names, { to: 2 }), {
      $set: { __v: 2 },
      $inc: { __rev: 1 },
    });
  });

  it('should refuse a different _id, operator keys and non-documents', () => {
    const prev = { _id: id, __v: 1 };
    const refuse = (next) =>
      assert.throws(
        () => stampedDiff(prev, next, names, { to: 2 }),
        (error) => error instanceof ShapeVersionError && error.context.reason === 'invalid',
      );
    refuse({ _id: new ObjectId() });
    refuse({ _id: id, $set: 1 });
    refuse({ _id: id, 'a.b': 1 });
    refuse({ _id: id, '': 1 });
    refuse({ _id: id, 'a\0': 1 });
    refuse(null);
    refuse([]);
    assert.throws(() => stampedDiff(prev, { _id: id }, names, { to: -1 }), ConfigInvalidError);
  });
});

describe('stampedUpdate', () => {
  it('should merge the stamp into an operator update', () => {
    assert.deepStrictEqual(
      stampedUpdate(names, { to: 2, update: { $set: { a: 1 }, $inc: { n: 1 } } }),
      { $set: { a: 1, __v: 2 }, $inc: { n: 1, __rev: 1 } },
    );
    assert.deepStrictEqual(stampedUpdate(names, { update: { $set: { a: 1 } } }), {
      $set: { a: 1 },
      $inc: { __rev: 1 },
    });
    assert.deepStrictEqual(stampedUpdate(names, { to: 0, update: { $unset: { a: '' } } }), {
      $unset: { a: '', __v: '' },
      $inc: { __rev: 1 },
    });
    assert.deepStrictEqual(stampedUpdate(noRevision, { to: 3, update: {} }), { $set: { __v: 3 } });
  });

  it('should append one stage to a pipeline', () => {
    assert.deepStrictEqual(stampedUpdate(names, { to: 2, update: [{ $set: { a: 1 } }] }), [
      { $set: { a: 1 } },
      { $set: { __v: { $literal: 2 }, __rev: { $add: [{ $ifNull: ['$__rev', 0] }, 1] } } },
    ]);
    assert.deepStrictEqual(stampedUpdate(noRevision, { to: 0, update: [] }), [{ $unset: '__v' }]);
    assert.deepStrictEqual(stampedUpdate(noRevision, { update: [] }), []);
  });

  it('should refuse replacements and updates that write a system field', () => {
    assert.throws(() => stampedUpdate(names, { update: { a: 1 } }), /replaceWithRevision/);
    assert.throws(
      () => stampedUpdate(names, { update: [{ $replaceWith: '$x' }] }),
      /cannot keep its revision/,
    );
    assert.throws(() => stampedUpdate(names, { update: { $inc: { __rev: 1 } } }), /revision field/);
    assert.throws(
      () => stampedUpdate(names, { to: 2, update: { $set: { __v: 1 } } }),
      /version field/,
    );
    assert.doesNotThrow(() => stampedUpdate(names, { update: { $set: { __v: 1 } } }));
    assert.throws(() => stampedUpdate(names, { update: 'x' }), ConfigInvalidError);
    assert.throws(() => stampedUpdate(names, { to: 1.5, update: {} }), ConfigInvalidError);
  });
});

describe('versioning — __proto__ and plain documents', () => {
  it('should keep a stored __proto__ field as data, in a copy and in a diff', () => {
    const stored = JSON.parse('{ "_id": 1, "__v": 1, "__proto__": { "role": "admin" } }');
    const copy = cloneDocument(stored);
    assert.ok(Object.hasOwn(copy, '__proto__'));
    assert.strictEqual(Object.getPrototypeOf(copy), Object.prototype);
    assert.strictEqual(copy.role, undefined, 'no field inherited from stored data');
    const next = cloneDocument(stored);
    Object.defineProperty(next, '__proto__', {
      value: { role: 'user' },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const update = stampedDiff(stored, next, names, { to: 2 });
    assert.ok(Object.hasOwn(update.$set, '__proto__'), 'the change is written, not lost');
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(update.$set, '__proto__').value, {
      role: 'user',
    });
    assert.match(fieldNameIssue('__proto__'), /__proto__/);
  });

  it('should refuse a document that is not a plain object, instead of a silent false', () => {
    class Hydrated {
      __v = 2;
    }
    assert.strictEqual(isVersion({ __v: 2 }, 2), true);
    assert.strictEqual(isVersion(null, 0), false);
    assert.throws(
      () => isVersion(new Hydrated(), 2),
      (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.match(error.message, /lean/);
        return true;
      },
    );
  });
});
