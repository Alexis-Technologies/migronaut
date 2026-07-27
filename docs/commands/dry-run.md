# migronaut dry-run

Preview what `up` or `down` would do — **without ever touching the database**.

```bash
migronaut dry-run <up|down> [file] [options]
```

## Usage

```bash
migronaut dry-run up               # preview every pending migration that would apply
migronaut dry-run up <file>        # preview a single file
migronaut dry-run up --to <file>   # preview a staged rollout up to (and including) a file
migronaut dry-run down             # preview reverting the last batch
migronaut dry-run down --steps <n> # preview reverting the last N migrations
migronaut dry-run down --batch <n> # preview reverting a specific batch
migronaut dry-run down --to <file> # preview reverting everything applied after a file
```

## How it works

`dry-run` resolves exactly the same set of files the real command would, and prints the plan — but it
**never connects for writes, acquires no lock, and changes nothing**. It's the safe way to confirm a
production run before committing to it.

```
◎ Dry-run  Would apply 2 migrations:
   • 20260605120000-add-users-index.js
   • 20260605120500-backfill-status.js
```

## Options

| Option | Description |
|---|---|
| `up \| down` | **Required.** Direction to preview. |
| `[file]` | Preview a single migration file. |
| `--steps <n>` | (down only) Preview reverting the last N migrations. |
| `--batch <n>` | (down only) Preview reverting a specific batch. |
| `--to <file>` | Preview migrating to this file — inclusive for `up`, exclusive for `down`, mirroring the real commands. |
| `--json` | Emit the planned rows as JSON. |

Plus the [global flags](/guide/configuration#global-cli-flags).

::: tip Read-only
Because a dry-run never writes, it takes no concurrency lock and is always safe to run against
production.
:::
