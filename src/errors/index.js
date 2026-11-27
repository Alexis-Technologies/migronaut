/**
 * Every class takes `(message, options = {})`, as `Error` does: `options.cause` is the error it
 * wraps and `options.context` plain, JSON-safe data about the failure. Only this base class reads
 * `options.code` — each subclass sets its own. `options` goes to `Error` whole, so `cause` is set
 * only when given.
 *
 * Every instance has `code` and `context` (`{}` when nothing was given), so
 * code that reads an error never asks whether the field exists, and
 * `context.results` can be attached to any of them.
 *
 * The cause is a real Error, not a string, so `error.cause.stack` still points
 * into the user's own migration. Wrap sites additionally keep its redacted
 * message in `context.cause`, because that is what survives JSON
 * serialization for `--json` consumers.
 */
class MigronautError extends Error {
  constructor(message, options = {}) {
    const { code, context = {} } = options;
    super(message, options);
    this.name = 'MigronautError';
    this.code = code;
    this.context = context;
  }
}

class LockAlreadyHeldError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'LockAlreadyHeldError';
    this.code = 'ALX_ERR_LOCK_ALREADY_HELD';
  }
}

class LockReleaseFailedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'LockReleaseFailedError';
    this.code = 'ALX_ERR_LOCK_RELEASE_FAILED';
  }
}

/** The run stops rather than risk two processes migrating the same database at once. */
class LockLostError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'LockLostError';
    this.code = 'ALX_ERR_LOCK_LOST';
  }
}

/**
 * Thrown when a run is stopped before finishing — via `MigratorKit.stop()` or a
 * SIGINT/SIGTERM. Migrations already applied are listed in `context.results`.
 */
class RunAbortedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'RunAbortedError';
    this.code = 'ALX_ERR_RUN_ABORTED';
  }
}

/**
 * Thrown when a run is asked of a MigratorKit that already has one in flight, or when it is
 * disconnected under one: one instance runs one thing at a time, and a second run would clobber the
 * first one's state.
 */
class RunInFlightError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'RunInFlightError';
    this.code = 'ALX_ERR_RUN_IN_FLIGHT';
  }
}

class HookFailedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'HookFailedError';
    this.code = 'ALX_ERR_HOOK_FAILED';
  }
}

/** Thrown when `migronaut create` would overwrite an existing migration file */
class MigrationFileExistsError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MigrationFileExistsError';
    this.code = 'ALX_ERR_MIGRATION_FILE_EXISTS';
  }
}

class ChecksumMismatchError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ChecksumMismatchError';
    this.code = 'ALX_ERR_CHECKSUM_MISMATCH';
  }
}

class MigrationFileNotFoundError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MigrationFileNotFoundError';
    this.code = 'ALX_ERR_MIGRATION_FILE_NOT_FOUND';
  }
}

class MigrationInvalidNameError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MigrationInvalidNameError';
    this.code = 'ALX_ERR_MIGRATION_INVALID_NAME';
  }
}

class MigrationInvalidExportError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MigrationInvalidExportError';
    this.code = 'ALX_ERR_MIGRATION_INVALID_EXPORT';
  }
}

class MigrationLoadFailedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MigrationLoadFailedError';
    this.code = 'ALX_ERR_MIGRATION_LOAD_FAILED';
  }
}

class MigrationExecutionFailedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MigrationExecutionFailedError';
    this.code = 'ALX_ERR_MIGRATION_EXECUTION_FAILED';
  }
}

/**
 * Best-effort: the migration's own work cannot be cancelled, but the run stops instead of hanging,
 * letting the lock's TTL expire so other instances are not blocked forever.
 */
class MigrationTimeoutError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MigrationTimeoutError';
    this.code = 'ALX_ERR_MIGRATION_TIMEOUT';
  }
}

/** A dedicated code, because the driver's own error blames the migration. */
class TransactionsUnsupportedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'TransactionsUnsupportedError';
    this.code = 'ALX_ERR_TRANSACTIONS_UNSUPPORTED';
  }
}

class ConfigInvalidError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ConfigInvalidError';
    this.code = 'ALX_ERR_CONFIG_INVALID';
  }
}

class ConfigFileExistsError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ConfigFileExistsError';
    this.code = 'ALX_ERR_CONFIG_FILE_EXISTS';
  }
}

class ConnectionFailedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ConnectionFailedError';
    this.code = 'ALX_ERR_CONNECTION_FAILED';
  }
}

/** `cause` is the driver's error, `context.serverCode` the server's code when it gave one. */
class DatabaseOperationFailedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'DatabaseOperationFailedError';
    this.code = 'ALX_ERR_DATABASE_OPERATION_FAILED';
  }
}

class NotAppliedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'NotAppliedError';
    this.code = 'ALX_ERR_NOT_APPLIED';
  }
}

class ImportTargetNotEmptyError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ImportTargetNotEmptyError';
    this.code = 'ALX_ERR_IMPORT_TARGET_NOT_EMPTY';
  }
}

class IrreversibleMigrationError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'IrreversibleMigrationError';
    this.code = 'ALX_ERR_MIGRATION_IRREVERSIBLE';
  }
}

/**
 * Thrown by a bulk `up` under `onOutOfOrder: 'error'` when a pending migration
 * sorts before the newest applied one — a file merged late from a parallel
 * branch, which would otherwise run after migrations authored later and leave
 * environments with different effective apply orders.
 */
class OutOfOrderMigrationError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'OutOfOrderMigrationError';
    this.code = 'ALX_ERR_MIGRATION_OUT_OF_ORDER';
  }
}

/**
 * Thrown by an `ordered` single-file run that would apply or revert out of
 * sequence: an earlier migration is still pending (`up`), or one applied later
 * is still applied (`down`). `context.blockedBy` names what must go first.
 */
class MigrationBlockedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'MigrationBlockedError';
    this.code = 'ALX_ERR_MIGRATION_BLOCKED';
  }
}

/**
 * Thrown by the queue adapter when a job's payload fails the contract check.
 * Job data comes back from Redis, so it is untrusted input — never a config
 * mistake of the process that reads it.
 */
class QueueJobInvalidError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'QueueJobInvalidError';
    this.code = 'ALX_ERR_QUEUE_JOB_INVALID';
  }
}

class QueueClosedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'QueueClosedError';
    this.code = 'ALX_ERR_QUEUE_CLOSED';
  }
}

/**
 * Thrown by a queue group's `wait()` when one of its jobs failed or the wait
 * timed out. The worker's typed error does not cross the queue — only its
 * message does — so `context.failedReason` carries it and `context.results`
 * lists the jobs that finished before it.
 */
class QueueJobFailedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'QueueJobFailedError';
    this.code = 'ALX_ERR_QUEUE_JOB_FAILED';
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
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ConvergeFailedError';
    this.code = 'ALX_ERR_CONVERGE_FAILED';
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
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'RevisionConflictError';
    this.code = 'ALX_ERR_REVISION_CONFLICT';
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
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ShapeVersionError';
    this.code = 'ALX_ERR_SHAPE_VERSION_UNSUPPORTED';
  }
}

/**
 * Thrown when a migration `requires` a background migration that has not
 * completed yet — or whose collection still holds documents of the old shape.
 * Nothing was run: `context.waitsFor` names the background migrations it
 * waits for, with their status.
 */
class BackgroundPendingError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'BackgroundPendingError';
    this.code = 'ALX_ERR_BACKGROUND_PENDING';
  }
}

/**
 * Thrown when a background migration ended `failed` — a partition used up its
 * slice failures, the document error budget ran out, or old-shape documents
 * kept appearing for `maxPasses` passes. `context.migration` names it and
 * `context.lastError` says what happened last.
 */
class BackgroundFailedError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'BackgroundFailedError';
    this.code = 'ALX_ERR_BACKGROUND_FAILED';
  }
}

/**
 * Thrown when a control action does not fit the background migration's state
 * — pausing a completed one, resuming one that is not paused, retrying one
 * that is still running. `context.status` is the state it found and
 * `context.action` what was asked.
 */
class BackgroundConflictError extends MigronautError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'BackgroundConflictError';
    this.code = 'ALX_ERR_BACKGROUND_CONFLICT';
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
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'SandboxRefusedError';
    this.code = 'ALX_ERR_SANDBOX_REFUSED';
  }
}

module.exports = {
  MigronautError,
  LockAlreadyHeldError,
  LockReleaseFailedError,
  LockLostError,
  RunAbortedError,
  RunInFlightError,
  HookFailedError,
  MigrationFileExistsError,
  ChecksumMismatchError,
  MigrationFileNotFoundError,
  MigrationInvalidNameError,
  MigrationInvalidExportError,
  MigrationLoadFailedError,
  MigrationExecutionFailedError,
  MigrationTimeoutError,
  TransactionsUnsupportedError,
  ConfigInvalidError,
  ConfigFileExistsError,
  ConnectionFailedError,
  DatabaseOperationFailedError,
  NotAppliedError,
  ImportTargetNotEmptyError,
  IrreversibleMigrationError,
  OutOfOrderMigrationError,
  MigrationBlockedError,
  QueueJobInvalidError,
  QueueClosedError,
  QueueJobFailedError,
  ConvergeFailedError,
  RevisionConflictError,
  ShapeVersionError,
  BackgroundPendingError,
  BackgroundFailedError,
  BackgroundConflictError,
  SandboxRefusedError,
};
