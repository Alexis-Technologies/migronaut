const { EXIT_CODES } = require('./cli/exit-codes.js');
const { MigratorKit } = require('./core/migrator.js');
const { pendingMigrations, runMigrations } = require('./core/run.js');
const {
  ChecksumMismatchError,
  ConfigFileExistsError,
  ConfigInvalidError,
  ConnectionFailedError,
  HookFailedError,
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
  LockAlreadyHeldError,
  LockLostError,
  LockReleaseFailedError,
  MigrationExecutionFailedError,
  MigrationFileExistsError,
  MigrationFileNotFoundError,
  MigrationInvalidExportError,
  MigrationInvalidNameError,
  MigrationTimeoutError,
  TransactionsUnsupportedError,
  MigronautError,
  NotAppliedError,
  RunAbortedError,
} = require('./errors/index.js');

module.exports = {
  // Main class
  MigratorKit,

  // Programmatic entry points (app startup / serverless / test setup)
  pendingMigrations,
  runMigrations,

  // The CLI's exit-code map, for wrappers that mirror its semantics
  EXIT_CODES,

  // Error classes
  ChecksumMismatchError,
  ConfigFileExistsError,
  ConfigInvalidError,
  ConnectionFailedError,
  HookFailedError,
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
  LockAlreadyHeldError,
  LockLostError,
  LockReleaseFailedError,
  MigrationExecutionFailedError,
  MigrationFileExistsError,
  MigrationFileNotFoundError,
  MigrationInvalidExportError,
  MigrationInvalidNameError,
  MigrationTimeoutError,
  TransactionsUnsupportedError,
  MigronautError,
  NotAppliedError,
  RunAbortedError,
};
