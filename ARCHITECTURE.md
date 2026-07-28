# Architecture & Contributor Guide — `migronaut`

> **Audience:** maintainers and new contributors who need to *understand and change* the codebase
> (not end-users — they have the [docs site](https://migronaut.vercel.app/) and `README.md`).
>
> **What this is:** a systematic, ground-up explanation of how the library is built, why each piece
> exists, how data flows through it, and every non-obvious nuance you need to make a safe change.
>

**Snapshot at time of writing:** v1.0.0 · Node ≥ 22.18 (engines; native TS type stripping is
always available) · runtime deps: **none** — `package.json` has no `dependencies` key; `.env`
loading, ANSI colors, the spinner, the arg parser, the table renderer and config validation are
all hand-rolled in `src/` · peer deps: `mongodb`, optional `mongoose`.

---

## Table of contents

1. [The 5-minute mental model](#1-the-5-minute-mental-model)
2. [Repository layout](#2-repository-layout)
3. [The layered architecture](#3-the-layered-architecture)
4. [End-to-end: what happens when you run `migronaut up`](#4-end-to-end-what-happens-when-you-run-migronaut-up)
5. [Module reference](#5-module-reference)
6. [Deep dives on the subtle subsystems](#6-deep-dives-on-the-subtle-subsystems)
7. [Cross-cutting conventions](#7-cross-cutting-conventions)
8. [The nuances / intentional deviations (read before changing anything)](#8-the-nuances--intentional-deviations)
9. [Testing strategy](#9-testing-strategy)
10. [Build, typecheck, lint, release](#10-build-typecheck-lint-release)
11. [Recipe: how to add a new command/feature](#11-recipe-how-to-add-a-new-commandfeature)
12. [Glossary](#12-glossary)

---

## 1. The 5-minute mental model

migronaut is a MongoDB migration tool with two faces over **one engine**:

- **A CLI** (`migronaut`) — what most users run.
- **A programmatic API** (`MigratorKit` + helper functions) — for app startup, serverless, tests.

Both faces are thin. All real logic lives in **one orchestrator class**, [`MigratorKit`](src/core/migrator.js),
which coordinates a handful of small, single-responsibility modules:

```
            ┌────────────────────────────────────────────────┐
   migronaut CLI ─┤                                                  │
            │              MigratorKit (orchestrator)          ├─ MongoDB
  your code ┤                                                  │
            └───┬──────┬───────┬────────┬────────┬────────┬───┘
              config  lock  changelog  loader  runner  context
```

Three ideas explain almost everything:

1. **Config is resolved once, then everything reads it.** Priority: CLI flags > env vars > config
   file > defaults ([config.js](src/core/config.js)).
2. **The changelog is an append-mostly audit trail.** Applying a migration *upserts* a record;
   reverting *updates* it to `status:'reverted'` — it **never deletes** ([changelog.js](src/core/changelog.js)).
3. **A MongoDB-native lock makes concurrent runs safe.** Only one process migrates at a time; a
   heartbeat keeps long migrations from losing their lock ([lock.js](src/core/lock.js)).

If you internalize those three, the rest is detail.

---

## 2. Repository layout

```
index.js                     # module.exports = require('./src/index.js') — package entry point
index.d.ts                   # Hand-written public type surface — the ONLY .d.ts in the repo
src/
├── index.js                 # Public API barrel — the ONLY thing users import
├── errors/index.js          # MigronautError base + one subclass per error code
├── core/                    # The engine
│   ├── migrator.js          # MigratorKit — orchestrates everything (the heart)
│   ├── config.js            # Config loader + built-in validation + precedence
│   ├── lock.js              # MongoDB distributed lock + heartbeat + runWithLock()
│   ├── changelog.js         # Read/write the _migronaut_migrations collection
│   ├── runner.js            # Execute ONE migration up()/down() (+ transactions)
│   ├── context.js           # Build the MigrationContext passed to each migration
│   ├── audit.js             # runAudit() — the read-only health-check flow
│   ├── import.js            # PURE migrate-mongo → MigrationRecord mapping
│   ├── import-runner.js     # runImport() — the impure import flow (read/map/write)
│   └── run.js               # Programmatic helpers: runMigrations(), pendingMigrations()
├── utils/
│   ├── logger.js            # Pino-compatible logger (default console, silent, pino adapter)
│   ├── colors.js            # ANSI palette + FORCE_COLOR/NO_COLOR/TTY detection + stripAnsi
│   ├── env.js               # .env loader — native util.parseEnv, override:false semantics
│   ├── checksum.js          # SHA-256 file hashing
│   ├── redact.js            # Mask user:password@ in strings leaving the process
│   ├── error.js             # errorText() — stringify caught errors, redaction built in
│   ├── loader.js            # Dynamic-import a migration file (.ts/.js, ESM/CJS)
│   ├── template.js          # Generate migration files & config files
│   └── date.js              # Dependency-free timestamp formatting
└── cli/
    ├── index.js             # CLI root: registers commands + global flags
    ├── args.js              # Zero-dependency commander-compatible arg parser
    ├── shared.js            # withMigrator(), confirm(), emitJson(), partialFromOpts()
    ├── spinner.js           # Minimal TTY spinner — start/stop, no-op when piped
    ├── table.js             # Box-drawing table renderers (status/list/import)
    └── commands/*.js        # One file per command — thin wrappers over MigratorKit

bin/migronaut.js             # CLI shebang entry → calls cli/index.js run()
tests/                       # unit/ (mocked) + integration/ (mongodb-memory-server)
docs/                        # VitePress user-facing site (dev-only, never published to npm)
```

**Golden rule of navigation:** a behavior change almost always lands in `src/core/migrator.js` (the
flow) plus one small module (the mechanism). The CLI command files rarely contain logic — they parse
flags and delegate.

---

## 3. The layered architecture

There are three layers. Keep logic in the lowest layer it belongs to.

| Layer | Files | Responsibility | Must NOT |
|---|---|---|---|
| **Presentation** | `cli/`, `bin/` | Parse args, render tables/JSON, spinner, prompts, exit codes | Contain migration logic; touch the DB directly |
| **Orchestration** | `core/migrator.js`, `core/run.js` | Sequence the steps of each command; own the connection lifecycle | Import the spinner or table renderer; render tables |
| **Mechanism** | `core/{lock,changelog,runner,context,import,config}.js`, `utils/` | One job each, pure-ish, unit-testable | Know about the CLI; call `console.*` |

**Why this matters for you:** the CLI's spinner lives *entirely* in the CLI layer
([cli/spinner.js](src/cli/spinner.js), driven from [cli/shared.js](src/cli/shared.js)) and is
injected into core as a `ProgressReporter` callback. Core never imports a spinner. Likewise the
`--json` routing, the `y/N` prompts, and exit codes are all presentation concerns. If you find
yourself wanting to require the spinner inside `core/`, stop — pass a callback instead. This
separation is what lets the same engine power both the CLI and `runMigrations()`.

---

## 4. End-to-end: what happens when you run `migronaut up`

Trace this once and you understand the whole system. Command: `migronaut up --strict`.

```
bin/migronaut.js
  └─ run(process.argv)                              [cli/index.js]
       └─ args.js parses → up command action        [cli/commands/up.js]
            ├─ pre-flight validation (--force/--json rules) — presentation only
            └─ withMigrator(opts, fn, {spinner})    [cli/shared.js]
                 ├─ partialFromOpts(opts) → Partial<MigronautConfig>   (flags only)
                 ├─ new MigratorKit(partial, {progress: spinnerReporter})
                 ├─ migrator.connect()              ← spinner: "Connecting…"
                 └─ fn(migrator):
                      └─ migrator.up(file, {noLock, force, step})  [core/migrator.js]
                           ├─ ensureConfig()         → loadConfig()          [config.js]
                           │     flags > env > file > defaults, built-in validation
                           ├─ connect() (idempotent) → MongoClient + ensureIndexes  [changelog.js]
                           └─ runWithLock(lock, …, () => runUp(...))         [lock.js]
                                ├─ lock.acquire()  (atomic test-and-set + owner readback)
                                ├─ start heartbeat (renew every ttlMs/2)
                                ├─ runUp():                                  [core/migrator.js]
                                │    ├─ getAppliedNames()                    [changelog.js]
                                │    ├─ resolve targets (file | pending dir files)
                                │    ├─ nextBatch()
                                │    ├─ hooks.beforeAll
                                │    └─ for each target:
                                │         ├─ computeChecksum()               [checksum.js]
                                │         ├─ skip/strict-throw if already applied
                                │         ├─ loadMigrationFile()             [loader.js]
                                │         ├─ progress.onStart() (spinner)
                                │         ├─ runMigration() (txn?)           [runner.js]
                                │         │    └─ onSuccess → markApplied()  [changelog.js]
                                │         │       (inside the txn, so record + data commit together)
                                │         └─ hooks.afterEach
                                │      (signal checked between migrations: lost lock / stop())
                                └─ finally: clearInterval(heartbeat); lock.release()
                 └─ finally: migrator.disconnect()
            └─ on any error: withMigrator prints "✖ CODE: message", process.exitCode = 1
```

Key observations:

- **The lock wraps the *whole batch*, not each file.** One acquire/release per `up` call.
- **Errors stop the batch.** `runUp`'s loop rethrows on the first failure; already-applied files in
  that run stay applied (changelog records them as they succeed), the failing one does not.
- **`connect()` is idempotent** — both `withMigrator` and `up()` call it; the second is a no-op.
- **`disconnect()` always runs** in `withMigrator`'s `finally`. The programmatic helpers do the same.

---

## 5. Module reference

Each entry: **responsibility · key exports · nuances you must know.**

### `index.d.ts` — the shared vocabulary (hand-written, repo root)
- **Responsibility:** the entire public type surface, maintained by hand in lockstep with
  `src/index.js` (no generation step; correctness enforced by tsd).
- **Key types:** `MigronautConfig`, `MigronautConfigInput` (object *or* factory fn), `MigrationContext`,
  `MigrationModule`, `MigrationRecord`, `MigrationHooks`, `MigronautLogger` (pino-compatible
  `{debug, info, warn, error, child?}`), `RunResult`, `StatusRow`,
  `ProgressReporter`, `LockInfo`, `MigronautErrorCode`, the import types.
- **Nuances:** `MigrationContext.session` is an *intentional* addition beyond the original spec —
  it's how transactions reach your migration. `MigrationRecord.origin` marks migrate-mongo imports
  as forward-only. When you add a config field, it goes here **and** in `CONFIG_KEYS` (the built-in
  validation spec in `config.js`) **and** the defaults **and** (if env-settable) the env reader.

### `src/errors/index.js` — the error model
- **Responsibility:** `MigronautError` base class (carries a typed `code` + `context`) and exactly one
  subclass per `MigronautErrorCode`.
- **Nuances:** never `throw new Error(...)` anywhere in `src/`. Always a domain error. The `code` is
  what the CLI prints (`✖ LOCK_ALREADY_HELD: …`) and what `--json` emits as `error.code`. Adding an
  error = add the literal to `MigronautErrorCode` in [index.d.ts](index.d.ts), add the subclass here,
  export from [src/index.js](src/index.js) if it's part of the public surface.

### `src/core/config.js` — configuration resolution
- **Responsibility:** merge config from all sources, validate, return a complete `MigronautConfig`.
- **Key exports:** `loadConfig(options)`, `validateConfig(config, {requireDb})`, `DEFAULT_CONFIG`.
- **Precedence (highest wins):** `flags` → `MIGRONAUT_*` env vars → config file → `DEFAULT_CONFIG`,
  implemented as successive `mergeDefined()` calls onto a defaults base.
- **Nuances:**
  - `applyEnvFile(cwd/.env)` runs first with `override: false` semantics — a real env var beats
    `.env`. Parsing is always the native `util.parseEnv` (see [utils/env.js](src/utils/env.js));
    there is no fallback parser, because `engines.node >= 22.18` guarantees the built-in is there.
  - The env layer is the table-driven `ENV_KEYS` (`{env, path, parse}`) — every *scalar* config key
    has an entry, and a unit test pins the table against `CONFIG_KEYS` so the two cannot drift.
    `parse` fails closed (`ConfigInvalidError` naming the variable) rather than coercing: a typo in
    `MIGRONAUT_STRICT`/`MIGRONAUT_LOCK_TTL`/`MIGRONAUT_CREATE_EXTENSION` must never silently
    disable a safety setting. `MIGRONAUT_ENV_FILE` is the one env-settable option outside the
    table — it selects which `.env` to load, so it has to resolve before the table runs.
  - The config file may export an **object or a (sync/async) factory function** — the factory is
    awaited. This is the secret-manager story; a throwing factory becomes `ConfigInvalidError`.
  - `requireDb: false` (used by `create`/`init`) relaxes validation so `uri`/`dbName` may be empty —
    those commands never connect.
  - Validation is the built-in table-driven `validateConfig` over the `CONFIG_KEYS` spec (no zod);
    failures throw `ConfigInvalidError` with per-issue `path`+`message`. Unknown keys are allowed;
    `mongoose`/`hooks`/`logger` are deliberately unchecked (live instances).

### `src/core/lock.js` — distributed lock (the subtlest module)
- **Responsibility:** ensure only one migration run executes at a time, cluster-wide.
- **Key exports:** `MigrationLock` (acquire/renew/release/inspect/forceRelease), `runWithLock()`.
- See the [deep dive](#62-the-lock-the-most-important-thing-to-get-right) — read it before touching
  anything here.

### `src/core/changelog.js` — the audit trail
- **Responsibility:** read/write `MigrationRecord`s in `_migronaut_migrations`.
- **Key methods:** `getAll`, `getAppliedNames`, `getByName`, `getLastBatch`, `getByBatch`,
  `getApplied`, `getMaxBatch`, `getForeignDocs` (raw read for import), `markApplied`,
  `markReverted`, `ensureIndexes`.
- **Nuances:**
  - `markApplied` is an **`updateOne(..., {upsert:true})` keyed on `name`** — *not* `insertOne`. This
    is deliberate: `redo` / `up --force` / `import` must overwrite a record without violating the
    unique `name` index. It uses `$set` (not a whole-document replace) plus
    `$setOnInsert: {firstAppliedAt}` and `$unset: {revertedAt}`, so a re-apply keeps the original
    first-applied timestamp and clears the stale revert marker instead of erasing both.
  - `markReverted` **never deletes** — it sets `status:'reverted'` + `revertedAt`. Audit history is
    sacred.
  - Both accept an optional trailing `session`. The runner passes the migration's own session so the
    changelog write **commits inside the migration's transaction** — without that, a crash between
    the commit and the record leaves a migration applied but unrecorded, and the next `up` runs it
    again.
  - `ensureIndexes` creates the three indexes the read paths use — unique `name`,
    `{status, batch}` (applied-set and highest-batch lookups) and `{batch}` (rollback by
    batch) — in one `createIndexes` round trip. Called once per `MigratorKit` instance, not
    once per `connect()`, and skipped entirely by `ensureIndexes: false` for deployments
    where the app user cannot create indexes.
  - `getMaxBatch` is an indexed `sort({batch:-1}).limit(1)`, not a scan: the next batch
    number must be derived without loading the whole changelog, and it counts reverted
    records so a rolled-back batch number is never handed out twice.

### `src/core/runner.js` — single-migration execution
- **Responsibility:** run exactly one `up()` or `down()`, optionally inside a transaction, time it,
  fire `onError`, and translate any throw into `MigrationExecutionFailedError` (or
  `TransactionsUnsupportedError` when a standalone deployment refused the transaction).
- **Key export:** `runMigration(params)`.
- **Nuances:** when `useTransaction`, it starts a session, injects it into a *copy* of the context
  (`{...context, session}`), and delegates commit/abort to the driver's `session.withTransaction()`,
  which also retries `TransientTransactionError`/`UnknownTransactionCommitResult` per the documented
  commit protocol — **so the migration body may run more than once; bodies must be idempotent**.
  `endSession()` always runs in `finally`. `onError` runs *before* the wrapped error is thrown.
  Errors are never swallowed.

### `src/core/context.js` — the migration's world
- **Responsibility:** build the `MigrationContext` (`{ client, db, mongoose?, signal? }`) handed to
  migrations.
- **Nuance:** `mongoose` is only attached when present; `signal` (abort on stop/lock loss) is
  attached here by the run loops. The `session` is added later by the runner, not here.

### `src/core/import.js` — migrate-mongo adoption (pure)
- **Responsibility:** **pure** transform from raw migrate-mongo changelog docs to `MigrationRecord`s.
- **Key exports:** `mapMigrateMongoDocs`, `isMigrateMongoDoc`.
- **Nuances:** all impure inputs (disk checksum, identity) are injected via `MapOptions` so the
  mapper is trivially unit-testable. Each imported record gets a **unique sequential batch** in apply
  order, offset past the target's existing batches; `origin:'migrate-mongo'` marks it forward-only.

### `src/core/migrator.js` — the orchestrator (the heart)
- **Responsibility:** every command's flow. `up`/`down`/`redo`/`dryRun`/`status`/`list`/`audit`/
  `create`/`init`/`import`/`lockInfo`/`forceUnlock`, plus connection lifecycle. The bodies of
  `audit` and `import` live in [audit.js](src/core/audit.js) and
  [import-runner.js](src/core/import-runner.js); the migrator only injects its capabilities.
- **Shape:** public method validates + connects + wraps the *private* `runX` worker in `runWithLock`.
  The `runX` worker is where the actual sequencing lives. This split keeps lock handling in one
  place. `up` and `down` share the same execution skeleton (`#runSequence` for
  beforeAll/loop/afterAll, `#executeMigration` for one migration end to end), so a fix to one
  direction cannot silently miss the other.
- **Nuances:** `#filepath(name)` centralizes **path-traversal defense** — every user-supplied name
  flows through it. Batch numbers come from `nextBatch()` (monotonic max+1). `down --steps` and its
  dry-run share `selectLastApplied` + `assertStepsValid`. `assertReversible` preflights
  migrate-mongo records before any write.

### `src/core/audit.js` — read-only health check
- **Responsibility:** the `migronaut audit` checks (config, connectivity, transactions, indexes,
  lock, checksum drift, runtime), each independent, rolled up into `{ok, failed, warnings, checks}`.
- **Key export:** `runAudit(deps)` — pure orchestration over capabilities the kit injects.

### `src/core/import-runner.js` — migrate-mongo adoption (impure half)
- **Responsibility:** the `migronaut import` flow — read the foreign collection (projected), map via
  the pure [import.js](src/core/import.js), and write with bounded concurrency, checking the abort
  signal between writes.
- **Key export:** `runImport(deps, options, signal)`.

### `src/core/run.js` — programmatic entry points
- **Responsibility:** the "blessed" lifecycle-safe helpers for app startup / serverless / tests.
- **Key exports:** `runMigrations(config, options)` → `MigrationSummary`; `pendingMigrations(config)`
  → `StatusRow[]`.
- **Nuances:** both manage their own connect/disconnect in a `finally`. `runMigrations` adds
  multi-instance lock handling: `onLockHeld: 'wait'` polls past `LockAlreadyHeldError` up to
  `lockWaitTimeoutMs`. See the [deep dive](#65-the-programmatic-api-runjs).

### `src/utils/`
- **logger.js** — pino-compatible surface `{debug, info, warn, error}`. `createLogger(stream)`
  (debug/info → stream, debug dimmed; warn/error → stderr always, yellow/red), `silentLogger`, and
  `resolveLogger`: `null`→silent, `undefined`→default, otherwise the user's logger adapted — a
  pino-style `child({component: 'migronaut'})` is bound once (adapters are WeakMap-cached), missing
  methods fall back to `info`, and every call is try/catch-guarded so a throwing logger can never
  break a run. The stream param is how `--json` keeps stdout clean (human lines → stderr).
- **colors.js** — ANSI palette (green/yellow/red/cyan/dim), `supportsColor` (precedence:
  `MIGRONAUT_FORCE_COLOR` > `MIGRONAUT_NO_COLOR` > `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` >
  `stream.isTTY` — binary, no chalk-style level detection), `stripAnsi`. The prefixed pair lets a
  project pin migronaut's own output without disturbing every other tool in the shell; the
  unprefixed pair stays honored underneath because no-color.org is an ecosystem-wide convention.
  There is deliberately no `MIGRONAUT_TERM` — `TERM` describes the terminal, not migronaut. When
  disabled every color function is the identity.
- **env.js** — `.env` loading: `applyEnvFile` parses via native `util.parseEnv` (always present on
  the supported Node range) and never overrides keys already in `process.env`.
- **checksum.js** — `computeChecksum` (SHA-256 hex of file contents, BOM/CRLF-normalized).
- **redact.js / error.js** — `redactUris`/`redactDeep` mask `user:password@` in any string leaving
  the process; `errorText(error)` is the single chokepoint for stringifying caught errors, with
  redaction built in. Use it instead of `error.message` everywhere.
- **loader.js** — `loadMigrationFile(filepath)`: dynamic `import()`, `mod.default ?? mod` for CJS,
  validates `up`/`down` are functions. Translates the `.ts`-can't-load failure into a clear error —
  see the [loader deep dive](#64-the-loader-and-the-ts-runtime-caveat).
- **template.js** — generates migration files (`createMigrationFile`) and config files
  (`createConfigFile`), including the secret-provider template. Owns filename stamping (timestamp vs
  sequential) and the inline-commented config output.
- **date.js** — `formatStamp`/`formatDateTime`, dependency-free (replaced `date-fns`).

### `src/cli/`
- **index.js** — builds the program (a `Command` from [args.js](src/cli/args.js)), registers global
  flags (`--uri/--db/--dir/--config`) and every command. `run(argv)` parses & dispatches.
- **args.js** — the zero-dependency commander-compatible parser: one level of subcommands,
  boolean/value/negatable (`--no-x` seeds `true`) options with camelCase keys and short aliases,
  required `<x>` / optional `[x]` positionals, `optsWithGlobals()`, generated `--help`/`--version`.
  Global options are recognized both before and after the command name; parse errors go to stderr
  with `process.exitCode = 1` — it never calls `process.exit()`. Deliberately unsupported (unused):
  combined short flags (`-fy`), variadic arguments. `util.parseArgs` was rejected: absent on
  Node 18.0–18.2, no `--no-x` before 22.4, no subcommands/help.
- **shared.js** — the CLI's workhorse:
  - `withMigrator(opts, fn, {spinner, json})` — constructs `MigratorKit`, drives the spinner,
    routes output for `--json`, runs `fn`, **always disconnects**, maps errors to exit code 1.
  - `partialFromOpts` — flags → `Partial<MigronautConfig>`.
  - `emitJson` — one JSON doc to stdout.
  - `confirm` — `y/N` prompt via `node:readline/promises`.
- **spinner.js** — minimal spinner with the `start(text)`/`stop()` surface, writing to stderr;
  a complete no-op when the stream isn't a TTY, so piped/CI output never sees control sequences.
- **table.js** — hand-rolled box-drawing renderers; column widths are computed ANSI-aware via
  `stripAnsi` so colored cells never skew alignment (no wcwidth — CJK/emoji cells would mis-align;
  migration names are ASCII).
- **commands/*.js** — one `registerX(program)` per command. They parse flags, do presentation-only
  pre-flight checks, then call `withMigrator`. Look at [up.js](src/cli/commands/up.js) as the
  canonical example (force/yes/json pre-flight rules + delegation).

### `bin/migronaut.js`
- Seven lines: require `run`, call it with `process.argv`, print + exit 1 on an unhandled throw.
  The shipped binary **is** this file — plain CJS with a `#!/usr/bin/env node` shebang, no build.

---

## 6. Deep dives on the subtle subsystems

### 6.1 Config resolution
The whole function is [`loadConfig`](src/core/config.js). Order of operations:
1. `applyEnvFile(cwd/.env)` — load `.env` without clobbering real env (always native
   `util.parseEnv`; the `engines.node >= 22.18` floor guarantees it, so there is no fallback parser).
2. Start from `{...DEFAULT_CONFIG}`.
3. If a config file is found (explicit `--config` path, else discover `migronaut.config.{ts,js,json}` in
   cwd), load it (awaiting a factory if exported) and `mergeDefined` onto the base.
4. `mergeDefined(readEnvConfig())` — env beats file. Driven by the `ENV_KEYS` table; every parse
   fails closed with a `ConfigInvalidError` naming the variable rather than coercing.
5. `mergeDefined(flags)` — flags beat env.
6. If `requireDb:false`, default empty `uri`/`dbName` so validation passes.
7. `validateConfig` (built-in, table-driven `CONFIG_KEYS`); on failure throw `ConfigInvalidError`
   with structured `{ path, message }` issues.

`mergeDefined` only copies **defined** keys, so a partial source never erases a lower-priority value
with `undefined`. This is why precedence works cleanly.

### 6.2 The lock (the most important thing to get right)
File: [lock.js](src/core/lock.js). The lock is a single document `{_id:'migronaut_lock'}` in
`_migronaut_locks`. Three mechanisms combine:

**(a) Atomic test-and-set with stale reclaim** — `acquire()`:
```
updateOne(
  { _id:'migronaut_lock', lockedAt: { $lt: now - ttl } },   // matches only a stale/absent lock
  { $set: { ...holderInfo, owner: randomUUID() } },
  { upsert:true }
)
```
- If a **fresh** lock exists, the filter doesn't match and the upsert collides on `_id` →
  duplicate-key error → `LockAlreadyHeldError` (with the current holder attached).
- If **no** lock or a **stale** one exists, the upsert inserts/overwrites it.

**(b) Owner-token readback (closes a race)** — after the upsert, `acquire()` reads the doc back and
checks `owner === ourToken`. If two processes both reclaim the same stale lock, both `updateOne`s
succeed but only the last writer's `owner` survives; the loser sees a different token and throws
instead of running concurrently ([lock.js:75](src/core/lock.js#L75)).

**(c) Heartbeat (makes long migrations safe)** — `runWithLock` starts a `setInterval` that calls
`renew()` every `ttlMs/2`. `renew()` is scoped to `{_id, owner}` so it only refreshes *our* lock and
returns `false` if we've lost it. The interval is `.unref()`-ed so it never keeps the process alive,
and is `clearInterval`-ed in `finally`; the last in-flight renewal is awaited there too, so no stray
query outlives the call and lands after the client is closed.

**(d) Losing the lock aborts the run** — `runWithLock` owns an `AbortController` and passes its
`signal` to the work function. A `renew()` that matches nothing means another process owns the lock,
so the signal is aborted immediately with a `LockLostError`; a renewal that *errors* is tolerated for
`MAX_RENEW_FAILURES` attempts first, since a single failure is often a blip. `#runUp`/`#runDown` check
the signal **between** migrations — the only safe point, where the previous migration has committed
and the next has not started. Set `onLockLost: 'warn'` to keep the old warn-and-continue behavior.
`MigratorKit.stop()` (and the CLI's SIGINT/SIGTERM handler) aborts through the same path with a
`RunAbortedError` carrying the partial results.

**Release** — `deleteOne({_id, owner})`, owner-scoped so we never delete a lock since reclaimed by
someone else. `forceRelease()` (for `migronaut unlock`) deletes unconditionally by `_id`.

> **Why TTL + heartbeat instead of just TTL?** TTL alone means a migration longer than `lockTTLSeconds`
> would let its own lock go stale and be stolen mid-run. The heartbeat refreshes it; the TTL is only
> the *crash-recovery* window (a dead holder's lock becomes reclaimable after TTL).

**Interactions to remember:** MongoDB's own `transactionLifetimeLimitSeconds` (~60s default) is
*independent* of this lock — a 5-minute single transaction fails regardless. And `runMigrations`'
`lockWaitTimeoutMs` must exceed a long migration's duration or waiting peers time out.

### 6.3 The changelog & batches
- A **batch** groups migrations applied together. Default `up` assigns one shared batch to the whole
  run (`nextBatch()` = max existing batch + 1). `up --step` gives each file its own sequential batch.
- `down` (no args) reverts the **last batch**; `down --batch N` a specific batch; `down --steps N`
  the last N applied files ignoring batches (newest-first, `appliedAt` desc).
- Records are upserted by `name`, so re-applying overwrites cleanly. Reverting flips `status` and
  stamps `revertedAt` but keeps the row — `status()` and `getAppliedNames()` filter on
  `status:'applied'`.

### 6.4 The loader and the `.ts` runtime caveat
File: [loader.js](src/utils/loader.js). It dynamic-`import()`s the migration via a `file://` URL and
resolves `mod.default ?? mod` (CJS default vs ESM named). It validates both `up` and `down` are
functions, else `MigrationInvalidExportError`. This is about **user migration files**, not migronaut's
own source — migronaut itself ships as plain CommonJS with no build step (see CLAUDE.md's "No build
step" section); this deep dive is purely about what runtime capability the *migration file being
loaded* needs.

**The caveat that confuses everyone:** the *shipped* CLI (`bin/migronaut.js`) runs as plain Node,
with no bundler and no `tsx` at runtime. So a `.ts` migration imports natively only on **Node ≥ 22.18**
(built-in type stripping) or under a user-provided loader such as `tsx`. On older Node, `import('foo.ts')`
throws `ERR_UNKNOWN_FILE_EXTENSION`. `tsLoadErrorOrNull()` detects exactly that and rethrows an
actionable `MigrationInvalidExportError` ("use Node ≥ 22.18 / a TS loader / a .js file") instead of a
cryptic Node error. This is why `createExtension` defaults to `'js'`. The real-world behavior is
verified by [tests/integration/runtime-ts.test.js](tests/integration/runtime-ts.test.js), which spawns
`bin/migronaut.js` under plain `node` — no build, no loader — since the shipped binary *is* the file
under test.

### 6.5 The programmatic API (run.js)
File: [run.js](src/core/run.js).
- `runMigrations(config, options)` — `new MigratorKit` → `connect` → loop `up()` → `disconnect`
  (finally). The loop only re-iterates when `onLockHeld:'wait'` **and** the error is
  `LockAlreadyHeldError` **and** there's time left before `lockWaitTimeoutMs`; otherwise it rethrows.
  Returns `{ applied, upToDate, waited }`.
- `pendingMigrations(config)` — connect → `list('pending')` → disconnect (finally). Read-only
  readiness probe.
- **Design intent:** these are the *blessed* one-call entry points so users never hand-roll the
  connect/run/disconnect dance (and never leak a connection). They are exported from
  [src/index.js](src/index.js) alongside `MigratorKit`.

---

## 7. Cross-cutting conventions

These are enforced by oxlint/oxfmt + review. Violating them is how a PR gets bounced. Note: `never
console.*` and the `MigronautError`-only-throw rule are **not lint-enforced** (oxlint's config here
has no rule for either) — catch these in review.

- **Types:** plain CommonJS, not TypeScript — no `import`/`export` syntax, no type annotations in
  `src/`/`bin/`. JSDoc comments document intent for the reader/editor but are never type-checked
  (no `tsc`/`checkJs` pass over them). The only checked type surface is the hand-written
  [index.d.ts](index.d.ts), verified against [tests/types/index.test-d.ts](tests/types/index.test-d.ts)
  via `tsd`. JSDoc on public methods is still expected.
- **Errors:** never `throw new Error`. Always a `MigronautError` subclass with a typed `code`. Never
  swallow — rethrow or route to `onError`.
- **Logging:** never `console.*`. Always the injected `MigronautLogger`. Core resolves it via
  `resolveLogger`; the CLI builds stream-targeted loggers. `null` logger = silent (used in all tests).
- **Imports/exports:** `require`/`module.exports` only — named exports via `module.exports = {...}`
  (config files are the sole default-export-shaped exception, since they may export an object or a
  factory function directly).
- **Style:** oxfmt/oxlint — single quotes, semicolons, 100-col, no unused vars/imports.
- **Public surface:** anything users should touch must be re-exported from [src/index.js](src/index.js)
  **and** typed in [index.d.ts](index.d.ts) — the two are maintained by hand in lockstep. If it's not
  in both, it's private.

---

## 8. The nuances / intentional deviations

These look like bugs or oversights but are deliberate. **Do not "fix" them without discussion.**
The high-impact ones for code changes:

- **`markApplied` upserts (not inserts)** — required for `redo`/`force`/`import` over the unique index.
- **`markReverted` never deletes** — audit trail. Reverted ≠ gone.
- **`MigrationContext.session`** — beyond the original type spec; how transactions actually work.
- **Spinner / prompts / JSON routing live in the CLI**, never in core. Core takes a `ProgressReporter`
  callback. Don't require `cli/spinner.js` or `cli/table.js` from `core/`.
- **`createExtension` defaults to `'js'`** and `.ts` is opt-in — because of the shipped-binary
  runtime caveat above. The "first-class .ts" claim is about *authoring/types*, not guaranteed
  runtime on the shipped CJS binary.
- **migrate-mongo imports are forward-only** (`origin:'migrate-mongo'`). `down`/`redo` preflight
  `assertReversible` and refuse them with `IrreversibleMigrationError`.
- **Path traversal is blocked centrally in `#filepath()`** — every user-supplied migration name (even
  one read back from a tampered changelog) is validated there.
- **`--json` is a global flag** (`migronaut --json status` and `migronaut status --json` both work).
  `init` is the one command with no JSON output — it rejects the flag with a pointer to
  `--format json`, which selects the generated config file's format. In JSON mode, human/progress
  output goes to stderr; stdout is one JSON doc.
- **`down --steps` preserves selection order** (newest-first) via a `preserveOrder` flag, instead of
  the usual filename-desc sort.

---

## 9. Testing strategy

- **Runner:** Node's built-in [`node:test`](https://nodejs.org/api/test.html) — no external test
  framework. `pnpm test` = `test:unit` then `test:integration`; the integration half runs
  serially (`--test-concurrency=1`) against **one shared in-memory replica set** booted by
  `--test-global-setup=tests/helpers/global-setup.js` (per-file isolation comes from distinct
  database names + `dropDatabase()` in each `beforeEach`; `concurrency.test.js` and
  `runtime-ts.test.js` opt out with `startTestMongo(db, { dedicated: true })` because they fork
  real processes).
- **Two tiers:**
  - `tests/unit/` — mock the DB; test pure logic (config precedence, checksum, loader, mapping,
    lock semantics with a fake collection, template, date, errors).
  - `tests/integration/` — real in-memory MongoDB via `mongodb-memory-server` (a **replica set**, so
    transactions work). Start in `before`, stop in `after`, `dropDatabase` in `beforeEach` (`node:test`
    uses these hook names, not the Vitest/Jest `beforeAll`/`afterAll`).
- **Harness:** [tests/helpers/](tests/helpers/) — `startTestMongo` (replica set + client),
  `makeProject` (throwaway migrations dir with `write`/`tamper`/`cleanup`), `makeMigrator`
  (a `MigratorKit` pointed at the test mongo with `logger:null`), and migration-body factories
  (`insertMigration`, `failingMigration`).
- **Rules:** every feature ships with tests in the same PR. Silence the logger (`logger:null`). No
  `.only`/`.skip` committed. Test file names mirror source names. Coverage gate: **90% lines / 90%
  funcs / 90% branches**, enforced via `c8` (`pnpm run test:coverage`).
- **Gotcha:** Node caches dynamic `import()` by path. A test that rewrites the *same* migration
  filename mid-run will re-load the *cached* module. Use a new filename, or assert via a read-only
  path (`pendingMigrations`), when you need "changed file" behavior.
- **Type coverage:** the public type surface ([index.d.ts](index.d.ts)) is checked separately by
  `tsd` against [tests/types/index.test-d.ts](tests/types/index.test-d.ts) — `pnpm run test:types`.
  This is a type-assertion pass over hand-written types, not a build/typecheck step.
- **Concurrency note:** the lock-heartbeat integration tests use real timers; running the *full*
  integration suite in parallel (many concurrent `mongodb-memory-server` replica sets) can make
  timing-sensitive tests flaky under heavy CPU contention. They're stable in isolation — not a
  correctness issue.

Useful commands:
```bash
pnpm test                                  # unit + integration (~570 tests)
node --test tests/integration/up.test.js   # one file (boots its own replica set)
pnpm run test:coverage                     # full suite under c8, gated at 90/90/90
pnpm run test:types                        # tsd — index.d.ts vs tests/types/*.test-d.ts
pnpm run check:dts                         # tsc --noEmit --strict over index.d.ts alone
```

## 10. No build, lint, release

- **No build step, ever.** migronaut ships exactly what's in `src/`/`bin/` — plain CommonJS, no
  compile pass for authors or consumers. The package version is read from `package.json` at
  runtime (`bin/migronaut.js`), not injected at build time.
- **Types:** the single hand-written [index.d.ts](index.d.ts) at the package root is the only
  `.d.ts` in the repo — there is no generation step and no `tsc` pass over `src/`. Correctness is
  enforced only by `tsd` (`pnpm run test:types`), which checks it against
  [tests/types/index.test-d.ts](tests/types/index.test-d.ts).
- **Lint/format:** `pnpm run lint` (`oxlint src bin scripts tests bench`), `pnpm run format` (`oxfmt` to
  fix formatting), `pnpm run format:check` (`oxfmt --check`, no writes).
- **Bundle-size report (informational only):** `pnpm run size` runs `scripts/size.js`, which uses
  esbuild to report library + CLI bundle size — it does not produce a published artifact.
- **Benchmarks (informational only, manual):** `pnpm run bench` runs `bench/bench.js`, a
  zero-dependency `node:perf_hooks` harness measuring ops/sec for the hottest paths
  (`checksum`, `loader`, `Changelog`, `MigrationLock`) — the DB-bound scenarios spin up a
  throwaway in-memory MongoDB replica set for the run. Not run in CI; results are hand-copied
  into the README's Benchmarks section before releases.
- **Published artifact:** exactly what `files` in [package.json](package.json) lists —
  `index.js`, `index.d.ts`, `bin`, `src`, `README.md`, `CHANGELOG.md`. `docs/`, `blog/`, and this
  `ARCHITECTURE.md` live in the repo but are **never** shipped to npm.
- **Release:** manual — bump `version` in `package.json`, write the entry in `CHANGELOG.md` by
  hand, commit and tag, then `pnpm run release` (= `pnpm publish`). `prepublishOnly` re-runs
  lint + format:check + test:coverage + test:types + check:dts as the pre-publish gate.
- **Commits:** Conventional Commits required (`feat(scope):`, `fix(scope):`, `test(...)`, etc.).

## 11. Recipe: how to add a new command/feature

Concrete worked path — say you're adding `migronaut verify` (re-checks all checksums):

1. **Types** ([index.d.ts](index.d.ts)) — add any new result/option type and, if needed, a new
   `MigronautErrorCode` literal. This is the *only* `.d.ts` in the repo; there is no per-file or
   generated alternative.
2. **Errors** ([src/errors/index.js](src/errors/index.js)) — add the matching `MigronautError`
   subclass.
3. **Core logic** ([src/core/migrator.js](src/core/migrator.js)) — add a public method `verify()`.
   If it touches the DB and mutates, wrap the worker in `runWithLock`; if it's read-only (this one
   is), just `ensureConfig()` + `connect()`. Reuse existing mechanism modules — don't reimplement
   checksum/changelog logic.
4. **Public API** ([src/index.js](src/index.js)) — export any new runtime symbols users need,
   updating `index.d.ts` in the same commit so the two stay in lockstep.
5. **CLI command** (`src/cli/commands/verify.js`) — `registerVerify(program)`: define flags
   (`--json` if it emits data), do presentation-only pre-flight, then `withMigrator(opts, fn, {...})`.
   Copy [up.js](src/cli/commands/up.js) as the template.
6. **Register it** ([src/cli/index.js](src/cli/index.js)) — import + call `registerVerify(program)`.
7. **Rendering** ([src/cli/table.js](src/cli/table.js)) — add a renderer if it has table output.
8. **Tests** — unit test the pure bits (`tests/unit/`); integration test the flow against
   `mongodb-memory-server` (`tests/integration/`); add a `tsd` assertion in
   [tests/types/index.test-d.ts](tests/types/index.test-d.ts) for any new public type. All in the
   same PR.
9. **Docs** — update `README.md` and add `docs/commands/verify.md` for the user site. Update the
   relevant section of this file if you introduced a nuance.
10. **Verify:** `pnpm run lint` → `pnpm run format:check` → `pnpm test` → `pnpm run test:types`
    (this is exactly what `prepublishOnly` runs — no build step to add).

**Where logic goes (decision rule):** mutation sequencing → a `runX` worker in `migrator.js`; a
reusable mechanism (hashing, locking, mapping) → its own `core/`/`utils/` module; anything about how
it *looks* or *exits* → the CLI layer.

## 12. Glossary

- **Batch** — a group of migrations applied together, sharing a `batch` number; the unit `down`
  reverts by default.
- **Changelog** — the `_migronaut_migrations` collection; the append-mostly audit trail of `MigrationRecord`s.
- **Checksum** — SHA-256 of a migration file at apply time; re-checked later to detect tampering.
- **Context** — the `{ db, client, mongoose?, session? }` object passed into every `up`/`down`.
- **Heartbeat** — the periodic `renew()` that keeps a long migration's lock fresh.
- **Hooks** — user callbacks (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`/`onError`) run around
  migrations.
- **Migrator** — `MigratorKit`, the orchestrator class.
- **Origin** — `'migrate-mongo'` marks an imported, forward-only record (cannot be reverted).
- **Owner token** — the random UUID proving which process currently holds the lock.
- **Progress reporter** — the CLI-injected callback that drives the spinner without core ever
  importing one.
- **Step** — Laravel-style per-file batching (`up --step`) / per-file rollback (`down --steps N`).

---

*Keep this file honest. If you change behavior and this doc still describes the old way, the doc is a
bug — fix it in the same PR.*
