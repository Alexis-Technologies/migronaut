# Migrations as a Queue (BullMQ)

`@alexify/migronaut/bullmq` turns migronaut into a **migration service**: pending migrations are
enqueued on a [BullMQ](https://docs.bullmq.io/) queue — **one migration per job** — and a worker
applies them in order. Enqueue from an HTTP handler, an admin panel, a deploy hook or a schedule;
watch progress in any BullMQ dashboard; roll back the same way.

It is opt-in, lives under its own entry point, and adds no dependency: **BullMQ is injected by you**
— migronaut never imports it.

```js
const { Queue, Worker, QueueEvents } = require('bullmq');
const { createMigrationQueue } = require('@alexify/migronaut/bullmq');

const mq = createMigrationQueue({
  config: { uri: process.env.MIGRONAUT_URI, dbName: 'my_app' },
  bullmq: { Queue, Worker, QueueEvents }, // your install, your version
  connection: { host: 'redis', port: 6379 },
});

await mq.startWorker(); // in the process that applies migrations

const group = await mq.enqueueUp(); // one job per pending migration
const { results } = await group.wait(); // optional: block until they all finished
```

::: tip When to reach for this — and when not
Use it when migrations should be **triggered and observed as a service**: a migration microservice,
an operator button, a schedule that keeps the database migrated, a deploy pipeline that enqueues
and waits.

If you only need "apply what is pending when the app boots", [`runMigrations`](/guide/api) is
simpler and needs no Redis.
:::

## Install

```bash
npm install @alexify/migronaut mongodb bullmq ioredis
```

`bullmq` and `ioredis` are **your** dependencies, not migronaut's — there is nothing to keep in
sync, and BullMQ Pro or a pinned version work the same way.

Tested against **BullMQ 6**. The BullMQ features it relies on are older — job deduplication
(5.17), job schedulers for `schedule()` (5.16), global concurrency (5.9, used when present) and
the processor's cancellation signal (5.64) — but 5.x is not part of migronaut's test suite.

## How it fits together

```
enqueueUp() ──► Redis (BullMQ queue) ──► worker ──► MongoDB
  plan            what was asked           one job      lock + changelog:
  + batch                                  at a time    what is true
```

Three rules explain every behaviour on this page:

1. **Redis holds intent; MongoDB holds truth.** A job says "apply `0003-x.js`". Whether it may run,
   and whether it already ran, is decided from the changelog at the moment the job executes — never
   from what the queue remembers.
2. **Every job is a normal single-file run** — `kit.up(name)` / `kit.down(name)` under the same
   [MongoDB lock](/guide/concepts) the CLI takes. A `migronaut up` running at the same time is safe:
   one waits for the other.
3. **Order is enforced, not assumed.** A job refuses to run while an earlier migration is still
   pending, so a failed migration stops everything behind it.

## The facade: `createMigrationQueue(options)`

| Option | | |
|---|---|---|
| `bullmq` | **required** | `{ Queue, Worker?, QueueEvents?, telemetry? }` — classes from your `bullmq`, or instances you already have. `Worker` is needed by `startWorker()`, `QueueEvents` by `wait()`. `telemetry` is BullMQ's own telemetry object (`new BullMQOtel(…)`), handed to the Queue and the Worker — see [OpenTelemetry](/guide/opentelemetry#through-a-bullmq-queue) |
| `connection` | required with classes | BullMQ's `connection` (options or your Redis client). Passed through untouched, **never closed** |
| `config` | | Migronaut config for the kit the queue creates. Omit to resolve from `migronaut.config.*` / `MIGRONAUT_*`. Its [`generateId`](/guide/configuration#custom-id-format), if set, is also what mints group ids |
| `kit` | | A `MigratorKit` you own, instead of `config` — never disconnected by `close()` |
| `kitOptions` | | `MigratorKit` options (`cwd`, `configPath`, …) |
| `queueName` | `'migronaut'` | **One queue per database** |
| `prefix` | | BullMQ key prefix |
| `jobOptions` | | Passed to every job: `removeOnComplete`, `removeOnFail`, `keepLogs`, … Options that reorder or retry jobs are rejected |
| `workerOptions` | | Defaults for `startWorker()`: `lockDuration` (default 60000), `maxStalledCount` (1), `stalledInterval`, … |
| `globalConcurrency` | `true` | Set the queue's global concurrency to 1 when the worker starts |
| `allow` | | `{ down: true, force: false, unordered: false }` — what a job may ask for beyond applying what is pending in order. See [Security](#security) |
| `lockWait` | | `{ onLockHeld: 'wait' \| 'throw', lockWaitTimeoutMs, lockPollIntervalMs: 500 }` — how a job behaves when the MongoDB lock is held. The timeout defaults to 90 s or 1.5× the holder's lock TTL, whichever is longer; polls back off up to 5 s |

| Method | Returns | |
|---|---|---|
| `enqueueUp(filename?, { to?, force?, ordered?, requestedBy?, reason? })` | `MigrationGroup` | All pending, pending up to `to`, or one file |
| `enqueueDown(filename?, { steps?, batch?, to?, ordered? })` | `MigrationGroup` | Last batch (default), a batch, the last N, back to `to`, or one file |
| `startWorker(options?)` | your `Worker` | Connects to MongoDB, then starts a concurrency-1 worker |
| `status()` / `pending()` / `audit()` / `lockInfo()` | | Read straight from MongoDB — same as the [kit methods](/guide/api) |
| `getJob(id)` | `MigrationJobView \| null` | A job as plain, redacted data — safe to return from an API |
| `pause()` / `resume()` | | Stop / resume picking up jobs; the one in flight finishes |
| `schedule({ every \| pattern, tz?, to?, id? })` / `unschedule(id?)` | | Keep the database migrated on a schedule |
| `close({ force? })` | | Graceful shutdown |
| `kit`, `queue`, `worker`, `queueEvents`, `processor`, `queueName` | | The parts, when you need them |

### The group handle

`enqueueUp` / `enqueueDown` return what was enqueued:

```js
{
  groupId: '3f0c…',          // this enqueue call — a UUID, or your `generateId` format
  direction: 'up',
  batch: 7,                  // the batch every job of the group will stamp
  upToDate: false,           // true → nothing to do, no job added
  jobs: [{ id: '41', migration: '0007-a.js', index: 0 }, …],
  deduplicated: [],          // files a peer had already queued
  wait: ({ timeoutMs? }) => Promise<{ groupId, direction, batch, results }>,
}
```

`wait()` resolves when every job has finished, or rejects with a `QueueJobFailedError` at the first
one that fails or outlives `timeoutMs` (one budget for the whole call, connecting included) —
`error.context` carries `migration`, `jobId`, `failedReason`, `timedOut`, the job's own typed
`code` (`MIGRATION_BLOCKED`, `CHECKSUM_MISMATCH`, …) and the `results` that finished before it.

## Ordering and failure

**One attempt per job.** A BullMQ retry re-queues a job *behind* the jobs already waiting, so the
migrations after it would run first. Migration jobs therefore always get `attempts: 1`; the one
transient condition worth retrying — the MongoDB lock being held — is waited out *inside* the job.

**A failure stops the line.** With `0001`, `0002`, `0003` enqueued and `0002` throwing:

| Job | Outcome |
|---|---|
| `0001` | completed — applied |
| `0002` | failed — `MIGRATION_EXECUTION_FAILED`, with the cause in `failedReason` |
| `0003` | failed — `MIGRATION_BLOCKED`: it never ran, because `0002` is still pending |

A job blocked by an earlier migration that has **not** failed — no `'failed'` trace in the
changelog — waits for it instead, within its `lockWait` budget: with several workers taking jobs,
the earlier one may simply still be in flight elsewhere. Only a block that outlasts the budget
fails the job. A block by a migration that did fail stops the line at once, as above.

Nothing is left half-ordered. Fix the migration, deploy, and call `enqueueUp()` again: it plans what
is still pending (`0002`, `0003`) as a new group.

**Duplicates are harmless.** Two instances enqueuing at boot produce one set of jobs: the second
call is deduplicated (`group.deduplicated` lists the files, and its `jobs` point at the first
call's jobs, so both can `wait()`). A job that finds its migration already applied completes with
`status: 'skipped'`.

**Which failures could be retried.** If you enqueue jobs yourself with `attempts > 1`, the processor
tells BullMQ not to retry what cannot succeed without a fix (a blocked, failed, invalid or drifted
migration), and leaves the transient ones retryable: `LOCK_ALREADY_HELD`, `LOCK_LOST`,
`LOCK_RELEASE_FAILED`, `RUN_ABORTED`, `CONNECTION_FAILED` (`RETRYABLE_CODES`).

**Opting out.** `enqueueUp(file, { ordered: false })` gives the CLI's plain single-file `up`, with
no order guard — for the rare deliberate out-of-sequence apply.

## Batches and rollback

Every job of one `enqueueUp()` call stamps the **same batch**, exactly like a normal `up` — so
"roll back the last deploy" still works:

```js
const down = await mq.enqueueDown(); // the last batch, newest applied first
await down.wait();

await mq.enqueueDown(undefined, { steps: 1 }); // just the newest migration
await mq.enqueueDown(undefined, { to: '0004-x.js' }); // everything applied after it
```

A rollback must be the **top of the applied stack**: `enqueueDown('0001-a.js')` while later
migrations are still applied is refused up front with `MigrationBlockedError`, and each rollback
job re-checks it. "Later" means *applied later* (by `appliedAt`), which is the order effects must
be undone in.

::: details Where this differs from the CLI
The CLI's `down --to X` and `down --batch N` select by name and batch and do not check what was
applied afterwards. The queue's ordered rollback does. Pass `{ ordered: false }` to get the CLI
behaviour.
:::

## Scheduling

```js
await mq.schedule({ every: 5 * 60_000 }); // or { pattern: '0 3 * * *', tz: 'UTC' }
await mq.unschedule();
```

Each tick enqueues a `sync` job that plans whatever is pending and enqueues it — the queue keeps
the database caught up with the migration files. Idempotent, so every instance can call it at
boot. Ticks carry the queue's `jobOptions`; when those set no retention, a tick keeps the last 100
completed and 500 failed jobs (`removeOnComplete: { count: 100 }`, `removeOnFail: { count: 500 }`)
— a schedule mints a job per tick forever, and BullMQ keeps every finished job by default.
After a failure, the schedule **holds the line**: a tick whose next migration failed, and whose
file is still the version that failed, enqueues nothing and reports it (`returnvalue.held`, and a
warning) instead of re-running a migration that may have half-applied its changes on every tick.
Deploy a fix — a changed file — and the next tick enqueues it again; `enqueueUp(name)` asks for it
explicitly whenever you decide a retry is right.

## Converge jobs

[Declared collections](/guide/collections) converge as a job too — one job, under the MongoDB
lock, applied by the same worker:

```js
const handle = await mq.enqueueConverge();
const result = await handle.wait(); // { changed, inSync, collections, … }
```

**At the end of every deploy.** With `convergeAfterUp: true` in the kit's config, `enqueueUp`
ends every group that reaches the newest migration with a converge job — the kit's own after-up
hook never fires in a queue, since each job is a single-file run. `enqueueUp(undefined, {
converge })` decides per call.

- The converge job runs after the group's last migration, and **refuses** (`MIGRATION_BLOCKED`)
  while any migration is still pending — so a failed migration stops it too, and a peer still
  applying the last migration is waited out under the lock rather than raced.
- `group.converge` is `{ id, deduplicated }`, and `group.wait()` resolves with
  `converge: ConvergeJobResult` after the migration results.
- With **nothing pending**, `enqueueUp` adds a converge-only job when a dry run finds the database
  out of step (and nothing at all when it is in step); `upToDate` stays `true`.
- Its deduplication id is keyed on the group's last migration: two pods enqueueing the same deploy
  share one converge job, while a newer, longer deploy gets its own at its own tail.
- A `sync` tick does the same: pending migrations are enqueued with their converge job; with
  nothing pending, one dry run decides whether a converge job is needed — so a deploy that only
  changed a definition converges on the next tick, and an idle tick takes no lock.

**On its own schedule.** Index builds often belong at night, not on every sync tick:

```js
await mq.schedule({ job: 'converge', pattern: '0 3 * * *', tz: 'UTC' }); // id 'migronaut-converge'
await mq.unschedule(DEFAULT_CONVERGE_SCHEDULER_ID);
```

A converge job is `{ v: 1, kind: 'converge', groupId?, ordered? }` — deliberately **without
`prune`**: what may be dropped is decided by the definitions the worker loads (`prune: true` in a
definition), never by a payload sitting in Redis. A failed converge job is not retried; with a
schedule or `convergeAfterUp`, the next tick or deploy tries again.

::: warning Roll the workers first
A worker running old code converges to the old definitions — with `prune`, it can drop an index the
new deploy just declared. Deploy the workers before you rely on a changed definition.
:::

## Enqueue and wait: deploy hooks and CI

```js
const { EXIT_CODES, MigronautError } = require('@alexify/migronaut');

try {
  const group = await mq.enqueueUp();
  const { results } = await group.wait({ timeoutMs: 10 * 60_000 });
  console.log(`applied ${results.filter((r) => r.status === 'applied').length} migration(s)`);
} catch (error) {
  console.error(error.message, error.context);
  process.exitCode = error instanceof MigronautError ? (EXIT_CODES[error.code] ?? 1) : 1;
} finally {
  await mq.close();
}
```

`wait()` reads finished jobs from the queue, so they must still be there: do not combine it with
`removeOnComplete: true`.

## Your own Worker: NestJS, BullMQ Pro, a shared worker

`createMigrationProcessor()` is the function a Worker runs, without the facade:

```js
const { Worker } = require('bullmq');
const { createMigrationProcessor } = require('@alexify/migronaut/bullmq');

const processor = createMigrationProcessor({ config, queue }); // `queue` only for sync jobs
const worker = new Worker('migronaut', processor, { connection, concurrency: 1 });

// on shutdown — stop fetching first, then stop the processor, together:
const closing = worker.close();
processor.shutdown();
await closing;
await processor.close();
```

Close the Worker first (or together with `shutdown()`, as above): a job that had not started its
migration when the processor shut down is moved back to the head of the queue, and a Worker that
is still fetching would take it straight back.

In NestJS, call it from your `WorkerHost`:

```ts
@Processor('migronaut', { concurrency: 1 })
export class MigrationsProcessor extends WorkerHost {
  private readonly run = createMigrationProcessor({ config });

  process(job: Job, token?: string, signal?: AbortSignal) {
    return this.run(job, token, signal);
  }
}
```

The producer side has the same split: `enqueueUp(queue, kit, options)`,
`enqueueDown(queue, kit, options)`, `enqueueConverge(queue, kit, options)`, `planUpJobs(kit,
options)` and `waitForGroup(...)` work on a `Queue` you own.

::: warning Run it with `concurrency: 1`
The processor serializes jobs inside one process whatever the Worker's concurrency, and the MongoDB
lock serializes processes — so a higher number never corrupts anything, it only makes jobs queue up
on the lock. One is the honest setting.
:::

## Observing

- **Job progress** (`job.progress`): `{ phase: 'lock-wait' | 'running' | 'completed' | 'failed', migration, direction, groupId, index, total, code?, runId? }` — `code` is the typed error code of a failed job (`'UNKNOWN'` for one that is not migronaut's), and `runId` the run's correlation id: the join key to the changelog record and the kit's log lines. A failed job has no return value, so its `runId` is found here and on the error's `context`. A `sync` or `converge` job reports `{ phase, kind }` instead of the migration fields.
- **Job logs** (`job.log`): lock acquisition, start, applied / reverted / skipped, every converge step (as it starts, and as it ends), and the failure line with its run id.
- **Kit events**: `mq.kit.on('migration:success', …)` — the same [lifecycle events](/guide/api) as everywhere else.
- **Worker events**: `mq.worker.on('failed', …)`.
- **Traces**: pass `bullmq.telemetry` and the kit's `telemetry` option, and one trace runs from the
  request that enqueued, through Redis, to the MongoDB commands the migration issued — see
  [OpenTelemetry](/guide/opentelemetry#through-a-bullmq-queue).

## Graceful shutdown

```js
process.on('SIGTERM', async () => {
  await mq.close(); // stop taking the lock, let the migration in flight finish, close what it created
  await redis.quit(); // the connection is yours
  process.exit(0);
});
```

`close()` never interrupts a migration body — that is what leaves a database half-migrated. It
waits. A job that had **not started** its migration yet — waiting for the lock, or just fetched —
is not failed: it is moved back to the **head** of the queue (BullMQ's `moveToWait`), so the
next worker runs it and the jobs behind it are not blocked. Rolling deploys therefore no longer
end the enqueue they interrupt. So:

- **Kubernetes:** set `terminationGracePeriodSeconds` above your longest migration. A pod killed
  mid-migration leaves the job to BullMQ's stall recovery: after `lockDuration` it is handed to
  another worker and **run again**.
- **Migrations should be re-runnable.** That is the at-least-once contract of any queue, and the
  same contract `useTransaction` retries already imply. Long migrations can watch `ctx.signal`,
  which fires on shutdown and on `worker.cancelJob(id)`.
- **A fix is a redeploy.** A long-lived worker has already loaded the migration files; a corrected
  file is picked up by a new process (or set `reloadMigrations: true`).

## Security

- **Job data is untrusted input.** It sat in Redis. The worker validates every job against the
  contract before touching anything: unknown job names, data versions it does not support and
  fields outside the contract are rejected, and the migration name must be a bare filename that
  belongs to the migration sequence — a job can make the worker run a migration that *exists in
  its migrations directory*, never an arbitrary path, a dotfile or a helper module next to the
  migrations. Invalid jobs fail with `QueueJobInvalidError`.
- **No decisions in jobs.** A converge job cannot ask for `prune` — what may be dropped comes from
  the worker's own definitions.
- **Permissions beyond the ordinary are opt-in.** A job can only *ask*; the worker decides with
  `allow`. By default it runs rollbacks but refuses `force` (re-running an applied migration) and
  `ordered: false` (skipping the order guard) — a job asking for either fails as
  `QUEUE_JOB_INVALID` before anything runs. `allow: { force: true, unordered: true }` turns them
  on; `allow: { down: false }` makes a worker that never rolls back. The facade applies the same
  policy to its own `enqueue*` calls, so give producers and workers the same `allow`.
- **No secrets in jobs.** A job carries a filename, a group id and a batch number. The connection
  string stays in the worker's configuration.
- **What the queue stores is redacted.** `failedReason`, stack traces, job logs and `getJob()`
  output pass through the same credential redaction as migronaut's logs, and the values a
  duplicate-key error quotes (`dup key: { <redacted> }`) are masked too — a queue keeps failed
  jobs and serves them to dashboards.
- **The API in front of it is yours to protect.** Whoever can enqueue can roll back.

## Who asked, and why

A worker runs as the container's OS user — that is the changelog's `executedBy`. Say who actually
asked, and why, when you enqueue: `enqueueUp(undefined, { requestedBy: user.email, reason:
'release 42' })` (also `enqueueDown` and `enqueueConverge`). The jobs carry both, and they are
stamped on the changelog records (`requestedBy`, `reason`; `revertRequestedBy`, `revertReason` for
a rollback) and on the [converge history](/guide/collections#history).

## Upgrading: the job contract

Jobs are versioned (`data.v`). A worker accepts every version from `MIN_JOB_DATA_VERSION` up to
its own, so jobs already in the queue survive an upgrade of the workers; it refuses a newer
version, and any field it does not know, as `QueueJobInvalidError` — a meaning it cannot honour is
never dropped silently. So: **roll the workers out before the producers** (the processes that
enqueue). A migration file is part of the same rule. An `up` job carries the checksum of the file
its plan saw: a worker that does not have the file yet fails the job with
`MIGRATION_FILE_NOT_FOUND`, and one that has *another version* of it — an edited pending file —
fails it with `CHECKSUM_MISMATCH` (`context.planned: true`) instead of applying the wrong one. Enqueue
again once every worker runs the new deploy.

## TypeScript

The subpath ships its own declarations (`bullmq.d.ts`). They describe BullMQ **structurally**
(`BullMQQueueLike`, …) instead of importing it, so they compile whether or not bullmq is installed.
The factory is generic over what you inject:

```ts
import { Queue, Worker, QueueEvents } from 'bullmq';
import { createMigrationQueue } from '@alexify/migronaut/bullmq';

// Name the instance types to get BullMQ's own defaults on mq.queue / mq.worker
const mq = createMigrationQueue<Queue, Worker, QueueEvents>({
  bullmq: { Queue, Worker, QueueEvents },
  connection,
  config,
});

mq.queue.getJobCounts(); // your Queue, not a stand-in
```

Errors (`MigrationBlockedError`, `QueueJobInvalidError`, `QueueJobFailedError`) are exported from
the package root, like every other [error class](/reference/error-codes).

## FAQ

**Can I run several workers?** Yes. They take turns (global concurrency 1), and even without that
the MongoDB lock and the order guard keep the sequence: a job that gets to the lock before an
earlier one still in flight on another worker waits for it rather than failing.

**Several databases?** One `createMigrationQueue` per database, each with its own `queueName`.

**What if Redis loses the queue?** Nothing is lost that matters: the changelog still says what is
applied. Enqueue again — only what is pending is planned.

**Does the CLI still work?** Yes, alongside the worker. They share the lock and the changelog.

**Why are `beforeAll` / `afterAll` hooks firing per migration?** Each job is its own run, so
run-level [hooks](/guide/hooks) fire once per job. `beforeEach` / `afterEach` behave as usual.

## Next

- A complete, runnable service: [`examples/migration-service`](https://github.com/Alexis-Technologies/migronaut/tree/main/examples/migration-service)
- [Programmatic API](/guide/api) — `MigratorKit`, `nextBatch()`, the `batch` / `ordered` options the queue is built on
- [Error Codes](/reference/error-codes)
