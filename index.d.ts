import type { ClientSession, Db, MongoClient } from 'mongodb';

// ─── Migration File Contract ───────────────────────────────────────────────────

/**
 * Structural stand-in for a Mongoose instance.
 *
 * Deliberately not `import type { Mongoose } from 'mongoose'`: mongoose is an
 * *optional* peer, and a hard import makes this declaration file fail to
 * resolve for the majority of users who never install it. A real `Mongoose` is
 * assignable to this.
 */
export interface MongooseLike {
  connection: unknown;
  model: (...args: never[]) => unknown;
}

/** Context object passed into every migration's up() and down() function */
export interface MigrationContext {
  /** Native MongoDB Db instance */
  db: Db;
  /** Native MongoClient instance — use for sessions/transactions */
  client: MongoClient;
  /** Mongoose instance — only present if passed in config */
  mongoose?: MongooseLike;
  /**
   * Active session, present only when this migration runs inside a transaction.
   * Pass it to your operations (e.g. `{ session }`) so they join the transaction.
   */
  session?: ClientSession;
}

/** Shape of an imported migration file module */
export interface MigrationModule {
  up: (ctx: MigrationContext) => Promise<void>;
  down: (ctx: MigrationContext) => Promise<void>;
  /** If true, wraps this migration in a MongoDB session + transaction */
  useTransaction?: boolean;
  /** Optional description shown in status table */
  description?: string;
}

// ─── Changelog ────────────────────────────────────────────────────────────────

export type MigrationStatus = 'applied' | 'reverted';

/**
 * Where a changelog record originated. `'migrate-mongo'` marks a record adopted
 * via `migronaut import`; such records are forward-only and cannot be reverted by migronaut.
 * Absent (or `'migronaut'`) means a natively-applied, reversible migration.
 */
export type MigrationOrigin = 'migronaut' | 'migrate-mongo';

/** A single record in the _migronaut_migrations changelog collection */
export interface MigrationRecord {
  /** Migration filename e.g. 20240526143021-add-users-index.ts */
  name: string;
  /** Sequential batch number. All migrations run together share the same batch */
  batch: number;
  status: MigrationStatus;
  appliedAt: Date;
  /** When this migration was applied the *first* time; survives a re-apply */
  firstAppliedAt?: Date;
  revertedAt?: Date;
  /** Execution time in milliseconds */
  duration: number;
  /** SHA-256 hash of the file at time of execution */
  checksum: string;
  /** Resolved environment at time of execution (config → NODE_ENV → 'production') */
  environment: string;
  /** Correlation id of the run that wrote this record; matches the lock's owner token */
  runId?: string;
  /** os.userInfo().username at time of execution */
  executedBy: string;
  /** Optional description from migration file */
  description?: string;
  /**
   * Origin of this record. Set to `'migrate-mongo'` for records adopted via
   * `migronaut import` — these are not reversible by migronaut. Absent for native records.
   */
  origin?: MigrationOrigin;
}

// ─── Config ───────────────────────────────────────────────────────────────────

/** Which migration in the run a per-migration hook is firing for */
export interface HookInfo {
  direction: 'up' | 'down';
  /** Zero-based position within this run's targets */
  index: number;
  total: number;
}

/** Outcome of the run, passed to `afterAll` */
export interface RunSummary {
  /** False when the run ended by throwing — `afterAll` runs either way */
  success: boolean;
  /** How many migrations were applied (or reverted) before the run ended */
  applied: number;
  direction: 'up' | 'down';
}

/**
 * Lifecycle hooks. A hook that throws fails the run with a
 * {@link HookFailedError} — it is never swallowed, and never surfaces as an
 * untyped Error.
 */
export interface MigrationHooks {
  /** Runs once before any migration in the batch starts */
  beforeAll?: (ctx: MigrationContext) => Promise<void>;
  /**
   * Runs once after the batch ends — including when it failed, so cleanup and
   * notification hooks still fire on the path where they matter most.
   */
  afterAll?: (ctx: MigrationContext, summary: RunSummary) => Promise<void>;
  /** Runs before each individual migration. Not fired for skipped migrations */
  beforeEach?: (name: string, ctx: MigrationContext, info: HookInfo) => Promise<void>;
  /** Runs after each individual migration completes successfully */
  afterEach?: (
    name: string,
    duration: number,
    ctx: MigrationContext,
    info: HookInfo,
  ) => Promise<void>;
  /** Runs when a migration throws — receives the error before it propagates */
  onError?: (name: string, error: Error, ctx: MigrationContext) => Promise<void>;
}

/** File type a created migration is written as */
export type MigrationExtension = 'ts' | 'js';

export interface MigronautConfig {
  /** MongoDB connection URI */
  uri: string;
  /** Database name */
  dbName: string;
  /** Path to migrations directory. Default: './migrations' */
  migrationsDir: string;
  /** Collection name for migration records. Default: '_migronaut_migrations' */
  migrationsCollection: string;
  /** Collection name for distributed lock. Default: '_migronaut_locks' */
  lockCollection: string;
  /** How long (seconds) a lock is considered stale. Default: 60 */
  lockTTLSeconds: number;
  /**
   * If true, abort when a migration file's checksum differs from what was applied.
   * If false, warn but continue. Default: false
   */
  strict: boolean;
  /** Wrap all migrations in transactions globally. Can be overridden per file. Default: false */
  useTransaction: boolean;
  /**
   * Create the changelog indexes on first connect. Default: true. Set false
   * when the application user has no index-creation rights and the indexes are
   * provisioned out of band.
   */
  ensureIndexes?: boolean;
  /** File extensions to scan. Default: ['.ts', '.js'] */
  fileExtensions: string[];
  /**
   * File type `migronaut create` generates by default. Overridden per run by the
   * `--js` / `--ts` flags. Default: 'js'
   */
  createExtension: MigrationExtension;
  /** Use sequential numbering (0001-) instead of timestamps. Default: false */
  sequential: boolean;
  /** Path to a custom migration template file */
  templatePath?: string;
  /**
   * `.env` file loaded before the config is resolved (it is what supplies the
   * `MIGRONAUT_*` variables). Relative to the working directory. Default:
   * `'.env'`; set `false` to load nothing, so a stray `.env` cannot silently
   * outrank a committed config.
   */
  envFile?: string | false;
  /**
   * Value stamped onto the `environment` field of changelog records. Falls back
   * to `process.env.NODE_ENV`, then to `'production'` — the safe assumption when
   * nothing says otherwise.
   */
  environment?: string;
  /**
   * What to do when the lock is lost mid-run (another process reclaimed it, or
   * the heartbeat cannot reach the database).
   *
   * - `'abort'` (default) — stop after the migration in flight and throw a
   *   {@link LockLostError}, rather than risk two processes migrating at once.
   * - `'warn'` — log and keep going.
   */
  onLockLost?: 'abort' | 'warn';
  /** Mongoose instance — required only if your migrations use Mongoose models */
  mongoose?: MongooseLike;
  hooks?: MigrationHooks;
  /** Custom logger — set to null to silence all output (useful in tests) */
  logger?: MigronautLogger | null;
}

/**
 * What a config file (`migronaut.config.{ts,js}`) may export: either a config object
 * or a (sync or async) factory that returns one. The factory form is resolved
 * at load time, so you can fetch values — e.g. a connection `uri` from AWS
 * Secrets Manager or Google Secret Manager — without ever writing them to disk.
 *
 * The fetched value lives in memory for that command only; the config file
 * itself is never rewritten. JSON config files cannot use the factory form.
 */
export type MigronautConfigInput =
  | Partial<MigronautConfig>
  | (() => Partial<MigronautConfig> | Promise<Partial<MigronautConfig>>);

// ─── Logger ───────────────────────────────────────────────────────────────────

/**
 * Pino-compatible logger surface: any object with these four methods works,
 * including a real pino instance (its optional `child` is used to bind a
 * `component` field when present).
 */
export interface MigronautLogger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  /**
   * Present on pino-style loggers. When it is, migronaut binds a `component`
   * field once *and* passes structured fields as the first argument, matching
   * pino's own `(obj, msg)` signature.
   */
  child?: (bindings: Record<string, unknown>) => MigronautLogger;
}

/**
 * A log sink. The optional second argument carries structured fields —
 * `{ runId, migration, direction, batch, durationMs }` — so a machine-readable
 * logger does not have to parse the human string. A plain `(msg) => …` logger
 * remains valid: the extra argument is simply ignored.
 */
export type LogMethod = (msg: string, fields?: Record<string, unknown>) => void;

// ─── Progress Reporter ─────────────────────────────────────────────────────────

/**
 * Receives migration lifecycle callbacks so a presentation layer (e.g. an ora
 * spinner) can react. Deliberately separate from {@link MigrationHooks}: hooks
 * run user DB logic inside the migration; this only drives a UI indicator and
 * never touches the database.
 */
export interface ProgressReporter {
  /** A migration's up()/down() is about to execute */
  onStart: (name: string, direction: 'up' | 'down') => void;
  /**
   * The in-flight migration finished — stop any indicator. `outcome` says
   * whether it succeeded, for reporters that render more than a spinner.
   */
  onStop: (outcome?: 'success' | 'error') => void;
}

// ─── Results ──────────────────────────────────────────────────────────────────

export type RunResultStatus = 'applied' | 'reverted' | 'skipped' | 'error';

export interface RunResult {
  file: string;
  status: RunResultStatus;
  duration?: number;
  batch?: number;
  reason?: string;
  error?: string;
}

export interface StatusRow {
  file: string;
  status: 'applied' | 'pending';
  batch: number | null;
  appliedAt: Date | null;
  duration: number | null;
  /** null = never applied, true = match, false = mismatch */
  checksumOk: boolean | null;
  description?: string;
}

// ─── Import (migrate-mongo adoption) ────────────────────────────────────────────

/**
 * The shape of a record in a migrate-mongo `changelog` collection. Only
 * `fileName` and `appliedAt` are guaranteed; `fileHash` exists only when
 * migrate-mongo ran with `useFileHash`, and `migrationBlock` only on newer
 * versions.
 */
export interface MigrateMongoDoc {
  fileName: string;
  appliedAt: Date;
  fileHash?: string;
  migrationBlock?: number;
}

/** How an imported record's checksum was resolved */
export type ImportChecksumSource = 'reused' | 'recomputed' | 'missing';

/** One mapped row produced by `migronaut import` */
export interface ImportRow {
  file: string;
  batch: number;
  appliedAt: Date;
  checksum: string;
  checksumSource: ImportChecksumSource;
}

/** Outcome of an `migronaut import` run */
export interface ImportResult {
  /** Source collection that was read (e.g. `changelog`) */
  source: string;
  /** Target collection records were written to (e.g. `_migronaut_migrations`) */
  target: string;
  /** Number of records written (0 when `dryRun` is true) */
  imported: number;
  /** Number of source docs skipped as invalid (missing `fileName`) */
  skipped: number;
  /** True when the run previewed only and wrote nothing */
  dryRun: boolean;
  /** The mapped rows, in apply order */
  rows: ImportRow[];
}

// ─── Lock ─────────────────────────────────────────────────────────────────────

/** Public view of the current holder of the migration lock */
export interface LockInfo {
  /** When the lock was acquired (or last renewed) */
  lockedAt: Date;
  /** OS process id of the holder */
  pid: number;
  /** Hostname of the holder */
  host: string;
  /** Username of the holder */
  executedBy: string;
}

// ─── Error Codes ──────────────────────────────────────────────────────────────

export type MigronautErrorCode =
  | 'LOCK_ALREADY_HELD'
  | 'LOCK_RELEASE_FAILED'
  | 'LOCK_LOST'
  | 'RUN_ABORTED'
  | 'HOOK_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'MIGRATION_FILE_NOT_FOUND'
  | 'MIGRATION_FILE_EXISTS'
  | 'MIGRATION_INVALID_NAME'
  | 'MIGRATION_INVALID_EXPORT'
  | 'MIGRATION_EXECUTION_FAILED'
  | 'CONFIG_INVALID'
  | 'CONFIG_FILE_EXISTS'
  | 'CONNECTION_FAILED'
  | 'NOT_APPLIED'
  | 'IMPORT_TARGET_NOT_EMPTY'
  | 'MIGRATION_IRREVERSIBLE';

// ─── Config file format ─────────────────────────────────────────────────────────

/** File format for a generated config file */
export type ConfigFormat = 'ts' | 'js' | 'json';

// ─── MigratorKit ────────────────────────────────────────────────────────────────

/** Options for {@link MigratorKit.up} */
export interface UpOptions {
  /** Skip lock acquisition (dev only) */
  noLock?: boolean;
  /**
   * Re-run a migration even if it is already applied. Only meaningful together
   * with a specific filename — a standalone `up` only ever targets pending
   * files, so `force` has no applied target to re-run.
   */
  force?: boolean;
  /**
   * Apply each migration in this run as its own batch (sequential, one per file)
   * instead of grouping the whole run into a single shared batch. This lets a
   * later `down` peel migrations off one at a time. Mirrors Laravel's
   * `migrate --step`.
   */
  step?: boolean;
}

/** Options for {@link MigratorKit.down} */
export interface DownOptions {
  /** Skip lock acquisition (dev only) */
  noLock?: boolean;
  /** Revert a specific batch number instead of the last batch */
  batch?: number;
  /**
   * Revert the last N applied migrations (counted as individual files, newest
   * first), regardless of how they were grouped into batches. Mirrors Laravel's
   * `migrate:rollback --step=N`. Mutually exclusive with `batch` and a filename.
   */
  steps?: number;
}

/** Options for {@link MigratorKit.redo} */
export interface RedoOptions {
  /** Skip lock acquisition (dev only) */
  noLock?: boolean;
}

/** Options for {@link MigratorKit.create} */
export interface CreateOptions {
  /** Path to a custom template file */
  template?: string;
  /** Generate a `.js` file instead of `.ts` */
  js?: boolean;
}

/** Options for {@link MigratorKit.init} */
export interface InitOptions {
  /** Config file format. Default: 'js' */
  format?: ConfigFormat;
  /** Overwrite an existing config file */
  force?: boolean;
  /**
   * Generate a runtime secret-loading config (an async factory that fetches the
   * connection from a secret manager) instead of a static object. Only valid
   * for `js`/`ts` formats.
   */
  secretProvider?: boolean;
}

/** Options for {@link MigratorKit.import} */
export interface ImportOptions {
  /** Source collection to read. Default: `changelog` (migrate-mongo's default) */
  from?: string;
  /** Target collection to write. Default: the config's `migrationsCollection` */
  to?: string;
  /** Preview the mapping without writing anything */
  dryRun?: boolean;
  /** Reuse the source `fileHash` verbatim instead of recomputing from disk */
  trustHash?: boolean;
  /** Proceed even when the target changelog already has records */
  force?: boolean;
  /** Skip lock acquisition (dev only) */
  noLock?: boolean;
}

/** Additional construction options for {@link MigratorKit} */
export interface MigratorKitOptions {
  /** Explicit config file path — overrides auto-discovery */
  configPath?: string;
  /**
   * Optional lifecycle reporter, invoked around each migration's execution so a
   * UI (the CLI's ora spinner) can show progress. Core never imports a spinner
   * library — it only calls these callbacks.
   */
  progress?: ProgressReporter;
}

/**
 * The main orchestration class. Every CLI command delegates here. Holds a
 * partial config that is resolved (merged with env/file/defaults) on first use.
 */
export class MigratorKit {
  constructor(config?: Partial<MigronautConfig>, options?: MigratorKitOptions);

  /** Connect to MongoDB and ensure changelog indexes exist */
  connect(): Promise<void>;
  /** Disconnect from MongoDB */
  disconnect(): Promise<void>;
  /**
   * Inspect the current migration lock without modifying it. Returns the holder,
   * or null when no lock is held.
   */
  lockInfo(): Promise<LockInfo | null>;
  /**
   * Force-release the migration lock regardless of who holds it — for clearing a
   * lock left behind by a crashed run (`migronaut unlock`). Returns the holder that was
   * removed, or null if no lock was held.
   */
  forceUnlock(): Promise<LockInfo | null>;
  /** Run all pending migrations, or a specific named file */
  up(filename?: string, options?: UpOptions): Promise<RunResult[]>;
  /** Rollback the last batch, a specific batch, a specific file, or the last N steps */
  down(filename?: string, options?: DownOptions): Promise<RunResult[]>;
  /**
   * Rollback then re-apply: the last applied migration, or a specific file.
   * Both directions run under a single lock, so no other process can slip in
   * while the migration is reverted.
   */
  redo(filename?: string, options?: RedoOptions): Promise<RunResult[]>;
  /**
   * Stop the run in progress: the migration currently executing finishes, the
   * remaining ones are skipped, the lock is released, and the in-flight call
   * rejects with a {@link RunAbortedError} whose `context.results` lists what
   * was applied. No-op when nothing is running.
   */
  stop(reason?: string): void;
  /** Preview what would run — never writes to the database */
  dryRun(
    direction: 'up' | 'down',
    filename?: string,
    options?: { steps?: number; batch?: number },
  ): Promise<StatusRow[]>;
  /** Full migration status for all known files and records */
  status(): Promise<StatusRow[]>;
  /** Filtered list of migrations */
  list(filter: 'all' | 'pending' | 'applied'): Promise<StatusRow[]>;
  /** Create a new migration file and return its absolute path */
  create(name: string, options?: CreateOptions): Promise<string>;
  /** Create a migronaut config file in the working directory and return its path */
  init(options?: InitOptions): Promise<string>;
  /**
   * Adopt an existing migrate-mongo `changelog` collection by mapping its
   * records into our schema and writing them to `migrationsCollection`.
   */
  import(options?: ImportOptions): Promise<ImportResult>;
}

// ─── Programmatic entry points ─────────────────────────────────────────────────

/** What to do when another process already holds the migration lock */
export type OnLockHeld = 'throw' | 'wait';

/** Options for {@link runMigrations} */
export interface RunMigrationsOptions extends MigratorKitOptions {
  /** Skip lock acquisition (dev only — never in production) */
  noLock?: boolean;
  /**
   * How to react when another process already holds the migration lock — the
   * typical case when several app instances boot at once.
   * - `'throw'` (default): propagate {@link LockAlreadyHeldError}.
   * - `'wait'`: poll until the lock frees, then run.
   */
  onLockHeld?: OnLockHeld;
  /** Max time (ms) to wait when `onLockHeld: 'wait'`. Default: 30000 */
  lockWaitTimeoutMs?: number;
  /** Poll interval (ms) while waiting for the lock. Default: 500 */
  lockPollIntervalMs?: number;
}

/** Outcome of a {@link runMigrations} call */
export interface MigrationSummary {
  /** Migrations applied during this call (empty when nothing was pending) */
  applied: RunResult[];
  /** True when no migrations were pending — the database was already up to date */
  upToDate: boolean;
  /** True when this instance waited for a peer to release the lock before running */
  waited: boolean;
}

/**
 * Run all pending migrations and return a summary — the blessed one-call entry
 * point for application startup, deploy hooks, serverless cold starts, and test
 * setup. Always disconnects in a `finally`, so a failure never leaks a MongoDB
 * connection.
 */
export function runMigrations(
  config?: Partial<MigronautConfig>,
  options?: RunMigrationsOptions,
): Promise<MigrationSummary>;

/**
 * Return the migrations that have not yet been applied — a connection-managed
 * readiness probe. Opens its own connection and always disconnects in a `finally`.
 */
export function pendingMigrations(
  config?: Partial<MigronautConfig>,
  options?: MigratorKitOptions,
): Promise<StatusRow[]>;

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Base error for all migronaut failures. Carries a typed code and context */
export class MigronautError extends Error {
  readonly code: MigronautErrorCode;
  readonly context?: Record<string, unknown>;
  constructor(code: MigronautErrorCode, message: string, context?: Record<string, unknown>);
}

/** Thrown when a lock is already held by another process within its TTL */
export class LockAlreadyHeldError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when releasing a lock fails */
export class LockReleaseFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when a file's checksum differs from the one recorded at apply time */
export class ChecksumMismatchError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when a referenced migration file does not exist on disk */
export class MigrationFileNotFoundError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/**
 * Thrown when a migration name is not a plain filename — e.g. it contains a
 * path separator or `..`, which would let a target escape the migrations
 * directory (path traversal) when joined into a filesystem path.
 */
export class MigrationInvalidNameError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when a migration file does not export valid up()/down() functions */
export class MigrationInvalidExportError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when a migration's up() or down() throws during execution */
export class MigrationExecutionFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when the merged configuration fails validation */
export class ConfigInvalidError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when creating a config file that already exists without `--force` */
export class ConfigFileExistsError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when connecting to MongoDB fails */
export class ConnectionFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/**
 * Thrown when the lock is lost while migrations are still running — another
 * process reclaimed it, or the heartbeat could not reach the database. Set
 * `onLockLost: 'warn'` to downgrade this to a warning.
 */
export class LockLostError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/**
 * Thrown when a run is stopped before finishing — via {@link MigratorKit.stop}
 * or a SIGINT/SIGTERM. `context.results` lists what was applied first.
 */
export class RunAbortedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when a user-supplied lifecycle hook throws */
export class HookFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when `create` would overwrite an existing migration file */
export class MigrationFileExistsError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when attempting to revert a migration that was never applied */
export class NotAppliedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when `migronaut import` targets a non-empty changelog without `--force` */
export class ImportTargetNotEmptyError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}

/** Thrown when attempting to roll back a migrate-mongo-imported (forward-only) migration */
export class IrreversibleMigrationError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>);
}
