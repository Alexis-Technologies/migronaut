# CLI Cheatsheet

Every command and flag on one page. For details, follow the link on each command.

## Global flags

Available on every command, highest precedence:

| Flag | Description |
|---|---|
| `--uri <uri>` | MongoDB connection URI |
| `--db <name>` | Database name |
| `--dir <path>` | Migrations directory |
| `--config <path>` | Path to a config file (overrides auto-discovery) |
| `--env-file <path>` | `.env` file to load (default: `./.env`) |
| `--no-env` | Do not load a `.env` file at all |
| `--verbose` | Show debug output, including the underlying cause of an error (disables the spinner — debug lines and an animated frame would fight for the same terminal line) |
| `--quiet` | Suppress everything but errors |
| `--no-color` | Disable colored output — wins over every color environment variable |
| `--json` | Machine-readable JSON output (every command except `init` — see `init --format`) |
| `-V, --version` | Print the installed version |
| `-h, --help` | Print help for the program or a command |

::: tip Color detection
Without the flag, color is decided by `MIGRONAUT_FORCE_COLOR` > `MIGRONAUT_NO_COLOR` >
`FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > whether the stream is an interactive TTY. A
`*FORCE_COLOR` that is set and non-empty decides (`0` forces color off, anything else forces it
on); a `*NO_COLOR` that is set and non-empty forces it off.

The `MIGRONAUT_`-prefixed pair lets you pin migronaut's output without disturbing every other tool
in the same shell. `--no-color` is an explicit instruction for this invocation, so it overrides all
of them — including a `FORCE_COLOR` exported by your CI runner.
:::

::: tip Short flags
Combined short flags are not supported: write `-f -y`, not `-fy`.
:::

## Running migrations

| Command | Description |
|---|---|
| [`migronaut up`](/commands/up) | Run all pending migrations |
| `migronaut up <file>` | Run a single migration |
| `migronaut up --to <file>` | Apply pending migrations up to and including that file |
| `migronaut down --to <file>` | Revert everything applied after that file (it stays applied) |
| `migronaut up --step` | Apply each file as its own batch |
| `migronaut up <file> --force --yes` | Re-run an already-applied file (short: `-f -y`) |
| `migronaut up --strict` | Abort on a checksum mismatch |
| `migronaut up --no-lock` | Skip the lock (dev only) |
| [`migronaut down`](/commands/down) | Roll back the last batch |
| `migronaut down <file>` | Roll back a single migration |
| `migronaut down --batch <n>` | Roll back a specific batch |
| `migronaut down --steps <n>` | Roll back the last N migrations |
| `migronaut down --no-lock` | Skip the lock (dev only) |
| [`migronaut redo`](/commands/redo) | Down + up the last applied migration |
| `migronaut redo <file>` | Down + up a specific migration |
| `migronaut redo --no-lock` | Skip the lock (dev only) |
| `migronaut up --converge` / `--no-converge` | Converge the declared collections afterwards — or not, whatever `convergeAfterUp` says |

## Declared collections

| Command | Description |
|---|---|
| [`migronaut converge`](/commands/converge) | Bring declared collections (indexes, search indexes, validators) to their declared state — asks before a drop or rebuild |
| `migronaut converge --dry-run` | Show the plan, change nothing |
| `migronaut converge --check` | Exit 28 if anything would change (CI gate) |
| `migronaut converge --prune` | Also drop indexes (and search indexes) a definition does not declare |
| `migronaut converge --wait-search` / `--no-wait-search` | Wait until every declared search index is queryable — or not, whatever `waitForSearchIndexes` says |
| `migronaut converge --ordered` | Refuse while a migration is still pending (exit 24) |
| `migronaut converge --history` | Show what converge has changed (`--limit n`, `--json`) |
| `migronaut up` / `down` / `redo` / `converge` `--reason <text>` | Why — recorded with the run (changelog / converge history) |
| `migronaut converge --yes` | Apply drops and rebuilds without asking (required for them with `--json`) |
| `migronaut converge --rebuild-unique` | Allow rebuilding a unique index (a `conflict` otherwise) |
| `migronaut converge --no-lock` | Skip the lock (dev only) |

## Background migrations

| Command | Description |
|---|---|
| [`migronaut background status [name]`](/commands/background) | Background migrations and their progress (`--partitions`, `--check`: exit 32 failed / 31 not completed) |
| `migronaut background run <name>` / `--all` | Drive it from this process (`--concurrency N`, `--once`); Ctrl-C stops the lanes at their next batch (exit 11) |
| `migronaut background pause\|resume\|cancel <name>` | Control it (`--wait` for the lanes on pause and cancel, `--reason`); cancel asks first |
| `migronaut background retry <name>` | Retry a failed or cancelled one (`--from-start` asks first, `--repin`), reopen a completed one |
| `migronaut background repin <name>` | Pin the file on disk (asks first) |
| `migronaut background dry-run <name>` | On a sample (`--sample`, `--first`, `--validate`, `--revert`) or by steps (`--steps`, `--from-start`, `--max-docs`, `--deadline-ms`) — nothing written; exit 34 on a sandbox refusal |
| `migronaut background unlock <name>` | Clear a stuck coordinator lock and every lease (asks first) |
| `migronaut background verify` | The drift watch, once (`--report`: never reopen; exit 31 on drift) |
| `migronaut background watch [collection]` | The live drift watcher in the foreground (`--report`: never upgrade); Ctrl-C stops it cleanly (exit 0) |
| `migronaut background … --yes` | Do not ask (required with `--json` for cancel, repin, unlock, retry `--from-start`) |

## Inspecting

| Command | Description |
|---|---|
| [`migronaut status`](/commands/status) | Full status table |
| `migronaut status --check` | Exit 2 if any migration is pending (CI gate) |
| `migronaut status --pending` / `--limit <n>` | Filter to pending rows / show only the last N (`--limit` is not combinable with `--check`) |
| `migronaut list --pending` | Only pending migrations |
| `migronaut list --applied` | Only applied migrations |
| [`migronaut dry-run up`](/commands/dry-run) | Preview what would apply |
| `migronaut dry-run down` | Preview what would revert |
| `migronaut dry-run down --steps <n>` | Preview reverting the last N |
| `migronaut dry-run down --batch <n>` | Preview reverting a specific batch |
| `migronaut dry-run up --to <file>` | Preview a staged rollout up to that file |
| `migronaut dry-run down --to <file>` | Preview reverting everything applied after that file |

## Authoring

| Command | Description |
|---|---|
| [`migronaut create <name>`](/commands/create) | Create a migration (default `.js`) |
| `migronaut create <name> --ts` | Create a `.ts` migration |
| `migronaut create <name> --js` | Create a `.js` migration |
| `migronaut create <name> --template <path>` | Use a custom template |
| `migronaut create <name> --background` | Create a [background migration](/guide/background-migrations) (`export const background`) — not with `--template` |
| [`migronaut init`](/commands/create#migronaut-init) | Generate `migronaut.config.js` |
| `migronaut init --format <js\|ts\|json>` | Config file format (`--ts`/`--js` are shorthands) |
| `migronaut init --secret-provider` | Generate a secret-manager config |
| `migronaut init --force` | Overwrite an existing config |

## Operations

| Command | Description |
|---|---|
| [`migronaut import`](/commands/import) | Adopt a migrate-mongo changelog |
| `migronaut import --from <c>` / `--to <c>` | Source / target collection |
| `migronaut import --dry-run` | Preview the mapping |
| `migronaut import --trust-hash` | Reuse migrate-mongo's `fileHash` |
| `migronaut import --force` | Import into a non-empty changelog |
| [`migronaut baseline`](/commands/baseline) | Mark existing files as applied without running them |
| `migronaut baseline --to <file>` | Baseline only files up to and including that one |
| `migronaut baseline --yes` | Skip the confirmation prompt (required with `--json`) |
| `migronaut lock` | Show who holds the migration lock |
| `migronaut lock --json` | Machine-readable `{ held, holder }` |
| `migronaut audit` | Check config, connectivity, transactions, indexes, lock, checksums |
| `migronaut audit --json` | Machine-readable report; exit 22 when a check fails |
| [`migronaut unlock`](/commands/unlock) | Force-release a stuck lock |
| `migronaut unlock --yes` | Release without confirmation (short: `-y`) |

## Exit codes

The code identifies *why* a run failed, so CI can branch on it. Success is
always `0`, and anything unmapped is `1` — a script testing `!= 0` keeps
working unchanged. The full map is also exported from the package root as
`EXIT_CODES`, so a wrapper script can mirror it without hardcoding numbers.

| Code | Meaning |
|---|---|
| `0` | Success (or nothing to do) |
| `1` | An unclassified error |
| `2` | `PENDING_MIGRATIONS` — `status --check` found pending migrations |
| `3` | `LOCK_ALREADY_HELD` — another run holds the lock |
| `4` | `CHECKSUM_MISMATCH` — an applied file was edited (with `--strict`) |
| `5` | `CONNECTION_FAILED` — could not reach MongoDB |
| `6` | `CONFIG_INVALID` — bad configuration or flags |
| `7` | `MIGRATION_EXECUTION_FAILED` — a migration threw |
| `8` | `MIGRATION_FILE_NOT_FOUND` |
| `9` | `NOT_APPLIED` — nothing to revert under that name |
| `10` | `LOCK_LOST` — the lock was lost mid-run |
| `11` | `RUN_ABORTED` — stopped by SIGINT/SIGTERM |
| `12` | `HOOK_FAILED` — a lifecycle hook threw |
| `13` | `MIGRATION_IRREVERSIBLE` — an imported migrate-mongo record |
| `14` | `MIGRATION_TIMEOUT` — a migration exceeded `timeoutMs` |
| `15` | `TRANSACTIONS_UNSUPPORTED` — transactions need a replica set / mongos |
| `16` | `CONFIG_FILE_EXISTS` — `init` found an existing config (idempotent no-op) |
| `17` | `IMPORT_TARGET_NOT_EMPTY` — `import` found records (re-run with `--force`) |
| `18` | `MIGRATION_FILE_EXISTS` — `create` name collision |
| `19` | `MIGRATION_INVALID_NAME` — a rejected (e.g. path-traversing) name |
| `20` | `MIGRATION_INVALID_EXPORT` — a migration file without valid `up`/`down` |
| `21` | `LOCK_RELEASE_FAILED` — the lock could not be released |
| `22` | `AUDIT_FAILED` — an `audit` check failed (warnings stay `0`) |
| `23` | `MIGRATION_OUT_OF_ORDER` — a late-merged file, under `onOutOfOrder: 'error'` |
| `24` | `MIGRATION_BLOCKED` — an ordered single-file run would go out of sequence |
| `25` | `QUEUE_JOB_INVALID` — a [queue job](/guide/bullmq) payload failed validation |
| `26` | `QUEUE_JOB_FAILED` — a queue group's `wait()` saw a job fail or time out |
| `27` | `CONVERGE_FAILED` — [`converge`](/commands/converge) refused a conflicting plan, a step failed, or `--wait-search` gave up |
| `28` | `COLLECTIONS_DRIFT` — `converge --check` found the database out of step with the declarations, or a search index that failed to build |
| `29` | `REVISION_CONFLICT` — a revision-guarded write lost a race (library only) |
| `30` | `SHAPE_VERSION_UNSUPPORTED` — an upcaster met a document it cannot read (library only) |
| `31` | `BACKGROUND_PENDING` — a migration waits for a [background migration](/commands/background), or `background status --check` / `background verify` found work |
| `32` | `BACKGROUND_FAILED` — a background migration failed |
| `33` | `BACKGROUND_CONFLICT` — a background control action did not fit its state |
| `34` | `SANDBOX_REFUSED` — a background dry run reached for something the sandbox refuses |
| `130` / `143` | Killed by a second SIGINT / SIGTERM |
