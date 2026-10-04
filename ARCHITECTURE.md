# Architecture & Contributor Guide — `migronaut`

> **Audience:** maintainers and new contributors who need to *understand and change* the codebase
> (not end-users — they have the [docs site](https://migronaut.vercel.app/) and `README.md`).
>
> **What this is:** a systematic, ground-up explanation of how the library is built, why each piece
> exists, how data flows through it, and every non-obvious nuance you need to make a safe change.
>

**Snapshot at time of writing:** v2.1.0 · Node ≥ 22.18 (engines; native TS type stripping is
always available) · runtime deps: **none** — `package.json` has no `dependencies` key; `.env`
loading, ANSI colors, the spinner, the arg parser, the table renderer and config validation are
all hand-rolled in `src/` · peer deps: `mongodb`, optional `mongoose` · BullMQ (the optional queue
adapter) is injected by the caller — not a dependency, not a peer.

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
which coordinates a handful of small, single-responsibility modules. A third, optional consumer —
the **queue adapter** (`@alexify/migronaut/bullmq`, [§6.6](#66-the-queue-adapter-bullmq)) — sits
on top of the same public API as "your code" does: it runs each migration as a BullMQ job by
calling `kit.up(name)` / `kit.down(name)`.

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
index.d.ts                   # Hand-written types for the package root
bullmq.js                    # module.exports = require('./src/bullmq/index.js') — the ./bullmq subpath
bullmq.d.ts                  # Hand-written types for the subpath (structural BullMQ types)
src/
├── index.js                 # Public API barrel of the package root
├── errors/index.js          # MigronautError base + one subclass per error code
├── core/                    # The engine
│   ├── migrator.js          # MigratorKit — orchestrates everything (the heart)
│   ├── options.js           # PURE: validation of each run method's options (the preambles)
│   ├── sequence.js          # The files on disk vs the applied names: pending, late, blocked, revert order
│   ├── run-recorder.js      # RunRecorder — run:start/run:end, lock events, run metrics, the Done line
│   ├── config.js            # Config loader + built-in validation + precedence
│   ├── lock.js              # MongoDB distributed lock + heartbeat + runWithLock()
│   ├── lock-wait.js         # withLockWait() — the one wait-for-the-lock loop (run.js + queue jobs)
│   ├── changelog.js         # Read/write the _migronaut_migrations collection
│   ├── runner.js            # Execute ONE migration up()/down() (+ transactions)
│   ├── context.js           # Build the MigrationContext passed to each migration
│   ├── audit.js             # runAudit() — the read-only health-check flow
│   ├── baseline.js          # runBaseline() — mark existing files applied without running them
│   ├── collections.js       # Declared collections: validate, normalize, load collectionsDir
│   ├── index-spec.js        # PURE: one declared index vs one live index (names, keys, options)
│   ├── search-index-spec.js # PURE: one declared search index vs one live one (defaults, type, build)
│   ├── converge-plan.js     # PURE: plan one collection — result rows + executable steps
│   ├── converge-search.js   # Atlas Search: raw commands, the availability probe, error hints, the wait
│   ├── converge.js          # runConverge() — read live state, plan, carry the plan out
│   ├── converge-log.js      # ConvergeLog — the append-only converge history (_migronaut_converge)
│   ├── import.js            # PURE migrate-mongo → MigrationRecord mapping
│   ├── import-runner.js     # runImport() — the impure import flow (read/map/write)
│   └── run.js               # Programmatic helpers: runMigrations(), pendingMigrations()
├── utils/
│   ├── logger.js            # Pino-compatible logger (default console, silent, pino adapter)
│   ├── colors.js            # ANSI palette + FORCE_COLOR/NO_COLOR/TTY detection + stripAnsi
│   ├── concurrency.js       # mapLimit() — bounded fan-out for per-file reads/writes
│   ├── env.js               # .env loader — native util.parseEnv, override:false semantics
│   ├── checksum.js          # SHA-256 file hashing
│   ├── redact.js            # Mask credentials (userinfo + query secrets) leaving the process
│   ├── sanitize.js          # Strip terminal control chars (C0 + full C1) from untrusted text
│   ├── error.js             # errorText()/errorWithCause() — stringify caught errors, redaction built in
│   ├── actor.js             # requestedBy/reason — limits, validation, changelog fields
│   ├── canonical.js         # canonical()/deepEqual()/toWire() — declared vs. stored value comparison
│   ├── collection-name.js   # isCollectionName() — the one rule for a usable collection name
│   ├── id.js                # The one place an id is minted — randomUUID, or the user's generateId
│   ├── loader.js            # Dynamic-import user files (migrations, collection definitions)
│   ├── migration-name.js    # isBareFilename() — the one rule for a safe migration name
│   ├── telemetry.js         # OpenTelemetry through the injected tracer/meter — guarded spans + instruments
│   ├── template.js          # Generate migration files & config files
│   ├── user.js              # safeUsername() — MIGRONAUT_USER, else the OS user
│   └── date.js              # Dependency-free timestamp formatting
├── cli/
│   ├── index.js             # CLI root: registers commands + global flags
│   ├── args.js              # Zero-dependency commander-compatible arg parser
│   ├── shared.js            # withMigrator(), confirm(), emitJson(), partialFromOpts()
│   ├── spinner.js           # Minimal TTY spinner — start/stop, no-op when piped
│   ├── table.js             # Box-drawing table renderers (status/list/import/converge)
│   └── commands/*.js        # One file per command — thin wrappers over MigratorKit
└── bullmq/                  # The queue adapter — never requires bullmq (it is injected)
    ├── index.js             # Public API barrel of the ./bullmq subpath
    ├── jobs.js              # The job contract: names, data version, validation, dedup ids
    ├── producer.js          # planUpJobs/planDownJobs + enqueueUp/enqueueDown/enqueueConverge
    ├── processor.js         # createMigrationProcessor() — runs ONE job (the Worker's function)
    ├── wait.js              # waitForGroup() — enqueue-and-wait over QueueEvents
    └── service.js           # MigrationQueue / createMigrationQueue() — the facade

bin/migronaut.js             # CLI shebang entry → calls cli/index.js run()
tests/                       # unit/ (mocked) + integration/ (mongodb-memory-server) + helpers/
examples/                    # Runnable example apps (own package.json; never published)
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
| **Orchestration** | `core/migrator.js` (+ `run-recorder.js`), `core/run.js` | Sequence the steps of each command; own the connection lifecycle | Import the spinner or table renderer; render tables |
| **Mechanism** | `core/{lock,changelog,runner,context,import,config,options,sequence}.js`, `utils/` | One job each, pure-ish, unit-testable | Know about the CLI; call `console.*` |
| **Integration adapter** | `bullmq.js`, `src/bullmq/` | Drive the kit's *public* API from queue jobs; own the Queue/Worker lifecycle | Require a mechanism module (`lock`, `changelog`, `runner`) or touch the DB; `require('bullmq')`; call `console.*` |

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
- **Responsibility:** the public type surface of the package root, maintained by hand in lockstep
  with `src/index.js` (no generation step; correctness enforced by tsd). The `./bullmq` subpath has
  its own [bullmq.d.ts](bullmq.d.ts), which imports from this file — never the other way round.
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
  - `generateId` is code-only like those, but it has exactly one valid shape, so `validateConfig`
    checks it (`must be a function`) outside the `CONFIG_KEYS` table — the table is pinned against
    the JSON schema and the env table, and a function belongs in neither.
  - `telemetry` is checked the same way (`telemetryIssues`): an object whose `tracer`, if present,
    has `startActiveSpan`, and whose `meter` has `createHistogram` and `createCounter`. Absent,
    `null` and `{}` all mean "off", so a config that builds it conditionally needs no special
    case. A stray key inside it (the whole `@opentelemetry/api` module is the usual one) is
    mentioned at debug level, like a stray top-level key.

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
  - `appliedAt`/`revertedAt`/`failedAt` are stamped in **server time** (`$currentDate`) unless the
    record carries an explicit `appliedAt` (import adopting historical timestamps) — the same
    clock discipline the lock's `$$NOW` uses, because `redo`/`down --steps` sort by `appliedAt`
    and a skewed client clock would mis-order the revert selection.
  - `markFailed` leaves a best-effort `status:'failed'` trace of a failed `up` attempt (error text,
    `failedAt`, `runId`). Its filter excludes `'applied'` records — a forced re-run's failure can
    never demote a migration the changelog says is applied — and every read path filters on
    `status:'applied'`, so a failed trace never changes what runs; the next successful apply
    overwrites it and clears `failedAt`/`error`.
  - Both accept an optional trailing `session`. The runner passes the migration's own session so the
    changelog write **commits inside the migration's transaction** — without that, a crash between
    the commit and the record leaves a migration applied but unrecorded, and the next `up` runs it
    again.
  - `ensureIndexes` creates the **five** indexes the read paths use — unique `name`
    (`name_unique`), `{status, batch}` (`status_batch`, highest-batch lookups), `{batch}`
    (`batch`, rollback by batch), `{status, name}` (`status_name`, the covered applied-set
    read) and `{status, appliedAt, name}` (`status_appliedAt_name`, newest-first ordering for
    `redo`/`down --steps`) — in one `createIndexes` round trip. Called once per `MigratorKit`
    instance, not once per `connect()`, and skipped entirely by `ensureIndexes: false` for
    deployments where the app user cannot create indexes.
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
  `create`/`init`/`import`/`baseline`/`lockInfo`/`forceUnlock`, plus connection lifecycle. The
  bodies of `audit`, `import` and `baseline` live in [audit.js](src/core/audit.js),
  [import-runner.js](src/core/import-runner.js) and [baseline.js](src/core/baseline.js); the
  migrator only injects its capabilities.
- **Shape:** public method validates + connects + wraps the *private* `runX` worker in `runWithLock`.
  The `runX` worker is where the actual sequencing lives. This split keeps lock handling in one
  place. `up` and `down` share the same execution skeleton (`#runSequence` for
  beforeAll/loop/afterAll, `#executeMigration` for one migration end to end), so a fix to one
  direction cannot silently miss the other.
- **What it delegates:** each public method's option checks are one call into
  [options.js](src/core/options.js) (`assertUpOptions`, `assertDownOptions`, …), made before the
  config loads; "which files, in which order, and what blocks them" is
  [sequence.js](src/core/sequence.js); and the bookkeeping of a locked run — events, metrics, the
  span's end, the closing line — is a [`RunRecorder`](src/core/run-recorder.js). What stays here is
  the flow and the state only the kit has (config, connection, run id, abort wiring).
- **Nuances:** `#filepath(name)` centralizes **path-traversal defense** — every user-supplied name
  flows through it (`assertMigrationName`, then a containment check). Batch numbers come from
  `nextBatch()` (monotonic max+1). `down --steps` and its dry-run share `#selectDownTargets` and the
  same `--steps` validation. `assertReversible` preflights migrate-mongo records before any write. `connect()` is safe under overlapping calls (they share
  one in-flight connection) — a long-lived kit in a service is called from several places at once.
- **Sequenced single-file runs:** `up(file, { batch, ordered })`, `down(file, { ordered })` and the
  public `nextBatch()` exist so something *outside* the kit can split one logical run into
  single-file calls without losing what a bulk run guarantees. `batch` stamps a caller-chosen
  number (a label, not a reservation). `ordered` makes a single-file `up` read the full applied
  set — so the `strict` drift check and `onOutOfOrder` apply as in a bulk run — and refuse with
  `MigrationBlockedError` while an earlier file is pending (`#assertUpNotBlocked`), checked inside
  the lock and before `beforeAll`. For `down` it refuses while a migration applied *later* (by
  `appliedAt`) is still applied (`#assertDownNotBlocked`).
- **Ids:** the kit never calls `randomUUID` itself. `#ensureConfig` builds `#newId` from the
  `generateId` option (`createIdGenerator`, [utils/id.js](src/utils/id.js)); `#withLock` mints the
  run id with it as its first act after the reentrancy guard, and the public `generateId()` hands
  the same source to layers above the kit.
- **Telemetry:** `#ensureConfig` also builds `#telemetry` from the `telemetry` option
  (`createTelemetry`, [utils/telemetry.js](src/utils/telemetry.js)) — a no-op object when nothing
  was injected. There are exactly two wrap sites, both here, so the mechanism modules stay ignorant
  of it:
  - `#withLock` opens the `migronaut.run` span around the callback it hands to `runWithLock` — i.e.
    *after* the lock is held — and hands it to its `RunRecorder`, which ends it in the `finally`,
    after the release, from the same summary `run:end` is built from. A refused acquisition
    therefore opens no span; it increments `migronaut.lock.refused` instead.
  - `#executeMigration` wraps `#executeMigrationSteps` (hooks, load, body, changelog write) in the
    `migronaut.migration` span, which makes it the *active* span for everything the migration
    does, and records the duration histogram on both the success and the failure path.

### `src/core/options.js` — run-method option validation (pure)
- **Responsibility:** one `assert*Options` per run method (`up`, `down`, `redo`, `dryRun`,
  `converge`, `list`, `import`, plus `assertHistoryLimit` and `assertFilename`), each the whole
  preamble of that method with its checks in the order that decides which error a caller sees.
  No config, no database, no file system — so a caller mistake costs neither a round trip nor the
  lock.

### `src/core/sequence.js` — the migration sequence
- **Responsibility:** the migration files on disk (`listMigrationFiles` — dotfiles, directories and
  `.d.ts` files skipped), measured against the applied names: `pendingIn` (a failed trace counts
  as pending), `truncateAtTarget` (`--to`), `lateArrivals` (the out-of-order check's input),
  `revertOrder`, and `blockedError` — the one wording of an ordered step's refusal. Pure apart from
  the directory read; refusing, warning or waiting is the kit's call.

### `src/core/run-recorder.js` — the record of a locked run
- **Responsibility:** `RunRecorder` — `run:start`, the `lock:*` events, the lock metrics, the run
  span's attributes and end, `run:end` with the row counts (taken from the error's
  `context.results` on the failure path), and the closing "✔ Done" line. Built per run by
  `#withLock` from the kit's guarded emitter, telemetry and logger, so nothing it does can fail a
  run. The span is still *opened* in `migrator.js` — one of the kit's two wrap sites.

### `src/core/audit.js` — read-only health check
- **Responsibility:** the `migronaut audit` checks (config, connectivity, transactions, indexes,
  lock, checksum drift, runtime), each independent, rolled up into `{ok, failed, warnings, checks}`.
- **Key export:** `runAudit(deps)` — pure orchestration over capabilities the kit injects.

### `src/core/import-runner.js` — migrate-mongo adoption (impure half)
- **Responsibility:** the `migronaut import` flow — read the foreign collection (projected), map via
  the pure [import.js](src/core/import.js), and write with bounded concurrency, checking the abort
  signal between writes.
- **Key export:** `runImport(deps, options, signal)`.

### `src/core/baseline.js` — adopt an existing database (no prior tool)
- **Responsibility:** the `migronaut baseline` flow — mark migration files on disk as applied
  (checksums hashed from disk, one shared batch, `origin: 'baseline'`) without executing anything,
  for databases whose state predates any migration tool. Forward-only like import (`down`/`redo`
  refuse the records), idempotent (already-applied names are skipped, so a re-run resumes).
- **Key export:** `runBaseline(deps, options, signal)` — same `runX(deps)` injection pattern as
  audit and import.

### `src/core/collections.js` — declared collections
- **Responsibility:** everything about a collection definition that is not the database:
  `definitionIssues` / `collectionsIssues` (strict validation — unknown keys and index options are
  errors, with nested paths like `collections[2].indexes[0].key` or `users.ts: indexes[0]`),
  `normalizeDefinition` (the planner's shape), `loadCollectionsDir` and `resolveDefinitions`
  (inline definitions first, then one file per collection; a name declared twice is an issue).
- **Nuances:** `config.js` requires it to validate inline `collections` with the rest of the
  config; the *files* are loaded only by `resolveDefinitions`, at converge time. A function export
  is refused rather than called (a Mongoose model is a function).

### `src/core/index-spec.js` — declared index vs live index (pure)
- **Responsibility:** `indexIssues` (the option whitelist), `normalizeDeclaredIndex` (effective
  name, server-form key, the spec to send — key as a `Map`, `false` booleans dropped),
  `normalizeLiveIndex`, `compareIndex` (`{ diffs, inPlace, rebuild }`), `sameSignature`,
  `defaultIndexName` (the driver's rule), `restoreSpec`.
- **The invariant:** what the server stores for a declaration must compare as unchanged against
  that declaration — see [§6.7](#67-declared-collections-converge).

### `src/core/search-index-spec.js` — declared search index vs live search index (pure)
- **Responsibility:** `searchIndexIssues` (light validation: unknown keys, the shape that tells
  `search` from `vectorSearch`, vector/`autoEmbed` mixing, repeated fields),
  `normalizeDeclaredSearchIndex` (default name `default`, type `search`),
  `normalizeLiveSearchIndex` (a `$listSearchIndexes` document — type inferred where a self-managed
  `mongot` reports none, `updating` from a staged index or an older served version),
  `effectiveDefinition` (`SEARCH_DEFAULTS` & co. filled in), `compareSearchIndex` (`{ diffs,
  typeChange, immutable }`), `isSearchIndexReady`, `searchBuild`, `searchIndexSpec`.
- **The invariant** is index-spec.js's: what the server reports for a declaration must compare as
  unchanged against it — hence defaults filled on *both* sides, from one table.

### `src/core/converge-search.js` — Atlas Search, the mechanism
- **Responsibility:** the raw search commands (`runSearchStep`: create, update — retried once with
  its type for a self-managed `mongot` — and drop, tolerating "already gone"),
  `listSearchIndexes`, `probeSearch` (does the server have Search at all — see
  [§6.7](#67-declared-collections-converge)), `isSearchUnavailable` / `searchHint` (what the
  server's errors mean), and `awaitSearchIndexes` / `nextPollDelay` (the optional wait). Returns
  outcomes; converge.js decides what they do to a run.

### `src/core/converge-plan.js` — the converge planner (pure)
- **Responsibility:** `planCollection(definition, live, { prune, search })` → `{ name, actions,
  steps }`: result rows (`create`/`modify`/`recreate`/`drop`/`keep`/`unchanged`/`conflict`/`skip`)
  and the steps that carry them out, in execution order, each pointing at the rows it settles.
  `planSearchIndexes` plans the `searchIndex` rows. Plus `summarize`, `isDestructive`, the
  validator helpers.

### `src/core/converge.js` — the converge flow
- **Responsibility:** `runConverge(deps, options, signal)`, in phases that are functions of their
  own: *read and plan* (`readAndPlan` — every live state in one `listCollections` plus bounded
  `listIndexes`, primary reads with forced BSON promotion; shard keys behind a mongos), *guard*
  (`refuseConflicts`), then per collection *re-plan* (`replan`), *apply* (`applyCollection` — the
  steps one by one, an abort check between them) and *verify* (`verifyFixedPoint`), and finally
  *report* (`reportSuccess` / `reportFailure` — closing lines, the history entry, `converge:end`).
- **Key exports:** `runConverge`, `readLiveState`, `readLiveStates`, `READ_OPTIONS`. Same
  `runX(deps)` injection pattern as audit, import and baseline.

### `src/core/converge-log.js` — the converge history
- **Responsibility:** `ConvergeLog` — `append(db, entry)` (creates the `startedAt` index on first
  use) and `list(db, limit)`, newest first, over `convergeLogCollection`. Written best-effort by
  converge.js; read only by `kit.convergeHistory()` / `converge --history`, never by a run.

### `src/core/run.js` — programmatic entry points
- **Responsibility:** the "blessed" lifecycle-safe helpers for app startup / serverless / tests.
- **Key exports:** `runMigrations(config, options)` → `MigrationSummary`; `pendingMigrations(config)`
  → `StatusRow[]`.
- **Nuances:** both manage their own connect/disconnect in a `finally`. `runMigrations` adds
  multi-instance lock handling: `onLockHeld: 'wait'` polls past `LockAlreadyHeldError` up to
  `lockWaitTimeoutMs`. See the [deep dive](#65-the-programmatic-api-runjs).

### `src/core/lock-wait.js` — the wait-for-the-lock loop
The budget bounds *stall* time and, left unset, defaults to `max(90 s, 1.5 × holder TTL)` (the
holder writes its `ttlMs` into the lock document; an older holder falls back to this process's
TTL) — an explicit budget is honoured and only warned about when it is shorter than the holder's
heartbeat. Polls back off from `lockPollIntervalMs`, doubling, capped at 5 s and at a quarter of
the budget (so a live heartbeat is always observed). `isTransient` widens what is waited out (the
queue's "an earlier job is still in flight"), `signal` aborts between polls, and `onSettle`
reports a wait that happened (`acquired` / `timeout` / `aborted`) — which is how
`migronaut.lock.wait.duration` is recorded, through the kit's non-exported `RECORD_LOCK_WAIT`
symbol.

- **Responsibility:** `withLockWait(attempt, options)` — retry `attempt()` while it rejects with
  `LockAlreadyHeldError`, bounded by a *stall* budget that re-arms whenever the holder's `lockedAt`
  advanced (a live peer is never timed out). Shared by `runMigrations` and the queue processor.
- **Key exports:** `withLockWait`, `assertLockWaitOptions`, the two default budgets.
- **Nuances:** an optional `signal` aborts the sleep *between* attempts (never an attempt in
  progress) — that is how a worker shutdown interrupts a job that is waiting for the lock.
  `kit.stop()` cannot do it: between attempts no run is in flight for it to stop.

### `src/bullmq/` — the queue adapter
Five small modules behind the `./bullmq` subpath; see [§6.6](#66-the-queue-adapter-bullmq) for
the design.
- **`jobs.js`** — the contract shared by producer and worker: job names
  (`up`/`down`/`sync`/`converge`), the versioned data shape, `parseJobData` (validation of
  *untrusted* payloads), `dedupId` / `convergeDedupId`, the job and scheduler templates.
- **`producer.js`** — `planUpJobs`/`planDownJobs` (the plan *is* `kit.dryRun`, so it can never
  disagree with a run), `enqueueUp`/`enqueueDown` (one atomic `addBulk`, returns the group
  handle) and `enqueueConverge`. The group id comes from `kit.generateId()`, so it follows the
  kit's id format. An `up` plan may carry a converge job as `plan.converge`, apart from `jobs`.
- **`processor.js`** — `createMigrationProcessor()`: the function a Worker runs. Validate →
  connect → `withLockWait(kit.up|down|converge)` → map the result; classify failures; forward kit
  events to the job as log rows and progress.
- **`wait.js`** — `waitForGroup()`: sequential `job.waitUntilFinished` under one time budget, the
  group's converge job last.
- **`service.js`** — `MigrationQueue`: validates everything before constructing anything, owns
  what it constructs (and only that), closes in dependency order.

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
  redaction built in. Use it instead of `error.message` everywhere. `errorWithCause(error)` adds the
  wrapped `context.cause` (which migration *and* why) — the changelog's failure trace and a failed
  span's status message.
- **actor.js** — `requestedBy` / `reason`: their limits (`ACTOR_LIMITS`), `actorIssue`,
  `pickActor`, and `actorFields` (the changelog field names, `revert`-prefixed for a rollback).
  Shared by the kit's options and the queue's job contract, so a producer cannot send what its
  worker refuses.
- **id.js** — the only module that mints an identifier. `randomId()` is the default
  (`crypto.randomUUID()`); `createIdGenerator(generateId)` wraps the user's function so that every
  call is bare (no arguments, no receiver), synchronous, and checked by `assertId` (a non-empty
  string of at most `MAX_ID_LENGTH` = 128 characters — the same limit a queue worker enforces on a
  job's group id). A throw, a promise or a non-id becomes a `ConfigInvalidError`. A unit test greps
  `src/` so no second minting site can appear.
- **telemetry.js** — `createTelemetry({ tracer, meter })` turns the injected OpenTelemetry objects
  into what the kit reports through: `open(name, attributes, fn)` (run `fn` with a new span active;
  the caller ends it), `wrap(...)` (the same, ended when `fn` settles), and one method per metric
  (`runEnded`, `migrationEnded`, `lockAcquired`, `lockRefused`, `lockLost`). Every call into the
  SDK goes through one `safe()`, and `open` runs the work exactly once whatever the tracer does —
  throws before calling back, throws after, calls back twice or late. A failure becomes
  `setStatus({ code: 2, message })` with the message through `errorText` (plus the redacted
  `context.cause`) and `error.type`; `recordException` and span events are not used. The span and
  metric names, the attribute keys, the histogram buckets (seconds) and the `SPAN_STATUS_ERROR = 2`
  constant all live here — nothing else in `src/` knows an OpenTelemetry name.
- **loader.js** — `loadMigrationFile(filepath)`: dynamic `import()`, `mod.default ?? mod` for CJS,
  validates `up`/`down` are functions. Translates the `.ts`-can't-load failure into a clear error —
  see the [loader deep dive](#64-the-loader-and-the-ts-runtime-caveat). `importUserFile` (the
  `reload` cache-busting import) and `tsLoadMessageOrNull` are shared with the collection
  definition loader.
- **canonical.js** — `canonical(value)` maps a declared value and what the server returns onto one
  key-sorted, JSON-safe shape (BSON number wrappers → numbers, `undefined` properties dropped,
  arrays kept in order), so `deepEqual` is a string comparison; `toWire` strips `undefined` from
  what converge sends, which a client with `ignoreUndefined: false` would otherwise store as `null`.
- **collection-name.js** — `isCollectionName`, moved out of `config.js` so `core/collections.js`
  can use it without a require cycle (`config.js` re-exports it).
- **template.js** — generates migration files (`createMigrationFile`) and config files
  (`createConfigFile`), including the secret-provider template. Owns filename stamping (timestamp vs
  sequential) and the inline-commented config output.
- **date.js** — `formatStamp`/`formatDateTime`, dependency-free (replaced `date-fns`).

### `src/cli/`
- **index.js** — builds the program (a `Command` from [args.js](src/cli/args.js)), registers global
  flags (`--uri/--db/--dir/--config`) and every command. `run(argv)` parses & dispatches.
- **args.js** — the zero-dependency commander-compatible parser: one level of subcommands,
  boolean/value/negatable (`--no-x` seeds `true` — unless `--x` is declared too, which makes the
  pair tri-state, as in commander) options with camelCase keys and short aliases,
  required `<x>` / optional `[x]` positionals, `optsWithGlobals()`, generated `--help`/`--version`.
  Global options are recognized both before and after the command name; parse errors go to stderr
  with `process.exitCode = 1` — it never calls `process.exit()`. Deliberately unsupported (unused):
  combined short flags (`-fy`), variadic arguments. `util.parseArgs` was rejected: absent on
  Node 18.0–18.2, no `--no-x` before 22.4, no subcommands/help.
- **shared.js** — the CLI's workhorse:
  - `defineCommand(program, spec)` — the envelope every data command registers through:
    `optsWithGlobals`, presentation-only `preflight`, `withMigrator`, JSON-vs-`render` routing,
    and `after` for exit-code logic. Command files stay pure declaration because of it.
  - `withMigrator(opts, fn, {spinner, json})` — constructs `MigratorKit`, drives the spinner,
    routes output for `--json`, runs `fn`, **always disconnects**, maps errors to exit code 1.
    `fn` gets `{ logger, json, opts, spinner, stopRequested }` — the last two for a command that
    reads, asks, then acts (`converge`): a signal during the prompt makes `migrator.stop()` a
    no-op, so the command checks `stopRequested()` itself.
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
- The CLI shebang entry: require `run`, call it with `process.argv`, and hold the last-resort
  handlers — EPIPE-tolerant stream error handlers (a closed pipe after printing what fit is
  success), `unhandledRejection`/`uncaughtException` formatted through `errorText` +
  `sanitizeTerminal` so even an escaped error never prints a raw credentialed URI or terminal
  escapes. The shipped binary **is** this file — plain CJS with a `#!/usr/bin/env node` shebang,
  no build.

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

**(a) Atomic test-and-set with stale reclaim, judged in server time** — `acquire()` upserts on
plain `{_id}` with an **aggregation-pipeline update**: a `$replaceWith`/`$cond` stage that
installs the new holder document when no `lockedAt` exists (fresh insert) or the current one is
older than `$$NOW - ttl`, and otherwise keeps `$$ROOT` untouched. Staleness is decided and
`lockedAt` stamped in **server time** (`$$NOW`), never the client clock — comparing one host's
clock against a timestamp another host wrote means a pod running 90s fast steals every healthy
lock, and one running slow never reclaims a dead one. String fields in the holder document are
`$literal`-guarded so a value starting with `$` can never be interpreted as a field path.
- Two processes racing the very **first** insert: the loser collides on `_id` →
  duplicate-key error → `LockAlreadyHeldError` (with the current holder attached).
- A fresh **upsert-insert** (`upsertedCount === 1`) already proves ownership — the common
  uncontended path (release deletes the document after every clean run) takes one round trip and
  skips the read-back below.

**(b) Owner readback (closes the reclaim race)** — for the non-insert outcomes, `acquire()` reads
the doc back and checks that it is the one it wrote: `owner === ourToken` **and**
`nonce === ourNonce`. If two processes both reclaim the same stale lock, both pipeline updates
succeed but only the last writer's document survives; the loser sees a different one and throws
instead of running concurrently.

The two fields do different jobs. `owner` is the **run id** — the kit passes it in, so the lock
document, the changelog records and the log lines of one run carry one value. Its format, and
therefore its uniqueness, belongs to the user's `generateId`. `nonce` is minted by `acquire()`
itself (`randomId()`, never the user's generator) and exists for exactly that reason: with
`owner` alone, a generator that hands two runs the same id — `() => process.env.DEPLOY_ID`, or a
counter that starts at 1 in every process — would let the second run pass the readback and migrate
alongside the first, then delete the first run's lock on its way out. Correlation is the user's to
shape; mutual exclusion is not. The nonce is never exposed (`toLockInfo` strips it); the owner
is, as `LockInfo.runId`, since it is the run id every event and log line already carries. The
holder also writes its `ttlMs`, so a waiter can size its patience to the holder's heartbeat.

Mixed versions contend safely: a release that predates the nonce compares `owner` only and writes
no nonce, and each side checks just the fields it knows — a nonce-less document can never match a
newer process's readback, and `$replaceWith` drops a stale nonce when an older process reclaims.

**(c) Heartbeat (makes long migrations safe)** — `runWithLock` starts a `setInterval` that calls
`renew()` every `ttlMs/2`. `renew()` is scoped to `{_id, owner, nonce}` so it only refreshes *our* lock and
returns `false` if we've lost it. The interval is `.unref()`-ed so it never keeps the process alive,
and is `clearInterval`-ed in `finally`; the last in-flight renewal is awaited there too, so no stray
query outlives the call and lands after the client is closed.

**(d) Losing the lock aborts the run** — `runWithLock` owns an `AbortController` and passes its
`signal` to the work function. A `renew()` that matches nothing means another process owns the lock,
so the signal is aborted immediately with a `LockLostError`. A renewal that *errors* is only warned
about: the single escalation is a **TTL deadline** (`armDeadline`) that fires strictly before the
lock becomes stale-reclaimable and is re-armed by every successful renewal — so transient failures
are tolerated exactly as long as they are harmless, and the run aborts just before a peer could
legally steal the lock. `#runUp`/`#runDown` check
the signal **between** migrations — the only safe point, where the previous migration has committed
and the next has not started. Set `onLockLost: 'warn'` to keep the old warn-and-continue behavior.
`MigratorKit.stop()` (and the CLI's SIGINT/SIGTERM handler) aborts through the same path with a
`RunAbortedError` carrying the partial results.

**Release** — `deleteOne({_id, owner, nonce})`, scoped so we never delete a lock since reclaimed by
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

### 6.6 The queue adapter (BullMQ)
Files: [src/bullmq/](src/bullmq/). Entry point: `@alexify/migronaut/bullmq`.

**What it is.** Pending migrations enqueued on a BullMQ queue, **one migration per job**, applied
by a worker — so migronaut can run as a service. Each job is nothing more than a single-file run:
`kit.up(name, { batch, ordered: true })` or `kit.down(name, { ordered: true })`.

**The governing idea: Redis holds intent, MongoDB holds truth.** A job says *what was asked*.
Whether it may run, and whether it already did, is decided from the changelog when it executes.
Every design choice below follows from refusing to trust the queue's memory:

- **Order is enforced in the kit, not arranged in the queue.** A flat FIFO queue with worker
  concurrency 1 gives the order in the normal case; the `ordered` guard (inside the MongoDB lock)
  gives it in every other one — a second worker, a misconfigured concurrency, a hand-added job, a
  CLI run in between. Flows (parent/child jobs) were rejected: their API differs across BullMQ
  majors, they cannot be combined with deduplication, and they would move the ordering truth into
  Redis.
- **A failed migration stops the line by itself.** The jobs behind it find it still pending and
  fail as `MIGRATION_BLOCKED` without running. No queue pause, no cross-job state. What tells a
  stopped line from a busy one is the changelog's `'failed'` trace: `MigrationBlockedError`
  carries `context.failed`, and a job blocked only by migrations that never failed (the earlier
  job still in flight on another worker) waits for them within its lock-wait budget
  (`isTransientForJob`) instead of failing its group.
- **`attempts: 1`, always.** A BullMQ retry re-queues the job *behind* the waiting ones, so the
  migrations after it would run first — and be blocked. The one transient condition worth retrying,
  a held lock, is waited out *inside* the job (`withLockWait`), where order is kept. `jobOptions`
  that reorder, delay or re-run a job are rejected by name.
- **Duplicates are harmless by construction.** Two instances enqueuing at boot: the second
  `addBulk` is absorbed by BullMQ deduplication (simple mode — the key lives only while the job is
  waiting or active, so a later down → up is never blocked, which a custom `jobId` would do for as
  long as the finished job is retained). A job that slips through anyway finds its migration
  applied and *completes* as `skipped`. A stalled job re-run by BullMQ does the same.
- **One batch per enqueue.** The producer peeks `nextBatch()` once and every job carries it, so
  `down` reverts a whole enqueue like a whole `up`. It is a peek, not a reservation: two enqueues
  (or a CLI run) racing between peek and first apply share the number and merge into one batch —
  accepted, because the alternative is a counter document on a read path, and dedup + the guard
  already rule out double or out-of-order application.
- **One id format.** The group id of an enqueue call is minted by `kit.generateId()` — the public
  face of the same generator that mints run ids — so a deployment that configured `generateId`
  sees its format in the queue too, and the adapter needs no option of its own. The producer
  re-checks the id (`assertId`) so an unusable one fails the enqueue call rather than every job;
  a duck-typed kit without the method gets a random UUID.
- **Rollbacks are ordered by `appliedAt`, not by name.** An ordered rollback must be the top of the
  applied stack; the producer checks it up front (one synchronous `MigrationBlockedError` instead
  of a group failing halfway) and each job re-checks it under the lock. Name order would deadlock a
  batch that holds a file merged late.

**BullMQ is injected.** `createMigrationQueue({ bullmq: { Queue, Worker, QueueEvents } })` takes
classes or instances; nothing under `src/` requires `bullmq` (pinned by a unit test), and
`bullmq.d.ts` types it structurally. Consequences worth knowing: the adapter feature-detects what
it can (`setGlobalConcurrency`, `upsertJobScheduler`); it cannot `throw new UnrecoverableError`, so
"do not retry" is signalled the way BullMQ itself checks it — by the error's `name` — and only for
jobs that have more than one attempt, so the adapter's own jobs keep their typed class names.

**The processor has exactly three declared parameters** (`job, token, signal`): BullMQ passes the
cancellation signal only when `processor.length >= 3`. The signal (and `processor.shutdown()`)
is bridged to `kit.stop()` and to the lock wait. A migration body that is already running is never
interrupted — it finishes and the job completes; that is the same rule `stop()` has always had.

**One kit, one job at a time.** A processor holds one long-lived `MigratorKit` and serializes jobs
through a promise chain, because a kit rejects overlapping runs. Across processes the MongoDB lock
does that. Global concurrency 1 (set when the worker starts, where BullMQ supports it) is an
optimization — it stops idle pods from each taking a job and queuing on the lock — never the thing
correctness rests on.

**Ownership.** `MigrationQueue` closes what it constructed and nothing else: an injected Queue or
QueueEvents instance, the Redis `connection`, an injected kit and its `MongoClient` all stay open.
Its constructor validates every option *before* constructing the Queue — a Queue opens a Redis
connection, and a constructor that throws afterwards would leak it. `close()` runs in dependency
order: stop taking the lock → worker → QueueEvents → Queue → kit.

**Converge jobs.** A `converge` job is one `kit.converge({ ordered: true })` under the same lock
wait. With `convergeAfterUp`, `planUpJobs` ends a group that reaches the head with one (the kit's
own after-up hook never fires here — every job is a single-file run), keyed for deduplication on
the group's last migration: identical plans from N pods collapse into one job, while a later,
longer plan gets its own at its own tail instead of being folded into a converge that sits in
front of its new migrations. The pending check is the kit's, *inside* the lock (`ordered`), never
a producer-side probe — a probe would race a peer still applying the last migration. With nothing
pending, a dry-run probe decides whether a converge-only job is needed; an idle `sync` tick does
the same, so a definitions-only deploy converges on the next tick without the idle tick taking the
lock. The payload carries no `prune`: what may be dropped is the worker's definitions' decision.

**Untrusted input.** Job data comes back from Redis. `parseJobData` checks it against the contract
before the kit is touched (version, names, positions, and the migration name with the same
`isBareFilename` rule `#filepath` uses); the kit then re-validates — and an `ordered` single-file
`up` (every queue job) refuses a target that is not a file of the migration sequence, so a payload
can never make the worker import a dotfile, a declaration file or a helper module. Everything
BullMQ stores about a failure — message, stack, log rows — goes through `redactOutbound` first
(credentials, and the values a duplicate-key error quotes: a queue keeps failed jobs and serves
them to dashboards), and the cause is folded into the message because `failedReason` is all a
dashboard shows.

**Well-formed is not permitted.** After parsing, a job is checked against the worker's `allow`
policy (`down` on, `force` and `unordered` off by default): a payload can only *ask* to re-run an
applied migration or skip the order guard; the worker decides. The facade applies the same policy
to its own `enqueue*` calls, so a request its worker would refuse fails at the call.

**A job names a file and its version.** An `up` job carries the checksum its plan saw (from
`dryRun('up')` rows); the kit refuses another version under the same name
(`up(name, { checksum })` → `CHECKSUM_MISMATCH`, `context.planned`). A worker from another deploy
therefore never applies a different file than the one that was planned.

**The contract evolves by rule.** A producer writes `JOB_DATA_VERSION`; a worker accepts every
version from `MIN_JOB_DATA_VERSION` up to its own (jobs already queued survive a worker upgrade),
refuses a newer one, and refuses any field outside its per-kind allow-list (`JOB_FIELDS`) — a
meaning it cannot honour must not be dropped silently. Hence: a new field that changes what a job
does bumps the version; workers are rolled out before producers; `MIN_JOB_DATA_VERSION` moves only
in a major. A job always writes `ordered`, so it never inherits a worker's default by accident.
Golden v1 payloads in `tests/unit/bullmq-jobs.test.js` pin what a worker must keep accepting.

**Shutdown puts unstarted work back.** Failing a job is for good (one attempt) and cascades through
its group as `MIGRATION_BLOCKED` — exactly what a rolling deploy would do to every enqueue it
interrupts. So a job the processor's shutdown stops before `migration:start` / `converge:start`
(waiting for the lock, or fetched after the shutdown) is moved back to the head of the wait list
with `job.moveToWait(token)`, and rejects with an error *named* `WaitingError`, which BullMQ
records as neither failed nor completed (matched by name, like `UnrecoverableError`). A job whose
work had begun is never put back. `close()` starts closing the Worker before shutting the
processor down, so a job put back is not fetched again by the same worker.

### 6.7 Declared collections (converge)
Files: [collections.js](src/core/collections.js), [index-spec.js](src/core/index-spec.js),
[converge-plan.js](src/core/converge-plan.js), [converge.js](src/core/converge.js).

**What it is.** Indexes, search indexes and validators declared as an end state (`collections`,
`collectionsDir`) and brought there by `kit.converge()` — stateless: every run reads
`listCollections` + `listIndexes` (+ `$listSearchIndexes` where search indexes are declared) and
plans afresh, and the history it appends is never read back to decide anything. Migrations keep everything with an order and a
history; this is for what only has a current value.

**Pure planner, thin executor.** All decisions live in `converge-plan.js` / `index-spec.js`
(table-tested, no database); `converge.js` reads, executes the steps in order and reports. Steps
per collection: create collection (with its validator) → validator `collMod` → search index
creates, then updates (accepted at once, built in the background — so before the regular builds)
→ index creates → in-place `collMod` (TTL when both sides have one, `hidden`) → rebuilds (drop +
create, back to back, no abort check between) → pruned index drops → pruned search index drops,
last — an index is only removed once everything declared exists.

**The comparison invariant.** Whatever the server stores for a declaration must compare as
unchanged against that declaration, or the index is rebuilt on every run. Hence: `false` booleans
are not sent (`sparse: false` is stored verbatim); text indexes compare in their `_fts`/`_ftsx` +
`weights` form; a collation is a *subset* match for its locale-specific fields (the server expands
`{ locale }` into a full, locale-specific spec — guessing those defaults would loop), while
`strength`, `caseLevel` and `numericOrdering`, whose defaults are the same for every locale, are
filled in (`3`, `false`, `false`) so a live strength-2 index never passes for `{ locale: 'en' }`;
an undeclared one must equal the collection default, `{ locale: 'simple' }` means none; a compound
`Map` key may hold an integer-like field only first (the driver reads keys back as plain
objects, which move such fields to the front); key directions compare by sign, TTLs by `Number()`;
validators via `canonical` (verbatim storage, any key order). Reads force primary and BSON
promotion, so an injected client's settings cannot make everything look changed. And because one
server version is what CI proves, a runtime **fixed-point check** re-plans each collection after
its steps: anything still differing goes to `result.unstable` and a warning, never into a loop.

**Matching.** Declared ↔ live by effective name; then for each index to create, *blockers* among
undeclared live indexes — same key + partial filter + collation, or any text index for a text
declaration (the server refuses either). Without prune, an identical blocker is accepted as is
(`unchanged` + `liveName` + warning) and a different one is a `conflict`; with prune, the blocker
is dropped right before the create. Rebuilds that need each other's drops (a key swap) run as one
group: all drops, then all creates. A plan with any conflict refuses the whole run before the first
write. A rebuild whose create fails re-creates what it dropped from `restoreSpec(raw)`, best-effort,
and reports `restored`.

**History, not state.** Converge never reads what it did before — but every real run that changed
something or failed appends an entry to `convergeLogCollection` ([converge-log.js](src/core/converge-log.js)),
best-effort, with the run id, who and where, `requestedBy`/`reason`, and each row's `from`/`to`.
The collection and its `startedAt` index are created by the first entry, never at connect.

**What the server can do decides how.** `readServer` asks `hello` (a `mongos`?) and `buildInfo` (the
version) once per run. The version feeds `inPlaceCapabilities`: unique-ization by `collMod`
(`prepareUnique` → `unique`, 7.0+, rolled back on duplicates) and adding a TTL (5.1+) become
`modify` steps; behind a `mongos` the shard keys are read so prune keeps their indexes (and a
refused drop is kept, not failed).

**Re-plan, then act.** Each collection after the first is re-read and re-planned right before its
steps; a conflict or a destructive row the initial plan lacked stops the run (`phase: 'replan'`).

**Search indexes.** A `searchIndex` row is planned by `planSearchIndexes` against the live
`$listSearchIndexes` documents, which are read only for collections that declare `searchIndexes`
— a run without any makes no search call, and no probe. Things that differ from regular indexes:
- *Never a rebuild.* `$search` against a missing index returns nothing rather than fail, so a
  drop-and-create would be a silent outage for the whole build. `updateSearchIndex` changes a
  definition in place (the old one serves meanwhile) and is **not** destructive; what it cannot
  change — the type, an `autoEmbed` field's path/model/size/quantization/modality — is a
  `conflict` with the new-name recipe. Only a pruned `drop` is destructive (and confirmed).
- *Is Search there?* `probeSearch` asks once per run, listing the first existing declaring
  collection: an "unavailable" refusal (31082 / 115 / 6047401 / 59 / 40324 — by version) is the
  answer; a non-empty list, or an empty one from 7.2.1+, means yes; an empty list from an older
  server proves nothing (a plain `mongod` of that age answered some lists with `[]`), so
  `getParameter searchIndexManagementHostAndPort` decides — empty or unknown → no, refused → assume
  yes. Without Search, declared search indexes are `conflict` rows (`onSearchUnavailable: 'fail'`,
  refused before any write, with a hint) or `skip` rows (`'skip'`). A refusal at apply time in skip
  mode turns the step's rows to `skip` and Search off for the rest of the run.
- *What the server reports.* `latestDefinition` comes back with defaults written in — top-level,
  per field mapping by type (`FIELD_DEFAULTS`: `string` gains `indexOptions`/`store`/`norms`,
  `number` its representation, `document` `dynamic`, …, recursively through `fields` and `multi`)
  and per vector field — and a field indexed as several types in the server's own order. Both
  sides are filled from the same tables and those lists sorted; the opt-in Atlas suite is what
  proves the tables (atlas-local 8.0 and 8.3). A self-managed `mongot` reports `latestVersion`
  instead of `latestDefinitionVersion.version`, and an Atlas CLI local deployment refuses every
  `updateSearchIndex` of a vector index (with or without `type`): the step fails with the
  new-name recipe as its hint.
- *Builds are asynchronous.* The server accepts a create or update at once. The verify phase
  re-reads a lagging list a bounded number of times (250/500/1000 ms) before calling anything
  unstable, and refreshes each row's `build`. `result.search.notReady` lists declared indexes not
  serving their declaration; **builds never count against `inSync`** (the queue's sync tick would
  otherwise enqueue a converge per tick while an index builds), but `converge --check` fails on a
  FAILED one. `waitForSearchIndexes` adds a wait phase after the last collection: polls back off
  1 s → 10 s, never past `searchIndexWaitTimeoutMs`; an updated index must also report a definition
  version past the one the update started from. FAILED (of an index the run created or changed)
  or timeout → `phase: 'wait'`; a FAILED or STALE index the run did not touch does not hold the
  wait (it is returned as `preexisting` and warned about). A read that fails with a blip (network,
  failover — `isTransientError`) is retried at the next poll, up to three in a row; the pause
  between polls is cut short by an abort.

**After `up`.** The hook lives in `up()`, not `#runUp` (which `redo` reuses): bulk only, no `to`,
definitions resolved before the lock, converge inside the same `#withLock` callback even with zero
pending; on failure the migration rows are attached as `context.results`, the converge result as
`context.converge` — never the other way round, because `#withLock` and `reportError` read
`results` as migration rows.

---

## 7. Cross-cutting conventions

These are enforced by oxlint/oxfmt + review. Violating them is how a PR gets bounced. Note: `never
console.*` and the `MigronautError`-only-throw rule are **not lint-enforced** (oxlint's config here
has no rule for either) — catch these in review.

- **Types:** plain CommonJS, not TypeScript — no `import`/`export` syntax, no type annotations in
  `src/`/`bin/`. JSDoc comments document intent for the reader/editor but are never type-checked
  (no `tsc`/`checkJs` pass over them). The only checked type surface is the hand-written
  [index.d.ts](index.d.ts) and [bullmq.d.ts](bullmq.d.ts), verified against
  [tests/types/](tests/types/) via `tsd`. JSDoc on public methods is still expected.
- **Errors:** never `throw new Error`. Always a `MigronautError` subclass with a typed `code`. Never
  swallow — rethrow or route to `onError`.
- **Logging:** never `console.*`. Always the injected `MigronautLogger`. Core resolves it via
  `resolveLogger`; the CLI builds stream-targeted loggers. `null` logger = silent (used in all tests).
- **Imports/exports:** `require`/`module.exports` only — named exports via `module.exports = {...}`
  (config files are the sole default-export-shaped exception, since they may export an object or a
  factory function directly).
- **Style:** oxfmt/oxlint — single quotes, semicolons, 100-col, no unused vars/imports.
- **Public surface:** anything users should touch must be re-exported from an entry point's barrel
  **and** typed in that entry's declaration file — [src/index.js](src/index.js) +
  [index.d.ts](index.d.ts) for the package root, [src/bullmq/index.js](src/bullmq/index.js) +
  [bullmq.d.ts](bullmq.d.ts) for the subpath. Each pair is maintained by hand in lockstep. If it's
  not in both, it's private — and the `exports` map makes that literal: nothing else is reachable.
- **Injected, never required:** third-party integrations come in through options. `src/` never
  requires `bullmq` (a unit test greps for it), and no `.d.ts` imports an optional package. An id
  format is the same kind of thing: migronaut ships no ULID/CUID implementation, it takes the
  user's `generateId`. So is OpenTelemetry: the tracer and the meter come in through `telemetry`,
  BullMQ's telemetry object through `bullmq.telemetry`, and nothing under `src/` or `bin/` — nor
  either `.d.ts` — imports `@opentelemetry/*` or `bullmq-otel` (a unit test greps for it; the
  structural `MigronautTracer` / `MigronautMeter` types stand in).
- **One place mints ids:** [src/utils/id.js](src/utils/id.js). Calling `randomUUID` anywhere else
  creates an id `generateId` cannot reach (a unit test greps for that too).

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
- **migrate-mongo imports and baselined records are forward-only** (`origin:'migrate-mongo'` /
  `origin:'baseline'`). `down`/`redo` preflight `assertReversible` and refuse them with
  `IrreversibleMigrationError` — imported files use a signature migronaut cannot run, and
  baselined ones were never executed by migronaut at all.
- **A `status:'failed'` record does not make a migration "not pending".** It is a best-effort
  forensic trace of a failed `up` attempt; every run path still treats the file as pending and
  retries it, and a successful apply overwrites the trace. Only `status()`/`audit` surface it.
- **Out-of-order detection warns by default** (`onOutOfOrder: 'warn'`): a bulk `up` names pending
  files that sort before the newest applied one instead of silently applying them late; `'error'`
  refuses the run, `'allow'` silences it. A single-file `up` is exempt — an explicit target is
  deliberate.
- **`--json` is non-interactive, and destructive confirmation needs an explicit `--yes` there.**
  `up <file> --force`, `unlock`, `baseline` and `converge` (for a plan that drops or rebuilds an
  index) all follow the same rule: in `--json` mode without `--yes` they refuse with a typed
  `CONFIG_INVALID` instead of assuming consent or hanging on a prompt no one can answer. New
  confirmation-bearing commands must copy this policy.
- **Path traversal is blocked centrally in `#filepath()`** — every user-supplied migration name (even
  one read back from a tampered changelog) is validated there.
- **`--json` is a global flag** (`migronaut --json status` and `migronaut status --json` both work).
  `init` is the one command with no JSON output — it rejects the flag with a pointer to
  `--format json`, which selects the generated config file's format. In JSON mode, human/progress
  output goes to stderr; stdout is one JSON doc.
- **`down --steps` preserves selection order** (newest-first) via a `preserveOrder` flag, instead of
  the usual filename-desc sort.
- **`batch` on `up` is a label, not a reservation** — it may equal a batch already in use (that is
  how several single-file runs become one rollback unit), and `nextBatch()` is a peek that two
  callers can get the same answer from.
- **Queue jobs get exactly one attempt**, forced over whatever the caller configured — see
  [§6.6](#66-the-queue-adapter-bullmq). Do not "add retries": they reorder the queue.
- **A queue job behind a failed migration fails (`MIGRATION_BLOCKED`) rather than waiting**, and a
  job for an already-applied migration *completes* as `skipped`. Both are the queue doing its job.
  A job behind migrations that are merely not applied yet (no `'failed'` trace) does wait, within
  its lock-wait budget — they may be in flight on another worker.
- **Non-retryable queue errors are renamed `UnrecoverableError` only when the job has
  `attempts > 1`.** The adapter cannot import BullMQ's class; BullMQ matches the name. With the
  adapter's own single-attempt jobs there is nothing to prevent, so the typed name stays.
- **`beforeAll`/`afterAll` fire once per queue job**, because each job is its own run.
- **A job stopped by a shutdown before its migration starts is put back, not failed.** It rejects
  with an error named `WaitingError` after `job.moveToWait(token)` — see
  [§6.6](#66-the-queue-adapter-bullmq). Without a token (a processor driven outside a Worker) it
  fails as `RUN_ABORTED`, as before.
- **A queue job refuses a field it does not know**, even an "optional" one — never ignores it.
  New fields bump `JOB_DATA_VERSION`; workers roll out first.
- **Scheduler ticks get a retention unless `jobOptions` sets one** (100 completed, 500 failed):
  a schedule mints a job per tick forever.
- **A tick holds a failed, unchanged migration.** `sync` enqueues nothing while the next
  migration's `'failed'` trace carries the checksum of the file still on disk (`markFailed` records
  it) — a circuit breaker, since re-running a half-applied migration on every tick is the worst
  retry policy. A changed file, or an explicit `enqueueUp(name)`, resumes it.
- **`generateId` is called with no arguments, and must be synchronous.** No "purpose" argument
  (`'run'`/`'group'`) is passed on purpose: `ulid(seedTime)` and `nanoid(size)` would read it as
  their own first parameter, and passing third-party generators as they are is the point. Async is
  refused because the run id is minted in the same tick as the reentrancy guard that checks it.
- **The lock document carries a `nonce` next to `owner`.** It looks redundant — the owner token
  was already a random UUID — but the owner is now the user-shaped run id, so the lock keeps a
  token of its own. Do not "simplify" the readback, `renew` or `release` back to `owner` alone.
- **An empty enqueue plan still mints a group id** (the handle always has one), so an up-to-date
  `enqueueUp()` costs one generator call.
- **A run that never got the lock emits no span.** The run span is opened inside `runWithLock`'s
  callback, not around it: `runMigrations` and the queue processor poll for a busy lock by
  retrying the whole run every ~500ms, and a span per refusal would bury the run that did the
  work. Refusals are counted (`migronaut.lock.refused`). The lock's own driver commands and the
  heartbeat therefore sit outside the run span — under whatever span was active around the call.
- **The span status code is the literal `2`, and no exception is recorded.** `SpanStatusCode`
  lives in a package migronaut never imports; and `span.recordException(error)` would ship the
  raw message and stack past `errorText` — the status message is the redacted record.
- **A span's status is never set to OK.** OpenTelemetry leaves that to the application; a library
  that succeeds leaves it unset.
- **`telemetry.open` takes its result from the callback, not from the tracer**, and remembers
  whether the callback ran. It looks like belt and braces; it is what stops a broken tracer from
  skipping a migration, or running one twice.
- **The scheduled `sync` job's template carries `telemetry: { omitContext: true }`.** BullMQ builds
  each scheduler iteration from the previous job's options, so a stored trace context would chain
  every tick into one endless trace (confirmed against the real library; the Redis suite pins it).
- **`createMigrationQueue` takes BullMQ's telemetry as `bullmq.telemetry`, not a top-level
  option** — `telemetry` at the top would read as the kit's own (`config.telemetry`), which is a
  different object with a different job.
- **A unique index is never rebuilt unasked.** A rebuild that drops a unique index and builds a
  unique one back plans as a `conflict` unless `converge({ rebuildUnique: true })`
  (`--rebuild-unique`): the constraint is gone until the build ends, and a duplicate written in
  between leaves neither index buildable. The after-up hook and queue jobs never pass it.
- **Converge never drops an undeclared index without prune — not even to "rename" one.** An
  identical index under another name is accepted as is; a rename is a full rebuild and, for a
  unique index, a window without the constraint. Do not make the rename automatic.
- **Converge confirms after reading state, not in `preflight`.** Whether a plan drops or rebuilds
  is only known once the database has been read, so `converge` plans first and asks inside `run` —
  the `unlock` pattern. `--json` without `--yes` refuses only a destructive plan; an additive one
  applies. The plan the operator confirmed and the one applied are two reads apart; the apply
  re-plans under the lock (an accepted race).
- **`up --json` stays the migration rows** with `convergeAfterUp` — an array cannot carry the
  converge result without breaking its consumers. The converge result travels as the
  `converge:end` event, `summary.converge` from `runMigrations`, and `migronaut converge --json`.
- **`dryRun('up')` does not preview a converge.** The plan only means something against the
  database the migrations leave behind; previewing it beforehand would compare with the wrong
  state. It logs a pointer instead.
- **Definition files load at converge time, not config time.** `#ensureConfig` serves every
  command; importing user modules there would let one broken file block an emergency `down`.
  Inline `collections` are pure data and are validated with the rest of the config.
- **A converge job carries no `prune`, and is ordered by default.** Pruning is a property of the
  definitions the worker loaded, not of a payload in Redis; and the tail of a deploy must not
  converge to a schema its own migrations have not reached.
- **No third telemetry wrap site.** A converge run is an ordinary `migronaut.run` span with
  `command: 'converge'`; there are no per-step spans (the driver's index commands nest under the
  run span).
- **A search index is never `recreate`d.** Changing its type, or an `autoEmbed` field's immutable
  attributes, is a `conflict` — even with `prune`. Dropping it to build it again would leave every
  `$search` silently returning nothing until the build ends.
- **A FAILED search index with the declared definition is `unchanged`.** Resubmitting the same
  definition changes nothing; it is reported (`notReady`, a warning, `--check` exit 28), never
  retried — and it does not hold `waitForSearchIndexes`, which only fails on a build the run
  started. Builds in progress or failed do not count against `inSync` — the sync tick would loop.
- **`type` goes to `createSearchIndexes` only for a vector index**, and `updateSearchIndex` is sent
  without one — retried with it only on a self-managed `mongot`'s "mappings is required". Atlas
  documents no `type` on update; an older server refuses a field it does not know.
- **The probe trusts an empty list only from 7.2.1+.** Older plain `mongod`s answered some
  `$listSearchIndexes` with `[]`; the `getParameter` tiebreaker decides, and a server that will not
  say (Atlas restricts it) is assumed to have Search — a refusal at apply time is still reported.
- **Search indexes are not read at all without `searchIndexes`.** No probe, no list, even with
  `prune: true` — "leave a part out to leave it alone" holds for Search too.

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
- **The queue adapter needs no Redis to be tested.**
  [fake-bullmq.js](tests/helpers/fake-bullmq.js) is an in-memory double of the slice of BullMQ the
  adapter uses (its header lists exactly which behaviours it reproduces and which it does not), and
  [stub-kit.js](tests/helpers/stub-kit.js) a stand-in kit for the unit tier. The end-to-end
  behaviour is written **once**, in [bullmq-scenarios.js](tests/helpers/bullmq-scenarios.js), and
  run twice: by `tests/integration/bullmq.test.js` against the fake (always — this carries the
  adapter's coverage) and by `tests/integration/bullmq-redis.test.js` against the real `bullmq`
  package on a real Redis. The second run is what keeps the first honest: when they disagree, the
  fake is wrong. Add adapter behaviour to the scenario module, not to either file.
- **Search indexes:** the unit tier's fake (`tests/unit/converge.test.js`) answers
  `$listSearchIndexes` and the three search commands, with lag, server-side normalization and
  build progress on demand — that carries the coverage. The memory-server suite proves the
  *unavailable* path against a real `mongod`, which has no Search. A server that has it is the
  opt-in, manual `tests/integration/search-atlas.test.js` (`mongodb/mongodb-atlas-local`): every
  scenario ends at a fixed point, which is the only proof that the comparison rules match what a
  real `mongot` reports.
- **Rules:** every feature ships with tests in the same PR. Silence the logger (`logger:null`). No
  `.only`/`.skip` committed — the two sanctioned exceptions are `bullmq-redis.test.js` and
  `search-atlas.test.js`, which skip themselves *with a reason* when `MIGRONAUT_TEST_REDIS_URL` /
  `MIGRONAUT_TEST_ATLAS_URI` is unset: environment-capability skips (CI sets the Redis variable via
  a Redis service and never the Atlas one), not disabled tests. The coverage gate must pass
  without them. Test file names mirror source names. Coverage gate: **90% lines / 90%
  funcs / 90% branches**, enforced via `c8` (`pnpm run test:coverage`).
- **Gotcha:** Node caches dynamic `import()` by path. A test that rewrites the *same* migration
  filename mid-run will re-load the *cached* module. Use a new filename, or assert via a read-only
  path (`pendingMigrations`), when you need "changed file" behavior.
- **Type coverage:** the public type surface ([index.d.ts](index.d.ts), [bullmq.d.ts](bullmq.d.ts))
  is checked separately by `tsd` against [tests/types/](tests/types/) — `pnpm run test:types`.
  This is a type-assertion pass over hand-written types, not a build/typecheck step.
  `bullmq.test-d.ts` also asserts that the *real* BullMQ classes satisfy the structural
  `BullMQ*Like` types — the one place that claim is checked, since the declaration file itself
  never imports bullmq. `esm-interop.test.js` additionally compiles a `nodenext` consumer, the only
  check that `exports["./bullmq"].types` resolves for modern TypeScript (tsd and `check:dts` use
  classic resolution, which ignores the exports map).
  `index.test-d.ts` does the same for OpenTelemetry — part by part (the real `Span` against
  `MigronautSpan`, the options type against the real `SpanOptions`, the meter and its instruments),
  because `expectAssignable<MigronautTracer>(realTracer)` alone proves little: a real tracer's
  two-argument overload matches almost any shape.
- **Telemetry tests** use the real SDK with in-memory exporters ([tests/helpers/otel.js](tests/helpers/otel.js)).
  `startTracing()` registers the global context manager — without one nothing can be made active
  and no span gets a parent — which is safe because `node:test` runs each file in its own process.
  `telemetry-mongodb.test.js` additionally loads the real `@opentelemetry/instrumentation-mongodb`,
  and must do so *before* anything requires the driver: it is the one test of the claim that
  driver spans nest under a migration. The trace across a queue is BullMQ's doing, so it is
  asserted only in the real-Redis suite.
- **Concurrency note:** the lock-heartbeat integration tests use real timers; running the *full*
  integration suite in parallel (many concurrent `mongodb-memory-server` replica sets) can make
  timing-sensitive tests flaky under heavy CPU contention. They're stable in isolation — not a
  correctness issue.

Useful commands:
```bash
pnpm test                                  # unit + integration (~1200 tests)
node --test tests/integration/up.test.js   # one file (boots its own replica set)
pnpm run test:coverage                     # full suite under c8, gated at 90/90/90
pnpm run test:types                        # tsd — index.d.ts + bullmq.d.ts vs tests/types/*.test-d.ts
pnpm run check:dts                         # tsc --noEmit --strict over both .d.ts files alone
# opt-in: the adapter scenarios against the real bullmq + Redis (CI runs this)
docker run --rm -d -p 6379:6379 redis:7-alpine
MIGRONAUT_TEST_REDIS_URL=redis://127.0.0.1:6379 node --test tests/integration/bullmq-redis.test.js
# opt-in, manual: declared search indexes against Atlas Search (CI does not run this)
docker run --rm -d -p 27018:27017 -e DO_NOT_TRACK=1 mongodb/mongodb-atlas-local:8.0
MIGRONAUT_TEST_ATLAS_URI="mongodb://127.0.0.1:27018/?directConnection=true" node --test tests/integration/search-atlas.test.js
```

## 10. No build, lint, release

- **No build step, ever.** migronaut ships exactly what's in `src/`/`bin/` — plain CommonJS, no
  compile pass for authors or consumers. The package version is read from `package.json` at
  runtime (`bin/migronaut.js`), not injected at build time.
- **Types:** two hand-written declaration files at the package root, one per entry point —
  [index.d.ts](index.d.ts) and [bullmq.d.ts](bullmq.d.ts). There is no generation step and no `tsc`
  pass over `src/`. Correctness is enforced by `tsd` (`pnpm run test:types`) against
  [tests/types/](tests/types/), and `pnpm run check:dts` compiles both files in one program.
- **Lint/format:** `pnpm run lint` (`oxlint src bin scripts tests bench examples`), `pnpm run format`
  (`oxfmt` to fix formatting), `pnpm run format:check` (`oxfmt --check`, no writes). The two root
  shims (`index.js`, `bullmq.js`) are one-line re-exports and are not in the globs.
- **Bundle-size report (informational only):** `pnpm run size` runs `scripts/size.js`, which uses
  esbuild to report library, CLI and queue-adapter bundle size — it does not produce a published
  artifact. `bullmq` is deliberately *not* marked external there: the adapter never imports it, so
  an accidental `require('bullmq')` would show up as a jump in the adapter's number.
- **Benchmarks (informational only, manual):** `pnpm run bench` runs `bench/bench.js`, a
  zero-dependency `node:perf_hooks` harness measuring ops/sec for the hottest paths
  (`checksum`, `loader`, `Changelog`, `MigrationLock`) — the DB-bound scenarios spin up a
  throwaway in-memory MongoDB replica set for the run. Not run in CI; results are hand-copied
  into the README's Benchmarks section before releases.
- **Published artifact:** exactly what `files` in [package.json](package.json) lists —
  `index.js`, `index.d.ts`, `bullmq.js`, `bullmq.d.ts`, `migronaut.schema.json`, `bin`, `src`,
  `README.md`, `CHANGELOG.md`. The `exports` map exposes two entry points (`.` and `./bullmq`) and
  nothing else. `docs/`, `blog/`, `examples/` and this `ARCHITECTURE.md` live in the repo but are
  **never** shipped to npm.
- **Release:** manual — bump `version` in `package.json`, write the dated entry in `CHANGELOG.md`
  by hand, commit and tag, then `pnpm run release` (= `pnpm publish`). `prepublishOnly` re-runs
  lint + format:check + test:coverage + test:types + check:dts as the pre-publish gate.
- **Publish-account hygiene:** the npm account publishing this package keeps 2FA required for
  publishes ("Require two-factor authentication and disallow tokens" in the package's npm access
  settings, or granular tokens with short expiry). For a zero-dependency package marketed on its
  absent supply-chain surface, the account itself is the one remaining door — this is the manual
  release flow's only (and sufficient) safeguard; no CI or provenance pipeline is used.
- **Commits:** Conventional Commits required (`feat(scope):`, `fix(scope):`, `test(...)`, etc.).

## 11. Recipe: how to add a new command/feature

Concrete worked path — say you're adding `migronaut verify` (re-checks all checksums):

1. **Types** ([index.d.ts](index.d.ts)) — add any new result/option type and, if needed, a new
   `MigronautErrorCode` literal. Each entry point has exactly one hand-written `.d.ts`
   (`index.d.ts` for the root, `bullmq.d.ts` for the queue adapter); there is no per-file or
   generated alternative. A change to the adapter's surface goes in `src/bullmq/index.js` +
   `bullmq.d.ts` instead, and its behaviour in `tests/helpers/bullmq-scenarios.js`.
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
10. **Verify:** `pnpm run lint` → `pnpm run format:check` → `pnpm run test:coverage` →
    `pnpm run test:types` → `pnpm run check:dts` (this is exactly what `prepublishOnly` runs —
    no build step to add; note the coverage-gated `test:coverage`, not plain `pnpm test`).

**Where logic goes (decision rule):** mutation sequencing → a `runX` worker in `migrator.js`; a
reusable mechanism (hashing, locking, mapping) → its own `core/`/`utils/` module; anything about how
it *looks* or *exits* → the CLI layer.

## 12. Glossary

- **Batch** — a group of migrations applied together, sharing a `batch` number; the unit `down`
  reverts by default.
- **Enqueue group** — the jobs one `enqueueUp()`/`enqueueDown()` call added to the queue; an `up`
  group shares one batch.
- **Job contract** — the versioned shape of a queue job's data (`src/bullmq/jobs.js`), validated
  by the worker as untrusted input.
- **Sync job** — the queue job a schedule tick adds: it plans what is pending and enqueues it.
- **Converge job** — the queue job that runs `kit.converge()`: the tail of an `up` group (with
  `convergeAfterUp`), a converge-only job, or a scheduled one.
- **Declared collection** — a `collections` / `collectionsDir` entry: indexes and a validator as
  an end state.
- **Converge** — compare declared collections with the live database and apply the difference;
  stateless. **Drift** is anything a converge would do; a kept undeclared index is not drift.
- **Prune** — let converge drop indexes a definition does not declare.
- **Changelog** — the `_migronaut_migrations` collection; the append-mostly audit trail of `MigrationRecord`s.
- **Checksum** — SHA-256 of a migration file at apply time; re-checked later to detect tampering.
- **Context** — the `{ db, client, mongoose?, session? }` object passed into every `up`/`down`.
- **Heartbeat** — the periodic `renew()` that keeps a long migration's lock fresh.
- **Hooks** — user callbacks (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`/`onError`) run around
  migrations.
- **Migrator** — `MigratorKit`, the orchestrator class.
- **Origin** — `'migrate-mongo'` marks an imported, forward-only record (cannot be reverted).
- **Owner token** — the lock document's `owner`: the run id of the run holding the lock (a random
  UUID, or whatever `generateId` returns). Paired with a lock-minted `nonce`, which is what
  actually proves which process holds it.
- **Run id** — one id per locked run, stamped on its changelog records, events and log lines and
  stored as the lock's owner token. Also the `migronaut.run.id` span attribute.
- **Run span / migration span** — `migronaut.run` and `migronaut.migration`, emitted through an
  injected OpenTelemetry tracer. The migration span is the active context while a migration runs.
- **Telemetry** — the `telemetry: { tracer, meter }` config option: the user's own OpenTelemetry
  objects. Not to be confused with `bullmq.telemetry`, BullMQ's own telemetry object.
- **Progress reporter** — the CLI-injected callback that drives the spinner without core ever
  importing one.
- **Step** — Laravel-style per-file batching (`up --step`) / per-file rollback (`down --steps N`).

---

*Keep this file honest. If you change behavior and this doc still describes the old way, the doc is a
bug — fix it in the same PR.*
