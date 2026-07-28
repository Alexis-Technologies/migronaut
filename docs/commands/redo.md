# migronaut redo

Roll back then re-apply a migration in one step — the last applied, or a specific file.

```bash
migronaut redo [file] [options]
```

## Usage

```bash
migronaut redo            # down + up the most recently applied migration
migronaut redo <file>     # down + up a specific migration
```

## How it works

`migronaut redo` runs `down()` then `up()` for the target. It's the fast loop for iterating on a migration
during development:

```
↩ Reverted 20260605120000-add-users-index.js     [18ms]
✔ Applied  20260605120000-add-users-index.js     [40ms]
```

## Options

| Option | Description |
|---|---|
| `[file]` | Redo a specific migration file instead of the last applied one. |
| `--no-lock` | Skip the concurrency lock. **Dev only.** |
| `--json` | Emit the run results as a JSON array on stdout. |

Plus the [global flags](/guide/configuration#global-cli-flags).

## Notes

- `redo` inherits the [forward-only guard](/commands/down#forward-only-imported-migrations): an
  imported `migrate-mongo` record cannot be redone and is rejected up front.
- Because the `down` half reverts the record and the `up` half re-applies it, the audit trail keeps
  both events.
- Both halves run under **one** lock. No other process can slip in between the revert and the
  re-apply, so the migration is never left in the reverted state by a competing run.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The migration was reverted and re-applied. |
| `3` | Another process holds the migration lock. |
| `7` | Either half threw. |
| `9` | The target isn't applied. |
| `13` | The target was imported from migrate-mongo and is forward-only. |

See the [full exit-code table](/reference/cli#exit-codes) for the rest.
