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
- `options` — runtime extras: a `configPath`, a `progress` reporter, or a `fallbackLogger`
  (used only when the resolved config supplies no `logger` of its own — pass `logger` in
  `config` for the usual case).

::: tip Connection is lazy
Most methods call `connect()` for you if you haven't. Call it explicitly when you want to control
when the connection opens, and always pair it with `disconnect()`.
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
| `lockInfo()` | `Promise<LockInfo \| null>` | Inspect the current lock holder, if any. |
| `forceUnlock()` | `Promise<LockInfo \| null>` | Force-release the lock; returns who held it. |
| `stop(reason?)` | `void` | Ask an in-flight run to stop cleanly after the current migration. |

`up`/`down`/`redo` return a [`RunResult[]`](#runresult); `status`/`list`/`dryRun` return
[`StatusRow[]`](#statusrow).

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

Three more things are exported from the package root, for the cases where a full
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
that lose the race to acquire the lock poll until the migrating peer finishes (up to
`lockWaitTimeoutMs`, default 90 s) instead of throwing `LockAlreadyHeldError`. The returned
`MigrationSummary` reports `waited`, `waitedMs` and `attempts` so you can log what actually happened.

### `pendingMigrations(config?, options?)`

A read-only readiness probe returning [`StatusRow[]`](#statusrow) for everything not yet applied.
Connection-managed the same way — useful in a health check that must never write.

```ts
const pending = await pendingMigrations();
if (pending.length > 0) throw new Error(`${pending.length} migration(s) behind`);
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
  status: 'applied' | 'pending';
  batch: number | null;
  appliedAt: Date | null;
  duration: number | null;
  checksumOk: boolean | null; // null = pending, true = match, false = mismatch
  description?: string;
}
```

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
