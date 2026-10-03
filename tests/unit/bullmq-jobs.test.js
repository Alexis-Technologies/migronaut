const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_CONVERGE_SCHEDULER_ID,
  DEFAULT_QUEUE_NAME,
  DEFAULT_SCHEDULER_ID,
  FORBIDDEN_JOB_OPTIONS,
  JOB_DATA_VERSION,
  JOB_FIELDS,
  JOB_NAMES,
  MIGRATION_JOB_OPTIONS,
  MIN_JOB_DATA_VERSION,
  buildConvergeJob,
  buildConvergeJobTemplate,
  buildMigrationJob,
  buildSyncJobTemplate,
  TICK_RETENTION,
  convergeDedupId,
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
    assert.deepStrictEqual(
      { ...JOB_NAMES },
      { UP: 'up', DOWN: 'down', SYNC: 'sync', CONVERGE: 'converge' },
    );
    assert.strictEqual(JOB_DATA_VERSION, 1);
  });

  it('should use names BullMQ accepts (no colon)', () => {
    assert.ok(!DEFAULT_QUEUE_NAME.includes(':'));
    assert.ok(!DEFAULT_SCHEDULER_ID.includes(':'));
    assert.ok(!DEFAULT_CONVERGE_SCHEDULER_ID.includes(':'));
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

  it('should never give two migrations one dedup id', () => {
    // A lossy mapping would let the second file's job be absorbed as a
    // duplicate of the first's — in the same enqueue call.
    const names = [
      '0001-add users.js',
      '0001-add_users.js',
      '0001-add~20users.js',
      '0002-café.js',
      '0002-cafè.js',
      '0003-міграція.js',
      '0003-a:b.js',
    ];
    const ids = new Set(names.map((name) => dedupId('up', name)));
    assert.strictEqual(ids.size, names.length);
    assert.strictEqual(dedupId('up', '0003-a:b.js'), 'up-0003-a~3Ab.js');
    for (const id of ids) assert.match(id, /^[A-Za-z0-9._~-]+$/);
  });

  it('should keep a forced re-run apart from a plain job for the same file', () => {
    assert.notStrictEqual(dedupId('up', 'a.js', { force: true }), dedupId('up', 'a.js'));
    assert.strictEqual(dedupId('up', 'a.js', { force: true }), 'up~force-a.js');
    // No file name can produce the forced id.
    assert.notStrictEqual(dedupId('up', '~force-a.js'), 'up~force-a.js');
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
        ordered: true,
      },
    });
  });

  it('should carry force only when set, and always say whether the job is ordered', () => {
    const base = { direction: 'up', migration: 'a.js', groupId: 'g', index: 0, total: 1, batch: 1 };
    assert.strictEqual(buildMigrationJob({ ...base, force: true }).data.force, true);
    assert.strictEqual(buildMigrationJob({ ...base, force: false }).data.force, undefined);
    assert.strictEqual(buildMigrationJob({ ...base, ordered: false }).data.ordered, false);
    // Written even at its default: the job, not the worker's setting, decides.
    assert.strictEqual(buildMigrationJob({ ...base, ordered: true }).data.ordered, true);
    assert.strictEqual(buildMigrationJob(base).data.ordered, true);
    const checksum = 'a'.repeat(64);
    assert.strictEqual(buildMigrationJob({ ...base, checksum }).data.checksum, checksum);
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
      opts: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: 1,
        telemetry: { omitContext: true },
      },
    });
    assert.strictEqual(buildSyncJobTemplate({ to: '0005-x.js' }).data.to, '0005-x.js');
  });

  it("should give scheduled ticks the caller's job options, and a bounded retention", () => {
    // A schedule mints a job per tick forever: without a retention they pile
    // up in Redis, so one is set whenever the caller has none.
    assert.deepStrictEqual(TICK_RETENTION, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });
    const opts = buildSyncJobTemplate({
      jobOptions: { removeOnComplete: true, keepLogs: 10, telemetry: { metadata: 'x' } },
    }).opts;
    assert.deepStrictEqual(opts, {
      removeOnComplete: true,
      removeOnFail: { count: 500 },
      keepLogs: 10,
      attempts: 1,
      telemetry: { metadata: 'x', omitContext: true },
    });
    assert.strictEqual(
      buildConvergeJobTemplate({ jobOptions: { removeOnFail: 5 } }).opts.removeOnFail,
      5,
    );
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

  it('should refuse a field outside the contract rather than ignore what it means', () => {
    assert.throws(
      () => parseJobData(job('up', upData({ noLock: true }))),
      (error) =>
        error instanceof QueueJobInvalidError && /unknown field "noLock"/.test(error.message),
    );
    assert.throws(() => parseJobData(job('sync', { v: 1, kind: 'sync', force: true })), /force/);
    for (const kind of ['migration', 'sync', 'converge']) assert.ok(JOB_FIELDS[kind].has('v'));
  });

  it('should accept a plan-time checksum, and only a SHA-256 hex digest', () => {
    const checksum = 'f'.repeat(64);
    assert.strictEqual(parseJobData(job('up', upData({ checksum }))).checksum, checksum);
    for (const bad of ['F'.repeat(64), 'f'.repeat(63), 64, '../x']) {
      assert.throws(() => parseJobData(job('up', upData({ checksum: bad }))), /checksum/);
    }
  });

  it('should accept every version from the oldest supported up to its own', () => {
    assert.strictEqual(MIN_JOB_DATA_VERSION, 1);
    assert.ok(MIN_JOB_DATA_VERSION <= JOB_DATA_VERSION);
    assert.strictEqual(
      parseJobData(job('up', upData({ v: MIN_JOB_DATA_VERSION }))).kind,
      'migration',
    );
    assert.throws(() => parseJobData(job('up', upData({ v: 0 }))), /unsupported/);
    assert.throws(() => parseJobData(job('up', upData({ v: 1.5 }))), /unsupported/);
  });

  // Payloads exactly as a 2.1.0 producer writes them. Every later worker must
  // keep accepting them for as long as MIN_JOB_DATA_VERSION is 1: jobs already
  // queued survive an upgrade of the workers.
  const GOLDEN_V1 = [
    [
      'up',
      {
        v: 1,
        direction: 'up',
        migration: '20260101000000-add-index.js',
        groupId: '0195f6a2-4c1b-7c3e-9a51-3b2d1e0f9a8b',
        index: 0,
        total: 2,
        batch: 7,
        ordered: true,
      },
    ],
    [
      'up',
      {
        v: 1,
        direction: 'up',
        migration: '20260101000000-add-index.js',
        groupId: 'g',
        index: 0,
        total: 1,
        batch: 8,
        force: true,
        ordered: false,
        checksum: 'c'.repeat(64),
      },
    ],
    [
      'down',
      {
        v: 1,
        direction: 'down',
        migration: 'a.js',
        groupId: 'g',
        index: 1,
        total: 2,
        batch: 7,
        ordered: true,
      },
    ],
    ['down', { v: 1, direction: 'down', migration: 'a.js', groupId: 'g', index: 0, total: 1 }],
    ['sync', { v: 1, kind: 'sync' }],
    ['sync', { v: 1, kind: 'sync', to: '0003-c.js' }],
    ['converge', { v: 1, kind: 'converge', groupId: 'g', ordered: true }],
    [
      'up',
      {
        v: 1,
        direction: 'up',
        migration: 'a.js',
        groupId: 'g',
        index: 0,
        total: 1,
        batch: 1,
        ordered: true,
        requestedBy: 'deploy-bot',
        reason: 'release 42',
      },
    ],
    ['converge', { v: 1, kind: 'converge', ordered: true, requestedBy: 'ops', reason: 'nightly' }],
    ['converge', { v: 1, kind: 'converge' }],
  ];
  for (const [name, data] of GOLDEN_V1) {
    it(`should keep accepting a v1 ${name} payload (${Object.keys(data).join(', ')})`, () => {
      assert.doesNotThrow(() => parseJobData(job(name, data)));
    });
  }

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
    ['a newer data version', () => job('up', upData({ v: 2 })), /newer than this worker/],
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
    ['an empty reason', () => job('up', upData({ reason: '' })), /reason/],
    [
      'an oversized requestedBy',
      () => job('up', upData({ requestedBy: 'x'.repeat(129) })),
      /requestedBy/,
    ],
    [
      'a requestedBy that is not a string',
      () => job('converge', { v: 1, kind: 'converge', requestedBy: 7 }),
      /requestedBy/,
    ],
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

describe('converge jobs', () => {
  it('should key the dedup id on the migration the converge follows', () => {
    assert.strictEqual(convergeDedupId(), 'converge');
    assert.strictEqual(convergeDedupId('0001-add users.js'), 'converge-after-0001-add~20users.js');
    assert.notStrictEqual(convergeDedupId('0001-a.js'), convergeDedupId('0002-b.js'));
  });

  it("should build a single-attempt job with the caller's passthrough options", () => {
    assert.deepStrictEqual(
      buildConvergeJob({ groupId: 'g', after: '0002-b.js', jobOptions: { removeOnComplete: 10 } }),
      {
        name: 'converge',
        data: { v: 1, kind: 'converge', groupId: 'g', ordered: true },
        opts: {
          removeOnComplete: 10,
          attempts: 1,
          deduplication: { id: 'converge-after-0002-b.js' },
        },
      },
    );
    assert.deepStrictEqual(buildConvergeJob({ ordered: false }).data, {
      v: 1,
      kind: 'converge',
      ordered: false,
    });
    // Written even at its default, like a migration job's.
    assert.strictEqual(buildConvergeJob({ ordered: true }).data.ordered, true);
  });

  it('should give a scheduled converge its own trace per tick', () => {
    assert.deepStrictEqual(buildConvergeJobTemplate(), {
      name: 'converge',
      data: { v: 1, kind: 'converge' },
      opts: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        attempts: 1,
        telemetry: { omitContext: true },
      },
    });
  });

  it('should parse a converge job, and refuse a prune it may never carry', () => {
    assert.deepStrictEqual(parseJobData(job('converge', { v: 1, kind: 'converge' })), {
      kind: 'converge',
    });
    assert.deepStrictEqual(
      parseJobData(job('converge', { v: 1, kind: 'converge', groupId: 'g', ordered: false })),
      { kind: 'converge', groupId: 'g', ordered: false },
    );
    assert.throws(
      () => parseJobData(job('converge', { v: 1, kind: 'converge', prune: true })),
      /prune is not accepted from a job/,
    );
  });

  it('should refuse a malformed converge job as untrusted input', () => {
    for (const data of [
      { v: 2, kind: 'converge' },
      { v: 1, kind: 'converge', groupId: '' },
      { v: 1, kind: 'converge', groupId: 'x'.repeat(129) },
      { v: 1, kind: 'converge', ordered: 'yes' },
    ]) {
      assert.throws(() => parseJobData(job('converge', data)), QueueJobInvalidError);
    }
  });
});
