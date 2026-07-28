# Migrating from migrate-mongo

Already using [`migrate-mongo`](https://github.com/seppevs/migrate-mongo)? You can switch in under a
minute. `migronaut` adopts your existing `changelog` **as-is** — no re-running migrations, no data loss, no
rewriting files.

## The one-command switch

```bash
migronaut import     # one-time: adopt your migrate-mongo changelog (it is never modified)
migronaut up         # applies only what's new — past migrations are recognized as already applied
```

Your applied history is preserved and new migrations run normally. Your `up`/`down`/`create`/`status`
mental model carries over 1:1.

## What `migronaut import` does

`migronaut import` reads your existing `migrate-mongo` changelog collection and records that history in the
migronaut changelog, so `migronaut up` runs only what is new. It is **one-time and forward-only**, and the source
collection is **never modified**.

- `--from <collection>` — source collection (default: `changelog`).
- `--to <collection>` — target collection (default: your config's `migrationsCollection`).
- `--dry-run` — preview the mapping, write nothing.
- `--trust-hash` — reuse `migrate-mongo`'s `fileHash` instead of recomputing the checksum from disk.
- `--force` — import into a non-empty migronaut changelog (batches continue after the current max).
- `--no-lock` — skip the concurrency lock (dev only).

Each imported migration gets a unique, sequential batch number; files on disk that are **not** in the
source changelog stay pending.

See the full [`migronaut import` command reference](/commands/import).

## Forward-only safety

Imported records are tagged `origin: 'migrate-mongo'`. Because their files use `migrate-mongo`'s
positional `up(db, client)` signature — which migronaut's single-context-argument runner cannot execute
safely — `migronaut down` and `migronaut redo` **refuse them up front** (before running or writing anything) with
a clear reason. This guarantees the collection is never left half-reverted.

::: tip Going forward
New migrations you author with `migronaut create` use the modern single-context signature and are fully
reversible. Only the *imported* legacy records are forward-only.
:::

## Capability comparison

| Capability                                      | `migrate-mongo` | `migronaut` |
| ----------------------------------------------- | :-------------: | :-----------------: |
| `up` / `down` / `create` / `status`             |        ✅        |          ✅          |
| Run a single migration file                     |        ❌        |          ✅          |
| Roll back a specific batch (not just the last)  |        ❌        |          ✅          |
| Dry-run preview                                 |        ❌        |          ✅          |
| `redo` (down + up)                              |        ❌        |          ✅          |
| SHA-256 checksum / tamper detection             |        ❌        |          ✅          |
| Lifecycle hooks                                 |        ❌        |          ✅          |
| First-class TypeScript (built-in)               |        ❌        |          ✅          |
| History preserved on rollback (never deleted)   |        ❌        |          ✅          |
| Adopt an existing `migrate-mongo` changelog     |        —        | ✅ `migronaut import` |

<sub>Reflects `migrate-mongo`'s documented CLI as of mid-2026. It has since added transaction access
via a `client` argument; `migronaut` exposes the same plus a declarative per-file `useTransaction`
flag.</sub>
