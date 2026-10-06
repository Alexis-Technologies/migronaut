import { Job, type Processor, Queue, QueueEvents, Worker } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import { expectAssignable, expectError, expectNotAssignable, expectType } from 'tsd';
import {
  type BackgroundEnqueueResult,
  type BackgroundJobData,
  type BackgroundJobResult,
  type BackgroundLaneJobData,
  type BackgroundLaneJobResult,
  type BackgroundProcessor,
  type BackgroundVerifyJobData,
  type BackgroundVerifyJobResult,
  type BullMQJobLike,
  type BullMQQueueEventsLike,
  type BullMQQueueLike,
  type BullMQWorkerLike,
  type ConvergeHandle,
  type ConvergeJobData,
  type ConvergeJobResult,
  type ConvergeJobSpec,
  DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID,
  DEFAULT_CONVERGE_SCHEDULER_ID,
  DEFAULT_QUEUE_NAME,
  DEFAULT_SCHEDULER_ID,
  type GroupWaitResult,
  JOB_DATA_VERSION,
  MIN_JOB_DATA_VERSION,
  JOB_NAMES,
  type MigrationGroup,
  type CreateMigrationProcessorOptions,
  type MigrationJobData,
  type MigrationJobPermissions,
  type MigrationJobProgress,
  type MigrationJobResult,
  type MigrationJobView,
  type MigrationPlan,
  type MigrationProcessor,
  MigrationQueue,
  type ParsedBackgroundJobData,
  type ParsedJobData,
  RETRYABLE_CODES,
  type SyncJobData,
  type SyncJobResult,
  backgroundQueueName,
  createBackgroundProcessor,
  createMigrationProcessor,
  createMigrationQueue,
  dedupId,
  enqueueBackground,
  enqueueConverge,
  enqueueDown,
  enqueueUp,
  isRetryableError,
  parseBackgroundJobData,
  parseJobData,
  planDownJobs,
  planUpJobs,
  waitForGroup,
} from '../../bullmq.js';
import {
  type AuditReport,
  type BackgroundStatus,
  type BackgroundVerifyResult,
  type LockInfo,
  MigratorKit,
  type MigronautErrorCode,
  type StatusRow,
} from '../../index.js';

const connection = { host: 'localhost', port: 6379 };
const config = { uri: 'mongodb://localhost:27017', dbName: 'test' };

// ─── The real BullMQ classes satisfy the structural stand-ins ────────────────
// bullmq.d.ts never imports bullmq, so this is where that claim is checked
// against the real package (a devDependency) instead of being taken on trust.

declare const realQueue: Queue;
declare const realWorker: Worker;
declare const realQueueEvents: QueueEvents;
declare const realJob: Job<MigrationJobData, MigrationJobResult>;
expectAssignable<BullMQQueueLike>(realQueue);
expectAssignable<BullMQWorkerLike>(realWorker);
expectAssignable<BullMQQueueEventsLike>(realQueueEvents);
expectAssignable<BullMQJobLike<MigrationJobData, MigrationJobResult>>(realJob);

// ─── Factory: what you inject is what you get back ───────────────────────────

const mq = createMigrationQueue({ bullmq: { Queue, Worker, QueueEvents }, connection, config });
// Methods the structural types do not declare — the real classes flowed through.
expectAssignable<Promise<{ [index: string]: number }>>(mq.queue.getJobCounts());
expectType<boolean>((await mq.startWorker()).isRunning());
expectType<MigratorKit>(mq.kit);

// BullMQ's own telemetry object rides in with the classes it is passed to.
// bullmq.d.ts never imports bullmq-otel; the real class fits the slot.
createMigrationQueue({
  bullmq: { Queue, Worker, QueueEvents, telemetry: new BullMQOtel({ tracerName: 'migrations' }) },
  connection,
  config,
});
expectError(createMigrationQueue({ bullmq: { Queue, telemetry: 'otel' }, connection }));
// The worker alone can be given a different one.
void mq.startWorker({ telemetry: new BullMQOtel({ tracerName: 'worker' }) });

// Naming the instance types pins BullMQ's own defaults instead of the inferred widest ones.
const typed = createMigrationQueue<Queue, Worker, QueueEvents>({
  bullmq: { Queue, Worker, QueueEvents },
  connection,
  config,
});
expectType<Queue>(typed.queue);
expectType<Promise<Worker>>(typed.startWorker());
expectType<Worker | undefined>(typed.worker);
expectType<QueueEvents | undefined>(typed.queueEvents);
expectType<string>(mq.queueName);
expectType<MigrationProcessor>(mq.processor);

// An instance instead of the class — and a producer-only process needs no Worker.
const fromInstance = createMigrationQueue({ bullmq: { Queue: realQueue }, config });
expectType<Queue>(fromInstance.queue);
createMigrationQueue({ bullmq: { Queue, QueueEvents: realQueueEvents }, connection, config });
new MigrationQueue({ bullmq: { Queue, Worker }, connection, kit: new MigratorKit(config) });

// Options that would break first-in, first-out are compile errors.
expectError(createMigrationQueue({}));
expectError(createMigrationQueue({ connection, config }));
expectError(createMigrationQueue({ bullmq: { Worker }, connection }));
expectError(
  createMigrationQueue({ bullmq: { Queue, Worker }, connection, jobOptions: { attempts: 3 } }),
);
expectError(
  createMigrationQueue({ bullmq: { Queue, Worker }, connection, jobOptions: { priority: 1 } }),
);
expectError(
  createMigrationQueue({
    bullmq: { Queue, Worker },
    connection,
    workerOptions: { concurrency: 4 },
  }),
);
expectError(mq.startWorker({ concurrency: 2 }));
createMigrationQueue({
  bullmq: { Queue, Worker },
  connection,
  queueName: 'billing-migrations',
  prefix: 'app',
  jobOptions: { removeOnComplete: { count: 500 }, removeOnFail: false },
  workerOptions: { lockDuration: 120_000 },
  globalConcurrency: false,
  lockWait: { onLockHeld: 'wait', lockWaitTimeoutMs: 120_000, lockPollIntervalMs: 250 },
});

// ─── Enqueue, wait, read ─────────────────────────────────────────────────────

expectType<Promise<MigrationGroup>>(mq.enqueueUp());
expectType<Promise<MigrationGroup>>(mq.enqueueUp(undefined, { to: '0005-x.js' }));
expectType<Promise<MigrationGroup>>(mq.enqueueUp('0005-x.js', { force: true, ordered: false }));
expectType<Promise<MigrationGroup>>(mq.enqueueDown(undefined, { steps: 2 }));
expectType<Promise<MigrationGroup>>(mq.enqueueDown('0005-x.js'));
expectError(mq.enqueueUp(undefined, { steps: 2 }));

declare const group: MigrationGroup;
expectType<string>(group.groupId);
expectType<number | null>(group.batch);
expectType<boolean>(group.upToDate);
expectType<{ id: string; migration: string; index: number }[]>(group.jobs);
expectType<string[]>(group.deduplicated);
expectType<Promise<GroupWaitResult>>(group.wait());
expectType<Promise<GroupWaitResult>>(
  group.wait({ timeoutMs: 60_000, queueEvents: realQueueEvents }),
);
declare const waited: GroupWaitResult;
expectType<MigrationJobResult[]>(waited.results);
expectType<'applied' | 'reverted' | 'skipped'>(waited.results[0].status);
expectType<number>(waited.results[0].lockWaitMs);

expectType<Promise<StatusRow[]>>(mq.status());
expectType<Promise<StatusRow[]>>(mq.pending());
expectType<Promise<AuditReport>>(mq.audit());
expectType<Promise<LockInfo | null>>(mq.lockInfo());
expectType<Promise<MigrationJobView | null>>(mq.getJob('1'));
expectType<Promise<void>>(mq.pause());
expectType<Promise<void>>(mq.resume());
expectType<Promise<void>>(mq.close());
expectType<Promise<void>>(mq.close({ force: true }));

// ─── Scheduling: exactly one of `every` / `pattern` ──────────────────────────

expectType<Promise<void>>(mq.schedule({ every: 60_000 }));
expectType<Promise<void>>(mq.schedule({ pattern: '0 3 * * *', tz: 'UTC', to: '0005-x.js' }));
expectError(mq.schedule({}));
expectError(mq.schedule({ every: 60_000, pattern: '0 3 * * *' }));
expectType<Promise<boolean>>(mq.unschedule());
expectType<Promise<boolean>>(mq.unschedule('nightly'));

// ─── Low-level: a Worker you own ─────────────────────────────────────────────

const processor = createMigrationProcessor({ config, queue: realQueue });
expectType<MigrationProcessor>(processor);
// It is a real BullMQ processor, cancellation signal included.
expectAssignable<
  Processor<
    MigrationJobData | SyncJobData | ConvergeJobData,
    MigrationJobResult | SyncJobResult | ConvergeJobResult
  >
>(processor);
new Worker<
  MigrationJobData | SyncJobData | ConvergeJobData,
  MigrationJobResult | SyncJobResult | ConvergeJobResult
>('migronaut', processor, { connection, concurrency: 1 });
expectType<AbortSignal | undefined>(undefined as Parameters<MigrationProcessor>[2]);
expectType<MigratorKit>(processor.kit);
expectType<void>(processor.shutdown('deploying'));
expectType<Promise<void>>(processor.close());
expectError(createMigrationProcessor({ lockWait: { onLockHeld: 'retry' } }));

declare const ownKit: MigratorKit;
expectType<Promise<MigrationPlan>>(planUpJobs(ownKit, { to: '0005-x.js' }));
expectType<Promise<MigrationPlan>>(planDownJobs(ownKit, { steps: 1 }));
expectType<Promise<MigrationGroup>>(enqueueUp(realQueue, ownKit, { queueEvents: realQueueEvents }));
expectType<Promise<MigrationGroup>>(enqueueDown(realQueue, ownKit, { filename: '0005-x.js' }));
expectType<Promise<GroupWaitResult>>(
  waitForGroup({
    queue: realQueue,
    queueEvents: realQueueEvents,
    groupId: 'g',
    direction: 'up',
    batch: 3,
    jobs: [{ id: '1', migration: '0001-a.js' }],
  }),
);

// ─── The job contract ────────────────────────────────────────────────────────

expectType<'up'>(JOB_NAMES.UP);
expectType<'down'>(JOB_NAMES.DOWN);
expectType<'sync'>(JOB_NAMES.SYNC);
expectType<1>(JOB_DATA_VERSION);
expectType<1>(MIN_JOB_DATA_VERSION);
expectAssignable<CreateMigrationProcessorOptions>({ allow: { force: true, unordered: false } });
expectNotAssignable<CreateMigrationProcessorOptions>({ allow: { sudo: true } });
expectAssignable<MigrationJobPermissions>({ down: false });
expectType<'migronaut'>(DEFAULT_QUEUE_NAME);
expectType<'migronaut-sync'>(DEFAULT_SCHEDULER_ID);
expectType<readonly MigronautErrorCode[]>(RETRYABLE_CODES);
expectType<boolean>(isRetryableError(new Error('x')));
expectType<string>(dedupId('up', '0001-a.js'));
expectType<ParsedJobData>(parseJobData(realJob));
declare const progress: MigrationJobProgress;
expectType<'lock-wait' | 'running' | 'search-wait' | 'completed' | 'failed'>(progress.phase);
expectType<number | undefined>(progress.searchIndexes);
expectType<MigronautErrorCode | 'UNKNOWN' | undefined>(progress.code);
expectType<string | undefined>(progress.runId);

// ─── Converge jobs ───────────────────────────────────────────────────────────

expectType<'converge'>(JOB_NAMES.CONVERGE);
expectType<'migronaut-converge'>(DEFAULT_CONVERGE_SCHEDULER_ID);
expectType<Promise<ConvergeHandle>>(mq.enqueueConverge());
expectType<Promise<ConvergeHandle>>(mq.enqueueConverge({ ordered: false }));
expectError(mq.enqueueConverge({ prune: true }));
expectType<Promise<ConvergeHandle>>(
  enqueueConverge(realQueue, ownKit, { queueEvents: realQueueEvents }),
);
expectType<Promise<MigrationGroup>>(mq.enqueueUp(undefined, { converge: true }));

declare const convergeHandle: ConvergeHandle;
expectType<Promise<ConvergeJobResult>>(convergeHandle.wait({ timeoutMs: 1000 }));
declare const convergeGroup: MigrationGroup;
expectType<{ id: string; deduplicated: boolean } | null>(convergeGroup.converge);
declare const convergeWait: GroupWaitResult;
expectType<ConvergeJobResult | undefined>(convergeWait.converge);
declare const convergePlan: MigrationPlan;
expectType<ConvergeJobSpec | undefined>(convergePlan.converge);
declare const convergeResult: ConvergeJobResult;
expectType<boolean>(convergeResult.inSync);
expectType<number>(convergeResult.lockWaitMs);
expectType<boolean | undefined>(convergeResult.search?.available);
expectAssignable<string | undefined>(convergeResult.search?.notReady[0]?.status);
declare const syncResult: SyncJobResult;
expectType<{ jobId: string; deduplicated: boolean } | undefined>(syncResult.converge);
// A payload carries no prune — the worker's own definitions decide.
expectError<ConvergeJobData>({ v: 1, kind: 'converge', prune: true });

expectType<Promise<void>>(mq.schedule({ job: 'converge', pattern: '0 3 * * *' }));
expectType<Promise<void>>(mq.schedule({ job: 'converge', every: 60_000, id: 'nightly-converge' }));
expectError(mq.schedule({ job: 'converge', every: 60_000, to: '0005-x.js' }));
expectError(mq.schedule({ job: 'migrate', every: 60_000 }));
expectType<Promise<boolean>>(mq.unschedule(DEFAULT_CONVERGE_SCHEDULER_ID));

// ─── Background migrations on their own queue ────────────────────────────────

// The moves a background job makes exist on the real Job, and the real Queue
// has the qualifiedName a child's `parent` names.
declare const realBackgroundJob: Job<BackgroundJobData, BackgroundJobResult>;
expectAssignable<BullMQJobLike<BackgroundJobData, BackgroundJobResult>>(realBackgroundJob);
expectType<string>(realQueue.qualifiedName);

expectType<'background'>(JOB_NAMES.BACKGROUND);
expectType<'background-lane'>(JOB_NAMES.BACKGROUND_LANE);
expectType<'background-verify'>(JOB_NAMES.BACKGROUND_VERIFY);
expectType<'migronaut-background-verify'>(DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID);
expectType<string>(backgroundQueueName('migronaut'));
expectType<ParsedBackgroundJobData>(parseBackgroundJobData(realBackgroundJob));

const withBackground = createMigrationQueue<Queue, Worker, QueueEvents>({
  bullmq: { Queue, Worker, QueueEvents },
  connection,
  config,
  background: {
    jobOptions: { removeOnComplete: { count: 50 } },
    workerOptions: { concurrency: 4 },
    sliceMs: 10_000,
    children: 'auto',
    stallMs: 600_000,
    verifyIntervalMs: false,
    watch: { refreshMs: 10_000, maxCollections: 4 },
  },
});
expectType<boolean | undefined>(withBackground.backgroundWatcher?.running);
expectError(
  createMigrationQueue({ bullmq: { Queue }, connection, background: { watch: { signal: 1 } } }),
);
createMigrationQueue({ bullmq: { Queue, Worker }, connection, config, background: true });
expectError(
  createMigrationQueue({
    bullmq: { Queue },
    connection,
    background: { jobOptions: { ignoreDependencyOnFailure: true } },
  }),
);
expectError(
  createMigrationQueue({ bullmq: { Queue }, connection, background: { children: true } }),
);
expectType<Promise<Worker>>(withBackground.startBackgroundWorker({ concurrency: 3 }));
expectType<Worker | undefined>(withBackground.backgroundWorker);
expectType<BackgroundProcessor | undefined>(withBackground.backgroundProcessor);
expectType<BullMQQueueLike | undefined>(withBackground.backgroundQueue);
expectType<Promise<BackgroundEnqueueResult>>(withBackground.enqueueBackground());
expectType<Promise<BackgroundEnqueueResult>>(
  withBackground.enqueueBackground('0001-orders.js', { requestedBy: 'ops' }),
);
expectType<Promise<BackgroundStatus | null>>(withBackground.backgroundStatus('0001-orders.js'));
expectType<Promise<BackgroundStatus[]>>(withBackground.backgroundStatus());
expectType<Promise<BackgroundVerifyResult>>(withBackground.verifyBackground({ onDrift: 'report' }));
expectType<Promise<void>>(withBackground.schedule({ job: 'background-verify', every: 300_000 }));
expectError(withBackground.schedule({ job: 'background-verify', every: 1, to: '0005-x.js' }));

const backgroundProcessor = createBackgroundProcessor({
  config,
  queue: realQueue,
  maxLaneRetries: 4,
});
expectType<BackgroundProcessor>(backgroundProcessor);
expectAssignable<
  Processor<
    BackgroundJobData | BackgroundLaneJobData | BackgroundVerifyJobData,
    BackgroundJobResult | BackgroundLaneJobResult | BackgroundVerifyJobResult
  >
>(backgroundProcessor);
expectType<Promise<BackgroundEnqueueResult>>(backgroundProcessor.heal());
expectError(createBackgroundProcessor({ config }));
expectType<Promise<BackgroundEnqueueResult>>(
  enqueueBackground(realQueue, ownKit, { migration: '0001-orders.js', stallMs: 60_000 }),
);

declare const laneResult: BackgroundLaneJobResult;
expectAssignable<string>(laneResult.outcome);
declare const verifyResult: BackgroundVerifyJobResult;
expectType<number>(verifyResult.enqueued);
declare const heldSync: SyncJobResult;
expectType<string[] | undefined>(heldSync.waiting?.waitsFor);
expectError(heldSync.held?.waitsFor);
expectType<{ enqueued: number } | undefined>(heldSync.background);
declare const registeringUp: MigrationJobResult;
expectType<{ migration: string; jobId: string }[] | undefined>(registeringUp.background);
declare const cutPlan: MigrationPlan;
expectType<{ migration: string; waitsFor: string[] } | undefined>(cutPlan.waiting);
