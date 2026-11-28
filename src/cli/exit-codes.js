/**
 * Exit code per error code, so CI can branch on *why* a run failed instead of
 * only that it did. Anything unmapped exits 1, and success is still 0 — a
 * script testing `!= 0` is unaffected.
 *
 * Every MigronautError code has an entry (pinned by a superset test), plus
 * three CLI-condition codes that have no error class: ALX_ERR_PENDING_MIGRATIONS
 * (`status --check` found work), ALX_ERR_AUDIT_FAILED (an audit check failed) and
 * ALX_ERR_COLLECTIONS_DRIFT (`converge --check` found the database out of step with
 * the declared collections).
 *
 * Exported from the package root so a programmatic wrapper can mirror the
 * CLI's exit semantics without hardcoding numbers from the docs table. Kept
 * in its own module so importing the library never loads the CLI machinery.
 * Frozen, with no prototype: the CLI reads this very object, so a consumer's
 * write would change its exit codes for the whole process, and a code read
 * from an error must never find `toString`.
 */
const EXIT_CODES = Object.freeze({
  __proto__: null,
  ALX_ERR_PENDING_MIGRATIONS: 2,
  ALX_ERR_LOCK_ALREADY_HELD: 3,
  ALX_ERR_CHECKSUM_MISMATCH: 4,
  ALX_ERR_CONNECTION_FAILED: 5,
  ALX_ERR_CONFIG_INVALID: 6,
  ALX_ERR_MIGRATION_EXECUTION_FAILED: 7,
  ALX_ERR_MIGRATION_FILE_NOT_FOUND: 8,
  ALX_ERR_NOT_APPLIED: 9,
  ALX_ERR_LOCK_LOST: 10,
  ALX_ERR_RUN_ABORTED: 11,
  ALX_ERR_HOOK_FAILED: 12,
  ALX_ERR_MIGRATION_IRREVERSIBLE: 13,
  ALX_ERR_MIGRATION_TIMEOUT: 14,
  ALX_ERR_TRANSACTIONS_UNSUPPORTED: 15,
  ALX_ERR_CONFIG_FILE_EXISTS: 16,
  ALX_ERR_IMPORT_TARGET_NOT_EMPTY: 17,
  ALX_ERR_MIGRATION_FILE_EXISTS: 18,
  ALX_ERR_MIGRATION_INVALID_NAME: 19,
  ALX_ERR_MIGRATION_INVALID_EXPORT: 20,
  ALX_ERR_LOCK_RELEASE_FAILED: 21,
  ALX_ERR_AUDIT_FAILED: 22,
  ALX_ERR_MIGRATION_OUT_OF_ORDER: 23,
  ALX_ERR_MIGRATION_BLOCKED: 24,
  ALX_ERR_QUEUE_JOB_INVALID: 25,
  ALX_ERR_QUEUE_JOB_FAILED: 26,
  ALX_ERR_CONVERGE_FAILED: 27,
  ALX_ERR_COLLECTIONS_DRIFT: 28,
  ALX_ERR_REVISION_CONFLICT: 29,
  ALX_ERR_SHAPE_VERSION_UNSUPPORTED: 30,
  ALX_ERR_BACKGROUND_PENDING: 31,
  ALX_ERR_BACKGROUND_FAILED: 32,
  ALX_ERR_BACKGROUND_CONFLICT: 33,
  ALX_ERR_SANDBOX_REFUSED: 34,
  ALX_ERR_MIGRATION_LOAD_FAILED: 35,
  ALX_ERR_DATABASE_OPERATION_FAILED: 36,
  ALX_ERR_QUEUE_CLOSED: 37,
  ALX_ERR_RUN_IN_FLIGHT: 38,
});

module.exports = { EXIT_CODES };
