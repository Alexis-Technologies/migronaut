const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { createMigrationProcessor, createMigrationQueue } = require('../../bullmq.js');
const { defineBullMQScenarios } = require('../helpers/bullmq-scenarios.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeProject } = require('../helpers/project.js');

const REDIS_URL = process.env.MIGRONAUT_TEST_REDIS_URL;
const DB = 'migronaut_bullmq_redis_test';

/**
 * The same scenarios as bullmq.test.js, on the real `bullmq` package and a
 * real Redis — the check that the in-tree fake (and with it the adapter) holds
 * against the library people will actually inject.
 *
 * Opt-in: it needs a Redis, which a plain `pnpm test` cannot assume. This is an
 * environment-capability skip with a reason — the one sanctioned exception to
 * "no committed skips" — and the coverage gate must pass without it. CI sets
 * the variable; locally:
 *
 *   docker run --rm -d -p 6379:6379 redis:7-alpine
 *   MIGRONAUT_TEST_REDIS_URL=redis://127.0.0.1:6379 node --test tests/integration/bullmq-redis.test.js
 */
describe(
  'BullMQ adapter (integration, real bullmq + Redis)',
  { skip: REDIS_URL ? false : 'set MIGRONAUT_TEST_REDIS_URL to run against a real Redis' },
  () => {
    let mongo;
    let connection;
    let bullmq;

    before(async () => {
      // Required here, not at module top: the skipped path must not need
      // either package to be loadable.
      const IORedis = require('ioredis');
      bullmq = require('bullmq');
      // BullMQ requires this of a client it shares with Workers.
      connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
      mongo = await startTestMongo(DB);
    });

    after(async () => {
      await mongo?.stop();
      await connection?.quit();
    });

    const harness = {
      fake: false,
      dbName: DB,
      mongo: () => mongo,
      bullmq: () => ({
        Queue: bullmq.Queue,
        Worker: bullmq.Worker,
        QueueEvents: bullmq.QueueEvents,
      }),
      connection: () => connection,
      // One Redis for the whole file: a prefix per test is the isolation.
      prefix: () => `migronaut-test-${randomUUID().slice(0, 8)}`,
      logsOf: async (queue, id) => (await queue.getJobLogs(id)).logs,
      obliterate: async (queue) => queue.obliterate({ force: true }),
    };

    defineBullMQScenarios(harness);

    // ─── What only the real library can confirm ──────────────────────────────

    it('should leave the injected Redis connection open after close()', async () => {
      const project = makeProject();
      try {
        const mq = createMigrationQueue({
          config: { uri: mongo.uri, dbName: DB, migrationsDir: project.dir, logger: null },
          bullmq: harness.bullmq(),
          connection,
          prefix: harness.prefix(),
        });
        await mq.startWorker();
        await mq.close();
        assert.strictEqual(await connection.ping(), 'PONG');
      } finally {
        project.cleanup();
      }
    });

    it('should announce a deduplicated add on QueueEvents', async () => {
      const project = makeProject();
      const prefix = harness.prefix();
      project.write('0001-a.js', insertMigration('things', 'a'));
      const mq = createMigrationQueue({
        config: { uri: mongo.uri, dbName: DB, migrationsDir: project.dir, logger: null },
        bullmq: harness.bullmq(),
        connection,
        prefix,
      });
      const queueEvents = new bullmq.QueueEvents(mq.queueName, { connection, prefix });
      try {
        await mongo.db.dropDatabase();
        await queueEvents.waitUntilReady();
        const seen = new Promise((resolve) => queueEvents.once('deduplicated', resolve));
        const first = await mq.enqueueUp();
        const second = await mq.enqueueUp();
        const event = await seen;
        assert.strictEqual(event.jobId, first.jobs[0].id);
        assert.strictEqual(event.deduplicationId, 'up-0001-a.js');
        assert.deepStrictEqual(second.deduplicated, ['0001-a.js']);
      } finally {
        await queueEvents.close();
        await mq.queue.obliterate({ force: true });
        await mq.close();
        project.cleanup();
      }
    });

    it('should run under a Worker the application constructs itself', async () => {
      const project = makeProject();
      const prefix = harness.prefix();
      project.write('0001-a.js', insertMigration('things', 'a'));
      await mongo.db.dropDatabase();
      const config = { uri: mongo.uri, dbName: DB, migrationsDir: project.dir, logger: null };
      const producer = createMigrationQueue({
        config,
        bullmq: { Queue: bullmq.Queue, QueueEvents: bullmq.QueueEvents },
        connection,
        prefix,
      });
      // The low-level path: a processor handed to a plain BullMQ Worker.
      const processor = createMigrationProcessor({ config });
      const worker = new bullmq.Worker(producer.queueName, processor, {
        connection,
        prefix,
        concurrency: 1,
      });
      try {
        const group = await producer.enqueueUp();
        const { results } = await group.wait({ timeoutMs: 15_000 });
        assert.strictEqual(results[0].status, 'applied');
      } finally {
        await worker.close();
        await processor.close();
        await producer.queue.obliterate({ force: true });
        await producer.close();
        project.cleanup();
      }
    });

    // ─── Tracing, end to end ─────────────────────────────────────────────────
    // The fake models none of this — it is BullMQ's own telemetry doing the
    // propagation, so only the real library can say whether the trace joins up.

    describe('with OpenTelemetry', () => {
      let tracing;
      let telemetry;
      let parentIdOf;

      before(() => {
        // `register()` installs the propagator as well as the context manager:
        // without it BullMQ has nothing to write into the job, and the worker's
        // span starts a trace of its own.
        const otel = require('../helpers/otel.js');
        parentIdOf = otel.parentIdOf;
        tracing = otel.startTracing();
        const { BullMQOtel } = require('bullmq-otel');
        telemetry = new BullMQOtel({ tracerName: 'migronaut-test' });
      });

      after(async () => {
        await tracing?.stop();
      });

      const idOf = (span) => span.spanContext().spanId;
      const traceOf = (span) => span.spanContext().traceId;

      it('should carry one trace from the enqueue to the migration', async () => {
        const project = makeProject();
        const prefix = harness.prefix();
        project.write('0001-a.js', insertMigration('things', 'a'));
        await mongo.db.dropDatabase();
        tracing.reset();
        const mq = createMigrationQueue({
          config: {
            uri: mongo.uri,
            dbName: DB,
            migrationsDir: project.dir,
            logger: null,
            telemetry: { tracer: tracing.tracer },
          },
          bullmq: { ...harness.bullmq(), telemetry },
          connection,
          prefix,
        });
        try {
          // Outside any span, as the guide says: a worker started inside one
          // would hang its background work under it.
          await mq.startWorker();
          const group = await tracing.tracer.startActiveSpan(
            'POST /migrations/up',
            async (span) => {
              try {
                return await mq.enqueueUp();
              } finally {
                span.end();
              }
            },
          );
          const { results } = await group.wait({ timeoutMs: 15_000 });
          assert.strictEqual(results[0].status, 'applied');
        } finally {
          // BullMQ ends the `process` span after the job is moved to completed,
          // which can be after wait() resolves — closing the worker settles it.
          await mq.queue.obliterate({ force: true });
          await mq.close();
          project.cleanup();
        }

        const [request] = tracing.named('POST /migrations/up');
        const [produced] = tracing.spans().filter((span) => span.name.startsWith('addBulk '));
        const [consumed] = tracing.spans().filter((span) => span.name.startsWith('process '));
        const [run] = tracing.named('migronaut.run');
        const [migration] = tracing.named('migronaut.migration');
        for (const [name, span] of Object.entries({
          request,
          produced,
          consumed,
          run,
          migration,
        })) {
          assert.ok(span, `expected a ${name} span`);
          assert.strictEqual(traceOf(span), traceOf(request), `${name} is in the request's trace`);
        }
        assert.strictEqual(parentIdOf(produced), idOf(request));
        assert.strictEqual(parentIdOf(consumed), idOf(produced));
        assert.strictEqual(parentIdOf(run), idOf(consumed));
        assert.strictEqual(parentIdOf(migration), idOf(run));
        assert.strictEqual(migration.attributes['migronaut.migration.name'], '0001-a.js');
      });

      it('should start a trace per scheduler tick, with its migrations under it', async () => {
        const project = makeProject();
        const prefix = harness.prefix();
        project.write('0001-a.js', insertMigration('things', 'a'));
        await mongo.db.dropDatabase();
        tracing.reset();
        const mq = createMigrationQueue({
          config: {
            uri: mongo.uri,
            dbName: DB,
            migrationsDir: project.dir,
            logger: null,
            telemetry: { tracer: tracing.tracer },
          },
          bullmq: { ...harness.bullmq(), telemetry },
          connection,
          prefix,
        });
        const syncs = [];
        try {
          const worker = await mq.startWorker();
          const twoTicks = new Promise((resolve) => {
            worker.on('completed', (job) => {
              if (job.name === 'sync' && syncs.push(job.id) === 2) resolve();
            });
          });
          // Registered inside a span — the trace every tick would otherwise join.
          await tracing.tracer.startActiveSpan('deploy', async (span) => {
            try {
              await mq.schedule({ every: 400 });
            } finally {
              span.end();
            }
          });
          await twoTicks;
          await mq.unschedule();
        } finally {
          await mq.queue.obliterate({ force: true });
          await mq.close();
          project.cleanup();
        }

        const [deploy] = tracing.named('deploy');
        const processed = tracing.spans().filter((span) => span.name.startsWith('process '));
        const ticks = processed.filter((span) => span.attributes['bullmq.job.name'] === 'sync');
        assert.ok(ticks.length >= 2, `expected two ticks, saw ${ticks.length}`);
        const traces = new Set(ticks.map(traceOf));
        assert.strictEqual(traces.size, ticks.length, 'every tick is a trace of its own');
        assert.ok(!traces.has(traceOf(deploy)), 'and none of them is the trace that scheduled it');
        for (const tick of ticks) assert.strictEqual(parentIdOf(tick), undefined);

        // The first tick found a pending migration and enqueued it: that job,
        // and the migration it ran, belong to the tick's trace.
        const [migration] = tracing.named('migronaut.migration');
        assert.ok(migration, 'the scheduled sync applied the pending migration');
        assert.ok(traces.has(traceOf(migration)));
      });
    });
  },
);
