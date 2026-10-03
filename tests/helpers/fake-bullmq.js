const { EventEmitter } = require('node:events');

/**
 * An in-memory stand-in for the slice of BullMQ the queue adapter talks to —
 * so its tests need neither Redis nor the bullmq package, and stay fast and
 * deterministic.
 *
 * Reproduced on purpose, because the adapter's design leans on each of them:
 * - `Queue`, `Worker` and `QueueEvents` built separately on the same
 *   connection + prefix + name share one queue;
 * - strict FIFO, a queue-wide pause, per-worker and global concurrency;
 * - a retried job goes to the END of the wait list (the reason migration jobs
 *   get a single attempt), and an error named `UnrecoverableError` is never
 *   retried;
 * - the cancellation signal reaches the processor only when it declares three
 *   parameters;
 * - `deduplication` in simple mode: a second add while the first job is
 *   waiting or active returns the EXISTING job's id; the key is freed when
 *   that job completes or fails;
 * - custom job ids may not contain `:` or be integers, and an id that still
 *   exists is silently not re-added;
 * - `waitUntilFinished` settles from state when the job already finished, and
 *   words its timeout the way BullMQ does;
 * - a stalled job is re-queued at the head and run again while the first
 *   attempt's outcome is discarded (`_simulateStall`);
 * - `job.moveToWait(token)` puts an active job back at the HEAD of the wait
 *   list (BullMQ RPUSHes it to the end consumers pop from), and a processor
 *   error named `WaitingError` is then neither a failure nor a completion.
 *
 * Not reproduced: Lua atomicity, lock renewal, delayed/prioritized jobs,
 * backoff delays, flows, rate limiting, retention (`removeOnComplete`), Redis
 * failures. `tests/integration/bullmq-redis.test.js` runs the same scenarios
 * against the real library to keep this double honest — when the two
 * disagree, this file is the one that is wrong.
 */

/** connection token → Map<'prefix:name', queue state> */
const servers = new WeakMap();

/** A fresh "Redis server": pass it as `connection` to isolate a test */
function createFakeConnection() {
  return { fake: 'redis' };
}

function stateFor(connection, prefix = 'bull', name) {
  if (connection === null || typeof connection !== 'object') {
    throw new Error('fake-bullmq: `connection` must be a createFakeConnection() token');
  }
  let queues = servers.get(connection);
  if (!queues) {
    queues = new Map();
    servers.set(connection, queues);
  }
  const key = `${prefix}:${name}`;
  let state = queues.get(key);
  if (!state) {
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    state = {
      jobs: new Map(),
      wait: [],
      active: new Set(),
      completed: new Set(),
      failed: new Set(),
      dedup: new Map(),
      schedulers: new Map(),
      paused: false,
      globalConcurrency: undefined,
      nextId: 1,
      bus,
    };
    queues.set(key, state);
  }
  return state;
}

function assertQueueName(name) {
  if (typeof name !== 'string' || name.includes(':')) {
    throw new Error('Queue name cannot contain :');
  }
}

class FakeJob {
  #state;

  constructor(state, { id, name, data, opts }) {
    this.#state = state;
    this.id = id;
    this.name = name;
    this.data = data;
    this.opts = opts;
    this.attemptsMade = 0;
    this.attemptsStarted = 0;
    this.progress = 0;
    this.returnvalue = null;
    this.failedReason = undefined;
    this.stacktrace = [];
    this.timestamp = Date.now();
    this.processedOn = undefined;
    this.finishedOn = undefined;
    this.logs = [];
  }

  async updateProgress(progress) {
    this.progress = progress;
    this.#state.bus.emit('progress', { jobId: this.id, data: progress });
  }

  async log(row) {
    this.logs.push(row);
    return this.logs.length;
  }

  /** Back to the head of the wait list — only for the worker holding it (`token`) */
  async moveToWait(token) {
    const state = this.#state;
    if (!state.active.has(this.id) || token !== `token-${this.id}`) {
      throw new Error(`Missing lock for job ${this.id}. moveToWait`);
    }
    state.active.delete(this.id);
    state.wait.unshift(this.id);
    state.bus.emit('waiting', { jobId: this.id, prev: 'active' });
    state.bus.emit('tick');
    return 0;
  }

  async getState() {
    const state = this.#state;
    if (state.active.has(this.id)) return 'active';
    if (state.completed.has(this.id)) return 'completed';
    if (state.failed.has(this.id)) return 'failed';
    if (state.wait.includes(this.id)) return 'waiting';
    return 'unknown';
  }

  async waitUntilFinished(queueEvents, ttl) {
    const state = this.#state;
    const jobId = this.id;
    const stored = state.jobs.get(jobId);
    if (!stored) throw new Error(`Missing key for job ${jobId}. isFinished`);
    if (state.completed.has(jobId)) return stored.returnvalue;
    if (state.failed.has(jobId)) throw new Error(stored.failedReason);

    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        queueEvents.off('completed', onCompleted);
        queueEvents.off('failed', onFailed);
      };
      const onCompleted = (args) => {
        if (args.jobId !== jobId) return;
        cleanup();
        resolve(args.returnvalue);
      };
      const onFailed = (args) => {
        if (args.jobId !== jobId) return;
        cleanup();
        reject(new Error(args.failedReason));
      };
      queueEvents.on('completed', onCompleted);
      queueEvents.on('failed', onFailed);
      if (ttl !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Job wait ${this.name} timed out before finishing, no finish notification ` +
                `arrived after ${ttl}ms (id=${jobId})`,
            ),
          );
        }, ttl);
        // Left ref'd on purpose: on a queue with no worker this timer is the
        // only thing that will ever settle the wait, and an unref'd one lets
        // the event loop drain first (Node 22 then cancels the test).
      }
    });
  }

  async remove() {
    const state = this.#state;
    state.jobs.delete(this.id);
    state.completed.delete(this.id);
    state.failed.delete(this.id);
    const position = state.wait.indexOf(this.id);
    if (position !== -1) state.wait.splice(position, 1);
    releaseDedup(state, this);
  }
}

function releaseDedup(state, job) {
  const dedupId = job.opts?.deduplication?.id;
  if (dedupId !== undefined && state.dedup.get(dedupId) === job.id) state.dedup.delete(dedupId);
}

function validateJobOptions(opts) {
  const jobId = opts?.jobId;
  if (jobId === undefined) return;
  if (`${parseInt(jobId, 10)}` === jobId) throw new Error('Custom Id cannot be integers');
  if (jobId.includes(':')) throw new Error('Custom Id cannot contain :');
}

class FakeQueue extends EventEmitter {
  #state;

  constructor(name, opts = {}) {
    super();
    assertQueueName(name);
    this.name = name;
    this.opts = opts;
    this.closed = false;
    this.#state = stateFor(opts.connection, opts.prefix, name);
  }

  #assertOpen() {
    if (this.closed) throw new Error('Queue closed');
  }

  /** Returns a detached Job, as BullMQ does — the stored one comes from getJob() */
  #addOne(name, data, opts) {
    const state = this.#state;
    const merged = { ...this.opts.defaultJobOptions, ...opts };
    const detached = (id) => new FakeJob(state, { id, name, data, opts: merged });

    if (merged.jobId !== undefined && state.jobs.has(merged.jobId)) {
      state.bus.emit('duplicated', { jobId: merged.jobId });
      return detached(merged.jobId);
    }
    const dedupId = merged.deduplication?.id;
    if (dedupId !== undefined && state.dedup.has(dedupId)) {
      const existing = state.dedup.get(dedupId);
      state.bus.emit('deduplicated', {
        jobId: existing,
        deduplicationId: dedupId,
        deduplicatedJobId: String(state.nextId),
      });
      return detached(existing);
    }

    const id = merged.jobId ?? String(state.nextId++);
    state.jobs.set(id, new FakeJob(state, { id, name, data, opts: merged }));
    state.wait.push(id);
    if (dedupId !== undefined) state.dedup.set(dedupId, id);
    state.bus.emit('waiting', { jobId: id });
    state.bus.emit('tick');
    return detached(id);
  }

  async add(name, data, opts = {}) {
    this.#assertOpen();
    validateJobOptions(opts);
    return this.#addOne(name, data, opts);
  }

  /** All-or-nothing: every spec is validated before the first is added */
  async addBulk(specs) {
    this.#assertOpen();
    for (const spec of specs) validateJobOptions(spec.opts);
    return specs.map((spec) => this.#addOne(spec.name, spec.data, spec.opts ?? {}));
  }

  async getJob(id) {
    this.#assertOpen();
    return this.#state.jobs.get(id);
  }

  async getJobs() {
    return [...this.#state.jobs.values()];
  }

  async getJobCounts() {
    const state = this.#state;
    return {
      waiting: state.wait.length,
      active: state.active.size,
      completed: state.completed.size,
      failed: state.failed.size,
    };
  }

  async pause() {
    this.#state.paused = true;
    this.#state.bus.emit('paused', {});
  }

  async resume() {
    this.#state.paused = false;
    this.#state.bus.emit('resumed', {});
    this.#state.bus.emit('tick');
  }

  async isPaused() {
    return this.#state.paused;
  }

  async setGlobalConcurrency(concurrency) {
    this.#state.globalConcurrency = concurrency;
    return 1;
  }

  async getGlobalConcurrency() {
    return this.#state.globalConcurrency ?? null;
  }

  async upsertJobScheduler(id, repeat, template = {}) {
    this.#assertOpen();
    if ((repeat.every === undefined) === (repeat.pattern === undefined)) {
      throw new Error('Either .pattern or .every options must be defined for this repeatable job');
    }
    this.#state.schedulers.set(id, { repeat, template, runs: 0 });
  }

  async removeJobScheduler(id) {
    return this.#state.schedulers.delete(id);
  }

  async getJobSchedulers() {
    const schedulers = [];
    for (const [id, scheduler] of this.#state.schedulers) schedulers.push({ id, ...scheduler });
    return schedulers;
  }

  /** Test-only: fire one tick of a scheduler, as if its interval elapsed */
  async _tick(id) {
    const scheduler = this.#state.schedulers.get(id);
    if (!scheduler) throw new Error(`fake-bullmq: no scheduler "${id}"`);
    scheduler.runs += 1;
    const { template } = scheduler;
    return this.#addOne(template.name ?? id, template.data ?? {}, template.opts ?? {});
  }

  /** Test-only: job ids by state */
  _state() {
    const state = this.#state;
    return {
      wait: [...state.wait],
      active: [...state.active],
      completed: [...state.completed],
      failed: [...state.failed],
    };
  }

  async obliterate() {
    const state = this.#state;
    state.jobs.clear();
    state.wait.length = 0;
    state.active.clear();
    state.completed.clear();
    state.failed.clear();
    state.dedup.clear();
    state.schedulers.clear();
  }

  async close() {
    this.closed = true;
  }
}

class FakeWorker extends EventEmitter {
  #state;
  #processor;
  #running = new Map();
  #started = false;
  #paused = false;
  #closing = false;
  #onTick = () => this.#schedule();

  constructor(name, processor, opts = {}) {
    super();
    assertQueueName(name);
    this.name = name;
    this.opts = opts;
    this.closed = false;
    this.#processor = processor;
    this.#state = stateFor(opts.connection, opts.prefix, name);
    this.#state.bus.on('tick', this.#onTick);
    if (opts.autorun !== false) this.run();
  }

  get concurrency() {
    return this.opts.concurrency ?? 1;
  }

  async run() {
    this.#started = true;
    this.#schedule();
  }

  async waitUntilReady() {
    return this;
  }

  isRunning() {
    return this.#started && !this.#closing;
  }

  isPaused() {
    return this.#paused;
  }

  async pause() {
    this.#paused = true;
  }

  resume() {
    this.#paused = false;
    this.#schedule();
  }

  #schedule() {
    setImmediate(() => this.#pump());
  }

  #canTake() {
    const state = this.#state;
    if (!this.#started || this.#closing || this.#paused || state.paused) return false;
    if (state.wait.length === 0 || this.#running.size >= this.concurrency) return false;
    return state.globalConcurrency === undefined || state.active.size < state.globalConcurrency;
  }

  #pump() {
    while (this.#canTake()) this.#process(this.#state.wait.shift());
  }

  #process(id) {
    const state = this.#state;
    const job = state.jobs.get(id);
    state.active.add(id);
    job.processedOn = Date.now();
    job.attemptsStarted += 1;
    const run = { controller: new AbortController(), stalled: false, promise: undefined };
    this.#running.set(id, run);
    this.emit('active', job);
    // BullMQ: `processorAcceptsSignal = processor.length >= 3`
    const args =
      this.#processor.length >= 3
        ? [job, `token-${id}`, run.controller.signal]
        : [job, `token-${id}`];
    run.promise = Promise.resolve()
      .then(() => this.#processor(...args))
      .then(
        (result) => this.#settle(job, run, undefined, result),
        (error) => this.#settle(job, run, error ?? new Error('unknown failure')),
      );
  }

  #settle(job, run, error, result) {
    const state = this.#state;
    if (this.#running.get(job.id) === run) this.#running.delete(job.id);
    // The lock was lost (stall): BullMQ refuses to move the job with
    // "Missing lock for job" — this attempt's outcome simply does not count.
    if (run.stalled) return;
    // The processor already moved the job back to wait (it may even be
    // active again on another worker): there is nothing to record.
    if (error !== undefined && error.name === 'WaitingError') {
      state.bus.emit('tick');
      return;
    }
    state.active.delete(job.id);

    if (error === undefined) {
      job.returnvalue = result;
      job.finishedOn = Date.now();
      state.completed.add(job.id);
      releaseDedup(state, job);
      this.emit('completed', job, result);
      state.bus.emit('completed', { jobId: job.id, returnvalue: result });
    } else {
      job.attemptsMade += 1;
      const retry =
        job.attemptsMade < (job.opts.attempts ?? 1) && error.name !== 'UnrecoverableError';
      if (retry) {
        // The FIFO-breaking part: behind everything already waiting.
        state.wait.push(job.id);
      } else {
        job.failedReason = error.message;
        job.stacktrace.push(String(error.stack));
        job.finishedOn = Date.now();
        state.failed.add(job.id);
        releaseDedup(state, job);
        this.emit('failed', job, error);
        state.bus.emit('failed', { jobId: job.id, failedReason: job.failedReason });
      }
    }
    if (state.wait.length === 0 && state.active.size === 0) this.emit('drained');
    state.bus.emit('tick');
  }

  cancelJob(id, reason) {
    const run = this.#running.get(id);
    if (!run) return false;
    run.controller.abort(reason);
    return true;
  }

  /**
   * Test-only: behave as if this worker died holding `id` — the job goes back
   * to the head of the queue and runs again, while the first attempt (still in
   * flight here) can no longer report its outcome.
   */
  _simulateStall(id) {
    const run = this.#running.get(id);
    if (!run) throw new Error(`fake-bullmq: job "${id}" is not active on this worker`);
    run.stalled = true;
    this.#running.delete(id);
    this.#state.active.delete(id);
    this.#state.wait.unshift(id);
    this.emit('stalled', id, 'active');
    this.#state.bus.emit('tick');
  }

  async close(force = false) {
    if (this.closed) return;
    this.#closing = true;
    this.emit('closing', 'closing queue');
    this.#state.bus.off('tick', this.#onTick);
    if (!force) {
      const inFlight = [];
      for (const run of this.#running.values()) inFlight.push(run.promise);
      await Promise.allSettled(inFlight);
    }
    this.closed = true;
    this.emit('closed');
  }
}

/** Events the bus forwards to a QueueEvents — what `waitUntilFinished` and tests listen for */
const QUEUE_EVENTS = ['completed', 'failed', 'progress', 'waiting', 'deduplicated', 'duplicated'];

class FakeQueueEvents extends EventEmitter {
  #state;
  #forwarders = new Map();

  constructor(name, opts = {}) {
    super();
    assertQueueName(name);
    this.name = name;
    this.opts = opts;
    this.closed = false;
    this.setMaxListeners(0);
    this.#state = stateFor(opts.connection, opts.prefix, name);
    for (const event of QUEUE_EVENTS) {
      const forward = (args) => this.emit(event, args, 'fake-event-id');
      this.#forwarders.set(event, forward);
      this.#state.bus.on(event, forward);
    }
  }

  async waitUntilReady() {
    return this;
  }

  async close() {
    for (const [event, forward] of this.#forwarders) this.#state.bus.off(event, forward);
    this.#forwarders.clear();
    this.closed = true;
  }
}

/** Shaped like the real package's exports — drop-in for the adapter's `bullmq` option */
function fakeBullmq() {
  return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents };
}

module.exports = {
  FakeJob,
  FakeQueue,
  FakeQueueEvents,
  FakeWorker,
  createFakeConnection,
  fakeBullmq,
};
