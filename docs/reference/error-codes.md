# Error Codes

Every error thrown by `migronaut` extends `MigronautError` and carries a typed `code`, a `message`,
and an optional `context` object. Catch `MigronautError` and switch on `code` for precise handling:

```ts
import { MigronautError } from '@alexify/migronaut';

try {
  await migrator.up();
} catch (err) {
  if (err instanceof MigronautError) {
    console.error(err.code, '—', err.message, err.context);
  }
}
```

Every error also carries `cause` — the original `Error`, with its stack — when it
wraps one, so `err.cause.stack` still points into your own migration. Pass
`--verbose` to have the CLI print it.

In `--json` mode the CLI prints:

```json
{
  "error": { "code": "MIGRATION_EXECUTION_FAILED", "message": "…", "context": { "…": "…" } },
  "partial": [{ "file": "0001-a.ts", "status": "applied", "duration": 12, "batch": 3 }]
}
```

`partial` lists what already succeeded before the failure, so a deploy pipeline
can tell how far the run got. The exit code identifies the failure — see
[Exit codes](/reference/cli#exit-codes).

## Reference

| Code | Error class | When it's thrown | What to do |
|---|---|---|---|
| `LOCK_ALREADY_HELD` | `LockAlreadyHeldError` | Another run holds the lock within its TTL | Wait, or [`migronaut unlock`](/commands/unlock) if it's stale |
| `LOCK_RELEASE_FAILED` | `LockReleaseFailedError` | The lock couldn't be released | Check DB connectivity; retry |
| `LOCK_LOST` | `LockLostError` | The lock was lost mid-run (reclaimed, or the heartbeat couldn't reach the DB) | Check what else is migrating; re-run `up` once it's clear |
| `RUN_ABORTED` | `RunAbortedError` | The run was stopped by `stop()` or SIGINT/SIGTERM | See `context.results` for what was applied, then re-run |
| `HOOK_FAILED` | `HookFailedError` | One of your lifecycle hooks threw | `context.hook` names it; `context.cause` has the message |
| `CHECKSUM_MISMATCH` | `ChecksumMismatchError` | An applied file was edited (in `--strict`) | Don't edit applied files — write a new migration |
| `MIGRATION_FILE_NOT_FOUND` | `MigrationFileNotFoundError` | A named migration file doesn't exist | Check the filename and `migrationsDir` |
| `MIGRATION_FILE_EXISTS` | `MigrationFileExistsError` | `migronaut create` would overwrite an existing file | Pick a different name, or delete the existing file |
| `MIGRATION_INVALID_NAME` | `MigrationInvalidNameError` | A migration name escapes the migrations dir, or isn't a string | Use a bare filename, not a path |
| `MIGRATION_INVALID_EXPORT` | `MigrationInvalidExportError` | A file is missing `up`/`down` functions | Export both `up` and `down` |
| `MIGRATION_EXECUTION_FAILED` | `MigrationExecutionFailedError` | A migration's `up`/`down` threw | Read the cause; fix the migration logic |
| `MIGRATION_TIMEOUT` | `MigrationTimeoutError` | A migration ran longer than `timeoutMs` | Raise the limit, or make the migration watch `ctx.signal` |
| `CONFIG_INVALID` | `ConfigInvalidError` | Config failed validation | Check required fields and types |
| `CONFIG_FILE_EXISTS` | `ConfigFileExistsError` | `migronaut init` found an existing config | Use `--force` to overwrite |
| `CONNECTION_FAILED` | `ConnectionFailedError` | Couldn't connect to MongoDB | Verify `uri`/`dbName` and that Mongo is up |
| `NOT_APPLIED` | `NotAppliedError` | Tried to revert a migration that isn't applied | Run `migronaut status` to see what's applied |
| `IMPORT_TARGET_NOT_EMPTY` | `ImportTargetNotEmptyError` | `migronaut import` target already has records | Use `--force` to import anyway |
| `MIGRATION_IRREVERSIBLE` | `IrreversibleMigrationError` | Tried to revert an imported migrate-mongo record | Write a new forward migration instead |

See [Troubleshooting](/guide/troubleshooting) for step-by-step fixes for the most common ones.
