# migronaut down

Roll back migrations — the last batch, a specific batch, the last N, or a single file.

```bash
migronaut down [file] [options]
```

## Usage

```bash
migronaut down                 # roll back the last batch
migronaut down <file>          # roll back a single migration by filename
migronaut down --batch <n>     # roll back every migration in batch n
migronaut down --steps <n>     # roll back the last N migrations, newest first
migronaut down --to <file>     # roll back everything applied after that file
```

## How it works

With no argument, `migronaut down` reverts the **most recent batch** — every migration that shares the
highest batch number — by calling each file's `down()` in reverse order.

```
↩ Reverted 20260605120500-backfill-status.js     [54ms]
↩ Reverted 20260605120000-add-users-index.js     [21ms]
```

History is **never deleted**: each reverted record has its `status` set to `reverted` and a
`revertedAt` timestamp, preserving the full audit trail.

## Options

| Option | Description |
|---|---|
| `[file]` | Revert only this migration file. |
| `--batch <n>` | Revert every migration in batch number `n`. |
| `--steps <n>` | Revert the **last N applied** migrations, newest first, ignoring batch grouping. |
| `--to <file>` | Revert everything applied **after** this file. The named file stays applied. |
| `--no-lock` | Skip the concurrency lock. **Dev only.** |
| `--json` | Emit the run results as a JSON array on stdout. |

Plus the [global flags](/guide/configuration#global-cli-flags).

::: warning Mutually exclusive
`--steps`, `--batch`, `--to` and a `[file]` are four different ways of choosing the same thing, so
none of them combine. Doing so exits with a validation error before connecting to the database.
:::

## `--steps` — Laravel-style rollback

`--steps <n>` reverts the last `n` applied migrations as **individual files**, newest first
(ordered by `appliedAt`), regardless of which batch they belong to:

```bash
migronaut down --steps 2   # undo the two most recently applied migrations
```

This differs from the default (revert the whole last *batch*) and from `--batch <n>` (revert one
specific batch).

## `--to` — roll back to a point in the sequence {#roll-back-to-a-point}

`--to <file>` reverts every migration applied **after** the named one, newest first. The named file
itself **stays applied** — you're rolling the database back *to* that point, not past it:

```bash
migronaut down --to 20260605120500-backfill-status.js
```

This is the exact inverse of [`migronaut up --to`](/commands/up#migrate-to-a-point):
`up --to X` followed by `down --to X` returns the database to the same state. That symmetry is why
the bound is exclusive.

The target must currently be applied — otherwise there's no point to roll back to, and the command
exits with `NotAppliedError` (code `9`) before touching anything.

## Forward-only / imported migrations

Migrations adopted via [`migronaut import`](/commands/import) are tagged `origin: 'migrate-mongo'` and are
**not reversible**. `migronaut down` preflights this and throws `IrreversibleMigrationError` **before**
touching anything, so the collection is never left half-reverted.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The targeted migrations were reverted (or there was nothing to revert). |
| `3` | Another process holds the migration lock. |
| `6` | Invalid flags — e.g. a non-integer `--batch`, or two target selectors at once. |
| `7` | A `down()` threw. The rollback stops at the first error. |
| `9` | The target isn't applied (`NotAppliedError`). |
| `13` | The target was imported from migrate-mongo and is forward-only. |

See the [full exit-code table](/reference/cli#exit-codes) for the rest.
