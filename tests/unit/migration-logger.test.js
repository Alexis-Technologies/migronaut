const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { MongoServerError } = require('mongodb');
const {
  MAX_MESSAGE_LENGTH,
  backgroundLogs,
  correlationOf,
  createMigrationLogger,
  createRunLog,
  migrationRunInfo,
  notices,
  runInfo,
  sequence,
} = require('../../src/core/migration-logger.js');

/** A sink that keeps its lines, and an emitter that keeps its events */
function harness({ wanted = true } = {}) {
  const lines = [];
  const events = [];
  const sink = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    sink[level] = (msg, fields) => lines.push({ level, msg, fields });
  }
  const emitter = { wanted: () => wanted, emit: (payload) => events.push(payload) };
  return { lines, events, sink, emitter };
}

const FULL_RUN = Object.freeze({
  id: 'run-1',
  direction: 'up',
  jobId: '17',
  groupId: 'g-1',
  requestedBy: 'alice',
  reason: 'TICKET-1',
  migration: '0001-a.js',
  batch: 3,
  attempt: 2,
});

function ordinary(options = {}) {
  const parts = harness(options);
  const logger = createMigrationLogger({
    sink: parts.sink,
    kind: 'migration',
    info: FULL_RUN,
    emitter: parts.emitter,
    nextSeq: sequence(),
    ...options.logger,
  });
  return { ...parts, logger };
}

describe('sequence', () => {
  it('should count from 1, separately per counter', () => {
    const a = sequence();
    const b = sequence();
    assert.deepStrictEqual([a(), a(), b(), a()], [1, 2, 1, 3]);
  });
});

describe('runInfo / migrationRunInfo', () => {
  it('should build a frozen run-level ctx.run without undefined fields', () => {
    const run = runInfo({ id: 'r', requestedBy: undefined, reason: 'why' }, 'down');
    assert.deepStrictEqual(run, { id: 'r', direction: 'down', reason: 'why' });
    assert.ok(Object.isFrozen(run));
  });

  it('should add the migration, its batch and the attempt in a new frozen object', () => {
    const run = runInfo({ id: 'r' }, 'up');
    const first = migrationRunInfo(run, { migration: 'a.js', batch: 4, attempt: 1 });
    assert.deepStrictEqual(first, {
      id: 'r',
      direction: 'up',
      migration: 'a.js',
      batch: 4,
      attempt: 1,
    });
    assert.ok(Object.isFrozen(first));
    const down = migrationRunInfo(runInfo({ id: 'r' }, 'down'), { migration: 'a.js', attempt: 1 });
    assert.ok(!('batch' in down), 'no batch on a down');
  });
});

describe('correlationOf', () => {
  it('should map every ctx.run field — the actor to the event only', () => {
    const { event, line } = correlationOf('migration', FULL_RUN);
    assert.deepStrictEqual(event, {
      kind: 'migration',
      runId: 'run-1',
      direction: 'up',
      jobId: '17',
      groupId: 'g-1',
      requestedBy: 'alice',
      reason: 'TICKET-1',
      migration: '0001-a.js',
      batch: 3,
      attempt: 2,
    });
    assert.deepStrictEqual(line, {
      runId: 'run-1',
      direction: 'up',
      jobId: '17',
      groupId: 'g-1',
      migration: '0001-a.js',
      batch: 3,
      attempt: 2,
    });
  });

  it('should map a background context: its name is the migration, its lane the run', () => {
    const background = {
      name: '0002-bg.js',
      generation: 1,
      partition: '3',
      runId: 'lane-1',
      jobId: 'bgl-x',
      attempt: 1,
    };
    const { event, line } = correlationOf('background', background, 'forward');
    assert.deepStrictEqual(event, {
      kind: 'background',
      runId: 'lane-1',
      migration: '0002-bg.js',
      direction: 'forward',
      generation: 1,
      partition: '3',
      jobId: 'bgl-x',
      attempt: 1,
    });
    assert.deepStrictEqual(line, {
      runId: 'lane-1',
      migration: '0002-bg.js',
      direction: 'forward',
      generation: 1,
      partition: '3',
      jobId: 'bgl-x',
      attempt: 1,
    });
  });
});

describe('createMigrationLogger', () => {
  it('should bind the correlation into every line, the bound values winning', () => {
    const { lines, events, logger } = ordinary();
    logger.info('scan started', { runId: 'mine', rows: 3 });
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].level, 'info');
    assert.strictEqual(lines[0].msg, 'scan started');
    assert.strictEqual(lines[0].fields.runId, 'run-1');
    assert.strictEqual(lines[0].fields.rows, 3);
    assert.strictEqual(lines[0].fields.migration, '0001-a.js');
    assert.strictEqual(lines[0].fields.attempt, 2);
    assert.ok(!('requestedBy' in lines[0].fields));
    assert.strictEqual(events.length, 0, 'no marker, no event');
  });

  it('should emit migration:log for userland: true, and keep the marker on the line', () => {
    const { lines, events, logger } = ordinary();
    logger.warn('batch done', { userland: true, processed: 1000, runId: 'mine' });
    logger.info('second', { userland: true });
    assert.strictEqual(lines[0].fields.userland, true);
    assert.strictEqual(events.length, 2);
    const [first, second] = events;
    assert.strictEqual(first.kind, 'migration');
    assert.strictEqual(first.runId, 'run-1');
    assert.strictEqual(first.requestedBy, 'alice');
    assert.strictEqual(first.level, 'warn');
    assert.strictEqual(first.msg, 'batch done');
    // The user's own keys stay in data — even one named like a bound field.
    assert.deepStrictEqual(first.data, { processed: 1000, runId: 'mine' });
    assert.ok(first.at instanceof Date);
    assert.deepStrictEqual([first.seq, second.seq], [1, 2]);
    assert.ok(!('truncated' in first));
  });

  it('should emit nothing for a marker that is not exactly true', () => {
    const { lines, events, logger } = ordinary();
    logger.info('a', { userland: 'true' });
    logger.info('b', { userland: 1 });
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(events.length, 0);
  });

  it('should not copy or emit when no one listens', () => {
    const { events, logger } = ordinary({ wanted: false });
    logger.info('a', { userland: true });
    assert.strictEqual(events.length, 0);
  });

  it('should log without emitting in a dry run, saying so on the line', () => {
    const { lines, events, logger } = ordinary({ logger: { dryRun: true } });
    logger.info('preview', { userland: true });
    assert.strictEqual(lines[0].fields.dryRun, true);
    assert.strictEqual(events.length, 0);
  });

  it('should take fields that are not a plain object as a value, without an event', () => {
    const { lines, events, logger } = ordinary();
    logger.info('array', [1, 2]);
    logger.info('none');
    assert.deepStrictEqual(lines[0].fields.value, [1, 2]);
    assert.strictEqual(lines[1].fields.runId, 'run-1');
    assert.ok(!('value' in lines[1].fields));
    assert.strictEqual(events.length, 0);
  });

  it("should accept pino's (fields, msg) order", () => {
    const { lines, events, logger } = ordinary();
    logger.info({ userland: true, n: 1 }, 'pino style');
    logger.info({ n: 2 });
    assert.strictEqual(lines[0].msg, 'pino style');
    assert.strictEqual(lines[0].fields.n, 1);
    assert.strictEqual(lines[1].msg, '');
    assert.strictEqual(events[0].msg, 'pino style');
  });

  it('should take an Error by its redacted message, and redact the event', () => {
    const { lines, events, logger } = ordinary();
    logger.error(new Error('connect mongodb://u:secret@h failed'), {
      userland: true,
      uri: 'mongodb://u:secret@h',
    });
    assert.strictEqual(lines[0].msg, 'connect mongodb://u:****@h failed');
    assert.strictEqual(events[0].msg, 'connect mongodb://u:****@h failed');
    assert.strictEqual(events[0].data.uri, 'mongodb://u:****@h');
  });

  it('should mask the values a server error quotes in the event, not on the line', () => {
    const { lines, events, logger } = ordinary();
    const error = new MongoServerError({
      ok: 0,
      code: 11000,
      errmsg: 'E11000 duplicate key error index: email_1 dup key: { email: "a@b.c" }',
      keyValue: { email: 'a@b.c' },
    });
    logger.error(error, { userland: true, err: error });
    assert.match(lines[0].msg, /a@b\.c/);
    assert.strictEqual(lines[0].fields.err, error);
    assert.strictEqual(
      events[0].msg,
      'E11000 duplicate key error index: email_1 dup key: { <redacted> }',
    );
    assert.deepStrictEqual(events[0].data.err, {
      name: 'MongoServerError',
      message: 'E11000 duplicate key error index: email_1 dup key: { <redacted> }',
      code: 11000,
    });
  });

  it('should clip a long message in the event only, and mark it truncated', () => {
    const { lines, events, logger } = ordinary();
    const long = 'm'.repeat(MAX_MESSAGE_LENGTH + 5);
    logger.info(long, { userland: true });
    assert.strictEqual(lines[0].msg, long);
    assert.strictEqual(events[0].msg.length, MAX_MESSAGE_LENGTH + 1);
    assert.strictEqual(events[0].truncated, true);
  });

  it('should drop a call whose fields throw, and never throw itself', () => {
    const { lines, events, logger } = ordinary();
    const hostile = {
      get boom() {
        throw new Error('getter');
      },
    };
    assert.doesNotThrow(() => logger.info('x', hostile));
    const throwingSink = createMigrationLogger({
      sink: {
        info: () => {
          throw new Error('sink down');
        },
      },
      kind: 'migration',
      info: FULL_RUN,
      nextSeq: sequence(),
    });
    assert.doesNotThrow(() => throwingSink.info('y'));
    assert.strictEqual(events.length, 0);
    // Dropped, but not invisibly: one debug line, with the correlation.
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].level, 'debug');
    assert.strictEqual(lines[0].msg, 'A ctx.logger call was dropped: getter');
    assert.strictEqual(lines[0].fields.runId, 'run-1');
  });

  it('should say once per run that calls were dropped or cut, whichever logger made them', () => {
    const parts = harness();
    const noticed = notices();
    const make = (attempt) =>
      createMigrationLogger({
        sink: parts.sink,
        kind: 'migration',
        info: { ...FULL_RUN, attempt },
        emitter: parts.emitter,
        nextSeq: sequence(),
        noticed,
      });
    const hostile = {
      get boom() {
        throw new Error('getter');
      },
    };
    const long = 'm'.repeat(MAX_MESSAGE_LENGTH + 1);
    for (const logger of [make(1), make(2)]) {
      logger.info('x', hostile);
      logger.info(long, { userland: true });
    }
    const debug = parts.lines.filter((line) => line.level === 'debug').map((line) => line.msg);
    assert.strictEqual(debug.length, 2);
    assert.strictEqual(debug[0], 'A ctx.logger call was dropped: getter');
    assert.match(debug[1], /^A ctx\.logger call was cut to the bounds of its migration:log event/);
    assert.strictEqual(parts.events.length, 2, 'the cut calls are still emitted');
  });

  it('should emit nothing without an emitter', () => {
    const { lines } = harness();
    const sink = { info: (msg) => lines.push(msg) };
    const logger = createMigrationLogger({
      sink,
      kind: 'migration',
      info: FULL_RUN,
      nextSeq: sequence(),
    });
    logger.info('x', { userland: true });
    assert.deepStrictEqual(lines, ['x']);
  });
});

describe('createRunLog', () => {
  function runLog(options = {}) {
    const parts = harness();
    const log = createRunLog({
      id: 'run-1',
      sink: parts.sink,
      emitter: parts.emitter,
      ...options,
    });
    return { ...parts, log };
  }

  it('should keep a copy of the job, as a reference and as log fields', () => {
    const job = { id: '17', groupId: 'g' };
    const { log } = runLog({ job, actor: { requestedBy: 'alice' } });
    assert.deepStrictEqual(log.job, { id: '17', groupId: 'g' });
    assert.notStrictEqual(log.job, job);
    assert.deepStrictEqual(log.fields, { jobId: '17', groupId: 'g' });
    assert.deepStrictEqual(runLog().log.fields, {});
    assert.strictEqual(runLog().log.job, undefined);
  });

  it("should make the run's ctx.run once per direction", () => {
    const { log } = runLog({ job: { id: '17' }, actor: { reason: 'why' } });
    const up = log.info('up');
    assert.strictEqual(log.info('up'), up);
    assert.deepStrictEqual(up, { id: 'run-1', direction: 'up', jobId: '17', reason: 'why' });
    assert.ok(Object.isFrozen(up));
    assert.strictEqual(log.info('down').direction, 'down');
  });

  it('should number every logger of the run in one sequence', () => {
    const { log, events } = runLog();
    const first = log.attempt('up', { migration: 'a.js', batch: 2, attempt: 1 });
    const second = log.attempt('up', { migration: 'b.js', attempt: 2 });
    assert.deepStrictEqual(first.run, {
      id: 'run-1',
      direction: 'up',
      migration: 'a.js',
      batch: 2,
      attempt: 1,
    });
    log.logger(log.info('up')).info('start', { userland: true });
    first.logger.info('a', { userland: true });
    second.logger.info('b', { userland: true });
    assert.deepStrictEqual(
      events.map((event) => [event.msg, event.seq, event.migration, event.attempt]),
      [
        ['start', 1, undefined, undefined],
        ['a', 2, 'a.js', 1],
        ['b', 3, 'b.js', 2],
      ],
    );
  });
});

describe('backgroundLogs', () => {
  const info = Object.freeze({
    name: 'bg.js',
    generation: 1,
    partition: '0',
    runId: 'lane-1',
    attempt: 1,
  });

  it("should number a slice's loggers in one sequence", () => {
    const { events, sink, emitter } = harness();
    const logs = backgroundLogs({ sink, emitter });
    logs(info, 'forward').info('a', { userland: true });
    logs({ ...info, attempt: 2 }, 'forward').info('b', { userland: true });
    assert.deepStrictEqual(
      events.map((event) => [event.seq, event.attempt, event.direction]),
      [
        [1, 1, 'forward'],
        [2, 2, 'forward'],
      ],
    );
  });

  it('should emit nothing in a dry run, even given an emitter', () => {
    const { lines, events, sink, emitter } = harness();
    backgroundLogs({ sink, emitter, dryRun: true })(info, 'forward').info('a', { userland: true });
    assert.strictEqual(events.length, 0);
    assert.strictEqual(lines[0].fields.dryRun, true);
  });
});
