const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { MigratorKit } = require('../../src/core/migrator.js');
const { ConfigInvalidError, MigrationInvalidNameError } = require('../../src/errors/index.js');

/**
 * A kit pointed at an unreachable host. Every guard below must reject *before*
 * any connection is attempted — if a guard were missing, the call would hang on
 * server selection instead of throwing, so these tests double as proof that the
 * validation happens up front.
 */
function guardedKit() {
  return new MigratorKit({
    // serverSelectionTimeoutMS keeps the one test that *does* reach the driver
    // from waiting out the 30s default.
    uri: 'mongodb://127.0.0.1:1/never?serverSelectionTimeoutMS=100',
    dbName: 'nope',
    migrationsDir: '/tmp/migronaut-guards-does-not-exist',
    logger: null,
  });
}

describe('MigratorKit filename guards', () => {
  // A non-string filename would flow into changelog.getByName -> findOne({ name })
  // where a query operator selects an arbitrary record.
  const injections = [
    ['query operator', { $ne: null }],
    ['regex', { $regex: '.*' }],
    ['array', ['a.js']],
    ['number', 42],
    ['null', null],
  ];

  for (const [label, value] of injections) {
    it(`should reject a ${label} filename passed to up()`, async () => {
      await assert.rejects(guardedKit().up(value), MigrationInvalidNameError);
    });

    it(`should reject a ${label} filename passed to down()`, async () => {
      await assert.rejects(guardedKit().down(value), MigrationInvalidNameError);
    });

    it(`should reject a ${label} filename passed to redo()`, async () => {
      await assert.rejects(guardedKit().redo(value), MigrationInvalidNameError);
    });

    it(`should reject a ${label} filename passed to dryRun()`, async () => {
      await assert.rejects(guardedKit().dryRun('up', value), MigrationInvalidNameError);
    });
  }

  it('should still allow an omitted filename (the bulk case)', () => {
    // undefined must pass the guard — it reaches the connection attempt instead,
    // which is a different (connection) failure, not an invalid-name one.
    const kit = guardedKit();
    return assert.rejects(kit.up(undefined), (error) => {
      assert.ok(!(error instanceof MigrationInvalidNameError));
      return true;
    });
  });
});

describe('MigratorKit import collection guards', () => {
  const badNames = [
    ['a system collection', 'system.users'],
    ['a $-bearing name', 'change$log'],
    ['a NUL-bearing name', 'change\0log'],
    ['an empty name', ''],
  ];

  for (const [label, value] of badNames) {
    it(`should reject ${label} as --from`, async () => {
      await assert.rejects(guardedKit().import({ from: value }), ConfigInvalidError);
    });

    it(`should reject ${label} as --to`, async () => {
      await assert.rejects(guardedKit().import({ to: value }), ConfigInvalidError);
    });
  }
});
