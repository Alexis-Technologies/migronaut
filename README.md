<div align="center">

<img src="assets/logo-icon-b-alt2.png" alt="@alexify/migronaut" width="420" />

# migronaut

**Elegant, fast, fully-typed MongoDB migrations for Node.js.**

_A modern, drop-in replacement for `migrate-mongo` etc._

[![npm version](https://img.shields.io/npm/v/%40alexify%2Fmigronaut?style=flat-square&color=1E9E57&logo=npm&logoColor=white)](https://www.npmjs.com/package/@alexify/migronaut)
[![Docs](https://img.shields.io/badge/docs-online-1E9E57?style=flat-square&logo=readthedocs&logoColor=white)](https://migronaut.vercel.app/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-1E9E57?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Known Vulnerabilities](https://snyk.io/test/npm/@alexify/migronaut/badge.svg)](https://snyk.io/test/npm/@alexify/migronaut)
[![License: MIT](https://img.shields.io/badge/License-MIT-1E9E57?style=flat-square)](https://opensource.org/licenses/MIT)


Precise, safe migrations for MongoDB. Run a single file, roll back anything, and preview every
change before it touches your database.

### 📖 [Read the documentation →](https://migronaut.vercel.app/)

</div>

---

## Reasons to choose it

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

### How it compares to `migrate-mongo`

| Capability                                      | `migrate-mongo` | `migronaut` |
| ----------------------------------------------- | :-------------: | :-----------------: |
| Run a single migration file                     |        ❌        |          ✅          |
| Roll back a specific batch (not just the last)  |        ❌        |          ✅          |
| Dry-run preview                                 |        ❌        |          ✅          |
| `redo` (down + up)                              |        ❌        |          ✅          |
| Checksum / tamper detection                     |        ❌        |          ✅          |
| Lifecycle hooks                                 |        ❌        |          ✅          |
| First-class TypeScript (built-in)               |        ❌        |          ✅          |
| History kept on rollback (never deleted)        |        ❌        |          ✅          |
| Adopt an existing `migrate-mongo` changelog | — | ✅ `migronaut import` |

<sub>Reflects `migrate-mongo`'s documented CLI as of mid-2026. It has since added transaction access
via a `client` argument; `migronaut` exposes the same plus a declarative per-file `useTransaction` flag.</sub>

> [!TIP]
> ### 🔄 Already using `migrate-mongo`? Switch in under a minute.
>
> `migronaut` adopts your existing `changelog` **as-is** — no re-running migrations, no data loss, no rewriting
> files. Point it at the same database and bring your whole history over in one command:
>
> ```bash
> migronaut import     # one-time: adopt your migrate-mongo changelog (it's never modified)
> migronaut up         # applies only what's new — your past migrations are recognized as already applied
> ```
>
> Your applied history is preserved and new migrations run normally. Your `up`/`down`/`create`/`status`
> mental model carries over 1:1 — you just gain dry-runs, single-file control, real rollbacks, hooks,
> and locking. → **[See how it works](#advanced-features)**

---

## Quick start

```bash
npm install @alexify/migronaut
npm install mongodb          # required peer dependency
```

```bash
# 1 · create a configuration file migronaut.config.*. (pass --ts if need ts file)
npx migronaut init

# 2 · create your first migration
npx migronaut create "add users email index"

# 3 · run everything pending
npx migronaut up

# 4 · see where you stand
npx migronaut status
```

A migration is just an `up` and a `down`:

```ts
import type { MigrationContext } from '@alexify/migronaut';

export const description = 'Add unique index on users.email';

export async function up({ db }: MigrationContext): Promise<void> {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
}

export async function down({ db }: MigrationContext): Promise<void> {
  await db.collection('users').dropIndex('email_1');
}
```

> Prefer no files at all? Skip `migronaut init` and export `MIGRONAUT_URI` and `MIGRONAUT_DB` — that is enough to run.

---

## Documentation

Full docs, guides, and the API reference live at
**[migronaut.vercel.app](https://migronaut.vercel.app/)**.

- [Why migronaut?](https://migronaut.vercel.app/guide/why) — how it compares to `migrate-mongo`
- [Core Concepts](https://migronaut.vercel.app/guide/concepts) — migrations, batches, the changelog, locking
- [Getting Started](https://migronaut.vercel.app/guide/getting-started) & [Tutorial](https://migronaut.vercel.app/guide/tutorial)
- [Configuration](https://migronaut.vercel.app/guide/configuration) · [Writing Migrations](https://migronaut.vercel.app/guide/writing-migrations) · [Transactions](https://migronaut.vercel.app/guide/transactions) · [Hooks](https://migronaut.vercel.app/guide/hooks)
- [Programmatic API](https://migronaut.vercel.app/guide/api) · [CI/CD](https://migronaut.vercel.app/guide/ci-cd) · [Troubleshooting](https://migronaut.vercel.app/guide/troubleshooting)
- Reference: [CLI Cheatsheet](https://migronaut.vercel.app/reference/cli) · [Error Codes](https://migronaut.vercel.app/reference/error-codes)

---

## Commands

Every command accepts the global flags `--uri`, `--db`, `--dir`, and `--config`.

| Command | What it does |
|---|---|
| `migronaut init` | Create a documented `migronaut.config.*` in the current directory |
| `migronaut import` | Adopt an existing `migrate-mongo` changelog (one-time, forward-only) |
| `migronaut create <name>` | Generate a timestamped migration file |
| `migronaut up [file]` | Run all pending migrations, or one named file |
| `migronaut down [file]` | Roll back the last batch, a chosen batch, the last N steps, or one file |
| `migronaut redo [file]` | Roll back then re-apply (the last migration, or one file) |
| `migronaut status` | Print the full migration status table (`--check` to fail CI on pending) |
| `migronaut list` | List migrations, filtered by status |
| `migronaut dry-run <up\|down> [file]` | Preview a run without touching the database |
| `migronaut unlock` | Force-release a stuck lock left behind by a crashed run |

Most data commands (`up`, `down`, `redo`, `status`, `list`, `dry-run`, `import`, `create`,
`unlock`) accept **`--json`** for machine-readable output — see [CI & automation](#ci--automation).

<details>
<summary><b>Options for every command</b></summary>

```bash
# init — generate a config file
migronaut init                     # migronaut.config.js (default)
migronaut init --js                # migronaut.config.js (explicit default)
migronaut init --ts                # migronaut.config.ts
migronaut init --json              # migronaut.config.json  (NOTE: here --json picks the file format)
migronaut init --secret-provider   # async config that loads the URI from a secret manager (js/ts only)
migronaut init --force             # overwrite an existing config file
migronaut init --uri mongodb://localhost:27017 --db my_app   # prefill the generated config

# import — adopt an existing migrate-mongo changelog
migronaut import                   # read `changelog`, write the migronaut changelog
migronaut import --from <name>     # read a differently-named source collection
migronaut import --to <name>       # write to a specific collection (default: config migrationsCollection)
migronaut import --dry-run         # preview the mapping, write nothing
migronaut import --trust-hash      # reuse migrate-mongo's fileHash instead of recomputing
migronaut import --force           # proceed even if the migronaut changelog already has records
migronaut import --no-lock         # skip the concurrency lock (local dev only)
migronaut import --json            # machine-readable output

# create — generate a migration file
migronaut create <name>            # file type follows config `createExtension` (default .js)
migronaut create <name> --ts       # force a .ts file
migronaut create <name> --js       # force a .js file
migronaut create <name> --template <path>   # use a custom template
migronaut create <name> --json     # machine-readable output ({ "path": "..." })

# up — apply migrations
migronaut up                       # all pending (one shared batch for the run)
migronaut up <file>                # one specific file
migronaut up --step                # apply each file as its own batch (revert individually later)
migronaut up <file> --force        # re-run an ALREADY-applied file (asks for confirmation)
migronaut up <file> --force --yes  # confirm a re-run non-interactively (required with --json)
migronaut up --strict              # abort on any checksum mismatch
migronaut up --no-lock             # skip the concurrency lock (local dev only)
migronaut up --json                # machine-readable output (array of run results)

# down — roll back
migronaut down                     # the last batch (may be several files)
migronaut down <file>              # one specific file
migronaut down --batch <n>         # a specific batch number
migronaut down --steps <n>         # the last N migrations, newest first, ignoring batches
migronaut down --no-lock           # skip the concurrency lock (local dev only)
migronaut down --json              # machine-readable output (array of run results)

# redo — down then up
migronaut redo                     # the most recently applied migration
migronaut redo <file>              # a specific file
migronaut redo --json              # machine-readable output (array of run results)

# status — full status table
migronaut status                   # the full status table
migronaut status --check           # exit 1 if any migration is pending (CI gate)
migronaut status --json            # machine-readable output (array of status rows)

# list — filtered status
migronaut list                     # all migrations
migronaut list --pending           # only pending
migronaut list --applied           # only applied
migronaut list --json              # machine-readable output (array of status rows)

# dry-run — preview, never writes
migronaut dry-run up [file]
migronaut dry-run down [file]
migronaut dry-run down --steps <n> # preview a step rollback (the last N migrations)
migronaut dry-run up --json        # machine-readable output (array of status rows)

# unlock — clear a stuck lock after a crash
migronaut unlock                   # shows the holder, prompts y/N
migronaut unlock --yes             # skip the prompt
migronaut unlock --json            # machine-readable output ({ "released": ..., "holder": ... })
```

**Global flags** (available on all commands): `--uri <uri>` (override `MIGRONAUT_URI`),
`--db <name>` (override `MIGRONAUT_DB`), `--dir <path>` (override `MIGRONAUT_MIGRATIONS_DIR`),
`--config <path>` (explicit config file, overrides auto-discovery).

**`--json`** is accepted by every data command above (`up`, `down`, `redo`, `status`, `list`,
`dry-run`, `import`, `create`, `unlock`) and prints one JSON document to stdout — see
[CI & automation](#ci--automation). On `migronaut init` only, `--json` instead selects the config
**file format** (`migronaut.config.json`).

</details>

---

## Advanced features

<details id="migrating-from-migrate-mongo">
<summary><b>Migrating from <code>migrate-mongo</code></b> — adopt an existing changelog with <code>migronaut import</code></summary>

<br>

`migronaut import` reads your existing `migrate-mongo` changelog and records that history in the `migronaut`
changelog, so `migronaut up` knows what is already applied and runs only what is new. It is a **one-time,
forward-only** step.

```bash
# point migronaut at the same database, then:
migronaut import --dry-run     # preview the mapping first (writes nothing)
migronaut import               # adopt the history
migronaut up                   # apply only the migrations added since
```

**What it does**

- Reads the source collection (`changelog` by default; `--from` to override) and **never modifies it** —
  the mapped records are written to the `migronaut` changelog (your config's `migrationsCollection`,
  `_migronaut_migrations` by default; `--to` to write to a different collection).
- Maps `fileName → name`, `appliedAt → appliedAt`, and resolves a checksum: it reuses `migrate-mongo`'s
  `fileHash` when it matches the file on disk, otherwise recomputes a SHA-256 from disk (`--trust-hash`
  reuses the stored hash as-is). Records whose files are missing are still imported.
- Assigns each migration a **unique, sequential batch number** in apply order. If the `migronaut` changelog
  already has records, imported batches **continue after** the existing maximum (use `--force` to import
  into a non-empty changelog).
- Leaves migration files that exist on disk but are **not** in the source changelog **pending** — they
  run on the next `migronaut up`, exactly as expected for newly added migrations.

**Options**

| Flag | Default | What it does |
|---|---|---|
| `--from <collection>` | `changelog` | Source collection to read (never modified). |
| `--to <collection>` | config `migrationsCollection` (`_migronaut_migrations`) | Target collection to write the adopted history to. |
| `--dry-run` | off | Preview the mapping and print the table; writes nothing. |
| `--trust-hash` | off | Reuse `migrate-mongo`'s stored `fileHash` as-is instead of recomputing the checksum from disk. |
| `--force` | off | Import into a changelog that already has records (imported batches continue after the existing max). |
| `--no-lock` | off | Skip the MongoDB concurrency lock (local dev only). |

Plus the global flags `--uri`, `--db`, `--dir`, and `--config`.

**Forward-only — imported migrations cannot be rolled back**

Adopted records are tagged `origin: 'migrate-mongo'`. `migrate-mongo` files use a positional
`up(db, client)` signature, which `migronaut` does not execute (it passes a single context object). To avoid
ever corrupting your data, `migronaut down` / `migronaut redo` **refuse** an imported migration up front, before
running or writing anything, and tell you why:

```text
✖ Cannot roll back 1 migrate-mongo-imported migration(s): 20260101-add-index.js
```

If you need an old migration to be reversible under `migronaut`, re-author its file in the native format
(named exports, single context argument — see [Migration file formats](#migration-file-formats)).

</details>

<details>
<summary><b>Transactions</b> — wrap a migration in an all-or-nothing MongoDB transaction</summary>

<br>

Opt in per file with `export const useTransaction = true` (or globally via config). The runner opens a
session, passes it through the context, and commits on success or aborts on any error. Pass the
`session` to every operation so it joins the transaction:

```ts
export const useTransaction = true;

export async function up({ db, session }: MigrationContext): Promise<void> {
  await db.collection('accounts').insertOne({ balance: 100 }, { session });
  await db.collection('ledger').insertOne({ delta: 100 }, { session });
}
```

> Transactions require a replica set or sharded cluster — MongoDB's own requirement, not a library limit.

</details>

<details>
<summary><b>Lifecycle hooks</b> — run code around the batch and each migration</summary>

<br>

Define hooks in your config file. Use them to seed data, emit metrics, or alert on failure:

```ts
hooks: {
  beforeAll:  async (ctx) => { /* once, before the batch */ },
  afterAll:   async (ctx) => { /* once, after the batch */ },
  beforeEach: async (name, ctx) => { /* before each file */ },
  afterEach:  async (name, durationMs, ctx) => { /* after each file */ },
  onError:    async (name, error, ctx) => { /* a file threw — alert, then it re-throws */ },
}
```

</details>

<details>
<summary><b>Loading secrets at runtime</b> — AWS, Google, Vault, Azure, anything</summary>

<br>

A `.ts`/`.js` config may export a **function** (sync or async) instead of an object.
`migronaut` calls it once per command, so you can fetch the connection from a secret manager at run time.
The secret is **never written to disk**, and a rotated value is picked up automatically on the next run.

The library ships **no** cloud SDKs — you bring the one you already use, so any provider works:

```js
// migronaut.config.js — AWS Secrets Manager
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export default async () => {
  const sm = new SecretsManagerClient({ region: 'us-east-1' });
  const res = await sm.send(new GetSecretValueCommand({ SecretId: 'prod/mongo' }));
  const { uri, dbName } = JSON.parse(res.SecretString ?? '{}');
  return { uri, dbName };  // merged at the config-file tier — env vars / flags still override
};
```

Run `migronaut init --secret-provider` to scaffold this form with an AWS example you can swap for any provider.
If the function throws, it surfaces as a `ConfigInvalidError` with the cause attached.

</details>

<details>
<summary><b>Batches &amp; step rollback</b> — group a deploy, or revert file-by-file</summary>

<br>

A **batch** is one `migronaut up` run. By default every migration applied in a single run shares one batch
number, so `migronaut down` rolls back that whole run as a unit — the same model used by **Laravel** and
**Knex**. That keeps a deploy atomic: one command applied it, one command reverts it.

When you want finer control, two flags mirror Laravel's `migrate --step` / `migrate:rollback --step`:

- **`migronaut up --step`** — apply each file in the run as its **own** sequential batch instead of one shared
  batch. A later `migronaut down` then peels them off one at a time.
- **`migronaut down --steps <n>`** — revert the **last N applied migrations**, newest first, counted as
  individual files **regardless of batch**. `migronaut down --steps 1` reverts just the single most-recently
  applied migration; a larger N can cross batch boundaries, so preview it first with
  `migronaut dry-run down --steps <n>`.

`--steps` is mutually exclusive with `--batch` and a filename. Migrations are always reverted
newest-first, so `up` followed by `down --steps <same n>` returns you to the starting state.

</details>

<details>
<summary><b>Concurrency lock &amp; checksums</b> — safe concurrent deploys, tamper detection</summary>

<br>

**Lock.** Each run acquires an atomic lock document in `_migronaut_locks`, so two deploys can never migrate
at once. A lock older than `lockTTLSeconds` is treated as stale and reclaimed; while a migration runs,
a heartbeat renews the lock at half the TTL so a long migration can't have its lock stolen mid-run.
The lock is always released in a `finally` block. `--no-lock` bypasses it for local development (and
warns loudly). If a process crashes hard and leaves a lock behind, clear it with **`migronaut unlock`** (it
shows you who held it and asks for confirmation).

**Checksums.** Every applied migration stores a SHA-256 of its file. On later runs `migronaut` compares the
two and surfaces drift in `status`. With `strict: true` (or `--strict`) a mismatch aborts the run;
otherwise it warns and skips. To intentionally re-run an edited, already-applied file, use
`migronaut up <file> --force`.

</details>

<details id="ci--automation">
<summary><b>CI &amp; automation</b> — JSON output, deploy gates, scripting</summary>

<br>

**Machine-readable output.** Add `--json` to any data command (`up`, `down`, `redo`, `status`,
`list`, `dry-run`, `import`, `create`, `unlock`) to get a single JSON document on **stdout** — all
human logs and the spinner are redirected to stderr, so the stream is safe to pipe into `jq` or parse
in a script. On failure the command prints `{ "error": { "code": "...", "message": "..." } }` to
stdout and exits `1`.

```bash
# Apply pending migrations and capture the result in CI
migronaut up --json | jq '.[] | select(.status == "applied") | .file'

# Fail a deploy step if the database isn't fully migrated
migronaut status --check          # exits 1 when anything is pending, 0 otherwise

# Inspect status as data
migronaut status --json | jq 'map(select(.status == "pending")) | length'
```

A typical pipeline gate:

```yaml
# .github/workflows/deploy.yml (excerpt)
- name: Fail if migrations are pending
  run: npx migronaut status --check --uri "$MONGO_URI" --db "$MONGO_DB"
```

> Note: `migronaut init --json` is the one exception — there `--json` means "write `migronaut.config.json`",
> not machine-readable output (kept for backwards compatibility).

</details>

<details>
<summary><b>Audit trail</b> — a complete, append-only history</summary>

<br>

Every record in `_migronaut_migrations` stores `batch`, `status`, `appliedAt`, `revertedAt`, `duration`,
`checksum`, `environment`, and `executedBy`. Rolling back **updates** a record's status to `reverted`
and stamps `revertedAt` — it is **never deleted**, so the full history stays intact for compliance.

</details>

<details>
<summary><b>Programmatic API</b> — run migrations from your own code</summary>

<br>

#### Run pending migrations on app start

`runMigrations()` is the blessed one-call entry point. It opens its own connection, applies every
pending migration, and **always disconnects** — even if a migration throws, so a failed boot never
leaks a MongoDB connection. A failing migration aborts startup instead of letting your app serve
traffic against a half-migrated database:

```ts
import { runMigrations } from '@alexify/migronaut';

// Call this before your server starts listening.
const { applied, upToDate } = await runMigrations({
  uri: process.env.MONGO_URI!,
  dbName: 'my_app',
  migrationsDir: './migrations',
});

if (!upToDate) console.log(`Applied ${applied.length} migration(s)`);
// then: app.listen(...)
```

#### Multiple instances booting together

When several instances start at once, only one wins the lock. Set `onLockHeld: 'wait'` so the others
block until the migrating peer finishes, then confirm there's nothing left to apply before returning:

```ts
await runMigrations(
  { uri: process.env.MONGO_URI!, dbName: 'my_app' },
  { onLockHeld: 'wait', lockWaitTimeoutMs: 30_000 }, // default 'throw'
);
```

#### Serverless / cold start

The same call works in a Lambda/Cloud Function bootstrap. Keep `onLockHeld: 'wait'` so concurrent
cold starts don't fail, and rely on the auto-disconnect so each invocation cleans up after itself.

#### Fail a deploy/health check when the DB is behind (no writes)

`pendingMigrations()` is a connection-managed, read-only readiness probe:

```ts
import { pendingMigrations } from '@alexify/migronaut';

const pending = await pendingMigrations({ uri, dbName: 'my_app' });
if (pending.length > 0) {
  throw new Error(`Database is behind by ${pending.length} migration(s)`);
}
```

#### Full control

For everything else, every CLI command is a method on `MigratorKit` (you manage the lifecycle):

```ts
import { MigratorKit } from '@alexify/migronaut';

const migrator = new MigratorKit({ uri, dbName: 'my_app', migrationsDir: './migrations' });
await migrator.connect();
const rows = await migrator.status();   // StatusRow[]
await migrator.disconnect();
```

All errors extend `MigronautError` and carry a typed `code` (`LOCK_ALREADY_HELD`, `CHECKSUM_MISMATCH`,
`NOT_APPLIED`, …), so `catch` blocks stay type-safe.

</details>

---

## Configuration

`migronaut` resolves settings in this order (**highest wins**):

> **CLI flags → environment variables → config file → built-in defaults**

A config file is optional and auto-discovered in the working directory as `migronaut.config.ts`,
`migronaut.config.js`, or `migronaut.config.json`. Run `migronaut init` to generate one — it ships fully commented,
so every setting lives in one documented place:

```js
// migronaut.config.js — generated by `migronaut init`, every option explained
/** @type {import('@alexify/migronaut').MigronautConfig} */
export default {
  // ── Connection (required) ───────────────────────────────────────────────
  uri: 'mongodb://localhost:27017', // MongoDB connection string
  dbName: 'my_app',                 // database to run migrations against

  // ── Files ───────────────────────────────────────────────────────────────
  migrationsDir: './migrations',    // where migration files live
  fileExtensions: ['.ts', '.js'],   // which files count as migrations
  createExtension: 'js',            // default type for `migronaut create` ('js' | 'ts'); --js/--ts override
  sequential: false,                // true → 0001-style numbering instead of timestamps
  // templatePath: './migration.template.ts', // custom template for `migronaut create`

  // ── Bookkeeping collections ─────────────────────────────────────────────
  migrationsCollection: '_migronaut_migrations', // the append-only audit trail
  lockCollection: '_migronaut_locks',            // the concurrency lock
  lockTTLSeconds: 60,                       // a lock older than this is reclaimable

  // ── Safety ──────────────────────────────────────────────────────────────
  strict: false,        // true → abort on a checksum mismatch (instead of warn + skip)
  useTransaction: false, // true → wrap every migration in a transaction (override per file)

  // ── Code-only options (omit in migronaut.config.json) ─────────────────────────
  // hooks: { beforeAll, afterAll, beforeEach, afterEach, onError },
  // mongoose: myMongooseInstance, // pass if your migrations use Mongoose models
  // logger: null,                 // null silences all output (handy in CI/tests)
};
```

<details>
<summary><b>Environment variables</b> — the zero-file way to configure everything</summary>

<br>

| Env var | Config key | Default |
|---|---|---|
| `MIGRONAUT_URI` | `uri` | — *(required)* |
| `MIGRONAUT_DB` | `dbName` | — *(required)* |
| `MIGRONAUT_MIGRATIONS_DIR` | `migrationsDir` | `./migrations` |
| `MIGRONAUT_COLLECTION` | `migrationsCollection` | `_migronaut_migrations` |
| `MIGRONAUT_LOCK_COLLECTION` | `lockCollection` | `_migronaut_locks` |
| `MIGRONAUT_LOCK_TTL` | `lockTTLSeconds` | `60` |
| `MIGRONAUT_STRICT` | `strict` | `false` |
| `MIGRONAUT_USE_TRANSACTION` | `useTransaction` | `false` |
| `MIGRONAUT_SEQUENTIAL` | `sequential` | `false` |
| `MIGRONAUT_CREATE_EXTENSION` | `createExtension` | `js` |

`.env` files are loaded automatically.

</details>

---

## Migration file formats

`migronaut` loads TypeScript and both JavaScript module systems with no extra setup:

```ts
// TypeScript / ESM — named exports (native on Node 22.18+, or under a loader like tsx)
export async function up({ db }) { /* ... */ }
export async function down({ db }) { /* ... */ }
```

```js
// CommonJS — default export
module.exports = {
  async up({ db }) { /* ... */ },
  async down({ db }) { /* ... */ },
};
```

Optional per-file exports: `description` (shown in `status`) and `useTransaction`. Note that `up`/`down`
receive a **single context object** (`{ db, client, mongoose?, session? }`) — not `migrate-mongo`'s
positional `(db, client)`.

> **ESM vs CommonJS:** Node decides a file's module system from its extension and the nearest
> `package.json` `"type"`. In a project with `"type": "module"`, a `.js` file is an ES module, so
> `module.exports = …` throws *"module is not defined in ES module scope."* Use named `export`s (above),
> or name the file `.cjs` and add `'.cjs'` to `fileExtensions` in your config.

---

## License

[MIT](./LICENSE) © guptasantosh327
