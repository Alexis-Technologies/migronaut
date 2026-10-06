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
 *   error named `WaitingError` is then neither a failure nor a completion;
 * - delayed jobs: `add(…, { delay })`, `job.moveToDelayed(timestamp, token)`
 *   with a processor error named `DelayedError`, a retry's `backoff`, and
 *   `job.updateData()`; a delayed job is promoted when its time comes (or at
 *   once by `_promoteDelayed()`). A run that moves its job uses no attempt
 *   (`attemptsStarted` still counts it); a failed or a completed one does;
 * - parents and children (what FlowProducer builds on): `queue.qualifiedName`,
 *   a child's `opts.parent` (a missing parent is refused, as is a parent with
 *   `deduplication`; an existing child id cannot be moved to another parent
 *   while its first one exists — otherwise the existing job is bound to the
 *   parent, as processed when it already completed),
 *   `job.moveToWaitingChildren(token)`
 *   (`true` while children are pending — then a processor error named
 *   `WaitingChildrenError` is neither a failure nor a completion), the parent
 *   woken once every child is done (at once, even one added with a `delay`
 *   or moved to delayed before; a parent still delayed stays delayed);
 *   a failed child with `ignoreDependencyOnFailure` (counted as ignored) or
 *   `removeDependencyOnFailure`, and — with neither — a parent left waiting
 *   for good; `getChildrenValues`, `getIgnoredChildrenFailures`,
 *   `getDependenciesCount`. `failParentOnFailure` / `continueParentOnFailure`
 *   are refused as not modelled.
 *
 * `fakeBullmq({ flows: false })` is a BullMQ without parent support (no
 * `qualifiedName`, no `moveToWaitingChildren`); `queue._loseRedis()` drops
 * every key of the fake "server", as a flushed Redis would.
 *
 * Not reproduced: Lua atomicity, lock renewal, prioritized jobs, rate
 * limiting, retention (`removeOnComplete`), removing a parent's children with
 * it, Redis connection failures. `tests/integration/bullmq-redis.test.js`
 * runs the same scenarios against the real library to keep this double
 * honest — when the two disagree, this file is the one that is wrong.
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
      key,
      queues,
      jobs: new Map(),
      wait: [],
      active: new Set(),
      completed: new Set(),
      failed: new Set(),
      delayed: new Map(),
      waitingChildren: new Set(),
      dedup: new Map(),
      schedulers: new Map(),
      paused: false,
      globalConcurrency: undefined,
      nextId: 1,
      flows: true,
      bus,
    };
    queues.set(key, state);
  }
  return state;
}

/** Into the wait list — and tell the workers */
function enqueue(state, id, { head = false } = {}) {
  if (head) state.wait.unshift(id);
  else state.wait.push(id);
  state.bus.emit('waiting', { jobId: id });
  state.bus.emit('tick');
}

/** Delay a job until `timestamp` — promoted to the wait list when it comes */
function delay(state, id, timestamp) {
  const ms = Math.max(0, timestamp - Date.now());
  const timer = setTimeout(() => promote(state, id), ms);
  timer.unref?.();
  state.delayed.set(id, { until: timestamp, timer });
  state.bus.emit('delayed', { jobId: id, delay: timestamp });
}

function promote(state, id) {
  const entry = state.delayed.get(id);
  if (entry === undefined) return;
  clearTimeout(entry.timer);
  state.delayed.delete(id);
  if (state.jobs.has(id)) enqueue(state, id);
}

/** The queue state and job a `parent` option points at — `{ queue: qualifiedName, id }` */
function parentOf(state, parent) {
  const target = state.queues.get(parent.queue);
  return { state: target, job: target?.jobs.get(parent.id) };
}

/**
 * A child finished: record it on its parent, and wake the parent when it was
 * the last one it waited for. `outcome`: `{ value }` or `{ failedReason }`.
 */
function childFinished(childState, child, outcome) {
  const parent = child.opts.parent;
  if (parent === undefined) return;
  const { state, job } = parentOf(childState, parent);
  if (job === undefined) return;
  const key = `${childState.key}:${child.id}`;
  if (outcome.failedReason === undefined) {
    job.dependencies.set(key, 'processed');
    job.childrenValues[key] = outcome.value;
  } else if (child.opts.ignoreDependencyOnFailure) {
    job.dependencies.set(key, 'ignored');
    job.ignoredFailures[key] = outcome.failedReason;
  } else if (child.opts.removeDependencyOnFailure) {
    job.dependencies.delete(key);
  } else {
    // Neither option: the parent waits for good — as in BullMQ.
    job.dependencies.set(key, 'failed');
  }
  wakeIfReady(state, job);
}

/**
 * A child id added again with a `parent`: BullMQ refuses to move it away from
 * a parent that still exists; otherwise the existing job joins the new parent's
 * dependencies — already processed when it completed.
 */
function bindExisting(state, existing, parent) {
  const before = existing.opts.parent;
  const same = before?.id === parent.id && before?.queue === parent.queue;
  if (before !== undefined && !same && parentOf(state, before).job !== undefined) {
    throw new Error(`The parent job ${parent.queue}:${parent.id} cannot be replaced. addJob`);
  }
  const target = parentOf(state, parent);
  const key = `${state.key}:${existing.id}`;
  if (state.completed.has(existing.id)) {
    target.job.dependencies.set(key, 'processed');
    target.job.childrenValues[key] = existing.returnvalue;
  } else if (!target.job.dependencies.has(key)) {
    target.job.dependencies.set(key, 'unprocessed');
  }
  existing.opts = { ...existing.opts, parent };
  wakeIfReady(target.state, target.job);
}

function pendingDependencies(job) {
  let pending = 0;
  for (const status of job.dependencies.values()) {
    if (status === 'unprocessed' || status === 'failed') pending += 1;
  }
  return pending;
}

function wakeIfReady(state, job) {
  if (!state.waitingChildren.has(job.id) || pendingDependencies(job) > 0) return;
  state.waitingChildren.delete(job.id);
  enqueue(state, job.id);
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
    this.dependencies = new Map();
    this.childrenValues = {};
    this.ignoredFailures = {};
    if (state.flows === false) this.moveToWaitingChildren = undefined;
  }

  /** Only the worker holding it (`token`) may move an active job */
  #assertHeld(token, method) {
    const state = this.#state;
    if (!state.active.has(this.id) || token !== `token-${this.id}`) {
      throw new Error(`Missing lock for job ${this.id}. ${method}`);
    }
  }

  async updateData(data) {
    this.data = data;
    const stored = this.#state.jobs.get(this.id);
    if (stored && stored !== this) stored.data = data;
  }

  /** Active → delayed until `timestamp`; the processor then throws a `DelayedError` */
  async moveToDelayed(timestamp, token) {
    this.#assertHeld(token, 'moveToDelayed');
    const state = this.#state;
    state.active.delete(this.id);
    delay(state, this.id, timestamp);
    state.bus.emit('tick');
  }

  /**
   * Active → waiting for its children, while any is unfinished (`true` — the
   * processor then throws a `WaitingChildrenError`); `false` when none is.
   */
  async moveToWaitingChildren(token) {
    this.#assertHeld(token, 'moveToWaitingChildren');
    const state = this.#state;
    const stored = state.jobs.get(this.id);
    if (pendingDependencies(stored) === 0) return false;
    state.active.delete(this.id);
    state.waitingChildren.add(this.id);
    state.bus.emit('tick');
    return true;
  }

  async getChildrenValues() {
    return { ...this.#state.jobs.get(this.id).childrenValues };
  }

  async getIgnoredChildrenFailures() {
    return { ...this.#state.jobs.get(this.id).ignoredFailures };
  }

  async getDependenciesCount() {
    const counts = { processed: 0, unprocessed: 0, ignored: 0, failed: 0 };
    for (const status of this.#state.jobs.get(this.id).dependencies.values()) counts[status] += 1;
    return counts;
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
    this.#assertHeld(token, 'moveToWait');
    const state = this.#state;
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
    if (state.delayed.has(this.id)) return 'delayed';
    if (state.waitingChildren.has(this.id)) return 'waiting-children';
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
    clearTimeout(state.delayed.get(this.id)?.timer);
    state.delayed.delete(this.id);
    state.waitingChildren.delete(this.id);
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
  if (opts?.parent !== undefined && opts.deduplication !== undefined) {
    throw new Error('Deduplication and parent options cannot be used together');
  }
  for (const option of ['failParentOnFailure', 'continueParentOnFailure']) {
    if (opts?.[option]) throw new Error(`fake-bullmq: ${option} is not modelled`);
  }
  const jobId = opts?.jobId;
  if (jobId === undefined) return;
  if (`${parseInt(jobId, 10)}` === jobId) throw new Error('Custom Id cannot be integers');
  if (jobId.includes(':')) throw new Error('Custom Id cannot contain :');
}

function clearState(state) {
  for (const entry of state.delayed.values()) clearTimeout(entry.timer);
  state.jobs.clear();
  state.wait.length = 0;
  state.active.clear();
  state.completed.clear();
  state.failed.clear();
  state.delayed.clear();
  state.waitingChildren.clear();
  state.dedup.clear();
  state.schedulers.clear();
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

  /** `prefix:name` — what a child's `parent.queue` names */
  get qualifiedName() {
    return this.#state.flows === false ? undefined : this.#state.key;
  }

  /** Returns a detached Job, as BullMQ does — the stored one comes from getJob() */
  #addOne(name, data, opts) {
    const state = this.#state;
    const merged = { ...this.opts.defaultJobOptions, ...opts };
    const detached = (id) => new FakeJob(state, { id, name, data, opts: merged });

    let parent;
    if (merged.parent !== undefined) {
      parent = parentOf(state, merged.parent);
      if (parent.job === undefined) {
        const key = `${merged.parent.queue}:${merged.parent.id}`;
        throw new Error(`Missing key for parent job ${key}. addJob`);
      }
    }
    if (merged.jobId !== undefined && state.jobs.has(merged.jobId)) {
      if (parent !== undefined) bindExisting(state, state.jobs.get(merged.jobId), merged.parent);
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
    if (dedupId !== undefined) state.dedup.set(dedupId, id);
    if (parent !== undefined) parent.job.dependencies.set(`${state.key}:${id}`, 'unprocessed');
    if (merged.delay > 0) delay(state, id, Date.now() + merged.delay);
    else enqueue(state, id);
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
      delayed: state.delayed.size,
      'waiting-children': state.waitingChildren.size,
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
      delayed: [...state.delayed.keys()],
      waitingChildren: [...state.waitingChildren],
    };
  }

  /** Test-only: promote every delayed job now, as if its time had come */
  _promoteDelayed() {
    for (const id of [...this.#state.delayed.keys()]) promote(this.#state, id);
  }

  /** Test-only: every key of this fake "server" gone — a flushed or replaced Redis */
  _loseRedis() {
    for (const state of this.#state.queues.values()) clearState(state);
  }

  async obliterate() {
    clearState(this.#state);
  }

  async close() {
    this.closed = true;
  }
}

/** Processor errors that mean "the processor moved this job itself" */
const MOVED = new Set(['WaitingError', 'DelayedError', 'WaitingChildrenError']);

/** A retry's delay: `{ type: 'fixed' | 'exponential', delay }` or a number */
function backoffMs(backoff, attemptsMade) {
  if (backoff === undefined) return 0;
  if (typeof backoff === 'number') return backoff;
  if (backoff.type === 'exponential') return (backoff.delay ?? 0) * 2 ** (attemptsMade - 1);
  return backoff.delay ?? 0;
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
    // The processor already moved the job back to wait, to delayed, or to
    // waiting for its children (it may even be active again on another
    // worker): there is nothing to record.
    if (error !== undefined && MOVED.has(error.name)) {
      state.bus.emit('tick');
      return;
    }
    // A job that was removed (an obliterate, a lost Redis) while it ran: its
    // outcome lands nowhere.
    if (!state.jobs.has(job.id)) {
      state.active.delete(job.id);
      state.bus.emit('tick');
      return;
    }
    state.active.delete(job.id);

    if (error === undefined) {
      // BullMQ counts the finishing run as an attempt too — never a move.
      job.attemptsMade += 1;
      job.returnvalue = result;
      job.finishedOn = Date.now();
      state.completed.add(job.id);
      releaseDedup(state, job);
      this.emit('completed', job, result);
      state.bus.emit('completed', { jobId: job.id, returnvalue: result });
      childFinished(state, job, { value: result });
    } else {
      job.attemptsMade += 1;
      const retry =
        job.attemptsMade < (job.opts.attempts ?? 1) && error.name !== 'UnrecoverableError';
      if (retry) {
        const backoff = backoffMs(job.opts.backoff, job.attemptsMade);
        // The FIFO-breaking part: behind everything already waiting.
        if (backoff > 0) delay(state, job.id, Date.now() + backoff);
        else state.wait.push(job.id);
      } else {
        job.failedReason = error.message;
        job.stacktrace.push(String(error.stack));
        job.finishedOn = Date.now();
        state.failed.add(job.id);
        releaseDedup(state, job);
        this.emit('failed', job, error);
        state.bus.emit('failed', { jobId: job.id, failedReason: job.failedReason });
        childFinished(state, job, { failedReason: job.failedReason });
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
const QUEUE_EVENTS = [
  'completed',
  'failed',
  'progress',
  'waiting',
  'delayed',
  'deduplicated',
  'duplicated',
];

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

/**
 * Shaped like the real package's exports — drop-in for the adapter's `bullmq`
 * option. `{ flows: false }`: a BullMQ without parent support, for the
 * adapter's fallback.
 */
function fakeBullmq({ flows = true } = {}) {
  if (flows) return { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents };
  const withoutFlows = (Base) =>
    class extends Base {
      constructor(...args) {
        super(...args);
        stateFor(this.opts.connection, this.opts.prefix, this.name).flows = false;
      }
    };
  return {
    Queue: withoutFlows(FakeQueue),
    Worker: withoutFlows(FakeWorker),
    QueueEvents: withoutFlows(FakeQueueEvents),
  };
}

module.exports = {
  FakeJob,
  FakeQueue,
  FakeQueueEvents,
  FakeWorker,
  createFakeConnection,
  fakeBullmq,
};
