const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_QUEUE_NAME,
  DEFAULT_SCHEDULER_ID,
  FORBIDDEN_JOB_OPTIONS,
  JOB_DATA_VERSION,
  JOB_NAMES,
  MIGRATION_JOB_OPTIONS,
  buildMigrationJob,
  buildSyncJobTemplate,
  dedupId,
  migrationJobOptions,
  parseJobData,
} = require('../../src/bullmq/jobs.js');
const { QueueJobInvalidError } = require('../../src/errors/index.js');

const upData = (overrides = {}) => ({
  v: 1,
  direction: 'up',
  migration: '0001-a.js',
  groupId: 'group-1',
  index: 0,
  total: 2,
  batch: 3,
  ...overrides,
});
const job = (name, data, id = '7') => ({ id, name, data });

describe('job contract constants', () => {
  it('should be frozen — the contract is shared with whatever enqueued the job', () => {
    assert.ok(Object.isFrozen(JOB_NAMES));
    assert.ok(Object.isFrozen(MIGRATION_JOB_OPTIONS));
    assert.ok(Object.isFrozen(FORBIDDEN_JOB_OPTIONS));
    assert.deepStrictEqual({ ...JOB_NAMES }, { UP: 'up', DOWN: 'down', SYNC: 'sync' });
    assert.strictEqual(JOB_DATA_VERSION, 1);
  });

  it('should use names BullMQ accepts (no colon)', () => {
    assert.ok(!DEFAULT_QUEUE_NAME.includes(':'));
    assert.ok(!DEFAULT_SCHEDULER_ID.includes(':'));
  });

  it('should give migration jobs exactly one attempt', () => {
    assert.strictEqual(MIGRATION_JOB_OPTIONS.attempts, 1);
  });
});

describe('dedupId', () => {
  it('should differ by direction, so a rollback is never absorbed by a pending apply', () => {
    assert.notStrictEqual(dedupId('up', '0001-a.js'), dedupId('down', '0001-a.js'));
  });

  it('should never contain a colon, whatever the filename holds', () => {
    for (const name of ['0001-a.js', 'a:b.ts', 'weird name (1).js', '0001:é.js']) {
      assert.ok(!dedupId('up', name).includes(':'), name);
    }
    assert.strictEqual(dedupId('up', '0001-a.js'), 'up-0001-a.js');
  });
});

describe('buildMigrationJob / migrationJobOptions', () => {
  it('should stamp the version, position and shared batch', () => {
    const spec = buildMigrationJob({
      direction: 'up',
      migration: '0002-b.js',
      groupId: 'g',
      index: 1,
      total: 3,
      batch: 9,
    });
    assert.deepStrictEqual(spec, {
      name: 'up',
      data: {
        v: 1,
        direction: 'up',
        migration: '0002-b.js',
        groupId: 'g',
        index: 1,
        total: 3,
        batch: 9,
      },
    });
  });

  it('should carry force and an opt-out of the order guard only when set', () => {
    const base = { direction: 'up', migration: 'a.js', groupId: 'g', index: 0, total: 1, batch: 1 };
    assert.strictEqual(buildMigrationJob({ ...base, force: true }).data.force, true);
    assert.strictEqual(buildMigrationJob({ ...base, force: false }).data.force, undefined);
    assert.strictEqual(buildMigrationJob({ ...base, ordered: false }).data.ordered, false);
    assert.strictEqual(buildMigrationJob({ ...base, ordered: true }).data.ordered, undefined);
  });

  it('should omit a missing batch (a down job for a record without one)', () => {
    const spec = buildMigrationJob({
      direction: 'down',
      migration: 'a.js',
      groupId: 'g',
      index: 0,
      total: 1,
      batch: null,
    });
    assert.ok(!Object.hasOwn(spec.data, 'batch'));
  });

  it("should put the contract's options over the caller's", () => {
    const opts = migrationJobOptions({ removeOnComplete: 10, attempts: 5 }, 'up', '0001-a.js');
    assert.deepStrictEqual(opts, {
      removeOnComplete: 10,
      attempts: 1,
      deduplication: { id: 'up-0001-a.js' },
    });
    assert.deepStrictEqual(migrationJobOptions(undefined, 'down', 'x.js'), {
      attempts: 1,
      deduplication: { id: 'down-x.js' },
    });
  });

  it('should build the sync template a scheduler replays', () => {
    assert.deepStrictEqual(buildSyncJobTemplate(), {
      name: 'sync',
      data: { v: 1, kind: 'sync' },
      opts: { attempts: 1, telemetry: { omitContext: true } },
    });
    assert.strictEqual(buildSyncJobTemplate({ to: '0005-x.js' }).data.to, '0005-x.js');
  });

  it('should keep a scheduled tick out of the trace that registered the schedule', () => {
    // BullMQ builds every iteration from the previous job's options: a trace
    // context left there would chain all ticks into one endless trace.
    assert.strictEqual(buildSyncJobTemplate().opts.telemetry.omitContext, true);
    assert.ok(!('metadata' in buildSyncJobTemplate().opts.telemetry));
  });
});

describe('parseJobData', () => {
  it('should normalize a valid up job', () => {
    assert.deepStrictEqual(parseJobData(job('up', upData())), {
      kind: 'migration',
      direction: 'up',
      migration: '0001-a.js',
      groupId: 'group-1',
      index: 0,
      total: 2,
      batch: 3,
    });
  });

  it('should keep force and ordered when present', () => {
    const parsed = parseJobData(job('up', upData({ force: true, ordered: false })));
    assert.strictEqual(parsed.force, true);
    assert.strictEqual(parsed.ordered, false);
  });

  it('should accept a down job with or without a batch', () => {
    const base = upData({ direction: 'down' });
    assert.strictEqual(parseJobData(job('down', base)).batch, 3);
    const { batch: _batch, ...withoutBatch } = base;
    assert.ok(!Object.hasOwn(parseJobData(job('down', withoutBatch)), 'batch'));
    assert.ok(!Object.hasOwn(parseJobData(job('down', { ...base, batch: null })), 'batch'));
  });

  it('should drop keys outside the contract instead of passing them on', () => {
    const parsed = parseJobData(job('up', upData({ noLock: true, uri: 'mongodb://evil' })));
    assert.ok(!Object.hasOwn(parsed, 'noLock'));
    assert.ok(!Object.hasOwn(parsed, 'uri'));
  });

  it('should accept a sync job, with an optional target', () => {
    assert.deepStrictEqual(parseJobData(job('sync', { v: 1, kind: 'sync' })), { kind: 'sync' });
    assert.deepStrictEqual(parseJobData(job('sync', { v: 1, kind: 'sync', to: '0003-c.js' })), {
      kind: 'sync',
      to: '0003-c.js',
    });
  });

  // Every case is a payload someone with write access to Redis could plant.
  const invalid = [
    ['a non-object job', () => 'up', /not an object/],
    ['an unknown job name', () => job('redo', upData()), /unknown job name/],
    ['data that is not an object', () => job('up', 'oops'), /data is not an object/],
    ['an array as data', () => job('up', []), /data is not an object/],
    ['a newer data version', () => job('up', upData({ v: 2 })), /unsupported job data version/],
    ['a missing version', () => job('up', upData({ v: undefined })), /unsupported/],
    ['a direction that disagrees with the job name', () => job('down', upData()), /direction/],
    [
      'a path-traversing migration',
      () => job('up', upData({ migration: '../../etc/passwd' })),
      /bare filename/,
    ],
    [
      'a nested migration path',
      () => job('up', upData({ migration: 'sub/0001-a.js' })),
      /bare filename/,
    ],
    [
      'a query operator as migration',
      () => job('up', upData({ migration: { $ne: null } })),
      /bare filename/,
    ],
    [
      'an oversized migration name',
      () => job('up', upData({ migration: `${'a'.repeat(256)}.js` })),
      /bare filename/,
    ],
    ['a non-string groupId', () => job('up', upData({ groupId: 5 })), /groupId/],
    ['an empty groupId', () => job('up', upData({ groupId: '' })), /groupId/],
    ['an oversized groupId', () => job('up', upData({ groupId: 'g'.repeat(129) })), /groupId/],
    ['an index outside the group', () => job('up', upData({ index: 2 })), /index\/total/],
    ['a negative index', () => job('up', upData({ index: -1 })), /index\/total/],
    ['a fractional total', () => job('up', upData({ total: 2.5 })), /index\/total/],
    ['an up job without a batch', () => job('up', upData({ batch: undefined })), /batch/],
    ['a non-positive batch', () => job('up', upData({ batch: 0 })), /batch/],
    ['a string batch', () => job('down', upData({ direction: 'down', batch: '3' })), /batch/],
    ['force that is not `true`', () => job('up', upData({ force: 'yes' })), /force/],
    ['force on a down job', () => job('down', upData({ direction: 'down', force: true })), /force/],
    ['a non-boolean ordered', () => job('up', upData({ ordered: 0 })), /ordered/],
    ['a sync target that is not a filename', () => job('sync', { v: 1, to: '../x' }), /to is not/],
  ];

  for (const [label, build, issue] of invalid) {
    it(`should reject ${label}`, () => {
      assert.throws(
        () => parseJobData(build()),
        (error) => {
          assert.ok(error instanceof QueueJobInvalidError);
          assert.match(error.context.issue, issue);
          return true;
        },
      );
    });
  }

  it('should name the job in the error, when it has an id', () => {
    assert.throws(
      () => parseJobData(job('up', upData({ v: 9 }), 42)),
      (error) => error.context.jobId === '42',
    );
    assert.throws(
      () => parseJobData({ name: 'up', data: upData({ v: 9 }) }),
      (error) => !Object.hasOwn(error.context, 'jobId'),
    );
  });
});
