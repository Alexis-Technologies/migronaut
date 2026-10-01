# Migration service example

`@alexify/migronaut` as a small service: migrations go into a BullMQ queue — **one migration per
job** — a worker applies them in order, and a plain `node:http` API enqueues, reports status and
rolls back. No framework: the same four calls drop into Fastify, Express, NestJS or a serverless
handler.

```
POST /migrations/up ──► BullMQ queue "migrations" ──► worker ──► MongoDB
                        (Redis: what was asked)      (lock + changelog: what is true)
```

| File                        | What it shows                                                                    |
| --------------------------- | -------------------------------------------------------------------------------- |
| [`mq.js`](mq.js)            | `createMigrationQueue(...)` — BullMQ is **injected**; migronaut never imports it |
| [`server.js`](server.js)    | The HTTP routes, the worker, error → status mapping, graceful shutdown           |
| [`migrations/`](migrations) | Two idempotent migrations (safe to re-run after a crash)                         |

## Run it

```bash
docker compose up -d                 # MongoDB + Redis
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

# Keep the database migrated every 5 minutes
curl -s -X PUT localhost:3000/migrations/schedule -H 'content-type: application/json' -d '{"every":300000}'
curl -s -X DELETE localhost:3000/migrations/schedule
```

## Running it as separate roles

```bash
ROLE=api node server.js       # enqueues and reports — needs no Worker
ROLE=worker node server.js    # applies the jobs — needs no HTTP port
```

Run as many of each as you like. Migrations still apply one at a time, in order: the queue is set
to a global concurrency of 1, and — whatever Redis says — every job re-checks the order against
the MongoDB changelog and takes the MongoDB lock, so a `migronaut up` from the CLI at the same
moment is safe too.

## Before you deploy something like this

- **Authenticate it.** These endpoints can roll your database back. The example has no auth on
  purpose (it is an example); put it behind your gateway, a network policy, or your own middleware.
- **Give the worker time to finish.** On `SIGTERM` the service stops taking the lock and lets the
  migration in flight complete. In Kubernetes, set `terminationGracePeriodSeconds` above your
  longest migration, or the pod is killed mid-migration and BullMQ re-runs the job elsewhere.
- **Write migrations that can be re-run.** A worker that dies mid-migration leaves the job to be
  picked up again — at-least-once, like any queue. Both example migrations are idempotent.
- **A fix is a redeploy.** A long-lived worker has already loaded the migration files; a corrected
  file is picked up by a new process (or set `reloadMigrations: true` in the config).
- **Redis must not evict keys** (`maxmemory-policy noeviction`) — a BullMQ requirement.

Full guide: <https://migronaut.vercel.app/guide/bullmq>
