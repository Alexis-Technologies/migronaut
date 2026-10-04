const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { Int32 } = require('mongodb');
const {
  MAX_BUILD_MESSAGE_LENGTH,
  SEARCH_INDEX_KEYS,
  compareSearchIndex,
  effectiveDefinition,
  inferSearchIndexType,
  isBeingRemoved,
  isSearchIndexReady,
  normalizeDeclaredSearchIndex,
  normalizeLiveSearchIndex,
  searchBuild,
  searchBuildState,
  searchIndexIssues,
  searchIndexSpec,
  searchIndexValue,
} = require('../../src/core/search-index-spec.js');

const issuesOf = (index) => searchIndexIssues(index, 'searchIndexes[0]');
const pathsOf = (index) => issuesOf(index).map((issue) => issue.path);

const VECTOR = {
  fields: [
    { type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' },
    { type: 'filter', path: 'year' },
  ],
};
const AUTO = {
  fields: [
    { type: 'autoEmbed', modality: 'text', path: 'plot', model: 'voyage-4' },
    { type: 'filter', path: 'year' },
  ],
};

/** A `$listSearchIndexes` document as Atlas reports it */
const listed = (fields = {}) => ({
  id: '6524096020da840844a4c4a7',
  name: 'default',
  type: 'search',
  status: 'READY',
  queryable: true,
  latestDefinitionVersion: { version: 0, createdAt: new Date(0) },
  latestDefinition: { mappings: { dynamic: true } },
  ...fields,
});

const declared = (index) => normalizeDeclaredSearchIndex(index);
const live = (fields) => normalizeLiveSearchIndex(listed(fields));

describe('searchIndexIssues', () => {
  it('should accept a search and a vector search declaration', () => {
    assert.deepStrictEqual(issuesOf({ definition: { mappings: { dynamic: true } } }), []);
    assert.deepStrictEqual(issuesOf({ name: 'v', type: 'vectorSearch', definition: VECTOR }), []);
    assert.deepStrictEqual(issuesOf({ name: 'a', type: 'vectorSearch', definition: AUTO }), []);
  });

  it('should refuse anything but an object', () => {
    assert.deepStrictEqual(pathsOf('default'), ['searchIndexes[0]']);
    assert.deepStrictEqual(pathsOf(null), ['searchIndexes[0]']);
  });

  it('should refuse unknown keys — a typo must not be dropped silently', () => {
    const [issue] = issuesOf({ definition: { mappings: {} }, analyser: 'lucene.english' });
    assert.strictEqual(issue.path, 'searchIndexes[0].analyser');
    assert.match(issue.message, /expected one of: name, type, definition/);
  });

  for (const [label, index, paths] of [
    ['an empty name', { name: '', definition: { mappings: {} } }, ['searchIndexes[0].name']],
    ['a non-string name', { name: 3, definition: { mappings: {} } }, ['searchIndexes[0].name']],
    ['an unknown type', { type: 'text', definition: { mappings: {} } }, ['searchIndexes[0].type']],
    ['no definition', { name: 'x' }, ['searchIndexes[0].definition']],
    ['a definition that is not an object', { definition: [] }, ['searchIndexes[0].definition']],
    [
      'a definition with a function',
      { definition: { mappings: {}, x: () => 1 } },
      ['searchIndexes[0].definition'],
    ],
    [
      'a search definition without mappings',
      { definition: { analyzer: 'lucene.standard' } },
      ['searchIndexes[0].definition.mappings'],
    ],
    [
      'a search definition whose mappings is not an object',
      { definition: { mappings: true } },
      ['searchIndexes[0].definition.mappings'],
    ],
    [
      'a vector definition without fields',
      { type: 'vectorSearch', definition: { fields: [] } },
      ['searchIndexes[0].definition.fields'],
    ],
    [
      'a vector field without a path',
      { type: 'vectorSearch', definition: { fields: [{ type: 'vector' }] } },
      ['searchIndexes[0].definition.fields[0]'],
    ],
    [
      'a vector field that is not an object',
      { type: 'vectorSearch', definition: { fields: ['embedding'] } },
      ['searchIndexes[0].definition.fields[0]'],
    ],
  ]) {
    it(`should refuse ${label}`, () => {
      assert.deepStrictEqual(pathsOf(index), paths);
    });
  }

  it('should tell a vector definition declared as a search index — and the other way round', () => {
    const [vector] = issuesOf({ definition: VECTOR });
    assert.strictEqual(vector.path, 'searchIndexes[0].definition');
    assert.match(vector.message, /set type: 'vectorSearch'/);
    const [search] = issuesOf({ type: 'vectorSearch', definition: { mappings: {} } });
    assert.strictEqual(search.path, 'searchIndexes[0].definition');
    assert.match(search.message, /search definition/);
  });

  it('should refuse a repeated field and vector fields mixed with autoEmbed ones', () => {
    const repeated = issuesOf({
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'filter', path: 'year' },
          { type: 'filter', path: 'year' },
        ],
      },
    });
    assert.deepStrictEqual(
      repeated.map((issue) => issue.path),
      ['searchIndexes[0].definition.fields[1]'],
    );
    assert.match(repeated[0].message, /fields\[0\]/);
    const [mixed] = issuesOf({
      type: 'vectorSearch',
      definition: { fields: [...VECTOR.fields, AUTO.fields[0]] },
    });
    assert.strictEqual(mixed.path, 'searchIndexes[0].definition.fields');
    assert.match(mixed.message, /mixes vector and autoEmbed/);
  });

  it('should stop at an unknown type rather than guess which definition rules apply', () => {
    assert.deepStrictEqual(pathsOf({ type: 'atlas', definition: { fields: [] } }), [
      'searchIndexes[0].type',
    ]);
  });

  it('should list exactly the keys it accepts', () => {
    assert.deepStrictEqual(SEARCH_INDEX_KEYS, ['name', 'type', 'definition']);
  });
});

describe('normalizing search indexes', () => {
  it('should keep a long build message short', () => {
    const message = 'x'.repeat(5000);
    const kept = live({ status: 'FAILED', message }).message;
    assert.strictEqual(kept.length, MAX_BUILD_MESSAGE_LENGTH);
    assert.ok(kept.endsWith('…'));
    assert.strictEqual(live({ status: 'FAILED', message: 'short' }).message, 'short');
  });

  it("should give a declaration the server's default name and type", () => {
    assert.deepStrictEqual(declared({ definition: { mappings: { dynamic: true } } }), {
      name: 'default',
      type: 'search',
      definition: { mappings: { dynamic: true } },
    });
  });

  it('should clean a declaration for the wire', () => {
    assert.deepStrictEqual(
      declared({ definition: { mappings: { dynamic: true }, analyzer: undefined } }).definition,
      { mappings: { dynamic: true } },
    );
  });

  it('should infer the type of a server that does not report it', () => {
    assert.strictEqual(inferSearchIndexType(VECTOR), 'vectorSearch');
    assert.strictEqual(inferSearchIndexType({ mappings: { dynamic: true } }), 'search');
    assert.strictEqual(inferSearchIndexType(undefined), 'search');
    const vector = live({ type: undefined, latestDefinition: VECTOR });
    assert.strictEqual(vector.type, 'vectorSearch');
  });

  it('should read the build state of a live index', () => {
    const index = live({
      status: 'FAILED',
      queryable: false,
      message: 'too many fields',
      latestDefinitionVersion: { version: 4 },
    });
    assert.strictEqual(index.status, 'FAILED');
    assert.strictEqual(index.queryable, false);
    assert.strictEqual(index.message, 'too many fields');
    assert.strictEqual(index.version, 4);
    assert.strictEqual(index.updating, false);
    assert.deepStrictEqual(searchBuild(index), {
      status: 'FAILED',
      queryable: false,
      message: 'too many fields',
    });
    assert.deepStrictEqual(searchBuild(live({ status: undefined, queryable: undefined })), {
      status: 'UNKNOWN',
      queryable: false,
    });
  });

  it('should read the version a self-managed mongot reports as latestVersion', () => {
    const index = normalizeLiveSearchIndex({
      name: 'default',
      status: 'READY',
      queryable: true,
      latestVersion: 3,
      latestDefinition: { mappings: {} },
    });
    assert.strictEqual(index.version, 3);
  });

  it('should see a newer definition being built next to the one served', () => {
    const staged = live({
      statusDetail: [{ hostname: 'a', mainIndex: {}, stagedIndex: { status: 'BUILDING' } }],
    });
    assert.strictEqual(staged.updating, true);
    assert.deepStrictEqual(searchBuild(staged).updating, true);
    const behind = live({
      latestDefinitionVersion: { version: 2 },
      statusDetail: [{ hostname: 'a', mainIndex: { definitionVersion: { version: 1 } } }],
    });
    assert.strictEqual(behind.updating, true);
    const current = live({
      latestDefinitionVersion: { version: 2 },
      statusDetail: [null, { hostname: 'a', mainIndex: { definitionVersion: { version: 2 } } }],
    });
    assert.strictEqual(current.updating, false);
  });

  it('should tell an index the server is removing', () => {
    assert.strictEqual(isBeingRemoved(live({ status: 'DELETING' })), true);
    assert.strictEqual(isBeingRemoved(live({ status: 'DOES_NOT_EXIST' })), true);
    assert.strictEqual(isBeingRemoved(live({ status: 'FAILED' })), false);
  });

  it('should send the type only for a vector index', () => {
    assert.deepStrictEqual(searchIndexSpec(declared({ definition: { mappings: {} } })), {
      name: 'default',
      definition: { mappings: {} },
    });
    assert.deepStrictEqual(
      searchIndexSpec(declared({ name: 'v', type: 'vectorSearch', definition: VECTOR })),
      { name: 'v', type: 'vectorSearch', definition: VECTOR },
    );
  });

  it('should describe an index for a result row', () => {
    assert.deepStrictEqual(searchIndexValue(live({})), {
      name: 'default',
      type: 'search',
      definition: { mappings: { dynamic: true } },
    });
  });
});

describe('effectiveDefinition', () => {
  it('should fill the documented search defaults — searchAnalyzer follows analyzer', () => {
    assert.deepStrictEqual(effectiveDefinition('search', { mappings: { dynamic: true } }), {
      analyzer: 'lucene.standard',
      searchAnalyzer: 'lucene.standard',
      storedSource: false,
      numPartitions: 1,
      analyzers: [],
      synonyms: [],
      mappings: { dynamic: true, fields: {} },
    });
    assert.strictEqual(
      effectiveDefinition('search', { analyzer: 'lucene.english', mappings: {} }).searchAnalyzer,
      'lucene.english',
    );
  });

  it('should fill vector field defaults and merge partial hnswOptions', () => {
    const filled = effectiveDefinition('vectorSearch', {
      fields: [
        {
          type: 'vector',
          path: 'e',
          numDimensions: 3,
          similarity: 'cosine',
          hnswOptions: { maxEdges: 32 },
        },
        {
          type: 'vector',
          path: 'f',
          numDimensions: 3,
          similarity: 'cosine',
          indexingMethod: 'flat',
        },
      ],
    });
    assert.deepStrictEqual(filled.fields[0], {
      type: 'vector',
      path: 'e',
      numDimensions: 3,
      similarity: 'cosine',
      quantization: 'none',
      indexingMethod: 'hnsw',
      hnswOptions: { maxEdges: 32, numEdgeCandidates: 100 },
    });
    assert.ok(!('hnswOptions' in filled.fields[1]));
  });

  it('should fill the defaults mongot writes into field mappings, nested ones too', () => {
    const { mappings } = effectiveDefinition('search', {
      mappings: {
        fields: {
          title: {
            type: 'string',
            multi: { english: { type: 'string', analyzer: 'lucene.english' } },
          },
          year: { type: 'number', indexIntegers: false },
          name: { type: 'autocomplete' },
          tag: { type: 'token' },
          meta: { type: 'document', fields: { note: { type: 'string' } } },
          when: { type: 'date' },
        },
      },
    });
    const STRING = { indexOptions: 'offsets', store: true, norms: 'include' };
    assert.deepStrictEqual(mappings.fields.title, {
      type: 'string',
      ...STRING,
      multi: { english: { type: 'string', analyzer: 'lucene.english', ...STRING } },
    });
    assert.deepStrictEqual(mappings.fields.year, {
      type: 'number',
      representation: 'double',
      indexIntegers: false,
      indexDoubles: true,
    });
    assert.deepStrictEqual(mappings.fields.name, {
      type: 'autocomplete',
      minGrams: 2,
      maxGrams: 15,
      foldDiacritics: true,
      tokenization: 'edgeGram',
    });
    assert.deepStrictEqual(mappings.fields.tag, { type: 'token', normalization: 'none' });
    assert.deepStrictEqual(mappings.fields.meta, {
      type: 'document',
      dynamic: false,
      fields: { note: { type: 'string', ...STRING } },
    });
    assert.deepStrictEqual(mappings.fields.when, { type: 'date' });
  });

  it('should leave a definition that is not an object alone', () => {
    assert.strictEqual(effectiveDefinition('search', undefined), undefined);
  });
});

describe('compareSearchIndex', () => {
  const same = (declaredIndex, liveFields) =>
    compareSearchIndex(declared(declaredIndex), live(liveFields)).diffs;

  for (const [label, declaredIndex, liveFields] of [
    [
      'the same definition in another key order',
      { definition: { mappings: { fields: { a: { type: 'string' } }, dynamic: false } } },
      { latestDefinition: { mappings: { dynamic: false, fields: { a: { type: 'string' } } } } },
    ],
    [
      'defaults left out on one side and spelled out on the other',
      { definition: { mappings: { dynamic: true } } },
      {
        latestDefinition: {
          analyzer: 'lucene.standard',
          searchAnalyzer: 'lucene.standard',
          mappings: { dynamic: true, fields: {} },
          storedSource: false,
          numPartitions: 1,
        },
      },
    ],
    [
      'an Int32 where the declaration has a number',
      {
        type: 'vectorSearch',
        definition: {
          fields: [{ type: 'vector', path: 'e', numDimensions: 3, similarity: 'cosine' }],
        },
      },
      {
        type: 'vectorSearch',
        latestDefinition: {
          fields: [
            { type: 'vector', path: 'e', numDimensions: new Int32(3), similarity: 'cosine' },
          ],
        },
      },
    ],
    [
      'field mappings with the defaults mongot writes into them',
      {
        definition: {
          mappings: {
            dynamic: false,
            fields: {
              title: { type: 'string' },
              year: { type: 'number' },
              sub: { type: 'document', fields: { a: { type: 'autocomplete' } } },
            },
          },
        },
      },
      {
        latestDefinition: {
          mappings: {
            dynamic: false,
            fields: {
              year: {
                type: 'number',
                representation: 'double',
                indexDoubles: true,
                indexIntegers: true,
              },
              title: { type: 'string', indexOptions: 'offsets', store: true, norms: 'include' },
              sub: {
                type: 'document',
                dynamic: false,
                fields: {
                  a: {
                    type: 'autocomplete',
                    minGrams: 2,
                    maxGrams: 15,
                    foldDiacritics: true,
                    tokenization: 'edgeGram',
                  },
                },
              },
            },
          },
        },
      },
    ],
    [
      'a field indexed as several types, reported in another order',
      {
        definition: {
          mappings: { fields: { tags: [{ type: 'token' }, { type: 'stringFacet' }] } },
        },
      },
      {
        latestDefinition: {
          mappings: { fields: { tags: [{ type: 'stringFacet' }, { type: 'token' }] } },
        },
      },
    ],
    [
      'vector fields in another order',
      { type: 'vectorSearch', definition: VECTOR },
      { type: 'vectorSearch', latestDefinition: { fields: [...VECTOR.fields].reverse() } },
    ],
    [
      'vector defaults spelled out by the server',
      { type: 'vectorSearch', definition: VECTOR },
      {
        type: undefined,
        latestDefinition: {
          fields: [
            {
              ...VECTOR.fields[0],
              quantization: 'none',
              indexingMethod: 'hnsw',
              hnswOptions: { maxEdges: 16, numEdgeCandidates: 100 },
            },
            VECTOR.fields[1],
          ],
        },
      },
    ],
    [
      'autoEmbed defaults spelled out by the server',
      { type: 'vectorSearch', definition: AUTO },
      {
        type: 'vectorSearch',
        latestDefinition: {
          fields: [
            { ...AUTO.fields[0], numDimensions: 1024, quantization: 'scalar' },
            AUTO.fields[1],
          ],
        },
      },
    ],
  ]) {
    it(`should see ${label} as unchanged`, () => {
      assert.deepStrictEqual(same(declaredIndex, liveFields), []);
    });
  }

  it('should name the top-level keys that differ', () => {
    assert.deepStrictEqual(
      same(
        { definition: { analyzer: 'lucene.english', mappings: { dynamic: false } } },
        { latestDefinition: { mappings: { dynamic: true } } },
      ),
      ['analyzer', 'mappings', 'searchAnalyzer'],
    );
  });

  it('should see a field option changed from its default as a change', () => {
    assert.deepStrictEqual(
      same(
        { definition: { mappings: { fields: { title: { type: 'string' } } } } },
        {
          latestDefinition: {
            mappings: { fields: { title: { type: 'string', store: false } } },
          },
        },
      ),
      ['mappings'],
    );
  });

  it('should see a removed option as a change, not as "left alone"', () => {
    assert.deepStrictEqual(
      same(
        { definition: { mappings: { dynamic: true } } },
        { latestDefinition: { mappings: { dynamic: true }, storedSource: true } },
      ),
      ['storedSource'],
    );
  });

  describe('options only the server reports', () => {
    const compare = (declaredIndex, liveFields) =>
      compareSearchIndex(declared(declaredIndex), live(liveFields));
    const SEARCH = {
      mappings: {
        dynamic: false,
        fields: {
          title: {
            type: 'string',
            multi: { english: { type: 'string', analyzer: 'lucene.english' } },
          },
          sub: { type: 'document', fields: { a: { type: 'token' } } },
          tags: [{ type: 'token' }, { type: 'stringFacet' }],
        },
      },
    };

    it('should ignore them at every option level of a search definition, and name them', () => {
      const outcome = compare(
        { definition: SEARCH },
        {
          latestDefinition: {
            sortOrder: 'new',
            mappings: {
              dynamic: false,
              fieldLimit: 1000,
              fields: {
                title: {
                  type: 'string',
                  similarity: { type: 'bm25' },
                  multi: {
                    english: { type: 'string', analyzer: 'lucene.english', ignoreAbove: 99 },
                  },
                },
                sub: { type: 'document', fields: { a: { type: 'token', newDefault: 1 } } },
                tags: [{ type: 'stringFacet', x: true }, { type: 'token' }],
              },
            },
          },
        },
      );
      assert.deepStrictEqual(outcome.diffs, []);
      assert.deepStrictEqual(outcome.ignored.sort(), [
        'mappings.fieldLimit',
        'mappings.fields.sub.fields.a.newDefault',
        'mappings.fields.tags[stringFacet].x',
        'mappings.fields.title.multi.english.ignoreAbove',
        'mappings.fields.title.similarity',
        'sortOrder',
      ]);
    });

    it('should ignore them on a vector definition, its fields and their hnswOptions', () => {
      const outcome = compare(
        { type: 'vectorSearch', definition: VECTOR },
        {
          type: 'vectorSearch',
          latestDefinition: {
            nested: [],
            fields: [
              { ...VECTOR.fields[1], newOption: 'x' },
              {
                ...VECTOR.fields[0],
                hnswOptions: { maxEdges: 16, numEdgeCandidates: 100, ef: 3 },
              },
            ],
          },
        },
      );
      assert.deepStrictEqual(outcome.diffs, []);
      assert.deepStrictEqual(outcome.ignored.sort(), [
        'fields[filter:year].newOption',
        'fields[vector:embedding].hnswOptions.ef',
        'nested',
      ]);
    });

    it('should still see a field, a mapping type or a vector field only the server has', () => {
      assert.deepStrictEqual(
        compare(
          { definition: SEARCH },
          {
            latestDefinition: {
              mappings: {
                ...SEARCH.mappings,
                fields: { ...SEARCH.mappings.fields, extra: { type: 'token' } },
              },
            },
          },
        ).paths,
        ['mappings.fields.extra'],
      );
      assert.deepStrictEqual(
        compare(
          { definition: SEARCH },
          {
            latestDefinition: {
              mappings: {
                ...SEARCH.mappings,
                fields: { ...SEARCH.mappings.fields, sub: { type: 'embeddedDocuments' } },
              },
            },
          },
        ).diffs,
        ['mappings'],
      );
      const vector = compare(
        { type: 'vectorSearch', definition: VECTOR },
        {
          type: 'vectorSearch',
          latestDefinition: { fields: [...VECTOR.fields, { type: 'filter', path: 'genre' }] },
        },
      );
      assert.deepStrictEqual(vector.diffs, ['fields']);
      assert.deepStrictEqual(vector.ignored, []);
    });

    it('should name the differing paths — a few, and how many more', () => {
      const fields = {};
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) fields[name] = { type: 'token' };
      const outcome = compare(
        { definition: { mappings: { fields } } },
        {
          latestDefinition: {
            mappings: {
              fields: Object.fromEntries(
                Object.keys(fields).map((name) => [
                  name,
                  { type: 'token', normalization: 'lowercase' },
                ]),
              ),
            },
          },
        },
      );
      assert.deepStrictEqual(outcome.paths, [
        'mappings.fields.a.normalization',
        'mappings.fields.b.normalization',
        'mappings.fields.c.normalization',
        'mappings.fields.d.normalization',
        'mappings.fields.e.normalization',
      ]);
      assert.strictEqual(outcome.more, 2);
    });

    it('should keep a field named __proto__ a field', () => {
      const definition = JSON.parse(
        '{"mappings":{"dynamic":false,"fields":{"__proto__":{"type":"token"}}}}',
      );
      const same = compare({ definition }, { latestDefinition: definition });
      assert.deepStrictEqual(same.diffs, []);
      const other = JSON.parse(
        '{"mappings":{"dynamic":false,"fields":{"__proto__":{"type":"string"}}}}',
      );
      assert.deepStrictEqual(compare({ definition }, { latestDefinition: other }).diffs, [
        'mappings',
      ]);
    });
  });

  it('should report a change of type, which no update can make', () => {
    const outcome = compareSearchIndex(
      declared({ type: 'vectorSearch', definition: VECTOR }),
      live({}),
    );
    assert.deepStrictEqual(outcome, {
      diffs: ['type'],
      paths: ['type'],
      more: 0,
      typeChange: true,
      immutable: [],
      ignored: [],
    });
  });

  it('should leave a plain vector index update to the server', () => {
    const outcome = compareSearchIndex(
      declared({
        type: 'vectorSearch',
        definition: { fields: [{ ...VECTOR.fields[0], numDimensions: 4 }, VECTOR.fields[1]] },
      }),
      live({ type: 'vectorSearch', latestDefinition: VECTOR }),
    );
    assert.deepStrictEqual(outcome, {
      diffs: ['fields'],
      paths: ['fields[1].numDimensions'],
      more: 0,
      typeChange: false,
      immutable: [],
      ignored: [],
    });
  });

  for (const [label, declaredFields, immutable] of [
    [
      'another model',
      [{ ...AUTO.fields[0], model: 'voyage-4-large' }, AUTO.fields[1]],
      ['plot.model'],
    ],
    [
      'another size and quantization',
      [{ ...AUTO.fields[0], numDimensions: 512, quantization: 'binary' }, AUTO.fields[1]],
      ['plot.numDimensions', 'plot.quantization'],
    ],
    ['another path', [{ ...AUTO.fields[0], path: 'summary' }, AUTO.fields[1]], ['path']],
    [
      'a vector field where the autoEmbed one was',
      [{ type: 'vector', path: 'plot', numDimensions: 3, similarity: 'cosine' }, AUTO.fields[1]],
      ['plot.type'],
    ],
  ]) {
    it(`should refuse an autoEmbed field with ${label}`, () => {
      const outcome = compareSearchIndex(
        declared({ type: 'vectorSearch', definition: { fields: declaredFields } }),
        live({ type: 'vectorSearch', latestDefinition: AUTO }),
      );
      assert.deepStrictEqual(outcome.immutable, immutable);
    });
  }

  it('should let an autoEmbed index change its filters and similarity', () => {
    const outcome = compareSearchIndex(
      declared({
        type: 'vectorSearch',
        definition: {
          fields: [
            { ...AUTO.fields[0], similarity: 'dotProduct' },
            { type: 'filter', path: 'genre' },
          ],
        },
      }),
      live({ type: 'vectorSearch', latestDefinition: AUTO }),
    );
    assert.deepStrictEqual(outcome.diffs, ['fields']);
    assert.deepStrictEqual(outcome.immutable, []);
  });
});

describe('isSearchIndexReady', () => {
  for (const [label, fields, options, ready] of [
    ['a READY, queryable index', {}, {}, true],
    ['an index the server does not give a status', { status: undefined }, {}, true],
    ['a BUILDING index', { status: 'BUILDING', queryable: false }, {}, false],
    ['a queryable index still BUILDING', { status: 'BUILDING' }, {}, false],
    ['a FAILED index', { status: 'FAILED', queryable: true }, {}, false],
    ['a STALE index, queryable as it is', { status: 'STALE' }, {}, false],
    [
      'an index building a newer definition',
      { statusDetail: [{ stagedIndex: { status: 'BUILDING' } }] },
      {},
      false,
    ],
    [
      'an updated index whose version has not moved yet',
      { latestDefinitionVersion: { version: 3 } },
      { sinceVersion: 3 },
      false,
    ],
    [
      'an updated index past the version it was updated at',
      { latestDefinitionVersion: { version: 4 } },
      { sinceVersion: 3 },
      true,
    ],
    [
      'an updated index on a server that reports no version',
      { latestDefinitionVersion: undefined },
      { sinceVersion: 3 },
      true,
    ],
  ]) {
    it(`should say ${label} is ${ready ? '' : 'not '}ready`, () => {
      assert.strictEqual(isSearchIndexReady(live(fields), options), ready);
    });
  }
});

describe('searchBuildState', () => {
  for (const [build, state] of [
    [{ status: 'READY', queryable: true }, 'serving'],
    [{ status: 'UNKNOWN', queryable: true }, 'serving'],
    [{ queryable: true }, 'serving'],
    [{ status: 'READY', queryable: true, updating: true }, 'updating'],
    [{ status: 'BUILDING', queryable: true }, 'building'],
    [{ status: 'PENDING', queryable: false }, 'building'],
    [{ status: 'READY', queryable: false }, 'building'],
    [{ status: 'STALE', queryable: true }, 'stale'],
    [{ status: 'FAILED', queryable: true, message: 'x' }, 'failed'],
    [{ status: 'DELETING', queryable: false }, 'removing'],
    [{ status: 'DOES_NOT_EXIST', queryable: false }, 'removing'],
  ]) {
    it(`should call ${JSON.stringify(build)} ${state}`, () => {
      assert.strictEqual(searchBuildState(build), state);
    });
  }

  it('should read a live index and the build of a row alike', () => {
    const stale = live({ status: 'STALE' });
    assert.strictEqual(searchBuildState(stale), 'stale');
    assert.strictEqual(searchBuildState(searchBuild(stale)), 'stale');
  });
});
