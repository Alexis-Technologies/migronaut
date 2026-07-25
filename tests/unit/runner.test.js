const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { runMigration } = require('../../src/core/runner.js');
const { MigrationExecutionFailedError } = require('../../src/errors/index.js');

function makeContext() {
  const session = {
    startTransaction: mock.fn(),
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
    assert.strictEqual(session.startTransaction.mock.callCount(), 0);
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
    assert.strictEqual(session.startTransaction.mock.callCount(), 1);
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
