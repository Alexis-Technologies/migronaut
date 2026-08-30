const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { runMigration } = require('../../src/core/runner.js');
const {
  MigrationExecutionFailedError,
  MigrationTimeoutError,
} = require('../../src/errors/index.js');
const { keepEventLoopAlive } = require('../helpers/event-loop.js');

function makeContext() {
  // withTransaction is the driver's retry-aware wrapper: it runs the body,
  // commits on success and aborts on throw. The stub mirrors that contract.
  const session = {
    withTransaction: mock.fn(async (body) => {
      try {
        const result = await body();
        session.commitTransaction();
        return result;
      } catch (error) {
        session.abortTransaction();
        throw error;
      }
    }),
    commitTransaction: mock.fn(() => Promise.resolve(undefined)),
    abortTransaction: mock.fn(() => Promise.resolve(undefined)),
    endSession: mock.fn(() => Promise.resolve(undefined)),
  };
  const client = { startSession: mock.fn(() => session) };
  const context = { client, db: {} };
  return { context, session };
}

describe('runMigration', () => {
  it('should run up without a transaction when useTransaction is false', async () => {
    const { context, session } = makeContext();
    const migration = {
      up: mock.fn(() => Promise.resolve(undefined)),
      down: mock.fn(() => Promise.resolve(undefined)),
    };
    const result = await runMigration({
      name: 'a.ts',
      migration,
      direction: 'up',
      context,
      useTransaction: false,
    });
    assert.strictEqual(migration.up.mock.callCount(), 1);
    assert.strictEqual(session.withTransaction.mock.callCount(), 0);
    assert.strictEqual(typeof result.duration, 'number');
    assert.ok(result.duration >= 0);
  });

  it('should run the down function when direction is down', async () => {
    const { context } = makeContext();
    const migration = {
      up: mock.fn(() => Promise.resolve(undefined)),
      down: mock.fn(() => Promise.resolve(undefined)),
    };
    await runMigration({
      name: 'a.ts',
      migration,
      direction: 'down',
      context,
      useTransaction: false,
    });
    assert.strictEqual(migration.down.mock.callCount(), 1);
    assert.strictEqual(migration.up.mock.callCount(), 0);
  });

  it('should commit the transaction on success when useTransaction is true', async () => {
    const { context, session } = makeContext();
    const migration = {
      up: mock.fn(() => Promise.resolve(undefined)),
      down: mock.fn(() => Promise.resolve(undefined)),
    };
    await runMigration({ name: 'a.ts', migration, direction: 'up', context, useTransaction: true });
    assert.strictEqual(session.withTransaction.mock.callCount(), 1);
    assert.strictEqual(session.commitTransaction.mock.callCount(), 1);
    assert.strictEqual(session.abortTransaction.mock.callCount(), 0);
    assert.strictEqual(session.endSession.mock.callCount(), 1);
  });

  it('should abort the transaction and call onError before throwing', async () => {
    const { context, session } = makeContext();
    const onError = mock.fn(() => Promise.resolve(undefined));
    const migration = {
      up: mock.fn(() => Promise.reject(new Error('boom'))),
      down: mock.fn(() => Promise.resolve(undefined)),
    };
    await assert.rejects(
      runMigration({
        name: 'a.ts',
        migration,
        direction: 'up',
        context,
        useTransaction: true,
        hooks: { onError },
      }),
      MigrationExecutionFailedError,
    );
    assert.strictEqual(session.abortTransaction.mock.callCount(), 1);
    assert.strictEqual(session.commitTransaction.mock.callCount(), 0);
    assert.strictEqual(onError.mock.callCount(), 1);
    assert.strictEqual(onError.mock.calls[0].arguments[0], 'a.ts');
    assert.ok(onError.mock.calls[0].arguments[1] instanceof Error);
    assert.strictEqual(session.endSession.mock.callCount(), 1);
  });

  it('should run onSuccess inside the transaction, before the commit', async () => {
    const { context, session } = makeContext();
    const order = [];
    session.commitTransaction.mock.mockImplementation(() => {
      order.push('commit');
      return Promise.resolve(undefined);
    });
    const migration = {
      up: mock.fn(() => {
        order.push('up');
        return Promise.resolve(undefined);
      }),
      down: mock.fn(() => Promise.resolve(undefined)),
    };
    const onSuccess = mock.fn((_duration, s) => {
      order.push(s === session ? 'record(in-session)' : 'record(no-session)');
      return Promise.resolve(undefined);
    });
    await runMigration({
      name: 'a.ts',
      migration,
      direction: 'up',
      context,
      useTransaction: true,
      onSuccess,
    });
    assert.deepStrictEqual(order, ['up', 'record(in-session)', 'commit']);
  });

  it('should pass the measured duration to onSuccess', async () => {
    const { context } = makeContext();
    const onSuccess = mock.fn(() => Promise.resolve(undefined));
    await runMigration({
      name: 'a.ts',
      migration: { up: mock.fn(() => Promise.resolve(undefined)), down: mock.fn() },
      direction: 'up',
      context,
      useTransaction: false,
      onSuccess,
    });
    const [duration, session] = onSuccess.mock.calls[0].arguments;
    assert.strictEqual(typeof duration, 'number');
    assert.ok(duration >= 0);
    assert.strictEqual(session, undefined);
  });

  it('should abort the transaction when onSuccess fails, so nothing is half-recorded', async () => {
    const { context, session } = makeContext();
    const migration = {
      up: mock.fn(() => Promise.resolve(undefined)),
      down: mock.fn(() => Promise.resolve(undefined)),
    };
    await assert.rejects(
      runMigration({
        name: 'a.ts',
        migration,
        direction: 'up',
        context,
        useTransaction: true,
        onSuccess: () => Promise.reject(new Error('changelog write failed')),
      }),
      MigrationExecutionFailedError,
    );
    assert.strictEqual(session.abortTransaction.mock.callCount(), 1);
    assert.strictEqual(session.commitTransaction.mock.callCount(), 0);
  });

  it('should not let a throwing onError hook mask the original failure', async () => {
    const { context } = makeContext();
    const warn = mock.fn();
    await assert.rejects(
      runMigration({
        name: 'a.ts',
        migration: {
          up: mock.fn(() => Promise.reject(new Error('the real cause'))),
          down: mock.fn(),
        },
        direction: 'up',
        context,
        useTransaction: false,
        logger: { warn, debug: mock.fn(), info: mock.fn(), error: mock.fn() },
        hooks: { onError: () => Promise.reject(new Error('hook exploded')) },
      }),
      (error) => {
        assert.ok(error instanceof MigrationExecutionFailedError);
        assert.strictEqual(error.context.cause, 'the real cause');
        return true;
      },
    );
    assert.strictEqual(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /onError hook failed/);
  });

  it('should not surface an unhandledRejection when a timed-out body later rejects', async () => {
    const { context, session } = makeContext();
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    // `up` never settles on its own and the context is a mock, so the unref'ed
    // timeout timer is the only pending handle — see tests/helpers/event-loop.js.
    const release = keepEventLoopAlive();
    try {
      let rejectLater;
      const migration = {
        up: mock.fn(() => new Promise((_resolve, reject) => (rejectLater = reject))),
        down: mock.fn(),
      };
      await assert.rejects(
        runMigration({
          name: 'slow.ts',
          migration,
          direction: 'up',
          context,
          useTransaction: true,
          timeoutMs: 20,
        }),
        MigrationTimeoutError,
      );
      // The session is already ended (finally block) while the body still
      // runs — its late rejection mirrors the MongoExpiredSessionError case
      // and must be swallowed, not escalated to the process.
      assert.strictEqual(session.endSession.mock.callCount(), 1);
      rejectLater(new Error('post-timeout failure'));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(unhandled, []);
    } finally {
      release();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('should wrap a non-Error throw in MigrationExecutionFailedError', async () => {
    const { context } = makeContext();
    const migration = {
      // eslint-disable-next-line prefer-promise-reject-errors -- intentionally tests the non-Error-throw wrapping path
      up: mock.fn(() => Promise.reject('string failure')),
      down: mock.fn(() => Promise.resolve(undefined)),
    };
    await assert.rejects(
      runMigration({ name: 'a.ts', migration, direction: 'up', context, useTransaction: false }),
      MigrationExecutionFailedError,
    );
  });
});

describe('runMigration — changelog-write phase (non-transactional)', () => {
  it('should report a changelog failure after a committed body as its own phase', async () => {
    const { context } = makeContext();
    const migration = {
      up: mock.fn(() => Promise.resolve(undefined)),
      down: mock.fn(() => Promise.resolve(undefined)),
    };
    // The generic "migration failed" would invite re-running writes that are
    // already committed — the phase marker is what lets the operator (and a
    // --json consumer) tell the two apart.
    await assert.rejects(
      runMigration({
        name: 'a.ts',
        migration,
        direction: 'up',
        context,
        useTransaction: false,
        onSuccess: () => Promise.reject(new Error('primary stepped down')),
      }),
      (error) => {
        assert.ok(error instanceof MigrationExecutionFailedError);
        assert.strictEqual(error.context.phase, 'changelog-write');
        assert.strictEqual(error.context.bodySucceeded, true);
        assert.match(error.message, /succeeded but recording it/);
        return true;
      },
    );
  });

  it('should not fire onError for a changelog-write failure (the migration did not fail)', async () => {
    const { context } = makeContext();
    const onError = mock.fn(() => Promise.resolve(undefined));
    await assert.rejects(
      runMigration({
        name: 'a.ts',
        migration: { up: () => Promise.resolve(undefined), down: () => Promise.resolve(undefined) },
        direction: 'up',
        context,
        useTransaction: false,
        hooks: { onError },
        onSuccess: () => Promise.reject(new Error('boom')),
      }),
    );
    assert.strictEqual(onError.mock.callCount(), 0);
  });
});

describe('runMigration — timeout aborts ctx.signal', () => {
  it('should abort the context signal when the timeout fires', async () => {
    const { context } = makeContext();
    let observedSignal;
    const migration = {
      // A cooperative body: parks forever unless the signal tells it to stop.
      up: (ctx) => {
        observedSignal = ctx.signal;
        return new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        });
      },
      down: () => Promise.resolve(undefined),
    };
    await assert.rejects(
      runMigration({
        name: 'slow.ts',
        migration,
        direction: 'up',
        context,
        useTransaction: false,
        timeoutMs: 20,
      }),
      MigrationTimeoutError,
    );
    assert.ok(observedSignal.aborted, 'ctx.signal must be aborted on timeout');
    assert.ok(observedSignal.reason instanceof MigrationTimeoutError);
  });

  it('should compose the run signal with the timeout signal', async () => {
    const { context } = makeContext();
    const runController = new AbortController();
    let observedSignal;
    const migration = {
      up: (ctx) => {
        observedSignal = ctx.signal;
        return Promise.resolve(undefined);
      },
      down: () => Promise.resolve(undefined),
    };
    await runMigration({
      name: 'a.ts',
      migration,
      direction: 'up',
      context: { ...context, signal: runController.signal },
      useTransaction: false,
    });
    // Aborting the run signal must reach the composed context signal too.
    assert.strictEqual(observedSignal.aborted, false);
    runController.abort(new Error('stop'));
    assert.strictEqual(observedSignal.aborted, true);
  });
});

describe('runMigration — failure timing', () => {
  it('should attach durationMs to the failure context', async () => {
    const { context } = makeContext();
    await assert.rejects(
      runMigration({
        name: 'a.ts',
        migration: {
          up: () => Promise.reject(new Error('nope')),
          down: () => Promise.resolve(undefined),
        },
        direction: 'up',
        context,
        useTransaction: false,
      }),
      (error) => {
        assert.strictEqual(typeof error.context.durationMs, 'number');
        assert.ok(error.context.durationMs >= 0);
        return true;
      },
    );
  });
});
