# migronaut import

Adopt an existing [`migrate-mongo`](https://github.com/seppevs/migrate-mongo) changelog into
`migronaut`. **One-time and forward-only** — the source collection is never modified.

```bash
migronaut import [options]
```

## Usage

```bash
migronaut import                       # adopt the migrate-mongo `changelog` collection
migronaut import --from changelog      # explicit source collection
migronaut import --to _migronaut_migrations  # explicit target collection
migronaut import --dry-run             # preview the mapping, write nothing
migronaut import --trust-hash          # reuse migrate-mongo's fileHash instead of recomputing
```

## How it works

`migronaut import` reads your `migrate-mongo` changelog and records that history in the migronaut changelog, so a
subsequent `migronaut up` runs only what's new. Files on disk that aren't in the source changelog stay
pending. Each imported migration gets a unique, sequential batch number continuing after any existing
records.

```
◎ Imported 12 migrations from `changelog` → `_migronaut_migrations`
```

## Options

| Option | Default | Description |
|---|---|---|
| `--from <collection>` | `changelog` | Source migrate-mongo collection (read-only, never modified). |
| `--to <collection>` | config `migrationsCollection` | Target migronaut collection. |
| `--dry-run` | — | Preview the mapping and write nothing. |
| `--trust-hash` | — | Reuse migrate-mongo's `fileHash` instead of recomputing the checksum from disk. |
| `--force` | — | Import into a **non-empty** migronaut changelog (batches continue after the current max). |
| `--no-lock` | — | Skip the concurrency lock. **Dev only.** |
| `--json` | — | Emit the import result as JSON. |

Plus the [global flags](/guide/configuration#global-cli-flags).

## Checksum mapping

For each imported record, the checksum is resolved as:

1. Reuse migrate-mongo's `fileHash` when it matches the on-disk SHA-256 (or always, under `--trust-hash`).
2. Otherwise recompute it from the file on disk.
3. Otherwise store `''` and warn (file missing).

## Forward-only safety

Imported records are tagged `origin: 'migrate-mongo'`. Because their files use migrate-mongo's
positional `up(db, client)` signature, [`migronaut down`](/commands/down) and [`migronaut redo`](/commands/redo)
**refuse them up front** with a clear reason — so the collection is never left half-reverted. New
migrations you author with `migronaut create` remain fully reversible.

::: warning Non-empty target
If the target collection already has records, `migronaut import` throws `ImportTargetNotEmptyError` unless
you pass `--force`. A forced re-import is stable — records being overwritten are excluded from the
batch offset.
:::

See the [migration guide](/guide/migrate-mongo) for the full switch-over walkthrough.
