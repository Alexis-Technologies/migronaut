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
can tell how far the run got. A failed converge carries its own progress in
`error.context.converge` instead — `partial` stays the migrations, so after an
`up` that converges it still lists the ones that were applied. The exit code identifies the failure — see
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
| `TRANSACTIONS_UNSUPPORTED` | `TransactionsUnsupportedError` | `useTransaction` is on, but the deployment is standalone | Set `useTransaction: false`, or run a replica set / mongos |
| `CONFIG_INVALID` | `ConfigInvalidError` | Config failed validation | Check required fields and types |
| `CONFIG_FILE_EXISTS` | `ConfigFileExistsError` | `migronaut init` found an existing config | Use `--force` to overwrite |
| `CONNECTION_FAILED` | `ConnectionFailedError` | Couldn't connect to MongoDB | Verify `uri`/`dbName` and that Mongo is up |
| `NOT_APPLIED` | `NotAppliedError` | Tried to revert a migration that isn't applied | Run `migronaut status` to see what's applied |
| `IMPORT_TARGET_NOT_EMPTY` | `ImportTargetNotEmptyError` | `migronaut import` target already has records | Use `--force` to import anyway |
| `MIGRATION_IRREVERSIBLE` | `IrreversibleMigrationError` | Tried to revert a forward-only record ([imported](/commands/import) or [baselined](/commands/baseline)) | Write a new forward migration instead |
| `MIGRATION_OUT_OF_ORDER` | `OutOfOrderMigrationError` | A bulk `up` under `onOutOfOrder: 'error'` found a pending migration sorting before the newest applied one (a file merged late from a parallel branch) | Apply it deliberately with `onOutOfOrder: 'warn'` or `'allow'` |
| `MIGRATION_BLOCKED` | `MigrationBlockedError` | An `ordered` single-file run (every [queue job](/guide/bullmq) is one) would go out of sequence: an earlier migration is still pending (`up`), or one applied later is still applied (`down`) | `context.blockedBy` names what must go first — fix or apply those, then enqueue again |
| `QUEUE_JOB_INVALID` | `QueueJobInvalidError` | A [queue job](/guide/bullmq)'s payload failed the contract check — unknown job name or data version, a migration name that is not a bare filename | Enqueue through `enqueueUp`/`enqueueDown`; `context.issue` says what was wrong |
| `QUEUE_JOB_FAILED` | `QueueJobFailedError` | A queue group's `wait()` saw one of its jobs fail, or timed out | `context.failedReason` is the worker's message, `context.results` what finished before it |
| `CONVERGE_FAILED` | `ConvergeFailedError` | [`converge`](/commands/converge) could not bring the declared collections to their declared state: the plan had a conflict, or a search index list could not be read before the first write (`context.phase: 'plan'` — nothing was written); a collection changed while the run was under way (`'replan'` — that collection was not touched); a step failed (`'apply'`); or `waitForSearchIndexes` gave up — on a FAILED build of an index the run created or changed, its timeout, or a search index list it could not read (`'wait'`, `context.reason` `'failed'`, `'timeout'` or `'unreadable'` — everything was applied, `context.notReady` lists the builds). A search index list that cannot be read later in the run is reported in the phase that read it (`'replan'`, `'apply'`, `'wait'`) | `context.hint` says what usually fixes the server error (deduplicate before a unique index, grant `dbAdmin` for validators, use a server with Atlas Search or `onSearchUnavailable: 'skip'`); `context.converge` is the result so far, `context.restored` whether a failed rebuild put the old index back |

See [Troubleshooting](/guide/troubleshooting) for step-by-step fixes for the most common ones.
