import { EventEmitter } from 'node:events';
import type { ClientSession, Db, MongoClient, MongoClientOptions } from 'mongodb';

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
  /**
   * Aborted when the run is stopping — the lock was lost, `stop()` was called,
   * or a SIGINT/SIGTERM arrived. A long migration can watch this to exit early;
   * migronaut cannot interrupt a running function by itself.
   */
  signal?: AbortSignal;
}

/** Shape of an imported migration file module */
export interface MigrationModule {
  up: (ctx: MigrationContext) => Promise<void>;
  down: (ctx: MigrationContext) => Promise<void>;
  /** If true, wraps this migration in a MongoDB session + transaction */
  useTransaction?: boolean;
  /** Overrides `MigronautConfig.timeoutMs` for this migration only */
  timeoutMs?: number;
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
  /** Who ran it: `MIGRONAUT_USER` if set, otherwise `os.userInfo().username` */
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

/**
 * Every **scalar** option below is also settable from the environment as
 * `MIGRONAUT_<SCREAMING_SNAKE>` (`migrationsDir` → `MIGRONAUT_MIGRATIONS_DIR`,
 * with `dbName` → `MIGRONAUT_DB`, `migrationsCollection` → `MIGRONAUT_COLLECTION`
 * and `lockTTLSeconds` → `MIGRONAUT_LOCK_TTL` as the shortened exceptions), which
 * is what makes a config file genuinely optional. Env vars outrank the config
 * file and are outranked by CLI flags. A value that does not parse is rejected
 * with a {@link ConfigInvalidError} naming the variable — never coerced.
 *
 * `fileExtensions`, `clientOptions` and the live handles (`client`, `mongoose`,
 * `hooks`, `logger`) are config-file/API only: a single environment string
 * cannot express them.
 */
export interface MigronautConfig {
  /** MongoDB connection URI. Not required when `client` is supplied */
  uri: string;
  /**
   * Driver options passed to `new MongoClient(uri, options)` — the escape hatch
   * for everything a connection string cannot express: TLS certificates,
   * AWS IAM / X.509 authentication, proxies, pool sizing, read preferences.
   */
  clientOptions?: MongoClientOptions;
  /**
   * An already-connected client to reuse instead of opening one. Ownership
   * stays with the caller: `disconnect()` leaves it open, so migrations at
   * application startup can share the app's own pool.
   */
  client?: MongoClient;
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
   * Abort the run when a single migration exceeds this many milliseconds.
   * Best-effort: the migration's own work cannot be cancelled, but the run
   * stops instead of hanging, which also lets the lock's TTL expire so other
   * instances are not blocked forever. A migration can watch `ctx.signal` to
   * bail out itself. Override per file with `export const timeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Bypass Node's ESM module cache when loading migration files. Only useful in
   * a long-lived process that runs migrations more than once (a test runner, a
   * dev server) — each load then leaks a module, which a one-shot CLI never
   * needs to care about. Default: false
   */
  reloadMigrations?: boolean;
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
  /**
   * Present (true) when the changelog record's name is not a plain filename —
   * a legacy or tampered record. The row is reported as-is instead of failing
   * the whole status/audit call.
   */
  invalid?: true;
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
  | 'MIGRATION_TIMEOUT'
  | 'TRANSACTIONS_UNSUPPORTED'
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
  /**
   * Apply pending migrations up to and including this file, then stop. Useful
   * for staged rollouts and for reproducing a database at a known point.
   * Mutually exclusive with a filename and `steps`.
   */
  to?: string;
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
  /**
   * Revert everything applied *after* this migration; the named one stays
   * applied. Exclusive, so `up --to X` then `down --to X` is a round trip back
   * to the same state. Mutually exclusive with `batch`, `steps` and a filename.
   */
  to?: string;
}

/** Payload common to every lifecycle event */
export interface MigronautEventBase {
  /** Correlation id of the run, matching the lock owner and changelog records */
  runId?: string;
}

export interface MigrationEvent extends MigronautEventBase {
  migration: string;
  direction: 'up' | 'down';
  batch?: number;
  durationMs?: number;
  /**
   * Human-readable failure message (on `migration:error` only), with URI
   * credentials already redacted — safe to ship to metrics/alerting as-is.
   */
  error?: string;
  /** Why the migration was skipped (on `migration:skipped` only) */
  reason?: string;
}

export interface RunStartEvent extends MigronautEventBase {
  /** Which command started the run: 'up' | 'down' | 'redo' | 'import' */
  command?: string;
  direction?: 'up' | 'down';
}

export interface RunEndEvent extends MigronautEventBase {
  success: boolean;
  /** Same identification as {@link RunStartEvent} */
  command?: string;
  direction?: 'up' | 'down';
  /** Wall-clock duration of the whole run, lock wait included */
  durationMs?: number;
  /**
   * Result counts — present when the run produced a result list, including
   * the failure path (counted from the partial results the error carries)
   */
  applied?: number;
  reverted?: number;
  total?: number;
  /** Redacted failure message — URI credentials are already masked */
  error?: string;
}

export interface LockEvent extends MigronautEventBase {
  owner?: string;
  reason?: string;
  /** True when acquisition was skipped via `noLock` — no real lock existed */
  skipped?: boolean;
  /** Lock TTL in ms (on `lock:acquired`) */
  ttlMs?: number;
  /** How long acquisition took in ms (on `lock:acquired`) */
  acquireMs?: number;
}

/**
 * Lifecycle events emitted by {@link MigratorKit}. Subscribe to feed metrics or
 * alerting without parsing log lines; a listener that throws is contained and
 * never fails the run.
 */
export interface MigronautEvents {
  'run:start': (event: RunStartEvent) => void;
  'run:end': (event: RunEndEvent) => void;
  'migration:start': (event: MigrationEvent) => void;
  'migration:success': (event: MigrationEvent) => void;
  'migration:skipped': (event: MigrationEvent) => void;
  'migration:error': (event: MigrationEvent) => void;
  'lock:acquired': (event: LockEvent) => void;
  'lock:released': (event: LockEvent) => void;
  'lock:lost': (event: LockEvent) => void;
}

/** One check performed by {@link MigratorKit.audit} */
export interface AuditCheck {
  /** e.g. 'config', 'connection', 'transactions', 'indexes', 'lock', 'checksums' */
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

/** Result of {@link MigratorKit.audit} — read-only; nothing is changed */
export interface AuditReport {
  /** True when no check failed. Warnings do not clear this flag */
  ok: boolean;
  failed: number;
  warnings: number;
  checks: AuditCheck[];
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
  /**
   * Force a `.js` (`true`) or `.ts` (`false`) file, overriding the config's
   * `createExtension`. Leave unset to let the config decide (default: `'js'`).
   */
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
  /**
   * Logger used only when the resolved config supplies no `logger` of its own.
   * This is how the CLI injects its console logger without clobbering a
   * `logger` (pino, or `null` for silence) declared in the user's config file.
   * Programmatic callers usually set `config.logger` instead.
   */
  fallbackLogger?: MigronautLogger | null;
}

/**
 * The main orchestration class. Every CLI command delegates here. Holds a
 * partial config that is resolved (merged with env/file/defaults) on first use.
 *
 * Extends Node's EventEmitter — see {@link MigronautEvents} for the lifecycle
 * events you can subscribe to.
 */
export class MigratorKit extends EventEmitter {
  constructor(config?: Partial<MigronautConfig>, options?: MigratorKitOptions);

  /** Connect to MongoDB and ensure changelog indexes exist */
  connect(): Promise<void>;
  /**
   * The resolved logger — silent when config sets `logger: null`. Meaningful
   * after `connect()` (before it, a config file's logger is not loaded yet).
   */
  readonly logger: MigronautLogger;
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
  on<E extends keyof MigronautEvents>(event: E, listener: MigronautEvents[E]): this;
  once<E extends keyof MigronautEvents>(event: E, listener: MigronautEvents[E]): this;
  off<E extends keyof MigronautEvents>(event: E, listener: MigronautEvents[E]): this;
  /**
   * Stop the current or imminently-starting run: the migration currently
   * executing finishes, the remaining ones are skipped, the lock is released,
   * and the in-flight call rejects with a {@link RunAbortedError} whose
   * `context.results` lists what was applied. A stop that arrives while config
   * is loading or the connection is opening is remembered and applied as soon
   * as the run reaches its lock; a pending stop is cleared when a run ends, so
   * it can never abort a later, unrelated run.
   */
  stop(reason?: string): void;
  /** Preview what would run — never writes to the database */
  dryRun(
    direction: 'up' | 'down',
    filename?: string,
    options?: { steps?: number; batch?: number; to?: string },
  ): Promise<StatusRow[]>;
  /** Full migration status for all known files and records */
  status(): Promise<StatusRow[]>;
  /**
   * Read-only health check: configuration, connectivity, transaction support,
   * changelog indexes, lock state, checksum drift and runtime. Reports
   * problems; fixes none of them.
   */
  audit(): Promise<AuditReport>;
  /** Filtered list of migrations. Default: 'all' */
  list(filter?: 'all' | 'pending' | 'applied'): Promise<StatusRow[]>;
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
  /**
   * Max time (ms) to wait when `onLockHeld: 'wait'`. Default: 90000 — sized to
   * outlast a peer's typical run plus one lock TTL, so parallel deploys don't
   * give up while a healthy peer is still migrating.
   */
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
  /** Total time (ms) spent waiting for a peer's lock. 0 when the lock was free */
  waitedMs: number;
  /** Number of `up` attempts made — 1 when the lock was free on the first try */
  attempts: number;
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

/**
 * The CLI's exit-code map: one entry per {@link MigronautErrorCode}, plus two
 * CLI-condition codes with no error class — `PENDING_MIGRATIONS` (from
 * `status --check`) and `AUDIT_FAILED`. Lets a wrapper script mirror the
 * CLI's exit semantics without hardcoding numbers. Anything unmapped exits 1;
 * success is 0.
 */
export const EXIT_CODES: Readonly<
  Record<MigronautErrorCode | 'PENDING_MIGRATIONS' | 'AUDIT_FAILED', number>
>;

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Construction options shared by every migronaut error — `cause` keeps the wrapped Error */
export interface MigronautErrorOptions {
  cause?: unknown;
}

/** Base error for all migronaut failures. Carries a typed code and context */
export class MigronautError extends Error {
  readonly code: MigronautErrorCode;
  readonly context?: Record<string, unknown>;
  constructor(
    code: MigronautErrorCode,
    message: string,
    context?: Record<string, unknown>,
    options?: MigronautErrorOptions,
  );
}

/** Thrown when a lock is already held by another process within its TTL */
export class LockAlreadyHeldError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when releasing a lock fails */
export class LockReleaseFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when a file's checksum differs from the one recorded at apply time */
export class ChecksumMismatchError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when a referenced migration file does not exist on disk */
export class MigrationFileNotFoundError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown when a migration name is not a plain filename — e.g. it contains a
 * path separator or `..`, which would let a target escape the migrations
 * directory (path traversal) when joined into a filesystem path.
 */
export class MigrationInvalidNameError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when a migration file does not export valid up()/down() functions */
export class MigrationInvalidExportError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when a migration's up() or down() throws during execution */
export class MigrationExecutionFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when the merged configuration fails validation */
export class ConfigInvalidError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when creating a config file that already exists without `--force` */
export class ConfigFileExistsError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when connecting to MongoDB fails */
export class ConnectionFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown when the lock is lost while migrations are still running — another
 * process reclaimed it, or the heartbeat could not reach the database. Set
 * `onLockLost: 'warn'` to downgrade this to a warning.
 */
export class LockLostError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown when a run is stopped before finishing — via {@link MigratorKit.stop}
 * or a SIGINT/SIGTERM. `context.results` lists what was applied first.
 */
export class RunAbortedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown when a migration exceeds its `timeoutMs`. Best-effort: the migration's
 * own work keeps running, but the run stops rather than hanging.
 */
export class MigrationTimeoutError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown when `useTransaction` is on but the deployment cannot run
 * transactions (a standalone server — they need a replica set or mongos).
 */
export class TransactionsUnsupportedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when a user-supplied lifecycle hook throws */
export class HookFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when `create` would overwrite an existing migration file */
export class MigrationFileExistsError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when attempting to revert a migration that was never applied */
export class NotAppliedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when `migronaut import` targets a non-empty changelog without `--force` */
export class ImportTargetNotEmptyError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** Thrown when attempting to roll back a migrate-mongo-imported (forward-only) migration */
export class IrreversibleMigrationError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}
