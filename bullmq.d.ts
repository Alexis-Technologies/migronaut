import type {
  AuditReport,
  BackgroundCounters,
  BackgroundSliceResult,
  BackgroundStatus,
  BackgroundVerifyResult,
  BackgroundWatcher,
  CollectionConvergeResult,
  ConvergeSearchSummary,
  ConvergeUnstable,
  LockInfo,
  MigratorKit,
  MigratorKitOptions,
  MigronautConfig,
  MigronautErrorCode,
  OnLockHeld,
  StatusRow,
  WatchBackgroundOptions,
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
  /** Used to put back a job a shutdown stopped before it began */
  moveToWait?(token?: string): Promise<unknown>;
  /** Background jobs: continue later (a lane between slices, a coordinator polling) */
  moveToDelayed?(timestamp: number, token?: string): Promise<void>;
  /** Background coordinators: wait for the lanes they spawned (BullMQ ≥ 5 parents) */
  moveToWaitingChildren?(token: string, opts?: any): Promise<boolean>;
  updateData?(data: Data): Promise<void>;
  getIgnoredChildrenFailures?(): Promise<{ [jobKey: string]: string }>;
}

/** See {@link BullMQJobLike} for why this is structural */
export interface BullMQQueueLike {
  name: string;
  /** `prefix:name` — what a child job's `parent.queue` names. Background coordinators need it */
  readonly qualifiedName?: string;
  addBulk(
    jobs: (MigrationJobSpec | ConvergeJobSpec | BackgroundJobSpec | BackgroundLaneJobSpec)[],
  ): Promise<BullMQJobLike[]>;
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
  /** BullMQ ≥ 5.16 — whether the drift watch's schedule exists already */
  getJobScheduler?(id: string): Promise<unknown>;
}

/** See {@link BullMQJobLike} for why this is structural */
export interface BullMQWorkerLike {
  name: string;
  close(force?: boolean): Promise<void>;
}

/** See {@link BullMQJobLike} for why this is structural */
export interface BullMQQueueEventsLike {
  /** Present on every QueueEvents — how an injected instance is told apart from the class */
  on(event: string, listener: (...args: any[]) => void): unknown;
  close(): Promise<void>;
  waitUntilReady?(): Promise<unknown>;
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
/** The job names of a background queue */
export type BackgroundJobName = 'background' | 'background-lane' | 'background-verify';

/**
 * Job names: `up`/`down` carry one migration each; `sync` plans and enqueues
 * what is pending; `converge` brings the declared collections to their
 * declared state. On the background queue: `background` (a background
 * migration's coordinator), `background-lane` (one of its lanes, a child of
 * the coordinator) and `background-verify` (the drift watch).
 */
export const JOB_NAMES: Readonly<{
  UP: 'up';
  DOWN: 'down';
  SYNC: 'sync';
  CONVERGE: 'converge';
  BACKGROUND: 'background';
  BACKGROUND_LANE: 'background-lane';
  BACKGROUND_VERIFY: 'background-verify';
}>;
/**
 * Version stamped on every job's data as `v`. A worker accepts every version
 * from {@link MIN_JOB_DATA_VERSION} up to its own and refuses a newer one —
 * roll workers out before the producers that write a new version.
 */
export const JOB_DATA_VERSION: 1;
/** The oldest job data version a worker still accepts — moves only in a major release */
export const MIN_JOB_DATA_VERSION: 1;
export const DEFAULT_QUEUE_NAME: 'migronaut';
export const DEFAULT_SCHEDULER_ID: 'migronaut-sync';
/** Default id of a `schedule({ job: 'converge' })` schedule */
export const DEFAULT_CONVERGE_SCHEDULER_ID: 'migronaut-converge';
/** Id of the drift watch's schedule on the background queue */
export const DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID: 'migronaut-background-verify';
/** The background queue that serves a migration queue: `<queueName>-background` */
export function backgroundQueueName(queueName: string): string;

/**
 * Data of an `up` or `down` job. Stored in Redis — re-validated by the worker as untrusted input
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
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
  /**
   * `false` skips the order guard for this job. Always written by the
   * producer; a job without it (hand-added) gets the worker's default.
   */
  ordered?: boolean;
  /** SHA-256 of the migration file when the job was planned */
  checksum?: string;
  /** Who asked (≤ 128 characters) — carried by the jobs, stamped on the changelog / converge history */
  requestedBy?: string;
  /** Why (≤ 512 characters) — carried and stamped like `requestedBy` */
  reason?: string;
}

/**
 * Data of a `sync` job — what a schedule tick enqueues
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface SyncJobData {
  v: 1;
  kind: 'sync';
  /** Enqueue pending migrations only up to and including this file */
  to?: string;
}

/**
 * Data of a `converge` job. There is deliberately no `prune`: what may be
 * dropped is decided by the definitions the worker loads, never by a payload.
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface ConvergeJobData {
  v: 1;
  kind: 'converge';
  /** The enqueue call it belongs to — the `up` group it ends, or its own */
  groupId?: string;
  /**
   * `false` lets it run while migrations are pending. Always written by the
   * producer; a job without it gets the worker's default (refuse).
   */
  ordered?: boolean;
  /** Who asked (≤ 128 characters) — carried by the jobs, stamped on the changelog / converge history */
  requestedBy?: string;
  /** Why (≤ 512 characters) — carried and stamped like `requestedBy` */
  reason?: string;
}

/**
 * Data of a `background` job — the coordinator of one background migration.
 * Deduplicated on the migration: every heal collapses into the chain alive.
 * @experimental New in 2.3
 */
export interface BackgroundJobData {
  v: 1;
  kind: 'background';
  migration: string;
  /** The chain's round, minted on its first run — an older round bows out */
  round?: number;
  /** How many times this chain spawned lanes — part of their ids */
  spawn?: number;
  /** A takeover of a coordinator nothing has heard from for `stallMs` */
  takeover?: true;
  requestedBy?: string;
  reason?: string;
}

/**
 * Data of a `background-lane` job — one lane of a background migration
 * @experimental New in 2.3
 */
export interface BackgroundLaneJobData {
  v: 1;
  kind: 'background-lane';
  migration: string;
  registration: string;
  generation: number;
  round: number;
  spawn: number;
  /** 0 to 63 */
  lane: number;
  /** Failed slices in a row — the lane backs off, and gives up after `maxLaneRetries` */
  retry?: number;
}

/**
 * Data of a `background-verify` job — a drift-watch tick
 * @experimental New in 2.3
 */
export interface BackgroundVerifyJobData {
  v: 1;
  kind: 'background-verify';
}

/**
 * What a completed `background` job returns: the coordinator chain ended
 * @experimental New in 2.3
 */
export interface BackgroundJobResult {
  kind: 'background';
  migration: string;
  /** The background migration's status — or `superseded` (a newer round took over), `unregistered` */
  status: BackgroundStatus['status'] | 'blocked' | 'superseded' | 'unregistered';
  round?: number;
}

/**
 * What a completed `background-lane` job returns: nothing left for it to claim
 * (`exhausted`), the background migration stopped (`paused`, `cancelled`,
 * `failed`), no plan yet (`stale`) — or `gave-up` after `maxLaneRetries`
 * failed slices in a row (each counted on its partition, in MongoDB)
 * @experimental New in 2.3
 */
export interface BackgroundLaneJobResult {
  kind: 'background-lane';
  migration: string;
  outcome: BackgroundSliceResult['outcome'] | 'gave-up';
  counters?: BackgroundCounters;
  code?: MigronautErrorCode;
}

/**
 * What a completed `background-verify` job returns
 * @experimental New in 2.3
 */
export interface BackgroundVerifyJobResult extends BackgroundVerifyResult {
  kind: 'background-verify';
  /** Coordinators this tick added (or found alive) — the heal */
  enqueued: number;
}

/**
 * What a completed `up`/`down` job returns
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
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
  /** The coordinators enqueued for what the job registered — on a queue with a background side */
  background?: { migration: string; jobId: string }[];
}

/**
 * What a completed `sync` job returns
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
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
  /**
   * Present when the tick enqueued nothing because the next migration failed
   * and its file has not changed since — a schedule's circuit breaker. A fix
   * (a changed file) or an explicit `enqueueUp(name)` resumes the line.
   */
  held?: {
    migration: string;
    reason: string;
    failedAt?: Date;
    /** The background migrations it waits for — the tick enqueued what comes before it */
    waitsFor?: string[];
  };
  /** The heal of the background side: coordinators added, or found alive */
  background?: { enqueued: number };
}

/**
 * What a completed `converge` job returns — the kit's result, minus `dryRun`
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface ConvergeJobResult {
  kind: 'converge';
  groupId?: string;
  changed: number;
  inSync: boolean;
  collections: CollectionConvergeResult[];
  unstable?: ConvergeUnstable[];
  /**
   * Atlas Search availability and the declared search indexes still building
   * — when the worker's definitions declare search indexes. Whether the job
   * waits for them is the worker kit's `waitForSearchIndexes`.
   * @experimental New in 2.2
   */
  search?: ConvergeSearchSummary;
  runId?: string;
  /** Time (ms) spent waiting for the MongoDB migration lock */
  lockWaitMs: number;
}

/**
 * What a job reports through `job.updateProgress`
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface MigrationJobProgress {
  /** `search-wait` (New in 2.2): a converge job waiting for search index builds */
  phase: 'lock-wait' | 'running' | 'search-wait' | 'completed' | 'failed';
  migration?: string;
  direction?: 'up' | 'down';
  groupId?: string;
  index?: number;
  total?: number;
  kind?: 'sync' | 'converge';
  /** `lock-wait` only */
  attempts?: number;
  /** `lock-wait` and `search-wait` */
  waitedMs?: number;
  /**
   * `search-wait` only — how many search indexes the wait is for
   * @experimental New in 2.2
   */
  searchIndexes?: number;
  /**
   * `failed` only — the typed error code, so nobody has to parse
   * `failedReason`; `'UNKNOWN'` for an error that is not migronaut's.
   */
  code?: MigronautErrorCode | 'UNKNOWN';
  /**
   * `completed` and `failed` — the run's correlation id, matching the changelog
   * record and the kit's events. A failed job has no return value, so this is
   * where its run id is found.
   */
  runId?: string;
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

/**
 * Per-job options passed through to every background job — retention and
 * logging. Besides what a migration job refuses, the four options of a
 * parent's child-failure policy are refused: the adapter owns them.
 */
export interface BackgroundJobOptions extends MigrationJobOptions {
  failParentOnFailure?: never;
  continueParentOnFailure?: never;
  ignoreDependencyOnFailure?: never;
  removeDependencyOnFailure?: never;
}

/** A coordinator job as handed to `queue.addBulk` */
export interface BackgroundJobSpec {
  name: 'background';
  data: BackgroundJobData;
  opts: { attempts: number; deduplication: { id: string }; [option: string]: unknown };
}

/** A lane job as handed to `queue.addBulk` */
export interface BackgroundLaneJobSpec {
  name: 'background-lane';
  data: BackgroundLaneJobData;
  opts: { attempts: 1; [option: string]: unknown };
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
  /**
   * The first pending file that requires a background migration not
   * completed yet: the plan ends before it (and has no converge job)
   */
  waiting?: { migration: string; waitsFor: string[] };
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

/** {@link parseBackgroundJobData}'s normalized result */
export type ParsedBackgroundJobData =
  | {
      kind: 'background';
      migration: string;
      round?: number;
      spawn?: number;
      takeover?: true;
      requestedBy?: string;
      reason?: string;
    }
  | {
      kind: 'background-lane';
      migration: string;
      registration: string;
      generation: number;
      round: number;
      spawn: number;
      lane: number;
      retry: number;
    }
  | { kind: 'background-verify' };

/**
 * Validate a job read back from a background queue and return a normalized
 * copy. Throws `QueueJobInvalidError` for anything outside the contract.
 * @experimental New in 2.3
 */
export function parseBackgroundJobData(job: {
  id?: string;
  name: string;
  data: unknown;
}): ParsedBackgroundJobData;

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
  /**
   * Max time (ms) to wait without observing the holder make progress. Default
   * 90000, or 1.5× the holder's lock TTL when that is longer
   */
  lockWaitTimeoutMs?: number;
  /** First poll interval (ms); polls back off, doubling, up to 5 s. Default 500 */
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
  /** Who asked (≤ 128 characters) — carried by the jobs, stamped on the changelog / converge history */
  requestedBy?: string;
  /** Why (≤ 512 characters) — carried and stamped like `requestedBy` */
  reason?: string;
}

/** Options for `enqueueConverge` */
export interface EnqueueConvergeOptions {
  /** Default `true`: refuse while a migration is still pending. `false` converges anyway */
  ordered?: boolean;
  /** Who asked (≤ 128 characters) — carried by the jobs, stamped on the changelog / converge history */
  requestedBy?: string;
  /** Why (≤ 512 characters) — carried and stamped like `requestedBy` */
  reason?: string;
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
  /** Who asked (≤ 128 characters) — carried by the jobs, stamped on the changelog / converge history */
  requestedBy?: string;
  /** Why (≤ 512 characters) — carried and stamped like `requestedBy` */
  reason?: string;
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
  /** See {@link MigrationPlan.waiting} — the group stops before this file */
  waiting?: { migration: string; waitsFor: string[] };
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
    | {
        /**
         * Each tick runs the drift watch on the background queue (and heals
         * it) — overrides the schedule `startBackgroundWorker()` registers.
         * Needs the `background` option. @experimental
         */
        job: 'background-verify';
        /** Scheduler id. Default `'migronaut-background-verify'` */
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
  /**
   * The job's data as stored in Redis — redacted, but not validated: anything
   * with write access to Redis can have put it there. A job the adapter
   * enqueued has one of the contract's shapes; check before relying on it.
   */
  data: unknown;
  state: string;
  /** As stored — see {@link MigrationJobProgress} for what the adapter writes */
  progress: MigrationJobProgress | number;
  returnvalue?:
    | MigrationJobResult
    | SyncJobResult
    | ConvergeJobResult
    | BackgroundJobResult
    | BackgroundLaneJobResult
    | BackgroundVerifyJobResult;
  failedReason?: string;
  attemptsMade: number;
  timestamp?: number;
  processedOn?: number;
  finishedOn?: number;
}

// ─── Processor ─────────────────────────────────────────────────────────────────

/**
 * What a worker accepts from a job's payload beyond "apply what is pending, in
 * order". Anything that can write to Redis can enqueue, so the requests that
 * go further are opt-in; a job asking for one that is off fails as
 * `QUEUE_JOB_INVALID` (`context.permission`) before anything runs.
 * @experimental New in 2.1 — the shape may still change in a minor release (named in the CHANGELOG).
 */
export interface MigrationJobPermissions {
  /** Roll back (`down` jobs). Default `true` */
  down?: boolean;
  /** Re-run an applied migration (`force: true`). Default `false` */
  force?: boolean;
  /** Skip the order guard (`ordered: false`, on any job). Default `false` */
  unordered?: boolean;
}

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
  /** What a job may ask for beyond the ordinary — see {@link MigrationJobPermissions} */
  allow?: MigrationJobPermissions;
  /**
   * The background queue: what an `up` (or `down`) job registers gets its
   * coordinator there at once, and every `sync` tick heals it. @experimental
   */
  background?: {
    queue: BullMQQueueLike;
    jobOptions?: BackgroundJobOptions;
    /** See {@link EnqueueBackgroundOptions.stallMs} */
    stallMs?: number;
  };
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
  /**
   * Stop taking the lock. Irreversible. A job that has not started its
   * migration (or converge) yet — waiting for the lock, or fetched after the
   * shutdown — is moved back to the head of the queue (`job.moveToWait`) and
   * rejects with an error named `WaitingError`, which BullMQ records as
   * neither failed nor completed; without a token (outside a Worker) it fails
   * with `RunAbortedError`. Close your Worker first, or together with this: a
   * job put back must not be fetched again by the same worker.
   */
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

/** Options for {@link createBackgroundProcessor} */
export interface CreateBackgroundProcessorOptions {
  config?: Partial<MigronautConfig>;
  kitOptions?: MigratorKitOptions;
  kit?: MigratorKit;
  /** The background queue — the coordinators add their lanes to it. Required */
  queue: BullMQQueueLike;
  jobOptions?: BackgroundJobOptions;
  /** A lane's slice (ms). Default: each background migration's own `sliceMs` */
  sliceMs?: number;
  /**
   * `'auto'` (default): lanes are children of their coordinator, which waits
   * for them (`moveToWaitingChildren`) when the queue and its jobs support
   * it. `false`: lanes on their own, and the coordinator polls MongoDB.
   */
  children?: 'auto' | false;
  /** How often a coordinator without children looks again (ms). Default 5000 */
  pollIntervalMs?: number;
  /** See {@link EnqueueBackgroundOptions.stallMs} */
  stallMs?: number;
  /** Failed slices in a row before a lane gives up (0–100). Default 8 */
  maxLaneRetries?: number;
}

/**
 * The function a Worker on the background queue runs. Jobs run side by side.
 * @experimental New in 2.3
 */
export interface BackgroundProcessor {
  (
    job: BullMQJobLike<BackgroundJobData | BackgroundLaneJobData | BackgroundVerifyJobData>,
    token?: string,
    signal?: AbortSignal,
  ): Promise<BackgroundJobResult | BackgroundLaneJobResult | BackgroundVerifyJobResult>;
  readonly kit: MigratorKit;
  /**
   * Stop: a lane stops at its next batch, checkpoints, releases its lease and
   * goes back to the queue (moved to delayed); a coordinator bows out and
   * comes back. Irreversible.
   */
  shutdown(reason?: string): void;
  /** `shutdown()`, let the jobs in flight settle, disconnect a kit the processor created */
  close(): Promise<void>;
  /** A coordinator for every background migration with work to do — what a worker does at start */
  heal(): Promise<BackgroundEnqueueResult>;
}

/**
 * Build the processor for a Worker on the background queue you construct
 * yourself.
 * @experimental New in 2.3
 */
export function createBackgroundProcessor(
  options: CreateBackgroundProcessorOptions,
): BackgroundProcessor;

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

/** Options for `enqueueBackground` */
export interface EnqueueBackgroundOptions {
  /**
   * A running background migration nothing has moved for this long (ms) — no
   * live lease, no checkpoint, no coordinator step — also gets a takeover
   * coordinator, whose newer round retires the stuck one. Default 900000
   * (15 minutes); at least 1000.
   */
  stallMs?: number;
  requestedBy?: string;
  reason?: string;
}

/** What `enqueueBackground` resolves with */
export interface BackgroundEnqueueResult {
  /** One per coordinator added — or absorbed by the one already alive (same id) */
  jobs: { migration: string; id: string; takeover?: true }[];
}

/**
 * Enqueue the coordinator of one background migration (`migration`) — or of
 * every one with work to do — on a background queue you own. Idempotent.
 * @experimental New in 2.3
 */
export function enqueueBackground(
  queue: BullMQQueueLike,
  kit: MigratorKit,
  options?: EnqueueBackgroundOptions & { migration?: string; jobOptions?: BackgroundJobOptions },
): Promise<BackgroundEnqueueResult>;

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
  /**
   * One queue per database. Default `'migronaut'` (or the injected queue's
   * name — a different one is rejected)
   */
  queueName?: string;
  /** BullMQ key prefix. Default: the injected queue's own (a different one is rejected) */
  prefix?: string;
  jobOptions?: MigrationJobOptions;
  /** Defaults for `startWorker()` */
  workerOptions?: StartWorkerOptions;
  /**
   * Set the queue's global concurrency to 1 when the worker starts (BullMQ
   * ≥ 5.9), so several pods take turns. Default `true`. The order never
   * depends on it — the MongoDB lock and the order guard keep it; without it,
   * a job that reaches the lock before an earlier one still in flight on
   * another worker waits for that one (within its lock-wait budget).
   */
  globalConcurrency?: boolean;
  lockWait?: LockWaitOptions;
  /**
   * What the worker accepts from a job — and what `enqueueUp` / `enqueueDown` /
   * `enqueueConverge` accept on this object, so a request its own worker would
   * refuse fails at the call. Give every producer and worker the same policy.
   */
  allow?: MigrationJobPermissions;
  /**
   * Background migrations on a queue of their own (`<queueName>-background`):
   * a coordinator job each, with lanes as its children. `true` takes every
   * default. @experimental New in 2.3
   */
  background?: boolean | BackgroundQueueOptions;
}

/** The `background` option of {@link createMigrationQueue} */
export interface BackgroundQueueOptions {
  /** Default `<queueName>-background` (or the injected queue's name) */
  queueName?: string;
  /** A background Queue instance you own — never closed by `close()` */
  queue?: BullMQQueueLike;
  jobOptions?: BackgroundJobOptions;
  /** Defaults for `startBackgroundWorker()` — concurrency 2 unless given */
  workerOptions?: { concurrency?: number; [option: string]: unknown };
  /** See {@link CreateBackgroundProcessorOptions} */
  sliceMs?: number;
  children?: 'auto' | false;
  pollIntervalMs?: number;
  /** See {@link EnqueueBackgroundOptions.stallMs} */
  stallMs?: number;
  /**
   * The drift watch's schedule, registered by `startBackgroundWorker()` (ms,
   * ≥ 1000). Default 600000 (10 minutes) — registered only when no schedule
   * exists yet, so one set with `schedule({ job: 'background-verify' })`
   * stays; given explicitly, it is re-registered at every start. `false`
   * registers none.
   */
  verifyIntervalMs?: number | false;
  /** See {@link CreateBackgroundProcessorOptions.maxLaneRetries} */
  maxLaneRetries?: number;
  /**
   * Host the live drift watcher in the background worker's process — `true`,
   * or its options. Default: when the kit's `backgroundDrift` is `'stream'`
   * or `'both'`. Closed first by `close()`.
   */
  watch?: boolean | Omit<WatchBackgroundOptions, 'signal' | 'onError'>;
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
  /** The background queue (`background` option), if any */
  readonly backgroundQueue: BullMQQueueLike | undefined;
  /** The worker started by {@link startBackgroundWorker}, if any */
  readonly backgroundWorker: W | undefined;
  /** The background processor, for a Worker you construct yourself */
  readonly backgroundProcessor: BackgroundProcessor | undefined;
  /** The live drift watcher `startBackgroundWorker()` started, if any */
  readonly backgroundWatcher: BackgroundWatcher | undefined;

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

  /**
   * Enqueue the coordinator of one background migration — or of every one
   * with work to do. Idempotent. Needs the `background` option. @experimental
   */
  enqueueBackground(
    name?: string,
    options?: EnqueueBackgroundOptions,
  ): Promise<BackgroundEnqueueResult>;
  /** A background migration's status, read from MongoDB — `null` when not registered */
  backgroundStatus(name: string): Promise<BackgroundStatus | null>;
  /** Every background migration's status */
  backgroundStatus(): Promise<BackgroundStatus[]>;
  /**
   * The drift watch, now — and, with the `background` option, a coordinator
   * for whatever it reopened. @experimental
   */
  verifyBackground(options?: {
    onDrift?: 'reopen' | 'report';
    collections?: string[];
  }): Promise<BackgroundVerifyResult>;

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
   * first job. Calling it again resolves the same worker — or, after a start
   * that failed, tries again.
   */
  startWorker(options?: StartWorkerOptions): Promise<W>;
  /**
   * Start the background worker (concurrency 2 by default): coordinators and
   * lanes side by side. Registers the drift watch's schedule and heals — a
   * coordinator for every background migration with work to do. Needs the
   * `background` option. @experimental
   */
  startBackgroundWorker(options?: { concurrency?: number; [option: string]: unknown }): Promise<W>;
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
   * {@link DEFAULT_CONVERGE_SCHEDULER_ID} (or your own id) for another. The
   * background queue's schedules (the drift watch's) are looked for too.
   * Resolves whether one existed.
   */
  unschedule(id?: string): Promise<boolean>;

  /**
   * Stop fetching, stop taking the lock, let the worker finish its job, then
   * close everything this object created. A job that had not started its
   * migration is put back at the head of the queue for the next worker.
   * `force` skips waiting for the job in flight — whose migration body, if
   * running, keeps its connection: a kit this object created is disconnected
   * once it settles. Injected instances, the Redis connection and an injected
   * kit are left open. Idempotent.
   */
  close(options?: { force?: boolean }): Promise<void>;
}

/** Create a {@link MigrationQueue} — `new MigrationQueue(options)` with inference */
export function createMigrationQueue<
  Q extends BullMQQueueLike = BullMQQueueLike,
  W extends BullMQWorkerLike = BullMQWorkerLike,
  E extends BullMQQueueEventsLike = BullMQQueueEventsLike,
>(options: CreateMigrationQueueOptions<Q, W, E>): MigrationQueue<Q, W, E>;
