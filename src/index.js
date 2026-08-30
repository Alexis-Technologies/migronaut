const { EXIT_CODES } = require('./cli/exit-codes.js');
const { MigratorKit } = require('./core/migrator.js');
const { pendingMigrations, runMigrations } = require('./core/run.js');
const { createLogger } = require('./utils/logger.js');
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
  OutOfOrderMigrationError,
  RunAbortedError,
} = require('./errors/index.js');

module.exports = {
  // Main class
  MigratorKit,

  // Programmatic entry points (app startup / serverless / test setup)
  pendingMigrations,
  runMigrations,

  // The default console logger, for programmatic callers who want migronaut's
  // own output at a chosen level (e.g. createLogger(process.stdout, 'debug'))
  // without hand-writing a four-method logger
  createLogger,

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
  OutOfOrderMigrationError,
  RunAbortedError,
};
