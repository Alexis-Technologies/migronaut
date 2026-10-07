# Migration service example

`@alexify/migronaut` as a small service: migrations go into a BullMQ queue — **one migration per
job** — a worker applies them in order, and a plain `node:http` API enqueues, reports status and
rolls back. No framework: the same four calls drop into Fastify, Express, NestJS or a serverless
handler.

```
POST /migrations/up ──► BullMQ queue "migrations" ──► worker ──► MongoDB
                        (Redis: what was asked)      (lock + changelog: what is true)
```

| File                          | What it shows                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| [`mq.js`](mq.js)              | `createMigrationQueue(...)` — BullMQ is **injected**; migronaut never imports it    |
| [`server.js`](server.js)      | The HTTP routes, the worker, error → status mapping, graceful shutdown              |
| [`logs.js`](logs.js)          | What the migrations log for the service's users, kept in a collection of its own    |
| [`tracing.js`](tracing.js)    | Optional OpenTelemetry: one trace from the HTTP request to the MongoDB commands     |
| [`migrations/`](migrations)   | Two idempotent migrations (safe to re-run after a crash) and a background one       |
| [`collections/`](collections) | Declared indexes, a search index, a validator and versioning, applied by `converge` |

## Run it

```bash
docker compose up -d                 # MongoDB (Atlas local, with Search) + Redis
cp .env.example .env
pnpm install --ignore-workspace      # or: npm install
node server.js                       # ROLE=all: API and worker in one process
```

`--ignore-workspace` matters with pnpm: this folder sits inside the migronaut repository, whose
workspace root would otherwise be installed instead. Copying the example elsewhere? Replace
`"file:../.."` in `package.json` with a version.

## Try it

```bash
# What is pending?
curl -s localhost:3000/migrations/pending

# Enqueue everything pending and return at once (202 + the job ids)…
curl -s -X POST localhost:3000/migrations/up

# …or wait for the whole group — what a deploy hook wants
curl -s -X POST localhost:3000/migrations/up -H 'content-type: application/json' -d '{"wait":true}'

# One job: state, progress, result or failure reason
curl -s localhost:3000/migrations/jobs/1

# Status straight from MongoDB (the source of truth), plus the lock holder
curl -s localhost:3000/migrations/status

# Roll back the last batch — i.e. everything the last enqueue applied
curl -s -X POST localhost:3000/migrations/down -H 'content-type: application/json' -d '{"wait":true}'

# Declared indexes, search index and validator: every enqueue above already ends with a converge
# job (convergeAfterUp), and this runs one on its own — "wait" returns its result
curl -s -X POST localhost:3000/migrations/converge -H 'content-type: application/json' -d '{"wait":true}'

# The background migration (plans v1 → v2): registered by the first `up`, rewritten by the
# background worker beside the migration line
curl -s localhost:3000/migrations/background

# After it completed, write a plan in the old shape — the live drift watcher upgrades it at once
# (and this runs the periodic drift check now)
curl -s -X POST localhost:3000/migrations/background/verify

# What a run's migrations logged for this service's users — the runId is on the job's result
# (returnvalue.runId above); or by job id, which also collects a background lane's slices
curl -s localhost:3000/migrations/runs/<runId>/logs
curl -s localhost:3000/migrations/jobs/2/logs

# Keep the database migrated every 5 minutes
curl -s -X PUT localhost:3000/migrations/schedule -H 'content-type: application/json' -d '{"every":300000}'
curl -s -X DELETE localhost:3000/migrations/schedule
```

## Migration logs for the service's users

A migration says what it did with `logger.info(…, { userland: true })` — the seed migration logs
how many plans it inserted. Migronaut binds the run, the migration, the transaction attempt and the
queue job to the line, writes it into the job's own log (`✎ plans seeded {…}`, visible in Bull
Board), and emits it as `migration:log` in the worker's process. Storing it is the service's job:
[`logs.js`](logs.js) writes every event into `migration_logs` (in batches, from a bounded buffer —
the migration never waits for its logs; indexed by run, job and migration, expired after 90 days),
and the API serves them:

```json
GET /migrations/runs/<runId>/logs
{
  "runId": "…",
  "logs": [
    {
      "kind": "migration", "runId": "…", "direction": "up", "jobId": "2", "groupId": "…",
      "migration": "20260102000000-seed-plans.js", "batch": 1, "attempt": 1,
      "level": "info", "msg": "plans seeded", "data": { "plans": 2, "inserted": 2 },
      "at": "…", "seq": 1
    }
  ]
}
```

The lines survive a rollback of the migration that logged them, and a transaction the driver
retried logs once per `attempt`. See [Migration Logs](https://migronaut.vercel.app/guide/migration-logs).

Like every route of this example, the log routes have no authentication — put your own in front of
the API before it serves anyone. What a migration logs for users can hold their data: migronaut
masks credentials in URIs and the values a server error quotes, and nothing else.

## Running it as separate roles

```bash
ROLE=api node server.js       # enqueues and reports — needs no Worker
ROLE=worker node server.js    # applies the jobs — needs no HTTP port
```

Run as many of each as you like. Migrations still apply one at a time, in order: the queue is set
to a global concurrency of 1, and — whatever Redis says — every job re-checks the order against
the MongoDB changelog and takes the MongoDB lock, so a `migronaut up` from the CLI at the same
moment is safe too.

## Tracing it

Set one variable and every enqueue becomes a trace you can open in Jaeger
(<http://127.0.0.1:16686>, started by `docker compose up -d`):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 node server.js
curl -s -X POST localhost:3000/migrations/up -H 'content-type: application/json' -d '{"wait":true}'
```

```
POST /migrations/up                 HTTP instrumentation
└─ addBulk migrations               BullMQ (producer)          ── the API process
   └─ process migrations            BullMQ (consumer)          ── the worker process
      └─ migronaut.run              migronaut: lock held, run id, what was applied
         └─ migronaut.migration     migronaut: one per migration, with its name and batch
            ├─ createIndexes users  MongoDB instrumentation: the migration's own commands
            └─ update _migronaut_migrations                    … and its changelog record
```

Three things make that one trace, and all three are in this folder:

- [`tracing.js`](tracing.js) starts the SDK **before** `node:http` and the MongoDB driver are
  loaded — the instrumentations patch those modules on load.
- [`mq.js`](mq.js) passes `bullmq.telemetry` (BullMQ's own, from `bullmq-otel`), which carries the
  trace across Redis from the process that enqueues to the one that applies.
- [`mq.js`](mq.js) passes `config.telemetry` (a tracer from `@opentelemetry/api`), which makes each
  migration a span that is _active_ while it runs — so the driver's command spans land under it.

Run the roles separately (`ROLE=api`, `ROLE=worker`) and the trace still joins up: the two halves
show as two services in Jaeger. With no endpoint set, nothing is loaded and nothing is traced.

Guide: <https://migronaut.vercel.app/guide/opentelemetry>

## Before you deploy something like this

- **Authenticate it.** These endpoints can roll your database back. The example has no auth on
  purpose (it is an example) and listens on `127.0.0.1` unless `HOST` says otherwise; put it
  behind your gateway, a network policy, or your own middleware before you widen that.
- **Decide what a job may ask for.** The example's worker allows `force` and `ordered: false`
  because its API offers them (`allow` in `mq.js`). A service that does not offer them should leave
  them off — the default — so a job planted in Redis cannot ask for them either.
- **Give the worker time to finish.** On `SIGTERM` the service stops taking the lock and lets the
  migration in flight complete. In Kubernetes, set `terminationGracePeriodSeconds` above your
  longest migration, or the pod is killed mid-migration and BullMQ re-runs the job elsewhere.
- **Write migrations that can be re-run.** A worker that dies mid-migration leaves the job to be
  picked up again — at-least-once, like any queue. Both example migrations are idempotent.
- **A fix is a redeploy.** A long-lived worker has already loaded the migration files; a corrected
  file is picked up by a new process (or set `reloadMigrations: true` in the config).
- **Redis must not evict keys** (`maxmemory-policy noeviction`) — a BullMQ requirement.

Full guide: <https://migronaut.vercel.app/guide/bullmq>
