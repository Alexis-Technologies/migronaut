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

/**
 * Thrown when a migration exceeds its `timeoutMs`. Best-effort: the migration's
 * own work cannot be cancelled, but the run stops instead of hanging, letting
 * the lock's TTL expire so other instances are not blocked forever.
 */
class MigrationTimeoutError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_TIMEOUT', message, context, options);
    this.name = 'MigrationTimeoutError';
  }
}

/**
 * Thrown when `useTransaction` is on but the deployment cannot run
 * transactions (a standalone server — they need a replica set or mongos).
 * A dedicated code, because the driver's own error blames the migration.
 */
class TransactionsUnsupportedError extends MigronautError {
  constructor(message, context, options) {
    super('TRANSACTIONS_UNSUPPORTED', message, context, options);
    this.name = 'TransactionsUnsupportedError';
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

/** Thrown when attempting to roll back a forward-only (imported or baselined) migration */
class IrreversibleMigrationError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_IRREVERSIBLE', message, context, options);
    this.name = 'IrreversibleMigrationError';
  }
}

/**
 * Thrown by a bulk `up` under `onOutOfOrder: 'error'` when a pending migration
 * sorts before the newest applied one — a file merged late from a parallel
 * branch, which would otherwise run after migrations authored later and leave
 * environments with different effective apply orders.
 */
class OutOfOrderMigrationError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_OUT_OF_ORDER', message, context, options);
    this.name = 'OutOfOrderMigrationError';
  }
}

/**
 * Thrown by an `ordered` single-file run that would apply or revert out of
 * sequence: an earlier migration is still pending (`up`), or one applied later
 * is still applied (`down`). `context.blockedBy` names what must go first.
 */
class MigrationBlockedError extends MigronautError {
  constructor(message, context, options) {
    super('MIGRATION_BLOCKED', message, context, options);
    this.name = 'MigrationBlockedError';
  }
}

/**
 * Thrown by the queue adapter when a job's payload fails the contract check.
 * Job data comes back from Redis, so it is untrusted input — never a config
 * mistake of the process that reads it.
 */
class QueueJobInvalidError extends MigronautError {
  constructor(message, context, options) {
    super('QUEUE_JOB_INVALID', message, context, options);
    this.name = 'QueueJobInvalidError';
  }
}

/**
 * Thrown by a queue group's `wait()` when one of its jobs failed or the wait
 * timed out. The worker's typed error does not cross the queue — only its
 * message does — so `context.failedReason` carries it and `context.results`
 * lists the jobs that finished before it.
 */
class QueueJobFailedError extends MigronautError {
  constructor(message, context, options) {
    super('QUEUE_JOB_FAILED', message, context, options);
    this.name = 'QueueJobFailedError';
  }
}

/**
 * Thrown by `converge` when the database cannot be brought to the declared
 * state. `context.phase` says where it stopped: `'plan'` (a conflict refused
 * the run before any write), `'replan'` (a collection changed while the run
 * was under way), `'apply'` (a step failed) or `'wait'` (the search index
 * builds did not finish — `context.reason`: `'failed'`, `'timeout'` or
 * `'unreadable'`). A search index list that could not be read is reported in
 * the phase that read it. `context.converge` is the converge result so far —
 * which steps were applied, which failed, which were never reached — and
 * `context.hint`, when present, says what usually fixes the server error
 * behind it.
 */
class ConvergeFailedError extends MigronautError {
  constructor(message, context, options) {
    super('CONVERGE_FAILED', message, context, options);
    this.name = 'ConvergeFailedError';
  }
}

/**
 * Thrown by the optimistic-concurrency helpers (`@alexify/migronaut/versioning`)
 * when a revision-guarded write matched nothing. `context.reason` says why:
 * `'conflict'` (the document exists at another revision — `context.actual`),
 * `'not-found'` (no document matches the filter at all) or `'unknown'` (the
 * follow-up read was skipped or could not tell). `context.expected` is the
 * revision the caller held. The filter is never copied in — it may carry PII.
 */
class RevisionConflictError extends MigronautError {
  constructor(message, context, options) {
    super('REVISION_CONFLICT', message, context, options);
    this.name = 'RevisionConflictError';
  }
}

/**
 * Thrown by an upcaster that cannot bring a document to the current shape:
 * `context.reason` is `'newer'` (written by a newer release), `'below-min'`
 * (older than the oldest shape still supported) or `'invalid'` (the version
 * field is not a non-negative integer, or a step returned something that is
 * not a document).
 */
class ShapeVersionError extends MigronautError {
  constructor(message, context, options) {
    super('SHAPE_VERSION_UNSUPPORTED', message, context, options);
    this.name = 'ShapeVersionError';
  }
}

/**
 * Thrown when a migration `requires` a background migration that has not
 * completed yet — or whose collection still holds documents of the old shape.
 * Nothing was run: `context.waitsFor` names the background migrations it
 * waits for, with their status.
 */
class BackgroundPendingError extends MigronautError {
  constructor(message, context, options) {
    super('BACKGROUND_PENDING', message, context, options);
    this.name = 'BackgroundPendingError';
  }
}

/**
 * Thrown when a background migration ended `failed` — a partition used up its
 * slice failures, the document error budget ran out, or old-shape documents
 * kept appearing for `maxPasses` passes. `context.migration` names it and
 * `context.lastError` says what happened last.
 */
class BackgroundFailedError extends MigronautError {
  constructor(message, context, options) {
    super('BACKGROUND_FAILED', message, context, options);
    this.name = 'BackgroundFailedError';
  }
}

/**
 * Thrown when a control action does not fit the background migration's state
 * — pausing a completed one, resuming one that is not paused, retrying one
 * that is still running. `context.status` is the state it found and
 * `context.action` what was asked.
 */
class BackgroundConflictError extends MigronautError {
  constructor(message, context, options) {
    super('BACKGROUND_CONFLICT', message, context, options);
    this.name = 'BackgroundConflictError';
  }
}

/**
 * Thrown by the dry-run sandbox when a step reaches for something it cannot
 * run inside an always-aborted transaction — DDL, an admin command, another
 * session, `$out`/`$merge`, a migronaut-internal collection. `context.method`
 * names the call and `context.reason` the rule it broke. A dry run reports
 * every refusal even when the step caught the error itself.
 */
class SandboxRefusedError extends MigronautError {
  constructor(message, context, options) {
    super('SANDBOX_REFUSED', message, context, options);
    this.name = 'SandboxRefusedError';
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
  MigrationTimeoutError,
  TransactionsUnsupportedError,
  ConfigInvalidError,
  ConfigFileExistsError,
  ConnectionFailedError,
  NotAppliedError,
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
  OutOfOrderMigrationError,
  MigrationBlockedError,
  QueueJobInvalidError,
  QueueJobFailedError,
  ConvergeFailedError,
  RevisionConflictError,
  ShapeVersionError,
  BackgroundPendingError,
  BackgroundFailedError,
  BackgroundConflictError,
  SandboxRefusedError,
};
