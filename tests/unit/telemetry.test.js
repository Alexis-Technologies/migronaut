const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { ConfigInvalidError, MigrationExecutionFailedError } = require('../../src/errors/index.js');
const {
  ATTRIBUTES,
  DURATION_BUCKETS_SECONDS,
  MAX_STATUS_MESSAGE_LENGTH,
  METRICS,
  NOOP_SPAN,
  SPANS,
  SPAN_STATUS_ERROR,
  createTelemetry,
  errorType,
  failureText,
} = require('../../src/utils/telemetry.js');
const { parentIdOf, startMetrics, startTracing } = require('../helpers/otel.js');

/** A tracer double that records what it was asked for and runs the callback inline */
function fakeTracer() {
  const spans = [];
  const calls = [];
  return {
    spans,
    calls,
    startActiveSpan(...args) {
      calls.push(args);
      const [name, options, fn] = args;
      const span = {
        name,
        attributes: { ...options.attributes },
        status: undefined,
        ended: 0,
        setAttribute(key, value) {
          this.attributes[key] = value;
        },
        setStatus(status) {
          this.status = status;
        },
        end() {
          this.ended += 1;
        },
      };
      spans.push(span);
      return fn(span);
    },
  };
}

/** A meter double: every instrument remembers how it was created and what it recorded */
function fakeMeter() {
  const instruments = {};
  const make = (kind) => (name, options) => {
    const instrument = {
      kind,
      options,
      points: [],
      record(value, attributes) {
        this.points.push({ value, attributes });
      },
      add(value, attributes) {
        this.points.push({ value, attributes });
      },
    };
    instruments[name] = instrument;
    return instrument;
  };
  return {
    instruments,
    createHistogram: make('histogram'),
    createCounter: make('counter'),
  };
}

describe('createTelemetry — switched off', () => {
  it('should run the work with a no-op span when there is nothing to report to', async () => {
    for (const config of [undefined, null, {}, { tracer: null, meter: null }]) {
      const telemetry = createTelemetry(config);
      const seen = [];
      assert.strictEqual(
        telemetry.open(SPANS.RUN, { a: 1 }, (span) => {
          seen.push(span);
          return 'opened';
        }),
        'opened',
      );
      assert.strictEqual(
        await telemetry.wrap(SPANS.MIGRATION, {}, async (span) => {
          seen.push(span);
          return 'wrapped';
        }),
        'wrapped',
      );
      assert.deepStrictEqual(seen, [NOOP_SPAN, NOOP_SPAN]);
      // The kit calls these unconditionally — none may need a meter to exist.
      telemetry.runEnded({ command: 'up', durationMs: 1 });
      telemetry.migrationEnded({ direction: 'up', durationMs: 1 });
      telemetry.lockAcquired(1);
      telemetry.lockRefused();
      telemetry.lockLost();
    }
  });

  it('should give the no-op span the surface the kit uses', () => {
    assert.strictEqual(NOOP_SPAN.set({ a: 1 }), undefined);
    assert.strictEqual(NOOP_SPAN.finish({ a: 1 }, new Error('x')), undefined);
  });
});

describe('open', () => {
  it('should start an active span with exactly three arguments', () => {
    // An SDK tracer picks its overload by argument count: a fourth argument
    // would be read as the callback.
    const tracer = fakeTracer();
    createTelemetry({ tracer }).open(SPANS.RUN, { a: 1 }, () => {});
    assert.strictEqual(tracer.calls.length, 1);
    assert.strictEqual(tracer.calls[0].length, 3);
    assert.strictEqual(tracer.calls[0][0], 'migronaut.run');
    assert.deepStrictEqual(tracer.calls[0][1], { attributes: { a: 1 } });
  });

  it('should leave undefined attributes out rather than hand them to the SDK', () => {
    const tracer = fakeTracer();
    createTelemetry({ tracer }).open(SPANS.RUN, { kept: 0, dropped: undefined }, () => {});
    assert.deepStrictEqual(tracer.spans[0].attributes, { kept: 0 });
  });

  it('should return what the work returned, not what the tracer did', () => {
    const tracer = fakeTracer();
    const real = tracer.startActiveSpan.bind(tracer);
    tracer.startActiveSpan = (...args) => {
      real(...args);
      return 'from the tracer';
    };
    assert.strictEqual(
      createTelemetry({ tracer }).open(SPANS.RUN, {}, () => 'from the work'),
      'from the work',
    );
  });

  it('should leave ending the span to the caller', () => {
    const tracer = fakeTracer();
    let held;
    createTelemetry({ tracer }).open(SPANS.RUN, {}, (span) => {
      held = span;
    });
    assert.strictEqual(tracer.spans[0].ended, 0);
    held.finish({ done: true });
    assert.strictEqual(tracer.spans[0].ended, 1);
    assert.strictEqual(tracer.spans[0].attributes.done, true);
  });

  it('should end a span once, however often it is finished', () => {
    const tracer = fakeTracer();
    let held;
    createTelemetry({ tracer }).open(SPANS.RUN, {}, (span) => {
      held = span;
    });
    held.finish({ first: true });
    held.finish({ second: true }, new Error('late'));
    assert.strictEqual(tracer.spans[0].ended, 1);
    assert.deepStrictEqual(tracer.spans[0].attributes, { first: true });
    assert.strictEqual(tracer.spans[0].status, undefined);
  });

  it('should never claim OK — a success leaves the status unset', () => {
    const tracer = fakeTracer();
    createTelemetry({ tracer }).open(SPANS.RUN, {}, (span) => span.finish());
    assert.strictEqual(tracer.spans[0].status, undefined);
    assert.ok(!(ATTRIBUTES.ERROR_TYPE in tracer.spans[0].attributes));
  });

  it('should mark a failed span with the ERROR status and the error type', () => {
    const tracer = fakeTracer();
    createTelemetry({ tracer }).open(SPANS.RUN, {}, (span) =>
      span.finish(undefined, new ConfigInvalidError('Invalid configuration')),
    );
    assert.deepStrictEqual(tracer.spans[0].status, {
      code: SPAN_STATUS_ERROR,
      message: 'Invalid configuration',
    });
    assert.strictEqual(SPAN_STATUS_ERROR, 2);
    assert.strictEqual(tracer.spans[0].attributes['error.type'], 'CONFIG_INVALID');
  });

  it('should set attributes on a span that is still open', () => {
    const tracer = fakeTracer();
    createTelemetry({ tracer }).open(SPANS.MIGRATION, {}, (span) => {
      span.set({ [ATTRIBUTES.MIGRATION_TRANSACTION]: false, skipped: undefined });
    });
    assert.deepStrictEqual(tracer.spans[0].attributes, {
      'migronaut.migration.transaction': false,
    });
  });
});

describe('open — a tracer that misbehaves', () => {
  it('should still do the work, once, when the tracer throws before calling back', () => {
    const tracer = {
      startActiveSpan() {
        throw new Error('exporter is down');
      },
    };
    let runs = 0;
    const result = createTelemetry({ tracer }).open(SPANS.RUN, {}, (span) => {
      runs += 1;
      assert.strictEqual(span, NOOP_SPAN);
      return 'done';
    });
    assert.strictEqual(result, 'done');
    assert.strictEqual(runs, 1);
  });

  it('should not turn finished work into a failure when the tracer throws afterwards', () => {
    const tracer = fakeTracer();
    const real = tracer.startActiveSpan.bind(tracer);
    tracer.startActiveSpan = (...args) => {
      real(...args);
      throw new Error('context manager broke');
    };
    let runs = 0;
    const result = createTelemetry({ tracer }).open(SPANS.RUN, {}, () => {
      runs += 1;
      return 'done';
    });
    assert.strictEqual(result, 'done');
    assert.strictEqual(runs, 1);
  });

  it('should do the work once when the tracer calls back twice', () => {
    // Running a migration twice because of a tracing bug is the one outcome
    // this module must make impossible.
    const tracer = {
      startActiveSpan(_name, _options, fn) {
        fn({});
        return fn({});
      },
    };
    let runs = 0;
    const result = createTelemetry({ tracer }).open(SPANS.RUN, {}, () => {
      runs += 1;
      return runs;
    });
    assert.strictEqual(result, 1);
    assert.strictEqual(runs, 1);
  });

  it('should do the work itself when the tracer never calls back', () => {
    const tracer = { startActiveSpan: () => undefined };
    let runs = 0;
    assert.strictEqual(
      createTelemetry({ tracer }).open(SPANS.RUN, {}, () => {
        runs += 1;
        return 'done';
      }),
      'done',
    );
    assert.strictEqual(runs, 1);
  });

  it('should not run the work again for a tracer that calls back late', () => {
    let late;
    const tracer = {
      startActiveSpan(_name, _options, fn) {
        late = () => fn({});
      },
    };
    let runs = 0;
    createTelemetry({ tracer }).open(SPANS.RUN, {}, () => {
      runs += 1;
      return 'done';
    });
    assert.strictEqual(late(), 'done');
    assert.strictEqual(runs, 1);
  });

  it('should rethrow a synchronous throw from the work, even past a tracer that swallows it', () => {
    const boom = new Error('boom');
    for (const tracer of [
      fakeTracer(),
      {
        startActiveSpan(_name, _options, fn) {
          try {
            fn({});
          } catch {
            // A tracer that eats what its callback throws.
          }
        },
      },
      {
        startActiveSpan() {
          throw new Error('never called back');
        },
      },
    ]) {
      assert.throws(
        () =>
          createTelemetry({ tracer }).open(SPANS.RUN, {}, () => {
            throw boom;
          }),
        (error) => error === boom,
      );
    }
  });

  it('should swallow a span whose methods throw', () => {
    const tracer = {
      startActiveSpan(_name, _options, fn) {
        return fn({
          setAttribute() {
            throw new Error('setAttribute');
          },
          setStatus() {
            throw new Error('setStatus');
          },
          end() {
            throw new Error('end');
          },
        });
      },
    };
    createTelemetry({ tracer }).open(SPANS.RUN, {}, (span) => {
      span.set({ a: 1 });
      span.finish({ b: 2 }, new Error('failed'));
    });
  });

  it('should survive a tracer that hands over no span at all', () => {
    const tracer = { startActiveSpan: (_name, _options, fn) => fn(undefined) };
    assert.strictEqual(
      createTelemetry({ tracer }).open(SPANS.RUN, {}, (span) => {
        span.set({ a: 1 });
        span.finish(undefined, new Error('failed'));
        return 'done';
      }),
      'done',
    );
  });

  it('should fall back to doing the work when the tracer is not one', () => {
    // validateConfig refuses this shape; a kit built some other way must
    // still not lose the run to it.
    let runs = 0;
    createTelemetry({ tracer: {} }).open(SPANS.RUN, {}, () => {
      runs += 1;
    });
    assert.strictEqual(runs, 1);
  });
});

describe('wrap', () => {
  it('should end the span when the work resolves', async () => {
    const tracer = fakeTracer();
    const result = await createTelemetry({ tracer }).wrap(
      SPANS.MIGRATION,
      { [ATTRIBUTES.MIGRATION_NAME]: '0001-a.js' },
      async () => 42,
    );
    assert.strictEqual(result, 42);
    assert.strictEqual(tracer.spans[0].name, 'migronaut.migration');
    assert.strictEqual(tracer.spans[0].ended, 1);
    assert.strictEqual(tracer.spans[0].status, undefined);
  });

  it('should fail the span and rethrow when the work rejects', async () => {
    const tracer = fakeTracer();
    const boom = new MigrationExecutionFailedError('Migration up failed: 0001-a.js', {
      name: '0001-a.js',
      cause: 'E11000 duplicate key',
    });
    await assert.rejects(
      createTelemetry({ tracer }).wrap(SPANS.MIGRATION, {}, async () => {
        throw boom;
      }),
      (error) => error === boom,
    );
    assert.strictEqual(tracer.spans[0].ended, 1);
    assert.deepStrictEqual(tracer.spans[0].status, {
      code: 2,
      message: 'Migration up failed: 0001-a.js — E11000 duplicate key',
    });
    assert.strictEqual(tracer.spans[0].attributes['error.type'], 'MIGRATION_EXECUTION_FAILED');
  });

  it('should not leave an unhandled rejection behind a tracer that wraps the work', async () => {
    // A tracer that chains on the work returns a second promise, which rejects
    // with it — nobody awaits that one, and an unhandled rejection ends Node.
    const tracer = fakeTracer();
    const inner = tracer.startActiveSpan.bind(tracer);
    tracer.startActiveSpan = (...args) => inner(...args).finally(() => undefined);
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(
        createTelemetry({ tracer }).wrap(SPANS.MIGRATION, {}, async () => {
          throw new Error('migration failed');
        }),
        /migration failed/,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepStrictEqual(unhandled, []);
  });

  it('should treat a synchronous throw like a rejection', async () => {
    const tracer = fakeTracer();
    await assert.rejects(
      createTelemetry({ tracer }).wrap(SPANS.MIGRATION, {}, () => {
        throw new TypeError('not async');
      }),
      TypeError,
    );
    assert.strictEqual(tracer.spans[0].ended, 1);
    assert.strictEqual(tracer.spans[0].attributes['error.type'], 'TypeError');
  });
});

describe('errorType', () => {
  it('should be the typed code of a migronaut error', () => {
    assert.strictEqual(errorType(new ConfigInvalidError('x')), 'CONFIG_INVALID');
  });

  it('should be the class name of any other error', () => {
    assert.strictEqual(errorType(new RangeError('x')), 'RangeError');
  });

  it('should fall back to _OTHER for a thrown value with no usable name', () => {
    for (const value of ['a string', 42, null, undefined, {}, { name: '' }, { name: 7 }]) {
      assert.strictEqual(errorType(value), '_OTHER');
    }
  });

  it('should never throw — not even for a value whose name getter does', () => {
    const hostile = {
      get name() {
        throw new Error('gotcha');
      },
    };
    assert.strictEqual(errorType(hostile), '_OTHER');
    assert.strictEqual(
      errorType(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error('trap');
            },
          },
        ),
      ),
      '_OTHER',
    );
  });
});

describe('failureText — what a tracing backend receives', () => {
  it('should mask the values a duplicate-key error quotes', () => {
    const error = new MigrationExecutionFailedError('Migration up failed: 0001-a.js', {
      cause: 'E11000 duplicate key error index: email_1 dup key: { email: "alice@example.com" }',
    });
    assert.strictEqual(
      failureText(error),
      'Migration up failed: 0001-a.js — E11000 duplicate key error index: email_1 dup key: ' +
        '{ <redacted> }',
    );
  });

  it('should bound the message', () => {
    const text = failureText(new Error('x'.repeat(5000)));
    assert.strictEqual(text.length, MAX_STATUS_MESSAGE_LENGTH);
    assert.ok(text.endsWith('…'));
  });
});

describe('failureText', () => {
  it('should mask URI credentials — a driver message can echo the connection string', () => {
    const text = failureText(new Error('connect failed: mongodb://app:hunter2@db.internal/app'));
    assert.strictEqual(text, 'connect failed: mongodb://app:****@db.internal/app');
  });

  it('should append the wrapped cause, redacted too', () => {
    const error = new MigrationExecutionFailedError('Migration up failed: 0001-a.js', {
      cause: 'bad auth mongodb://app:hunter2@db.internal/app',
    });
    assert.strictEqual(
      failureText(error),
      'Migration up failed: 0001-a.js — bad auth mongodb://app:****@db.internal/app',
    );
  });

  it('should ignore a cause that is not a string, or not on a migronaut error', () => {
    assert.strictEqual(
      failureText(new ConfigInvalidError('Invalid configuration', { cause: { nested: true } })),
      'Invalid configuration',
    );
    const plain = new Error('plain');
    plain.context = { cause: 'not ours' };
    assert.strictEqual(failureText(plain), 'plain');
    assert.strictEqual(failureText('thrown string'), 'thrown string');
  });
});

describe('metrics', () => {
  it('should create four duration histograms in seconds and two counters', () => {
    const meter = fakeMeter();
    createTelemetry({ meter });
    assert.deepStrictEqual(Object.keys(meter.instruments).sort(), [
      'migronaut.lock.acquire.duration',
      'migronaut.lock.lost',
      'migronaut.lock.refused',
      'migronaut.lock.wait.duration',
      'migronaut.migration.duration',
      'migronaut.run.duration',
    ]);
    for (const name of [
      METRICS.RUN_DURATION,
      METRICS.MIGRATION_DURATION,
      METRICS.LOCK_ACQUIRE_DURATION,
      METRICS.LOCK_WAIT_DURATION,
    ]) {
      const instrument = meter.instruments[name];
      assert.strictEqual(instrument.kind, 'histogram');
      assert.strictEqual(instrument.options.unit, 's');
      assert.strictEqual(typeof instrument.options.description, 'string');
      assert.deepStrictEqual(
        instrument.options.advice.explicitBucketBoundaries,
        DURATION_BUCKETS_SECONDS,
      );
    }
    for (const name of [METRICS.LOCK_REFUSED, METRICS.LOCK_LOST]) {
      assert.strictEqual(meter.instruments[name].kind, 'counter');
      // A counter of events says what it counts, as the conventions ask.
      assert.match(meter.instruments[name].options.unit, /^\{\w+\}$/);
    }
  });

  it('should record how a lock wait ended, in seconds', () => {
    const meter = fakeMeter();
    const telemetry = createTelemetry({ meter }, { dbName: 'app' });
    telemetry.lockWaited({ waitedMs: 2500, outcome: 'acquired' });
    telemetry.lockWaited({ waitedMs: 90_000, outcome: 'timeout' });
    assert.deepStrictEqual(meter.instruments[METRICS.LOCK_WAIT_DURATION].points, [
      {
        value: 2.5,
        attributes: { 'db.namespace': 'app', 'migronaut.lock.wait.outcome': 'acquired' },
      },
      {
        value: 90,
        attributes: { 'db.namespace': 'app', 'migronaut.lock.wait.outcome': 'timeout' },
      },
    ]);
  });

  it('should size the buckets for migrations — ascending, from 10ms to an hour', () => {
    assert.strictEqual(DURATION_BUCKETS_SECONDS[0], 0.01);
    assert.strictEqual(DURATION_BUCKETS_SECONDS.at(-1), 3600);
    const sorted = [...DURATION_BUCKETS_SECONDS].sort((a, b) => a - b);
    assert.deepStrictEqual(DURATION_BUCKETS_SECONDS, sorted);
  });

  it('should record a run in seconds, with its command, direction and failure', () => {
    const meter = fakeMeter();
    const telemetry = createTelemetry({ meter });
    telemetry.runEnded({ command: 'up', direction: 'up', durationMs: 1500 });
    telemetry.runEnded({ command: 'redo', durationMs: 20, error: new ConfigInvalidError('x') });
    assert.deepStrictEqual(meter.instruments[METRICS.RUN_DURATION].points, [
      {
        value: 1.5,
        attributes: { 'migronaut.run.command': 'up', 'migronaut.run.direction': 'up' },
      },
      // redo has no single direction — the attribute is absent, not undefined.
      {
        value: 0.02,
        attributes: { 'migronaut.run.command': 'redo', 'error.type': 'CONFIG_INVALID' },
      },
    ]);
  });

  it('should record a migration by direction only — its name stays on the span', () => {
    const meter = fakeMeter();
    const telemetry = createTelemetry({ meter });
    telemetry.migrationEnded({ direction: 'up', durationMs: 250 });
    telemetry.migrationEnded({ direction: 'down', durationMs: 4, error: new RangeError('x') });
    assert.deepStrictEqual(meter.instruments[METRICS.MIGRATION_DURATION].points, [
      { value: 0.25, attributes: { 'migronaut.migration.direction': 'up' } },
      {
        value: 0.004,
        attributes: { 'migronaut.migration.direction': 'down', 'error.type': 'RangeError' },
      },
    ]);
  });

  it('should record lock acquisition latency and count refusals and losses', () => {
    const meter = fakeMeter();
    const telemetry = createTelemetry({ meter });
    telemetry.lockAcquired(12);
    telemetry.lockRefused();
    telemetry.lockRefused();
    telemetry.lockLost();
    assert.deepStrictEqual(meter.instruments[METRICS.LOCK_ACQUIRE_DURATION].points, [
      { value: 0.012, attributes: {} },
    ]);
    assert.strictEqual(meter.instruments[METRICS.LOCK_REFUSED].points.length, 2);
    assert.strictEqual(meter.instruments[METRICS.LOCK_LOST].points.length, 1);
    assert.strictEqual(meter.instruments[METRICS.LOCK_LOST].points[0].value, 1);
  });

  it('should keep the other instruments when one cannot be created', () => {
    const meter = fakeMeter();
    const createHistogram = meter.createHistogram;
    meter.createHistogram = (name, options) => {
      if (name === METRICS.RUN_DURATION) throw new Error('duplicate instrument');
      return createHistogram(name, options);
    };
    const telemetry = createTelemetry({ meter });
    telemetry.runEnded({ command: 'up', durationMs: 5 });
    telemetry.migrationEnded({ direction: 'up', durationMs: 5 });
    assert.ok(!(METRICS.RUN_DURATION in meter.instruments));
    assert.strictEqual(meter.instruments[METRICS.MIGRATION_DURATION].points.length, 1);
  });

  it('should swallow an instrument that rejects when recording', async () => {
    const rejecting = {
      record: async () => {
        throw new Error('exporter down');
      },
      add: async () => {
        throw new Error('exporter down');
      },
    };
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const telemetry = createTelemetry({
        meter: { createHistogram: () => rejecting, createCounter: () => rejecting },
      });
      telemetry.runEnded({ command: 'up', durationMs: 5 });
      telemetry.lockRefused();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepStrictEqual(unhandled, []);
  });

  it('should swallow an instrument that throws when recording', () => {
    const throwing = {
      record() {
        throw new Error('record');
      },
      add() {
        throw new Error('add');
      },
    };
    const telemetry = createTelemetry({
      meter: { createHistogram: () => throwing, createCounter: () => throwing },
    });
    telemetry.runEnded({ command: 'up', durationMs: 5 });
    telemetry.migrationEnded({ direction: 'up', durationMs: 5 });
    telemetry.lockAcquired(5);
    telemetry.lockRefused();
    telemetry.lockLost();
  });

  it('should work with a meter alone — spans and metrics are independent', async () => {
    const meter = fakeMeter();
    const telemetry = createTelemetry({ meter });
    assert.strictEqual(await telemetry.wrap(SPANS.MIGRATION, {}, async () => 'done'), 'done');
    telemetry.migrationEnded({ direction: 'up', durationMs: 1 });
    assert.strictEqual(meter.instruments[METRICS.MIGRATION_DURATION].points.length, 1);
  });
});

describe('createTelemetry — against the real OpenTelemetry SDK', () => {
  let tracing;

  before(() => {
    tracing = startTracing();
  });

  after(async () => {
    await tracing.stop();
  });

  it('should nest a migration span under the run span that is active around it', async () => {
    const telemetry = createTelemetry({ tracer: tracing.tracer });
    let run;
    await telemetry.open(SPANS.RUN, { [ATTRIBUTES.RUN_COMMAND]: 'up' }, async (span) => {
      run = span;
      await telemetry.wrap(SPANS.MIGRATION, { [ATTRIBUTES.MIGRATION_NAME]: '0001-a.js' }, () =>
        Promise.resolve(),
      );
    });
    run.finish({ [ATTRIBUTES.RUN_APPLIED]: 1 });

    const [migration] = tracing.named('migronaut.migration');
    const [runSpan] = tracing.named('migronaut.run');
    assert.strictEqual(parentIdOf(migration), runSpan.spanContext().spanId);
    assert.strictEqual(parentIdOf(runSpan), undefined);
    assert.deepStrictEqual(runSpan.attributes, {
      'migronaut.run.command': 'up',
      'migronaut.run.applied': 1,
    });
    // UNSET (0): a success is not claimed as OK.
    assert.strictEqual(runSpan.status.code, 0);
  });

  it('should record a failure the way a real span reports it', async () => {
    tracing.reset();
    const telemetry = createTelemetry({ tracer: tracing.tracer });
    await assert.rejects(
      telemetry.wrap(SPANS.MIGRATION, {}, async () => {
        throw new MigrationExecutionFailedError('Migration up failed: 0002-b.js', {
          cause: 'mongodb://app:hunter2@db/app refused',
        });
      }),
    );
    const [span] = tracing.named('migronaut.migration');
    assert.strictEqual(span.status.code, 2);
    assert.strictEqual(
      span.status.message,
      'Migration up failed: 0002-b.js — mongodb://app:****@db/app refused',
    );
    assert.strictEqual(span.attributes['error.type'], 'MIGRATION_EXECUTION_FAILED');
    // No exception event: the redacted status message is the whole record.
    assert.deepStrictEqual(span.events, []);
  });

  it('should produce real histogram and counter points', async () => {
    const metrics = startMetrics();
    const telemetry = createTelemetry({ meter: metrics.meter });
    telemetry.runEnded({ command: 'up', direction: 'up', durationMs: 1500 });
    telemetry.migrationEnded({ direction: 'up', durationMs: 250 });
    telemetry.lockAcquired(8);
    telemetry.lockRefused();
    telemetry.lockLost();

    const data = await metrics.collect();
    const run = data['migronaut.run.duration'][0];
    assert.strictEqual(run.value.sum, 1.5);
    assert.strictEqual(run.value.count, 1);
    assert.deepStrictEqual(run.value.buckets.boundaries, DURATION_BUCKETS_SECONDS);
    assert.deepStrictEqual(run.attributes, {
      'migronaut.run.command': 'up',
      'migronaut.run.direction': 'up',
    });
    assert.strictEqual(data['migronaut.migration.duration'][0].value.sum, 0.25);
    assert.strictEqual(data['migronaut.lock.acquire.duration'][0].value.sum, 0.008);
    assert.strictEqual(data['migronaut.lock.refused'][0].value, 1);
    assert.strictEqual(data['migronaut.lock.lost'][0].value, 1);
    await metrics.stop();
  });
});
