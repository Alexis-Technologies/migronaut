# Why not `migrate-mongo`?

[`migrate-mongo`](https://github.com/seppevs/migrate-mongo) is the incumbent — roughly 345k weekly
downloads, and the tool that defined what a MongoDB migration CLI looks like in Node.js:
`up`/`down`/`status`/`create`, a changelog collection, transactions via a `client` argument. If you
use it, you already know it works. This page is not going to pretend otherwise.

What it is going to do is show, row by row, where `migronaut` goes further — and state plainly what
switching costs, because there are real costs.

## What `migrate-mongo` already gets right

Credit first, so the comparison below means something:

- **The core loop** — `up`, `down`, `status`, `create` — is exactly the right shape, and `migronaut`
  kept it. Your mental model carries over 1:1.
- **Transactions** are available: `up(db, client)` hands you the `MongoClient`, and you start a
  session yourself.
- **A concurrency lock exists** — opt-in, via `lockCollectionName` and `lockTtl`. Off by default,
  but it is there when you configure it.
- **File-change awareness exists** — opt-in, via `useFileHash`. Its purpose is re-running scripts
  you have edited, not enforced tamper detection, and it does that job fine.

Most of `migronaut`'s differences are not "they have nothing, we have something." They are
"theirs is optional or advisory, ours is always-on and enforced" — which matters most in the three
situations where a migration tool earns its place: under load, under failure, and under automation.

## Where `migronaut` goes further

| Capability | `migrate-mongo` | `migronaut` |
| ----------------------------------------------- | :-------------: | :-----------------: |
| `up` / `down` / `status` / `create`             |        ✅        |          ✅          |
| Transactions                                    | ✅ via the `client` argument | ✅ same, plus a per-file `useTransaction` flag |
| Concurrency lock                                | opt-in, TTL-only (`lockCollectionName`/`lockTtl`) | on by default: heartbeat renewal, owner token, abort on lock loss, `lock`/`unlock` CLI |
| Changed-file detection                          | opt-in `useFileHash` — re-runs changed scripts | enforced drift detection: per-row `checksumOk`, `up --strict`, `audit` |
| Run a single migration file                     |        ❌        | ✅ `up <file>` / `down <file>` |
| Rollback targeting                              | last applied migration | last batch, `--batch <n>`, `--steps <n>`, `--to <file>`, one file, `redo` |
| Dry-run preview                                 |        ❌        | ✅ `dry-run up` / `dry-run down` |
| Changelog record written                        | as a separate write after the migration | inside the migration's own transaction |
| History on rollback                             | record deleted   | updated to `status: 'reverted'` — never deleted |
| Out-of-order detection                          |        ❌        | `onOutOfOrder`: `warn` (default) / `error` / `allow` |
| Machine output & exit codes                     |        —        | `--json` on every data command, typed errors mapped to `EXIT_CODES` |
| Lifecycle hooks & events                        |        ❌        | 5 hooks + typed `EventEmitter` events |
| Credentials masked in output                    |        ❌        | ✅ in errors, logs and `--json` |
| App-startup runner                              | exported `up()` etc., no lock-wait | `runMigrations` with `onLockHeld: 'wait'` |
| TypeScript migration files                      |        ❌        | native `.ts` on Node ≥ 22.18, no loader |
| Runtime dependencies                            |     several     |       **0**         |
| Adopting an existing database                   |        —        | `migronaut import` (a `migrate-mongo` changelog), `baseline` (no prior tool) |

<sub>Compared against `migrate-mongo`'s documented CLI and config as of mid-2026 (v14: optional
`lockCollectionName`/`lockTtl` lock, optional `useFileHash`, transactions via the `client`
argument). Where its behavior is nuanced, the row says so instead of flattening it to ❌.</sub>

### The lock is on by default

`migrate-mongo`'s lock, when you enable it, is a TTL document: a second run is refused until the TTL
expires. Nothing renews it, and nothing proves ownership — expiry is the whole protocol, so the TTL
must outlive your slowest migration, and a crashed run blocks deploys until it lapses.

`migronaut`'s lock is on unless you pass `--no-lock` (a dev escape hatch, labeled as such). A
heartbeat renews it for as long as the migration runs, so the TTL can stay short. An owner token
proves which process holds it, so a stale lock is reclaimed safely rather than on a timer alone. If
the lock is lost mid-run — network partition, manual `unlock` — the run is aborted rather than
allowed to race a second runner. And [`migronaut lock`](/commands/lock) /
[`migronaut unlock`](/commands/unlock) let you inspect and clear it without touching the collection
by hand.

### Drift detection is enforced, not advisory

`useFileHash` and `migronaut`'s checksums sound similar but aim at different problems. `useFileHash`
exists so an edited script becomes pending again and re-runs — useful while iterating, but it means
an edit *changes what runs* rather than raising an alarm. `migronaut` treats an applied file whose
content changed as **drift**: `status` shows `checksumOk` per row, `up --strict` refuses to proceed,
and [`migronaut audit`](/commands/audit) reports it read-only for CI. An edited applied migration is
a question to answer, never something to silently re-execute.

### The changelog commits with the migration

`migrate-mongo` writes its changelog entry after the migration returns — two separate writes, so a
crash between them leaves a migration applied but unrecorded, and the next `up` runs it again. In a
transactional `migronaut` migration, the changelog record is written with the same session as your
changes: they commit together or not at all. See [Transactions](/guide/transactions).

### Built for automation

Every data command speaks `--json` on stdout while logs and the spinner go to stderr, so stdout
stays pipe-safe. Every error carries a typed code mapped to its own exit code, exported as
`EXIT_CODES` so wrapper scripts never hardcode numbers. `status --check` exits `2` when anything is
pending — a deploy gate in one line. See [CI/CD & Deployment](/guide/ci-cd) and the
[error code reference](/reference/error-codes).

### Out-of-order detection

A migration merged late from a parallel branch — timestamped *before* something already applied —
is the classic way teams corrupt ordering assumptions. `migronaut` flags it: `warn` by default,
`onOutOfOrder: 'error'` to refuse the run, `'allow'` to silence it. This safeguard is standard in
tools like Flyway on the SQL side but absent from the Node.js MongoDB migration tools, including
`migrate-mongo`.

## The honest trade-offs

Switching is not free, and two of these three points may decide it for you:

- **Node floor.** `migronaut` requires **Node.js ≥ 22.18**; `migrate-mongo` runs on far older
  releases. The floor is what buys native `.ts` migrations and dependency-free `.env` parsing, but
  if you are pinned to an older Node, that is a real cost, not a win.
- **Ecosystem depth.** `migrate-mongo` has close to a decade of Stack Overflow answers, blog posts,
  and CI recipes. `migronaut` is young with a small user base — when something goes wrong, you will
  be reading these docs and the source (which is short and ships unbundled), not a search results
  page.
- **Maintenance.** Factually: `migrate-mongo`'s release cadence has slowed in recent years, with
  long quiet stretches between versions, and community forks exist that carry dependency updates.
  It still works — its download numbers say plenty of teams are content. `migronaut` is actively
  maintained, but by a smaller team with a much shorter track record. Weigh both directions.

## Coming from `migrate-mongo`

Everything you do today has a direct counterpart:

| `migrate-mongo` | `migronaut` |
|---|---|
| `migrate-mongo init` | `migronaut init` |
| `migrate-mongo create <name>` | `migronaut create <name>` |
| `migrate-mongo up` | `migronaut up` |
| `migrate-mongo down` (last applied migration) | `migronaut down` (last batch — or `--batch`, `--steps`, `--to`, a single file) |
| `migrate-mongo status` | `migronaut status` (plus `--check`, `--json`) |
| `migrate-mongo-config.js` | `migronaut.config.{js,ts,json}` — or env vars only |
| `changelogCollectionName` | `migrationsCollection` |
| `lockCollectionName` / `lockTtl` | `lockCollection` / `lockTTLSeconds` |
| `up(db, client)` signature | `up(context)` — `{ db, client, mongoose?, session? }` |

And the switch itself is one command:

```bash
migronaut import     # one-time: adopt your migrate-mongo changelog (it is never modified)
migronaut up         # applies only what's new — past migrations are recognized as applied
```

`migronaut import` reads your existing `changelog` collection and records that history in the
`migronaut` changelog. No migrations re-run, nothing in the source collection is touched, and files
not present in the changelog stay pending.

::: warning Imported records are forward-only
Your existing files use the positional `up(db, client)` signature, which `migronaut`'s runner cannot
execute safely — so `down` and `redo` refuse imported records up front, with a clear reason, before
touching anything. Migrations you author from now on with `migronaut create` are fully reversible.
The details are in [Migrating from migrate-mongo](/guide/migrate-mongo).
:::

## Next

- [Migrating from migrate-mongo](/guide/migrate-mongo) — the step-by-step switch guide.
- [`migronaut import`](/commands/import) — full command reference.
- [Why migronaut?](/guide/why) — the whole pitch, competitor-free.
- [vs. mongo-migrate-kit](/guide/vs-mongo-migrate-kit) — how it compares to the project it forked.
