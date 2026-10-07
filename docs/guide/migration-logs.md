# Migration Logs

A migration often has something to say to people other than the operator who ran it: how many
documents it changed, what it skipped and why, a summary that an internal tool shows its users
next to the run. Migronaut gives every migration a **logger bound to the run**, and an **event**
for the lines you mark as meant for your users. Keeping those lines — and showing them — is your
application's job: migronaut stores none of them.

::: warning Experimental
New in 2.4. The event's payload may still change in a minor release.
:::

## Logging from a migration

```js
// migrations/20261012090000-normalize-emails.js
export async function up({ db, logger, signal }) {
  logger.debug('scanning users'); // operational: your logs only

  let processed = 0;
  let skipped = 0;
  for await (const user of db.collection('users').find({ email: /[A-Z]/ })) {
    signal?.throwIfAborted();
    // …
    processed += 1;
  }

  // For your users: a log line AND a `migration:log` event.
  logger.info('emails normalized', { userland: true, processed, skipped });
}
```

- **`ctx.logger` is the kit's logger** — the [`logger`](/guide/configuration) you configured, pino
  included — with the run's correlation bound into the fields of every line: `runId`,
  `migration`, `direction`, `batch`, `attempt`, and `jobId` / `groupId` when a queue job runs it.
  Pino's own argument order, `logger.info({ … }, 'message')`, works too.
- **A call whose fields hold `userland: true`** — exactly `true` — is also emitted as the
  `migration:log` event. A call without the marker emits nothing, so operational noise stays in
  your logs. The marker stays on the log line, so a log pipeline can filter on it as well.
- The event fires whatever the logger's level, and with `logger: null` too.
- The [hooks](/guide/hooks) get a logger as well: `beforeAll`/`afterAll` the run's, the others
  the migration's.

In TypeScript, `logger` and `run` are optional on `MigrationContext` (a context built by hand in a
unit test still type-checks); migronaut always passes both.

## `ctx.run`

The same correlation as a frozen object, for a migration that needs it itself:

| Field | |
|---|---|
| `id` | The run id — the same on the lock, the changelog record and every event of the run |
| `direction` | `'up'` or `'down'` |
| `migration` | The file (absent in `beforeAll`/`afterAll`) |
| `batch` | The changelog batch (`up` only) |
| `attempt` | `1`, or more when a transaction was retried and the body runs again |
| `jobId`, `groupId` | The queue job running it — set by the [BullMQ adapter](/guide/bullmq), or the `job` option |
| `requestedBy`, `reason` | Who asked for the run, and why — when the caller said |

Driving the kit from a queue of your own, pass the job yourself: `kit.up(name, { job: { id,
groupId } })` — `down` and `redo` take it too. `id` is at most 1024 characters, `groupId` 128.

## The `migration:log` event

```js
kit.on('migration:log', (event) => {
  // { kind: 'migration', runId, migration, direction, batch, attempt, jobId?, groupId?,
  //   requestedBy?, reason?, level, msg, data, at, seq }
});
```

| Field | |
|---|---|
| `kind` | `'migration'` — or `'background'` for a [background migration](#background-migrations) |
| `runId`, `migration`, `direction`, `batch`, `attempt`, `jobId`, `groupId`, `requestedBy`, `reason` | As on `ctx.run` |
| `level` | `'debug'`, `'info'`, `'warn'` or `'error'` — the method you called |
| `msg` | The message — URI credentials and the values a server error quotes (an E11000's duplicate key) masked — at most 2048 characters |
| `data` | The fields without the marker, as a document your driver can store: a copy, its strings redacted — at most 8 levels and 1000 entries deep, strings at most 4096 characters. Dates, regular expressions, ObjectIds and other BSON values are kept as they are, and so is binary data up to 4096 bytes. An `Error` becomes `{ name, message, code?, codeName? }` (its message masked like `msg`, no stack); a `Map` an object, a `Set` an array; any other instance what `JSON.stringify` would see — its `toJSON()`, or its own fields |
| `at` | When the call was made (a `Date`, by this process's clock) |
| `seq` | Increasing within one `runId` — orders the events of one millisecond |
| `truncated` | `true` when `msg` or `data` was cut to those bounds |

## Keeping them

A collection of your own, and one listener:

```js
const logs = client.db('app').collection('migration_logs');
await logs.createIndexes([
  { key: { runId: 1, seq: 1 } }, // a run's lines, in order
  { key: { jobId: 1, seq: 1 } }, // a queue job's
  { key: { migration: 1, at: -1 } }, // a migration's history
  { key: { at: 1 }, expireAfterSeconds: 90 * 24 * 60 * 60 }, // and gone after 90 days
]);

kit.on('migration:log', (event) => {
  // Fire and forget: the migration never waits for its logs, and a failed
  // insert never fails it.
  logs.insertOne({ ...event }).catch((error) => console.error('migration log lost', error));
});
```

- **Keep the listener cheap.** It runs synchronously inside the migration — inside its transaction,
  for a transactional one. Do not `await` in it, and never pass the migration's session: a log
  written in the transaction would roll back with it.
- **Insert a copy** (`{ ...event }`): `insertOne` adds an `_id` to the object it is given, and the
  event is shared with every other listener.
- An `async` listener whose promise rejects is contained like one that throws — logged at debug
  level — but catching it yourself is the only way to hear about it.
- Read a run back with `logs.find({ runId }).sort({ seq: 1 })`.

**Where to subscribe** — in the process that runs the migrations, which is not always the one that
asked for them:

| Runs in | Subscribe with |
|---|---|
| Your code (`MigratorKit`) | `kit.on('migration:log', …)` before `up()` |
| `runMigrations` | `onKit: (kit) => kit.on('migration:log', …)` |
| A [BullMQ](/guide/bullmq) worker | `mq.kit.on(…)` in the worker process — or `processor.kit` with your own `Worker` |
| The CLI | Nowhere — the lines go to the CLI's log output; run migrations from code or a worker to keep them |

The [example service](https://github.com/Alexis-Technologies/migronaut/tree/main/examples/migration-service)
does exactly this: its worker stores the events, and its API serves a run's lines at
`GET /migrations/runs/:runId/logs`.

## What the events mean

- **They survive a rollback.** An event is not a write in the migration's session, so a migration
  that fails keeps the lines that explain why, while its own writes are rolled back. Show a run's
  outcome from `migration:error` or the changelog, not from its last line.
- **A retried transaction logs again.** When the driver retries a transient error, the body runs
  again and every call is made again — with `attempt: 2`. Show both, or keep the last attempt of
  each migration.
- **A timed-out body is not stopped.** If it logs after the run ended, the event still carries its
  own run's id, and its `seq` goes on — but it no longer reaches the queue job's log.
- **A dry run emits nothing.** Its lines say `dryRun: true`.
- **What you put in `data` is yours to store.** Migronaut masks credentials in URIs and the values
  a server error quotes, and nothing else: personal data in a log line lands in your collection as
  it is. The local log line is not masked — it is what a developer debugs with.

## On a queue

With the [BullMQ adapter](/guide/bullmq), every run is told which job it works for: its events
carry `jobId` and `groupId`, and its `userland: true` lines are also written into the **job's own
log**, next to the adapter's lifecycle rows — so a dashboard such as Bull Board shows them too:

```
🔒 Lock acquired (3ms)
▶ up 20261012090000-normalize-emails.js
✎ emails normalized {"processed":1200,"skipped":3}
✔ Applied 20261012090000-normalize-emails.js [842ms]
```

A row shows the level when it is not `info`, `(attempt N)` for a retried transaction, and is cut
at 1024 characters; a line break in the message shows as `⏎`, so a row is always one line. A job's
log takes up to [`userlandLogRows`](/guide/bullmq#the-facade-createmigrationqueue-options) of them
(1000 by default) — the rest are counted in one closing row, while the event still carries every
line. The job's `returnvalue.runId` (or `progress.runId` of a failed one) joins it to what you
stored.

## Background migrations

A [background migration](/guide/background-migrations)'s `ctx.logger` is bound to
`ctx.background` — the migration, its generation and partition, the lane's `runId` (the one its
`background:*` events carry), the lane's queue job and the transaction attempt — and a
`userland: true` call emits `migration:log` with `kind: 'background'`. On a queue, it lands in the
lane job's log.

::: tip Log per batch, not per document
`migrate` runs once per document — and again for a document a concurrent write moved. Log from
`migrateBatch`, from a `step`, or a summary, rather than from every document.
:::

## Why migronaut stores nothing

The lines are your users' data, and what to keep, for how long, and who may read it is your
application's decision — as is the UI that shows them. A collection of migronaut's own would grow
without bound and still need your API in front of it. So migronaut stops where only it can help:
it knows the run, the migration, the attempt and the job, and binds them to every line.
