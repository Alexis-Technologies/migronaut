const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { ObjectId } = require('mongodb');
const {
  BACKGROUND_DEFAULTS,
  ID_BRACKETS,
  MAX_BAD_IDS,
  STATUSES,
  TERMINAL,
  TRANSITIONS,
  assertSliceMs,
  backgroundIssues,
  bracketOfType,
  keysetFilter,
  matchHash,
  resolveBackgroundSpec,
  scopeFilter,
  scopeIssue,
  transition,
} = require('../../src/core/background-spec.js');
const { assertUpOptions } = require('../../src/core/options.js');
const {
  BackgroundConflictError,
  ConfigInvalidError,
  MigrationInvalidExportError,
} = require('../../src/errors/index.js');
const { requiresIssues } = require('../../src/utils/migration-name.js');
const { resolveVersioning } = require('../../src/versioning/config.js');

const migrate = (doc) => doc;
const base = { collection: 'orders', from: 1, to: 2, migrate };
const pathsOf = (spec, options) => backgroundIssues(spec, options).map((issue) => issue.path);
const messageAt = (spec, path, options) =>
  backgroundIssues(spec, options).find((issue) => issue.path === path)?.message;

describe('backgroundIssues — declarative', () => {
  it('should accept a minimal spec and every setting', () => {
    assert.deepStrictEqual(backgroundIssues(base), []);
    assert.deepStrictEqual(
      backgroundIssues({
        ...base,
        filter: { status: 'open' },
        revert: migrate,
        description: 'x',
        batchSize: 200,
        pauseMs: 0,
        sliceMs: 5000,
        writeConcern: { w: 1 },
        maxDocumentErrors: 10,
        maxPasses: 3,
        maxConflictRetries: 0,
        maxSliceFailures: 5,
        maxReplicationLagMs: false,
        throttle: () => 0,
        maxParallel: 8,
        partitions: { overPartition: 2, maxPartitions: 64, minPartitionDocs: 100, sampleSize: 500 },
        transaction: { timeoutMs: 5000, maxRetries: 2 },
        adaptive: { targetLatencyMs: 200, minBatchSize: 5, maxBatchSize: 100, maxPauseMs: 1000 },
        shardConcurrency: 2,
        versionField: '__v',
        revisionField: '__rev',
        occ: 'revision',
      }),
      [],
    );
    assert.deepStrictEqual(
      backgroundIssues({ ...base, from: 0, migrate: undefined, migrateBatch: migrate }),
      [],
    );
  });

  it('should refuse unknown, reserved and misplaced keys', () => {
    assert.match(
      messageAt({ ...base, colection: 'x' }, 'background.colection'),
      /not a background/,
    );
    assert.match(
      messageAt({ ...base, partitioner: 'x' }, 'background.partitioner'),
      /not supported yet/,
    );
    assert.match(messageAt(null, 'background'), /must be an object/);
  });

  it('should require collection, from, to and one transformation', () => {
    assert.deepStrictEqual(pathsOf({}), [
      'background.collection',
      'background.from',
      'background.to',
      'background.migrate',
    ]);
    assert.match(messageAt({ ...base, collection: '$x' }, 'background.collection'), /valid/);
    assert.match(messageAt({ ...base, from: -1 }, 'background.from'), /integer ≥ 0/);
    assert.match(messageAt({ ...base, to: 1.5 }, 'background.to'), /integer ≥ 0/);
    assert.match(messageAt({ ...base, to: 1 }, 'background.to'), /greater than from/);
    assert.match(
      messageAt({ ...base, migrateBatch: migrate }, 'background.migrateBatch'),
      /cannot be combined/,
    );
    assert.match(
      messageAt({ ...base, revert: migrate, revertBatch: migrate }, 'background.revertBatch'),
      /cannot be combined/,
    );
    assert.match(messageAt({ ...base, migrate: 'x' }, 'background.migrate'), /must be a function/);
  });

  it('should check the filter and the field names', () => {
    assert.match(messageAt({ ...base, filter: [] }, 'background.filter'), /query document/);
    assert.match(messageAt({ ...base, filter: { a: () => 1 } }, 'background.filter'), /functions/);
    assert.match(
      messageAt({ ...base, filter: { __v: 1 } }, 'background.filter'),
      /must not constrain "__v"/,
    );
    assert.match(
      messageAt({ ...base, versionField: 'v', filter: { $or: [{ v: 1 }] } }, 'background.filter'),
      /must not constrain "v"/,
    );
    assert.match(
      messageAt({ ...base, versionField: 'a.b' }, 'background.versionField'),
      /top-level/,
    );
    assert.match(
      messageAt({ ...base, occ: 'none' }, 'background.occ'),
      /'revision' or 'version-only'/,
    );
    assert.match(
      messageAt({ ...base, occ: 'version-only', revisionField: 'r' }, 'background.revisionField'),
      /no effect/,
    );
  });

  it('should refuse a filter that runs JavaScript on the server', () => {
    for (const filter of [
      { $where: 'this.a > 1' },
      { $expr: { $function: { body: 'return true', args: [], lang: 'js' } } },
      { $and: [{ a: 1 }, { $where: 'true' }] },
    ]) {
      assert.match(messageAt({ ...base, filter }, 'background.filter'), /JavaScript/);
    }
    assert.deepStrictEqual(pathsOf({ ...base, filter: { status: 'open' } }), []);
  });

  it('should check the settings ranges', () => {
    const at = (key, value) => messageAt({ ...base, [key]: value }, `background.${key}`);
    assert.match(at('batchSize', 0), /from 1 to 10000/);
    assert.match(at('sliceMs', 10), /from 1000/);
    assert.match(at('maxParallel', 65), /from 1 to 64/);
    // Past the ids a state keeps, a budget could never be told.
    assert.match(at('maxDocumentErrors', MAX_BAD_IDS + 1), /from 0 to 1000/);
    assert.deepStrictEqual(pathsOf({ ...base, maxDocumentErrors: MAX_BAD_IDS }), []);
    assert.match(at('maxReplicationLagMs', -1), /false or an integer/);
    assert.match(at('writeConcern', 'majority'), /write concern object/);
    assert.match(at('writeConcern', { w: 0 }), /acknowledged/);
    assert.match(at('description', 1), /string/);
    assert.match(at('partitions', 3), /must be an object/);
    assert.match(at('transaction', 'yes'), /boolean or an object/);
    assert.match(
      messageAt({ ...base, partitions: { shards: 1 } }, 'background.partitions.shards'),
      /not one of the partitions settings/,
    );
    assert.match(
      messageAt(
        { ...base, transaction: { timeoutMs: 60_000 } },
        'background.transaction.timeoutMs',
      ),
      /from 1 to 50000/,
    );
    assert.match(
      messageAt({ ...base, adaptive: { burst: 1 } }, 'background.adaptive.burst'),
      /not one of the adaptive settings/,
    );
    assert.match(
      messageAt(
        { ...base, adaptive: { minBatchSize: 50, maxBatchSize: 10 } },
        'background.adaptive.minBatchSize',
      ),
      /must not exceed/,
    );
  });

  it('should hold a caller sliceMs to a positive integer up to the spec maximum', () => {
    for (const ok of [1, 100, 3_600_000]) assert.doesNotThrow(() => assertSliceMs(ok));
    for (const bad of [0, -5, 1.5, Number.NaN, '1000', 3_600_001]) {
      assert.throws(() => assertSliceMs(bad), ConfigInvalidError);
    }
  });

  it('should check the spec against the collection versioning', () => {
    const versioning = resolveVersioning({ current: 2 });
    assert.deepStrictEqual(backgroundIssues(base, { versioning }), []);
    assert.match(
      messageAt({ ...base, to: 3 }, 'background.to', { versioning }),
      /past the collection's versioning.current \(2\) — raise current first/,
    );
    assert.match(
      messageAt({ ...base, versionField: 'v' }, 'background.versionField', { versioning }),
      /differs/,
    );
    const noRevision = resolveVersioning({ current: 2, revision: false });
    assert.match(messageAt(base, 'background.occ', { versioning: noRevision }), /version-only/);
    assert.deepStrictEqual(
      backgroundIssues({ ...base, occ: 'version-only' }, { versioning: noRevision }),
      [],
    );
  });
});

describe('backgroundIssues — step', () => {
  const step = async () => ({ checkpoint: null, done: true });

  it('should accept a step migration and refuse declarative keys on it', () => {
    assert.deepStrictEqual(backgroundIssues({ step, revertStep: step, collection: 'orders' }), []);
    assert.match(messageAt({ step, from: 1 }, 'background.from'), /step owns its own writes/);
    assert.match(messageAt({ step, migrate }, 'background.migrate'), /step owns its own writes/);
    assert.match(messageAt({ step, maxParallel: 2 }, 'background.maxParallel'), /must be 1/);
    assert.match(messageAt({ step, collection: '' }, 'background.collection'), /valid/);
  });
});

describe('resolveBackgroundSpec', () => {
  it('should fill every default and keep the functions apart', () => {
    const { spec, fns } = resolveBackgroundSpec(base, { name: '0001-a.js' });
    assert.deepStrictEqual(spec, {
      mode: 'declarative',
      collection: 'orders',
      from: 1,
      to: 2,
      filter: {},
      field: '__v',
      revisionField: '__rev',
      occ: 'revision',
      batched: false,
      reversible: false,
      batchSize: 500,
      pauseMs: 100,
      sliceMs: 30_000,
      writeConcern: { w: 'majority' },
      maxDocumentErrors: 0,
      maxPasses: 10,
      maxConflictRetries: 3,
      maxSliceFailures: 3,
      maxReplicationLagMs: 10_000,
      maxParallel: 1,
      shardConcurrency: 1,
      partitions: { overPartition: 4, maxPartitions: 256, minPartitionDocs: 2000, sampleSize: 400 },
      transaction: false,
      adaptive: { targetLatencyMs: 500, minBatchSize: 10, maxBatchSize: 500, maxPauseMs: 30_000 },
    });
    assert.deepStrictEqual(Object.keys(fns), ['migrate']);
    assert.strictEqual(BACKGROUND_DEFAULTS.batchSize, 500);
  });

  it('should size batches down for transactions, and cap the adaptive throttle', () => {
    const { spec } = resolveBackgroundSpec({
      ...base,
      transaction: true,
      maxParallel: 4,
      adaptive: { maxBatchSize: 5000 },
      maxReplicationLagMs: false,
      revertBatch: migrate,
    });
    assert.deepStrictEqual(spec.transaction, { timeoutMs: 10_000, maxRetries: 5 });
    assert.strictEqual(spec.batchSize, 100);
    assert.strictEqual(spec.adaptive.maxBatchSize, 100);
    assert.strictEqual(spec.partitions.sampleSize, 1600);
    assert.strictEqual(spec.maxReplicationLagMs, false);
    assert.strictEqual(spec.reversible, true);
    assert.strictEqual(resolveBackgroundSpec({ ...base, adaptive: false }).spec.adaptive, false);
  });

  it('should take the field names from the collection versioning', () => {
    const versioning = resolveVersioning({ current: 3, field: 'v', revision: false });
    const { spec } = resolveBackgroundSpec(
      { ...base, occ: 'version-only', filter: { status: /open/i } },
      { versioning },
    );
    assert.strictEqual(spec.field, 'v');
    assert.strictEqual(spec.revisionField, null);
    assert.ok(spec.filter.status instanceof RegExp);
  });

  it('should resolve a step migration as one partition', () => {
    const step = async () => ({ checkpoint: null, done: true });
    const { spec, fns } = resolveBackgroundSpec({ step, collection: 'orders', transaction: true });
    assert.strictEqual(spec.mode, 'step');
    assert.strictEqual(spec.maxParallel, 1);
    assert.strictEqual(spec.reversible, false);
    assert.strictEqual(spec.collection, 'orders');
    assert.strictEqual(typeof fns.step, 'function');
    assert.strictEqual(resolveBackgroundSpec({ step }).spec.collection, undefined);
  });

  it('should throw every issue at once, naming the file', () => {
    assert.throws(
      () => resolveBackgroundSpec({ collection: 'orders' }, { name: '0002-x.js' }),
      (error) =>
        error instanceof MigrationInvalidExportError &&
        /0002-x\.js/.test(error.message) &&
        error.context.issues.length === 3,
    );
  });
});

describe('matchHash', () => {
  it('should change with anything that changes the matched documents', () => {
    const { spec } = resolveBackgroundSpec(base);
    const hash = matchHash(spec);
    assert.match(hash, /^[0-9a-f]{32}$/);
    assert.strictEqual(matchHash(resolveBackgroundSpec({ ...base, batchSize: 7 }).spec), hash);
    assert.notStrictEqual(matchHash(spec, 'revert'), hash);
    assert.notStrictEqual(matchHash(resolveBackgroundSpec({ ...base, to: 3 }).spec), hash);
    assert.notStrictEqual(
      matchHash(resolveBackgroundSpec({ ...base, filter: { a: 1 } }).spec),
      hash,
    );
    // Key order of the filter does not matter, values do.
    assert.strictEqual(
      matchHash(resolveBackgroundSpec({ ...base, filter: { a: 1, b: 2 } }).spec),
      matchHash(resolveBackgroundSpec({ ...base, filter: { b: 2, a: 1 } }).spec),
    );
    assert.match(matchHash({ mode: 'step' }), /^[0-9a-f]{32}$/);
  });
});

describe('requiresIssues', () => {
  it('should accept earlier bare names and refuse the rest', () => {
    assert.deepStrictEqual(requiresIssues(undefined, 'b.js'), []);
    assert.deepStrictEqual(requiresIssues(['a.js'], 'b.js'), []);
    assert.match(requiresIssues('a.js', 'b.js')[0].message, /array/);
    assert.deepStrictEqual(
      requiresIssues(['../a.js', 'a.js', 'a.js', 'b.js', 'c.js'], 'b.js').map(
        (issue) => issue.path,
      ),
      ['requires[0]', 'requires[2]', 'requires[3]', 'requires[4]'],
    );
    // An edge only ever points backwards, so no cycle can form.
    assert.match(requiresIssues(['c.js'], 'b.js')[0].message, /earlier migration/);
  });
});

describe('state transitions', () => {
  it('should move, keep or refuse every action from every status', () => {
    for (const [action, rule] of Object.entries(TRANSITIONS)) {
      for (const status of STATUSES) {
        if (rule.from.includes(status)) {
          assert.deepStrictEqual(transition(status, action), { to: rule.to, applied: 'changed' });
        } else if (rule.done.includes(status)) {
          assert.deepStrictEqual(transition(status, action), { to: status, applied: 'unchanged' });
        } else {
          assert.throws(
            () => transition(status, action, { migration: 'm.js' }),
            (error) =>
              error instanceof BackgroundConflictError &&
              error.context.status === status &&
              error.context.action === action &&
              /Cannot .* background migration m\.js/.test(error.message),
          );
        }
      }
    }
    assert.throws(() => transition('pending', 'explode'), BackgroundConflictError);
  });

  it('should reopen only a completed one, and pause no terminal one', () => {
    assert.deepStrictEqual(transition('completed', 'reopen'), {
      to: 'running',
      applied: 'changed',
    });
    assert.deepStrictEqual(transition('blocked', 'unblock'), { to: 'pending', applied: 'changed' });
    for (const status of TERMINAL) assert.throws(() => transition(status, 'pause'));
  });
});

describe('_id brackets and scopes', () => {
  it('should list the brackets in server order, with their $type names', () => {
    assert.deepStrictEqual(
      ID_BRACKETS.map((bracket) => bracket.name),
      [
        'minKey',
        'null',
        'number',
        'string',
        'object',
        'binData',
        'objectId',
        'bool',
        'date',
        'timestamp',
        'exotic',
        'maxKey',
      ],
    );
    assert.strictEqual(bracketOfType('long'), 'number');
    assert.strictEqual(bracketOfType('symbol'), 'string');
    assert.strictEqual(bracketOfType('javascript'), 'exotic');
    assert.strictEqual(bracketOfType('somethingNew'), 'exotic');
  });

  it('should filter a scope by type and bounds, and resume after the last id', () => {
    const id = new ObjectId();
    assert.deepStrictEqual(scopeFilter({ kind: 'id-range', bracket: 'objectId', gte: id }), {
      _id: { $type: ['objectId'], $gte: id },
    });
    assert.deepStrictEqual(scopeFilter({ kind: 'id-range', bracket: 'number', lt: 10 }), {
      _id: { $type: ['int', 'long', 'double', 'decimal'], $lt: 10 },
    });
    assert.deepStrictEqual(scopeFilter({ kind: 'step' }), {});
    assert.deepStrictEqual(keysetFilter(id), { _id: { $gt: id } });
    assert.deepStrictEqual(keysetFilter(undefined), {});
  });

  it('should refuse a scope it cannot run', () => {
    assert.strictEqual(scopeIssue({ kind: 'id-range', bracket: 'string', gte: 'a' }), null);
    assert.strictEqual(scopeIssue({ kind: 'step' }), null);
    assert.match(scopeIssue(null), /object/);
    assert.match(scopeIssue({ kind: 'hash' }), /unknown kind/);
    assert.match(scopeIssue({ kind: 'id-range', bracket: 'array' }), /unknown bracket/);
    assert.match(scopeIssue({ kind: 'id-range', bracket: 'object', gte: {} }), /never split/);
  });
});

describe('up options — onBackgroundPending', () => {
  it("should accept 'error' and 'stop' only", () => {
    assert.doesNotThrow(() => assertUpOptions(undefined, { onBackgroundPending: 'stop' }));
    assert.throws(
      () => assertUpOptions(undefined, { onBackgroundPending: 'wait' }),
      ConfigInvalidError,
    );
  });
});
