const { MigratorKit } = require('../core/migrator.js');
const { ConfigInvalidError } = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { isBareFilename } = require('../utils/migration-name.js');
const { redactDeep, redactUris } = require('../utils/redact.js');
const {
  DEFAULT_QUEUE_NAME,
  DEFAULT_SCHEDULER_ID,
  buildSyncJobTemplate,
  isPlainObject,
} = require('./jobs.js');
const { createMigrationProcessor, resolveProcessorOptions } = require('./processor.js');
const { assertJobOptions, enqueueDown, enqueueUp } = require('./producer.js');

/**
 * Twice BullMQ's default job lock: its renewal (every half) then survives a
 * migration that keeps the event loop busy for a while, instead of the job
 * being declared stalled and handed to another worker mid-run.
 */
const DEFAULT_LOCK_DURATION_MS = 60_000;
/** One stall is a crashed worker; a second on the same job is a pattern — fail it */
const DEFAULT_MAX_STALLED_COUNT = 1;

const isClass = (value) => typeof value === 'function';

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
  #closing;

  constructor(options) {
    if (!isPlainObject(options)) {
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
    } = options;

    if (!isPlainObject(bullmq)) {
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
    const queueIsInstance = isPlainObject(Queue) && typeof Queue.addBulk === 'function';
    if (!isClass(Queue) && !queueIsInstance) {
      throw new ConfigInvalidError('bullmq.Queue must be the Queue class or a Queue instance');
    }
    if (Worker !== undefined && !isClass(Worker)) {
      throw new ConfigInvalidError('bullmq.Worker must be the Worker class');
    }
    const eventsIsInstance = isPlainObject(QueueEvents) && typeof QueueEvents.on === 'function';
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
    if (prefix !== undefined) assertName(prefix, 'prefix');
    assertJobOptions(jobOptions);
    if (!isPlainObject(workerOptions)) {
      throw new ConfigInvalidError('workerOptions must be an object');
    }
    MigrationQueue.#assertConcurrency(workerOptions.concurrency);
    if (typeof globalConcurrency !== 'boolean') {
      throw new ConfigInvalidError('globalConcurrency must be a boolean', { globalConcurrency });
    }

    this.#connection = connection;
    this.#queueName = resolvedName;
    this.#prefix = prefix;
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
    });

    this.#ownsKit = kit === undefined;
    this.#kit = kit ?? new MigratorKit(config ?? {}, kitOptions);
    this.#ownsQueue = !queueIsInstance;
    this.#queue = queueIsInstance
      ? Queue
      : new Queue(resolvedName, {
          connection,
          ...(prefix !== undefined ? { prefix } : {}),
          ...(telemetry !== undefined ? { telemetry } : {}),
        });
    this.#listen(this.#queue, 'error', (error) =>
      this.#kit.logger.error(`✖ Migration queue error: ${errorText(error)}`, {
        queue: resolvedName,
        error: errorText(error),
      }),
    );
    this.#processor = createMigrationProcessor({
      kit: this.#kit,
      // `sync` jobs enqueue into the same queue they arrived on.
      queue: this.#queue,
      ...(lockWait !== undefined ? { lockWait } : {}),
      ...(jobOptions !== undefined ? { jobOptions } : {}),
    });
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

  #ensureQueueEvents() {
    if (this.#queueEvents) return this.#queueEvents;
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
    return enqueueDown(
      this.#queue,
      this.#kit,
      { ...options, filename, jobOptions: this.#jobOptions },
      this.#internals(),
    );
  }

  /** Full migration status — read straight from MongoDB, not from the queue */
  async status() {
    return this.#kit.status();
  }

  /** Migrations not applied yet */
  async pending() {
    return this.#kit.list('pending');
  }

  async audit() {
    return this.#kit.audit();
  }

  /** The current holder of the MongoDB migration lock, or null */
  async lockInfo() {
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
    if (!isPlainObject(overrides)) {
      throw new ConfigInvalidError('startWorker options must be an object');
    }
    MigrationQueue.#assertConcurrency(overrides.concurrency);
    if (!this.#WorkerClass) {
      throw new ConfigInvalidError(
        'startWorker() needs the Worker class — pass bullmq: { Queue, Worker }',
      );
    }
    this.#workerStarting ??= this.#startWorker(overrides);
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
        {
          ...fields,
          ...(job?.id !== undefined ? { jobId: String(job.id) } : {}),
          ...(error?.code ? { code: error.code } : {}),
          error: errorText(error),
        },
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

  /** Stop workers from picking up new jobs. The job in flight finishes */
  async pause() {
    await this.#queue.pause();
  }

  async resume() {
    await this.#queue.resume();
  }

  /**
   * A job as plain, redacted data — safe to hand to an HTTP response — or
   * null. For the live BullMQ Job, use `queue.getJob(id)`.
   */
  async getJob(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new ConfigInvalidError('Job id must be a non-empty string', { id });
    }
    const job = await this.#queue.getJob(id);
    if (!job) return null;
    return redactDeep({
      id: String(job.id),
      name: job.name,
      data: job.data,
      state: typeof job.getState === 'function' ? await job.getState() : 'unknown',
      progress: job.progress,
      ...(job.returnvalue != null ? { returnvalue: job.returnvalue } : {}),
      ...(job.failedReason ? { failedReason: redactUris(job.failedReason) } : {}),
      attemptsMade: job.attemptsMade ?? 0,
      ...(job.timestamp !== undefined ? { timestamp: job.timestamp } : {}),
      ...(job.processedOn !== undefined ? { processedOn: job.processedOn } : {}),
      ...(job.finishedOn !== undefined ? { finishedOn: job.finishedOn } : {}),
    });
  }

  /**
   * Keep the database migrated on a schedule: every tick enqueues a `sync`
   * job, which plans whatever is pending and enqueues it. Idempotent — safe to
   * call from every instance at boot.
   */
  async schedule(options = {}) {
    this.#assertOpen();
    if (!isPlainObject(options)) {
      throw new ConfigInvalidError('schedule options must be an object');
    }
    const { id = DEFAULT_SCHEDULER_ID, every, pattern, tz, to } = options;
    assertName(id, 'id');
    if ((every === undefined) === (pattern === undefined)) {
      throw new ConfigInvalidError(
        'schedule needs exactly one of `every` (ms) or `pattern` (cron)',
      );
    }
    if (every !== undefined && (!Number.isFinite(every) || every <= 0)) {
      throw new ConfigInvalidError('every must be a positive number of milliseconds', { every });
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
    if (typeof this.#queue.upsertJobScheduler !== 'function') {
      throw new ConfigInvalidError(
        'schedule() needs job schedulers (queue.upsertJobScheduler) — BullMQ 5.16 or newer',
      );
    }
    await this.#queue.upsertJobScheduler(
      id,
      { ...(every !== undefined ? { every } : { pattern }), ...(tz !== undefined ? { tz } : {}) },
      buildSyncJobTemplate({ to }),
    );
  }

  /** Remove a schedule. Resolves whether one existed */
  async unschedule(id = DEFAULT_SCHEDULER_ID) {
    assertName(id, 'id');
    if (typeof this.#queue.removeJobScheduler !== 'function') {
      throw new ConfigInvalidError(
        'unschedule() needs job schedulers (queue.removeJobScheduler) — BullMQ 5.16 or newer',
      );
    }
    return Boolean(await this.#queue.removeJobScheduler(id));
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
    this.#processor.shutdown('Migration queue closing');
    // A worker still starting must be closed too, not orphaned.
    await attempt(() => this.#workerStarting);
    if (this.#worker) await attempt(() => this.#worker.close(force));
    if (this.#queueEvents && this.#ownsQueueEvents) await attempt(() => this.#queueEvents.close());
    if (this.#ownsQueue) await attempt(() => this.#queue.close());
    await attempt(() => this.#processor.close());
    if (this.#ownsKit) await attempt(() => this.#kit.disconnect());
    if (failures.length > 0) throw failures[0];
  }
}

function createMigrationQueue(options) {
  return new MigrationQueue(options);
}

module.exports = { MigrationQueue, createMigrationQueue };
