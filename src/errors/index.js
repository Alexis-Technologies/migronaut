/**
 * Base error for all migronaut failures. Carries a typed `code`, an optional
 * `context`, and — when the failure wraps another error — that error as
 * `cause`.
 *
 * The cause is a real Error, not a string, so `err.cause.stack` still points
 * into the user's own migration. Wrap sites additionally keep the *message* in
 * `context.cause`, because that is what survives JSON serialization for
 * `--json` consumers.
 */
class MigronautError extends Error {
  constructor(code, message, context, options) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
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
  constructor(message, context, options) {
    super('LOCK_ALREADY_HELD', message, context, options);
    this.name = 'LockAlreadyHeldError';
  }
}

/** Thrown when releasing a lock fails */
class LockReleaseFailedError extends MigronautError {
  constructor(message, context, options) {
    super('LOCK_RELEASE_FAILED', message, context, options);
    this.name = 'LockReleaseFailedError';
  }
}

/**
 * Thrown when the lock is lost while migrations are still running — another
 * process reclaimed it, or the heartbeat could not reach the database. The run
 * stops rather than risk two processes migrating the same database at once.
 */
class LockLostError extends MigronautError {
  constructor(message, context, options) {
    super('LOCK_LOST', message, context, options);
    this.name = 'LockLostError';
  }
}

/**
 * Thrown when a run is stopped before finishing — via `MigratorKit.stop()` or a
 * SIGINT/SIGTERM. Migrations already applied are listed in `context.results`.
 */
class RunAbortedError extends MigronautError {
  constructor(message, context, options) {
    super('RUN_ABORTED', message, context, options);
    this.name = 'RunAbortedError';
  }
}

/** Thrown when a user-supplied lifecycle hook throws */
class HookFailedError extends MigronautError {
  constructor(message, context, options) {
    super('HOOK_FAILED', message, context, options);
    this.name = 'HookFailedError';
  }
}

/** Thrown when `migronaut create` would overwrite an existing migration file */
class MigrationFileExistsError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_FILE_EXISTS', message, context, options);
    this.name = 'MigrationFileExistsError';
  }
}

/** Thrown when a file's checksum differs from the one recorded at apply time */
class ChecksumMismatchError extends MigronautError {
  constructor(message, context, options) {
    super('CHECKSUM_MISMATCH', message, context, options);
    this.name = 'ChecksumMismatchError';
  }
}

/** Thrown when a referenced migration file does not exist on disk */
class MigrationFileNotFoundError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_FILE_NOT_FOUND', message, context, options);
    this.name = 'MigrationFileNotFoundError';
  }
}

/**
 * Thrown when a migration name is not a plain filename — e.g. it contains a
 * path separator or `..`, which would let a target escape the migrations
 * directory (path traversal) when joined into a filesystem path.
 */
class MigrationInvalidNameError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_INVALID_NAME', message, context, options);
    this.name = 'MigrationInvalidNameError';
  }
}

/** Thrown when a migration file does not export valid up()/down() functions */
class MigrationInvalidExportError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_INVALID_EXPORT', message, context, options);
    this.name = 'MigrationInvalidExportError';
  }
}

/** Thrown when a migration's up() or down() throws during execution */
class MigrationExecutionFailedError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_EXECUTION_FAILED', message, context, options);
    this.name = 'MigrationExecutionFailedError';
  }
}

/** Thrown when the merged configuration fails validation */
class ConfigInvalidError extends MigronautError {
  constructor(message, context, options) {
    super('CONFIG_INVALID', message, context, options);
    this.name = 'ConfigInvalidError';
  }
}

/** Thrown when creating a config file that already exists without `--force` */
class ConfigFileExistsError extends MigronautError {
  constructor(message, context, options) {
    super('CONFIG_FILE_EXISTS', message, context, options);
    this.name = 'ConfigFileExistsError';
  }
}

/** Thrown when connecting to MongoDB fails */
class ConnectionFailedError extends MigronautError {
  constructor(message, context, options) {
    super('CONNECTION_FAILED', message, context, options);
    this.name = 'ConnectionFailedError';
  }
}

/** Thrown when attempting to revert a migration that was never applied */
class NotAppliedError extends MigronautError {
  constructor(message, context, options) {
    super('NOT_APPLIED', message, context, options);
    this.name = 'NotAppliedError';
  }
}

/** Thrown when `migronaut import` targets a non-empty changelog without `--force` */
class ImportTargetNotEmptyError extends MigronautError {
  constructor(message, context, options) {
    super('IMPORT_TARGET_NOT_EMPTY', message, context, options);
    this.name = 'ImportTargetNotEmptyError';
  }
}

/** Thrown when attempting to roll back a migrate-mongo-imported (forward-only) migration */
class IrreversibleMigrationError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_IRREVERSIBLE', message, context, options);
    this.name = 'IrreversibleMigrationError';
  }
}

module.exports = {
  MigronautError,
  LockAlreadyHeldError,
  LockReleaseFailedError,
  LockLostError,
  RunAbortedError,
  HookFailedError,
  ChecksumMismatchError,
  MigrationFileNotFoundError,
  MigrationFileExistsError,
  MigrationInvalidNameError,
  MigrationInvalidExportError,
  MigrationExecutionFailedError,
  ConfigInvalidError,
  ConfigFileExistsError,
  ConnectionFailedError,
  NotAppliedError,
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
};
