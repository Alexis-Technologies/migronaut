const { MigratorKit } = require('../core/migrator.js');
const { ConfigInvalidError, MigronautError } = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { isBareFilename } = require('../utils/migration-name.js');
const { redactDeep, redactOutbound } = require('../utils/redact.js');
const {
  DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID,
  DEFAULT_CONVERGE_SCHEDULER_ID,
  DEFAULT_QUEUE_NAME,
  DEFAULT_SCHEDULER_ID,
  JOB_NAMES,
  backgroundQueueName,
  buildBackgroundVerifyJobTemplate,
  buildConvergeJobTemplate,
  permissionsNeeded,
  resolveAllow,
  buildSyncJobTemplate,
  isObjectLike,
} = require('./jobs.js');
const {
  createBackgroundProcessor,
  resolveBackgroundProcessorOptions,
} = require('./background-processor.js');
const { createMigrationProcessor, resolveProcessorOptions } = require('./processor.js');
const {
  DEFAULT_STALL_MS,
  assertJobOptions,
  enqueueBackground,
  enqueueConverge,
  enqueueDown,
  enqueueUp,
} = require('./producer.js');

/**
 * Twice BullMQ's default job lock: its renewal (every half) then survives a
 * migration that keeps the event loop busy for a while, instead of the job
 * being declared stalled and handed to another worker mid-run.
 */
const DEFAULT_LOCK_DURATION_MS = 60_000;
/** One stall is a crashed worker; a second on the same job is a pattern — fail it */
const DEFAULT_MAX_STALLED_COUNT = 1;
/** The shortest interval `schedule({ every })` accepts */
const MIN_SCHEDULE_EVERY_MS = 1000;
/** Background jobs run side by side — a lane and a coordinator need not take turns */
const DEFAULT_BACKGROUND_CONCURRENCY = 2;
/** How often the drift watch runs on the background queue by default */
const DEFAULT_BACKGROUND_VERIFY_MS = 600_000;
/** Every key the `background` option accepts */
const BACKGROUND_KEYS = new Set([
  'queueName',
  'queue',
  'jobOptions',
  'workerOptions',
  'sliceMs',
  'children',
  'pollIntervalMs',
  'stallMs',
  'verifyIntervalMs',
  'watch',
  'maxLaneRetries',
]);

/**
 * The `background` option, checked and filled in — or undefined when the
 * queue has no background side. `true` takes every default.
 */
function resolveBackground(background, { queueName, QueueSource }) {
  if (background === undefined || background === false) return undefined;
  const options = background === true ? {} : background;
  if (!isObjectLike(options)) {
    throw new ConfigInvalidError('background must be true or an object');
  }
  for (const key of Object.keys(options)) {
    if (!BACKGROUND_KEYS.has(key)) {
      throw new ConfigInvalidError(`background.${key} is not a known option`, { key });
    }
  }
  const queueIsInstance =
    options.queue !== undefined &&
    isObjectLike(options.queue) &&
    typeof options.queue.addBulk === 'function';
  if (options.queue !== undefined && !queueIsInstance) {
    throw new ConfigInvalidError('background.queue must be a Queue instance');
  }
  if (!queueIsInstance && !isClass(QueueSource)) {
    throw new ConfigInvalidError(
      'background needs bullmq.Queue as a class to build its queue — or a background.queue',
    );
  }
  const name =
    options.queueName ??
    (queueIsInstance ? options.queue.name : undefined) ??
    backgroundQueueName(queueName);
  assertName(name, 'background.queueName');
  if (name === queueName) {
    throw new ConfigInvalidError('background.queueName must differ from the migration queue', {
      queueName: name,
    });
  }
  if (options.workerOptions !== undefined && !isObjectLike(options.workerOptions)) {
    throw new ConfigInvalidError('background.workerOptions must be an object');
  }
  assertBackgroundConcurrency(options.workerOptions?.concurrency);
  const verifyIntervalMs = options.verifyIntervalMs ?? DEFAULT_BACKGROUND_VERIFY_MS;
  if (
    verifyIntervalMs !== false &&
    (!Number.isSafeInteger(verifyIntervalMs) || verifyIntervalMs < MIN_SCHEDULE_EVERY_MS)
  ) {
    throw new ConfigInvalidError(
      `background.verifyIntervalMs must be false or an integer ≥ ${MIN_SCHEDULE_EVERY_MS}`,
      { verifyIntervalMs },
    );
  }
  const { watch } = options;
  if (watch !== undefined && typeof watch !== 'boolean' && !isObjectLike(watch)) {
    throw new ConfigInvalidError('background.watch must be a boolean or the watcher options');
  }
  // Said explicitly, the interval is re-registered at every start; left to its
  // default, a schedule set with schedule({ job: 'background-verify' }) stays.
  return {
    ...options,
    name,
    queueIsInstance,
    verifyIntervalMs,
    verifyIntervalGiven: options.verifyIntervalMs !== undefined,
  };
}

function assertBackgroundConcurrency(concurrency) {
  if (concurrency !== undefined && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
    throw new ConfigInvalidError('background worker concurrency must be a positive integer', {
      concurrency,
    });
  }
}

const isClass = (value) => typeof value === 'function';

/** A short string field of a job read back from Redis, or undefined — for log fields only */
function shortString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 ? value : undefined;
}

/** What a failed job's log line can say about it, from the job and from the error */
function failedJobFields(job, error) {
  const data = job?.data ?? {};
  const fields = {
    ...(job?.id !== undefined ? { jobId: String(job.id) } : {}),
    groupId: shortString(data.groupId),
    migration: shortString(data.migration),
    direction: shortString(data.direction),
    runId: shortString(error?.context?.runId),
    ...(error instanceof MigronautError ? { code: error.code } : {}),
  };
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
  return fields;
}

function assertName(value, name) {
  // BullMQ builds its Redis keys by joining with `:` and rejects it in names.
  if (typeof value !== 'string' || value.length === 0 || value.includes(':')) {
    throw new ConfigInvalidError(`${name} must be a non-empty string without ':'`, {
      [name]: value,
    });
  }
}

/**
 * Migrations as a queue: one database's migrations, enqueued as one BullMQ job
 * each and applied by a single-concurrency worker.
 *
 * BullMQ itself is never imported — the classes (or ready instances) come in
 * through `options.bullmq`, the same way a Mongoose instance or a pino logger
 * does. Whatever this object constructed, it closes; whatever was handed to it
 * (a Queue instance, the Redis connection, a kit, its MongoClient) stays the
 * caller's to close.
 */
class MigrationQueue {
  #kit;
  #ownsKit;
  #queue;
  #ownsQueue;
  #WorkerClass;
  #worker;
  #workerStarting;
  #queueEventsSource;
  #queueEvents;
  #ownsQueueEvents = false;
  #processor;
  #connection;
  #queueName;
  #prefix;
  #jobOptions;
  #workerOptions;
  #telemetry;
  #globalConcurrency;
  #allow;
  #closing;
  #background;
  #backgroundQueue;
  #ownsBackgroundQueue = false;
  #backgroundProcessor;
  #backgroundWorker;
  #backgroundStarting;
  #backgroundWatcher;

  constructor(options) {
    if (!isObjectLike(options)) {
      throw new ConfigInvalidError('createMigrationQueue options must be an object');
    }
    const {
      config,
      kit,
      kitOptions,
      bullmq,
      connection,
      queueName,
      prefix,
      jobOptions,
      workerOptions = {},
      globalConcurrency = true,
      lockWait,
      allow,
      background,
      userlandLogRows,
    } = options;

    if (!isObjectLike(bullmq)) {
      throw new ConfigInvalidError(
        'bullmq is required — pass { Queue, Worker, QueueEvents } from your own bullmq install',
      );
    }
    const { Queue, Worker, QueueEvents, telemetry } = bullmq;
    // BullMQ's own telemetry object (`new BullMQOtel(…)`), handed to the Queue
    // and the Worker untouched — it is what carries a trace from the process
    // that enqueues to the one that applies. Nothing here looks inside it.
    if (telemetry !== undefined && (typeof telemetry !== 'object' || telemetry === null)) {
      throw new ConfigInvalidError(
        'bullmq.telemetry must be a BullMQ telemetry object — e.g. new BullMQOtel(…)',
        { telemetry: typeof telemetry },
      );
    }
    const queueIsInstance = isObjectLike(Queue) && typeof Queue.addBulk === 'function';
    if (!isClass(Queue) && !queueIsInstance) {
      throw new ConfigInvalidError('bullmq.Queue must be the Queue class or a Queue instance');
    }
    if (Worker !== undefined && !isClass(Worker)) {
      throw new ConfigInvalidError('bullmq.Worker must be the Worker class');
    }
    const eventsIsInstance = isObjectLike(QueueEvents) && typeof QueueEvents.on === 'function';
    if (QueueEvents !== undefined && !isClass(QueueEvents) && !eventsIsInstance) {
      throw new ConfigInvalidError(
        'bullmq.QueueEvents must be the QueueEvents class or a QueueEvents instance',
      );
    }
    // Anything this object has to construct needs somewhere to connect to.
    const constructs = isClass(Queue) || Worker !== undefined || isClass(QueueEvents);
    if (constructs && connection == null) {
      throw new ConfigInvalidError(
        'connection is required — the BullMQ connection options or your Redis client',
      );
    }

    const resolvedName =
      queueName ?? (queueIsInstance ? Queue.name : undefined) ?? DEFAULT_QUEUE_NAME;
    assertName(resolvedName, 'queueName');
    // An injected Queue already says where its keys live. A Worker or
    // QueueEvents built here on another name or prefix would listen to an
    // empty queue: jobs that never run, a wait() that never returns.
    const resolvedPrefix = prefix ?? (queueIsInstance ? Queue.opts?.prefix : undefined);
    if (resolvedPrefix !== undefined) assertName(resolvedPrefix, 'prefix');
    if (queueIsInstance) {
      MigrationQueue.#assertSameQueue('bullmq.Queue', Queue, resolvedName, resolvedPrefix);
    }
    if (eventsIsInstance) {
      MigrationQueue.#assertSameQueue(
        'bullmq.QueueEvents',
        QueueEvents,
        resolvedName,
        resolvedPrefix,
      );
    }
    assertJobOptions(jobOptions);
    if (!isObjectLike(workerOptions)) {
      throw new ConfigInvalidError('workerOptions must be an object');
    }
    MigrationQueue.#assertConcurrency(workerOptions.concurrency);
    if (typeof globalConcurrency !== 'boolean') {
      throw new ConfigInvalidError('globalConcurrency must be a boolean', { globalConcurrency });
    }

    this.#connection = connection;
    this.#queueName = resolvedName;
    this.#prefix = resolvedPrefix;
    this.#jobOptions = jobOptions;
    this.#workerOptions = workerOptions;
    this.#telemetry = telemetry;
    this.#globalConcurrency = globalConcurrency;
    this.#WorkerClass = Worker;
    this.#queueEventsSource = QueueEvents;
    if (eventsIsInstance) this.#queueEvents = QueueEvents;

    // Everything is validated before the first thing is constructed: a Queue
    // opens a Redis connection, and a constructor that throws after that would
    // leave it open with nobody holding a reference to close it.
    resolveProcessorOptions({
      ...(kit !== undefined ? { kit } : {}),
      ...(config !== undefined ? { config } : {}),
      ...(lockWait !== undefined ? { lockWait } : {}),
      ...(allow !== undefined ? { allow } : {}),
      ...(userlandLogRows !== undefined ? { userlandLogRows } : {}),
    });
    this.#allow = resolveAllow(allow);
    const backgroundSettings = resolveBackground(background, {
      queueName: resolvedName,
      QueueSource: Queue,
    });
    if (backgroundSettings?.queueIsInstance) {
      // The same check as the migration queue's: a Worker built here on
      // another name or prefix would listen to an empty queue.
      MigrationQueue.#assertSameQueue(
        'background.queue',
        backgroundSettings.queue,
        backgroundSettings.name,
        resolvedPrefix,
      );
    }
    if (backgroundSettings !== undefined) {
      // Validated against a stand-in queue: the real one does not exist yet.
      resolveBackgroundProcessorOptions({
        ...MigrationQueue.#backgroundProcessorOptions(backgroundSettings),
        queue: { addBulk() {} },
      });
    }

    this.#ownsKit = kit === undefined;
    this.#kit = kit ?? new MigratorKit(config ?? {}, kitOptions);
    this.#ownsQueue = !queueIsInstance;
    this.#queue = queueIsInstance
      ? Queue
      : new Queue(resolvedName, {
          connection,
          ...(resolvedPrefix !== undefined ? { prefix: resolvedPrefix } : {}),
          ...(telemetry !== undefined ? { telemetry } : {}),
        });
    this.#listen(this.#queue, 'error', (error) =>
      this.#kit.logger.error(`✖ Migration queue error: ${errorText(error)}`, {
        queue: resolvedName,
        error: errorText(error),
      }),
    );
    if (backgroundSettings !== undefined) {
      this.#background = backgroundSettings;
      this.#ownsBackgroundQueue = !backgroundSettings.queueIsInstance;
      this.#backgroundQueue = backgroundSettings.queueIsInstance
        ? backgroundSettings.queue
        : new Queue(backgroundSettings.name, {
            connection,
            ...(resolvedPrefix !== undefined ? { prefix: resolvedPrefix } : {}),
            ...(telemetry !== undefined ? { telemetry } : {}),
          });
      this.#listen(this.#backgroundQueue, 'error', (error) =>
        this.#kit.logger.error(`✖ Background queue error: ${errorText(error)}`, {
          queue: backgroundSettings.name,
          error: errorText(error),
        }),
      );
      this.#backgroundProcessor = createBackgroundProcessor({
        kit: this.#kit,
        queue: this.#backgroundQueue,
        ...MigrationQueue.#backgroundProcessorOptions(backgroundSettings),
        ...(userlandLogRows !== undefined ? { userlandLogRows } : {}),
      });
    }
    this.#processor = createMigrationProcessor({
      kit: this.#kit,
      // `sync` jobs (and the converge jobs they add) enqueue into the queue
      // they arrived on.
      queue: this.#queue,
      ...(lockWait !== undefined ? { lockWait } : {}),
      ...(jobOptions !== undefined ? { jobOptions } : {}),
      ...(allow !== undefined ? { allow } : {}),
      ...(userlandLogRows !== undefined ? { userlandLogRows } : {}),
      // What an `up` registers starts on the background queue at once.
      ...(this.#backgroundQueue !== undefined
        ? {
            background: {
              queue: this.#backgroundQueue,
              ...MigrationQueue.#backgroundEnqueueOptions(backgroundSettings),
            },
          }
        : {}),
    });
  }

  /** Whether the drift watch's schedule exists already — false when that cannot be told */
  static async #hasScheduler(queue) {
    if (typeof queue.getJobScheduler === 'function') {
      return Boolean(await queue.getJobScheduler(DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID));
    }
    if (typeof queue.getJobSchedulers === 'function') {
      for (const scheduler of await queue.getJobSchedulers()) {
        if ((scheduler.id ?? scheduler.key) === DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID) return true;
      }
    }
    return false;
  }

  /** The background processor's options out of the resolved `background` option */
  static #backgroundProcessorOptions(settings) {
    const picked = {};
    for (const key of [
      'jobOptions',
      'sliceMs',
      'children',
      'pollIntervalMs',
      'stallMs',
      'maxLaneRetries',
    ]) {
      if (settings[key] !== undefined) picked[key] = settings[key];
    }
    return picked;
  }

  /** What every coordinator enqueue from this object carries */
  static #backgroundEnqueueOptions(settings) {
    return {
      ...(settings.jobOptions !== undefined ? { jobOptions: settings.jobOptions } : {}),
      stallMs: settings.stallMs ?? DEFAULT_STALL_MS,
    };
  }

  #assertBackground(method) {
    if (this.#background === undefined) {
      throw new ConfigInvalidError(
        `${method} needs the background queue — pass background: true to createMigrationQueue`,
      );
    }
  }

  /**
   * Refuse, at the enqueue call, a request this object's own policy would
   * refuse on the worker — a job that can only fail is better not added. The
   * same `allow` belongs on every process that enqueues and every worker.
   */
  #assertPermitted(request) {
    for (const permission of permissionsNeeded(request)) {
      if (!this.#allow[permission]) {
        throw new ConfigInvalidError(
          `${permission === 'unordered' ? 'ordered: false' : permission} is not allowed by this ` +
            `queue (allow.${permission})`,
          { permission },
        );
      }
    }
  }

  /** An injected instance must be on the queue this object is configured for */
  static #assertSameQueue(label, instance, name, prefix) {
    if (typeof instance.name === 'string' && instance.name !== name) {
      throw new ConfigInvalidError(`${label} is on queue "${instance.name}", not "${name}"`, {
        queueName: name,
      });
    }
    const instancePrefix = instance.opts?.prefix;
    if (instancePrefix !== undefined && prefix !== undefined && instancePrefix !== prefix) {
      throw new ConfigInvalidError(`${label} uses prefix "${instancePrefix}", not "${prefix}"`, {
        prefix,
      });
    }
  }

  static #assertConcurrency(concurrency) {
    if (concurrency !== undefined && concurrency !== 1) {
      throw new ConfigInvalidError(
        'Worker concurrency must be 1 — migrations run one at a time, in order',
        { concurrency },
      );
    }
  }

  /** Subscribe if the object is an emitter — an unlistened `error` event throws */
  #listen(emitter, event, listener) {
    if (typeof emitter?.on === 'function') emitter.on(event, listener);
  }

  #assertOpen() {
    if (this.#closing) {
      throw new ConfigInvalidError('This migration queue is closed');
    }
  }

  get kit() {
    return this.#kit;
  }

  get queue() {
    return this.#queue;
  }

  /** The worker started by {@link startWorker}, if any */
  get worker() {
    return this.#worker;
  }

  /** The QueueEvents in use — an injected instance, or the one built on first `wait()` */
  get queueEvents() {
    return this.#queueEvents;
  }

  get queueName() {
    return this.#queueName;
  }

  /** The function a Worker runs — for attaching to a Worker you construct yourself */
  get processor() {
    return this.#processor;
  }

  /** The background queue (`background` option), if any */
  get backgroundQueue() {
    return this.#backgroundQueue;
  }

  /** The background worker started by {@link startBackgroundWorker}, if any */
  get backgroundWorker() {
    return this.#backgroundWorker;
  }

  /** The background queue's processor, for a Worker you construct yourself */
  get backgroundProcessor() {
    return this.#backgroundProcessor;
  }

  /** The live drift watcher `startBackgroundWorker()` started, if any */
  get backgroundWatcher() {
    return this.#backgroundWatcher;
  }

  #ensureQueueEvents() {
    if (this.#queueEvents) return this.#queueEvents;
    // A connection opened after close() would have nobody to close it.
    this.#assertOpen();
    const QueueEvents = this.#queueEventsSource;
    if (!isClass(QueueEvents)) return undefined;
    this.#queueEvents = new QueueEvents(this.#queueName, {
      connection: this.#connection,
      ...(this.#prefix !== undefined ? { prefix: this.#prefix } : {}),
    });
    this.#ownsQueueEvents = true;
    this.#listen(this.#queueEvents, 'error', (error) =>
      this.#kit.logger.error(`✖ Migration queue events error: ${errorText(error)}`, {
        queue: this.#queueName,
        error: errorText(error),
      }),
    );
    return this.#queueEvents;
  }

  #internals() {
    return { getQueueEvents: () => this.#ensureQueueEvents() };
  }

  /**
   * Enqueue pending migrations — all of them, up to `options.to`, or the one
   * `filename` — as one job each, under a single shared batch.
   */
  async enqueueUp(filename, options = {}) {
    this.#assertOpen();
    this.#assertPermitted({
      kind: 'migration',
      direction: JOB_NAMES.UP,
      force: options?.force === true,
      ordered: options?.ordered,
    });
    return enqueueUp(
      this.#queue,
      this.#kit,
      { ...options, filename, jobOptions: this.#jobOptions },
      this.#internals(),
    );
  }

  /**
   * Enqueue a rollback — the last batch, `options.batch`, the last
   * `options.steps`, everything after `options.to`, or the one `filename` —
   * newest applied first.
   */
  async enqueueDown(filename, options = {}) {
    this.#assertOpen();
    this.#assertPermitted({
      kind: 'migration',
      direction: JOB_NAMES.DOWN,
      ordered: options?.ordered,
    });
    return enqueueDown(
      this.#queue,
      this.#kit,
      { ...options, filename, jobOptions: this.#jobOptions },
      this.#internals(),
    );
  }

  /**
   * Enqueue a converge job: the declared collections brought to their
   * declared state by the worker, under the MongoDB lock. By default it
   * refuses while a migration is still pending (`ordered: false` lifts that).
   */
  async enqueueConverge(options = {}) {
    this.#assertOpen();
    this.#assertPermitted({ kind: 'converge', ordered: options?.ordered });
    return enqueueConverge(
      this.#queue,
      this.#kit,
      { ...options, jobOptions: this.#jobOptions },
      this.#internals(),
    );
  }

  /**
   * Enqueue the coordinator of one background migration — or of every one with
   * work to do. Idempotent: a coordinator already alive absorbs the add.
   * @experimental
   */
  async enqueueBackground(name, options = {}) {
    this.#assertOpen();
    this.#assertBackground('enqueueBackground()');
    if (!isObjectLike(options)) {
      throw new ConfigInvalidError('enqueueBackground options must be an object');
    }
    return enqueueBackground(this.#backgroundQueue, this.#kit, {
      ...MigrationQueue.#backgroundEnqueueOptions(this.#background),
      ...options,
      ...(name !== undefined ? { migration: name } : {}),
    });
  }

  /** A background migration's status (or every one's) — read from MongoDB */
  async backgroundStatus(name) {
    this.#assertOpen();
    return this.#kit.backgroundStatus(name);
  }

  /**
   * The drift watch, now — and, on a queue with a background side, a
   * coordinator for whatever it reopened.
   * @experimental
   */
  async verifyBackground(options = {}) {
    this.#assertOpen();
    const result = await this.#kit.verifyBackground(options);
    if (this.#background !== undefined && result.drift.length > 0) {
      await enqueueBackground(
        this.#backgroundQueue,
        this.#kit,
        MigrationQueue.#backgroundEnqueueOptions(this.#background),
      );
    }
    return result;
  }

  /** Full migration status — read straight from MongoDB, not from the queue */
  async status() {
    this.#assertOpen();
    return this.#kit.status();
  }

  /** Migrations not applied yet */
  async pending() {
    this.#assertOpen();
    return this.#kit.list('pending');
  }

  async audit() {
    this.#assertOpen();
    return this.#kit.audit();
  }

  /** The current holder of the MongoDB migration lock, or null */
  async lockInfo() {
    this.#assertOpen();
    return this.#kit.lockInfo();
  }

  /**
   * Start the worker that applies the jobs. Needs `bullmq.Worker`. Connects to
   * MongoDB first, so an unreachable database fails here. Concurrency is
   * always 1, and where BullMQ supports it the queue's *global* concurrency
   * is set to 1 too, so several pods running this take turns instead of each
   * picking a job and queuing on the MongoDB lock. Calling it again returns
   * the same worker.
   */
  async startWorker(overrides = {}) {
    this.#assertOpen();
    if (!isObjectLike(overrides)) {
      throw new ConfigInvalidError('startWorker options must be an object');
    }
    MigrationQueue.#assertConcurrency(overrides.concurrency);
    if (!this.#WorkerClass) {
      throw new ConfigInvalidError(
        'startWorker() needs the Worker class — pass bullmq: { Queue, Worker }',
      );
    }
    // A failed start is not cached: a database or Redis that was briefly
    // unreachable at boot must not leave this object unable to ever start.
    this.#workerStarting ??= this.#startWorker(overrides).catch((error) => {
      this.#workerStarting = undefined;
      throw error;
    });
    return this.#workerStarting;
  }

  async #startWorker(overrides) {
    // Connect first: a worker that cannot reach MongoDB should fail at boot,
    // not on its first job — and until the config is resolved the kit's logger
    // is only provisional, so the listeners below would ignore `logger: null`.
    await this.#kit.connect();
    const queue = this.#queue;
    if (this.#globalConcurrency && typeof queue.setGlobalConcurrency === 'function') {
      await queue.setGlobalConcurrency(1);
    }
    // close() may have begun while this was connecting: a Worker built now
    // would fetch a job after shutdown, with nobody left to close it.
    this.#assertOpen();
    const Worker = this.#WorkerClass;
    const worker = new Worker(this.#queueName, this.#processor, {
      connection: this.#connection,
      ...(this.#prefix !== undefined ? { prefix: this.#prefix } : {}),
      lockDuration: DEFAULT_LOCK_DURATION_MS,
      maxStalledCount: DEFAULT_MAX_STALLED_COUNT,
      // Before the worker options, so a `telemetry` given there (or to this
      // call) still wins for the worker alone.
      ...(this.#telemetry !== undefined ? { telemetry: this.#telemetry } : {}),
      ...this.#workerOptions,
      ...overrides,
      concurrency: 1,
    });
    this.#worker = worker;
    const fields = { queue: this.#queueName };
    this.#listen(worker, 'error', (error) =>
      this.#kit.logger.error(`✖ Migration worker error: ${errorText(error)}`, {
        ...fields,
        error: errorText(error),
      }),
    );
    this.#listen(worker, 'failed', (job, error) =>
      this.#kit.logger.warn(
        `✖ Migration job failed${job?.id !== undefined ? ` (${job.id})` : ''}: ${errorText(error)}`,
        { ...fields, ...failedJobFields(job, error), error: errorText(error) },
      ),
    );
    this.#listen(worker, 'stalled', (jobId) =>
      this.#kit.logger.warn(`⚠ Migration job stalled (${jobId}) — it will be re-run`, {
        ...fields,
        jobId: String(jobId),
      }),
    );
    await worker.waitUntilReady?.();
    return worker;
  }

  /**
   * Start the background worker: coordinators and lanes of background
   * migrations, side by side (concurrency 2 by default). Connects to MongoDB
   * first, registers the drift watch's schedule (`verifyIntervalMs`), and
   * heals — a coordinator for every background migration with work to do.
   * Calling it again returns the same worker.
   * @experimental
   */
  async startBackgroundWorker(overrides = {}) {
    this.#assertOpen();
    this.#assertBackground('startBackgroundWorker()');
    if (!isObjectLike(overrides)) {
      throw new ConfigInvalidError('startBackgroundWorker options must be an object');
    }
    assertBackgroundConcurrency(overrides.concurrency);
    if (!this.#WorkerClass) {
      throw new ConfigInvalidError(
        'startBackgroundWorker() needs the Worker class — pass bullmq: { Queue, Worker }',
      );
    }
    this.#backgroundStarting ??= this.#startBackgroundWorker(overrides).catch((error) => {
      this.#backgroundStarting = undefined;
      throw error;
    });
    return this.#backgroundStarting;
  }

  async #startBackgroundWorker(overrides) {
    await this.#kit.connect();
    const queue = this.#backgroundQueue;
    const { verifyIntervalMs, verifyIntervalGiven, workerOptions = {} } = this.#background;
    if (
      verifyIntervalMs !== false &&
      typeof queue.upsertJobScheduler === 'function' &&
      (verifyIntervalGiven || !(await MigrationQueue.#hasScheduler(queue)))
    ) {
      await queue.upsertJobScheduler(
        DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID,
        { every: verifyIntervalMs },
        buildBackgroundVerifyJobTemplate({ jobOptions: this.#background.jobOptions }),
      );
    }
    this.#assertOpen();
    const Worker = this.#WorkerClass;
    // An injected background queue says where its keys live; its worker listens there.
    const prefix = this.#background.queue?.opts?.prefix ?? this.#prefix;
    const worker = new Worker(this.#background.name, this.#backgroundProcessor, {
      connection: this.#connection,
      ...(prefix !== undefined ? { prefix } : {}),
      lockDuration: DEFAULT_LOCK_DURATION_MS,
      maxStalledCount: DEFAULT_MAX_STALLED_COUNT,
      ...(this.#telemetry !== undefined ? { telemetry: this.#telemetry } : {}),
      concurrency: DEFAULT_BACKGROUND_CONCURRENCY,
      ...workerOptions,
      ...overrides,
    });
    this.#backgroundWorker = worker;
    const fields = { queue: this.#background.name };
    this.#listen(worker, 'error', (error) =>
      this.#kit.logger.error(`✖ Background worker error: ${errorText(error)}`, {
        ...fields,
        error: errorText(error),
      }),
    );
    this.#listen(worker, 'failed', (job, error) =>
      this.#kit.logger.warn(
        `✖ Background job failed${job?.id !== undefined ? ` (${job.id})` : ''}: ${errorText(error)}`,
        { ...fields, ...failedJobFields(job, error), error: errorText(error) },
      ),
    );
    await worker.waitUntilReady?.();
    // Closing meanwhile: close() takes it from here — nothing more to start.
    if (this.#closing) return worker;
    await this.#backgroundProcessor.heal();
    if (this.#closing) return worker;
    await this.#startWatcher();
    return worker;
  }

  /**
   * The live drift watcher, in this process — when `background.watch` says
   * so, or, unsaid, when `backgroundDrift` is `'stream'` or `'both'`. A
   * watcher that cannot start (a standalone server) leaves the polling watch
   * to it, with a warning: the worker itself is fine.
   */
  async #startWatcher() {
    let wanted = this.#background.watch;
    wanted ??= (await this.#kit.driftMode()) !== 'poll';
    if (wanted === false) return;
    const logger = this.#kit.logger;
    try {
      this.#backgroundWatcher = await this.#kit.watchBackground({
        ...(typeof wanted === 'object' ? wanted : {}),
        onError: (error, collection) =>
          logger.warn(
            `⚠ Drift watcher${collection ? ` (${collection})` : ''}: ${errorText(error)}`,
            {
              queue: this.#background.name,
              ...(collection ? { collection } : {}),
              error: errorText(error),
            },
          ),
      });
    } catch (error) {
      logger.warn(`⚠ The live drift watcher did not start: ${errorText(error)}`, {
        queue: this.#background.name,
        error: errorText(error),
      });
    }
  }

  /** Stop workers from picking up new jobs. The job in flight finishes */
  async pause() {
    this.#assertOpen();
    await this.#queue.pause();
  }

  async resume() {
    this.#assertOpen();
    await this.#queue.resume();
  }

  /**
   * A job as plain, redacted data — safe to hand to an HTTP response — or
   * null. For the live BullMQ Job, use `queue.getJob(id)`.
   */
  async getJob(id) {
    this.#assertOpen();
    if (typeof id !== 'string' || id.length === 0) {
      throw new ConfigInvalidError('Job id must be a non-empty string', { id });
    }
    let job = await this.#queue.getJob(id);
    if (!job) return null;
    const state = typeof job.getState === 'function' ? await job.getState() : 'unknown';
    // The job and its state are two reads: one that finished in between would
    // read as finished with no outcome (no returnvalue or failedReason, the
    // attempt not counted). A finished job no longer changes, so read it again.
    if (state === 'completed' || state === 'failed') job = (await this.#queue.getJob(id)) ?? job;
    return redactDeep({
      id: String(job.id),
      name: job.name,
      data: job.data,
      state,
      progress: job.progress,
      ...(job.returnvalue != null ? { returnvalue: job.returnvalue } : {}),
      ...(job.failedReason ? { failedReason: redactOutbound(job.failedReason) } : {}),
      attemptsMade: job.attemptsMade ?? 0,
      ...(job.timestamp !== undefined ? { timestamp: job.timestamp } : {}),
      ...(job.processedOn !== undefined ? { processedOn: job.processedOn } : {}),
      ...(job.finishedOn !== undefined ? { finishedOn: job.finishedOn } : {}),
    });
  }

  /**
   * Keep the database migrated on a schedule: every tick enqueues a `sync`
   * job, which plans whatever is pending and enqueues it — or, with
   * `job: 'converge'`, a converge job, on a cadence of its own (index builds
   * often belong at night, not on every sync). Idempotent — safe to call from
   * every instance at boot.
   */
  async schedule(options = {}) {
    this.#assertOpen();
    if (!isObjectLike(options)) {
      throw new ConfigInvalidError('schedule options must be an object');
    }
    const { job = JOB_NAMES.SYNC, every, pattern, tz, to } = options;
    if (
      job !== JOB_NAMES.SYNC &&
      job !== JOB_NAMES.CONVERGE &&
      job !== JOB_NAMES.BACKGROUND_VERIFY
    ) {
      throw new ConfigInvalidError(
        "schedule job must be 'sync', 'converge' or 'background-verify'",
        { job },
      );
    }
    const converge = job === JOB_NAMES.CONVERGE;
    const verify = job === JOB_NAMES.BACKGROUND_VERIFY;
    if (verify) this.#assertBackground("schedule({ job: 'background-verify' })");
    const {
      id = verify
        ? DEFAULT_BACKGROUND_VERIFY_SCHEDULER_ID
        : converge
          ? DEFAULT_CONVERGE_SCHEDULER_ID
          : DEFAULT_SCHEDULER_ID,
    } = options;
    assertName(id, 'id');
    if (job !== JOB_NAMES.SYNC && to !== undefined) {
      throw new ConfigInvalidError('to only applies to a sync schedule', { to });
    }
    if ((every === undefined) === (pattern === undefined)) {
      throw new ConfigInvalidError(
        'schedule needs exactly one of `every` (ms) or `pattern` (cron)',
      );
    }
    // A tick is a job, a Redis round trip and a changelog read: a schedule
    // faster than once a second is a typo, not a cadence.
    if (every !== undefined && (!Number.isFinite(every) || every < MIN_SCHEDULE_EVERY_MS)) {
      throw new ConfigInvalidError(`every must be at least ${MIN_SCHEDULE_EVERY_MS} milliseconds`, {
        every,
      });
    }
    if (pattern !== undefined && (typeof pattern !== 'string' || pattern.length === 0)) {
      throw new ConfigInvalidError('pattern must be a cron expression', { pattern });
    }
    if (tz !== undefined && (typeof tz !== 'string' || tz.length === 0)) {
      throw new ConfigInvalidError('tz must be a time zone name', { tz });
    }
    if (to !== undefined && !isBareFilename(to)) {
      throw new ConfigInvalidError('to must be a migration filename', { to });
    }
    const queue = verify ? this.#backgroundQueue : this.#queue;
    if (typeof queue.upsertJobScheduler !== 'function') {
      throw new ConfigInvalidError(
        'schedule() needs job schedulers (queue.upsertJobScheduler) — BullMQ 5.16 or newer',
      );
    }
    let template;
    if (verify) {
      template = buildBackgroundVerifyJobTemplate({ jobOptions: this.#background.jobOptions });
    } else if (converge) {
      template = buildConvergeJobTemplate({ jobOptions: this.#jobOptions });
    } else {
      template = buildSyncJobTemplate({ to, jobOptions: this.#jobOptions });
    }
    await queue.upsertJobScheduler(
      id,
      { ...(every !== undefined ? { every } : { pattern }), ...(tz !== undefined ? { tz } : {}) },
      template,
    );
  }

  /**
   * Remove a schedule — the sync one by default; pass
   * `DEFAULT_CONVERGE_SCHEDULER_ID` (or your own id) for another. Resolves
   * whether one existed.
   */
  async unschedule(id = DEFAULT_SCHEDULER_ID) {
    this.#assertOpen();
    assertName(id, 'id');
    if (typeof this.#queue.removeJobScheduler !== 'function') {
      throw new ConfigInvalidError(
        'unschedule() needs job schedulers (queue.removeJobScheduler) — BullMQ 5.16 or newer',
      );
    }
    const removed = Boolean(await this.#queue.removeJobScheduler(id));
    // A schedule of the background queue (the drift watch) goes the same way.
    const background = this.#backgroundQueue;
    if (typeof background?.removeJobScheduler !== 'function') return removed;
    return Boolean(await background.removeJobScheduler(id)) || removed;
  }

  /**
   * Shut down in dependency order: stop taking the lock, let the worker finish
   * its job (`force` skips that wait), then close what this object created and
   * disconnect a kit it created. Idempotent; every step is attempted, and the
   * first failure is rethrown once they all have been.
   */
  async close(options = {}) {
    this.#closing ??= this.#close(options?.force === true);
    return this.#closing;
  }

  async #close(force) {
    const failures = [];
    const attempt = async (step) => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    };
    // The workers stop fetching first, together: a job the shutdown below
    // puts back in the queue must go to the next worker, not straight back
    // to this one. Both processors are told to stop: a lane checkpoints at
    // its next batch and goes back to the queue. Nothing waits for a start
    // in progress before that — one can hang on Redis for good.
    const worker = this.#worker;
    const backgroundWorker = this.#backgroundWorker;
    const workersClosed = [
      worker ? attempt(() => worker.close(force)) : undefined,
      backgroundWorker ? attempt(() => backgroundWorker.close(force)) : undefined,
    ];
    this.#processor.shutdown('Migration queue closing');
    this.#backgroundProcessor?.shutdown('Migration queue closing');
    // The watcher: its streams close, its last positions are saved, its
    // locks go to the next pod's watcher.
    const watcher = this.#backgroundWatcher;
    if (watcher) await attempt(() => watcher.stop());
    await Promise.all(workersClosed);
    // A worker still starting is closed too, not orphaned — the start sees
    // the close at its next step — and a start that failed is that call's
    // failure, not this one's.
    await this.#workerStarting?.catch(() => undefined);
    if (this.#worker && this.#worker !== worker) {
      await attempt(() => this.#worker.close(force));
    }
    await this.#backgroundStarting?.catch(() => undefined);
    if (this.#backgroundWorker && this.#backgroundWorker !== backgroundWorker) {
      await attempt(() => this.#backgroundWorker.close(force));
    }
    if (this.#backgroundWatcher && this.#backgroundWatcher !== watcher) {
      await attempt(() => this.#backgroundWatcher.stop());
    }
    const processors = [this.#processor];
    if (this.#backgroundProcessor) processors.push(this.#backgroundProcessor);
    if (!force) {
      for (const processor of processors) await attempt(() => processor.close());
    }
    if (this.#queueEvents && this.#ownsQueueEvents) await attempt(() => this.#queueEvents.close());
    if (this.#ownsQueue) await attempt(() => this.#queue.close());
    if (this.#ownsBackgroundQueue) await attempt(() => this.#backgroundQueue.close());
    if (force) {
      // The work in flight is not waited for — but it keeps its connection
      // until it ends: a kit this object created is disconnected only once
      // the processors have settled.
      Promise.allSettled(processors.map((processor) => processor.close()))
        .then(() => (this.#ownsKit ? this.#kit.disconnect() : undefined))
        .catch(() => undefined);
    } else if (this.#ownsKit) {
      await attempt(() => this.#kit.disconnect());
    }
    if (failures.length > 0) throw failures[0];
  }
}

function createMigrationQueue(options) {
  return new MigrationQueue(options);
}

module.exports = { MigrationQueue, createMigrationQueue };
