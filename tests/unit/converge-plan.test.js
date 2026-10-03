const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { normalizeDefinition } = require('../../src/core/collections.js');
const {
  UNIQUE_REBUILD_REASON,
  desiredValidator,
  isDestructive,
  liveValidator,
  planCollection,
  summarize,
} = require('../../src/core/converge-plan.js');

const ID_INDEX = { v: 2, key: { _id: 1 }, name: '_id_' };
const FR = { locale: 'fr', strength: 3, version: '57.1' };

const definition = (fields) => normalizeDefinition({ name: 'c', ...fields });
const existing = (indexes = [], options = {}) => ({
  exists: true,
  type: 'collection',
  options,
  indexes: [ID_INDEX, ...indexes.map((index) => ({ v: 2, ...index }))],
});
const MISSING = { exists: false, indexes: [] };

/** Rows as compact strings: target:name:action[:reason][@liveName] */
const rows = (plan) =>
  plan.actions.map(
    (action) =>
      `${action.target}:${action.name}:${action.action}` +
      (action.reason ? `:${action.reason}` : '') +
      (action.liveName ? `@${action.liveName}` : ''),
  );
/** Steps as compact strings, in execution order */
const steps = (plan) =>
  plan.steps.map((step) => {
    if (step.op === 'createIndex') return `create ${step.spec.name}`;
    if (step.op === 'dropIndex') return `drop ${step.name}`;
    if (step.op === 'createCollection') return 'createCollection';
    if (step.op === 'collMod') {
      return step.command.index ? `collMod ${step.command.index.name}` : 'collMod validator';
    }
    return `rebuild [${step.drops.map((drop) => drop.name).join(',')}] → [${step.creates
      .map((create) => create.spec.name)
      .join(',')}]`;
  });

describe('planCollection — a collection that does not exist', () => {
  it('should create it, with its validator, then its indexes', () => {
    const plan = planCollection(
      definition({ indexes: [{ key: { a: 1 } }], validator: { a: { $type: 'int' } } }),
      MISSING,
    );
    assert.deepStrictEqual(rows(plan), [
      'collection:c:create',
      'validator:c:create',
      'index:a_1:create',
    ]);
    assert.deepStrictEqual(steps(plan), ['createCollection', 'create a_1']);
    assert.deepStrictEqual(plan.steps[0].options, {
      validator: { a: { $type: 'int' } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    // One step settles both the collection and the validator row.
    assert.strictEqual(plan.steps[0].actions.length, 2);
    assert.ok(plan.actions.every((action) => action.status === 'planned'));
  });

  it('should not create an empty collection just to have no validator', () => {
    assert.deepStrictEqual(rows(planCollection(definition({ validator: null }), MISSING)), []);
    assert.deepStrictEqual(rows(planCollection(definition({ indexes: [] }), MISSING)), []);
  });
});

describe('planCollection — views and time-series collections', () => {
  it('should refuse anything that is not a regular collection', () => {
    for (const type of ['view', 'timeseries']) {
      const plan = planCollection(definition({ indexes: [{ key: { a: 1 } }] }), {
        exists: true,
        type,
        options: {},
        indexes: [],
      });
      assert.deepStrictEqual(rows(plan), [
        `collection:c:conflict:is a ${type}, not a regular collection`,
      ]);
      assert.deepStrictEqual(plan.steps, []);
    }
  });
});

describe('planCollection — validators', () => {
  const cases = [
    ['unmanaged', { indexes: [] }, {}, [], []],
    ['none, and none wanted', { validator: null }, {}, ['validator:c:unchanged'], []],
    [
      'an empty object means none',
      { validator: {} },
      { validator: {} },
      ['validator:c:unchanged'],
      [],
    ],
    ['added', { validator: { a: 1 } }, {}, ['validator:c:create'], ['collMod validator']],
    [
      'removed',
      { validator: null },
      { validator: { a: 1 } },
      ['validator:c:drop'],
      ['collMod validator'],
    ],
    [
      'same document in another key order, defaults implied',
      { validator: { a: 1, b: 2 } },
      { validator: { b: 2, a: 1 } },
      ['validator:c:unchanged'],
      [],
    ],
    [
      'changed document and action',
      { validator: { a: 1 }, validationAction: 'warn' },
      { validator: { a: 2 } },
      ['validator:c:modify:validator, validationAction'],
      ['collMod validator'],
    ],
    [
      'level reset to the default',
      { validator: { a: 1 } },
      { validator: { a: 1 }, validationLevel: 'moderate', validationAction: 'error' },
      ['validator:c:modify:validationLevel'],
      ['collMod validator'],
    ],
  ];
  for (const [label, fields, options, expectedRows, expectedSteps] of cases) {
    it(`should plan a validator that is ${label}`, () => {
      const plan = planCollection(definition(fields), existing([], options));
      assert.deepStrictEqual(rows(plan), expectedRows);
      assert.deepStrictEqual(steps(plan), expectedSteps);
    });
  }

  it('should send every validator setting, and an empty document to remove it', () => {
    const set = planCollection(definition({ validator: { a: 1 } }), existing());
    assert.deepStrictEqual(set.steps[0].command, {
      validator: { a: 1 },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    const removed = planCollection(
      definition({ validator: null }),
      existing([], { validator: { a: 1 } }),
    );
    assert.deepStrictEqual(removed.steps[0].command, { validator: {} });
  });

  it('should expose the desired and live validator states', () => {
    assert.strictEqual(desiredValidator({}), undefined);
    assert.strictEqual(desiredValidator({ validator: {} }), null);
    assert.strictEqual(liveValidator(undefined), null);
    assert.deepStrictEqual(liveValidator({ validator: { a: 1 }, validationAction: 'warn' }), {
      validator: { a: 1 },
      validationLevel: 'strict',
      validationAction: 'warn',
    });
  });
});

describe('planCollection — indexes', () => {
  const cases = [
    {
      label: 'nothing to do',
      declared: [{ key: { a: 1 } }],
      live: [{ key: { a: 1 }, name: 'a_1' }],
      rows: ['index:a_1:unchanged'],
      steps: [],
    },
    {
      label: 'a missing index',
      declared: [{ key: { a: 1 } }],
      live: [],
      rows: ['index:a_1:create'],
      steps: ['create a_1'],
    },
    {
      label: 'a TTL and a hidden flag changed in place',
      declared: [
        { key: { t: 1 }, expireAfterSeconds: 60 },
        { key: { h: 1 }, hidden: true },
      ],
      live: [
        { key: { t: 1 }, name: 't_1', expireAfterSeconds: 30 },
        { key: { h: 1 }, name: 'h_1' },
      ],
      rows: ['index:t_1:modify:expireAfterSeconds', 'index:h_1:modify:hidden'],
      steps: ['collMod t_1', 'collMod h_1'],
    },
    {
      label: 'a changed option rebuilt',
      declared: [{ key: { a: 1 }, unique: true }],
      live: [{ key: { a: 1 }, name: 'a_1' }],
      rows: ['index:a_1:recreate:unique'],
      steps: ['rebuild [a_1] → [a_1]'],
    },
    {
      label: 'a unique index rebuilt unasked — a conflict',
      declared: [{ key: { a: 1 }, unique: true, sparse: true }],
      live: [{ key: { a: 1 }, name: 'a_1', unique: true }],
      rows: [`index:a_1:conflict:sparse; ${UNIQUE_REBUILD_REASON}`],
      steps: [],
    },
    {
      label: 'a unique index rebuilt with rebuildUnique',
      declared: [{ key: { a: 1 }, unique: true, sparse: true }],
      live: [{ key: { a: 1 }, name: 'a_1', unique: true }],
      rebuildUnique: true,
      rows: ['index:a_1:recreate:sparse'],
      steps: ['rebuild [a_1] → [a_1]'],
    },
    {
      label: 'a unique index made non-unique — the constraint is meant to go',
      declared: [{ key: { a: 1 } }],
      live: [{ key: { a: 1 }, name: 'a_1', unique: true }],
      rows: ['index:a_1:recreate:unique'],
      steps: ['rebuild [a_1] → [a_1]'],
    },
    {
      label: 'a unique index renamed with prune — a conflict without rebuildUnique',
      declared: [{ key: { a: 1 }, name: 'a_declared', unique: true }],
      live: [{ key: { a: 1 }, name: 'a_live', unique: true }],
      prune: true,
      rows: [`index:a_declared:conflict:name; ${UNIQUE_REBUILD_REASON}@a_live`],
      steps: [],
    },
    {
      label: 'an undeclared index kept with prune off',
      declared: [],
      live: [{ key: { x: 1 }, name: 'x_1' }],
      rows: ['index:x_1:keep:not declared'],
      steps: [],
    },
    {
      label: 'an undeclared index dropped with prune on, last',
      declared: [{ key: { a: 1 } }],
      live: [{ key: { x: 1 }, name: 'x_1' }],
      prune: true,
      rows: ['index:a_1:create', 'index:x_1:drop:not declared'],
      steps: ['create a_1', 'drop x_1'],
    },
    {
      label: 'an identical index under another name, kept without prune',
      declared: [{ key: { a: 1 }, name: 'a_declared', unique: true }],
      live: [{ key: { a: 1 }, name: 'a_live', unique: true }],
      rows: ['index:a_declared:unchanged:exists as "a_live"@a_live'],
      steps: [],
    },
    {
      label: 'an identical index under another name, renamed with prune',
      declared: [{ key: { a: 1 }, name: 'a_declared' }],
      live: [{ key: { a: 1 }, name: 'a_live' }],
      prune: true,
      rows: ['index:a_declared:recreate:name@a_live'],
      steps: ['rebuild [a_live] → [a_declared]'],
    },
    {
      label: 'a different undeclared index on the same key, a conflict without prune',
      declared: [{ key: { a: 1 }, name: 'a_declared', unique: true }],
      live: [{ key: { a: 1 }, name: 'a_live' }],
      rows: [
        'index:a_declared:conflict:the undeclared index "a_live" covers the same key — declare ' +
          'it under its own name, or converge with prune to replace it@a_live',
      ],
      steps: [],
    },
    {
      label: 'a different undeclared index on the same key, replaced with prune',
      declared: [{ key: { a: 1 }, name: 'a_declared', unique: true }],
      live: [{ key: { a: 1 }, name: 'a_live' }],
      prune: true,
      rows: ['index:a_declared:recreate:replaces "a_live"@a_live'],
      steps: ['rebuild [a_live] → [a_declared]'],
    },
    {
      label: 'a rebuild blocked by an undeclared index, both dropped with prune',
      declared: [{ key: { a: 1 }, name: 'idx', unique: true }],
      live: [
        { key: { a: 1, b: 1 }, name: 'idx' },
        { key: { a: 1 }, name: 'a_1' },
      ],
      prune: true,
      rows: ['index:idx:recreate:key, unique; replaces "a_1"@a_1'],
      steps: ['rebuild [idx,a_1] → [idx]'],
    },
    {
      label: 'a second text index, a conflict without prune',
      declared: [{ key: { b: 'text' } }],
      live: [
        {
          key: { _fts: 'text', _ftsx: 1 },
          name: 'a_text',
          weights: { a: 1 },
          default_language: 'english',
          language_override: 'language',
        },
      ],
      rows: [
        'index:b_text:conflict:the undeclared index "a_text" covers the same key — declare it ' +
          'under its own name, or converge with prune to replace it@a_text',
      ],
      steps: [],
    },
    {
      label: 'two rebuilds that swap keys, run as one group',
      declared: [
        { key: { b: 1 }, name: 'x' },
        { key: { a: 1 }, name: 'y' },
      ],
      live: [
        { key: { a: 1 }, name: 'x' },
        { key: { b: 1 }, name: 'y' },
      ],
      rows: ['index:x:recreate:key', 'index:y:recreate:key'],
      steps: ['rebuild [x,y] → [x,y]'],
    },
    {
      label: 'a create that waits for a rebuild dropping its key',
      declared: [
        { key: { a: 1 }, name: 'fresh' },
        { key: { b: 1 }, name: 'old' },
      ],
      live: [{ key: { a: 1 }, name: 'old' }],
      rows: ['index:fresh:create', 'index:old:recreate:key'],
      steps: ['rebuild [old] → [old,fresh]'],
    },
    {
      label: 'creates, then in-place changes, then rebuilds, then drops',
      declared: [
        { key: { r: 1 }, unique: true },
        { key: { t: 1 }, expireAfterSeconds: 5 },
        { key: { n: 1 } },
      ],
      live: [
        { key: { r: 1 }, name: 'r_1' },
        { key: { t: 1 }, name: 't_1', expireAfterSeconds: 9 },
        { key: { gone: 1 }, name: 'gone_1' },
      ],
      prune: true,
      rows: [
        'index:r_1:recreate:unique',
        'index:t_1:modify:expireAfterSeconds',
        'index:n_1:create',
        'index:gone_1:drop:not declared',
      ],
      steps: ['create n_1', 'collMod t_1', 'rebuild [r_1] → [r_1]', 'drop gone_1'],
    },
  ];

  for (const testCase of cases) {
    it(`should plan ${testCase.label}`, () => {
      const plan = planCollection(
        definition({ indexes: testCase.declared }),
        existing(testCase.live),
        {
          prune: testCase.prune ?? false,
          rebuildUnique: testCase.rebuildUnique ?? false,
        },
      );
      assert.deepStrictEqual(rows(plan), testCase.rows);
      assert.deepStrictEqual(steps(plan), testCase.steps);
    });
  }

  it('should never list the _id index or a clustered index', () => {
    const plan = planCollection(
      definition({ indexes: [] }),
      existing([{ key: { _id: 1 }, name: 'cluster', unique: true, clustered: true }]),
      { prune: true },
    );
    assert.deepStrictEqual(rows(plan), []);
  });

  it('should leave indexes alone when the definition does not manage them', () => {
    const plan = planCollection(
      definition({ validator: null }),
      existing([{ key: { x: 1 }, name: 'x_1' }]),
      {
        prune: true,
      },
    );
    assert.deepStrictEqual(rows(plan), ['validator:c:unchanged']);
  });

  it("should accept the collection's default collation on an undeclared-collation index", () => {
    const plan = planCollection(
      definition({ indexes: [{ key: { z: 1 } }] }),
      existing([{ key: { z: 1 }, name: 'z_1', collation: FR }], { collation: FR }),
    );
    assert.deepStrictEqual(rows(plan), ['index:z_1:unchanged']);
  });

  it('should carry what a failed rebuild needs to restore the dropped index', () => {
    const plan = planCollection(
      definition({ indexes: [{ key: { a: 1 }, unique: true }] }),
      existing([{ key: { a: 1 }, name: 'a_1', ns: 'db.c', background: true }]),
    );
    assert.deepStrictEqual(plan.steps[0].drops, [
      { name: 'a_1', restore: { key: { a: 1 }, name: 'a_1' } },
    ]);
  });
});

describe('summarize / isDestructive', () => {
  it('should count changes, applied changes, conflicts and destructive rows', () => {
    const collections = [
      {
        actions: [
          { target: 'index', action: 'create', status: 'applied' },
          { target: 'index', action: 'recreate', status: 'planned' },
          { target: 'index', action: 'drop', status: 'planned' },
          { target: 'validator', action: 'drop', status: 'planned' },
          { target: 'index', action: 'keep', status: 'planned' },
          { target: 'index', action: 'conflict', status: 'planned' },
        ],
      },
    ];
    assert.deepStrictEqual(summarize(collections), {
      changes: 4,
      applied: 1,
      conflicts: 1,
      destructive: 2,
    });
    assert.ok(isDestructive({ target: 'index', action: 'recreate' }));
    // Removing a validator was declared outright and loses no data.
    assert.ok(!isDestructive({ target: 'validator', action: 'drop' }));
  });
});
