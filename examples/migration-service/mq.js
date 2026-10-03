const path = require('node:path');
const { metrics, trace } = require('@opentelemetry/api');
const { Queue, QueueEvents, Worker } = require('bullmq');
const { BullMQOtel } = require('bullmq-otel');
const IORedis = require('ioredis');
const { createMigrationQueue } = require('@alexify/migronaut/bullmq');

// REDIS_URL is needed before migronaut resolves its own config (which is when
// it would load .env), so load the file here. Absent in containers — fine.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env: the environment is already set (docker, k8s, CI).
}

// One Redis client, owned by this module. BullMQ requires
// `maxRetriesPerRequest: null` of a client it shares with Workers.
const connection = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

const mq = createMigrationQueue({
  // The connection string and database come from MIGRONAUT_URI / MIGRONAUT_DB.
  config: {
    migrationsDir: path.join(__dirname, 'migrations'),
    // Declared collections, one file each: their indexes and validators as an
    // end state. With convergeAfterUp, every group that reaches the newest
    // migration ends with a converge job — after the migrations, in order.
    collectionsDir: path.join(__dirname, 'collections'),
    convergeAfterUp: true,
    // OpenTelemetry is injected like everything else: a tracer and a meter from
    // this app's own @opentelemetry/api. Until tracing.js starts an SDK both
    // are no-ops, so this costs nothing when tracing is off. (The meter stays a
    // no-op here even with tracing on — the example SDK has no metric reader.)
    telemetry: {
      tracer: trace.getTracer('@alexify/migronaut'),
      meter: metrics.getMeter('@alexify/migronaut'),
    },
  },
  // BullMQ is injected: migronaut never imports it, so this app decides the version.
  // `telemetry` is BullMQ's own — it is what carries a trace from the process
  // that enqueues to the worker that applies, and it goes to both.
  bullmq: {
    Queue,
    Worker,
    QueueEvents,
    telemetry: new BullMQOtel({ tracerName: 'migration-service' }),
  },
  connection,
  // One queue per database. A second database is a second createMigrationQueue
  // with its own queueName.
  queueName: 'migrations',
  // Keep finished jobs around: `wait()` and GET /migrations/jobs/:id read them.
  jobOptions: { removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 } },
  // What a job may ask for beyond "apply what is pending, in order". The API
  // in server.js offers `force` and `ordered: false`, so this service allows
  // them; a service that does not offer them should leave both off (the
  // default) — then a job planted in Redis cannot ask for them either.
  allow: { force: true, unordered: true },
});

module.exports = { connection, mq };
