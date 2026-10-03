import type {
  AuditReport,
  CollectionConvergeResult,
  ConvergeUnstable,
  LockInfo,
  MigratorKit,
  MigratorKitOptions,
  MigronautConfig,
  MigronautErrorCode,
  OnLockHeld,
  StatusRow,
} from './index.js';

// ─── Structural BullMQ surface ─────────────────────────────────────────────────

/**
 * Structural stand-ins for BullMQ's `Job`, `Queue`, `Worker` and `QueueEvents`
 * — only the members the adapter actually calls.
 *
 * Deliberately not `import type { Queue } from 'bullmq'`: bullmq is not a
 * dependency of migronaut of any kind — you inject its classes — so a hard
 * import would make this declaration file fail to resolve for everyone who has
 * not installed it. The real classes are assignable to these (pinned by the
 * type tests against the real package), and the factory is generic over what
 * you inject, so `mq.queue` and `mq.worker` are your own `Queue`/`Worker`.
 * Injected classes are inferred with BullMQ's widest type arguments; name the
 * instance types to pin them — `createMigrationQueue<Queue, Worker>(…)`.
 *
 * Methods use shorthand syntax on purpose: method parameters are compared
 * bivariantly, which is what lets BullMQ's generic, overloaded signatures
 * satisfy these without being imported.
 */
export interface BullMQJobLike<Data = any, Result = any> {
  id?: string;
  name: string;
  data: Data;
  opts: { attempts?: number };
  attemptsMade: number;
  progress: unknown;
  returnvalue: Result;
  failedReason: string;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  updateProgress(progress: any): Promise<void>;
  log(row: string): Promise<number>;
  getState(): Promise<string>;
  waitUntilFinished(queueEvents: any, ttl?: number): Promise<Result>;
}

/** See {@link BullMQJobLike} for why this is structural */
export interface BullMQQueueLike {
  name: string;
  addBulk(jobs: (MigrationJobSpec | ConvergeJobSpec)[]): Promise<BullMQJobLike[]>;
  getJob(id: string): Promise<BullMQJobLike | undefined>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
  /** BullMQ ≥ 5.9 — used when present to cap the queue at one active job */
  setGlobalConcurrency?(concurrency: number): Promise<unknown>;
  /** BullMQ ≥ 5.16 — needed by `schedule()` */
  upsertJobScheduler?(id: string, repeat: any, template?: any): Promise<unknown>;
  /** BullMQ ≥ 5.16 — needed by `unschedule()` */
  removeJobScheduler?(id: string): Promise<boolean>;
}

/** See {@link BullMQJobLike} for why this is structural */
export interface BullMQWorkerLike {
  name: string;
  close(force?: boolean): Promise<void>;
}

/** See {@link BullMQJobLike} for why this is structural */
export interface BullMQQueueEventsLike {
  close(): Promise<void>;
}

/** The `Queue` class: `new Queue(name, { connection, prefix })` */
export type BullMQQueueClass<Q extends BullMQQueueLike = BullMQQueueLike> = new (
  name: string,
  opts: any,
) => Q;

/** The `Worker` class: `new Worker(name, processor, { connection, concurrency, … })` */
export type BullMQWorkerClass<W extends BullMQWorkerLike = BullMQWorkerLike> = new (
  name: string,
  processor: any,
  opts: any,
) => W;

/** The `QueueEvents` class: `new QueueEvents(name, { connection, prefix })` */
export type BullMQQueueEventsClass<E extends BullMQQueueEventsLike = BullMQQueueEventsLike> = new (
  name: string,
  opts: any,
) => E;

// ─── Job contract ──────────────────────────────────────────────────────────────

export type MigrationJobName = 'up' | 'down' | 'sync' | 'converge';

/**
 * Job names: `up`/`down` carry one migration each; `sync` plans and enqueues
 * what is pending; `converge` brings the declared collections to their
 * declared state.
 */
export const JOB_NAMES: Readonly<{ UP: 'up'; DOWN: 'down'; SYNC: 'sync'; CONVERGE: 'converge' }>;
/** Version stamped on every job's data as `v` — a worker rejects versions it does not know */
export const JOB_DATA_VERSION: 1;
export const DEFAULT_QUEUE_NAME: 'migronaut';
export const DEFAULT_SCHEDULER_ID: 'migronaut-sync';
/** Default id of a `schedule({ job: 'converge' })` schedule */
export const DEFAULT_CONVERGE_SCHEDULER_ID: 'migronaut-converge';

/** Data of an `up` or `down` job. Stored in Redis — re-validated by the worker as untrusted input */
export interface MigrationJobData {
  v: 1;
  direction: 'up' | 'down';
  /** Bare migration filename */
  migration: string;
  /** The enqueue call this job belongs to — minted by the kit's `generateId`, a UUID by default */
  groupId: string;
  /** Position within the group, and the group's size */
  index: number;
  total: number;
  /**
   * `up`: the batch every job of the group stamps (peeked once at enqueue
   * time). `down`: the batch the record carried, for information only.
   */
  batch?: number;
  /** Re-run an already-applied migration (`up` only) */
  force?: true;
  /** `false` skips the order guard for this job. Default: guarded */
  ordered?: boolean;
}

/** Data of a `sync` job — what a schedule tick enqueues */
export interface SyncJobData {
  v: 1;
  kind: 'sync';
  /** Enqueue pending migrations only up to and including this file */
  to?: string;
}

/**
 * Data of a `converge` job. There is deliberately no `prune`: what may be
 * dropped is decided by the definitions the worker loads, never by a payload.
 */
export interface ConvergeJobData {
  v: 1;
  kind: 'converge';
  /** The enqueue call it belongs to — the `up` group it ends, or its own */
  groupId?: string;
  /** `false` lets it run while migrations are pending. Default: refuse */
  ordered?: boolean;
}

/** What a completed `up`/`down` job returns */
export interface MigrationJobResult {
  migration: string;
  direction: 'up' | 'down';
  /** `'skipped'`: already applied (up) or already reverted (down) — a duplicate job, not an error */
  status: 'applied' | 'reverted' | 'skipped';
  duration?: number;
  batch?: number;
  /** Correlation id of the run, matching the changelog record and the kit's events */
  runId?: string;
  reason?: string;
  /** Time (ms) spent waiting for the MongoDB migration lock */
  lockWaitMs: number;
}

/** What a completed `sync` job returns */
export interface SyncJobResult {
  kind: 'sync';
  groupId: string | null;
  batch: number | null;
  /** Number of migration jobs this tick added */
  enqueued: number;
  upToDate: boolean;
  migrations: string[];
  /** The converge job this tick added (`convergeAfterUp`), if any */
  converge?: { jobId: string; deduplicated: boolean };
}

/** What a completed `converge` job returns — the kit's result, minus `dryRun` */
export interface ConvergeJobResult {
  kind: 'converge';
  groupId?: string;
  changed: number;
  inSync: boolean;
  collections: CollectionConvergeResult[];
  unstable?: ConvergeUnstable[];
  runId?: string;
  /** Time (ms) spent waiting for the MongoDB migration lock */
  lockWaitMs: number;
}

/** What a job reports through `job.updateProgress` */
export interface MigrationJobProgress {
  phase: 'lock-wait' | 'running' | 'completed' | 'failed';
  migration?: string;
  direction?: 'up' | 'down';
  groupId?: string;
  index?: number;
  total?: number;
  kind?: 'sync' | 'converge';
  /** `lock-wait` only */
  attempts?: number;
  waitedMs?: number;
  /** `failed` only — the typed error code, so nobody has to parse `failedReason` */
  code?: MigronautErrorCode | 'UNKNOWN';
}

/**
 * Per-job BullMQ options passed through to every migration job — retention and
 * logging knobs. Anything that would reorder, delay or re-run a job is refused:
 * the queue is first-in, first-out with a single attempt, on purpose.
 */
export interface MigrationJobOptions {
  removeOnComplete?: boolean | number | { age?: number; count?: number };
  removeOnFail?: boolean | number | { age?: number; count?: number };
  keepLogs?: number;
  stackTraceLimit?: number;
  sizeLimit?: number;
  attempts?: never;
  backoff?: never;
  delay?: never;
  priority?: never;
  lifo?: never;
  jobId?: never;
  deduplication?: never;
  repeat?: never;
  parent?: never;
  [option: string]: unknown;
}

/** One job as handed to `queue.addBulk` */
export interface MigrationJobSpec {
  name: 'up' | 'down';
  data: MigrationJobData;
  opts: { attempts: 1; deduplication: { id: string }; [option: string]: unknown };
}

/** A converge job as handed to `queue.addBulk` */
export interface ConvergeJobSpec {
  name: 'converge';
  data: ConvergeJobData;
  opts: { attempts: 1; deduplication: { id: string }; [option: string]: unknown };
}

/** A planned, not yet enqueued, group */
export interface MigrationPlan {
  /** Id of this enqueue call, in the kit's `generateId` format (a UUID by default) */
  groupId: string;
  direction: 'up' | 'down';
  /** Shared batch of an `up` group; null for `down` and for an empty plan */
  batch: number | null;
  /** The files, in execution order */
  migrations: string[];
  jobs: MigrationJobSpec[];
  /** The converge job that ends an `up` group — see `EnqueueUpOptions.converge` */
  converge?: ConvergeJobSpec;
}

/** {@link parseJobData}'s normalized result */
export type ParsedJobData =
  | {
      kind: 'migration';
      direction: 'up' | 'down';
      migration: string;
      groupId: string;
      index: number;
      total: number;
      batch?: number;
      force?: true;
      ordered?: boolean;
    }
  | { kind: 'sync'; to?: string }
  | { kind: 'converge'; groupId?: string; ordered?: boolean };

/**
 * Validate a job read back from the queue and return a normalized copy.
 * Throws `QueueJobInvalidError` for anything outside the contract.
 */
export function parseJobData(job: { id?: string; name: string; data: unknown }): ParsedJobData;

/** The deduplication id a migration's job carries — never contains `:` */
export function dedupId(direction: 'up' | 'down', migration: string): string;

/**
 * Error codes a later attempt can get past with nothing fixed (lock busy or
 * lost, database unreachable, run stopped). Every other `MigronautError` is
 * failed without retry.
 */
export const RETRYABLE_CODES: readonly MigronautErrorCode[];

/** Whether the processor treats `error` as retryable — see {@link RETRYABLE_CODES} */
export function isRetryableError(error: unknown): boolean;

// ─── Options ───────────────────────────────────────────────────────────────────

/** How a job behaves when the MongoDB migration lock is held (a CLI run, a peer worker) */
export interface LockWaitOptions {
  /** Default `'wait'` — unlike `runMigrations`, nothing is blocked on a job */
  onLockHeld?: OnLockHeld;
  /** Max time (ms) to wait without observing the holder make progress. Default 90000 */
  lockWaitTimeoutMs?: number;
  /** Default 500 */
  lockPollIntervalMs?: number;
}

/** Options for `enqueueUp` */
export interface EnqueueUpOptions {
  /** Enqueue pending migrations up to and including this file */
  to?: string;
  /** Re-run an already-applied migration. Needs a filename */
  force?: boolean;
  /**
   * Default `true`: each job refuses (`MigrationBlockedError`) while an
   * earlier migration is still pending. `false` gives the plain single-file
   * `up` of the CLI.
   */
  ordered?: boolean;
  /**
   * End the group with a converge job, which runs once every migration of the
   * group is applied (and refuses, as blocked, while one is not). Default: the
   * kit's `convergeAfterUp` — a queue never fires the kit's own after-up hook,
   * since each job is a single-file run. With nothing pending, a converge job
   * is added only when a dry run finds the database out of step. Refused with
   * a filename or `to`.
   */
  converge?: boolean;
}

/** Options for `enqueueConverge` */
export interface EnqueueConvergeOptions {
  /** Default `true`: refuse while a migration is still pending. `false` converges anyway */
  ordered?: boolean;
}

/** Options for `enqueueDown` */
export interface EnqueueDownOptions {
  /** Revert this batch instead of the last one */
  batch?: number;
  /** Revert the last N applied migrations */
  steps?: number;
  /** Revert everything applied after this migration */
  to?: string;
  /**
   * Default `true`: the rollback must be the top of the applied stack and each
   * job refuses while a later-applied migration remains. `false` gives the
   * CLI's unguarded `down`.
   */
  ordered?: boolean;
}

/** Options for a group's `wait()` */
export interface WaitOptions {
  /** One budget (ms) for the whole group. Default: no limit */
  timeoutMs?: number;
  /** A QueueEvents instance to listen on, when the facade was not given one */
  queueEvents?: BullMQQueueEventsLike;
}

/** What a group's `wait()` resolves with */
export interface GroupWaitResult {
  groupId: string;
  direction: 'up' | 'down';
  batch: number | null;
  /** One result per job, in group order */
  results: MigrationJobResult[];
  /** The group's converge job, when it had one */
  converge?: ConvergeJobResult;
}

/** Handle returned by `enqueueUp`/`enqueueDown` */
export interface MigrationGroup {
  /** Id of this enqueue call, in the kit's `generateId` format (a UUID by default) */
  groupId: string;
  direction: 'up' | 'down';
  /** The batch every job of an `up` group will stamp; null for `down` or when nothing was enqueued */
  batch: number | null;
  /** True when there was nothing to do — no job was added */
  upToDate: boolean;
  jobs: { id: string; migration: string; index: number }[];
  /**
   * Files whose job already existed in the queue (enqueued by a peer). Their
   * `jobs[].id` is that existing job, so `wait()` simply joins it.
   */
  deduplicated: string[];
  /** The converge job ending the group, or null. `deduplicated`: a peer's identical job */
  converge: { id: string; deduplicated: boolean } | null;
  /**
   * Resolve when every job has finished — the converge job last; reject with
   * `QueueJobFailedError` at the first one that fails or outlives `timeoutMs`.
   * Needs QueueEvents.
   */
  wait(options?: WaitOptions): Promise<GroupWaitResult>;
}

/** Handle returned by `enqueueConverge` */
export interface ConvergeHandle {
  groupId: string;
  jobId: string;
  /** True when an identical converge job was already waiting — `jobId` is that one */
  deduplicated: boolean;
  /** Resolve with the job's result; reject with `QueueJobFailedError`. Needs QueueEvents */
  wait(options?: WaitOptions): Promise<ConvergeJobResult>;
}

/**
 * Options for {@link MigrationQueue.schedule} — exactly one of `every` /
 * `pattern`, for a `sync` schedule (the default) or a `converge` one.
 */
export type ScheduleOptions = (
  | { every: number; pattern?: never }
  | { pattern: string; every?: never }
) & {
  /** Time zone for `pattern` */
  tz?: string;
} & (
    | {
        /** Each tick plans and enqueues what is pending. The default */
        job?: 'sync';
        /** Scheduler id. Default `'migronaut-sync'` */
        id?: string;
        /** Each tick enqueues pending migrations only up to and including this file */
        to?: string;
      }
    | {
        /** Each tick enqueues a converge job */
        job: 'converge';
        /** Scheduler id. Default `'migronaut-converge'` */
        id?: string;
        to?: never;
      }
  );

/** Options for {@link MigrationQueue.startWorker} — passed to the Worker constructor */
export interface StartWorkerOptions {
  /** Always 1; anything else is rejected */
  concurrency?: 1;
  /** BullMQ job lock (ms). Default 60000 */
  lockDuration?: number;
  stalledInterval?: number;
  /** Default 1 */
  maxStalledCount?: number;
  autorun?: boolean;
  [option: string]: unknown;
}

/** A job as plain, redacted data — what {@link MigrationQueue.getJob} returns */
export interface MigrationJobView {
  id: string;
  name: string;
  data: MigrationJobData | SyncJobData | ConvergeJobData;
  state: string;
  progress: MigrationJobProgress | number;
  returnvalue?: MigrationJobResult | SyncJobResult | ConvergeJobResult;
  failedReason?: string;
  attemptsMade: number;
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
}

// ─── Processor ─────────────────────────────────────────────────────────────────

/** Options for {@link createMigrationProcessor} */
export interface CreateMigrationProcessorOptions {
  /** Config for a MigratorKit the processor creates (and disconnects on `close()`) */
  config?: Partial<MigronautConfig>;
  kitOptions?: MigratorKitOptions;
  /** A kit you own instead of `config` — never disconnected by the processor */
  kit?: MigratorKit;
  /** The queue the jobs arrive on. Needed only to process `sync` jobs, which enqueue into it */
  queue?: BullMQQueueLike;
  lockWait?: LockWaitOptions;
  /** Order guard for jobs that do not say. Default `true` */
  ordered?: boolean;
  /** Options for the jobs a `sync` job enqueues */
  jobOptions?: MigrationJobOptions;
}

/**
 * The function a BullMQ Worker runs — pass it as the Worker's processor. It
 * declares exactly three parameters, which is what makes BullMQ hand it the
 * cancellation signal. Jobs are processed one at a time even when the Worker
 * is configured for more.
 */
export interface MigrationProcessor {
  (
    job: BullMQJobLike<MigrationJobData | SyncJobData | ConvergeJobData>,
    token?: string,
    signal?: AbortSignal,
  ): Promise<MigrationJobResult | SyncJobResult | ConvergeJobResult>;
  /** The kit running the jobs — subscribe to its events for metrics */
  readonly kit: MigratorKit;
  /** Stop taking the lock: a job waiting for it fails with `RunAbortedError`. Irreversible */
  shutdown(reason?: string): void;
  /** `shutdown()`, let the job in flight settle, disconnect a kit the processor created */
  close(): Promise<void>;
}

/**
 * Build the processor for a Worker you construct yourself (a NestJS
 * `@Processor`, BullMQ Pro, a shared worker process). Run it with
 * `concurrency: 1`.
 */
export function createMigrationProcessor(
  options?: CreateMigrationProcessorOptions,
): MigrationProcessor;

// ─── Producer building blocks ──────────────────────────────────────────────────

/** Plan an `up` group without enqueuing it */
export function planUpJobs(
  kit: MigratorKit,
  options?: EnqueueUpOptions & { filename?: string; jobOptions?: MigrationJobOptions },
): Promise<MigrationPlan>;

/** Plan a `down` group without enqueuing it */
export function planDownJobs(
  kit: MigratorKit,
  options?: EnqueueDownOptions & { filename?: string; jobOptions?: MigrationJobOptions },
): Promise<MigrationPlan>;

/** Enqueue pending migrations on a queue you own */
export function enqueueUp(
  queue: BullMQQueueLike,
  kit: MigratorKit,
  options?: EnqueueUpOptions & {
    filename?: string;
    jobOptions?: MigrationJobOptions;
    /** Lets the returned group's `wait()` work without further arguments */
    queueEvents?: BullMQQueueEventsLike;
  },
): Promise<MigrationGroup>;

/** Enqueue a rollback on a queue you own */
export function enqueueDown(
  queue: BullMQQueueLike,
  kit: MigratorKit,
  options?: EnqueueDownOptions & {
    filename?: string;
    jobOptions?: MigrationJobOptions;
    queueEvents?: BullMQQueueEventsLike;
  },
): Promise<MigrationGroup>;

/** Enqueue a converge job on its own, on a queue you own */
export function enqueueConverge(
  queue: BullMQQueueLike,
  kit: MigratorKit,
  options?: EnqueueConvergeOptions & {
    jobOptions?: MigrationJobOptions;
    /** Lets the returned handle's `wait()` work without further arguments */
    queueEvents?: BullMQQueueEventsLike;
  },
): Promise<ConvergeHandle>;

/** Wait for a group's jobs — what `MigrationGroup.wait()` calls */
export function waitForGroup(options: {
  queue: BullMQQueueLike;
  queueEvents: BullMQQueueEventsLike;
  groupId: string;
  direction: 'up' | 'down';
  batch: number | null;
  jobs: { id: string; migration: string }[];
  /** The group's converge job, waited for last */
  converge?: { id: string };
  timeoutMs?: number;
}): Promise<GroupWaitResult>;

// ─── Facade ────────────────────────────────────────────────────────────────────

/** Options for {@link createMigrationQueue} */
export interface CreateMigrationQueueOptions<
  Q extends BullMQQueueLike = BullMQQueueLike,
  W extends BullMQWorkerLike = BullMQWorkerLike,
  E extends BullMQQueueEventsLike = BullMQQueueEventsLike,
> {
  /**
   * BullMQ, from your own install — migronaut never imports it. Pass classes,
   * or instances you already have (an injected instance is never closed by
   * `close()`).
   */
  bullmq: {
    /** The `Queue` class, or a Queue instance */
    Queue: BullMQQueueClass<Q> | Q;
    /** The `Worker` class. Needed by `startWorker()`; a process that only enqueues can omit it */
    Worker?: BullMQWorkerClass<W>;
    /** The `QueueEvents` class, or an instance. Needed by `wait()` */
    QueueEvents?: BullMQQueueEventsClass<E> | E;
    /**
     * BullMQ's own telemetry object — `new BullMQOtel({ tracerName })` from
     * `bullmq-otel` — passed untouched to the Queue and the Worker this object
     * constructs. It is what joins the trace of the process that enqueues to
     * the one that applies. An injected Queue *instance* keeps whatever
     * telemetry it was built with; `workerOptions.telemetry` and
     * `startWorker({ telemetry })` override it for the worker.
     *
     * Not to be confused with the kit's own `config.telemetry` (a tracer and a
     * meter for migronaut's spans and metrics).
     */
    telemetry?: object;
  };
  /**
   * BullMQ `connection` — connection options or your Redis client, passed
   * through untouched and never closed. Required when anything is constructed
   * from a class.
   */
  connection?: unknown;
  /** Config for the MigratorKit the queue creates (and disconnects on `close()`) */
  config?: Partial<MigronautConfig>;
  kitOptions?: MigratorKitOptions;
  /** A kit you own instead of `config` — never disconnected by `close()` */
  kit?: MigratorKit;
  /** One queue per database. Default `'migronaut'` (or the injected queue's name) */
  queueName?: string;
  /** BullMQ key prefix */
  prefix?: string;
  jobOptions?: MigrationJobOptions;
  /** Defaults for `startWorker()` */
  workerOptions?: StartWorkerOptions;
  /**
   * Set the queue's global concurrency to 1 when the worker starts (BullMQ
   * ≥ 5.9), so several pods take turns. Default `true`. Correctness never
   * depends on it — the MongoDB lock and the order guard do that.
   */
  globalConcurrency?: boolean;
  lockWait?: LockWaitOptions;
}

/**
 * Migrations as a queue: one database's migrations, enqueued as one BullMQ job
 * each and applied in order by a single-concurrency worker. Status reads go
 * straight to MongoDB — the changelog, not the queue, is the source of truth.
 */
export class MigrationQueue<
  Q extends BullMQQueueLike = BullMQQueueLike,
  W extends BullMQWorkerLike = BullMQWorkerLike,
  E extends BullMQQueueEventsLike = BullMQQueueEventsLike,
> {
  constructor(options: CreateMigrationQueueOptions<Q, W, E>);

  /** The kit behind the queue — `kit.on('migration:success', …)` for metrics */
  readonly kit: MigratorKit;
  /** Your Queue, with its own type */
  readonly queue: Q;
  /** The worker started by {@link startWorker}, if any */
  readonly worker: W | undefined;
  /** The QueueEvents in use — injected, or built on the first `wait()` */
  readonly queueEvents: E | undefined;
  readonly queueName: string;
  /** The processor, for attaching to a Worker you construct yourself */
  readonly processor: MigrationProcessor;

  /**
   * Enqueue pending migrations — all, up to `options.to`, or the one
   * `filename` — as one job each, under a single shared batch.
   */
  enqueueUp(filename?: string, options?: EnqueueUpOptions): Promise<MigrationGroup>;
  /**
   * Enqueue a rollback — the last batch, `options.batch`, the last
   * `options.steps`, everything after `options.to`, or the one `filename` —
   * newest applied first.
   */
  enqueueDown(filename?: string, options?: EnqueueDownOptions): Promise<MigrationGroup>;
  /**
   * Enqueue a converge job: the declared collections brought to their declared
   * state by the worker, under the MongoDB lock — refused while a migration is
   * pending unless `ordered: false`. Experimental.
   */
  enqueueConverge(options?: EnqueueConvergeOptions): Promise<ConvergeHandle>;

  /** Full migration status, read from MongoDB */
  status(): Promise<StatusRow[]>;
  /** Migrations not applied yet */
  pending(): Promise<StatusRow[]>;
  audit(): Promise<AuditReport>;
  /** Current holder of the MongoDB migration lock, or null */
  lockInfo(): Promise<LockInfo | null>;

  /**
   * Start the worker (concurrency 1). Needs `bullmq.Worker`. Connects to
   * MongoDB first, so an unreachable database fails here rather than on the
   * first job. Calling it again resolves the same worker.
   */
  startWorker(options?: StartWorkerOptions): Promise<W>;
  /** Stop workers from picking up new jobs; the job in flight finishes */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** A job as plain, redacted data — or null */
  getJob(id: string): Promise<MigrationJobView | null>;

  /**
   * Keep the database migrated on a schedule: each tick enqueues a `sync` job
   * that plans and enqueues whatever is pending — or, with `job: 'converge'`,
   * a converge job on a cadence of its own. Idempotent. BullMQ ≥ 5.16.
   */
  schedule(options: ScheduleOptions): Promise<void>;
  /**
   * Remove a schedule — the sync one by default; pass
   * {@link DEFAULT_CONVERGE_SCHEDULER_ID} (or your own id) for another.
   * Resolves whether one existed.
   */
  unschedule(id?: string): Promise<boolean>;

  /**
   * Stop taking the lock, let the worker finish its job (`force` skips that
   * wait), then close everything this object created. Injected instances, the
   * Redis connection and an injected kit are left open. Idempotent.
   */
  close(options?: { force?: boolean }): Promise<void>;
}

/** Create a {@link MigrationQueue} — `new MigrationQueue(options)` with inference */
export function createMigrationQueue<
  Q extends BullMQQueueLike = BullMQQueueLike,
  W extends BullMQWorkerLike = BullMQWorkerLike,
  E extends BullMQQueueEventsLike = BullMQQueueEventsLike,
>(options: CreateMigrationQueueOptions<Q, W, E>): MigrationQueue<Q, W, E>;
