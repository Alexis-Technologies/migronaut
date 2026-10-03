const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Int32 } = require('mongodb');
const {
  compareIndex,
  defaultIndexName,
  indexIssues,
  keyEntries,
  normalizeDeclaredIndex,
  normalizeLiveIndex,
  restoreSpec,
  sameDeclaredSignature,
  sameSignature,
} = require('../../src/core/index-spec.js');

// What MongoDB 7.0 returns from listIndexes for these declarations — taken
// from a real server, so a rule that disagrees with it fails here.
const FR_COLLATION = {
  locale: 'fr',
  caseLevel: false,
  caseFirst: 'off',
  strength: 3,
  numericOrdering: false,
  alternate: 'non-ignorable',
  maxVariable: 'punct',
  normalization: false,
  backwards: false,
  version: '57.1',
};
const EN2_COLLATION = { ...FR_COLLATION, locale: 'en', strength: 2 };

const live = (raw) => normalizeLiveIndex({ v: 2, ...raw });
const declared = (index) => normalizeDeclaredIndex(index);
const compare = (index, raw, defaultCollation) =>
  compareIndex(declared(index), live(raw), defaultCollation);

describe('defaultIndexName', () => {
  it("should follow the driver's naming rule", () => {
    const cases = [
      [{ email: 1 }, 'email_1'],
      [{ 'a.b': 1, c: -1 }, 'a.b_1_c_-1'],
      [{ title: 'text', body: 'text' }, 'title_text_body_text'],
      [{ _id: 'hashed' }, '_id_hashed'],
      [{ loc: '2dsphere' }, 'loc_2dsphere'],
      [{ '$**': 1 }, '$**_1'],
      [{ 'meta.$**': 1 }, 'meta.$**_1'],
    ];
    for (const [key, name] of cases) {
      assert.strictEqual(defaultIndexName(keyEntries(key)), name);
    }
  });

  it('should keep the order of a Map key', () => {
    assert.strictEqual(
      defaultIndexName(
        keyEntries(
          new Map([
            ['2', 1],
            ['a', -1],
          ]),
        ),
      ),
      '2_1_a_-1',
    );
  });
});

describe('indexIssues', () => {
  const issues = (index) => indexIssues(index, 'idx');
  const paths = (index) => issues(index).map((issue) => issue.path);

  it('should accept every supported shape', () => {
    for (const index of [
      { key: { a: 1 } },
      { key: new Map([['a', 1]]), name: 'n', unique: true, sparse: false, hidden: true },
      { key: { t: 1 }, expireAfterSeconds: 0 },
      { key: { p: 1 }, partialFilterExpression: { p: { $exists: true } } },
      { key: { n: 1 }, collation: { locale: 'en', strength: 2 } },
      { key: { a: 'text' }, weights: { a: 2 }, default_language: 'none', textIndexVersion: 3 },
      { key: { language_override: 'text' }, language_override: 'lang' },
      { key: { 'a.$**': 1 } },
      { key: { '$**': 1 }, wildcardProjection: { secret: 0 } },
      {
        key: new Map([
          ['$**', 1],
          ['b', 1],
        ]),
        wildcardProjection: { b: 0 },
      },
      { key: { loc: '2d' }, bits: 26, min: -180, max: 180 },
      { key: { loc: '2dsphere' }, '2dsphereIndexVersion': 3 },
      { key: { a: 1 }, storageEngine: {}, background: true },
    ]) {
      assert.deepStrictEqual(issues(index), [], JSON.stringify([...keyEntries(index.key)]));
    }
  });

  it('should refuse a non-object declaration', () => {
    assert.deepStrictEqual(paths(null), ['idx']);
    assert.deepStrictEqual(paths([]), ['idx']);
  });

  it('should refuse an unknown option instead of letting the driver drop it', () => {
    assert.deepStrictEqual(paths({ key: { a: 1 }, uniqe: true }), ['idx.uniqe']);
    assert.deepStrictEqual(paths({ key: { a: 1 }, v: 2 }), ['idx.v']);
  });

  it('should refuse malformed keys', () => {
    assert.deepStrictEqual(paths({}), ['idx.key']);
    assert.deepStrictEqual(paths({ key: [] }), ['idx.key']);
    assert.deepStrictEqual(paths({ key: {} }), ['idx.key']);
    assert.deepStrictEqual(paths({ key: { a: 'asc' } }), ['idx.key']);
    assert.deepStrictEqual(paths({ key: { a: 2 } }), ['idx.key']);
    assert.deepStrictEqual(paths({ key: new Map([['', 1]]) }), ['idx.key']);
    assert.deepStrictEqual(paths({ key: new Map([[1, 1]]) }), ['idx.key']);
  });

  it('should refuse integer-like field names in a multi-field plain object', () => {
    const [issue] = issues({ key: { b: 1, 2: 1 } });
    assert.strictEqual(issue.path, 'idx.key');
    assert.match(issue.message, /Map/);
    // One field has no order to lose.
    assert.deepStrictEqual(issues({ key: { 2: 1 } }), []);
  });

  it('should accept a Map key only in the order the driver reads it back', () => {
    // listIndexes comes back as a plain object, where integer-like fields
    // move to the front — any other order would rebuild on every run.
    assert.deepStrictEqual(
      issues({
        key: new Map([
          ['2', 1],
          ['b', 1],
        ]),
      }),
      [],
    );
    const [issue] = issues({
      key: new Map([
        ['b', 1],
        ['2', 1],
      ]),
    });
    assert.strictEqual(issue.path, 'idx.key');
    assert.match(issue.message, /migration/);
  });

  it('should refuse the _id index itself', () => {
    assert.deepStrictEqual(paths({ key: { _id: 1 } }), ['idx.key']);
    assert.deepStrictEqual(issues({ key: { _id: 'hashed' } }), []);
    assert.deepStrictEqual(paths({ key: { a: 1 }, name: '_id_' }), ['idx.name']);
  });

  it('should check every option type', () => {
    assert.deepStrictEqual(
      paths({
        key: { a: 'text', '$**': 1 },
        name: '',
        unique: 'yes',
        partialFilterExpression: 'x',
        expireAfterSeconds: -1,
        collation: { strength: 2 },
        default_language: '',
        textIndexVersion: 0,
        min: Number.NaN,
      }),
      [
        'idx.name',
        'idx.unique',
        'idx.partialFilterExpression',
        'idx.expireAfterSeconds',
        'idx.collation',
        'idx.default_language',
        'idx.textIndexVersion',
        'idx.min',
      ],
    );
    assert.deepStrictEqual(paths({ key: { a: 1 }, expireAfterSeconds: 1.5 }), [
      'idx.expireAfterSeconds',
    ]);
  });

  it('should refuse options that do not apply to the index type', () => {
    assert.deepStrictEqual(paths({ key: { a: 1 }, weights: { a: 1 } }), ['idx.weights']);
    assert.deepStrictEqual(paths({ key: { a: 1 }, wildcardProjection: { a: 0 } }), [
      'idx.wildcardProjection',
    ]);
    // The server takes a projection only on an all-fields wildcard.
    assert.deepStrictEqual(paths({ key: { 'a.$**': 1 }, wildcardProjection: { b: 0 } }), [
      'idx.wildcardProjection',
    ]);
  });
});

describe('normalizeDeclaredIndex', () => {
  it('should derive the name and keep the declared key order as a Map', () => {
    const index = declared({ key: { b: 1, a: -1 }, unique: true });
    assert.strictEqual(index.name, 'b_1_a_-1');
    assert.deepStrictEqual(
      [...index.spec.key],
      [
        ['b', 1],
        ['a', -1],
      ],
    );
    assert.deepStrictEqual(index.spec, { key: index.spec.key, name: 'b_1_a_-1', unique: true });
  });

  it('should drop false booleans and the ignored background option from the spec', () => {
    const index = declared({ key: { a: 1 }, unique: false, sparse: false, background: true });
    assert.deepStrictEqual(Object.keys(index.spec), ['key', 'name']);
  });

  it('should fold text fields into the server form', () => {
    const index = declared({ key: { tag: 1, title: 'text', body: 'text', suffix: 1 } });
    assert.ok(index.isText);
    assert.deepStrictEqual(index.serverKey, [
      ['tag', 1],
      ['_fts', 'text'],
      ['_ftsx', 1],
      ['suffix', 1],
    ]);
  });
});

describe('compareIndex — what MongoDB returns compares as unchanged', () => {
  const roundTrips = [
    [
      { key: { email: 1 }, unique: true },
      { key: { email: 1 }, name: 'email_1', unique: true },
    ],
    [
      { key: { a: 1 }, sparse: false },
      { key: { a: 1 }, name: 'a_1', sparse: false },
    ],
    [
      { key: { createdAt: 1 }, name: 'ttl', expireAfterSeconds: 3600 },
      { key: { createdAt: 1 }, name: 'ttl', expireAfterSeconds: 3600 },
    ],
    [
      { key: { s: 1 }, sparse: true, hidden: true },
      { key: { s: 1 }, name: 's_1', hidden: true, sparse: true },
    ],
    [
      { key: { p: 1 }, partialFilterExpression: { p: { $exists: true } } },
      { key: { p: 1 }, name: 'p_1', partialFilterExpression: { p: { $exists: true } } },
    ],
    [
      { key: { n: 1 }, collation: { locale: 'en', strength: 2 } },
      { key: { n: 1 }, name: 'n_1', collation: EN2_COLLATION },
    ],
    [
      { key: { title: 'text', body: 'text' }, weights: { title: 5 } },
      {
        key: { _fts: 'text', _ftsx: 1 },
        name: 'title_text_body_text',
        weights: { body: 1, title: 5 },
        default_language: 'english',
        language_override: 'language',
        textIndexVersion: 3,
      },
    ],
    [
      { key: { tag: 1, title: 'text', suffix: 1 } },
      {
        key: { tag: 1, _fts: 'text', _ftsx: 1, suffix: 1 },
        name: 'tag_1_title_text_suffix_1',
        weights: { title: 1 },
        default_language: 'english',
        language_override: 'language',
        textIndexVersion: 3,
      },
    ],
    [{ key: { h: 'hashed' } }, { key: { h: 'hashed' }, name: 'h_hashed' }],
    [
      { key: { loc: '2dsphere' } },
      { key: { loc: '2dsphere' }, name: 'loc_2dsphere', '2dsphereIndexVersion': 3 },
    ],
    [
      { key: { '$**': 1 }, wildcardProjection: { secret: 0 } },
      { key: { '$**': 1 }, name: '$**_1', wildcardProjection: { secret: 0 } },
    ],
  ];

  for (const [index, raw] of roundTrips) {
    it(`should see no difference for ${raw.name}`, () => {
      assert.deepStrictEqual(compare(index, raw).diffs, []);
    });
  }

  it('should compare number directions by sign, Int32 wrappers included', () => {
    assert.deepStrictEqual(compare({ key: { a: 1 } }, { key: { a: 1.0 }, name: 'a_1' }).diffs, []);
    assert.deepStrictEqual(
      compare({ key: { a: -1 } }, { key: { a: new Int32(-1) }, name: 'a_-1' }).diffs,
      [],
    );
  });
});

describe('compareIndex — differences', () => {
  it('should rebuild for a changed key or uniqueness', () => {
    const result = compare({ key: { a: 1 }, unique: true }, { key: { a: -1 }, name: 'a_1' });
    assert.deepStrictEqual(result.diffs, ['key', 'unique']);
    assert.strictEqual(result.rebuild, true);
    assert.deepStrictEqual(result.inPlace, {});
  });

  it('should change a TTL in place when both sides have one', () => {
    const result = compare(
      { key: { t: 1 }, expireAfterSeconds: 60 },
      { key: { t: 1 }, name: 't_1', expireAfterSeconds: 3600 },
    );
    assert.deepStrictEqual(result, {
      diffs: ['expireAfterSeconds'],
      inPlace: { expireAfterSeconds: 60 },
      rebuild: false,
    });
  });

  it('should rebuild to add or remove a TTL', () => {
    assert.strictEqual(
      compare({ key: { t: 1 }, expireAfterSeconds: 60 }, { key: { t: 1 }, name: 't_1' }).rebuild,
      true,
    );
    assert.strictEqual(
      compare({ key: { t: 1 } }, { key: { t: 1 }, name: 't_1', expireAfterSeconds: 0 }).rebuild,
      true,
    );
  });

  it('should toggle hidden in place, together with a TTL', () => {
    const result = compare(
      { key: { t: 1 }, expireAfterSeconds: 60, hidden: true },
      { key: { t: 1 }, name: 't_1', expireAfterSeconds: 30 },
    );
    assert.deepStrictEqual(result.inPlace, { hidden: true, expireAfterSeconds: 60 });
    assert.strictEqual(result.rebuild, false);
  });

  it('should drop the in-place changes when a rebuild is needed anyway', () => {
    const result = compare(
      { key: { t: 1 }, hidden: true, unique: true },
      { key: { t: 1 }, name: 't_1' },
    );
    assert.deepStrictEqual(result.inPlace, {});
    assert.deepStrictEqual(result.diffs, ['unique', 'hidden']);
  });

  it('should see partial filter, wildcard projection and text option changes', () => {
    assert.deepStrictEqual(
      compare(
        { key: { p: 1 }, partialFilterExpression: { p: { $gt: 1 } } },
        { key: { p: 1 }, name: 'p_1', partialFilterExpression: { p: { $gt: 2 } } },
      ).diffs,
      ['partialFilterExpression'],
    );
    assert.deepStrictEqual(
      compare(
        { key: { '$**': 1 }, wildcardProjection: { a: 0 } },
        { key: { '$**': 1 }, name: '$**_1' },
      ).diffs,
      ['wildcardProjection'],
    );
    const text = {
      key: { _fts: 'text', _ftsx: 1 },
      name: 'a_text',
      weights: { a: 1 },
      default_language: 'english',
      language_override: 'language',
    };
    assert.deepStrictEqual(
      compare({ key: { a: 'text' }, weights: { a: 3 }, default_language: 'french' }, text).diffs,
      ['weights', 'default_language'],
    );
  });

  it('should compare declared-only options only when declared', () => {
    const raw = { key: { loc: '2dsphere' }, name: 'loc_2dsphere', '2dsphereIndexVersion': 3 };
    assert.deepStrictEqual(compare({ key: { loc: '2dsphere' } }, raw).diffs, []);
    assert.deepStrictEqual(
      compare({ key: { loc: '2dsphere' }, '2dsphereIndexVersion': 2 }, raw).diffs,
      ['2dsphereIndexVersion'],
    );
  });
});

describe('compareIndex — collation', () => {
  it('should match a declared collation as a subset of the expanded one', () => {
    const raw = { key: { n: 1 }, name: 'n_1', collation: EN2_COLLATION };
    assert.deepStrictEqual(
      compare({ key: { n: 1 }, collation: { locale: 'en', strength: 2 } }, raw).diffs,
      [],
    );
    assert.deepStrictEqual(
      compare({ key: { n: 1 }, collation: { locale: 'en', strength: 3 } }, raw).diffs,
      ['collation'],
    );
  });

  it('should read an omitted strength, caseLevel or numericOrdering as its default', () => {
    // Every locale defaults these alike, so leaving one out asks for the
    // default — a live strength-2 index is not what { locale: 'en' } means.
    const en2 = { key: { n: 1 }, name: 'n_1', collation: EN2_COLLATION };
    assert.deepStrictEqual(compare({ key: { n: 1 }, collation: { locale: 'en' } }, en2).diffs, [
      'collation',
    ]);
    const fr = { key: { n: 1 }, name: 'n_1', collation: FR_COLLATION };
    assert.deepStrictEqual(compare({ key: { n: 1 }, collation: { locale: 'fr' } }, fr).diffs, []);
    const numeric = { ...fr, collation: { ...FR_COLLATION, numericOrdering: true } };
    assert.deepStrictEqual(compare({ key: { n: 1 }, collation: { locale: 'fr' } }, numeric).diffs, [
      'collation',
    ]);
    // A server that leaves a universal field out reports its default.
    const { caseLevel, ...withoutCaseLevel } = FR_COLLATION;
    assert.strictEqual(caseLevel, false);
    assert.deepStrictEqual(
      compare(
        { key: { n: 1 }, collation: { locale: 'fr' } },
        { ...fr, collation: withoutCaseLevel },
      ).diffs,
      [],
    );
  });

  it("should accept an undeclared collation that is the collection's default", () => {
    const raw = { key: { z: 1 }, name: 'z_1', collation: FR_COLLATION };
    assert.deepStrictEqual(compare({ key: { z: 1 } }, raw, FR_COLLATION).diffs, []);
    // Without a collection default, a collation on the index is a difference.
    assert.deepStrictEqual(compare({ key: { z: 1 } }, raw).diffs, ['collation']);
    // An index with no collation on a collection that has one was made 'simple'.
    assert.deepStrictEqual(
      compare({ key: { z: 1 } }, { key: { z: 1 }, name: 'z_1' }, FR_COLLATION).diffs,
      ['collation'],
    );
  });

  it("should read { locale: 'simple' } as no collation", () => {
    const raw = { key: { y: 1 }, name: 'y_1' };
    assert.deepStrictEqual(
      compare({ key: { y: 1 }, collation: { locale: 'simple' } }, raw, FR_COLLATION).diffs,
      [],
    );
    assert.deepStrictEqual(
      compare(
        { key: { y: 1 }, collation: { locale: 'simple' } },
        { ...raw, collation: FR_COLLATION },
      ).diffs,
      ['collation'],
    );
    assert.deepStrictEqual(compare({ key: { y: 1 }, collation: { locale: 'fr' } }, raw).diffs, [
      'collation',
    ]);
  });
});

describe('sameSignature', () => {
  it('should match same key, filter and collation regardless of name and other options', () => {
    const index = declared({ key: { a: 1 }, name: 'declared', unique: true });
    assert.ok(sameSignature(index, live({ key: { a: 1 }, name: 'other' })));
    assert.ok(!sameSignature(index, live({ key: { a: -1 }, name: 'other' })));
    assert.ok(
      !sameSignature(
        index,
        live({ key: { a: 1 }, name: 'other', partialFilterExpression: { a: 1 } }),
      ),
    );
    assert.ok(
      !sameSignature(index, live({ key: { a: 1 }, name: 'other', collation: FR_COLLATION })),
    );
    assert.ok(
      sameSignature(
        index,
        live({ key: { a: 1 }, name: 'other', collation: FR_COLLATION }),
        FR_COLLATION,
      ),
    );
  });
});

describe('sameDeclaredSignature', () => {
  it('should treat two declarations of one server index as the same', () => {
    const a = declared({ key: { a: 1 }, name: 'one' });
    assert.ok(sameDeclaredSignature(a, declared({ key: { a: 1 }, name: 'two', unique: true })));
    assert.ok(!sameDeclaredSignature(a, declared({ key: { a: -1 } })));
    const en = declared({ key: { a: 1 }, collation: { locale: 'en' } });
    assert.ok(
      sameDeclaredSignature(
        en,
        declared({ key: { a: 1 }, collation: { locale: 'en', strength: 3 } }),
      ),
    );
    assert.ok(
      !sameDeclaredSignature(
        en,
        declared({ key: { a: 1 }, collation: { locale: 'en', strength: 2 } }),
      ),
    );
    // Apart on a collection with a default collation — a definition cannot know.
    assert.ok(
      !sameDeclaredSignature(a, declared({ key: { a: 1 }, collation: { locale: 'simple' } })),
    );
  });
});

describe('normalizeLiveIndex / restoreSpec', () => {
  it('should mark text indexes and drop false booleans', () => {
    const index = live({ key: { _fts: 'text', _ftsx: 1 }, name: 't', sparse: false });
    assert.ok(index.isText);
    assert.deepStrictEqual(index.options, {});
  });

  it('should read a flag stored as 1 as true', () => {
    assert.deepStrictEqual(live({ key: { a: 1 }, name: 'a_1', unique: 1 }).options, {
      unique: true,
    });
    assert.deepStrictEqual(
      compare({ key: { a: 1 }, unique: true }, { key: { a: 1 }, name: 'a_1', unique: 1 }).diffs,
      [],
    );
  });

  it('should strip the server-managed fields for a restore', () => {
    assert.deepStrictEqual(
      restoreSpec({ v: 2, key: { a: 1 }, name: 'a_1', ns: 'db.c', background: true, unique: true }),
      { key: { a: 1 }, name: 'a_1', unique: true },
    );
  });
});
