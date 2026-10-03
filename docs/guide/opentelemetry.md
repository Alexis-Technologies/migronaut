# OpenTelemetry

Hand migronaut a tracer and it turns every run and every migration into a span; hand it a meter and
their durations become metrics. Both come from **your** `@opentelemetry/api` — migronaut never
imports it, the same way it never imports your logger.

```js
// migronaut.config.js
import { metrics, trace } from '@opentelemetry/api';

export default {
  uri: process.env.MONGO_URI,
  dbName: 'myapp',
  telemetry: {
    tracer: trace.getTracer('@alexify/migronaut'),
    meter: metrics.getMeter('@alexify/migronaut'),
  },
};
```

The two parts are independent: a tracer alone gives spans, a meter alone gives metrics. Absent,
`null` or empty turns telemetry off — it costs nothing when unused.

::: tip When this is worth it — and when it is not
**Migrations at application startup** ([`runMigrations`](/guide/api)) gain the most. An instrumented
MongoDB driver only records a command that has a parent span, and a migration run at boot has none
— so without this, the driver's spans for your migrations are simply not there.

**A migration service** ([BullMQ](/guide/bullmq)) gains a joined-up trace from the request that
enqueued to the worker that applied — see [below](#through-a-bullmq-queue).

**A one-off `migronaut up` from a terminal** gains little: the log lines and the
[changelog](/guide/concepts) already tell you what ran and how long it took.

For plain metrics you may not need this at all — [lifecycle events](/guide/hooks#events) carry the
same durations and are enough to feed StatsD, Prometheus or your own counters.
:::

## What you get

```
migronaut.run                          one per run, once it holds the lock
├─ find _migronaut_migrations          ← the driver's own spans, if it is instrumented
└─ migronaut.migration                 one per migration executed
   ├─ insert users                     ← what the migration's `up()` did
   └─ update _migronaut_migrations     ← its changelog record
```

The migration's span is the **active** one for everything that migration does — its hooks, its
`up`/`down`, its changelog write. That is the part only migronaut can provide: a
[lifecycle event](/guide/hooks#events) can tell you a migration started, but it cannot make a span
the parent of what runs next. Anything instrumented underneath — the MongoDB driver, an HTTP client
your migration calls — nests under the migration that caused it, with no change to your migration
files.

Whatever span is active when you call `kit.up()` becomes the run's parent, so a run started inside
your own "application startup" span shows up as part of it.

### Spans

| Span | Emitted | Attributes |
|---|---|---|
| `migronaut.run` | Once per `up` / `down` / `redo` / `baseline` / `import` / `converge` that acquired the lock | `migronaut.run.id`, `migronaut.run.command`, `migronaut.run.direction`, `migronaut.lock.acquire_ms` (or `migronaut.lock.skipped` under `--no-lock`); at the end `migronaut.run.applied`, `migronaut.run.reverted`, `migronaut.run.skipped`, `migronaut.run.total`, and `migronaut.lock.lost_reason` if the lock was lost |
| `migronaut.migration` | Once per migration executed, as a child of the run | `migronaut.migration.name`, `migronaut.migration.direction`, `migronaut.migration.batch`, `migronaut.migration.index`, `migronaut.migration.total`, `migronaut.migration.transaction`, and `migronaut.run.id` |

A failure sets the span's status to `ERROR` with the failure message, and `error.type` to the
[error code](/reference/error-codes) (`MIGRATION_EXECUTION_FAILED`, `LOCK_LOST`, …) — or, for an
error that is not migronaut's (a `TypeError` thrown by a migration), to its class name, and
`_OTHER` when it has none. A success leaves the status unset, as OpenTelemetry asks of libraries.
A converge run is an ordinary `migronaut.run` with `migronaut.run.command = converge`; the
driver's index commands nest under it.

`migronaut.run.id` is the same `runId` found on log lines, lifecycle events and changelog records —
the join key between a trace and the database.

Every span and every metric point also carries `db.namespace` — the database name, in
OpenTelemetry's database convention — so one process migrating several databases (a kit per
tenant) produces series you can tell apart. Add your own low-cardinality dimensions with
`telemetry.attributes`:

```js
telemetry: {
  tracer: trace.getTracer('@alexify/migronaut'),
  meter: metrics.getMeter('@alexify/migronaut'),
  attributes: { tenant: 'acme', region: 'eu-west-1' }, // at most 20; scalars only
},
```

They go on every span and metric point; they cannot replace `db.namespace` or a `migronaut.*`
attribute.

### Metrics

| Instrument | Type | Recorded | Attributes |
|---|---|---|---|
| `migronaut.run.duration` | histogram, `s` | Every run that acquired the lock | `migronaut.run.command`, `migronaut.run.direction`, `error.type` |
| `migronaut.migration.duration` | histogram, `s` | Every migration executed | `migronaut.migration.direction`, `error.type` |
| `migronaut.lock.acquire.duration` | histogram, `s` | Every successful lock acquisition — the acquire round trip, not the wait before it | — |
| `migronaut.lock.wait.duration` | histogram, `s` | Every wait for a held lock (`runMigrations` with `onLockHeld: 'wait'`, a queue job) — one point per wait, however many polls | `migronaut.lock.wait.outcome`: `acquired`, `timeout` or `aborted` |
| `migronaut.lock.refused` | counter, `{refusal}` | A run refused because the lock was held — one per poll of a waiting caller | — |
| `migronaut.lock.lost` | counter, `{loss}` | A lock lost mid-run | — |

Every point also carries `db.namespace` and your `telemetry.attributes`.

Durations are in seconds, with bucket boundaries from 10 ms to an hour (an SDK's defaults are sized
for milliseconds and would put every migration in one bucket). `error.type` is present only on
failures — a point without it is a success. The migration's file name is deliberately not a metric
attribute — it would add a series per file; it is on the span.

::: info Names may still change
The span, attribute and metric names above are new in 2.1 and follow OpenTelemetry's conventions as
they stand. Treat them as experimental until a later release says otherwise — build dashboards on
them, but expect that a rename would be called out in the changelog.
:::

## Setting it up

migronaut needs nothing but the tracer and the meter. Everything else is your application's ordinary
OpenTelemetry setup, with two rules that matter here:

**Start the SDK before the MongoDB driver is loaded.** Instrumentations patch a module as it is
required, so the SDK has to come first — a `--require` preload is the usual way:

```js
// tracing.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { MongoDBInstrumentation } = require('@opentelemetry/instrumentation-mongodb');

const sdk = new NodeSDK({
  serviceName: 'my-app',
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [new MongoDBInstrumentation()],
});
sdk.start();

process.on('beforeExit', () => sdk.shutdown());
```

```bash
node --require ./tracing.js app.js
```

**Flush before the process exits.** Spans are exported in batches; a process that ends first loses
the last ones — usually the migration you most wanted to see. Call `sdk.shutdown()` on your shutdown
path.

### From the CLI

`telemetry` holds live objects, so it cannot come from a flag, an environment variable or a JSON
config — only from `migronaut.config.js` / `.ts`. Preload the SDK the same way:

```bash
NODE_OPTIONS="--require ./tracing.js" npx migronaut up
```

The CLI never calls `process.exit()` on its way out — it sets the exit code and lets the event loop
drain — so the `beforeExit` handler above runs and the batch is flushed.

### At application startup

```js
import { metrics, trace } from '@opentelemetry/api';
import { runMigrations } from '@alexify/migronaut';

await runMigrations(
  {
    uri: process.env.MONGO_URI,
    dbName: 'myapp',
    telemetry: {
      tracer: trace.getTracer('@alexify/migronaut'),
      meter: metrics.getMeter('@alexify/migronaut'),
    },
  },
  { onLockHeld: 'wait' },
);
```

When several instances boot together, the ones that lose the race for the lock poll for it. Those
attempts emit **no span** — a span per poll would bury the one run that did the work — so the wait
shows as a gap before `migronaut.run` in the surrounding span. It is measured instead:
`migronaut.lock.wait.duration` records each wait once, with how it ended (`acquired`, `timeout`,
`aborted`), `migronaut.lock.refused` goes up once per attempt, and `runMigrations` returns
`waitedMs`.

## Through a BullMQ queue

In a [migration service](/guide/bullmq) the request that enqueues and the worker that applies are
different processes. BullMQ carries the trace between them with its own telemetry object, from the
[`bullmq-otel`](https://docs.bullmq.io/guide/telemetry) package — pass it alongside the classes:

```js
const { metrics, trace } = require('@opentelemetry/api');
const { Queue, Worker, QueueEvents } = require('bullmq');
const { BullMQOtel } = require('bullmq-otel');
const { createMigrationQueue } = require('@alexify/migronaut/bullmq');

const mq = createMigrationQueue({
  config: {
    uri: process.env.MIGRONAUT_URI,
    dbName: 'my_app',
    // migronaut's own spans and metrics
    telemetry: {
      tracer: trace.getTracer('@alexify/migronaut'),
      meter: metrics.getMeter('@alexify/migronaut'),
    },
  },
  bullmq: {
    Queue,
    Worker,
    QueueEvents,
    // BullMQ's telemetry — goes to the Queue and the Worker
    telemetry: new BullMQOtel({ tracerName: 'my-service' }),
  },
  connection,
});
```

```
POST /migrations/up                 your HTTP instrumentation     ┐ the process
└─ addBulk migronaut                BullMQ, producer              ┘ that enqueues
   └─ process migronaut             BullMQ, consumer              ┐
      └─ migronaut.run                                            │ the worker
         └─ migronaut.migration                                   │
            └─ insert users         MongoDB instrumentation       ┘
```

The two `telemetry` options are different things, and you want both: `bullmq.telemetry` joins the
trace across Redis; `config.telemetry` adds the run and migration spans inside the worker.

A few things worth knowing:

- **Pass an options object to `BullMQOtel`.** `new BullMQOtel('name')` was the 1.x form; `bullmq-otel`
  2.x (the version BullMQ 6 needs) silently ignores a string.
- **Call `startWorker()` outside any span.** BullMQ's background work (lock renewal, stalled-job
  checks) inherits the context the worker was started in, and would otherwise pile up under it.
- **An injected `Queue` instance keeps its own telemetry.** `bullmq.telemetry` only reaches what
  migronaut constructs; with a ready-made Queue it applies to the Worker alone. To give the worker a
  different one, use `workerOptions.telemetry` or `startWorker({ telemetry })`.
- **Each scheduler tick is its own trace.** A [scheduled](/guide/bullmq) `sync` job does not join
  the trace that registered the schedule — one trace would otherwise grow for as long as the
  schedule lives. The migrations a tick enqueues hang under that tick.
- **A deduplicated enqueue has no consumer span of its own.** The second request for a migration
  that is already queued gets the existing job, which carries the first request's trace.

The [migration service example](https://github.com/Alexis-Technologies/migronaut/tree/main/examples/migration-service)
wires all of this up, with a Jaeger in its `docker-compose.yml`.

## What it guarantees

- **Telemetry never fails a run.** Every call into your tracer, span, meter and instruments is
  guarded: an exporter that is down, or an SDK that throws, costs you the telemetry and nothing
  else. A tracer that misbehaves — throws before or after running the work, or runs it twice —
  still gets each migration executed exactly once.
- **No credentials, and no quoted data, reach the backend.** A driver error can echo the connection
  string, and a duplicate-key error quotes the offending values (an email, say): the span's status
  message masks both — credentials as every log line does, `dup key: { … }` values on top, since a
  tracing backend is a third party — and is cut at 1 KB. No exception event is recorded, because it
  would carry the raw message and stack. Other text a server error may contain is passed on, so
  treat status messages as you would error logs.
- **No new dependency.** `@opentelemetry/api` is not a dependency of migronaut, nor a peer. The
  types are structural (`MigronautTracer`, `MigronautMeter`): a real `Tracer` and `Meter` satisfy
  them, and they resolve for users who never installed OpenTelemetry.

## What it does not do

- It does not start an SDK, pick an exporter or register an instrumentation — that stays yours.
- It does not trace `connect()`, `status`, `dry-run` or `audit`: only runs that take the lock.
- It does not propagate context itself; across a queue that is BullMQ's job (above).
- A migration that [times out](/guide/configuration) keeps running in the background — JavaScript
  cannot cancel it — so its driver spans may end after the migration's span did. They stay attached
  to it, with `error.type = MIGRATION_TIMEOUT` explaining why.
