# Programmatic API

Everything the `migronaut` CLI does is available programmatically through the `MigratorKit` class — useful
for running migrations from app startup, a deploy script, or tests.

```ts
import { MigratorKit } from '@alexify/migronaut';

const migrator = new MigratorKit({
  uri: 'mongodb://localhost:27017',
  dbName: 'my_app',
  migrationsDir: './migrations',
});

await migrator.connect();
const results = await migrator.up();
await migrator.disconnect();

console.log(results); // → RunResult[]
```

::: tip Need migrations as background jobs?
[Migrations as a Queue](/guide/bullmq) runs each migration as a BullMQ job — a migration service
you trigger over HTTP, on a schedule, or from a deploy hook.
:::

## `new MigratorKit(config?, options?)`

```ts
constructor(config?: Partial<MigronautConfig>, options?: MigratorKitOptions)
```

- `config` — any subset of [`MigronautConfig`](/guide/configuration#all-options). Anything omitted falls
  back to env vars, a config file, then defaults — the same precedence as the CLI.
- `options` — runtime extras: a `configPath`, a `cwd` (the project root used for config-file
  discovery, `.env` loading and a relative `migrationsDir` — defaults to `process.cwd()`, worth
  setting when one process hosts kits for several projects), a `progress` reporter, or a
  `fallbackLogger` (used only when the resolved config supplies no `logger` of its own — pass
  `logger` in `config` for the usual case).

::: tip Connection is lazy
Most methods call `connect()` for you if you haven't. Call it explicitly when you want to control
when the connection opens, and always pair it with `disconnect()`.
:::

::: warning Several kits in one process
Give each kit `envFile: false` and an explicit `uri`/`dbName`. Loading a `.env` file mutates the
shared `process.env` (with `override: false` semantics), so whichever kit resolves first plants
its `MIGRONAUT_*` values there — and every later kit's config resolution can silently pick them
up, even from a different project's env file.
:::

## Methods

| Method | Returns | Description |
|---|---|---|
| `connect()` | `Promise<void>` | Open the MongoDB connection and ensure changelog indexes. |
| `disconnect()` | `Promise<void>` | Close the connection. |
| `up(filename?, options?)` | `Promise<RunResult[]>` | Apply all pending migrations, or one file. |
| `down(filename?, options?)` | `Promise<RunResult[]>` | Revert the last batch, or a file/batch/last-N. |
| `redo(filename?, options?)` | `Promise<RunResult[]>` | Revert then re-apply, both under one lock. |
| `dryRun(direction, filename?, options?)` | `Promise<StatusRow[]>` | Preview `'up'`/`'down'` without writing. |
| `status(options?)` | `Promise<StatusRow[]>` | Full status of every known migration. `{ checksums: false }` skips hashing applied files. |
| `list(filter, options?)` | `Promise<StatusRow[]>` | Filtered status: `'all' \| 'pending' \| 'applied'`; same `checksums` option. |
| `audit()` | `Promise<AuditReport>` | Read-only health check — the [`migronaut audit`](/commands/audit) command's engine. |
| `create(name, options?)` | `Promise<string>` | Scaffold a new migration; returns its path. |
| `init(options?)` | `Promise<string>` | Generate a config file; returns its path. |
| `import(options?)` | `Promise<ImportResult>` | Adopt a migrate-mongo changelog. |
| `baseline(options?)` | `Promise<BaselineSummary>` | Mark files applied without executing them — the [`migronaut baseline`](/commands/baseline) command's engine. |
| `converge(options?)` | `Promise<ConvergeResult>` | Bring the [declared collections](/guide/collections) to their declared indexes, search indexes and validators — the [`migronaut converge`](/commands/converge) command's engine. |
| `convergesAfterUp()` | `Promise<boolean>` | Whether a bulk `up` on this kit ends by converging (`convergeAfterUp` on, something declared). Does not connect. |
| `convergeHistory(options?)` | `Promise<ConvergeHistoryEntry[]>` | The [converge history](/guide/collections#history), newest first (`{ limit }`, default 20). Read-only. |
| `nextBatch()` | `Promise<number>` | The batch number the next `up` would use — a peek, not a reservation. |
| `generateId()` | `Promise<string>` | A new id in the kit's configured format — the [`generateId`](/guide/configuration#custom-id-format) option, else a random UUID. Does not connect. |
| `lockInfo()` | `Promise<LockInfo \| null>` | Inspect the current lock holder, if any. |
| `forceUnlock()` | `Promise<LockInfo \| null>` | Force-release the lock; returns who held it. |
| `stop(reason?)` | `void` | Ask an in-flight run to stop cleanly after the current migration. |

`up`/`down`/`redo` return a [`RunResult[]`](#runresult); `status`/`list`/`dryRun` return
[`StatusRow[]`](#statusrow).

`up`, `down`, `redo` and `converge` take `requestedBy` (≤ 128 characters) and `reason` (≤ 512):
who asked for the run, and why. They are stamped on what the run writes — `requestedBy` /
`reason` on applied records, `revertRequestedBy` / `revertReason` on reverted ones, both on a
converge history entry — and `status()` shows them. `executedBy` stays the OS user that ran it.
`up(file, { checksum })` refuses any other version of the file than the one with that SHA-256 (the
`checksum` that `dryRun('up')` rows carry).

`baseline({ to?, noLock? })` adopts an existing database with no prior migration tool: it stamps
migration files as applied — checksums from disk, one shared batch, `origin: 'baseline'` — without
executing anything, and resolves to `{ baselined, skipped, batch }`. Baselined records are
forward-only (`down`/`redo` refuse them), and already-applied names are skipped, so a partial
baseline can simply be re-run. See [`migronaut baseline`](/commands/baseline).

### Driving a run one file at a time

Two `up` options — and one for `down` — let something outside the kit (a queue, a workflow engine)
split one logical run into single-file calls without losing what a bulk run guarantees:

```ts
const batch = await migrator.nextBatch();
for (const file of ['0007-a.js', '0008-b.js']) {
  await migrator.up(file, { batch, ordered: true });
}
```

- **`batch`** stamps the given number instead of the next free one, so the files form one batch and
  a later `down` reverts them together. Mutually exclusive with `step`.
- **`ordered`** (needs a filename) refuses with `MigrationBlockedError` while an earlier file is
  still pending — and makes the single-file run honour `strict` drift checks and `onOutOfOrder`
  like a bulk run. On `down(file, { ordered: true })` it refuses while a migration applied *later*
  is still applied.

This is exactly what the [BullMQ adapter](/guide/bullmq) does for every job.

### Declared collections

`converge()` compares the [declared collections](/guide/collections) with the live database and
makes the difference — stateless, under the migration lock:

```ts
const plan = await migrator.converge({ dryRun: true }); // no lock, no writes, no events
if (!plan.inSync) await migrator.converge();
await migrator.converge({ prune: true });               // drop undeclared indexes too
```

| Option | Meaning |
|---|---|
| `dryRun` | Plan only. The result's rows are `'planned'` |
| `prune` | Drop undeclared indexes in collections whose definition does not set `prune` |
| `noLock` | Skip the lock (dev only) |
| `ordered` | Refuse (`MigrationBlockedError`) while a migration is pending — checked under the lock |
| `rebuildUnique` | Allow a rebuild that drops a unique index and builds a unique one back (a `conflict` otherwise) |
| `waitForSearchIndexes` | Hold the run until every declared [search index](/guide/collections#search-indexes) is queryable (overrides the config key; not with `dryRun`) |

```ts
interface ConvergeResult {
  dryRun: boolean;
  changed: number; // applied — or, in a dry run, would be
  inSync: boolean; // nothing left to do, no conflict
  collections: {
    name: string;
    actions: {
      target: 'collection' | 'validator' | 'index' | 'searchIndex';
      name: string;
      action:
        | 'create' | 'modify' | 'recreate' | 'drop' | 'keep' | 'unchanged' | 'conflict'
        | 'skip'; // a search index on a server without Search (onSearchUnavailable: 'skip')
      status: 'planned' | 'applied' | 'failed' | 'skipped';
      reason?: string; // what differs, or why
      liveName?: string; // the live index, when its name differs
      durationMs?: number;
      from?: object; // what is there now
      to?: object; // what the row puts there
      build?: { status: string; queryable: boolean; message?: string; updating?: true }; // search
    }[];
  }[];
  unstable?: { collection: string; target: string; name: string; action: string; reason?: string }[];
  // Present when search indexes are declared:
  search?: {
    available: boolean; // the server has Atlas Search
    notReady: { collection: string; name: string; status: string; queryable: boolean }[];
  };
}
```

A search index builds in the background: `result.search.notReady` lists the declared ones still
building, updating or failed — which does not count against `inSync`.

A conflicting plan, a step that fails, or a `waitForSearchIndexes` that gives up rejects with
`ConvergeFailedError` (`CONVERGE_FAILED`, `context.phase`: `plan`, `replan`, `apply` or `wait`),
whose `context.converge` is the result so far. `up(undefined, { converge: true })` converges after
the migrations under the same lock — what `convergeAfterUp` does for every bulk `up`; `up` still
returns its migration rows, and the converge outcome arrives as the `converge:end` event.

### Background migrations

A [background migration](/guide/background-migrations) is registered by `up` and carried out by
these methods — none of them takes the migration lock, and one kit may run many at once. All are
experimental.

```ts
await migrator.runBackground('20261004-orders-v2.js', { concurrency: 4 }); // to the end, from here
const status = await migrator.backgroundStatus('20261004-orders-v2.js');   // null when not registered
await migrator.pauseBackground('20261004-orders-v2.js', { wait: true, reason: 'peak hours' });
await migrator.resumeBackground('20261004-orders-v2.js');
```

| Method | What it does |
|---|---|
| `runBackground(name, { signal?, sliceMs?, untilDone?, concurrency? })` | Drive it from this process — the coordinator and up to `concurrency` lanes (at most its `maxParallel`) — to the end, or one round with `untilDone: false`. A failure rejects with `BackgroundFailedError`; an aborted `signal` with `RunAbortedError` (it goes on from there next time) |
| `coordinateBackground(name, { signal?, driver? })` / `runBackgroundSlice(name, { signal?, sliceMs? })` | One coordinator step / one lane's slice — the building blocks the runner and the queue use |
| `backgroundStatus(name?)` / `backgroundPartitions(name)` / `runnableBackground()` | Read its state, the partitions of its latest generation, the ones with work to do |
| `pauseBackground` / `resumeBackground` / `cancelBackground(name, { wait?, requestedBy?, reason? })` | Controls; each lane sees them at its next batch |
| `retryBackground(name, { fromStart?, repin? })` / `repinBackground(name)` / `unlockBackground(name)` | Retry a failed or cancelled one (or reopen a completed one), pin the file on disk, release its coordinator lock and every lease |
| `dryRunBackground(name, { sample?, first?, validate?, steps?, direction? })` | Preview without writing — a sample, or a `step` migration's steps in the always-aborted sandbox |
| `verifyBackground({ onDrift?, collections? })` | The drift check, once: old-shape documents written after completion |
| `watchBackground(options?)` / `backgroundWatchStatus(collection?)` | The live drift watcher (change streams), and what the watchers recorded |
| `driftMode()` | The `backgroundDrift` setting — what a runner or a queue worker hosting this kit follows |

`startBackgroundRunner({ kit | config, concurrency?, pollIntervalMs?, verifyIntervalMs?, watch?,
signal?, onError? })` runs lanes inside the application, shared by every runnable background
migration, plus the drift check (and, when drift is streamed, the live watcher); it resolves to
`{ kit, running, watcher, stop() }`. An ordinary migration that `requires` a background one waits
for it: `up` rejects with `BackgroundPendingError` — or, with `onBackgroundPending: 'stop'` (also
on `runMigrations`), ends the line cleanly and reports it as `summary.waiting`.

::: tip `MigratorKit` is an `EventEmitter`
Subscribe to `run:start`, `run:end`, `migration:start`, `migration:success`, `migration:skipped`,
`migration:error`, `lock:acquired`, `lock:released`, `lock:lost` and — for a real converge run —
`converge:start`, `converge:action`, `converge:wait` and `converge:end` to feed metrics or alerting without
parsing log lines. See [Lifecycle Hooks → Events](/guide/hooks#events) for the payloads. For traces — spans that the
MongoDB driver's own spans nest under — and ready-made OpenTelemetry metrics, pass
[`telemetry`](/guide/opentelemetry) in the config instead.
:::

## Common patterns

### Run migrations on app startup

```ts
const migrator = new MigratorKit(); // reads env / config file
try {
  await migrator.up();
} finally {
  await migrator.disconnect();
}
```

### Gate a deploy on pending migrations

```ts
const rows = await migrator.status();
const pending = rows.filter((r) => r.status === 'pending');
if (pending.length > 0) {
  throw new Error(`${pending.length} migration(s) pending — aborting deploy`);
}
```

### Silence output (e.g. in tests)

```ts
const migrator = new MigratorKit({ /* ... */, logger: null });
```

## Top-level helpers

Four more things are exported from the package root, for the cases where a full
`MigratorKit` instance is more machinery than you need.

### `runMigrations(config?, options?)`

The one-call entry point for app startup, deploy hooks, serverless cold starts and test setup. It
opens its own connection and **always disconnects in a `finally`**, so a failure can never leak one.

```ts
import { runMigrations } from '@alexify/migronaut';

const { applied, upToDate, waited } = await runMigrations(
  { uri: process.env.MIGRONAUT_URI, dbName: 'my_app' },
  { onLockHeld: 'wait' },
);
if (!upToDate) console.log(`Applied ${applied.length} migration(s)`);
```

`onLockHeld: 'wait'` is the option that matters when several instances boot together: instances
that lose the race to acquire the lock poll until the migrating peer finishes instead of throwing
`LockAlreadyHeldError`. The returned `MigrationSummary` reports `waited`, `waitedMs` and
`attempts` so you can log what actually happened. With `convergeAfterUp`, it also carries
`converge` — the [converge result](#declared-collections) that ended the run.

`lockWaitTimeoutMs` bounds **stall** time, not total wait: while a waiting instance can see the
holder's heartbeat advancing the lock, the deadline re-arms — a healthy peer working through a
long backlog never times its waiters out. Only a holder that stops renewing runs the budget down.
Left out, it is 90 s or 1.5× the holder's `lockTTLSeconds`, whichever is longer — the heartbeat
moves the lock only every TTL/2, and a crashed holder's lock is reclaimable only after a full TTL.
Polls start at `lockPollIntervalMs` (500 ms) and back off, doubling, up to 5 s, so a fleet waiting
out a long deploy does not hammer the lock document. A wait that times out rethrows the
`LockAlreadyHeldError` with `context.timedOut`, `attempts` and `waitedMs`.

Pass a `signal` so a shutdown reaches the call: the wait stops between polls, and a run that
already holds the lock stops between migrations (the one executing finishes), with a
`RunAbortedError`:

```ts
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort('SIGTERM'));
await runMigrations(config, { onLockHeld: 'wait', signal: controller.signal });
```

`onKit` receives the internally-constructed `MigratorKit` right after construction (before
connect), so an embedding application can subscribe to its lifecycle events — metrics without log
parsing — while keeping the managed connect/run/disconnect lifecycle:

```ts
await runMigrations(config, {
  onLockHeld: 'wait',
  onKit: (kit) => {
    kit.on('migration:success', ({ migration, durationMs }) => {
      metrics.timing('migration.duration', durationMs, { migration });
    });
    // acquireMs is the acquire round trip; the wait itself is the summary's waitedMs.
    kit.on('lock:acquired', ({ acquireMs }) => metrics.timing('migration.lock_acquire', acquireMs));
  },
});
```

See [Lifecycle Hooks → Events](/guide/hooks#events) for the payloads.

### `pendingMigrations(config?, options?)`

A read-only readiness probe returning [`StatusRow[]`](#statusrow) for everything not yet applied.
Connection-managed the same way — useful in a health check that must never write.

```ts
const pending = await pendingMigrations();
if (pending.length > 0) throw new Error(`${pending.length} migration(s) behind`);
```

### `createLogger(stream?, level?)`

The built-in console logger as a factory — pino-compatible surface, colors and terminal-escape
sanitization included — for when you want migronaut's own output at a chosen verbosity without
hand-writing a four-method logger. `level` is `'debug' | 'info' | 'warn' | 'error'` (default
`'info'`); anything less severe is dropped. `debug`/`info` write to `stream` (stdout by default),
`warn`/`error` always go to stderr.

```ts
import { MigratorKit, createLogger } from '@alexify/migronaut';

const migrator = new MigratorKit({ logger: createLogger(process.stdout, 'debug') });
```

### `EXIT_CODES`

The CLI's exit-code map, so a wrapper script can mirror its semantics without hardcoding numbers.
One entry per error code, plus `PENDING_MIGRATIONS` (from `status --check`), `AUDIT_FAILED` and
`COLLECTIONS_DRIFT` (from `converge --check`).
See the [exit-code table](/reference/cli#exit-codes).

## Document versioning

`@alexify/migronaut/versioning` is a third entry point, beside the package root and `./bullmq`: the
[document versioning](/guide/versioning) runtime for your application's repository layer. It loads
no part of the migration engine, and neither the driver nor Mongoose — the helpers take your
collection (a driver `Collection`, or a Mongoose model's `Model.collection`) and use only its
methods.

```ts
import { defineShapes, updateWithRevision } from '@alexify/migronaut/versioning';
import ordersDefinition from './collections/orders.js';

// The same definition converge declares the collection with
const shapes = defineShapes({ orders: ordersDefinition });
const orders = db.collection('orders');

await orders.insertOne(shapes.stamp('orders', draft)); // __v: current, __rev: 0
await updateWithRevision(orders, { _id }, order.__rev ?? 0, { $set: { status: 'paid' } });
```

| Export | What it is |
|---|---|
| `defineShapes(definitions)` | The registry of your versioned collections, read from their definitions: `stamp`, `onInsert`, `stampUpsert`, `versionOf`, `isCurrent`, `isVersion`, `upcaster`, `plugin`. `defineShapes<Shapes>()(definitions)` is the [typed form](/guide/versioning#typed-shapes) |
| `updateWithRevision`, `replaceWithRevision`, `findOneAndUpdateWithRevision` | Writes that land only at the revision the caller read, and bump it — `RevisionConflictError` otherwise |
| `retryOnConflict(fn, options?)` | Read, decide and write again after a conflict — 3 attempts, full-jitter backoff |
| `bumpRevision(update, options?)` | The update with the revision bumped, for a write that needs no guard |
| `upcaster(definition, steps, options?)` | One collection's shape changes: `step(from)` for a background migration, `upcast(doc)` on read |
| `isVersion(doc, version, options?)` | Whether a document is at a version — a missing field is 0; a type guard |
| `versioningPlugin` | The [Mongoose plugin](/guide/mongoose#document-versioning) |
| `MigronautError`, `ConfigInvalidError`, `RevisionConflictError`, `ShapeVersionError` | The package root's own classes — `instanceof` agrees whichever entry point you import them from |

Its types live in `versioning.d.ts` (TypeScript ≥ 5.0): `AnyShape`, `CurrentShape`, `ShapeAt`,
`Stamped`, `BackgroundMigrationFor`, `ShapeRegistry`, `Upcaster`, `RevisionWriteOptions` and more.
`Body` and `CollectionVersioning` come from the package root as well. Experimental, like everything
new in 2.3 — see [Document Versioning](/guide/versioning) for the whole picture.

## Key types

### `RunResult`

```ts
interface RunResult {
  file: string;
  status: 'applied' | 'reverted' | 'skipped' | 'error';
  duration?: number;
  batch?: number;
  reason?: string;
  error?: string;
}
```

### `StatusRow`

```ts
interface StatusRow {
  file: string;
  status: 'applied' | 'pending' | 'failed';
  batch: number | null;
  appliedAt: Date | null;
  duration: number | null;
  checksumOk: boolean | null; // null = pending, true = match, false = mismatch
  description?: string;
  // Audit trail, when the changelog recorded it:
  executedBy?: string; // who ran it
  environment?: string; // environment stamped at apply time
  runId?: string; // correlation id of the run that wrote the record
  revertedAt?: Date; // present on reverted history rows
  origin?: MigrationOrigin; // 'migrate-mongo' / 'baseline' mark forward-only records
  error?: string; // status 'failed' only — redacted message of the last attempt
  failedAt?: Date; // status 'failed' only
  outOfOrder?: true; // pending but sorts before the newest applied migration
}
```

`'failed'` marks a recorded failed attempt: the file still counts as pending everywhere (the next
`up` retries it), but the failure is surfaced — with `error` and `failedAt` — instead of rendering
as a plain pending row. A reverted record reports as `'pending'`, with `revertedAt` carrying its
history. `outOfOrder` flags a late arrival from a parallel branch — see
[`onOutOfOrder`](/guide/configuration#all-options).

All public types are exported from the package — `MigronautConfig`, `MigrationContext`,
`MigrationRecord`, `RunResult`, `StatusRow`, `ImportResult`, `LockInfo`, `CollectionDefinition`,
`ConvergeResult`, and more. See the
[error classes](#errors) below and the [Error Codes reference](/reference/error-codes).

## Errors

Every error extends `MigronautError`, which carries a typed `code` and an optional `context`:

```ts
import { MigronautError } from '@alexify/migronaut';

try {
  await migrator.up();
} catch (err) {
  if (err instanceof MigronautError) {
    console.error(err.code, err.message, err.context);
  }
}
```

Exported error classes include `LockAlreadyHeldError`, `ChecksumMismatchError`,
`ConnectionFailedError`, `NotAppliedError`, `IrreversibleMigrationError`, `MigrationBlockedError`,
and more — see the full table in the [Error Codes reference](/reference/error-codes).
