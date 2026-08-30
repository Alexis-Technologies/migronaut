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
| `status()` | `Promise<StatusRow[]>` | Full status of every known migration. |
| `list(filter)` | `Promise<StatusRow[]>` | Filtered status: `'all' \| 'pending' \| 'applied'`. |
| `audit()` | `Promise<AuditReport>` | Read-only health check — the [`migronaut audit`](/commands/audit) command's engine. |
| `create(name, options?)` | `Promise<string>` | Scaffold a new migration; returns its path. |
| `init(options?)` | `Promise<string>` | Generate a config file; returns its path. |
| `import(options?)` | `Promise<ImportResult>` | Adopt a migrate-mongo changelog. |
| `baseline(options?)` | `Promise<BaselineSummary>` | Mark files applied without executing them — the [`migronaut baseline`](/commands/baseline) command's engine. |
| `lockInfo()` | `Promise<LockInfo \| null>` | Inspect the current lock holder, if any. |
| `forceUnlock()` | `Promise<LockInfo \| null>` | Force-release the lock; returns who held it. |
| `stop(reason?)` | `void` | Ask an in-flight run to stop cleanly after the current migration. |

`up`/`down`/`redo` return a [`RunResult[]`](#runresult); `status`/`list`/`dryRun` return
[`StatusRow[]`](#statusrow).

`baseline({ to?, noLock? })` adopts an existing database with no prior migration tool: it stamps
migration files as applied — checksums from disk, one shared batch, `origin: 'baseline'` — without
executing anything, and resolves to `{ baselined, skipped, batch }`. Baselined records are
forward-only (`down`/`redo` refuse them), and already-applied names are skipped, so a partial
baseline can simply be re-run. See [`migronaut baseline`](/commands/baseline).

::: tip `MigratorKit` is an `EventEmitter`
Subscribe to `run:start`, `run:end`, `migration:start`, `migration:success`, `migration:skipped`,
`migration:error`, `lock:acquired`, `lock:released` and `lock:lost` to feed metrics or alerting
without parsing log lines. See [Lifecycle Hooks → Events](/guide/hooks#events) for the payloads.
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
`attempts` so you can log what actually happened.

`lockWaitTimeoutMs` (default 90 s) bounds **stall** time, not total wait: while a waiting
instance can see the holder's heartbeat advancing the lock, the deadline re-arms — a healthy peer
working through a long backlog never times its waiters out. Only a holder that stops renewing
runs the budget down.

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
    kit.on('lock:acquired', ({ acquireMs }) => metrics.timing('migration.lock_wait', acquireMs));
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
One entry per error code, plus `PENDING_MIGRATIONS` (from `status --check`) and `AUDIT_FAILED`.
See the [exit-code table](/reference/cli#exit-codes).

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
`MigrationRecord`, `RunResult`, `StatusRow`, `ImportResult`, `LockInfo`, and more. See the
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
`ConnectionFailedError`, `NotAppliedError`, `IrreversibleMigrationError`, and more — see the full
table in the [Error Codes reference](/reference/error-codes).
