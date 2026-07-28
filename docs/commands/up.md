# migronaut up

Run pending migrations — all of them, or a single named file.

```bash
migronaut up [file] [options]
```

## Usage

```bash
migronaut up                      # run all pending migrations (one shared batch)
migronaut up <file>               # run a single migration by filename
migronaut up --to <file>          # run pending migrations up to and including that file
migronaut up --step               # apply each pending file as its own batch
migronaut up <file> --force --yes  # re-run an already-applied file (non-interactive)
```

## How it works

With no argument, `migronaut up` resolves every file in the migrations directory that isn't already
applied, sorted ascending, and runs them as **one batch**. A later `migronaut down` reverts that whole
batch together.

```
✔ Applied  20260605120000-add-users-index.js     [42ms]
✔ Applied  20260605120500-backfill-status.js     [128ms]
```

If there's nothing to do:

```
Nothing to migrate
```

## Options

| Option | Description |
|---|---|
| `[file]` | Run only this migration file. |
| `--to <file>` | Apply pending migrations **up to and including** this file, leaving later ones pending. |
| `--step` | Apply each pending file as its **own** sequential batch, so they can later be rolled back one at a time. |
| `-f, --force` | Re-run an **already-applied** file (requires a `[file]`). Prompts for confirmation. |
| `-y, --yes` | Skip the confirmation prompt for `--force` (required in `--json` mode). |
| `--strict` | Override config: abort on a checksum mismatch instead of warning. |
| `--no-lock` | Skip the concurrency lock. **Dev only** — warns loudly. |
| `--json` | Emit the run results as a JSON array on stdout. |

Plus the [global flags](/guide/configuration#global-cli-flags): `--uri`, `--db`, `--dir`, `--config`.

## `--to` — migrate to a point in the sequence {#migrate-to-a-point}

`--to <file>` applies every pending migration **up to and including** the named one, in filename
order, and leaves everything after it pending:

```bash
migronaut up --to 20260605120500-backfill-status.js
```

Use it to stage a release in halves, or to bring a branch's database exactly as far as that branch's
code expects — without hand-listing files.

It is **idempotent**: if the target is already applied, nothing before it is pending either, so the
command is a no-op rather than an error. Running the same `--to` twice is safe.

`--to` names a point in the sequence, so it can't be combined with `[file]`, `--steps` or `--batch` —
those are different ways of choosing the same thing. Doing so exits with a validation error before
connecting. An unknown filename exits with `MIGRATION_FILE_NOT_FOUND` (code `8`).

::: tip Round trip
[`down --to <file>`](/commands/down#roll-back-to-a-point) is the exact inverse: it reverts back to
that same point, leaving the named file applied. `up --to X` then `down --to X` returns the database
to where it was.
:::

## `--step` vs. the default batch model

```bash
migronaut up          # files A, B, C → batch 5 (all together)
migronaut up --step   # A → batch 5, B → batch 6, C → batch 7 (each its own batch)
```

Use `--step` when you want to peel migrations off individually later with
[`migronaut down --steps`](/commands/down).

## Re-running an applied migration

By default an already-applied file is skipped. `--force` re-runs its `up()` and re-records it as a new
batch. It requires a specific file (a bare `migronaut up --force` exits 6) and asks for `y/N` confirmation
first — pass `--yes` to confirm non-interactively:

```bash
migronaut up 20260605120000-add-users-index.js --force --yes
```

::: warning
`--force` bypasses the checksum-mismatch guard — re-running is the explicit intent. In `--json` mode,
`--force` without `--yes` is refused so automation never silently re-applies a migration.
:::

## Checksum behavior

Each file's SHA-256 is verified against what was recorded when it was applied. If a file changed:

- `strict: false` (default) → logs a warning and skips it.
- `strict: true` (or `--strict`) → throws `ChecksumMismatchError` and stops.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All targeted migrations applied (or nothing to do). |
| `3` | Another process holds the migration lock. |
| `4` | An applied file was edited and `--strict` is on. |
| `7` | A migration threw. The batch stops at the first error. |
| `8` | The named file (or `--to` target) doesn't exist. |
| `11` | Stopped by SIGINT/SIGTERM — see `context.results` for what was applied. |

See the [full exit-code table](/reference/cli#exit-codes) for the rest. Anything unmapped is `1`, so
a script testing `!= 0` keeps working.
