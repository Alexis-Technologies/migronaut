/** Base error for all migronaut failures. Carries a typed code and context */
class MigronautError extends Error {
  constructor(code, message, context) {
    super(message);
    this.name = 'MigronautError';
    this.code = code;
    if (context !== undefined) {
      this.context = context;
    }
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Thrown when a lock is already held by another process within its TTL */
class LockAlreadyHeldError extends MigronautError {
  constructor(message, context) {
    super('LOCK_ALREADY_HELD', message, context);
    this.name = 'LockAlreadyHeldError';
  }
}

/** Thrown when releasing a lock fails */
class LockReleaseFailedError extends MigronautError {
  constructor(message, context) {
    super('LOCK_RELEASE_FAILED', message, context);
    this.name = 'LockReleaseFailedError';
  }
}

/** Thrown when a file's checksum differs from the one recorded at apply time */
class ChecksumMismatchError extends MigronautError {
  constructor(message, context) {
    super('CHECKSUM_MISMATCH', message, context);
    this.name = 'ChecksumMismatchError';
  }
}

/** Thrown when a referenced migration file does not exist on disk */
class MigrationFileNotFoundError extends MigronautError {
  constructor(message, context) {
    super('MIGRATION_FILE_NOT_FOUND', message, context);
    this.name = 'MigrationFileNotFoundError';
  }
}

/**
 * Thrown when a migration name is not a plain filename — e.g. it contains a
 * path separator or `..`, which would let a target escape the migrations
 * directory (path traversal) when joined into a filesystem path.
 */
class MigrationInvalidNameError extends MigronautError {
  constructor(message, context) {
    super('MIGRATION_INVALID_NAME', message, context);
    this.name = 'MigrationInvalidNameError';
  }
}

/** Thrown when a migration file does not export valid up()/down() functions */
class MigrationInvalidExportError extends MigronautError {
  constructor(message, context) {
    super('MIGRATION_INVALID_EXPORT', message, context);
    this.name = 'MigrationInvalidExportError';
  }
}

/** Thrown when a migration's up() or down() throws during execution */
class MigrationExecutionFailedError extends MigronautError {
  constructor(message, context) {
    super('MIGRATION_EXECUTION_FAILED', message, context);
    this.name = 'MigrationExecutionFailedError';
  }
}

/** Thrown when the merged configuration fails validation */
class ConfigInvalidError extends MigronautError {
  constructor(message, context) {
    super('CONFIG_INVALID', message, context);
    this.name = 'ConfigInvalidError';
  }
}

/** Thrown when creating a config file that already exists without `--force` */
class ConfigFileExistsError extends MigronautError {
  constructor(message, context) {
    super('CONFIG_FILE_EXISTS', message, context);
    this.name = 'ConfigFileExistsError';
  }
}

/** Thrown when connecting to MongoDB fails */
class ConnectionFailedError extends MigronautError {
  constructor(message, context) {
    super('CONNECTION_FAILED', message, context);
    this.name = 'ConnectionFailedError';
  }
}

/** Thrown when attempting to apply a migration that is already applied */
class AlreadyAppliedError extends MigronautError {
  constructor(message, context) {
    super('ALREADY_APPLIED', message, context);
    this.name = 'AlreadyAppliedError';
  }
}

/** Thrown when attempting to revert a migration that was never applied */
class NotAppliedError extends MigronautError {
  constructor(message, context) {
    super('NOT_APPLIED', message, context);
    this.name = 'NotAppliedError';
  }
}

/** Thrown when `migronaut import` targets a non-empty changelog without `--force` */
class ImportTargetNotEmptyError extends MigronautError {
  constructor(message, context) {
    super('IMPORT_TARGET_NOT_EMPTY', message, context);
    this.name = 'ImportTargetNotEmptyError';
  }
}

/** Thrown when attempting to roll back a migrate-mongo-imported (forward-only) migration */
class IrreversibleMigrationError extends MigronautError {
  constructor(message, context) {
    super('MIGRATION_IRREVERSIBLE', message, context);
    this.name = 'IrreversibleMigrationError';
  }
}

module.exports = {
  MigronautError,
  LockAlreadyHeldError,
  LockReleaseFailedError,
  ChecksumMismatchError,
  MigrationFileNotFoundError,
  MigrationInvalidNameError,
  MigrationInvalidExportError,
  MigrationExecutionFailedError,
  ConfigInvalidError,
  ConfigFileExistsError,
  ConnectionFailedError,
  AlreadyAppliedError,
  NotAppliedError,
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
};
