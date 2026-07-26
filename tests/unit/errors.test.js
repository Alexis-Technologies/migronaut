const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  ChecksumMismatchError,
  ConfigFileExistsError,
  ConfigInvalidError,
  ConnectionFailedError,
  HookFailedError,
  LockAlreadyHeldError,
  LockLostError,
  LockReleaseFailedError,
  MigrationExecutionFailedError,
  MigrationFileExistsError,
  MigrationFileNotFoundError,
  MigrationInvalidExportError,
  MigronautError,
  NotAppliedError,
  RunAbortedError,
} = require('../../src/errors/index.js');

describe('MigronautError', () => {
  it('should set code, message and context', () => {
    const err = new MigronautError('CONFIG_INVALID', 'Bad config', { field: 'uri' });
    assert.strictEqual(err.code, 'CONFIG_INVALID');
    assert.strictEqual(err.message, 'Bad config');
    assert.deepStrictEqual(err.context, { field: 'uri' });
    assert.strictEqual(err.name, 'MigronautError');
  });

  it('should be an instance of Error', () => {
    const err = new MigronautError('CONFIG_INVALID', 'Bad config');
    assert.ok(err instanceof Error);
  });

  it('should leave context undefined when not provided', () => {
    const err = new MigronautError('CONFIG_INVALID', 'Bad config');
    assert.strictEqual(err.context, undefined);
  });

  it('should capture a stack trace', () => {
    const err = new MigronautError('CONFIG_INVALID', 'Bad config');
    assert.notStrictEqual(err.stack, undefined);
  });
});

describe('domain error classes', () => {
  const cases = [
    { Ctor: LockAlreadyHeldError, code: 'LOCK_ALREADY_HELD', name: 'LockAlreadyHeldError' },
    { Ctor: LockReleaseFailedError, code: 'LOCK_RELEASE_FAILED', name: 'LockReleaseFailedError' },
    { Ctor: ChecksumMismatchError, code: 'CHECKSUM_MISMATCH', name: 'ChecksumMismatchError' },
    {
      Ctor: MigrationFileNotFoundError,
      code: 'MIGRATION_FILE_NOT_FOUND',
      name: 'MigrationFileNotFoundError',
    },
    {
      Ctor: MigrationInvalidExportError,
      code: 'MIGRATION_INVALID_EXPORT',
      name: 'MigrationInvalidExportError',
    },
    {
      Ctor: MigrationExecutionFailedError,
      code: 'MIGRATION_EXECUTION_FAILED',
      name: 'MigrationExecutionFailedError',
    },
    { Ctor: ConfigInvalidError, code: 'CONFIG_INVALID', name: 'ConfigInvalidError' },
    { Ctor: ConfigFileExistsError, code: 'CONFIG_FILE_EXISTS', name: 'ConfigFileExistsError' },
    { Ctor: ConnectionFailedError, code: 'CONNECTION_FAILED', name: 'ConnectionFailedError' },
    { Ctor: NotAppliedError, code: 'NOT_APPLIED', name: 'NotAppliedError' },
    { Ctor: LockLostError, code: 'LOCK_LOST', name: 'LockLostError' },
    { Ctor: RunAbortedError, code: 'RUN_ABORTED', name: 'RunAbortedError' },
    { Ctor: HookFailedError, code: 'HOOK_FAILED', name: 'HookFailedError' },
    {
      Ctor: MigrationFileExistsError,
      code: 'MIGRATION_FILE_EXISTS',
      name: 'MigrationFileExistsError',
    },
  ];

  for (const { Ctor, code, name } of cases) {
    it(`${name} should carry code ${code} and extend MigronautError`, () => {
      const err = new Ctor('Something happened', { detail: 1 });
      assert.ok(err instanceof MigronautError);
      assert.ok(err instanceof Error);
      assert.strictEqual(err.code, code);
      assert.strictEqual(err.name, name);
      assert.strictEqual(err.message, 'Something happened');
      assert.deepStrictEqual(err.context, { detail: 1 });
    });

    it(`${name} should be catchable as MigronautError with its code`, () => {
      try {
        throw new Ctor('boom');
      } catch (e) {
        assert.ok(e instanceof MigronautError);
        assert.strictEqual(e.code, code);
      }
    });
  }
});
