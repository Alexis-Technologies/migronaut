const { MigratorKit } = require('./core/migrator.js');
const { pendingMigrations, runMigrations } = require('./core/run.js');
const {
  AlreadyAppliedError,
  ChecksumMismatchError,
  ConfigFileExistsError,
  ConfigInvalidError,
  ConnectionFailedError,
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
  LockAlreadyHeldError,
  LockReleaseFailedError,
  MigrationExecutionFailedError,
  MigrationFileNotFoundError,
  MigrationInvalidExportError,
  MigrationInvalidNameError,
  MigronautError,
  NotAppliedError,
} = require('./errors/index.js');

module.exports = {
  // Main class
  MigratorKit,

  // Programmatic entry points (app startup / serverless / test setup)
  pendingMigrations,
  runMigrations,

  // Error classes
  AlreadyAppliedError,
  ChecksumMismatchError,
  ConfigFileExistsError,
  ConfigInvalidError,
  ConnectionFailedError,
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
  LockAlreadyHeldError,
  LockReleaseFailedError,
  MigrationExecutionFailedError,
  MigrationFileNotFoundError,
  MigrationInvalidExportError,
  MigrationInvalidNameError,
  MigronautError,
  NotAppliedError,
};
