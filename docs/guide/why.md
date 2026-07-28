# Why migronaut?

Most MongoDB migration tools run every pending migration, then only undo the last one.
`migronaut` gives you precise control over what runs and what rolls back — and won't leave
your database half-migrated when something fails.

::: info Where to start
**New to migrations?** Read [Core Concepts](/guide/concepts), then follow the
[Tutorial](/guide/tutorial). <br>
**Done this before?** Jump to [Getting Started](/guide/getting-started), the
[CLI Cheatsheet](/reference/cli), or the [Programmatic API](/guide/api).
:::

## Reasons to choose it

- **Zero dependencies** — no runtime dependencies at all; only the `mongodb` driver as a peer.
  Instant installs, nothing extra in your lockfile, no supply-chain surface.
- **Run a single migration** — `migronaut up <file>`, not just "all pending".
- **Roll back anything** — a batch (`--batch 3`), the last N (`--steps 2`), one file, or `redo`.
- **Preview before you run** — `migronaut dry-run up` prints the exact plan without touching the database.
- **No race conditions** — an atomic MongoDB lock stops two deploys running migrations at once.
- **Tamper detection** — SHA-256 checksums catch a migration edited after it was applied.
- **Audit trail kept** — a rollback updates the record, it never deletes it.
- **Lifecycle hooks** — `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `onError`.
- **Opt-in transactions** — wrap a migration so it fully commits or fully aborts.
- **TypeScript, ESM & CommonJS** — all run with no `ts-node` plumbing.
- **Zero config files required** — drive everything from env vars if you prefer.

## vs. migrate-mongo

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

::: tip Already on migrate-mongo?
Switch in one command — `migronaut import` adopts your existing `changelog` as-is, with no re-running and
no data loss. See [Migrating from migrate-mongo](/guide/migrate-mongo).
:::

## Next

- [vs. mongo-migrate-kit](/guide/vs-mongo-migrate-kit) — what changed since the `mmk` fork, and why.
- [Getting Started](/guide/getting-started) — install and run your first migration.
- [Writing Migrations](/guide/writing-migrations) — the `up`/`down` contract.
