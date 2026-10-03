# migronaut converge

Bring the [declared collections](/guide/collections) — their indexes and validators — to their
declared state.

```bash
migronaut converge [options]
```

## Why it exists

An index or a validator has a current value, not a history. Rather than a migration file per
change, declare the end state in `collections` (or one file per collection in `collectionsDir`)
and let converge compare it with the live database and make the difference. It is stateless:
every run reads the database afresh, and the [history](/guide/collections#history) it keeps is for
you — no run reads it back.

## Usage

```bash
migronaut converge --dry-run   # show what would change, change nothing
migronaut converge --check     # exit 28 if anything would change — a CI gate
migronaut converge             # plan, ask before any drop or rebuild, then apply
migronaut converge --prune     # also drop indexes a definition does not declare
migronaut converge --ordered   # refuse while a migration is still pending
migronaut converge --reason "TICKET-123"  # why — recorded in the converge history
migronaut converge --history   # what converge has changed, newest first (read-only)
migronaut converge --yes       # no confirmation
migronaut converge --rebuild-unique  # allow rebuilding a unique index (see below)
```

Without `--yes`, converge plans first. A plan that only creates indexes or modifies them in place is
applied straight away; one that would **drop or rebuild an index**, or **change the validator of a
collection that already exists** (tightening one can start rejecting your application's writes),
is shown, then confirmed. A plan with a conflict is refused without asking:

```
◎ Planned  2 change(s) in 1 of 2 collection(s)
┌────────────┬────────┬─────────────┬──────────┬────────────────────┐
│ Collection │ Target │ Index       │ Action   │ Detail             │
├────────────┼────────┼─────────────┼──────────┼────────────────────┤
│ users      │ index  │ email_1     │ recreate │ unique             │
│ users      │ index  │ createdAt_1 │ modify   │ expireAfterSeconds │
└────────────┴────────┴─────────────┴──────────┴────────────────────┘
Would make 2 change(s) in 1 of 2 collection(s) · 1 drop/rebuild · 2 unchanged
Apply these changes? [y/N] y
✔ Modified index createdAt_1 on users   [6ms]
✔ Rebuilt  index email_1 on users   [17ms]
✔ Converged 2 change(s) in 1 of 2 collection(s) in 31ms
```

Rows that need nothing are folded into the summary; `--verbose` lists them too.

## Options

| Option | Description |
|---|---|
| `--dry-run` | Plan and print, change nothing. Takes no lock. |
| `--check` | Like `--dry-run`, then exit `28` (`COLLECTIONS_DRIFT`) if anything would change or conflict. An undeclared index kept with prune off is not drift. |
| `--prune` | Drop indexes a definition does not declare — in collections whose definition does not set `prune` itself. With `indexes: []` that is every index but `_id`, and converge warns. |
| `--ordered` | Refuse (`MIGRATION_BLOCKED`, exit `24`) while any migration is still pending — checked under the lock. |
| `--reason <text>` | Why — recorded in the [converge history](/guide/collections#history) with the run. |
| `--history` | Show the converge history instead of converging: when, triggered how, who asked and why, how many changes. `--json` prints the full entries, with every row's `from` / `to`. |
| `--limit <n>` | With `--history`: how many entries (default 20, at most 1000). |
| `-y, --yes` | Apply drops, rebuilds and validator changes without asking. **Required** for them with `--json`. |
| `--rebuild-unique` | Allow a rebuild that drops a unique index and builds a unique one back. Without it such a rebuild is a `conflict`. |
| `--no-lock` | Skip the concurrency lock. **Dev only.** |
| `--json` | Print the converge result as JSON. |

Plus the [global flags](/guide/configuration#global-cli-flags).

### Rebuilding a unique index

A rebuild drops the index before it builds the new one. For a unique index that means **no
constraint at all** until the build ends — and a duplicate written in that window makes both the
new index and the old one unbuildable, leaving the collection with neither. So a plan that would
rebuild a unique index (and keep it unique) is a `conflict` that refuses the run, unless you pass
`--rebuild-unique` (`converge({ rebuildUnique: true })` in code). The safe path needs no flag:
declare the changed index under a **new name**, converge, then remove the old declaration and
converge with `--prune`. A converge after `up` and a queue job never pass the flag.

`--json` without `--yes` applies a plan that only creates or modifies indexes; a plan that would
drop or rebuild an index, or change an existing collection's validator, is refused with
`CONFIG_INVALID` (exit `6`), listing those actions in
`error.context.destructive` — so a pipeline can apply "only if safe". A closed stdin at the prompt
is refused the same way.

## Output

`--json` prints the result:

```json
{
  "dryRun": false,
  "changed": 2,
  "inSync": true,
  "collections": [
    {
      "name": "users",
      "actions": [
        {
          "target": "index", "name": "email_1", "action": "recreate", "reason": "unique",
          "from": { "key": { "email": 1 }, "name": "email_1" },
          "to": { "key": { "email": 1 }, "name": "email_1", "unique": true },
          "status": "applied", "durationMs": 17
        },
        {
          "target": "index", "name": "createdAt_1", "action": "modify", "reason": "expireAfterSeconds",
          "from": { "key": { "createdAt": 1 }, "name": "createdAt_1", "expireAfterSeconds": 3600 },
          "to": { "key": { "createdAt": 1 }, "name": "createdAt_1", "expireAfterSeconds": 86400 },
          "status": "applied", "durationMs": 6
        }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `dryRun` | `true` for `--dry-run` / `--check` |
| `changed` | Changes applied — or, in a dry run, changes that would be |
| `inSync` | Nothing left to do and no conflict |
| `collections[].actions[].action` | `create`, `modify`, `recreate`, `drop`, `keep`, `unchanged`, `conflict` |
| `collections[].actions[].status` | `planned` (dry run), `applied`, `failed`, `skipped` (nothing to do, or not reached) |
| `collections[].actions[].from` / `.to` | What is there now, and what the row puts there — the index (`{ key, name, …options }`) or the validator (`{ validator, validationLevel, validationAction }`) |
| `unstable` | Present when something applied still compares as changed afterwards |

## Exit codes

| Code | When |
|---|---|
| `0` | Converged, already in sync, or the confirmation was declined |
| `3` | `LOCK_ALREADY_HELD` — another run holds the lock (a dry run still works) |
| `6` | `CONFIG_INVALID` — a bad definition, or a destructive plan without `--yes` in `--json` mode |
| `11` | `RUN_ABORTED` — stopped by a signal, between steps or at the prompt |
| `27` | `CONVERGE_FAILED` — a conflict refused the plan, or a step failed |
| `28` | `COLLECTIONS_DRIFT` — `--check` found work to do |

On `27`, `--json` prints the usual error document; `error.context.converge` holds the result so
far, and `error.context.hint` what usually fixes the server error behind it.

## Locked, and refused on conflict

A real run holds the migration lock, like `up`. A plan with a [conflict](/guide/collections#conflicts)
— an undeclared index covering a declared one's key under another name, a view, a time-series
collection — is refused before anything is written.

## After `up`

Set `convergeAfterUp: true` and every bulk `migronaut up` ends by converging, under the same
lock. `migronaut up --converge` / `--no-converge` override it for one run. See
[After every deploy](/guide/collections#after-every-deploy).

## Programmatic API

```js
const result = await kit.converge();                 // under the lock
const plan = await kit.converge({ dryRun: true });   // no lock, no writes
await kit.converge({ prune: true });
```

See [Declared Collections](/guide/collections) for the definition format and the rules.
