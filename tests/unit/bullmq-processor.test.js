const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { describe, it, mock } = require('node:test');
const {
  RETRYABLE_CODES,
  createMigrationProcessor,
  isRetryableError,
  isTransientForJob,
  jobRefOf,
  ownLine,
  userlandRow,
} = require('../../src/bullmq/processor.js');
const { MigratorKit } = require('../../src/core/migrator.js');
const {
  ChecksumMismatchError,
  ConfigInvalidError,
  ConnectionFailedError,
  LockAlreadyHeldError,
  MigrationBlockedError,
  MigrationExecutionFailedError,
  NotAppliedError,
  QueueJobInvalidError,
  RunAbortedError,
} = require('../../src/errors/index.js');
const { stubKit } = require('../helpers/stub-kit.js');

function fakeJob(name, data, { attempts } = {}) {
  const job = {
    id: '11',
    name,
    data: { v: 1, ...data },
    opts: attempts !== undefined ? { attempts } : {},
    logs: [],
    progressUpdates: [],
    log: mock.fn(async (row) => job.logs.push(row)),
    updateProgress: mock.fn(async (progress) => job.progressUpdates.push(progress)),
  };
  return job;
}

const upJob = (overrides = {}, jobOptions) =>
  fakeJob(
    'up',
    {
      direction: 'up',
      migration: '0001-a.js',
      groupId: 'g',
      index: 0,
      total: 1,
      batch: 4,
      ...overrides,
    },
    jobOptions,
  );
const downJob = (overrides = {}) =>
  fakeJob('down', {
    direction: 'down',
    migration: '0001-a.js',
    groupId: 'g',
    index: 0,
    total: 1,
    ...overrides,
  });

const fastWait = { lockPollIntervalMs: 2, lockWaitTimeoutMs: 1000 };

describe('createMigrationProcessor', () => {
  it('should declare exactly three parameters, so BullMQ passes the cancellation signal', () => {
    const processor = createMigrationProcessor({ kit: stubKit() });
    assert.strictEqual(processor.length, 3);
  });

  it('should expose the kit, shutdown and close', () => {
    const kit = stubKit();
    const processor = createMigrationProcessor({ kit });
    assert.strictEqual(processor.kit, kit);
    assert.strictEqual(typeof processor.shutdown, 'function');
    assert.strictEqual(typeof processor.close, 'function');
  });

  it('should build its own kit from config', () => {
    const processor = createMigrationProcessor({
      config: { uri: 'mongodb://127.0.0.1:1/never', dbName: 'never', logger: null },
    });
    assert.ok(processor.kit instanceof MigratorKit);
  });

  describe('option validation', () => {
    const invalid = [
      ['options that are not an object', 'nope'],
      ['both kit and config', { kit: stubKit(), config: {} }],
      ['a kit that is not a kit', { kit: {} }],
      ['a non-boolean ordered', { kit: stubKit(), ordered: 'yes' }],
      ['a lockWait that is not an object', { kit: stubKit(), lockWait: 5 }],
      ['an unknown onLockHeld', { kit: stubKit(), lockWait: { onLockHeld: 'retry' } }],
      ['a NaN wait budget', { kit: stubKit(), lockWait: { lockWaitTimeoutMs: Number.NaN } }],
      ['a zero poll interval', { kit: stubKit(), lockWait: { lockPollIntervalMs: 0 } }],
      ['job options that reorder jobs', { kit: stubKit(), jobOptions: { priority: 1 } }],
    ];
    for (const [label, options] of invalid) {
      it(`should reject ${label}`, () => {
        assert.throws(() => createMigrationProcessor(options), ConfigInvalidError);
      });
    }
  });

  describe('up and down jobs', () => {
    it('should apply one migration under the group batch, guarded, and report it', async () => {
      const kit = stubKit();
      const processor = createMigrationProcessor({ kit });
      const result = await processor(upJob());
      // The job's ids travel with the run: its lines and migration:log name the job.
      assert.deepStrictEqual(kit.up.mock.calls[0].arguments, [
        '0001-a.js',
        { batch: 4, ordered: true, job: { id: '11', groupId: 'g' } },
      ]);
      assert.deepStrictEqual(result, {
        migration: '0001-a.js',
        direction: 'up',
        status: 'applied',
        duration: 5,
        batch: 4,
        runId: 'run-1',
        lockWaitMs: 0,
      });
      assert.strictEqual(kit.connect.mock.callCount(), 1);
    });

    it('should pass force through and drop the guard when the job opts out — if allowed', async () => {
      const kit = stubKit();
      const processor = createMigrationProcessor({ kit, allow: { force: true, unordered: true } });
      await processor(upJob({ force: true, ordered: false }));
      assert.deepStrictEqual(kit.up.mock.calls[0].arguments[1], {
        batch: 4,
        force: true,
        job: { id: '11', groupId: 'g' },
      });
    });

    it('should refuse what a payload may not ask for by default — force, ordered: false', async () => {
      const kit = stubKit();
      const processor = createMigrationProcessor({ kit });
      for (const [data, permission] of [
        [{ force: true }, 'force'],
        [{ ordered: false }, 'unordered'],
      ]) {
        const job = upJob(data);
        await assert.rejects(processor(job), (error) => {
          assert.ok(error instanceof QueueJobInvalidError);
          assert.strictEqual(error.context.permission, permission);
          assert.match(error.message, new RegExp(`allow\\.${permission}`));
          return true;
        });
      }
      assert.strictEqual(kit.up.mock.callCount(), 0);
      assert.strictEqual(kit.connect.mock.callCount(), 0, 'refused before connecting');
    });

    it('should let a worker refuse rollbacks altogether', async () => {
      const kit = stubKit();
      await assert.rejects(
        createMigrationProcessor({ kit, allow: { down: false } })(downJob()),
        (error) => error instanceof QueueJobInvalidError && error.context.permission === 'down',
      );
      assert.strictEqual(kit.down.mock.callCount(), 0);
    });

    it('should validate allow', () => {
      for (const allow of ['all', { sudo: true }, { force: 'yes' }]) {
        assert.throws(
          () => createMigrationProcessor({ kit: stubKit(), allow }),
          ConfigInvalidError,
        );
      }
    });

    it('should let the processor default the guard off for jobs that do not say', async () => {
      const kit = stubKit();
      const processor = createMigrationProcessor({ kit, ordered: false });
      await processor(upJob());
      await processor(upJob({ ordered: true }));
      assert.deepStrictEqual(kit.up.mock.calls[0].arguments[1], {
        batch: 4,
        job: { id: '11', groupId: 'g' },
      });
      assert.deepStrictEqual(kit.up.mock.calls[1].arguments[1], {
        batch: 4,
        ordered: true,
        job: { id: '11', groupId: 'g' },
      });
      await processor(downJob());
      assert.deepStrictEqual(kit.down.mock.calls[0].arguments[1], {
        job: { id: '11', groupId: 'g' },
      });
    });

    it('should revert one migration, guarded', async () => {
      const kit = stubKit();
      const processor = createMigrationProcessor({ kit });
      const result = await processor(downJob());
      assert.deepStrictEqual(kit.down.mock.calls[0].arguments, [
        '0001-a.js',
        { ordered: true, job: { id: '11', groupId: 'g' } },
      ]);
      assert.strictEqual(result.status, 'reverted');
      assert.strictEqual(result.direction, 'down');
    });

    it('should report a duplicate rollback as skipped, not as a failure', async () => {
      const kit = stubKit({
        down: mock.fn(async () => {
          throw new NotAppliedError('Migration is not applied');
        }),
      });
      const processor = createMigrationProcessor({ kit });
      assert.deepStrictEqual(await processor(downJob()), {
        migration: '0001-a.js',
        direction: 'down',
        status: 'skipped',
        reason: 'Not applied',
        lockWaitMs: 0,
      });
    });

    it('should pass on a skipped row with its reason', async () => {
      const kit = stubKit({
        up: mock.fn(async (name) => [{ file: name, status: 'skipped', reason: 'Already applied' }]),
      });
      const result = await createMigrationProcessor({ kit })(upJob());
      assert.strictEqual(result.status, 'skipped');
      assert.strictEqual(result.reason, 'Already applied');
      assert.ok(!Object.hasOwn(result, 'duration'));
    });

    it('should treat an empty result as skipped', async () => {
      const kit = stubKit({ up: mock.fn(async () => []) });
      const result = await createMigrationProcessor({ kit })(upJob());
      assert.strictEqual(result.status, 'skipped');
    });

    it('should forward the run to the job as log rows and progress', async () => {
      const kit = stubKit();
      const job = upJob();
      await createMigrationProcessor({ kit })(job);
      assert.ok(job.logs.some((row) => /Lock acquired/.test(row)));
      assert.ok(job.logs.some((row) => /▶ up 0001-a\.js/.test(row)));
      assert.ok(job.logs.some((row) => /Applied 0001-a\.js/.test(row)));
      const phases = job.progressUpdates.map((update) => update.phase);
      assert.deepStrictEqual(phases, ['running', 'completed']);
      assert.deepStrictEqual(job.progressUpdates[0], {
        phase: 'running',
        migration: '0001-a.js',
        direction: 'up',
        groupId: 'g',
        index: 0,
        total: 1,
      });
    });

    it('should forward skipped, lock-lost and reverted events too', async () => {
      const kit = stubKit({
        down: mock.fn(async (name) => {
          kit.emit('lock:acquired', { skipped: true });
          kit.emit('lock:lost', { reason: 'reclaimed' });
          kit.emit('lock:lost', {});
          kit.emit('migration:skipped', { migration: name, reason: 'already-applied' });
          kit.emit('migration:skipped', { migration: name });
          kit.emit('migration:success', { migration: name, direction: 'down' });
          return [{ file: name, status: 'reverted' }];
        }),
      });
      const job = downJob();
      await createMigrationProcessor({ kit })(job);
      assert.ok(!job.logs.some((row) => /Lock acquired/.test(row)), 'a skipped lock is not logged');
      assert.ok(job.logs.some((row) => /Lock lost: reclaimed/.test(row)));
      assert.ok(job.logs.some((row) => /Lock lost: unknown reason/.test(row)));
      assert.ok(job.logs.some((row) => /Skipped 0001-a\.js \(already-applied\)/.test(row)));
      assert.ok(job.logs.some((row) => /Reverted 0001-a\.js \[0ms\]/.test(row)));
    });

    it('should ignore kit events that arrive with no job in flight', () => {
      const kit = stubKit();
      createMigrationProcessor({ kit });
      for (const event of ['run:start', 'lock:acquired', 'lock:lost']) kit.emit(event, {});
      for (const event of ['migration:start', 'migration:success', 'migration:skipped']) {
        kit.emit(event, { migration: 'x.js', direction: 'up' });
      }
    });

    it('should never let a failing job write fail the migration', async () => {
      const kit = stubKit();
      const job = upJob();
      job.log = mock.fn(async () => {
        throw new Error('redis down');
      });
      job.updateProgress = () => {
        throw new Error('redis down, synchronously');
      };
      const result = await createMigrationProcessor({ kit })(job);
      assert.strictEqual(result.status, 'applied');
    });

    it('should cope with a job that cannot log or report progress at all', async () => {
      const kit = stubKit();
      const job = upJob();
      delete job.log;
      delete job.updateProgress;
      assert.strictEqual((await createMigrationProcessor({ kit })(job)).status, 'applied');
    });

    it('should run jobs one at a time even when called concurrently', async () => {
      let active = 0;
      let peak = 0;
      const kit = stubKit({
        up: mock.fn(async (name) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return [{ file: name, status: 'applied' }];
        }),
      });
      const processor = createMigrationProcessor({ kit });
      await Promise.all([processor(upJob()), processor(upJob()), processor(upJob())]);
      assert.strictEqual(peak, 1);
      assert.strictEqual(kit.up.mock.callCount(), 3);
    });

    it('should run each job in the async context it was called from', async () => {
      // BullMQ calls the processor inside the consumer span's context, and the
      // kit's spans take their parent from whatever is active. Jobs queue up on
      // one promise chain here — a job that ran in the context of the job
      // ahead of it would hang its migration under the wrong trace.
      const store = new AsyncLocalStorage();
      const seen = [];
      const kit = stubKit({
        up: mock.fn(async (name) => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          seen.push([name, store.getStore()]);
          return [{ file: name, status: 'applied' }];
        }),
      });
      const processor = createMigrationProcessor({ kit });
      await Promise.all([
        store.run('trace-a', () => processor(upJob({ migration: '0001-a.js' }))),
        store.run('trace-b', () => processor(upJob({ migration: '0002-b.js' }))),
        store.run('trace-c', () => processor(upJob({ migration: '0003-c.js' }))),
      ]);
      assert.deepStrictEqual(seen, [
        ['0001-a.js', 'trace-a'],
        ['0002-b.js', 'trace-b'],
        ['0003-c.js', 'trace-c'],
      ]);
    });

    it('should keep serving jobs after one fails', async () => {
      let calls = 0;
      const kit = stubKit({
        up: mock.fn(async (name) => {
          calls += 1;
          if (calls === 1) throw new Error('first one breaks');
          return [{ file: name, status: 'applied' }];
        }),
      });
      const processor = createMigrationProcessor({ kit });
      await assert.rejects(processor(upJob()), /first one breaks/);
      assert.strictEqual((await processor(upJob())).status, 'applied');
    });
  });

  describe('untrusted payloads', () => {
    it('should reject an invalid job before touching the kit', async () => {
      const kit = stubKit();
      const processor = createMigrationProcessor({ kit });
      const job = upJob({ migration: '../../etc/passwd' });
      await assert.rejects(processor(job), QueueJobInvalidError);
      assert.strictEqual(kit.connect.mock.callCount(), 0);
      assert.strictEqual(kit.up.mock.callCount(), 0);
      assert.ok(job.logs.some((row) => /Invalid migration job/.test(row)));
    });

    it('should refuse keys outside the contract before the kit is touched', async () => {
      const kit = stubKit();
      await assert.rejects(
        createMigrationProcessor({ kit })(upJob({ noLock: true, to: 'x' })),
        QueueJobInvalidError,
      );
      assert.strictEqual(kit.up.mock.callCount(), 0);
      await createMigrationProcessor({ kit })(upJob());
      assert.deepStrictEqual(Object.keys(kit.up.mock.calls[0].arguments[1]), [
        'batch',
        'ordered',
        'job',
      ]);
    });
  });

  describe('lock contention', () => {
    const heldOnce = () => {
      let calls = 0;
      return mock.fn(async (name) => {
        calls += 1;
        if (calls === 1) {
          throw new LockAlreadyHeldError('held', { holder: { lockedAt: new Date(0) } });
        }
        return [{ file: name, status: 'applied' }];
      });
    };

    it('should wait for the lock by default, and say so on the job', async () => {
      const kit = stubKit({ up: heldOnce() });
      const job = upJob();
      const result = await createMigrationProcessor({ kit, lockWait: fastWait })(job);
      assert.strictEqual(result.status, 'applied');
      assert.ok(result.lockWaitMs > 0);
      assert.strictEqual(kit.up.mock.callCount(), 2);
      assert.ok(job.logs.some((row) => /waiting/.test(row)));
      assert.ok(job.progressUpdates.some((update) => update.phase === 'lock-wait'));
    });

    it('should report a long wait every few seconds, not on every poll', async () => {
      let calls = 0;
      const kit = stubKit({
        up: mock.fn(async (name) => {
          calls += 1;
          if (calls <= 6) {
            throw new LockAlreadyHeldError('held', { holder: { lockedAt: new Date(0) } });
          }
          return [{ file: name, status: 'applied' }];
        }),
      });
      const job = upJob();
      await createMigrationProcessor({ kit, lockWait: fastWait })(job);
      const waits = job.progressUpdates.filter((update) => update.phase === 'lock-wait');
      assert.strictEqual(waits.length, 1, `6 polls in well under 2s: ${waits.length} updates`);
    });

    it("should fail at once under onLockHeld: 'throw', leaving the error retryable", async () => {
      const kit = stubKit({ up: heldOnce() });
      const job = upJob({}, { attempts: 3 });
      await assert.rejects(
        createMigrationProcessor({ kit, lockWait: { onLockHeld: 'throw' } })(job),
        (error) => {
          assert.ok(error instanceof LockAlreadyHeldError);
          assert.strictEqual(error.name, 'LockAlreadyHeldError');
          return true;
        },
      );
      assert.strictEqual(kit.up.mock.callCount(), 1);
    });
  });

  describe('what the queue stores', () => {
    it("should keep a duplicate key's values out of the message, stack and job log", async () => {
      const kit = stubKit({
        up: mock.fn(async () => {
          throw new MigrationExecutionFailedError('Migration up failed: 0001-a.js', {
            cause: 'E11000 duplicate key error index: email_1 dup key: { email: "a@b.c" }',
          });
        }),
      });
      const job = upJob();
      await assert.rejects(createMigrationProcessor({ kit })(job), (error) => {
        assert.ok(!error.message.includes('a@b.c'), error.message);
        assert.ok(!error.stack.includes('a@b.c'));
        assert.match(error.message, /dup key: \{ <redacted> \}/);
        return true;
      });
      assert.ok(!job.logs.join('\n').includes('a@b.c'), job.logs.join(' | '));
    });
  });

  describe('blocked jobs', () => {
    const blockedOnce = (failed) => {
      let calls = 0;
      return mock.fn(async (name) => {
        calls += 1;
        if (calls === 1) {
          throw new MigrationBlockedError('blocked', { blockedBy: ['0000-z.js'], failed });
        }
        return [{ file: name, status: 'applied' }];
      });
    };

    it('should wait out a block by migrations that have not failed — they may be in flight', async () => {
      const kit = stubKit({ up: blockedOnce([]) });
      const job = upJob();
      const result = await createMigrationProcessor({ kit, lockWait: fastWait })(job);
      assert.strictEqual(result.status, 'applied');
      assert.strictEqual(kit.up.mock.callCount(), 2);
      assert.ok(
        job.logs.some((row) => /not applied yet — waiting/.test(row)),
        job.logs.join(' | '),
      );
    });

    it('should fail at once on a block by a migration that failed', async () => {
      const kit = stubKit({ up: blockedOnce(['0000-z.js']) });
      await assert.rejects(
        createMigrationProcessor({ kit, lockWait: fastWait })(upJob()),
        MigrationBlockedError,
      );
      assert.strictEqual(kit.up.mock.callCount(), 1);
    });

    it('should tell the transient cases apart', () => {
      assert.ok(isTransientForJob(new LockAlreadyHeldError('held')));
      assert.ok(isTransientForJob(new MigrationBlockedError('b', { failed: [] })));
      assert.ok(!isTransientForJob(new MigrationBlockedError('b', { failed: ['x'] })));
      // A block from a hand-made kit without the field is never waited on.
      assert.ok(!isTransientForJob(new MigrationBlockedError('b', { blockedBy: ['x'] })));
      assert.ok(!isTransientForJob(new Error('other')));
    });
  });

  describe('failures', () => {
    const failingWith = (error) =>
      stubKit({
        up: mock.fn(async () => {
          throw error;
        }),
      });

    it('should throw the original typed error', async () => {
      const original = new MigrationBlockedError('0002-b.js is blocked', {
        blockedBy: ['0001-a.js'],
      });
      const job = upJob();
      await assert.rejects(
        createMigrationProcessor({ kit: failingWith(original) })(job),
        (error) => {
          assert.strictEqual(error, original);
          assert.strictEqual(error.code, 'MIGRATION_BLOCKED');
          // The adapter's own jobs have a single attempt — nothing to prevent,
          // so the class name is left exactly as it was.
          assert.strictEqual(error.name, 'MigrationBlockedError');
          return true;
        },
      );
      assert.deepStrictEqual(job.progressUpdates.at(-1), {
        phase: 'failed',
        migration: '0001-a.js',
        direction: 'up',
        groupId: 'g',
        index: 0,
        total: 1,
        code: 'MIGRATION_BLOCKED',
      });
      assert.ok(job.logs.some((row) => /✖ 0002-b\.js is blocked/.test(row)));
    });

    const nonRetryable = [
      new MigrationBlockedError('blocked'),
      new ChecksumMismatchError('drift'),
      new MigrationExecutionFailedError('failed'),
      new QueueJobInvalidError('bad'),
      new ConfigInvalidError('bad'),
    ];
    for (const error of nonRetryable) {
      it(`should mark ${error.code} unrecoverable when the job would otherwise be retried`, async () => {
        const job = upJob({}, { attempts: 3 });
        await assert.rejects(
          createMigrationProcessor({ kit: failingWith(error) })(job),
          (thrown) => {
            assert.strictEqual(thrown, error);
            assert.strictEqual(thrown.name, 'UnrecoverableError');
            assert.ok(thrown.message.length > 0, 'BullMQ needs a message on it');
            return true;
          },
        );
      });
    }

    const retryable = [
      new LockAlreadyHeldError('held'),
      new ConnectionFailedError('down'),
      new RunAbortedError('stopped'),
      new Error('something unexpected'),
    ];
    for (const error of retryable) {
      it(`should leave ${error.code ?? 'an unknown error'} retryable`, async () => {
        const job = upJob({}, { attempts: 3 });
        const expectedName = error.name;
        await assert.rejects(
          createMigrationProcessor({ kit: failingWith(error), lockWait: { onLockHeld: 'throw' } })(
            job,
          ),
          (thrown) => thrown === error && thrown.name === expectedName,
        );
      });
    }

    it('should fold the cause into the message — it is all a dashboard shows', async () => {
      const error = new MigrationExecutionFailedError('Migration up failed: 0001-a.js', {
        cause: 'E11000 duplicate key',
      });
      const job = upJob();
      await assert.rejects(createMigrationProcessor({ kit: failingWith(error) })(job), (thrown) => {
        assert.strictEqual(thrown.message, 'Migration up failed: 0001-a.js — E11000 duplicate key');
        return true;
      });
      assert.ok(
        job.logs.some((row) => row === '✖ Migration up failed: 0001-a.js — E11000 duplicate key'),
      );
    });

    it('should redact credentials from everything BullMQ stores', async () => {
      const error = new MigrationExecutionFailedError(
        'Failed against mongodb://admin:hunter2@db.internal/app',
        { cause: 'connect mongodb://admin:hunter2@db.internal/app refused' },
      );
      const job = upJob();
      await assert.rejects(createMigrationProcessor({ kit: failingWith(error) })(job), (thrown) => {
        assert.ok(!thrown.message.includes('hunter2'));
        assert.ok(!thrown.stack.includes('hunter2'));
        assert.match(thrown.message, /admin:\*\*\*\*@/);
        return true;
      });
      assert.ok(job.logs.every((row) => !row.includes('hunter2')));
    });

    it('should not repeat a cause the message already carries', async () => {
      const error = new MigrationExecutionFailedError('boom: disk full', { cause: 'disk full' });
      await assert.rejects(
        createMigrationProcessor({ kit: failingWith(error) })(upJob()),
        (thrown) => thrown.message === 'boom: disk full',
      );
    });

    it('should survive an error that cannot be rewritten', async () => {
      const error = Object.freeze(new MigrationBlockedError('blocked'));
      await assert.rejects(
        createMigrationProcessor({ kit: failingWith(error) })(upJob()),
        (thrown) => thrown === error,
      );
    });

    it('should pass a thrown non-error through untouched', async () => {
      const kit = stubKit({
        up: mock.fn(async () => {
          // eslint-disable-next-line no-throw-literal -- intentionally a thrown non-Error
          throw 'a bare string';
        }),
      });
      const job = upJob({}, { attempts: 3 });
      await assert.rejects(
        createMigrationProcessor({ kit })(job),
        (thrown) => thrown === 'a bare string',
      );
      assert.strictEqual(job.progressUpdates.at(-1).code, 'UNKNOWN');
    });

    it('should surface a failed connect as a retryable failure', async () => {
      const kit = stubKit({
        connect: mock.fn(async () => {
          throw new ConnectionFailedError('Failed to connect to MongoDB');
        }),
      });
      await assert.rejects(
        createMigrationProcessor({ kit })(upJob({}, { attempts: 2 })),
        (error) => {
          assert.strictEqual(error.name, 'ConnectionFailedError');
          return true;
        },
      );
      assert.strictEqual(kit.up.mock.callCount(), 0);
    });
  });

  describe('correlation', () => {
    it("should stamp a failed job's ids on its error, progress and log", async () => {
      const kit = stubKit({
        up: mock.fn(async () => {
          kit.emit('run:start', { runId: 'run-3', command: 'up' });
          throw new MigrationBlockedError('blocked', { blockedBy: ['0000-z.js'] });
        }),
      });
      const job = upJob();
      await assert.rejects(createMigrationProcessor({ kit })(job), (error) => {
        assert.strictEqual(error.context.runId, 'run-3');
        assert.strictEqual(error.context.jobId, '11');
        assert.strictEqual(error.context.groupId, 'g');
        assert.deepStrictEqual(error.context.blockedBy, ['0000-z.js']);
        return true;
      });
      assert.deepStrictEqual(job.progressUpdates.at(-1).runId, 'run-3');
      assert.strictEqual(job.progressUpdates.at(-1).code, 'MIGRATION_BLOCKED');
      assert.match(job.logs.at(-1), /\[run run-3\]$/);
    });

    it("should report 'UNKNOWN' for a code that is not migronaut's", async () => {
      const kit = stubKit({
        up: mock.fn(async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }),
      });
      const job = upJob();
      await assert.rejects(createMigrationProcessor({ kit })(job), /EACCES/);
      assert.strictEqual(job.progressUpdates.at(-1).code, 'UNKNOWN');
    });
  });

  describe('cancellation and shutdown', () => {
    it("should stop the kit's run when the job's signal aborts mid-run", async () => {
      const controller = new AbortController();
      let release;
      const kit = stubKit({
        up: mock.fn(
          (name) =>
            new Promise((resolve) => {
              release = () => resolve([{ file: name, status: 'applied' }]);
            }),
        ),
      });
      const pending = createMigrationProcessor({ kit })(upJob(), 'token', controller.signal);
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort('cancelled by operator');
      assert.strictEqual(kit.stop.mock.callCount(), 1);
      release();
      // The migration body was already running: it finishes and the job completes.
      assert.strictEqual((await pending).status, 'applied');
    });

    it('should not start a migration for a job that was cancelled before it began', async () => {
      const kit = stubKit();
      await assert.rejects(
        createMigrationProcessor({ kit })(upJob(), 'token', AbortSignal.abort('too late')),
        RunAbortedError,
      );
      assert.strictEqual(kit.up.mock.callCount(), 0);
    });

    it('should stop listening to a signal once its job is done', async () => {
      const controller = new AbortController();
      const kit = stubKit();
      await createMigrationProcessor({ kit })(upJob(), 'token', controller.signal);
      controller.abort();
      assert.strictEqual(kit.stop.mock.callCount(), 0);
    });

    it('should interrupt a lock wait on shutdown, failing the job as aborted', async () => {
      const kit = stubKit({
        up: mock.fn(async () => {
          throw new LockAlreadyHeldError('held', { holder: { lockedAt: new Date(0) } });
        }),
      });
      const processor = createMigrationProcessor({
        kit,
        lockWait: { lockPollIntervalMs: 5000, lockWaitTimeoutMs: 60_000 },
      });
      const pending = processor(upJob());
      await new Promise((resolve) => setTimeout(resolve, 10));
      processor.shutdown('deploying');
      await assert.rejects(pending, (error) => {
        assert.ok(error instanceof RunAbortedError);
        assert.strictEqual(error.context.reason, 'deploying');
        return true;
      });
    });

    it('should put a job a shutdown stopped before its migration back at the head of the queue', async () => {
      const kit = stubKit({
        up: mock.fn(async () => {
          throw new LockAlreadyHeldError('held', { holder: { lockedAt: new Date(0) } });
        }),
      });
      const processor = createMigrationProcessor({
        kit,
        lockWait: { lockPollIntervalMs: 5000, lockWaitTimeoutMs: 60_000 },
      });
      const job = upJob();
      job.moveToWait = mock.fn(async () => 0);
      const pending = processor(job, 'token-11');
      await new Promise((resolve) => setTimeout(resolve, 10));
      processor.shutdown('deploying');
      await assert.rejects(pending, (error) => {
        // The name is what BullMQ checks: neither failed nor completed.
        assert.strictEqual(error.name, 'WaitingError');
        assert.ok(error instanceof RunAbortedError);
        assert.strictEqual(error.context.requeued, true);
        assert.strictEqual(error.context.jobId, '11');
        return true;
      });
      assert.deepStrictEqual(job.moveToWait.mock.calls[0].arguments, ['token-11']);
      assert.ok(job.logs.includes('↩ Returned to the queue: deploying'), job.logs.join(' | '));
      assert.ok(!job.progressUpdates.some((update) => update.phase === 'failed'));
    });

    it('should fail as usual when the job cannot be moved back', async () => {
      const kit = stubKit();
      const processor = createMigrationProcessor({ kit });
      processor.shutdown('deploying');
      const job = upJob();
      job.moveToWait = mock.fn(async () => {
        throw new Error('Missing lock for job 11');
      });
      await assert.rejects(processor(job, 'token-11'), (error) => {
        assert.ok(error instanceof RunAbortedError);
        assert.notStrictEqual(error.name, 'WaitingError');
        return true;
      });
      // No token, no move: a processor driven outside a Worker fails the same way.
      const plain = upJob();
      plain.moveToWait = mock.fn(async () => 0);
      await assert.rejects(processor(plain), RunAbortedError);
      assert.strictEqual(plain.moveToWait.mock.callCount(), 0);
    });

    it('should never put back a job whose migration had already started', async () => {
      const kit = stubKit({
        up: mock.fn(async () => {
          kit.emit('migration:start', { migration: '0001-a.js', direction: 'up' });
          processor.shutdown('deploying');
          throw new RunAbortedError('Run stopped', { reason: 'deploying' });
        }),
      });
      // Called by the stub only once the job runs — after this line.
      const processor = createMigrationProcessor({ kit });
      const job = upJob();
      job.moveToWait = mock.fn(async () => 0);
      await assert.rejects(processor(job, 'token-11'), (error) => error.name !== 'WaitingError');
      assert.strictEqual(job.moveToWait.mock.callCount(), 0);
    });

    it('should refuse new jobs after shutdown, and shut down only once', async () => {
      const kit = stubKit();
      const processor = createMigrationProcessor({ kit });
      processor.shutdown();
      processor.shutdown('again');
      await assert.rejects(processor(upJob()), (error) => {
        assert.ok(error instanceof RunAbortedError);
        assert.match(error.message, /shutting down/);
        return true;
      });
      assert.strictEqual(kit.up.mock.callCount(), 0);
    });

    it('should detach from an injected kit on close without disconnecting it', async () => {
      const kit = stubKit();
      const processor = createMigrationProcessor({ kit });
      assert.ok(kit.listenerCount('migration:start') > 0);
      await processor.close();
      assert.strictEqual(kit.listenerCount('migration:start'), 0);
      assert.strictEqual(kit.listenerCount('run:start'), 0);
      assert.strictEqual(kit.disconnect.mock.callCount(), 0);
    });

    it('should disconnect a kit it created', async () => {
      const processor = createMigrationProcessor({
        config: { uri: 'mongodb://127.0.0.1:1/never', dbName: 'never', logger: null },
      });
      const disconnect = mock.method(processor.kit, 'disconnect', async () => {});
      await processor.close();
      assert.strictEqual(disconnect.mock.callCount(), 1);
    });

    it('should let the job in flight settle before close resolves', async () => {
      let finished = false;
      const kit = stubKit({
        up: mock.fn(async (name) => {
          await new Promise((resolve) => setTimeout(resolve, 15));
          finished = true;
          return [{ file: name, status: 'applied' }];
        }),
      });
      const processor = createMigrationProcessor({ kit });
      const pending = processor(upJob());
      await new Promise((resolve) => setImmediate(resolve));
      await processor.close();
      assert.strictEqual(finished, true);
      assert.strictEqual((await pending).status, 'applied');
    });
  });

  describe('converge jobs', () => {
    const convergeJob = (data = {}) => fakeJob('converge', { kind: 'converge', ...data });
    const converged = {
      dryRun: false,
      changed: 2,
      inSync: true,
      collections: [{ name: 'c', actions: [] }],
    };

    it('should converge under the lock, ordered by default, and return the result', async () => {
      const kit = stubKit({
        converge: mock.fn(async () => {
          kit.emit('run:start', { runId: 'run-9', command: 'converge' });
          kit.emit('converge:start', { trigger: 'converge', collections: 1 });
          kit.emit('converge:action', {
            collection: 'c',
            target: 'index',
            name: 'a_1',
            action: 'create',
            status: 'started',
          });
          kit.emit('converge:action', {
            collection: 'c',
            target: 'index',
            name: 'a_1',
            action: 'create',
            status: 'applied',
            durationMs: 4,
          });
          kit.emit('converge:action', {
            collection: 'c',
            target: 'validator',
            name: 'c',
            action: 'modify',
            status: 'failed',
          });
          kit.emit('converge:action', {
            collection: 'c',
            target: 'searchIndex',
            name: 'default',
            action: 'create',
            status: 'applied',
            durationMs: 2,
          });
          kit.emit('converge:wait', { status: 'started', searchIndexes: 1, lockReleased: true });
          kit.emit('converge:wait', { status: 'progress', searchIndexes: 1, waitedMs: 30_400 });
          kit.emit('converge:wait', { status: 'ready', searchIndexes: 1, waitedMs: 41_000 });
          kit.emit('converge:end', { success: true, changed: 2 });
          return {
            ...converged,
            unstable: [{ collection: 'c', target: 'index', name: 'a_1', action: 'modify' }],
            search: { available: true, notReady: [] },
          };
        }),
      });
      const job = convergeJob({ groupId: 'g-1' });
      const result = await createMigrationProcessor({ kit })(job);
      assert.deepStrictEqual(kit.converge.mock.calls[0].arguments, [{ ordered: true }]);
      assert.deepStrictEqual(result, {
        kind: 'converge',
        groupId: 'g-1',
        changed: 2,
        inSync: true,
        collections: [{ name: 'c', actions: [] }],
        unstable: [{ collection: 'c', target: 'index', name: 'a_1', action: 'modify' }],
        search: { available: true, notReady: [] },
        runId: 'run-9',
        lockWaitMs: 0,
      });
      assert.deepStrictEqual(job.progressUpdates.at(0), { phase: 'running', kind: 'converge' });
      assert.deepStrictEqual(job.progressUpdates.at(-1), {
        phase: 'completed',
        kind: 'converge',
        runId: 'run-9',
      });
      assert.ok(job.logs.includes('… create index a_1 on c'), job.logs.join(' | '));
      assert.ok(job.logs.includes('✔ create index a_1 on c [4ms]'), job.logs.join(' | '));
      assert.ok(job.logs.includes('✖ modify validator on c: failed'), job.logs.join(' | '));
      assert.ok(
        job.logs.includes(
          '… Waiting for 1 search index(es) to become queryable — the migration lock is released meanwhile',
        ),
        job.logs.join(' | '),
      );
      assert.ok(job.logs.includes('… Still waiting for search indexes [30s]'));
      assert.ok(job.logs.includes('✔ Search index(es) queryable [41000ms]'));
      assert.deepStrictEqual(
        job.progressUpdates.filter((update) => update.phase === 'search-wait'),
        [
          { phase: 'search-wait', kind: 'converge', searchIndexes: 1, waitedMs: 0 },
          { phase: 'search-wait', kind: 'converge', searchIndexes: 1, waitedMs: 30_400 },
        ],
      );
      assert.ok(
        job.logs.includes('✔ create search index default on c [2ms]'),
        job.logs.join(' | '),
      );
      assert.ok(job.logs.includes('✔ Converged 2 change(s)'));
    });

    it('should honour a job that opts out of the order guard, and the processor default', async () => {
      const kit = stubKit({ converge: mock.fn(async () => converged) });
      await assert.rejects(
        createMigrationProcessor({ kit })(convergeJob({ ordered: false })),
        QueueJobInvalidError,
      );
      await createMigrationProcessor({ kit, allow: { unordered: true } })(
        convergeJob({ ordered: false }),
      );
      assert.deepStrictEqual(kit.converge.mock.calls[0].arguments, [{}]);
      await createMigrationProcessor({ kit, ordered: false })(convergeJob());
      assert.deepStrictEqual(kit.converge.mock.calls[1].arguments, [{}]);
    });

    it('should fail a blocked converge without a retry', async () => {
      const kit = stubKit({
        converge: mock.fn(async () => {
          throw new MigrationBlockedError('converge is blocked: 1 migration(s) still pending', {});
        }),
      });
      const job = convergeJob();
      await assert.rejects(createMigrationProcessor({ kit })(job), MigrationBlockedError);
      assert.strictEqual(job.progressUpdates.at(-1).code, 'MIGRATION_BLOCKED');
    });

    it('should wait out a held lock', async () => {
      let calls = 0;
      const kit = stubKit({
        converge: mock.fn(async () => {
          calls += 1;
          if (calls === 1) throw new LockAlreadyHeldError('held', {});
          return converged;
        }),
        lockInfo: mock.fn(async () => null),
      });
      const job = convergeJob();
      const result = await createMigrationProcessor({ kit, lockWait: fastWait })(job);
      assert.strictEqual(result.inSync, true);
      assert.ok(job.progressUpdates.some((update) => update.phase === 'lock-wait'));
    });
  });

  describe('sync jobs', () => {
    const syncJob = (data = {}) => fakeJob('sync', { kind: 'sync', ...data });

    it('should need the queue it enqueues into', async () => {
      const kit = stubKit();
      await assert.rejects(createMigrationProcessor({ kit })(syncJob()), (error) => {
        assert.ok(error instanceof ConfigInvalidError);
        assert.match(error.message, /needs the queue/);
        return true;
      });
    });

    it('should do nothing when no migration is pending', async () => {
      const kit = stubKit({ dryRun: mock.fn(async () => []) });
      const queue = { addBulk: mock.fn(async () => []) };
      const job = syncJob();
      const result = await createMigrationProcessor({ kit, queue })(job);
      assert.deepStrictEqual(result, {
        kind: 'sync',
        groupId: null,
        batch: null,
        enqueued: 0,
        upToDate: true,
        migrations: [],
      });
      assert.strictEqual(kit.dryRun.mock.callCount(), 0, 'the cheap probe short-circuits planning');
      assert.strictEqual(queue.addBulk.mock.callCount(), 0);
      assert.deepStrictEqual(job.progressUpdates.at(-1), { phase: 'completed', kind: 'sync' });
    });

    it('should add a converge job from an idle tick, only when the database differs', async () => {
      const drift = { dryRun: true, changed: 1, inSync: false, collections: [] };
      const kit = stubKit({
        convergesAfterUp: mock.fn(async () => true),
        converge: mock.fn(async () => drift),
      });
      const queue = {
        addBulk: mock.fn(async (specs) => specs.map((spec, index) => ({ id: String(index + 1) }))),
      };
      const result = await createMigrationProcessor({ kit, queue })(syncJob());
      assert.deepStrictEqual(result.converge, { jobId: '1', deduplicated: false });
      assert.strictEqual(queue.addBulk.mock.calls[0].arguments[0][0].name, 'converge');

      drift.inSync = true;
      const quiet = await createMigrationProcessor({ kit, queue })(syncJob());
      assert.ok(!('converge' in quiet));
      // A tick limited by `to` stops short of the head: no converge.
      drift.inSync = false;
      const limited = await createMigrationProcessor({ kit, queue })(syncJob({ to: '0001-a.js' }));
      assert.ok(!('converge' in limited));
      assert.strictEqual(queue.addBulk.mock.callCount(), 1);
    });

    it('should report the converge job ending the group it enqueued', async () => {
      const pending = [{ file: '0001-a.js', status: 'pending' }];
      const kit = stubKit({
        list: mock.fn(async () => pending),
        dryRun: mock.fn(async () => pending),
        convergesAfterUp: mock.fn(async () => true),
      });
      const queue = {
        addBulk: mock.fn(async (specs) => specs.map((spec, index) => ({ id: String(index + 1) }))),
      };
      const result = await createMigrationProcessor({ kit, queue })(syncJob());
      assert.strictEqual(result.enqueued, 1);
      assert.deepStrictEqual(result.converge, { jobId: '2', deduplicated: false });
    });

    it('should enqueue what is pending as one group', async () => {
      const pending = [
        { file: '0001-a.js', status: 'pending' },
        { file: '0002-b.js', status: 'pending' },
      ];
      const kit = stubKit({
        list: mock.fn(async () => pending),
        dryRun: mock.fn(async () => pending),
        nextBatch: mock.fn(async () => 6),
      });
      const queue = {
        addBulk: mock.fn(async (specs) =>
          specs.map((spec, index) => ({ id: String(index + 1), ...spec })),
        ),
        getJob: mock.fn(async (id) => ({ id, data: { groupId: 'someone-else' } })),
      };
      const result = await createMigrationProcessor({
        kit,
        queue,
        jobOptions: { removeOnComplete: 50 },
      })(syncJob({ to: '0002-b.js' }));

      assert.strictEqual(result.kind, 'sync');
      assert.strictEqual(result.enqueued, 2);
      assert.strictEqual(result.batch, 6);
      assert.strictEqual(result.upToDate, false);
      assert.deepStrictEqual(result.migrations, ['0001-a.js', '0002-b.js']);
      assert.strictEqual(typeof result.groupId, 'string');
      assert.deepStrictEqual(kit.dryRun.mock.calls[0].arguments, [
        'up',
        undefined,
        { to: '0002-b.js' },
      ]);
      const [specs] = queue.addBulk.mock.calls[0].arguments;
      assert.strictEqual(specs[0].opts.removeOnComplete, 50);
      assert.strictEqual(specs[0].opts.attempts, 1);
    });

    it('should report up to date when planning finds nothing within the target', async () => {
      const kit = stubKit({
        list: mock.fn(async () => [{ file: '0009-z.js', status: 'pending' }]),
        dryRun: mock.fn(async () => []),
      });
      const queue = { addBulk: mock.fn(async () => []) };
      const result = await createMigrationProcessor({ kit, queue })(syncJob({ to: '0001-a.js' }));
      assert.strictEqual(result.upToDate, true);
      assert.strictEqual(result.groupId, null);
      assert.strictEqual(queue.addBulk.mock.callCount(), 0);
    });
  });
});

describe('isRetryableError', () => {
  it('should retry what a later attempt can get past', () => {
    for (const code of RETRYABLE_CODES) {
      assert.strictEqual(isRetryableError(Object.assign(new RunAbortedError('x'), { code })), true);
    }
    assert.ok(Object.isFrozen(RETRYABLE_CODES));
  });

  it('should not retry what needs a fix first', () => {
    assert.strictEqual(isRetryableError(new MigrationBlockedError('x')), false);
    assert.strictEqual(isRetryableError(new MigrationExecutionFailedError('x')), false);
  });

  it('should keep errors of unknown origin retryable', () => {
    assert.strictEqual(isRetryableError(new Error('x')), true);
    assert.strictEqual(isRetryableError('x'), true);
    assert.strictEqual(isRetryableError(undefined), true);
  });
});

describe('createMigrationProcessor background link', () => {
  const NAME = '0001-orders.js';
  function linked(overrides = {}, queueOverrides = {}) {
    const added = [];
    const queue = {
      addBulk: mock.fn(async (specs) => {
        added.push(...specs);
        return specs.map((_, index) => ({ id: `bg-${added.length + index}` }));
      }),
      ...queueOverrides,
    };
    const kit = stubKit({
      backgroundStatus: mock.fn(async (name) => ({ migration: name, status: 'pending' })),
      runnableBackground: mock.fn(async () => [
        { migration: NAME, status: 'pending', maxParallel: 1 },
      ]),
      ...overrides,
    });
    // What the kit emits when an up registers a background migration.
    const up = kit.up;
    kit.up = mock.fn(async (name, options) => {
      kit.emit('background:registered', { migration: name, status: 'pending' });
      return up(name, options);
    });
    return { kit, queue, added };
  }

  for (const [what, background, pattern] of [
    ['a non-object', 1, /background must be \{ queue \}/],
    ['no queue', {}, /background must be \{ queue \}/],
    ['an unknown key', { queue: { addBulk() {} }, sliceMs: 5 }, /background\.sliceMs/],
    ['a forbidden job option', { queue: { addBulk() {} }, jobOptions: { parent: {} } }, /parent/],
  ]) {
    it(`should refuse ${what}`, () => {
      assert.throws(
        () => createMigrationProcessor({ kit: stubKit(), background }),
        ConfigInvalidError,
      );
      assert.throws(() => createMigrationProcessor({ kit: stubKit(), background }), pattern);
    });
  }

  it('should enqueue the coordinator of what an up job registered', async () => {
    const { kit, queue, added } = linked();
    const processor = createMigrationProcessor({
      kit,
      background: { queue, jobOptions: { keepLogs: 2 }, stallMs: 5000 },
    });
    const job = upJob({ migration: NAME });
    const result = await processor(job, 'token');
    assert.deepStrictEqual(result.background, [{ migration: NAME, jobId: 'bg-1' }]);
    assert.strictEqual(added[0].name, 'background');
    assert.strictEqual(added[0].opts.keepLogs, 2);
    assert.ok(job.logs.some((row) => /Background coordinator bg-1 enqueued/.test(row)));
  });

  it('should still apply when the coordinator cannot be enqueued — the next heal will', async () => {
    const { kit, queue } = linked(
      {},
      {
        addBulk: mock.fn(async () => {
          throw new Error('redis down');
        }),
      },
    );
    const warnings = [];
    kit.logger = { ...kit.logger, warn: (message) => warnings.push(message) };
    const processor = createMigrationProcessor({ kit, background: { queue } });
    const result = await processor(upJob({ migration: NAME }), 'token');
    assert.strictEqual(result.status, 'applied');
    assert.deepStrictEqual(result.background, []);
    assert.match(warnings[0], /Could not enqueue background migration .*redis down/);
  });

  it('should heal on every sync tick, and report a line waiting for a background migration', async () => {
    let completed = false;
    const { kit, queue, added } = linked({
      list: mock.fn(async () => [{ file: '0002-contract.js', status: 'pending' }]),
      dryRun: mock.fn(async () => [
        { file: '0002-contract.js', status: 'pending', ...(completed ? {} : { waitsFor: [NAME] }) },
      ]),
      backgroundStatus: mock.fn(async () => ({
        migration: NAME,
        status: completed ? 'completed' : 'running',
        direction: 'forward',
      })),
    });
    const processor = createMigrationProcessor({
      kit,
      queue: { addBulk: mock.fn(async (specs) => specs.map((_, i) => ({ id: `j${i}` }))) },
      background: { queue },
    });
    const result = await processor(fakeJob('sync', { kind: 'sync' }), 'token');
    // Waiting is not a failure: `held` stays the circuit breaker's.
    assert.strictEqual(result.held, undefined);
    assert.deepStrictEqual(result.waiting, { migration: '0002-contract.js', waitsFor: [NAME] });
    assert.deepStrictEqual(result.background, { enqueued: 1 });
    assert.strictEqual(result.upToDate, false);
    assert.strictEqual(result.groupId, null);
    assert.strictEqual(added[0].data.migration, NAME);
    const plans = kit.dryRun.mock.callCount();
    // The next tick, still waiting: said again without planning.
    const again = await processor(fakeJob('sync', { kind: 'sync' }), 'token');
    assert.deepStrictEqual(again.waiting, { migration: '0002-contract.js', waitsFor: [NAME] });
    assert.strictEqual(kit.dryRun.mock.callCount(), plans, 'no plan while still waiting');
    // Once it completed, the tick plans — and the line goes on.
    completed = true;
    const resumed = await processor(fakeJob('sync', { kind: 'sync' }), 'token');
    assert.strictEqual(resumed.waiting, undefined);
    assert.ok(kit.dryRun.mock.callCount() > plans);
  });

  it('should count a heal that fails as nothing enqueued', async () => {
    const { kit, queue } = linked({
      runnableBackground: mock.fn(async () => {
        throw new Error('mongo blip');
      }),
    });
    const processor = createMigrationProcessor({
      kit,
      queue: { addBulk: mock.fn() },
      background: { queue },
    });
    const result = await processor(fakeJob('sync', { kind: 'sync' }), 'token');
    assert.deepStrictEqual(result.background, { enqueued: 0 });
    assert.strictEqual(result.upToDate, true);
  });
});

describe('userland lines in the job log', () => {
  /** A migration:log event as the kit makes it for job `jobId` */
  const userland = (jobId, extra = {}) => ({
    kind: 'migration',
    runId: 'run-1',
    direction: 'up',
    migration: '0001-a.js',
    attempt: 1,
    level: 'info',
    msg: 'batch done',
    data: { processed: 1000 },
    at: new Date(0),
    seq: 1,
    ...(jobId !== undefined ? { jobId } : {}),
    ...extra,
  });

  it("should write the job's own userland events into its log, and only those", async () => {
    const kit = stubKit({
      up: mock.fn(async (name, options) => {
        kit.emit('run:start', { runId: 'run-1', command: 'up' });
        kit.emit('migration:log', userland(options.job.id));
        // Another job's late line, and a background lane's: neither is this job's.
        kit.emit('migration:log', userland('99', { msg: 'stale' }));
        kit.emit('migration:log', { ...userland(options.job.id), kind: 'background' });
        return [{ file: name, status: 'applied', duration: 1 }];
      }),
    });
    const job = upJob();
    await createMigrationProcessor({ kit })(job);
    const rows = job.logs.filter((row) => row.startsWith('✎'));
    assert.deepStrictEqual(rows, ['✎ batch done {"processed":1000}']);
  });

  it('should match by run id when the job has no id', async () => {
    const kit = stubKit({
      up: mock.fn(async (name, options) => {
        assert.strictEqual(options.job, undefined, 'no job to name');
        kit.emit('run:start', { runId: 'run-1', command: 'up' });
        kit.emit('migration:log', userland(undefined));
        kit.emit('migration:log', userland(undefined, { runId: 'run-0', msg: 'stale' }));
        return [{ file: name, status: 'applied', duration: 1 }];
      }),
    });
    const job = upJob();
    delete job.id;
    await createMigrationProcessor({ kit })(job);
    assert.deepStrictEqual(
      job.logs.filter((row) => row.startsWith('✎')),
      ['✎ batch done {"processed":1000}'],
    );
  });

  it('should write nothing once the job settled, nor between jobs', async () => {
    let late;
    const kit = stubKit({
      up: mock.fn(async (name, options) => {
        late = () => kit.emit('migration:log', userland(options.job.id, { msg: 'late' }));
        return [{ file: name, status: 'applied', duration: 1 }];
      }),
    });
    const processor = createMigrationProcessor({ kit });
    const job = upJob();
    await processor(job);
    late();
    assert.ok(!job.logs.some((row) => row.includes('late')));
  });

  it('should take the lines of the lanes its run drives inline, by job and group', async () => {
    const kit = stubKit({
      up: mock.fn(async (name, options) => {
        kit.emit('run:start', { runId: 'run-1', command: 'up' });
        const lane = { kind: 'background', runId: 'lane-1', partition: '2', msg: 'batch' };
        kit.emit('migration:log', userland(options.job.id, { ...lane, groupId: 'g' }));
        // A background queue's lane with the same id: no group, not this job's.
        kit.emit('migration:log', userland(options.job.id, { ...lane, msg: 'other queue' }));
        return [{ file: name, status: 'applied', duration: 1 }];
      }),
    });
    const job = upJob();
    await createMigrationProcessor({ kit })(job);
    assert.deepStrictEqual(
      job.logs.filter((row) => row.startsWith('✎')),
      ['✎ batch {"processed":1000} [partition 2]'],
    );
  });

  it('should not take a line of another run of the same job', async () => {
    const kit = stubKit({
      up: mock.fn(async (name, options) => {
        kit.emit('run:start', { runId: 'run-1', command: 'up' });
        // A body of an earlier run of this job — put back in the queue — still logging.
        kit.emit('migration:log', userland(options.job.id, { runId: 'run-0', msg: 'stale' }));
        kit.emit('migration:log', userland(options.job.id));
        return [{ file: name, status: 'applied', duration: 1 }];
      }),
    });
    const job = upJob();
    await createMigrationProcessor({ kit })(job);
    assert.deepStrictEqual(
      job.logs.filter((row) => row.startsWith('✎')),
      ['✎ batch done {"processed":1000}'],
    );
  });

  it('should mirror up to userlandLogRows lines, then count the rest in one row', async () => {
    const kit = stubKit({
      up: mock.fn(async (name, options) => {
        kit.emit('run:start', { runId: 'run-1', command: 'up' });
        for (let seq = 1; seq <= 5; seq++) {
          kit.emit('migration:log', userland(options.job.id, { seq, msg: `line ${seq}` }));
        }
        return [{ file: name, status: 'applied', duration: 1 }];
      }),
    });
    const job = upJob();
    await createMigrationProcessor({ kit, userlandLogRows: 2 })(job);
    assert.deepStrictEqual(
      job.logs.filter((row) => row.startsWith('✎')),
      [
        '✎ line 1 {"processed":1000}',
        '✎ line 2 {"processed":1000}',
        '✎ … 3 more line(s) past the limit of 2 not mirrored here — see migration:log',
      ],
    );
  });

  it('should mirror none with userlandLogRows: 0, on the failing path too', async () => {
    const kit = stubKit({
      up: mock.fn(async (_name, options) => {
        kit.emit('run:start', { runId: 'run-1', command: 'up' });
        kit.emit('migration:log', userland(options.job.id));
        throw new MigrationExecutionFailedError('Migration up failed: 0001-a.js', {});
      }),
    });
    const job = upJob();
    await assert.rejects(
      createMigrationProcessor({ kit, userlandLogRows: 0 })(job),
      MigrationExecutionFailedError,
    );
    assert.deepStrictEqual(
      job.logs.filter((row) => row.startsWith('✎')),
      ['✎ … 1 more line(s) past the limit of 0 not mirrored here — see migration:log'],
    );
  });

  it('should refuse a userlandLogRows that is not a count', () => {
    for (const userlandLogRows of [-1, 1.5, '2', Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createMigrationProcessor({ kit: stubKit(), userlandLogRows }),
        ConfigInvalidError,
      );
    }
  });

  it('should carry the failing path too, before the failure row', async () => {
    const kit = stubKit({
      up: mock.fn(async (_name, options) => {
        kit.emit('run:start', { runId: 'run-1', command: 'up' });
        kit.emit('migration:log', userland(options.job.id, { level: 'error', msg: 'gave up' }));
        throw new MigrationExecutionFailedError('Migration up failed: 0001-a.js', {});
      }),
    });
    const job = upJob();
    await assert.rejects(createMigrationProcessor({ kit })(job), MigrationExecutionFailedError);
    const userlandAt = job.logs.findIndex((row) => row.startsWith('✎ error: gave up'));
    const failedAt = job.logs.findIndex((row) => row.startsWith('✖'));
    assert.ok(userlandAt !== -1 && userlandAt < failedAt);
  });
});

describe('ownLine', () => {
  const ctx = { runId: 'run-1', jobRef: { id: '7', groupId: 'g' } };
  const line = (extra) => ({
    kind: 'migration',
    runId: 'run-1',
    jobId: '7',
    groupId: 'g',
    ...extra,
  });

  it("should take the job's own run, and nothing of another run or job", () => {
    assert.strictEqual(ownLine(ctx, line()), true);
    assert.strictEqual(ownLine(ctx, line({ runId: 'run-0' })), false);
    assert.strictEqual(ownLine(ctx, line({ jobId: '8' })), false);
    assert.strictEqual(ownLine({ jobRef: ctx.jobRef }, line()), false, 'no run yet');
    assert.strictEqual(ownLine({ runId: 'run-1' }, line({ jobId: undefined })), true);
    assert.strictEqual(ownLine(ctx, line({ kind: 'other' })), false);
  });

  it("should take an inline lane's line only by the job and its group", () => {
    const lane = (extra) => line({ kind: 'background', runId: 'lane-1', ...extra });
    assert.strictEqual(ownLine(ctx, lane()), true);
    assert.strictEqual(ownLine(ctx, lane({ groupId: undefined })), false);
    assert.strictEqual(ownLine(ctx, lane({ groupId: 'h' })), false);
    assert.strictEqual(ownLine(ctx, lane({ jobId: '8' })), false);
    assert.strictEqual(ownLine({ runId: 'run-1', jobRef: { id: '7' } }, lane()), false);
    assert.strictEqual(ownLine({ runId: 'run-1' }, lane()), false);
  });
});

describe('jobRefOf', () => {
  it("should name the job by its id and group, as the kit's job option", () => {
    assert.deepStrictEqual(jobRefOf({ id: 11 }, 'g'), { id: '11', groupId: 'g' });
    assert.deepStrictEqual(jobRefOf({ id: '11' }), { id: '11' });
  });

  it('should drop what the kit would refuse', () => {
    assert.strictEqual(jobRefOf({}), undefined);
    assert.strictEqual(jobRefOf({ id: null }), undefined);
    assert.strictEqual(jobRefOf({ id: 'x'.repeat(1025) }), undefined);
    assert.deepStrictEqual(jobRefOf({ id: '11' }, 'g'.repeat(200)), { id: '11' });
  });
});

describe('userlandRow', () => {
  const base = { kind: 'migration', level: 'info', msg: 'done', data: {}, attempt: 1 };

  it('should show the level only when it is not info, and the data as JSON', () => {
    assert.strictEqual(userlandRow(base), '✎ done');
    assert.strictEqual(
      userlandRow({ ...base, level: 'warn', data: { n: 1, big: 2n } }),
      '✎ warn: done {"n":1,"big":"2"}',
    );
  });

  it('should name a retried attempt and a background partition', () => {
    assert.strictEqual(userlandRow({ ...base, attempt: 2 }), '✎ done (attempt 2)');
    assert.strictEqual(
      userlandRow({ ...base, kind: 'background', partition: '3' }),
      '✎ done [partition 3]',
    );
  });

  it('should survive data that does not serialize, and cut a long row', () => {
    class Broken {
      toJSON() {
        throw new Error('no');
      }
    }
    assert.strictEqual(
      userlandRow({ ...base, data: { broken: new Broken() } }),
      '✎ done [data not serializable]',
    );
    const row = userlandRow({ ...base, msg: 'x'.repeat(2000) });
    assert.strictEqual(row.length, 1024);
    assert.ok(row.endsWith('…'));
  });

  it('should write data only as far as the row shows it', () => {
    const data = {};
    for (let index = 0; index < 1000; index++) data[`k${index}`] = 'v'.repeat(4096);
    const row = userlandRow({ ...base, data });
    assert.strictEqual(row.length, 1024);
    assert.ok(row.startsWith('✎ done {"k0":"vvv'));
    assert.ok(row.endsWith('…'));
    // A cycle (never from the kit, whose copies are acyclic) ends at the bound too.
    const cyclic = {};
    cyclic.self = cyclic;
    assert.strictEqual(userlandRow({ ...base, data: cyclic }).length, 1024);
  });

  it('should keep a row on one line, with no control characters', () => {
    assert.strictEqual(
      userlandRow({ ...base, msg: 'done\n✔ Applied 0002-x.js\r\nnext\u2028\u001b[2J' }),
      '✎ done⏎✔ Applied 0002-x.js⏎next⏎[2J',
    );
    assert.strictEqual(userlandRow({ ...base, data: { note: 'a\nb' } }), '✎ done {"note":"a\\nb"}');
  });

  it('should show dates and ids by their JSON, and skip what JSON skips', () => {
    assert.strictEqual(
      userlandRow({
        ...base,
        data: { at: new Date(0), none: undefined, fn: () => 1, list: [undefined, 1n] },
      }),
      '✎ done {"at":"1970-01-01T00:00:00.000Z","list":[null,"1"]}',
    );
  });
});
