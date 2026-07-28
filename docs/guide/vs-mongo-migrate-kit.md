# Why not `mongo-migrate-kit`?

`migronaut` began as a fork of [`mongo-migrate-kit`](https://www.npmjs.com/package/mongo-migrate-kit)
(CLI `mmk`) by Santosh Gupta. It is MIT-licensed and the attribution is retained in
[LICENSE](https://github.com/Alexis-Technologies/migronaut/blob/main/LICENSE).

The fork was not a rename. Everything below landed after it, and most of it changes how the tool
behaves under load, under attack, or under automation — the three situations where a migration tool
either earns its place in a deploy pipeline or doesn't.

## What changed

| Capability | `mongo-migrate-kit` | `migronaut` |
| ----------------------------------------------- | :-------------: | :-----------------: |
| Runtime dependencies                            |    6            |      **0**          |
| Ships as                                        | bundled `dist/` | source, no build step |
| `--json` on every command                       |        ❌        |          ✅          |
| Typed exit code per error (`EXIT_CODES`)        |        ❌        |          ✅          |
| `status --check` deploy gate                    |        ❌        |          ✅          |
| `audit` — read-only health check                |        ❌        |          ✅          |
| `lock` — inspect the lock holder                |        ❌        |          ✅          |
| `up --to` / `down --to` targeting               |        ❌        |          ✅          |
| Lifecycle events (`EventEmitter`)               |        ❌        |          ✅          |
| Reuse an already-connected `MongoClient`        |        ❌        |          ✅          |
| Changelog written inside the migration's transaction | ❌         |          ✅          |
| Credentials masked in errors, logs and `--json` |        ❌        |          ✅          |
| Terminal-injection safety on DB-sourced text    |        ❌        |          ✅          |
| Pino-compatible logger                          |        ❌        |          ✅          |
| Every scalar option settable from the environment |      ❌        |          ✅          |

<sub>Compared against `mongo-migrate-kit` 1.2.2 — the version this project forked from. Each row was
checked against that source tree, not inferred from its README.</sub>

### Zero dependencies

`mongo-migrate-kit` pulls in `chalk`, `cli-table3`, `commander`, `dotenv`, `ora` and `zod`.
`migronaut`'s `package.json` has no `dependencies` key at all — every one of those was replaced with
an in-tree module. `mongodb` is a required peer, `mongoose` an optional one. Nothing else enters
your lockfile, and there is no third-party code in the process that writes to your database.

### It ships what you can read

`mongo-migrate-kit` publishes a `tsup` bundle and generated `.d.ts` files. `migronaut` publishes
`src/` as-is — plain CommonJS, with a hand-written [`index.d.ts`](https://github.com/Alexis-Technologies/migronaut/blob/main/index.d.ts).
The file you step into in a debugger is the file in the repository.

### Built for automation

Every data command speaks `--json` on stdout while human logs and the spinner go to stderr, so
stdout stays pipe-safe. Every error maps to its own exit code, exported as `EXIT_CODES` so a wrapper
script never hardcodes numbers. `status --check` exits `2` when anything is pending, which is the
whole deploy gate in one line. See [CI/CD & Deployment](/guide/ci-cd).

### Safer under failure

The changelog record is written inside the migration's own transaction, so a crash between commit
and record can no longer leave a migration applied but unrecorded. Connection-string passwords are
masked everywhere a string leaves the process. Control characters in values read back from the
database — descriptions, filenames, lock-holder fields — are stripped before they reach your
terminal.

## What stayed the same

The parts that were already right were kept, and your migration files do not need rewriting:

- The `up(context)` / `down(context)` contract, with the same `{ db, client, mongoose?, session? }`
  context object.
- `.ts`, ESM and CommonJS migration files, and the `export const useTransaction = true` per-file flag.
- Batches, `--batch` / `--steps` rollback, SHA-256 checksums, and the append-only changelog that
  updates a record on revert rather than deleting it.
- The five lifecycle hooks: `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `onError`.
- The MongoDB-native lock with TTL-based stale reclaim and heartbeat renewal.
- Config files that may export a factory function, for pulling a URI from a secret manager.

## Coming from `mmk`

Everything `mmk`-named has a `migronaut`-named counterpart:

| `mongo-migrate-kit` / `mmk` | `migronaut` |
|---|---|
| npm package `mongo-migrate-kit` | `@alexify/migronaut` |
| CLI binary `mmk` | `migronaut` |
| Env vars `MMK_*` | `MIGRONAUT_*` |
| `mmk.config.{ts,js,json}` | `migronaut.config.{ts,js,json}` |
| `MmkConfig`, `MmkConfigInput`, `MmkLogger`, `MmkErrorCode` | `MigronautConfig`, `MigronautConfigInput`, `MigronautLogger`, `MigronautErrorCode` |
| `MmkError` | `MigronautError` |
| `_mmk_migrations`, `_mmk_locks` | `_migronaut_migrations`, `_migronaut_locks` |

::: warning The collection names differ
`migronaut` reads `_migronaut_migrations`, not `_mmk_migrations`, so it will see an `mmk` project as
having zero applied migrations. Point it at the existing collection instead of re-running anything:

```bash
migronaut up --config ./migronaut.config.js
```

with `migrationsCollection: '_mmk_migrations'` and `lockCollection: '_mmk_locks'` in that config —
or set `MIGRONAUT_COLLECTION` and `MIGRONAUT_LOCK_COLLECTION`. The record shape is a compatible
superset of `mmk`'s (`firstAppliedAt` and `runId` were added, both optional), so `migronaut status`
reads an `mmk` changelog directly and rollbacks keep working.

`migronaut import` is **not** the tool for this — it adopts a `migrate-mongo` changelog, whose shape
is different, and marks the records forward-only.
:::

::: info One trade-off, stated plainly
`migronaut` requires **Node.js ≥ 22.18**; `mongo-migrate-kit` runs on ≥ 18. That floor is what buys
`.ts` migrations with no loader and `.env` parsing with no dependency — both are built-ins from
22.18 on. If you are pinned to an older Node, this is a real cost, not a win.
:::

## Next

- [Why migronaut?](/guide/why) — how it compares to `migrate-mongo`.
- [Getting Started](/guide/getting-started) — install and run your first migration.
