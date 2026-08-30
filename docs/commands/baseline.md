# migronaut baseline

Adopt an existing database that has **no prior migration tool** — mark migration files on disk as
applied **without executing them**.

```bash
migronaut baseline [options]
```

## Why it exists

Your database predates migronaut: its schema was built up by hand, or by home-grown scripts, and
you've since reconstructed migration files that describe the state it's already in. Running
`migronaut up` now would re-execute changes the database already has. `migronaut baseline` records
those files as applied instead, so a subsequent `migronaut up` runs only what's new.

## Usage

```bash
migronaut baseline                                    # adopt everything pending (prompts y/N)
migronaut baseline --to 20260605120500-backfill.js    # staged: adopt up to and including that file
migronaut baseline --yes                              # skip the confirmation prompt
migronaut baseline --json --yes                       # CI-safe: --yes is required with --json
```

Because baselining rewrites what the changelog claims is applied, it asks for confirmation first:

```
Mark pending migration files as applied WITHOUT running them? [y/N]
```

Then it writes the records in one batch:

```
✔ Baselined 12 migration(s) as applied (batch 4)
```

## What gets recorded

Each baselined file gets a normal changelog record, with a few deliberate differences:

| Field | Value |
|---|---|
| `status` | `'applied'` |
| `checksum` | SHA-256 of the file **as it is now** — the baseline asserts the DB already matches these exact files, and later drift checks police edits against this snapshot |
| `batch` | One **shared** batch (the next batch number) for the whole baseline |
| `duration` | `0` — nothing was executed |
| `origin` | `'baseline'` — marks the record forward-only |
| `appliedAt` | Stamped in server time |
| `environment` / `executedBy` / `runId` | Same as a normal apply |

## Options

| Option | Description |
|---|---|
| `--to <file>` | Baseline pending files **up to and including** this one, leaving later ones pending. |
| `-y, --yes` | Skip the confirmation prompt (**required** in `--json` mode). |
| `--no-lock` | Skip the concurrency lock. **Dev only.** |
| `--json` | Emit `{ baselined, skipped, batch }` as JSON. |

Plus the [global flags](/guide/configuration#global-cli-flags).

`--json` without `--yes` is refused with `CONFIG_INVALID` (exit `6`) — JSON mode is non-interactive,
so a prompt could never be answered. An unknown `--to` filename exits with
`MIGRATION_FILE_NOT_FOUND` (code `8`).

In `--json` mode the output is:

```json
{ "baselined": ["20260601090000-create-users.js", "…"], "skipped": 3, "batch": 4 }
```

`skipped` counts the files on disk that were **not** baselined by this run — already applied, or
sorting after the `--to` target.

## Idempotent, and locked

Already-applied names are skipped, so re-running a baseline resumes it (or no-ops when there's
nothing left):

```
Nothing to baseline
```

Like every write command it runs under the [concurrency lock](/commands/unlock) — two concurrent
baselines, or a baseline racing an `up`, serialize like any other mutation.

## Forward-only safety

Baselined records are tagged `origin: 'baseline'`. migronaut never executed them, so it will not
revert them: [`migronaut down`](/commands/down) and [`migronaut redo`](/commands/redo) **refuse them
up front** with `MIGRATION_IRREVERSIBLE` (exit `13`). New migrations you author with
`migronaut create` remain fully reversible.

::: warning When NOT to use it
A baseline **asserts the database already matches the files** — it makes migronaut believe they ran.
If the migrations were never actually applied to this database (a fresh environment, a new
developer's local DB), run [`migronaut up`](/commands/up) instead and let them execute for real.
:::

::: tip Coming from migrate-mongo?
If you have an existing `migrate-mongo` `changelog` collection, don't baseline — adopt that history
as-is with [`migronaut import`](/commands/import). `baseline` is for databases with **no** prior
migration tool at all.
:::

## Programmatic API

The same capability is available on `MigratorKit`:

```ts
const summary = await migrator.baseline();   // → BaselineSummary
// { baselined: string[], skipped: number, batch: number | null }

await migrator.baseline({ to: '20260605120500-backfill.js' });  // staged adoption
```
