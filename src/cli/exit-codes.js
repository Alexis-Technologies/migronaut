/**
 * Exit code per error code, so CI can branch on *why* a run failed instead of
 * only that it did. Anything unmapped exits 1, and success is still 0 — a
 * script testing `!= 0` is unaffected.
 *
 * Every MigronautError code has an entry (pinned by a superset test), plus
 * three CLI-condition codes that have no error class: PENDING_MIGRATIONS
 * (`status --check` found work), AUDIT_FAILED (an audit check failed) and
 * COLLECTIONS_DRIFT (`converge --check` found the database out of step with
 * the declared collections).
 *
 * Exported from the package root so a programmatic wrapper can mirror the
 * CLI's exit semantics without hardcoding numbers from the docs table. Kept
 * in its own module so importing the library never loads the CLI machinery.
 */
const EXIT_CODES = {
  PENDING_MIGRATIONS: 2,
  LOCK_ALREADY_HELD: 3,
  CHECKSUM_MISMATCH: 4,
  CONNECTION_FAILED: 5,
  CONFIG_INVALID: 6,
  MIGRATION_EXECUTION_FAILED: 7,
  MIGRATION_FILE_NOT_FOUND: 8,
  NOT_APPLIED: 9,
  LOCK_LOST: 10,
  RUN_ABORTED: 11,
  HOOK_FAILED: 12,
  MIGRATION_IRREVERSIBLE: 13,
  MIGRATION_TIMEOUT: 14,
  TRANSACTIONS_UNSUPPORTED: 15,
  CONFIG_FILE_EXISTS: 16,
  IMPORT_TARGET_NOT_EMPTY: 17,
  MIGRATION_FILE_EXISTS: 18,
  MIGRATION_INVALID_NAME: 19,
  MIGRATION_INVALID_EXPORT: 20,
  LOCK_RELEASE_FAILED: 21,
  AUDIT_FAILED: 22,
  MIGRATION_OUT_OF_ORDER: 23,
  MIGRATION_BLOCKED: 24,
  QUEUE_JOB_INVALID: 25,
  QUEUE_JOB_FAILED: 26,
  CONVERGE_FAILED: 27,
  COLLECTIONS_DRIFT: 28,
  REVISION_CONFLICT: 29,
  SHAPE_VERSION_UNSUPPORTED: 30,
  BACKGROUND_PENDING: 31,
  BACKGROUND_FAILED: 32,
  BACKGROUND_CONFLICT: 33,
  SANDBOX_REFUSED: 34,
};

module.exports = { EXIT_CODES };
