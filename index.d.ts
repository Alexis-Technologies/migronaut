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
  /**
   * The kit's logger, with this run's correlation ({@link run}) bound into the
   * fields of every line. A call whose fields hold `userland: true` is also
   * emitted as the `migration:log` event, for the application to store and show
   * its users — migronaut stores none of it:
   *
   * ```js
   * logger.info('batch done', { userland: true, processed: 1000 });
   * ```
   *
   * Always present when migronaut runs the migration; optional so a context
   * built by hand (in a test) still type-checks.
   * @experimental New in 2.4
   */
  logger?: MigronautLogger;
  /**
   * Who this is: the run id, the migration, the direction, the transaction
   * attempt and, when the caller named them, the queue job and the actor.
   * Frozen; the same values `logger` binds and `migration:log` carries.
   * Always present when migronaut runs the migration.
   * @experimental New in 2.4
   */
  run?: MigrationRunInfo;
}

/**
 * The correlation of a run, as `ctx.run`. `migration`, `batch` and `attempt`
 * describe one migration and are absent in `beforeAll`/`afterAll`.
 * @experimental New in 2.4
 */
export interface MigrationRunInfo {
  /** The run id — the same on the lock, the changelog record and every event of the run */
  readonly id: string;
  readonly direction: 'up' | 'down';
  /** The migration file */
  readonly migration?: string;
  /** The changelog batch (`up` only) */
  readonly batch?: number;
  /**
   * 1 — or more when a transaction was retried and the body runs again. Not a
   * queue retry: a migration job is never retried.
   */
  readonly attempt?: number;
  /** The queue job that runs this migration (set by the BullMQ adapter, or the `job` option) */
  readonly jobId?: string;
  /** The queue group the job belongs to */
  readonly groupId?: string;
  /** Who asked for the run (`requestedBy` option) */
  readonly requestedBy?: string;
  /** Why (`reason` option) */
  readonly reason?: string;
}

/** Shape of an imported migration file module */
export interface MigrationModule {
  up: (ctx: MigrationContext) => Promise<void>;
  down: (ctx: MigrationContext) => Promise<void>;
  /**
   * Background migrations (file names, each sorting before this file) that
   * must have completed before this migration runs.
   * @experimental New in 2.3
   */
  requires?: readonly string[];
  /** If true, wraps this migration in a MongoDB session + transaction */
  useTransaction?: boolean;
  /** Overrides `MigronautConfig.timeoutMs` for this migration only */
  timeoutMs?: number;
  /** Optional description shown in status table */
  description?: string;
}

// ─── Document shapes and background migrations ───────────────────────────────

/** The system field names of a versioned collection — `revisionField` is `null` without revisions */
export interface ShapeFieldNames {
  field: string;
  revisionField: string | null;
}

/** The default system field names: `__v` and `__rev` */
export interface DefaultShapeFieldNames {
  field: '__v';
  revisionField: '__rev';
}

/**
 * A document type without its system fields (the version and the revision),
 * distributed over a union. What a shape body is declared as, and what a
 * background transformation returns: migronaut writes the system fields.
 * @experimental New in 2.3
 */
export type Body<T, N extends ShapeFieldNames = DefaultShapeFieldNames> = T extends unknown
  ? Omit<T, N['field'] | Extract<N['revisionField'], string>>
  : never;

/**
 * What a background migration's transformation gets besides the document.
 * `session`, `db` and `client` are there only in a `transaction` background
 * migration — writes to other collections must pass `session` to commit
 * with the batch.
 * @experimental New in 2.3
 */
export interface BackgroundMigrationContext {
  /** Aborted when the slice is stopping (lease lost, pause, shutdown) */
  signal: AbortSignal;
  /**
   * The kit's logger with {@link background} bound into every line. Fields
   * with `userland: true` also emit `migration:log` (`kind: 'background'`) —
   * but `migrate` runs once per document, and again for a document a
   * concurrent write moved: log from `migrateBatch` or a `step` rather than
   * per document. In a dry run the lines say `dryRun: true` and nothing is
   * emitted.
   */
  logger: MigronautLogger;
  direction: 'forward' | 'revert';
  /** Where this runs — frozen */
  background: BackgroundRunInfo;
  session?: ClientSession;
  db?: Db;
  client?: MongoClient;
  /** True in a dry run — the writes are rolled back */
  dryRun?: boolean;
}

/**
 * `ctx.background`: which background migration, generation and partition —
 * and the lane, its queue job and the transaction attempt, as its log lines
 * and `migration:log` events carry them.
 */
export interface BackgroundRunInfo {
  readonly name: string;
  /** The plan generation — absent when the live drift watcher runs the transformation */
  readonly generation?: number;
  /** The partition (`''` for the drift watcher, `'dry-run'` in a dry run) */
  readonly partition: string;
  /**
   * The lane's run id — its lease's owner, the runId of its `background:*`
   * events. Absent in a dry run.
   * @experimental New in 2.4
   */
  readonly runId?: string;
  /**
   * The queue job working the lane — a background queue's lane job, or the
   * migration job whose run drives it inline (`backgroundInline`)
   * @experimental New in 2.4
   */
  readonly jobId?: string;
  /**
   * The group of that migration job — only when a run drives it inline; a
   * background queue's lanes have none
   * @experimental New in 2.4
   */
  readonly groupId?: string;
  /**
   * 1 — or more when a transactional batch or step runs again in a new
   * transaction (a transient error, a conflict, a smaller batch)
   * @experimental New in 2.4
   */
  readonly attempt: number;
}

/** How a background migration splits its collection into partitions */
export interface BackgroundPartitionSettings {
  /** Partitions per lane (default 4), so a slow partition does not hold the pass */
  overPartition?: number;
  /** Default 256 */
  maxPartitions?: number;
  /** No partition is planned smaller than this (default 4 × batchSize) */
  minPartitionDocs?: number;
  /** Ids sampled to place the boundaries (default min(10 000, 100 × partitions)) */
  sampleSize?: number;
}

/** A transactional background migration's budget */
export interface BackgroundTransactionSettings {
  /** Per batch, ≤ 50 000 (default 10 000) */
  timeoutMs?: number;
  /** Retries of a batch on a transient transaction error (default 5) */
  maxRetries?: number;
}

/** The latency-driven throttle (AIMD) */
export interface BackgroundAdaptiveSettings {
  /** A batch write slower than this halves the batch (default 500) */
  targetLatencyMs?: number;
  /** Default 10 */
  minBatchSize?: number;
  /** Never above `batchSize` (the default) */
  maxBatchSize?: number;
  /** Default 30 000 */
  maxPauseMs?: number;
}

/** What a `throttle` hook is told before every batch */
export interface BackgroundThrottleContext {
  name: string;
  collection?: string;
  generation: number;
  partition: string;
  batchSize: number;
  signal: AbortSignal;
}

/**
 * Settings every background migration may carry, with their defaults.
 * @experimental New in 2.3
 */
export interface BackgroundMigrationSettings {
  description?: string;
  /** Documents per batch: 500 (100 with `transaction`) */
  batchSize?: number;
  /** Pause between batches: 100 ms */
  pauseMs?: number;
  /** How long a lane holds a partition before it yields: 30 000 ms */
  sliceMs?: number;
  /** Every batch write's, transactions included — default `{ w: 'majority' }` */
  writeConcern?: { w?: number | 'majority'; j?: boolean; wtimeoutMS?: number };
  /** Documents that may fail before the background migration does: 0 (at most 1000) */
  maxDocumentErrors?: number;
  /** Passes over the remaining old-shape documents before giving up: 10 */
  maxPasses?: number;
  /** Re-read rounds for documents a concurrent write changed under a batch: 3 */
  maxConflictRetries?: number;
  /** Failed slices of one partition in a row (no checkpoint between) before it fails: 3 */
  maxSliceFailures?: number;
  /** Wait while a secondary lags more than this: 10 000 ms (`false`: never) */
  maxReplicationLagMs?: number | false;
  /** Called before every batch; a number it returns is an extra pause (ms) */
  throttle?(ctx: BackgroundThrottleContext): number | void | Promise<number | void>;
  /** Partitions processed at once, across every process: 1 (at most 64) */
  maxParallel?: number;
  partitions?: BackgroundPartitionSettings;
  /** Batch and checkpoint in one transaction (needs a replica set or mongos): false */
  transaction?: boolean | BackgroundTransactionSettings;
  /** The latency-driven throttle: true */
  adaptive?: boolean | BackgroundAdaptiveSettings;
  /** Lanes per shard on a sharded collection: 1 */
  shardConcurrency?: number;
}

/**
 * A declarative background migration: every document of `collection` at
 * version `from` (and matching `filter`) rewritten to version `to` by
 * `migrate` (or `migrateBatch`), in partitions, behind an optimistic guard.
 * `From` and `To` type the documents — see `BackgroundMigrationFor` in
 * `@alexify/migronaut/versioning` for the shape-map form.
 *
 * The callbacks are declared as methods, so a transformation typed for the
 * stored document (with its version) or for its body fits either way.
 * @experimental New in 2.3
 */
export interface DeclarativeBackgroundMigration<
  From extends object = Record<string, any>,
  To extends object = Record<string, any>,
> extends BackgroundMigrationSettings {
  collection: string;
  /** The version rewritten — 0 for documents without a version field */
  from: number;
  to: number;
  filter?: Record<string, unknown>;
  /** The new document for one old one; the engine sets the version and bumps the revision */
  migrate?(doc: From, ctx: BackgroundMigrationContext): To | Promise<To>;
  /** The new documents for a batch, aligned — an `Error` fails just that document */
  migrateBatch?(docs: From[], ctx: BackgroundMigrationContext): (To | Error)[] | Promise<(To | Error)[]>;
  /** The way back, for `down` */
  revert?(doc: To, ctx: BackgroundMigrationContext): From | Promise<From>;
  revertBatch?(docs: To[], ctx: BackgroundMigrationContext): (From | Error)[] | Promise<(From | Error)[]>;
  /** Default: the collection's `versioning.field`, else `'__v'` */
  versionField?: string;
  /** Default: the collection's `versioning.revisionField`, else `'__rev'` */
  revisionField?: string;
  /**
   * `'revision'` (default) guards each write with the revision; a collection
   * without revisions must say `'version-only'` — a concurrent write that
   * leaves the version alone is then invisible to it.
   */
  occ?: 'revision' | 'version-only';
}

/** What a `step` background migration gets */
export interface BackgroundStepContext extends BackgroundMigrationContext {
  db: Db;
  client: MongoClient;
  /** What the previous step returned (`null` at the start) */
  checkpoint: unknown;
  /** Epoch ms the step should return by — the slice ends then */
  deadline: number;
}

/** What a `step` returns */
export interface BackgroundStepResult {
  /** Saved (≤ 64 KiB of BSON) and handed to the next step */
  checkpoint: unknown;
  /** True once there is nothing left */
  done: boolean;
  processed?: number;
  migrated?: number;
  /** For progress, when known */
  total?: number;
}

/**
 * A free-form background migration — the escape hatch: migronaut runs `step`
 * again and again with its last checkpoint until it says `done`, owning the
 * lease, the slices, the throttle and the controls. One partition only; the
 * writes must be idempotent.
 * @experimental New in 2.3
 */
export interface StepBackgroundMigration extends BackgroundMigrationSettings {
  /** Shown in status — the collection it works on, if one */
  collection?: string;
  step(ctx: BackgroundStepContext): BackgroundStepResult | Promise<BackgroundStepResult>;
  revertStep?(ctx: BackgroundStepContext): BackgroundStepResult | Promise<BackgroundStepResult>;
}

/** A background migration, as a migration file exports it: `export const background = {…}` */
export type BackgroundMigration = DeclarativeBackgroundMigration | StepBackgroundMigration;

/** Shape of a background migration file module — no `up`/`down` */
export interface BackgroundMigrationModule {
  background: BackgroundMigration;
  /** Background migrations that must complete first (each sorting before this file) */
  requires?: readonly string[];
  description?: string;
}

// ─── Changelog ────────────────────────────────────────────────────────────────

export type MigrationStatus = 'applied' | 'reverted' | 'failed';

/**
 * Where a changelog record originated. `'migrate-mongo'` marks a record adopted
 * via `migronaut import`, `'baseline'` one stamped by `migronaut baseline`; both are
 * forward-only and cannot be reverted by migronaut. Absent (or `'migronaut'`)
 * means a natively-applied, reversible migration.
 */
export type MigrationOrigin = 'migronaut' | 'migrate-mongo' | 'baseline';

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
  /** When the last failed attempt was recorded (status `'failed'` only) */
  failedAt?: Date;
  /** Redacted message of the last failed attempt (status `'failed'` only) */
  error?: string;
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
  /**
   * `'background'` for a background migration file — applying it registered
   * the background migration; its documents are rewritten later.
   * @experimental New in 2.3
   */
  kind?: 'background';
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
 * Mints one identifier. Called with **no arguments** and no `this`, so a
 * third-party generator passes straight through (`generateId: ulid`,
 * `generateId: createId`, `generateId: nanoid`). It must be **synchronous** and
 * return a non-empty string of at most 128 characters, different on every
 * call; anything else — a throw and a returned promise included — fails the
 * run with a {@link ConfigInvalidError}.
 */
export type IdGenerator = () => string;

/**
 * Every **scalar** option below is also settable from the environment as
 * `MIGRONAUT_<SCREAMING_SNAKE>` (`migrationsDir` → `MIGRONAUT_MIGRATIONS_DIR`,
 * with `dbName` → `MIGRONAUT_DB`, `migrationsCollection` → `MIGRONAUT_COLLECTION`
 * and `lockTTLSeconds` → `MIGRONAUT_LOCK_TTL` as the shortened exceptions), which
 * is what makes a config file genuinely optional. Env vars outrank the config
 * file and are outranked by CLI flags. A value that does not parse is rejected
 * with a {@link ConfigInvalidError} naming the variable — never coerced.
 *
 * `fileExtensions`, `clientOptions`, `collections`, `generateId` and the live
 * handles (`client`, `mongoose`, `hooks`, `logger`, `telemetry`) are
 * config-file/API only: a single environment string cannot express them.
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
  /**
   * Collection holding the converge history — one entry per converge that
   * changed something or failed. Created by the first such converge, never
   * before. Default: '_migronaut_converge'
   */
  convergeLogCollection: string;
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
  /**
   * What a bulk `up` does when a pending migration sorts before the newest
   * applied one — a file merged late from a parallel branch, which would apply
   * out of authoring order (environments migrated at different times then
   * disagree on the effective order).
   *
   * - `'warn'` (default) — log the late arrivals and apply them.
   * - `'error'` — refuse the run with an {@link OutOfOrderMigrationError}.
   * - `'allow'` — apply silently.
   *
   * A single-file `up` (an explicit, deliberate target) is never checked.
   */
  onOutOfOrder?: 'warn' | 'error' | 'allow';
  /**
   * Declared collections: their indexes and validator, as the end state you
   * want. `converge()` (`migronaut converge`) compares them with the live
   * database and makes the difference — no migration file per change, and
   * nothing recorded. Combined with the files in `collectionsDir`; a
   * collection declared twice is a {@link ConfigInvalidError}. Experimental.
   */
  collections?: CollectionDefinition[];
  /**
   * Directory of collection definition files, one collection per file (a
   * `.ts`/`.js` default export or a `.json` document; the collection name
   * defaults to the file name). Opt-in — nothing is read unless this is set.
   * Files are loaded when a converge runs, not at config resolution.
   */
  collectionsDir?: string;
  /**
   * End every bulk `up` — no file, no `to` — by converging the declared
   * collections, under the same lock and even when no migration was pending.
   * Default: false
   */
  convergeAfterUp?: boolean;
  /**
   * What converge does with declared search indexes on a server without
   * Atlas Search: `'fail'` refuses the run before anything is written,
   * `'skip'` converges everything else and reports them as `skip` rows.
   * Default: 'fail'
   * @experimental New in 2.2
   */
  onSearchUnavailable?: 'fail' | 'skip';
  /**
   * Hold every converge — the after-up one included — until each declared
   * search index is queryable with its declared definition. Search indexes
   * build in the background, so without it a new one is not queryable yet when
   * converge returns. An index that FAILED or went STALE before the run, its
   * definition unchanged, does not hold it — it is warned about instead. The
   * migration lock is released while it waits. Default: false
   * @experimental New in 2.2
   */
  waitForSearchIndexes?: boolean;
  /**
   * How long `waitForSearchIndexes` waits before the converge fails with
   * `phase: 'wait'` (the server goes on building). Default: 600000 (10 minutes)
   * @experimental New in 2.2
   */
  searchIndexWaitTimeoutMs?: number;
  /**
   * Where background migrations keep their state — and, named after it,
   * their partitions (`<name>_partitions`) and the drift watcher's resume
   * tokens (`<name>_watch`). Default `'_migronaut_background'`.
   * @experimental New in 2.3
   */
  backgroundCollection?: string;
  /**
   * Run a background migration to the end inside the `up` that registers it,
   * under the migration lock — for small collections and tests. Default false.
   * @experimental New in 2.3
   */
  backgroundInline?: boolean;
  /**
   * What the drift watch does with old-shape documents that appear after a
   * background migration completed: `'reopen'` it (default) or only `'report'`.
   * @experimental New in 2.3
   */
  backgroundOnDrift?: 'reopen' | 'report';
  /**
   * How drift is watched: `'poll'` (default — a check every 10 minutes),
   * `'stream'` (change streams, the check as a backstop) or `'both'`.
   * @experimental New in 2.3
   */
  backgroundDrift?: 'poll' | 'stream' | 'both';
  /**
   * Partition a sharded collection by its shard key and target each write at
   * one shard (`'auto'`, default), or treat it like any other (`'off'`).
   * @experimental New in 2.3
   */
  backgroundShardAware?: 'auto' | 'off';
  /** Mongoose instance — required only if your migrations use Mongoose models */
  mongoose?: MongooseLike;
  hooks?: MigrationHooks;
  /** Custom logger — set to null to silence all output (useful in tests) */
  logger?: MigronautLogger | null;
  /**
   * Your own identifier format (ULID, CUID, UUIDv7, …) for every id migronaut
   * mints: the run id — stamped on changelog records, events and log lines,
   * and stored as the lock's owner token — and, through
   * `@alexify/migronaut/bullmq`, the group id of an enqueue call.
   * Default: `crypto.randomUUID()`.
   *
   * Ids are for correlation. The lock adds a token of its own, so a generator
   * that repeats a value blurs which run wrote what but never lets two runs
   * hold the lock at once.
   */
  generateId?: IdGenerator;
  /**
   * OpenTelemetry, from your own `@opentelemetry/api`: a tracer, a meter, or
   * both. Every run and every migration becomes a span — the migration's span
   * is the active one while its `up`/`down` runs, so an instrumented MongoDB
   * driver nests its command spans under it — and their durations are
   * recorded as histograms. Absent, `null` or empty turns it off.
   */
  telemetry?: MigronautTelemetry | null;
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

// ─── Collections (converge) ───────────────────────────────────────────────────

/** An index key direction: ascending, descending, or a special index type */
export type IndexKeyDirection = 1 | -1 | 'text' | 'hashed' | '2d' | '2dsphere';

/** Collation of an index — `locale` required, the rest as MongoDB defines them */
export interface IndexCollation {
  locale: string;
  caseLevel?: boolean;
  caseFirst?: 'upper' | 'lower' | 'off';
  strength?: 1 | 2 | 3 | 4 | 5;
  numericOrdering?: boolean;
  alternate?: 'non-ignorable' | 'shifted';
  maxVariable?: 'punct' | 'space';
  backwards?: boolean;
  normalization?: boolean;
}

/**
 * One declared index, in the driver's own flat `createIndexes` shape. Every
 * option is checked: an unknown one is a {@link ConfigInvalidError} rather
 * than dropped, because the driver drops it silently and the index would be
 * built without it.
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface IndexDefinition {
  /**
   * Field → direction, in index order. A compound key with an integer-like
   * field name must be a `Map` (a plain object reorders such names), with that
   * field first — the live key is read back as a plain object.
   */
  key: Record<string, IndexKeyDirection> | Map<string, IndexKeyDirection>;
  /** Defaults to the name MongoDB generates: `email_1`, `a_1_b_-1` */
  name?: string;
  unique?: boolean;
  sparse?: boolean;
  /** Changed in place (`collMod`) — no rebuild */
  hidden?: boolean;
  /** TTL in seconds. Changed in place when the live index already has one */
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
  collation?: IndexCollation;
  /** For a wildcard (`$**`) index */
  wildcardProjection?: Record<string, 0 | 1 | boolean>;
  /** Text index field weights (default 1) */
  weights?: Record<string, number>;
  default_language?: string;
  language_override?: string;
  textIndexVersion?: number;
  '2dsphereIndexVersion'?: number;
  bits?: number;
  min?: number;
  max?: number;
  storageEngine?: Record<string, unknown>;
  /** Accepted and ignored — a no-op since MongoDB 4.2 */
  background?: boolean;
}

export type ValidationLevel = 'off' | 'strict' | 'moderate';
export type ValidationAction = 'error' | 'warn' | 'errorAndLog';

/** The two kinds of Atlas search index */
export type SearchIndexType = 'search' | 'vectorSearch';

/** `mappings` of an Atlas Search definition */
export interface SearchIndexMappings {
  /** Default: false */
  dynamic?: boolean | { typeSet: string };
  fields?: Record<string, unknown>;
}

/**
 * An Atlas Search index definition, as Atlas defines it. Compared whole, with
 * the documented defaults filled in; anything Atlas adds can be declared too.
 */
export interface SearchDefinition {
  mappings: SearchIndexMappings;
  /** Default: 'lucene.standard' */
  analyzer?: string;
  /** Default: the analyzer */
  searchAnalyzer?: string;
  analyzers?: Array<Record<string, unknown>>;
  synonyms?: Array<Record<string, unknown>>;
  /** Default: false */
  storedSource?: boolean | { include?: string[]; exclude?: string[] };
  /** Default: 1 */
  numPartitions?: number;
  [option: string]: unknown;
}

/** One field of a Vector Search definition */
export interface VectorSearchField {
  /** `'autoEmbed'` is Atlas's automated embedding (in preview); one index holds vector or autoEmbed fields, not both */
  type: 'vector' | 'filter' | 'autoEmbed' | (string & {});
  path: string;
  numDimensions?: number;
  similarity?: 'euclidean' | 'cosine' | 'dotProduct';
  /** Default: 'none' ('scalar' for autoEmbed) */
  quantization?: string;
  /** Default: 'hnsw' */
  indexingMethod?: 'hnsw' | 'flat';
  /** Default: { maxEdges: 16, numEdgeCandidates: 100 } */
  hnswOptions?: { maxEdges?: number; numEdgeCandidates?: number };
  /** autoEmbed: the embedding model */
  model?: string;
  /** autoEmbed: 'text' */
  modality?: string;
  [option: string]: unknown;
}

/** A Vector Search index definition */
export interface VectorSearchDefinition {
  fields: VectorSearchField[];
  [option: string]: unknown;
}

/**
 * One declared Atlas Search or Vector Search index. The name defaults to
 * `'default'` and the type to `'search'`, as on the server. A change of type
 * — or of an autoEmbed field's path, model, size, quantization or modality —
 * cannot be made in place: converge refuses it, and the way is a new index
 * under a new name (converge, then remove the old declaration and converge
 * with prune).
 * @experimental New in 2.2 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export type SearchIndexDefinition =
  | { name?: string; type?: 'search'; definition: SearchDefinition }
  | { name?: string; type: 'vectorSearch'; definition: VectorSearchDefinition };

/**
 * A declared collection: the end state `converge()` keeps it in. Leave
 * `indexes`, `searchIndexes` or `validator` out to leave that part unmanaged.
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface CollectionDefinition {
  name: string;
  /**
   * Every index besides `_id`. Undeclared live indexes are kept (and reported)
   * unless `prune` is on.
   */
  indexes?: readonly IndexDefinition[];
  /**
   * Atlas Search and Vector Search indexes (Atlas, an Atlas CLI local
   * deployment, or MongoDB 8.3+ with mongot). Undeclared live ones are kept
   * unless `prune` is on; leave the key out and they are not managed at all.
   * @experimental New in 2.2
   */
  searchIndexes?: readonly SearchIndexDefinition[];
  /**
   * A query or `{ $jsonSchema }` document; `null` (or `{}`) for no validator.
   * With `versioning`, its rules are merged in — and `null` is refused.
   */
  validator?: Record<string, unknown> | null;
  /**
   * Default: 'strict' — 'moderate' when the only rules are the ones
   * `versioning` adds. Only with a validator (or `versioning`)
   */
  validationLevel?: ValidationLevel;
  /** Default: 'error'. Only with a validator (or `versioning`) */
  validationAction?: ValidationAction;
  /**
   * Drop live indexes (and search indexes, when `searchIndexes` is declared)
   * this definition does not declare. Default: the call's `prune`, else false.
   * With `versioning` and no `indexes`, only the version index is managed —
   * prune leaves the others alone.
   */
  prune?: boolean;
  /**
   * Document shape versioning: the version (and revision) field typed and
   * required by the validator, and the version index background migrations
   * scan. The source of truth `defineShapes` reads too.
   * @experimental New in 2.3
   */
  versioning?: CollectionVersioning;
}

/**
 * The `versioning` block of a collection definition.
 * @experimental New in 2.3
 */
export interface CollectionVersioning {
  /** The shape version new documents are written at (≥ 1) */
  current: number;
  /**
   * The oldest shape still allowed (default 1, ≤ `current`). `0` types the
   * fields without requiring them — for a collection that predates
   * versioning. Converge refuses to raise it while documents below it remain.
   * There is deliberately no maximum: a newer release may write ahead of the
   * declaration during a rolling deploy.
   */
  min?: number;
  /** The version field. Default `'__v'` */
  field?: string;
  /** Also manage a revision field for optimistic concurrency. Default `true` */
  revision?: boolean;
  /** The revision field. Default `'__rev'` */
  revisionField?: string;
  /** Declare the `{ <field>: 1, _id: 1 }` index. Default `true` */
  index?: boolean;
}

/** What a `collectionsDir` file exports: a definition whose name defaults to the file name */
export type CollectionDefinitionFile = Omit<CollectionDefinition, 'name'> & { name?: string };

/**
 * Options for {@link MigratorKit.converge}
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface ConvergeOptions {
  /** Plan without writing: no lock, no events. The result's rows are `'planned'` */
  dryRun?: boolean;
  /** Drop undeclared indexes in collections whose definition does not set `prune` */
  prune?: boolean;
  /** Skip lock acquisition (dev only) */
  noLock?: boolean;
  /**
   * Refuse ({@link MigrationBlockedError}) while any migration is still
   * pending — checked under the lock. How the queue adapter runs a converge
   * as the tail of a deploy.
   */
  ordered?: boolean;
  /**
   * Allow a rebuild that drops a unique index and builds a unique one back.
   * Without it such a rebuild plans as a `conflict`: the constraint is gone
   * until the new index is built, and a duplicate written in between leaves
   * neither index buildable. The after-up hook and queue jobs never set it.
   * CLI: `--rebuild-unique`.
   */
  rebuildUnique?: boolean;
  /**
   * Hold the run until every declared search index serves its
   * declaration — failing on a FAILED build of an index this run created or
   * changed, or after `searchIndexWaitTimeoutMs`. The migration lock is released
   * when the wait starts — it only reads. Overrides the config's `waitForSearchIndexes`;
   * not with `dryRun`. CLI: `--wait-search` / `--no-wait-search`.
   * @experimental New in 2.2
   */
  waitForSearchIndexes?: boolean;
  /** Who asked for this converge — recorded in the converge history */
  requestedBy?: string;
  /** Why — recorded in the converge history */
  reason?: string;
}

export type ConvergeTarget = 'collection' | 'validator' | 'index' | 'searchIndex';

/**
 * What converge does to one target. `keep` is an undeclared index left alone
 * (prune off); `conflict` refuses the run — an undeclared index covers the
 * declared one's key under another name, a unique index would be rebuilt
 * without {@link ConvergeOptions.rebuildUnique}, the collection is a view or a
 * time-series collection, a search index would need a change no update can
 * make (its type, an autoEmbed field's model or size), or the server has no
 * Atlas Search; `skip` is a declared search index left alone on a server
 * without Search (`onSearchUnavailable: 'skip'`). A search index is never
 * `recreate`d: `modify` updates it in place.
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export type ConvergeActionKind =
  | 'create'
  | 'modify'
  | 'recreate'
  | 'drop'
  | 'keep'
  | 'unchanged'
  | 'conflict'
  | 'skip';

/**
 * The status `$listSearchIndexes` reports for a search index — `'UNKNOWN'`
 * when the server reports none
 */
export type SearchIndexStatus =
  | 'PENDING'
  | 'BUILDING'
  | 'READY'
  | 'FAILED'
  | 'STALE'
  | 'DELETING'
  | 'DOES_NOT_EXIST'
  | 'UNKNOWN'
  | (string & {});

/**
 * Where the server is with a search index: it builds in the background, so a
 * created or updated one is not queryable (with its new definition) at once
 * @experimental New in 2.2
 */
export interface SearchIndexBuild {
  status: SearchIndexStatus;
  queryable: boolean;
  /** The server's message — why a build FAILED, typically */
  message?: string;
  /** A newer definition is being built next to the one served */
  updating?: true;
}

/**
 * `planned` in a dry run; otherwise `applied`, `failed`, or `skipped` — no
 * change was needed, or the run stopped before reaching it.
 */
export type ConvergeActionStatus = 'planned' | 'applied' | 'failed' | 'skipped';

/**
 * One row of a converge result
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface ConvergeAction {
  target: ConvergeTarget;
  /** The index name; the collection name for a `collection` or `validator` row */
  name: string;
  action: ConvergeActionKind;
  status: ConvergeActionStatus;
  /** What differs (`'unique, expireAfterSeconds'`), or why a row is what it is */
  reason?: string;
  /** The live index the row refers to when its name differs from the declared one */
  liveName?: string;
  durationMs?: number;
  /**
   * What is there now — the live index (`{ key, name, ...options }`) or
   * validator (`{ validator, validationLevel, validationAction }`) — on rows
   * that change or drop it, and on `keep` rows. Plain JSON.
   */
  from?: Record<string, unknown>;
  /** What the row puts there — the declared index or validator — on rows that create or change it */
  to?: Record<string, unknown>;
  /**
   * A search index row's build state on the server — as read before the run,
   * and after it for a row the run applied
   * @experimental New in 2.2
   */
  build?: SearchIndexBuild;
  /**
   * On a search index row: the options the server reports that the
   * declaration does not set and migronaut knows no default for
   * (`mappings.fields.title.similarity`) — left out of the comparison, so a
   * new server default does not make every converge update the index.
   * Declare one to manage it.
   * @experimental New in 2.2
   */
  ignored?: string[];
}

/**
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface CollectionConvergeResult {
  name: string;
  actions: ConvergeAction[];
}

/**
 * One entry of the converge history (`convergeLogCollection`): a converge that
 * changed something or failed.
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface ConvergeHistoryEntry {
  runId?: string;
  /** `'converge'`, or `'up'` for the converge that ended a bulk `up` */
  trigger: ConvergeTrigger;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  success: boolean;
  /** Redacted failure message (`success: false` only) */
  error?: string;
  executedBy: string;
  host: string;
  environment: string;
  requestedBy?: string;
  reason?: string;
  /** Changes applied */
  changed: number;
  /** The rows that changed, failed or refused the run — each with its collection and `from` / `to` */
  actions: Array<ConvergeAction & { collection: string }>;
  unstable?: ConvergeUnstable[];
  /**
   * What the run saw of Atlas Search, and how a wait for its builds ended —
   * when a definition declares `searchIndexes`
   * @experimental New in 2.2
   */
  search?: ConvergeSearchSummary;
}

/**
 * Something applied that still compares as changed — reported, never rebuilt in a loop
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface ConvergeUnstable {
  collection: string;
  target: ConvergeTarget;
  name: string;
  action: ConvergeActionKind;
  reason?: string;
}

/**
 * A declared search index that exists but does not serve its declaration yet
 * @experimental New in 2.2
 */
export interface SearchIndexNotReady extends SearchIndexBuild {
  collection: string;
  name: string;
}

/**
 * What a converge saw of Atlas Search — present when a definition declares
 * `searchIndexes`
 * @experimental New in 2.2
 */
export interface ConvergeSearchSummary {
  /** Whether the server has Atlas Search */
  available: boolean;
  /**
   * How that was told: `'listed'` (the server listed search indexes),
   * `'parameter'` (its search index manager setting), `'error'` (it refused
   * a search command), `'version'` (older than 6.0, not asked) or
   * `'assumed'` (it would not say — a refusal at apply time reports it)
   */
  evidence?: 'listed' | 'parameter' | 'error' | 'version' | 'assumed';
  /**
   * Declared search indexes still building, updating, stale or failed. Does
   * not count against `inSync`: a build is the server's work, not a difference.
   */
  notReady: SearchIndexNotReady[];
  /** How a wait for the builds (`waitForSearchIndexes`) ended, when there was one */
  wait?: { outcome: ConvergeWaitOutcome; waitedMs: number };
}

/** How a wait for search index builds ended */
export type ConvergeWaitOutcome = 'ready' | 'failed' | 'timeout' | 'unreadable' | 'aborted';

/**
 * Outcome of {@link MigratorKit.converge}
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface ConvergeResult {
  dryRun: boolean;
  /** Changes applied — or, in a dry run, changes the run would make */
  changed: number;
  /**
   * True when the database matches the declarations: nothing left to do and
   * no conflict. Undeclared indexes kept with prune off, search indexes
   * skipped on a server without Search, and search index builds still under
   * way do not count against it.
   */
  inSync: boolean;
  collections: CollectionConvergeResult[];
  unstable?: ConvergeUnstable[];
  /** @experimental New in 2.2 */
  search?: ConvergeSearchSummary;
}

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
 *
 * On a migration's `ctx.logger`, fields with `userland: true` also emit the
 * `migration:log` event (see {@link MigrationLogEvent}).
 */
export type LogMethod = (msg: string, fields?: Record<string, unknown>) => void;

// ─── Telemetry ────────────────────────────────────────────────────────────────

/** A span or metric attribute value — the scalar subset migronaut sets */
export type MigronautAttributes = Record<string, string | number | boolean>;

/**
 * The slice of an OpenTelemetry `Span` migronaut calls. Declared structurally —
 * `@opentelemetry/api` is deliberately not imported, so the package's types
 * resolve for users who never installed it. A real `Span` satisfies it.
 */
export interface MigronautSpan {
  setAttribute(key: string, value: string | number | boolean): unknown;
  /** `code` is OpenTelemetry's `SpanStatusCode` — migronaut only ever sets ERROR (2) */
  setStatus(status: { code: number; message?: string }): unknown;
  end(): void;
}

/**
 * The slice of an OpenTelemetry `Tracer` migronaut calls — what
 * `trace.getTracer('@alexify/migronaut')` returns. Only `startActiveSpan` is
 * used: it is what makes a span the active context for the migration's own
 * code, and so for any instrumentation running underneath it.
 */
export interface MigronautTracer {
  startActiveSpan<T>(
    name: string,
    options: { attributes?: MigronautAttributes },
    fn: (span: MigronautSpan) => T,
  ): T;
}

/** An OpenTelemetry `Histogram`, as far as migronaut uses one */
export interface MigronautHistogram {
  record(value: number, attributes?: MigronautAttributes): void;
}

/** An OpenTelemetry `Counter`, as far as migronaut uses one */
export interface MigronautCounter {
  add(value: number, attributes?: MigronautAttributes): void;
}

/** Options migronaut passes when it creates an instrument */
export interface MigronautMetricOptions {
  description?: string;
  unit?: string;
  /** Histogram bucket boundaries, in the instrument's unit (seconds) */
  advice?: { explicitBucketBoundaries?: number[] };
}

/**
 * The slice of an OpenTelemetry `Meter` migronaut calls — what
 * `metrics.getMeter('@alexify/migronaut')` returns.
 */
export interface MigronautMeter {
  createHistogram(name: string, options?: MigronautMetricOptions): MigronautHistogram;
  createCounter(name: string, options?: MigronautMetricOptions): MigronautCounter;
}

/**
 * The `telemetry` config option. Both parts are optional and independent:
 * a tracer alone gives spans, a meter alone gives metrics.
 *
 * Spans: `migronaut.run` (one per run that held the lock) and
 * `migronaut.migration` (one per migration executed, a child of the run).
 * Metrics: `migronaut.run.duration`, `migronaut.migration.duration` and
 * `migronaut.lock.acquire.duration` (histograms, seconds), plus the counters
 * `migronaut.lock.refused` and `migronaut.lock.lost`. A failure sets the span's
 * status to ERROR with a redacted message, and `error.type` — on the span and
 * the metric point — to the {@link MigronautErrorCode}, or for an error that is
 * not migronaut's to its class name (`_OTHER` when it has none).
 *
 * A tracer or meter that throws never fails a run.
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface MigronautTelemetry {
  tracer?: MigronautTracer | null;
  meter?: MigronautMeter | null;
  /**
   * Static attributes added to every span and every metric point — your own
   * low-cardinality dimensions (`{ tenant: 'acme' }`). At most 20. They cannot
   * replace migronaut's own: `db.namespace` (the database name, always
   * present) and the `migronaut.*` attributes win.
   */
  attributes?: Record<string, string | number | boolean>;
}

// ─── Progress Reporter ─────────────────────────────────────────────────────────

/**
 * Receives migration lifecycle callbacks so a presentation layer (e.g. a
 * progress spinner) can react. Deliberately separate from {@link MigrationHooks}: hooks
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
  /**
   * `'failed'` marks a recorded failed attempt — the file still counts as
   * pending for every run path (the next `up` retries it), but the failure is
   * surfaced instead of rendering as a plain pending row. A reverted record
   * reports as `'pending'`, with `revertedAt` carrying its history.
   */
  status: 'applied' | 'pending' | 'failed';
  batch: number | null;
  appliedAt: Date | null;
  duration: number | null;
  /** null = never applied, true = match, false = mismatch */
  checksumOk: boolean | null;
  description?: string;
  /** Who ran it — from the changelog's audit trail, when recorded */
  executedBy?: string;
  /** Environment stamped at apply time, when recorded */
  environment?: string;
  /** Correlation id of the run that wrote the record, when recorded */
  runId?: string;
  /** When the migration was reverted — present on reverted history rows */
  revertedAt?: Date;
  /** `'migrate-mongo'` / `'baseline'` mark forward-only adopted records */
  origin?: MigrationOrigin;
  /** Redacted message of the last failed attempt (status `'failed'` only) */
  error?: string;
  /**
   * `'background'` for a background migration file (applied = registered) —
   * in `status()` and `dryRun('up')` rows alike
   * @experimental New in 2.3
   */
  kind?: 'background';
  /** When the last failed attempt was recorded (status `'failed'` only) */
  failedAt?: Date;
  /**
   * Present (true) on a not-yet-applied row that sorts before the newest
   * applied migration — a file merged late from a parallel branch, which will
   * apply out of authoring order. See `MigronautConfig.onOutOfOrder`.
   */
  outOfOrder?: true;
  /**
   * Present (true) when the changelog record's name is not a plain filename —
   * a legacy or tampered record. The row is reported as-is instead of failing
   * the whole status/audit call.
   */
  invalid?: true;
  /**
   * The file's current checksum (SHA-256 hex) — on `dryRun('up')` rows, so a
   * caller that applies them later can insist on exactly this version
   * (`up(file, { checksum })`).
   */
  checksum?: string;
  /**
   * `dryRun('up')` rows: the background migrations the file requires
   * @experimental New in 2.3
   */
  requires?: string[];
  /**
   * `dryRun('up')` rows: those of `requires` not completed yet
   * @experimental New in 2.3
   */
  waitsFor?: string[];
  /** Who asked for the apply, and why — when the run said (`requestedBy` / `reason` options) */
  requestedBy?: string;
  reason?: string;
  /** Who asked for the revert, and why — on reverted history rows */
  revertRequestedBy?: string;
  revertReason?: string;
  /** The checksum of the file version that failed (status `'failed'` only) */
  failedChecksum?: string;
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
  /**
   * The holder's run id — the `runId` of its events, log lines and changelog
   * records. Absent for a document written by hand.
   */
  runId?: string;
  /** The holder's lock TTL (ms), which paces its heartbeat. Absent before 2.1 */
  ttlMs?: number;
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
  | 'MIGRATION_IRREVERSIBLE'
  | 'MIGRATION_OUT_OF_ORDER'
  | 'MIGRATION_BLOCKED'
  | 'QUEUE_JOB_INVALID'
  | 'QUEUE_JOB_FAILED'
  | 'CONVERGE_FAILED'
  | 'REVISION_CONFLICT'
  | 'SHAPE_VERSION_UNSUPPORTED'
  | 'BACKGROUND_PENDING'
  | 'BACKGROUND_FAILED'
  | 'BACKGROUND_CONFLICT'
  | 'SANDBOX_REFUSED';

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
  /**
   * Stamp this batch number on what the run applies, instead of the next free
   * one ({@link MigratorKit.nextBatch}). A label, not a reservation: it may
   * equal a batch already in use, which is how several single-file runs become
   * one rollback unit — the queue adapter gives every job of an enqueue group
   * the same value. Positive integer; mutually exclusive with `step`.
   */
  batch?: number;
  /**
   * Refuse ({@link MigrationBlockedError}) to apply the named file while an
   * earlier file on disk is still pending — the invariant a bulk `up` gets by
   * construction, enforced from the changelog rather than from the caller's
   * memory. Also makes the single-file run honour `strict` drift checks and
   * `onOutOfOrder` like a bulk run. Requires a filename.
   */
  ordered?: boolean;
  /**
   * The SHA-256 (hex) the named file must have — refuse ({@link
   * ChecksumMismatchError}, `context.planned: true`) to apply any other
   * version of it. A queue job carries the checksum its plan saw, so a worker
   * from another deploy never applies a different file under the same name.
   * Requires a filename; an already-applied file is skipped as usual.
   */
  checksum?: string;
  /**
   * Converge the declared collections after the migrations, under the same
   * lock — overrides `convergeAfterUp` for this call. Bulk runs only: refused
   * with a filename or `to`.
   */
  converge?: boolean;
  /**
   * What the run does at a migration that `requires` a background migration
   * not completed yet: `'error'` (default) throws {@link BackgroundPendingError};
   * `'stop'` ends the run there, cleanly (`background:waiting`). Either way
   * that migration fires no hook and leaves no failed trace.
   * @experimental New in 2.3
   */
  onBackgroundPending?: 'error' | 'stop';
  /**
   * Who asked for this run (≤ 128 characters) — stamped on the changelog
   * records it writes. `executedBy` is the OS user that ran it; on a queue
   * worker that is the container's, which is why the requester is separate.
   */
  requestedBy?: string;
  /** Why (≤ 512 characters) — a ticket, a sentence; stamped like `requestedBy` */
  reason?: string;
  /**
   * The queue job this run works for — bound into `ctx.run`, the run's log
   * lines and `migration:log`. The BullMQ adapter sets it; set it yourself
   * when you drive the kit from a queue of your own.
   * @experimental New in 2.4
   */
  job?: JobRef;
}

/**
 * The queue job a run works for. Nothing is stored: the ids only correlate
 * what the run logs with the job a dashboard shows.
 * @experimental New in 2.4
 */
export interface JobRef {
  /** The job's id (≤ 1024 characters) */
  id: string;
  /** The group of jobs it was enqueued with (≤ 128 characters) */
  groupId?: string;
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
  /**
   * Refuse ({@link MigrationBlockedError}) to revert the named file while a
   * migration applied *after* it is still applied — reverts must go newest
   * first (by `appliedAt`, the order `steps` uses). Requires a filename.
   */
  ordered?: boolean;
  /**
   * Who asked for this run (≤ 128 characters) — stamped on the records it
   * reverts (`revertRequestedBy`). `executedBy` is the OS user that ran it; on a queue
   * worker that is the container's, which is why the requester is separate.
   */
  requestedBy?: string;
  /** Why (≤ 512 characters) — a ticket, a sentence; stamped as `revertReason` */
  reason?: string;
  /**
   * The queue job this run works for — see {@link UpOptions.job}
   * @experimental New in 2.4
   */
  job?: JobRef;
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
   * How many times the body ran, when the driver retried its transaction (on
   * `migration:success` and `migration:error`; absent when it ran once)
   * @experimental New in 2.4
   */
  attempts?: number;
  /**
   * Human-readable failure message (on `migration:error` only), with URI
   * credentials already redacted — safe to ship to metrics/alerting as-is.
   */
  error?: string;
  /** Why the migration was skipped (on `migration:skipped` only) */
  reason?: string;
}

export interface RunStartEvent extends MigronautEventBase {
  /** Which command started the run: 'up' | 'down' | 'redo' | 'import' | 'baseline' | 'converge' */
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
  /**
   * True on a `lock:released` that came before the run ended: a converge gave
   * the lock up to wait for search index builds, which only reads.
   * @experimental New in 2.2
   */
  early?: true;
}

/** Who started a converge: the `converge` call itself, or a bulk `up` (`convergeAfterUp`) */
export type ConvergeTrigger = 'converge' | 'up';

/**
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface ConvergeStartEvent extends MigronautEventBase {
  trigger: ConvergeTrigger;
  /** Declared collections being converged */
  collections: number;
}

/**
 * One step a converge carried out (or failed)
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface ConvergeActionEvent extends MigronautEventBase {
  collection: string;
  target: ConvergeTarget;
  name: string;
  action: ConvergeActionKind;
  /**
   * `'started'` fires before the step runs — an index build can take hours,
   * and this is how a subscriber sees which one is in progress; `'applied'`
   * or `'failed'` follows when it ends.
   */
  status: 'started' | 'applied' | 'failed';
  /** `'applied'` only */
  durationMs?: number;
  reason?: string;
  /** Redacted failure message (status `'failed'` only) */
  error?: string;
}

/**
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
/**
 * A converge's wait for search index builds (`waitForSearchIndexes`):
 * `started` once, `progress` every 30 seconds, then how it ended — one of
 * {@link ConvergeWaitOutcome}.
 * @experimental New in 2.2
 */
export interface ConvergeWaitEvent extends MigronautEventBase {
  status: 'started' | 'progress' | ConvergeWaitOutcome;
  /** How many search indexes the wait is for */
  searchIndexes: number;
  /** `started` only — whether the migration lock was released for the wait */
  lockReleased?: boolean;
  /** `started` only — the budget (`searchIndexWaitTimeoutMs`) */
  timeoutMs?: number;
  /** Every status but `started` */
  waitedMs?: number;
  /** `failed` and `timeout` — the indexes that did not get there */
  notReady?: SearchIndexNotReady[];
}

export interface ConvergeEndEvent extends MigronautEventBase {
  trigger: ConvergeTrigger;
  success: boolean;
  durationMs: number;
  changed: number;
  inSync: boolean;
  /** Rows per action kind */
  counts: Partial<Record<ConvergeActionKind, number>>;
  /** The full result — partial on the failure path */
  result: ConvergeResult;
  /** Redacted failure message */
  error?: string;
}

/** The level of a `ctx.logger` call */
export type MigrationLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * What every `migration:log` event carries.
 * @experimental New in 2.4
 */
export interface MigrationLogEventBase {
  level: MigrationLogLevel;
  /**
   * The message — URI credentials and the values a server error quotes (an
   * E11000's duplicate key) masked — at most 2048 characters
   */
  msg: string;
  /**
   * The call's fields without the `userland` marker, as a document a driver can
   * store: a copy, its strings redacted, at most 8 levels and 1000 entries
   * deep, strings at most 4096 characters. Dates, regular expressions and BSON
   * values are kept as they are, binary data up to 4096 bytes too. An `Error`
   * becomes `{ name, message, code?, codeName? }`; a `Map` an object, a `Set`
   * an array; any other instance what `JSON.stringify` would see.
   */
  data: Record<string, unknown>;
  /** When the call was made, by this process's clock — a TTL index can expire on it */
  at: Date;
  /** Increasing within one `runId`: orders the events of one millisecond */
  seq: number;
  /** Present when `msg` or `data` was cut to those bounds */
  truncated?: true;
}

/**
 * A `ctx.logger` call with `userland: true` in an ordinary migration or its
 * hooks — `migration`, `batch` and `attempt` are absent in `beforeAll`/`afterAll`.
 * @experimental New in 2.4
 */
export interface OrdinaryMigrationLogEvent extends MigrationLogEventBase {
  kind: 'migration';
  runId: string;
  direction: 'up' | 'down';
  migration?: string;
  batch?: number;
  attempt?: number;
  jobId?: string;
  groupId?: string;
  requestedBy?: string;
  reason?: string;
}

/**
 * A `ctx.logger` call with `userland: true` in a background migration's
 * `migrate`, `migrateBatch`, `step` (or their way back). `runId` is the lane's,
 * the one its `background:*` events carry.
 * @experimental New in 2.4
 */
export interface BackgroundMigrationLogEvent extends MigrationLogEventBase {
  kind: 'background';
  runId?: string;
  migration: string;
  direction: 'forward' | 'revert';
  generation?: number;
  partition: string;
  attempt: number;
  jobId?: string;
  /** Only when a run drives it inline — see {@link BackgroundRunInfo.groupId} */
  groupId?: string;
}

/**
 * The `migration:log` event — `kind` tells an ordinary migration's from a
 * background migration's.
 * @experimental New in 2.4
 */
export type MigrationLogEvent = OrdinaryMigrationLogEvent | BackgroundMigrationLogEvent;

/**
 * Lifecycle events emitted by {@link MigratorKit}. Subscribe to feed metrics or
 * alerting without parsing log lines; a listener that throws is contained and
 * never fails the run. The `converge:*` events fire for real converge runs
 * only, not for a dry run.
 */
export interface MigronautEvents {
  'run:start': (event: RunStartEvent) => void;
  'run:end': (event: RunEndEvent) => void;
  'migration:start': (event: MigrationEvent) => void;
  'migration:success': (event: MigrationEvent) => void;
  'migration:skipped': (event: MigrationEvent) => void;
  'migration:error': (event: MigrationEvent) => void;
  /**
   * A `ctx.logger` call marked `userland: true` — for the application to keep.
   * Logged lines without the marker emit nothing.
   * @experimental New in 2.4
   */
  'migration:log': (event: MigrationLogEvent) => void;
  'lock:acquired': (event: LockEvent) => void;
  'lock:released': (event: LockEvent) => void;
  'lock:lost': (event: LockEvent) => void;
  'converge:start': (event: ConvergeStartEvent) => void;
  'converge:action': (event: ConvergeActionEvent) => void;
  'converge:wait': (event: ConvergeWaitEvent) => void;
  'converge:end': (event: ConvergeEndEvent) => void;
  /** @experimental New in 2.3 */
  'background:registered': (event: BackgroundRegisteredEvent) => void;
  /** @experimental New in 2.3 */
  'background:waiting': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:drift': (event: BackgroundEvent) => void;
  /**
   * A collection's live drift watcher changed state
   * @experimental New in 2.3
   */
  'background:watch': (event: {
    runId?: string;
    collection: string;
    state: BackgroundWatchState;
  }) => void;
  /** @experimental New in 2.3 */
  'background:unblocked': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:partitioned': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:pass': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:slice:start': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:batch': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:slice:end': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:lease:lost': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:throttle': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:control': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:completed': (event: BackgroundEvent) => void;
  /** @experimental New in 2.3 */
  'background:failed': (event: BackgroundEvent) => void;
}

/** One check performed by {@link MigratorKit.audit} */
export interface AuditCheck {
  /**
   * e.g. 'config', 'connection', 'transactions', 'indexes', 'lock', 'checksums',
   * 'pending', 'ordering', 'runtime' — 'search' when declared collections
   * hold search indexes, and 'background' when background migrations are
   * registered
   */
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

/** Options for {@link MigratorKit.status} and {@link MigratorKit.list} */
export interface StatusOptions {
  /** Hash applied files to fill `checksumOk`. Default true */
  checksums?: boolean;
}

/** Options for {@link MigratorKit.redo} */
export interface RedoOptions {
  /** Skip lock acquisition (dev only) */
  noLock?: boolean;
  /** Who asked — stamped on the revert and on the re-apply */
  requestedBy?: string;
  /** Why — stamped like `requestedBy` */
  reason?: string;
  /**
   * The queue job this run works for — both halves carry it; see {@link UpOptions.job}
   * @experimental New in 2.4
   */
  job?: JobRef;
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
  /**
   * Generate a background migration (`export const background`) instead of
   * `up`/`down`. Not combined with `template`.
   * @experimental New in 2.3
   */
  background?: boolean;
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

/** Options for {@link MigratorKit.baseline} */
export interface BaselineOptions {
  /** Baseline pending files up to and including this one, instead of all */
  to?: string;
  /** Skip lock acquisition (dev only) */
  noLock?: boolean;
}

/** Outcome of a {@link MigratorKit.baseline} call */
export interface BaselineSummary {
  /** Files marked applied by this call, in name order */
  baselined: string[];
  /** Files on disk that were already applied (or beyond `--to`) and untouched */
  skipped: number;
  /** The shared batch number stamped on the baselined records; null when none */
  batch: number | null;
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
   * Project root this instance resolves against: config-file discovery, the
   * `.env` file and a relative `migrationsDir`. Defaults to `process.cwd()`.
   * Set it when one process hosts kits for several projects, so their
   * relative paths stop sharing one global working directory.
   */
  cwd?: string;
  /**
   * Optional lifecycle reporter, invoked around each migration's execution so a
   * UI (the CLI's spinner) can show progress. Core never imports a spinner
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
  /**
   * The batch number the next `up` would use (highest recorded batch + 1,
   * reverted and failed records included). A peek, not a reservation — pair it
   * with `up(name, { batch })` to stamp several single-file runs as one batch.
   * Connects if needed.
   */
  nextBatch(): Promise<number>;
  /**
   * A new id in this kit's configured format — the `generateId` option, else a
   * random UUID. The same source every run id comes from, for code that wants
   * its own ids to match. Resolves the config; does not connect.
   */
  generateId(): Promise<string>;
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
  /**
   * Full migration status for all known files and records. `checksums: false`
   * skips hashing the applied files (`checksumOk` stays null).
   */
  status(options?: StatusOptions): Promise<StatusRow[]>;
  /**
   * Read-only health check: configuration, connectivity, transaction support,
   * changelog indexes, lock state, checksum drift and runtime. Reports
   * problems; fixes none of them.
   */
  audit(): Promise<AuditReport>;
  /**
   * Filtered list of migrations. Default: 'all'. `checksums: false` skips
   * hashing the applied files — for a caller that needs names and dates only.
   */
  list(filter?: 'all' | 'pending' | 'applied', options?: StatusOptions): Promise<StatusRow[]>;
  /** Create a new migration file and return its absolute path */
  create(name: string, options?: CreateOptions): Promise<string>;
  /** Create a migronaut config file in the working directory and return its path */
  init(options?: InitOptions): Promise<string>;
  /**
   * Adopt an existing migrate-mongo `changelog` collection by mapping its
   * records into our schema and writing them to `migrationsCollection`.
   */
  import(options?: ImportOptions): Promise<ImportResult>;
  /**
   * Adopt an existing database with no prior migration tool: mark migration
   * files on disk as applied — checksums from disk, one shared batch,
   * `origin: 'baseline'` — without executing anything. Forward-only:
   * `down`/`redo` refuse baselined records. Idempotent: already-applied names
   * are skipped, so a partial baseline can simply be re-run.
   */
  baseline(options?: BaselineOptions): Promise<BaselineSummary>;
  /**
   * Bring the declared collections (`collections`, `collectionsDir`) to their
   * declared indexes and validators. Stateless: the live database is read and
   * compared on every call; what a run changed is appended to the converge
   * history ({@link MigratorKit.convergeHistory}), which no run reads back. A
   * real run holds the migration lock; a plan with a conflict is refused before
   * any write, and a failed step throws {@link ConvergeFailedError}. Experimental.
   */
  converge(options?: ConvergeOptions): Promise<ConvergeResult>;
  /**
   * Whether a bulk `up` on this kit ends by converging: `convergeAfterUp` is
   * on and something is declared. Resolves the config; does not connect.
   */
  convergesAfterUp(): Promise<boolean>;
  /**
   * How drift is watched — the `backgroundDrift` setting — which a runner or
   * a queue worker hosting this kit follows. Resolves the config; does not
   * connect. @experimental
   */
  driftMode(): Promise<'poll' | 'stream' | 'both'>;
  /**
   * The converge history, newest first (`limit` 1–1000, default 20): one entry
   * per converge that changed something or failed. Read-only.
   */
  convergeHistory(options?: { limit?: number }): Promise<ConvergeHistoryEntry[]>;

  // ─── Background migrations (experimental, new in 2.3) ─────────────────────
  // Reentrant: none of these is a run — no migration lock, no run id; one kit
  // may drive many at once.

  /** One coordinator step — see {@link BackgroundCoordinatorAnswer}. @experimental */
  coordinateBackground(
    name: string,
    options?: { signal?: AbortSignal; driver?: BackgroundDriver },
  ): Promise<BackgroundCoordinatorAnswer>;
  /** One slice of one lane: claim a partition and a slot, work it, release. @experimental */
  runBackgroundSlice(
    name: string,
    options?: {
      signal?: AbortSignal;
      sliceMs?: number;
      /**
       * The queue job working the lane — on its log lines and `migration:log` events
       * @experimental New in 2.4
       */
      job?: Pick<JobRef, 'id'>;
    },
  ): Promise<BackgroundSliceResult>;
  /**
   * Drive a background migration from this process until it is done (or one
   * round, `untilDone: false`) with up to `concurrency` lanes (≤ its
   * `maxParallel`). A failed one throws {@link BackgroundFailedError}; a stop
   * {@link RunAbortedError} — it goes on from there next time. @experimental
   */
  runBackground(
    name: string,
    options?: {
      signal?: AbortSignal;
      sliceMs?: number;
      untilDone?: boolean;
      concurrency?: number;
    },
  ): Promise<BackgroundStatus>;
  /** One background migration's status, or `null` when it is not registered. @experimental */
  backgroundStatus(name: string): Promise<BackgroundStatus | null>;
  /** Every background migration's status, oldest registration first. @experimental */
  backgroundStatus(): Promise<BackgroundStatus[]>;
  /** The partitions of a background migration's latest generation. @experimental */
  backgroundPartitions(name: string): Promise<BackgroundPartitionInfo[]>;
  /** The background migrations with work to do (blocked ones unblocked on the way). @experimental */
  runnableBackground(): Promise<RunnableBackground[]>;
  /** Pause; its lanes stop at the next batch (`wait` until they have). @experimental */
  pauseBackground(name: string, options?: BackgroundControlOptions): Promise<BackgroundControlResult>;
  /** Resume a paused one. @experimental */
  resumeBackground(name: string, options?: BackgroundControlOptions): Promise<BackgroundControlResult>;
  /** Cancel (`wait` until its lanes have stopped). @experimental */
  cancelBackground(name: string, options?: BackgroundControlOptions): Promise<BackgroundControlResult>;
  /**
   * Retry a failed or cancelled one — the same generation, or `fromStart`;
   * `repin` pins the file on disk first. A completed one is reopened. @experimental
   */
  retryBackground(
    name: string,
    options?: BackgroundControlOptions & { fromStart?: boolean; repin?: boolean },
  ): Promise<BackgroundControlResult>;
  /** Pin the file on disk (checksum, spec — and the changelog's checksum). @experimental */
  repinBackground(
    name: string,
    options?: BackgroundControlOptions,
  ): Promise<BackgroundControlResult & { replan: boolean; checksum: string }>;
  /** Clear the coordinator lock and every lease of a stuck one. @experimental */
  unlockBackground(name: string): Promise<{ lock: boolean; leases: number }>;
  /**
   * Dry-run a background migration, registered or not, with nothing written:
   * on a sample, its transformation alone — or with `validate`, the real write
   * path in a transaction that is always aborted. @experimental
   */
  dryRunBackground(name: string, options?: BackgroundDryRunOptions): Promise<BackgroundDryRun>;
  /**
   * The drift watch, once: one indexed probe per completed background
   * migration for documents of its old shape that appeared since; a finding
   * reopens it (`onDrift: 'reopen'`, the `backgroundOnDrift` default) or is
   * only reported. No document id is returned. @experimental
   */
  verifyBackground(options?: {
    onDrift?: 'reopen' | 'report';
    collections?: string[];
  }): Promise<BackgroundVerifyResult>;
  /**
   * The live drift watcher: a change stream per collection with a completed
   * background migration — one leader per collection across every process —
   * that upgrades each old-shape write moments after it lands, through the
   * lanes' own write path. Resolves once started; rejects with
   * ConfigInvalidError on a standalone server (no change streams).
   * @experimental
   */
  watchBackground(options?: WatchBackgroundOptions): Promise<BackgroundWatcher>;
  /** What the live drift watchers recorded for a collection — `null` when it has none @experimental */
  backgroundWatchStatus(collection: string): Promise<BackgroundWatchStatus | null>;
  /** What the live drift watchers recorded, one row per watched collection @experimental */
  backgroundWatchStatus(): Promise<BackgroundWatchStatus[]>;
}

/** What a collection's live drift watcher is doing */
export type BackgroundWatchState =
  | 'following'
  | 'catching-up'
  | 'streaming'
  | 'history-lost'
  | 'overloaded'
  | 'restarting'
  | 'suspended'
  | 'fallback'
  | 'stopped';

/** Options of {@link MigratorKit.watchBackground} */
export interface WatchBackgroundOptions {
  /** Only these collections. Default: every one with a completed background migration */
  collections?: string[];
  /** Stops the watcher when aborted */
  signal?: AbortSignal;
  /** `false`: only report old-shape writes, never upgrade them. Default `true` */
  upgrade?: boolean;
  /** How often the edges and the collections are read again (ms). Default 30000 */
  refreshMs?: number;
  /** The most often the resume token is saved (ms). Default 5000 */
  checkpointMs?: number;
  /** How often a follower tries to become the leader (ms, jittered). Default 10000 */
  leaderRetryMs?: number;
  /** Collections watched by this process at most; the rest stay with the poll. Default 16 */
  maxCollections?: number;
  /**
   * A stream this far behind (ms) gives up on its backlog: the background
   * migrations it serves are reopened, and it starts again from now. Default 60000
   */
  maxLagMs?: number;
  /** Hears every failure (the watcher itself never throws) */
  onError?(error: unknown, collection?: string): void;
}

/** A running live drift watcher */
export interface BackgroundWatcher {
  readonly running: boolean;
  /** What each followed collection's watcher is doing in this process */
  status(): {
    collection: string;
    state: BackgroundWatchState | 'starting';
    /** Whether this process leads the collection */
    leading: boolean;
    counters: { events: number; upgraded: number; failed: number; skipped: number };
    lastEventAt?: Date;
  }[];
  /** Close every stream, save its position, release its lock */
  stop(): Promise<void>;
}

/** A collection's live drift watcher, as stored — never its resume token */
export interface BackgroundWatchStatus {
  collection: string;
  state: BackgroundWatchState | 'starting';
  /** The version a document should have at least */
  target?: number;
  /** The background migrations it upgrades with */
  edges: string[];
  leader?: { host: string; pid: number; at: Date };
  counters: { events: number; upgraded: number; failed: number; skipped: number };
  lastEventAt?: Date;
  updatedAt: Date;
}

// ─── Background migration results ─────────────────────────────────────────────

/** Where a background migration stands */
export type BackgroundState =
  | 'blocked'
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Who runs a coordinator step: `{ kind, ref?, round? }` — a BullMQ round lets the newest win
 * @experimental New in 2.3
 */
export interface BackgroundDriver {
  kind: 'bullmq' | 'runner' | 'cli' | 'inline' | 'local';
  ref?: string;
  round?: number;
}

/**
 * One of {@link MigratorKit.runnableBackground}: what a driver needs to pick it up, or to tell it stalled
 * @experimental New in 2.3
 */
export interface RunnableBackground {
  migration: string;
  status: BackgroundState;
  maxParallel: number;
  /** Leases renewed within their TTL — lanes working right now */
  liveLeases: number;
  registeredAt: Date;
  startedAt?: Date;
  lastProgressAt?: Date;
  coordinator?: { kind: string; round?: number; at: Date };
}

/**
 * What a coordinator step says to do next
 * @experimental New in 2.3
 */
export interface BackgroundCoordinatorAnswer {
  next: 'process' | 'wait' | 'done' | 'busy' | 'superseded';
  /** `process`: lanes that could start now */
  lanes?: number;
  generation?: number;
  /** `process`: the registration the lanes work for (it names their jobs) */
  registration?: string;
  /** `process`: the current plan's partitions by status */
  counts?: BackgroundStatus['partitions'];
  /**
   * A `bullmq` driver's round — handed out by this step to a chain that
   * asked without one; a chain whose round is not the latest is `superseded`
   */
  round?: number;
  /** `done`: where it stands */
  status?: BackgroundState | 'unregistered';
  /** `wait`: why — `checksum`, `replan-draining`, `plan-race`, … */
  reason?: string;
  /** `done` + `failed`: why */
  error?: string;
  waitsFor?: string[];
  retryAfterMs?: number;
}

/** Counters of a slice, a partition or a whole background migration */
export interface BackgroundCounters {
  scanned?: number;
  migrated?: number;
  skipped?: number;
  conflicts?: number;
  failed?: number;
  retried?: number;
  batches?: number;
  processed?: number;
  txnRetries?: number;
}

/** How a lane's slice ended */
export interface BackgroundSliceResult {
  outcome:
    | 'yielded'
    | 'exhausted'
    | 'busy'
    | 'stale'
    | 'paused'
    | 'cancelled'
    | 'failed'
    | 'stopped'
    | 'lost';
  counters: BackgroundCounters;
  retryAfterMs?: number;
  error?: BackgroundFailedError;
}

/** A background migration, as {@link MigratorKit.backgroundStatus} reports it */
export interface BackgroundStatus {
  migration: string;
  status: BackgroundState;
  phase: 'partition' | 'process' | 'replan';
  direction: 'forward' | 'revert';
  /** Minted at every (re-)registration — `up --force`, `redo` and `down` get a new one */
  registration: string;
  mode: 'declarative' | 'step';
  collection?: string;
  from?: number;
  to?: number;
  generation: number;
  pass: number;
  maxParallel: number;
  transaction: boolean;
  totals: BackgroundCounters & { slices?: number; reclaims?: number };
  /** Distinct documents that failed (within `maxDocumentErrors`) */
  failedDocuments: number;
  requires: string[];
  waitsFor: string[];
  /** The current plan's partitions by status */
  partitions?: {
    total: number;
    pending: number;
    running: number;
    done: number;
    failed: number;
    cancelled: number;
    superseded: number;
    leased: number;
  };
  /** Leases renewed within their TTL — lanes working right now */
  liveLeases: number;
  /**
   * The driver of the latest coordinator step that said who it was — a queue's
   * coordinator chain carries its `round`, and an older round bows out
   */
  coordinator?: { kind: string; round?: number; at: Date };
  /**
   * The current plan. `estimate` is the documents it expects to rewrite —
   * with `atLeast`, a count that stopped at its limit (there are more)
   */
  plan?: {
    method: string;
    estimate: number;
    atLeast?: boolean;
    partitions: number;
    degraded?: string;
  };
  /**
   * On a sharded collection, how the plan used the shard key: `chunks` (a
   * partition per run of chunks on one shard), `sampled` (the key space
   * sampled — the chunks could not be read), or `untargeted` (partitions by
   * `_id`: the key could not be read, or the version index does not carry it)
   */
  sharding?: {
    mode: 'chunks' | 'sampled' | 'empty' | 'untargeted';
    shardKey?: Record<string, 1 | 'hashed'>;
    hashed?: boolean;
    /** Shards the partitions are grouped by */
    groups?: number;
  };
  registeredAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  lastProgressAt?: Date;
  lastError?: string;
  description?: string;
  /** The registration this one replaced (`up --force`, `redo`, `down`), as it stood then */
  previous?: {
    registration: string;
    status: BackgroundState;
    direction: 'forward' | 'revert';
    pass: number;
    totals: BackgroundCounters & { slices?: number; reclaims?: number };
    registeredAt: Date;
    completedAt?: Date;
  };
}

/** One partition of a background migration */
export interface BackgroundPartitionInfo {
  id: string;
  generation: number;
  seq: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'superseded';
  scope: Record<string, unknown>;
  estimate: number;
  counters: BackgroundCounters;
  group?: string;
  lease?: { slot: number; owner: string; host: string; pid: number; renewedAt: Date };
  throttle?: { batchSize: number; pauseMs: number };
  claims: number;
  reclaims: number;
  failures: number;
  lastError?: string;
}

/** Options every background control action takes */
export interface BackgroundControlOptions {
  /** Who asked — recorded in its history */
  requestedBy?: string;
  /** Why — recorded in its history */
  reason?: string;
  /** pause / cancel: resolve once no lane holds a lease any more */
  wait?: boolean;
  signal?: AbortSignal;
}

/** What a control action did */
export interface BackgroundControlResult {
  applied: 'changed' | 'unchanged';
  status: BackgroundState;
  /** `wait`: whether every lane stopped in time */
  stopped?: boolean;
}

/** What {@link MigratorKit.verifyBackground} found */
export interface BackgroundVerifyResult {
  /** Completed background migrations probed */
  checked: number;
  /** Skipped: another one at work on the collection, the validator guards it, no version index */
  skipped: number;
  drift: { migration: string; collection: string; action: 'reopened' | 'reported' }[];
}

/** Options of {@link MigratorKit.dryRunBackground} */
export interface BackgroundDryRunOptions {
  /** A random sample of this many matching documents (1–1000, default 5) */
  sample?: number;
  /** The first n matching documents by `_id`, instead of a sample */
  first?: number;
  /** Through the real write path, in the always-aborted sandbox */
  validate?: boolean;
  /** Dry-run the way back */
  direction?: 'forward' | 'revert';
  /** Step migrations: how many steps (1–50, default 1) */
  steps?: number;
  /** Step migrations: document images kept (default 20, at most 1000) */
  maxDocuments?: number;
  /** Step migrations: from no checkpoint, not the pinned one */
  fromStart?: boolean;
  /** Stop the sandbox after this long (default 50 000 ms) — steps, or a `validate` sample */
  deadlineMs?: number;
}

/** One document of a dry run, as relaxed EJSON */
export interface BackgroundDryRunDocument {
  _id: unknown;
  before: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** The operator update it would be written with (without `validate`) */
  change?: Record<string, unknown>;
  error?: string;
  /** With `validate`: what the server made of it */
  validation?: 'ok' | 'failed' | 'skipped';
}

/** One operation the sandbox ran — the filter as relaxed EJSON, at most 2 KiB */
export interface BackgroundSandboxOperation {
  seq: number;
  step: number;
  collection?: string;
  method: string;
  filter?: unknown;
  result?: unknown;
  durationMs?: number;
  error?: string;
}

/** A document the sandbox saw change */
export interface BackgroundSandboxDocument {
  collection: string;
  _id: unknown;
  op: 'insert' | 'update' | 'delete' | 'unknown';
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** What {@link MigratorKit.dryRunBackground} found */
export type BackgroundDryRun =
  | {
      mode: 'declarative';
      migration: string;
      direction: 'forward' | 'revert';
      method: 'sample' | 'first';
      requested: number;
      found: number;
      migrated: number;
      failed: number;
      documents: BackgroundDryRunDocument[];
      /** With `validate` */
      validated?: true;
      aborted?: true;
      ops?: BackgroundSandboxOperation[];
      refusals?: { method: string; reason: string; collection?: string }[];
      /** Documents of other collections the side writes touched */
      sideEffects?: BackgroundSandboxDocument[];
      attempts?: number;
    }
  | BackgroundStepDryRun;

/** A step migration's dry run: up to `steps` steps in one always-aborted transaction */
export interface BackgroundStepDryRun {
  mode: 'step';
  migration: string;
  direction: 'forward' | 'revert';
  aborted: true;
  ok: boolean;
  attempts: number;
  stoppedBy?: 'deadline' | 'done' | 'steps';
  steps: {
    step: number;
    checkpointIn: unknown;
    checkpointOut?: unknown;
    done?: boolean;
    processed?: number;
    migrated?: number;
    error?: string;
  }[];
  ops: BackgroundSandboxOperation[];
  documents: BackgroundSandboxDocument[];
  refusals: { method: string; reason: string; collection?: string }[];
  leakedCursors: number;
  truncated: boolean;
  abortedBy?: string;
  error?: string;
}

/** `background:registered` */
export interface BackgroundRegisteredEvent {
  runId?: string;
  migration: string;
  status: BackgroundState | 'withdrawn';
  direction: 'forward' | 'revert';
  waitsFor?: string[];
}

/** Any other `background:*` event: the migration it is about, and what happened */
export interface BackgroundEvent {
  runId?: string;
  migration: string;
  [field: string]: unknown;
}

// ─── Programmatic entry points ─────────────────────────────────────────────────

/** What to do when another process already holds the migration lock */
export type OnLockHeld = 'throw' | 'wait';

/** Options for {@link runMigrations} */
export interface RunMigrationsOptions extends MigratorKitOptions {
  /** Skip lock acquisition (dev only — never in production) */
  noLock?: boolean;
  /**
   * At a migration that requires an unfinished background migration: throw
   * (`'error'`, default) or stop the run there (`'stop'`, listed in
   * `waiting`) — `'stop'` lets an app boot while a background migration runs.
   * @experimental New in 2.3
   */
  onBackgroundPending?: 'error' | 'stop';
  /**
   * How to react when another process already holds the migration lock — the
   * typical case when several app instances boot at once.
   * - `'throw'` (default): propagate {@link LockAlreadyHeldError}.
   * - `'wait'`: poll until the lock frees, then run.
   */
  onLockHeld?: OnLockHeld;
  /**
   * Max time (ms) to wait when `onLockHeld: 'wait'` **without observing holder
   * progress**. While the holder's heartbeat visibly advances its lock, the
   * deadline is re-armed — a healthy peer working through a long backlog never
   * times its waiting peers out; only a stalled holder runs this budget down.
   * Default: 90000, or 1.5× the holder's lock TTL when that is longer — its
   * heartbeat only moves the lock every TTL/2, and a crashed holder's lock is
   * reclaimable only after a full TTL. An explicit value is used as given.
   */
  lockWaitTimeoutMs?: number;
  /**
   * First poll interval (ms) while waiting for the lock. Polls back off from
   * it, doubling, up to 5 s (and never more than a quarter of the wait budget).
   * Default: 500
   */
  lockPollIntervalMs?: number;
  /**
   * Abort the call: a wait for the lock stops between polls, and a run that
   * holds it stops between migrations (one already executing finishes), with
   * a {@link RunAbortedError}. Wire it to SIGTERM so a pod being shut down
   * does not take the lock just before it is killed.
   */
  signal?: AbortSignal;
  /**
   * Receives the internally-constructed {@link MigratorKit} right after
   * construction (before connect), so an embedding application can subscribe
   * to its lifecycle events — `kit.on('migration:success', …)` for metrics,
   * lock telemetry, runId correlation — while keeping the managed
   * connect/run/disconnect lifecycle.
   */
  onKit?: (kit: MigratorKit) => void;
}

/** Outcome of a {@link runMigrations} call */
export interface MigrationSummary {
  /** Migrations applied during this call (empty when nothing was pending) */
  applied: RunResult[];
  /** True when no migrations were pending — the database was already up to date */
  upToDate: boolean;
  /** True when this instance waited for a peer to release the lock before running */
  waited: boolean;
  /** Time (ms) from the first refusal to the run, by the clock. 0 when the lock was free */
  waitedMs: number;
  /** Number of `up` attempts made — 1 when the lock was free on the first try */
  attempts: number;
  /** The converge that ended the run — present only when `convergeAfterUp` converged */
  converge?: ConvergeResult;
  /**
   * With `onBackgroundPending: 'stop'`: the migration the run stopped at and
   * the background migrations it waits for.
   * @experimental New in 2.3
   */
  waiting?: { migration: string; waitsFor: { migration: string; status: string }[] }[];
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
 * The CLI's exit-code map: one entry per {@link MigronautErrorCode}, plus three
 * CLI-condition codes with no error class — `PENDING_MIGRATIONS` (from
 * `status --check`), `AUDIT_FAILED` and `COLLECTIONS_DRIFT` (from
 * `converge --check`). Lets a wrapper script mirror the CLI's exit semantics
 * without hardcoding numbers. Anything unmapped exits 1; success is 0.
 */
export const EXIT_CODES: Readonly<
  Record<
    MigronautErrorCode | 'PENDING_MIGRATIONS' | 'AUDIT_FAILED' | 'COLLECTIONS_DRIFT',
    number
  >
>;

// ─── Background runner ────────────────────────────────────────────────────────

/** Options of {@link startBackgroundRunner} */
export interface BackgroundRunnerOptions {
  /** The kit to drive — or `config` (and `kitOptions`) for one the runner makes and closes */
  kit?: MigratorKit;
  config?: Partial<MigronautConfig>;
  kitOptions?: MigratorKitOptions;
  /** Lane loops in this process, shared by every background migration (default 1, ≤ 64) */
  concurrency?: number;
  /** How often the runnable list is read again (default 5000 ms) */
  pollIntervalMs?: number;
  /** A slice's length (default: each background migration's `sliceMs`) */
  sliceMs?: number;
  /** The drift watch's period (default 600 000 ms — 10 minutes); `false`: off */
  verifyIntervalMs?: number | false;
  /**
   * Host the live drift watcher in this process — `true`, or its options.
   * Default: when `backgroundDrift` is `'stream'` or `'both'`
   */
  watch?: boolean | Omit<WatchBackgroundOptions, 'signal' | 'onError'>;
  /** Stops the runner, as `stop()` does */
  signal?: AbortSignal;
  /** Hears every failed slice (the runner itself never throws) */
  onError?: (error: unknown, migration?: string) => void;
}

/** A running {@link startBackgroundRunner} */
export interface BackgroundRunner {
  readonly kit: MigratorKit;
  readonly running: boolean;
  /** The live drift watcher this runner hosts, once started — or undefined */
  readonly watcher: BackgroundWatcher | undefined;
  /**
   * Stop at the next batch, release every lease, and close the kit the runner
   * made. `timeoutMs`: stop waiting for a lane stuck in its transformation
   * (its lease expires; the work resumes from the last checkpoint)
   */
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

/**
 * Drive background migrations from inside the application — no queue:
 * `concurrency` lane loops shared by every runnable background migration,
 * round-robin, plus the drift watch every `verifyIntervalMs`. Several
 * application instances share the work through the leases.
 * @experimental New in 2.3
 */
export function startBackgroundRunner(options?: BackgroundRunnerOptions): BackgroundRunner;

// ─── Logger factory ───────────────────────────────────────────────────────────

/** Threshold accepted by {@link createLogger} — drops anything less severe */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Create the default console logger (pino-compatible surface, terminal-escape
 * sanitization and colors included). `debug`/`info` write to `stream`
 * (stdout by default); `warn`/`error` always write to stderr. For programmatic
 * callers who want migronaut's own output at a chosen verbosity — e.g.
 * `logger: createLogger(process.stdout, 'debug')` — without hand-writing a
 * four-method logger.
 */
export function createLogger(stream?: NodeJS.WritableStream, level?: LogLevel): MigronautLogger;

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

/** Thrown when attempting to roll back a forward-only (imported or baselined) migration */
export class IrreversibleMigrationError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown by a bulk `up` under `onOutOfOrder: 'error'` when a pending migration
 * sorts before the newest applied one — a file merged late from a parallel
 * branch. `context.names` lists the late arrivals.
 */
export class OutOfOrderMigrationError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown by an `ordered` single-file `up`/`down` that would run out of
 * sequence: an earlier migration is still pending (`up`), or one applied later
 * is still applied (`down`). `context.name`, `context.direction` and
 * `context.blockedBy` (the migrations that must go first).
 */
export class MigrationBlockedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown by the queue adapter (`@alexify/migronaut/bullmq`) when a job's
 * payload fails the contract check — an unknown job name or data version, a
 * migration name that is not a bare filename, malformed group fields. Job data
 * is untrusted input. `context.jobId`, `context.issue`.
 */
export class QueueJobInvalidError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown by a queue group's `wait()` when one of its jobs failed or the wait
 * timed out (one budget for the whole call). `context.failedReason` is the
 * worker's (redacted) message, `context.code` the job's own typed error code
 * when it reported one (`MIGRATION_BLOCKED`, `CHECKSUM_MISMATCH`, …),
 * `context.results` the jobs that finished before it, plus `groupId`, `jobId`,
 * `migration`, `direction` and `timedOut`.
 */
export class QueueJobFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown by {@link MigratorKit.converge} when the database cannot be brought
 * to the declared state. `context.phase` is:
 * - `'plan'` for a refused plan (`context.conflicts` lists why, with a `hint`
 *   when Atlas Search is missing; nothing was written) — or a search index
 *   list that could not be read before the first write (`collection`,
 *   `target: 'searchIndex'`, `cause`, `mongoCode`, `hint`);
 * - `'replan'` when a collection changed while the run was under way
 *   (`collection`, `introduced`: the new conflicts or drops; nothing of that
 *   collection was written) — or its search index list could not be read
 *   again (as for `'plan'`);
 * - `'apply'` for a failed step (`collection`, `target`, `name`, `action`,
 *   `cause`, and `mongoCode`, `hint` and — after a failed rebuild — `restored`
 *   when they apply) — or a search index list that could not be read to check
 *   the steps just applied (as for `'plan'`);
 * - `'wait'` when `waitForSearchIndexes` gave up: `reason` is `'failed'` (the
 *   build of a search index this run created or changed FAILED) or `'timeout'`,
 *   with `notReady` the indexes not serving their declaration, `waitedMs`,
 *   `timeoutMs` — or `'unreadable'`: a search index list that could not be
 *   read (as for `'plan'`), after up to three network or failover blips in a
 *   row. Everything was applied — only the builds were not finished.
 *
 * `context.converge` is the {@link ConvergeResult} so far.
 */
export class ConvergeFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown by the optimistic-concurrency helpers of `@alexify/migronaut/versioning`
 * when a revision-guarded write matched nothing. `context.reason` is
 * `'conflict'` (the document is at another revision — `context.actual`),
 * `'not-found'` (nothing matches the filter) or `'unknown'` (the follow-up read
 * was skipped or could not tell); `context.expected` is the revision the
 * caller held. The filter is never copied into the error. Experimental.
 */
export class RevisionConflictError extends MigronautError {
  readonly context?: RevisionConflictContext;
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/** {@link RevisionConflictError}'s `context` — what a caller decides on */
export interface RevisionConflictContext {
  reason: 'conflict' | 'not-found' | 'unknown';
  /** The revision the caller held */
  expected: number;
  /** `conflict`: the revision the document is at */
  actual?: number;
  /** The collection's name, when the collection object has one */
  collection?: string;
  [key: string]: unknown;
}

/**
 * Thrown by an upcaster that cannot bring a document to the current shape:
 * `context.reason` is `'newer'`, `'below-min'` or `'invalid'`, with
 * `context.version` and `context.current`. Experimental.
 */
export class ShapeVersionError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown when a migration `requires` a background migration that has not
 * completed — or whose collection still holds old-shape documents. Nothing was
 * run; `context.waitsFor` lists what it waits for. Experimental.
 */
export class BackgroundPendingError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown when a background migration ended `failed`; `context.migration` names
 * it and `context.lastError` says what happened last. Experimental.
 */
export class BackgroundFailedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown when a control action does not fit the background migration's state;
 * `context.status` is the state found and `context.action` what was asked.
 * Experimental.
 */
export class BackgroundConflictError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}

/**
 * Thrown by the dry-run sandbox when a step reaches for something it cannot
 * run inside an always-aborted transaction; `context.method` names the call
 * and `context.reason` the rule. Experimental.
 */
export class SandboxRefusedError extends MigronautError {
  constructor(message: string, context?: Record<string, unknown>, options?: MigronautErrorOptions);
}
