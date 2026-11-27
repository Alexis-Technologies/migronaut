# src/bullmq — the queue adapter (`@alexify/migronaut/bullmq`)

Migrations as BullMQ jobs, one migration per job, and since 2.3 background migrations on a queue
of their own. `jobs.js` is the contract (names, payloads, options), `producer.js` enqueues,
`processor.js` and `background-processor.js` run jobs, `wait.js` waits for a group, and
`service.js` (`MigrationQueue`) is the facade.

## BullMQ is injected, never required

- The caller hands in its classes or ready instances: `createMigrationQueue({ bullmq: { Queue,
  Worker, QueueEvents, telemetry } })`. Nothing here may `require('bullmq')` or `ioredis` (a unit
  test greps for it), and `bullmq.d.ts` describes them structurally (`BullMQQueueLike`, …).
  `bullmq.Queue` and `bullmq.QueueEvents` may each be the class or an instance: the constructor
  splits them at once into `QueueClass` / `queueInstance`, and nothing after it holds both kinds.
  BullMQ's own `telemetry` object is passed through untouched.
- The adapter is a second orchestration layer _above_ the kit: it may require `core/migrator.js`,
  `core/lock-wait.js`, `utils/` and `errors/`, never a mechanism module (`lock`, `changelog`,
  `runner`, anything under `core/background/`) and never the database. What it needs and the kit
  does not offer becomes a small public kit option (`up({ batch, ordered })`, `nextBatch()`,
  `coordinateBackground()`, `driftMode()` came from there).
- Listeners it puts on a Queue or a QueueEvents it was handed come off when it closes (`#listen`).

## Jobs

- Migration jobs are forced to `attempts: 1`: a BullMQ retry re-queues behind the waiting jobs and
  would break the order. A job behind a failed migration fails as `ALX_ERR_MIGRATION_BLOCKED`
  instead of waiting; an already-applied migration's job _completes_ as `skipped`.
- Errors are told by their `code`, never `instanceof` (a kit from another copy of the package).
  `RETRYABLE_CODES` (`processor.js`) lists the codes a retry can fix; a non-retryable one is
  renamed `UnrecoverableError` only when a job has `attempts > 1` (BullMQ matches the name — the
  adapter cannot import the class). A failure that is not migronaut's reports
  `code: 'ALX_ERR_UNKNOWN'`. **Kept on purpose (error-handling, "do not retry bugs"):** an unknown
  code stays retryable; it matters only where a job has `attempts > 1`.
- The scheduled `sync` job template carries `telemetry: { omitContext: true }`, without which
  every scheduler tick joins one endless trace. A tick that waits for a background migration
  reports `waiting`, never `held`; a tick's held converge is `convergeHeld` (`converge` stays the
  job that was added), held until the plan's `fingerprint` changes, not for a time.
- An option nobody reads is **warned about, not refused**, on the queue's entry points
  (`enqueueBackground` refuses, as before). `allow` checks its keys with `Object.hasOwn`.
- `schedule({ every })` destructures a public option, not `Array#every` — the one
  `no-restricted-properties` disable directive here.

## Userland log rows

- The processors route `migration:log` rows by **job id and run id**, never by `current` alone,
  mirror at most `userlandLogRows` per job (a lane: per slice) and seal a job before its last
  flush. A job settles without its log rows after 5 s (`JOB_WRITE_WAIT_MS`).
- Lanes an `up` drives inline (`backgroundInline`) carry the run's `jobId` **and `groupId`** — the
  group tells them from a background queue's lanes, whose ids may repeat a migration job's — but
  no parent run id.

## The background queue

- A lane _completes_ for every outcome the kit recorded (its coordinator decides from MongoDB).
  Lanes carry `ignoreDependencyOnFailure` (the other three failure policies strand or wake the
  coordinator wrongly) and get a new job id per spawn (BullMQ will not move a job to another
  parent).

## Closing

- `close()` waits for the job in flight; `close({ timeoutMs })` leaves one still running to end
  on its own; `close({ force: true })` on top of a `close()` under way only stops waiting.
  `MigrationQueue.close()` rethrows the first failure and says each later one at `warn`.
- A closed queue is `ALX_ERR_QUEUE_CLOSED`.

## Kept on purpose here

- `MigrationProcessor` is a callable with properties, not a plain function or a class: BullMQ
  requires a function processor (`bullmq.d.ts`).
- The processor bridges a job's abort (its own signal and the shutdown) to `kit.stop()` for the
  whole job, rather than passing `{ signal }` to each call: one job makes several kit calls (the
  lock wait, the run, a converge), and a migration body already executing finishes either way.
- `String(value)` for what BullMQ or Redis threw (`wait.js`): it may be a symbol.

## Testing

The adapter's coverage comes from `tests/helpers/fake-bullmq.js` — see
[tests/CLAUDE.md](../../tests/CLAUDE.md). After changing this folder or the background queue, run
the real one: `pnpm run test:optin redis`.
