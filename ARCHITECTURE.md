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
calling `kit.up(name)` / `kit.down(name)` (and, since 2.3, background migrations as coordinator and
lane jobs on a queue of their own). Beside them sits a fourth, engine-free entry point: the
**versioning runtime** (`@alexify/migronaut/versioning`, [§6.9](#69-document-versioning-and-the-versioning-subpath)) —
small helpers an application's repository layer uses for the shape version (`__v`) and the
optimistic-concurrency revision (`__rev`) that converge declares and background migrations write.

Since 2.3 the engine also runs **background migrations** ([§6.8](#68-background-migrations)):
long data rewrites that `up` only registers, and that partitions, leases and a coordinator then
carry out beside the migration line — never holding the migration lock.

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
versioning.js                # module.exports = require('./src/versioning/index.js') — the ./versioning subpath
versioning.d.ts              # Hand-written types for it (structural driver types, the shape-map machinery)
src/
├── index.js                 # Public API barrel of the package root
├── errors/index.js          # MigronautError base + one subclass per error code
├── versioning/              # The versioning runtime — requires nothing but its siblings and errors/
│   ├── internal.js          # PURE: plain-object/BSON helpers, counts, BSON-aware sameValue, touched fields
│   ├── config.js            # PURE: versioning keys, defaults, validation, resolve, versioningOf
│   ├── document.js          # PURE: the shared contract — version/revision filters, occFilter, stampedDiff
│   ├── occ.js               # updateWithRevision & co., retryOnConflict, bumpRevision
│   ├── registry.js          # defineShapes() — stamp, onInsert, stampUpsert, upcaster, plugin
│   ├── upcaster.js          # The in-memory upcaster (and its step() for background migrations)
│   ├── mongoose.js          # versioningPlugin — never requires mongoose
│   └── index.js             # Barrel of the ./versioning subpath
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
│   ├── converge-search-run.js # The search half of a converge run: read, report, wait for builds
│   ├── server-info.js       # Read options, read pace, server version/topology, not-found codes
│   ├── converge.js          # runConverge() — read live state, plan, carry the plan out
│   ├── converge-log.js      # ConvergeLog — the append-only converge history (_migronaut_converge)
│   ├── import.js            # PURE migrate-mongo → MigrationRecord mapping
│   ├── import-runner.js     # runImport() — the impure import flow (read/map/write)
│   ├── run.js               # Programmatic helpers: runMigrations(), pendingMigrations()
│   ├── versioning-spec.js   # PURE: a collection's versioning as validator rules, an index, a floor guard
│   ├── shard-info.js        # A collection's shard key and chunks, from config (clusterMonitor)
│   ├── background-spec.js   # PURE: background specs, settings, state transitions, scopes, keysets
│   ├── background-partition.js # The _id-range partitioner (sampled _id quantiles per BSON bracket)
│   ├── background-shard.js  # The shard-aware partitioner, targeted writes, the shard-key guard
│   ├── background-store.js  # BackgroundStore — state, partitions, leases (= slots), fenced checkpoints
│   ├── background-engine.js # One batch / one partition: read, transform, stampedDiff, OCC write
│   ├── background-throttle.js # pauseMs, the throttle hook, replication lag, the AIMD controller
│   ├── background.js        # The flow: coordinate, runSlice, control, verify (drift), audit findings
│   ├── background-sandbox.js # The always-aborted transaction + allow-list proxies of a dry run
│   ├── background-dry-run.js # previewSample / previewSteps
│   ├── background-runner.js # startBackgroundRunner() — lanes in the application's own process
│   ├── background-watch-plan.js # PURE: the live drift watcher's edges, pipeline, error reading
│   ├── background-watch-store.js # Its resume tokens and leaders (<backgroundCollection>_watch)
│   ├── background-watch.js  # The live drift watcher: change streams, one leader per collection
│   └── bson-peer.js         # The one lazy require('mongodb').BSON outside migrator.js
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
    ├── background-processor.js # createBackgroundProcessor() — coordinator, lane and verify jobs
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
| **Integration adapter** | `bullmq.js`, `src/bullmq/` | Drive the kit's *public* API from queue jobs; own the Queue/Worker lifecycle | Require a mechanism module (`lock`, `changelog`, `runner`, any `background-*`) or touch the DB; `require('bullmq')`; call `console.*` |
| **Versioning runtime** | `versioning.js`, `src/versioning/` | Pure helpers and thin driver calls for an application's repository layer | Require anything outside `src/versioning/` and `src/errors/` — no core, no `mongodb`, no `mongoose` (pinned by a test) |

The background modules split the same way: `background-spec.js`, `background-watch-plan.js` and
the planning halves of the partitioners are pure; `background-store.js`,
`background-watch-store.js`, the engine and the throttle are mechanism; `background.js` and
`background-watch.js` are flows that receive what they need as `deps` from the kit (like
`converge.js`), and only `migrator.js` builds those deps. The core may require `src/versioning/`;
`src/versioning/` never requires the core.

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
  was injected. There are exactly three wrap sites, all here, so the mechanism modules stay
  ignorant of it:
  - `#withLock` opens the `migronaut.run` span around the callback it hands to `runWithLock` — i.e.
    *after* the lock is held — and hands it to its `RunRecorder`, which ends it in the `finally`,
    after the release, from the same summary `run:end` is built from. A refused acquisition
    therefore opens no span; it increments `migronaut.lock.refused` instead.
  - `#executeMigration` wraps `#executeMigrationSteps` (hooks, load, body, changelog write) in the
    `migronaut.migration` span, which makes it the *active* span for everything the migration
    does, and records the duration histogram on both the success and the failure path.
  - `#backgroundDeps` hands `background.js` a `span(kind, name, fn)` that wraps one background
    step: `migronaut.background.slice` (one lease held by one lane) or
    `migronaut.background.coordinate` (one coordinator step). Each is opened only once the lease or
    the coordinator lock is held — a `busy` answer opens none — and is active for that step's
    driver commands. Background migrations run outside `#withLock`, so this third site is
    separate from the run span.

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
  run. The span is still *opened* in `migrator.js` — one of the kit's three wrap sites.

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
  `effectiveDefinition` (`SEARCH_DEFAULTS` & co. filled in), `tolerateServerOptions`,
  `compareSearchIndex` (`{ diffs, paths, more, typeChange, immutable, ignored }`),
  `searchBuildState` (`serving`/`updating`/`building`/`stale`/`failed`/`removing` — the one word
  every reporter uses), `isSearchIndexReady`, `searchBuild`, `searchIndexSpec`.
- **The invariant** is index-spec.js's: what the server reports for a declaration must compare as
  unchanged against it — hence defaults filled on *both* sides, from one table. What the tables do
  not know, `tolerateServerOptions` drops: after the fill, an option the live side has and the
  declared side lacks can only be one whose default migronaut does not know, so it is left out
  (and named in `ignored`) rather than turned into an update — and a rebuild — on every run. Only
  option objects are trimmed (definition, `mappings`, field mappings with their `fields`/`multi`,
  vector fields and `hnswOptions`); a field, a mapping type or a vector field only the server has
  stays a difference. Keys are written with `canonical.js`'s `assign`, so a field named
  `__proto__` stays a field.

### `src/core/converge-search.js` — Atlas Search, the mechanism
- **Responsibility:** the raw search commands (`runSearchStep`: create, update — retried once with
  its type for a self-managed `mongot` — and drop, tolerating "already gone"),
  `listSearchIndexes`, `probeSearch` (does the server have Search at all — see
  [§6.7](#67-declared-collections-converge)), `isSearchUnavailable` / `searchHint` (what the
  server's errors mean), `isTransientError` (a read worth trying again), and
  `awaitSearchIndexes` / `nextPollDelay` (the optional wait). Returns outcomes; converge.js
  decides what they do to a run.

### `src/core/converge-search-run.js` — the search half of a converge run
- **Responsibility:** what converge.js calls in at each phase when definitions declare search
  indexes — `readSearch` (the probe, then every declaring collection's list), `readSearchIndexes`
  (a failed read reported in the phase that read it), `warnIgnored` / `warnSkipping`,
  `searchSummary` (`result.search`), `refreshBuilds` (the verify phase), `waitPhase` (release the
  lock, poll, emit `converge:wait`, record the metric point, fail on a build the run started),
  and `reportNotReady` (the closing lines). Orchestration over the same `deps` as converge.js;
  split out so the main flow reads as one. `pause` (an abortable sleep) and
  `SEARCH_SETTLE_DELAYS_MS` live here too.

### `src/core/server-info.js` — what is read about the server, and how
- **Responsibility:** `READ_OPTIONS` (primary, plain-JavaScript BSON — forced onto every converge
  and audit read), `READ_CONCURRENCY`, `readServer` (mongos or not, version with patch) and the
  `NAMESPACE_NOT_FOUND` / `INDEX_NOT_FOUND` codes — shared by converge, its search half and the
  audit, so none of them reaches into another for it.

### `src/core/converge-plan.js` — the converge planner (pure)
- **Responsibility:** `planCollection(definition, live, { prune, search })` → `{ name, actions,
  steps }`: result rows (`create`/`modify`/`recreate`/`drop`/`keep`/`unchanged`/`conflict`/`skip`)
  and the steps that carry them out, in execution order, each pointing at the rows it settles.
  `planSearchIndexes` plans the `searchIndex` rows. Plus `isDestructive`, `needsConfirmation`,
  `SERVED_ACTIONS`, `TARGET_LABELS`, the validator helpers.

### `src/core/converge.js` — the converge flow
- **Responsibility:** `runConverge(deps, options, signal)`, in phases that are functions of their
  own: *read and plan* (`readAndPlan` — every live state in one `listCollections` plus bounded
  `listIndexes`, primary reads with forced BSON promotion; shard keys behind a mongos), *guard*
  (`refuseConflicts`), then per collection *re-plan* (`replan`), *apply* (`applyCollection` — the
  steps one by one, an abort check between them) and *verify* (`verifyFixedPoint`), and finally
  *report* (`reportSuccess` / `reportFailure` — closing lines, the history entry, `converge:end`).
  Everything the report needs — `changed`/`inSync`, collections touched, undeclared indexes kept,
  the per-action `counts`, the history rows, the search indexes not serving — comes from one pass
  over the rows (`tally`, behind `finalize`), which also settles the rows never reached.
- **Key exports:** `runConverge`, `readLiveState`, `readLiveStates` (`READ_OPTIONS` lives in
  `server-info.js`). Same `runX(deps)` injection pattern as audit, import and baseline.

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

### `src/core/background*.js` — background migrations
Background migrations get their own section, [§6.8](#68-background-migrations). In short:
`background-spec.js` validates a file's `background` export and holds the pure tables (defaults,
the state transitions, `_id` brackets, keysets); the two partitioners (`background-partition.js`
by `_id`, `background-shard.js` by shard key) plan a pass and build each batch's query;
`background-store.js` owns the state and partition documents and their leases;
`background-engine.js` rewrites one batch and works one partition; `background-throttle.js`
paces it; `background.js` is the flow (`coordinate`, `runSlice`, `control`, `verify`, the audit
findings); `background-sandbox.js` and `background-dry-run.js` preview without writing;
`background-runner.js` drives lanes in-process; and `background-watch*.js` are the live drift
watcher. `shard-info.js` reads a collection's shard key and chunks from `config`, and
`bson-peer.js` is the only place besides `migrator.js` that requires `mongodb` (lazily, for
`BSON`: a checkpoint's size, EJSON for a dry run, the Long/MinKey/MaxKey bounds of a shard-key
range).

### `src/versioning/` — the versioning runtime
The `./versioning` subpath: see [§6.9](#69-document-versioning-and-the-versioning-subpath). It
requires nothing outside itself and `src/errors/` — no core, no `mongodb`, no `mongoose` (a
test pins that). `document.js` is the contract the background engine shares with application code
(version and revision filters, `occFilter`, `stampedDiff`), so a background migration and a
repository write by the same rules.

### `src/bullmq/` — the queue adapter
Six small modules behind the `./bullmq` subpath; see [§6.6](#66-the-queue-adapter-bullmq) for
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
- **`background-processor.js`** — `createBackgroundProcessor()`: the function a Worker on the
  background queue runs — a coordinator job, a lane job or a drift-watch tick; jobs run side by
  side, every decision is the kit's (`coordinateBackground`, `runBackgroundSlice`).
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

**Early release** — the work function gets a second argument, `control`, whose `release()` gives
the lock up before the work returns: it stops the heartbeat and the deadline, awaits the renewal in
flight, deletes the document, fires `onLockReleased({ early: true })` (`lock:released` with
`early: true`) and resolves to whether it worked. It is for a tail that only reads — converge
waiting for search index builds — so the next deploy or a queue's next job need not wait out a
build. The run goes on (its id, span and `run:end` are unchanged); a stop still aborts it, a lost
lock no longer can. Idempotent; a failed early release is warned about and retried at the end;
under `noLock` it resolves `false`.

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

**Background migrations on the queue (2.3).** A queue with the `background` option gets a second
queue, `<queueName>-background`, with its own Worker (concurrency 2 by default) and processor, so
a migration job never waits behind a background one. Here flows *are* used — differently from the
line above, and for a reason that does not apply there: the ordering truth stays in MongoDB.

- A **coordinator** job per background migration (`background`, deduplicated on its name, a few
  attempts with a long backoff as the outer safety net) asks the kit for one coordinator step.
  When lanes have work it adds them as **children** (`parent` + `moveToWaitingChildren`) and
  waits; it wakes once its last lane is done and asks the kit again — the kit decides from
  MongoDB whether to spawn more, plan another pass, or finish. `wait`/`busy` answers move it to
  delayed (`DelayedError`, matched by name like `WaitingError`).
- **Lanes** (`background-lane`) run one slice each and continue themselves with `moveToDelayed`
  between slices; they *complete* for every outcome the kit recorded and give up (complete as
  `gave-up`) after `maxLaneRetries` failed slices, each counted on its partition in MongoDB.
  They carry `ignoreDependencyOnFailure: true` — verified on BullMQ 6.3.11 (and pinned by the
  fidelity scenarios): `failParentOnFailure` fails the parent without running it (no finalize),
  `continueParentOnFailure` wakes it while siblings still hold leases, and with no option a failed
  child strands the parent in `waiting-children` for good. A lane's id is new for every spawn
  (`…-r<round>-s<spawn>-l<k>`): BullMQ will not move an existing job to another parent, and
  deduplication cannot be combined with `parent`.
- **Rounds.** A coordinator chain takes the round after the last one recorded on the state
  document and keeps it in its job data; the kit refuses an older round (`superseded`). That is
  what makes a **stall takeover** safe: a heal (worker start, every sync tick, every drift-watch
  tick) adds a coordinator for every runnable background migration — absorbed by the chain that
  is alive — plus, for one nothing has moved for `stallMs`, a takeover deduplicated per round.
- **Heals are the recovery for everything Redis can lose.** Plans, cursors, leases and counters
  are in MongoDB; a flushed queue costs one heal, not work. A queue without parent support (or
  `children: false`) deduplicates lanes per slot and lets the coordinator poll instead.
- **The `up` side.** The migration processor enqueues the coordinator of whatever an `up` (or a
  `down`) job registered (`background:registered`); and an `up` plan stops before an ordinary
  migration that requires a background one not completed yet (`plan.waiting`, a sync tick's
  `held.waitsFor`) — a background file that requires one is not held: it registers as blocked.
- **Close order:** the drift watcher, then both workers together (both processors told to stop: a
  lane checkpoints at its batch boundary and moves itself back to delayed for the next worker),
  then both processors, QueueEvents, the queues, the kit.

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
  proves the tables (atlas-local 8.0 and 8.3). A default the tables lack is tolerated (see
  `tolerateServerOptions`) and warned about once per run; a *value* the server changes for a
  known default still shows as `unstable`, with the paths and a warning that every update builds
  the index again. A self-managed `mongot` reports `latestVersion`
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
  version past the one the update started from. The wait only reads, so it starts by giving the
  migration lock up (`deps.releaseLock` → `runWithLock`'s early release); `converge:end` and the
  history entry still come after it. FAILED (of an index the run created or changed)
  or timeout → `phase: 'wait'`; a FAILED or STALE index the run did not touch does not hold the
  wait (it is returned as `preexisting` and warned about). A read that fails with a blip (network,
  failover — `isTransientError`) is retried at the next poll, up to three in a row; the pause
  between polls is cut short by an abort.

**After `up`.** The hook lives in `up()`, not `#runUp` (which `redo` reuses): bulk only, no `to`,
definitions resolved before the lock, converge inside the same `#withLock` callback even with zero
pending; on failure the migration rows are attached as `context.results`, the converge result as
`context.converge` — never the other way round, because `#withLock` and `reportError` read
`results` as migration rows.

### 6.8 Background migrations

Files: `src/core/background*.js`, `src/core/shard-info.js`, `src/bullmq/background-processor.js`.

**What it is.** A background migration is a migration file with `export const background =
{ collection, from, to, migrate | migrateBatch, … }` (or a free-form `step(ctx)`) instead of
`up`/`down`. `up` only **registers** it — the changelog record (`kind: 'background'`) and a state
document — and the line goes on. The rewrite itself runs beside the line, for as long as it takes,
in any number of processes: lanes in the CLI (`background run`), in the application
(`startBackgroundRunner`) or on the queue ([§6.6](#66-the-queue-adapter-bullmq)). It never holds
the migration lock. An ordinary migration that must wait for it says so with `export const requires
= [...]`; the kit checks that *before* `beforeEach` (no hook fires, no failed trace) and refuses
with `BackgroundPendingError` — or, with `onBackgroundPending: 'stop'`, ends the line cleanly.

**Where the truth is.** MongoDB, always: `<backgroundCollection>` holds one state document per
background migration (status, phase, plan, generation, pass, totals, requires/waitsFor, history),
`<backgroundCollection>_partitions` one document per range of the current plan (cursor, counters,
lease), `<backgroundCollection>_watch` the live drift watchers' positions. Processes and Redis are
only executors; anything they lose is recovered from these.

**Leases are slots.** A lane claims a partition and a slot `0..maxParallel-1` in one atomic write;
a unique partial index on `{ background, lease.slot }` makes "at most `maxParallel` at once" an
invariant of the schema, across every pod. Expired leases are reaped in server time (`$$NOW`).
Every checkpoint is fenced by the lease token, so a lane that lost its lease (a GC pause, a
partition) stops at the next batch boundary; the lease is heartbeated through the same
`runWithLock` that holds the migration lock (any object with `acquire/renew/release/ttlMs` is a
lock there). On a sharded collection a second unique partial index, `{ background,
lease.groupSlot }` (`<shard>#<k>`), caps the lanes per shard (`shardConcurrency`); a claim picks
its candidate first and rules out a full shard by name, so losing that race never reads as busy.

**The coordinator.** One idempotent step at a time under the `background:<name>` lock (a
`MigrationLock` with an id of its own; `forceUnlock` and `unlock` never touch it): unblock what
waits for others, plan a pass (partitions committed under a fresh plan token with a CAS on the
state — a coordinator that lost the race leaves partitions nobody can claim, dropped next time),
tell the drivers how many lanes have work, and finalize: roll the partitions' counters into the
state once per generation (`rolledGeneration` makes it idempotent after a crash), then **count
what is left** — zero completes it, anything left starts another generation over just that, and
`maxPasses` passes that never drain it fail it ("an old release is still writing the old shape").
Completion is decided by that count alone; partitions only spread the work. The state transitions
are a pure table (`background-spec.js`).

**One batch.** Read through the version index (`READ_OPTIONS` — the transform sees plain JS
values), transform a copy, `stampedDiff` it against what was read — `$set` only the top-level
fields that changed, `$unset` those that went, `$set __v`, `$inc __rev` — and write with the
optimistic filter (`_id`, the exact version and revision read; on a sharded collection the shard
key too). A write that matched nothing is re-read: still old → transformed again (up to
`maxConflictRetries`), gone or new → skipped. Writing only the diff keeps the BSON types of every
field the transform did not touch (a full replace would write a `Double 1.0` back as an `Int32`).
The checkpoint follows; a crash between the two replays the batch, which the version filter makes
a no-op. **Transactional mode** reads, writes and checkpoints in one snapshot transaction (the
fenced checkpoint is its last write, so a lane that lost its lease cannot commit), with its own
retry loop (transient errors, commit-unknown, time/size limits → a smaller batch), and lets the
transform write elsewhere through `ctx.session`.

**Pacing.** `pauseMs` and the `throttle` hook before each batch, replication lag
(`replSetGetStatus`, quietly off without the privilege), and the AIMD controller per process and
shard: slow or overloaded writes halve the batch, then double the pause; healthy ones grow it back
— never past the author's `batchSize`.

**Drift.** After `completed`, an old pod can still write the old shape. Three lines of defence: the
validator once `min` is raised (converge refuses to raise it over old documents); the `requires`
guard and the min guard both look at the data, not the status; and the drift watch — a probe per
completed migration (`verifyBackground`, every 10 minutes in each runtime by default) that reopens
it (`backgroundOnDrift: 'reopen'`) or reports it — plus, opt-in, the **live drift watcher**
(`watchBackground`, `backgroundDrift: 'stream' | 'both'`): a change stream per collection, one
leader per collection (`watch:<collection>` lock), its token kept in the `_watch` collection (at
most every `checkpointMs`, the post-batch token while idle). It upgrades a document through the
lanes' own write path, edge by edge, only with completed forward migrations, and stands aside
while a revert works the collection. A fresh start opens the stream *before* it probes the past,
so nothing falls between the two; a lost history (286/280/136) starts over from now; a stream more
than `maxLagMs` behind reopens its background migrations rather than becoming one. In `'stream'`
mode the poll skips a collection whose watcher is streaming and fresh.

**Dry runs** never write: a sample previewed in memory, `--validate` through the real write path in
a transaction that is always aborted, and a `step` migration's steps in the same sandbox behind
allow-list proxies of `db`/`client`/`session` (anything else is refused, exit 34). The sandbox is
a guard rail, not a security boundary — code can reach around it.

**Sharded clusters.** On a sharded collection whose key can be read (`clusterMonitor`) and whose
version index carries it (`{ __v, …shard key, _id }`, converge's), partitions follow runs of
adjacent chunks on one shard, split further at sampled key quantiles (or arithmetically, for a
hashed first field) when a shard's lanes want more. A batch reads the version index with exact
`min`/`max` bounds plus a targeting predicate; a ranged key keeps a keyset cursor of index tuples,
a hashed one drains (rewritten documents leave the range by themselves; at most 100 stuck ones are
stepped over by id). Writes carry the shard key; a transform that changes it is a document error
(`shard-key-changed`). A plan records the collection's epoch (uuid, key): resharded since, the
pass is re-split. Without the privilege, or without that index, the collection stays on `_id`
ranges ("untargeted"), said once per process.

**On a sharded cluster: what the probes established.** The shard-aware side rests on what a
mongos and the `config` database actually do — so those assumptions were probed on a real cluster
before anything was built on them (`tests/integration/sharded.test.js`, the `[probe]` cases;
MongoDB 8.0, two shards behind a mongos). What they established, and what follows from each:

- **Where the layout lives.** `config.collections` holds a sharded collection's `key`, `uuid` and
  `timestamp` (the epoch); `config.chunks` lists its chunks **by `uuid`** — a 5.0+ chunk carries
  no `ns` — each with `min`, `max` and `shard`, the first from `MinKey`, the last to `MaxKey`.
- **8.0 tracks unsharded collections too.** A collection moved with `moveCollection` appears in
  `config.collections` as `unsplittable: true` with the key `{ _id: 1 }`. It is on one shard and
  has no key to partition or target by: read it as **not sharded**.
- **Hashed bounds are 64-bit.** The bounds of a hashed chunk are `NumberLong`s — which the driver
  turns into plain numbers by default (`promoteLongs`), losing precision past 2^53. Chunks are read
  with `promoteLongs: false`.
- **`min`/`max` do not target; a predicate does.** A `find` bounded by `min`/`max` alone (with the
  hint they need) goes to every shard. A range predicate on the shard key alongside them targets
  the shards that own it, and through the mongos `min`/`max` still return exactly that range,
  merged in index order when sorted by the index. So a batch query keeps the exact `min`/`max`
  bounds and adds the targeting predicate where its bounds are finite and of one BSON type — no
  `$or` decomposition of the range is needed. One catch: choosing shards, the mongos takes a
  `$lt` bound as inclusive, so a range that ends exactly at a chunk boundary also reaches the next
  chunk's shard. A partition — which ends where its run of chunks does — therefore reads from at
  most two shards, its own and its neighbour's, instead of all of them.
- **Missing and `null` keys.** A document without the shard key lives with the `null` ones, in the
  chunk that holds `null`; `{ key: null }` targets that one shard and matches both.
- **Writes.** An update filtered by the whole shard key (plus `_id`) goes to one shard; one
  filtered by `_id` alone goes to all of them. The OCC filter of a targeted write carries the
  shard key.
- **Nothing refuses a shard-key change.** With retryable writes — the driver's default — an update
  that changes a document's shard key value is carried out: the mongos moves the document to its
  new shard. Only with `retryWrites: false` is it refused. So a transform that rewrites the shard
  key is caught by migronaut's own guard (`shard-key-changed`, a document error) or not at all;
  where the key cannot be read (no `clusterMonitor`), there is no guard, and that is documented.
- **`distinct` in a transaction** on a sharded collection is refused (263,
  `OperationNotSupportedInTransaction`) — one more reason the dry-run sandbox refuses it there.
- **Privileges.** A user with `readWrite` on the application database is refused (13) on both
  `config.collections` and `config.chunks`: the shard-aware mode needs `clusterMonitor`, and falls
  back without it.

### 6.9 Document versioning and the versioning subpath

Files: `src/core/versioning-spec.js`, `src/versioning/`. Entry point:
`@alexify/migronaut/versioning`.

**One contract, two writers.** A collection's `versioning: { current, min?, field?, revision?,
revisionField?, index? }` is declared once, in its definition. Converge folds it into an ordinary
validator (the version an `int` with a `minimum` of `min`, never a `maximum` — that would break a
rolling deploy and every rollback; the revision `int|long`, since `$inc` overflows an int32 into a
long; `moderate` when the validator exists for versioning alone, so a legacy document stays
updatable) and an ordinary index, so the planner knows nothing about versioning. The application
writes through the subpath's helpers and background migrations through the engine, and both use
`src/versioning/document.js` — the same filters, the same "a missing or null field is 0", the
same revision bump — so a background migration never silently loses an application write.

**The min guard.** Raising `min` would leave older documents invalid; converge probes for one
(`{ field: { $not: { $gte: min } } }`) only when `min` rises — the steady state costs nothing —
and refuses the whole run with a `conflict` row before any write. The ids found are never named
(PII).

**The revision invariant.** In a collection with `revision: true` *every* write must bump `__rev`
(`updateWithRevision`, `bumpRevision`, the Mongoose plugin): the optimistic filter can only see a
concurrent write that moved the revision. What the helpers deliberately do not do — and why — is in
the user guide: no repository base class, no on-read upgrade hooks (`upcaster` is explicit and
in-memory, the exception), no HTTP policy, no mandatory OCC, no automated contract step.

**Types without codegen.** `versioning.d.ts` turns a shape map (`{ orders: { 1: OrderV1; 2:
OrderV2 } }`) into discriminated unions on the literal version (`AnyShape`, `CurrentShape`,
`Stamped`, `BackgroundMigrationFor`), with the `Hold<T>` trick standing in for `NoInfer` so an
upcaster's steps are typed contextually. A literal `current` past the highest shape is caught —
written inline its error reads "not assignable to type 'never'"; from an imported `as const`
definition it names the two numbers.

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
- **A converge run adds no wrap site.** It is an ordinary `migronaut.run` span with
  `command: 'converge'`; there are no per-step spans (the driver's index commands nest under the
  run span). The third wrap site belongs to background migrations, which run outside any run.
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

### Background migrations and versioning

- **`up` applies a background file without running it.** The record says `applied`; the state
  document says how far the rewrite is. `down` with a `revert` withdraws the forward rewrite and
  registers the way back; without one it refuses once documents were rewritten
  (`IrreversibleMigrationError`). A file may not export both `background` and `up`/`down`: the
  expand step is a migration of its own.
- **Completion is a count, not a sum of partitions.** A pass ends when no partition is open; the
  background migration completes only when counting what still matches finds nothing. Gaps between
  partitions and documents written meanwhile are why — the partitioner may sample and round freely.
- **A finished `generation` is never reset** (lane ids and leases are unique per generation);
  `pass` counts toward `maxPasses` and a drift reopening is a new pass, not a reset — an old
  release that keeps writing the old shape exhausts `maxPasses` and fails it visibly.
- **The coordinator lock is not the migration lock.** `background:<name>` and `watch:<collection>`
  live in the lock collection beside `migronaut_lock`; `forceUnlock`, `unlock` and audit's lock
  check look only at the migration lock. `background unlock` clears a coordinator lock and every
  lease of one background migration.
- **Lanes complete; they do not fail.** On the queue a lane completes for every outcome the kit
  recorded and only gives up after `maxLaneRetries`; its coordinator decides from MongoDB. A lane
  job id is new for every spawn and coordinators are deduplicated, never lanes under a parent.
- **`stampedDiff` writes only what changed.** A full replace would rewrite every field the engine
  read through `READ_OPTIONS` with its promoted JS type; the diff leaves them as they are. A changed
  nested field rewrites its whole top-level subdocument.
- **No `maximum` on the version**, and `moderate` for a validator synthesized for versioning alone:
  both protect a rolling deploy and a rollback.
- **The shard-key guard compares numbers by value.** A `Long 5` that becomes an `int 5` routes the
  same; anything it cannot prove equal counts as a change.
- **A shard-aware read may reach two shards.** The mongos takes a `$lt` bound as inclusive when it
  picks shards, and a partition ends where its run of chunks does (§6.8).
- **The live watcher opens its stream before it probes.** The other order leaves a window where a
  write is neither probed nor streamed.
- **A typed `current` past the highest shape errors as "not assignable to type 'never'"** when it
  is written inline — the check works through a conditional type there; from an imported
  `as const` definition the same check names the two numbers.

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
  fake is wrong. Add adapter behaviour to the scenario module, not to either file. Two more
  modules run the same way: [bullmq-fidelity.js](tests/helpers/bullmq-fidelity.js) checks the
  BullMQ semantics the background queue builds on (delays, parents and children) on bare
  Queue/Worker objects, and [bullmq-background-scenarios.js](tests/helpers/bullmq-background-scenarios.js)
  drives background migrations through the queue — each one waits until MongoDB says what it
  expects *and* the background queue holds nothing waiting, active, delayed or waiting for children.
- **Background migrations** are tested on the replica set: the store (30 racing claims against
  three slots), the engine (an application write in the middle of a batch is never lost), the
  coordinator (passes, controls, a crash between roll-up and clean-up), a lane killed with `kill -9`
  in a child process ([background-child.js](tests/helpers/background-child.js)), the transactional
  mode, the sandbox, the drift watch and the live watcher (a real 286 comes from the `failCommand`
  fail point — the memory server is started with `enableTestCommands`).
- **Search indexes:** the unit tier's fake (`tests/unit/converge.test.js`) answers
  `$listSearchIndexes` and the three search commands, with lag, server-side normalization and
  build progress on demand — that carries the coverage. The memory-server suite proves the
  *unavailable* path against a real `mongod`, which has no Search. A server that has it is the
  opt-in, manual `tests/integration/search-atlas.test.js` (`mongodb/mongodb-atlas-local`): every
  scenario ends at a fixed point, which is the only proof that the comparison rules match what a
  real `mongot` reports.
- **Sharded clusters:** the opt-in, manual `tests/integration/sharded.test.js` runs against a
  whole cluster in one `mongo:8.0` container (`tests/fixtures/sharded/start.sh`: config servers,
  two shards, a mongos, access control on). Its `[probe]` cases pin what §6.8 relies on.
- **Rules:** every feature ships with tests in the same PR. Silence the logger (`logger:null`). No
  `.only`/`.skip` committed — the three sanctioned exceptions are `bullmq-redis.test.js`,
  `search-atlas.test.js` and `sharded.test.js`, which skip themselves *with a reason* when
  `MIGRONAUT_TEST_REDIS_URL` / `MIGRONAUT_TEST_ATLAS_URI` / `MIGRONAUT_TEST_SHARDED_URI` is unset:
  environment-capability skips (CI sets the Redis variable via a Redis service and never the
  other two), not disabled tests. The coverage gate must pass
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
# opt-in, manual: a sharded cluster in one container (CI does not run this)
docker run --rm -d --name migronaut-sharded -p 27019:27017 -v "$PWD/tests/fixtures/sharded:/s:ro" mongo:8.0 bash /s/start.sh
MIGRONAUT_TEST_SHARDED_URI="mongodb://root:root@127.0.0.1:27019/?authSource=admin" node --test tests/integration/sharded.test.js
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
- **Background migration** — a migration file exporting `background`: a long rewrite of one
  collection from one shape version to another, which `up` registers and lanes carry out beside the
  line. Its run over the data is a **background update**.
- **Partition** — a range of a background migration's collection (`_id` or shard key) with its own
  cursor, counters and lease; the unit of parallel work.
- **Lane** — a worker of one background migration: claims a partition and a slot, works it in
  batches for a slice, releases it. A BullMQ child job, a runner loop or a CLI `--concurrency`.
- **Slot** — `0..maxParallel-1`, held with a lease; a unique index caps the lanes at `maxParallel`.
- **Coordinator** — the step-by-step process that plans a pass, waits for its lanes and finalizes.
- **Pass / generation** — one walk over every partition of one plan; another one starts over
  whatever is left.
- **Drift** (of a background migration) — an old-shape document written after it completed.
- **Live drift watcher** — the change-stream follower that upgrades such documents as they land.
- **Shape version / revision** — `__v` and `__rev`: what shape a document has, and how many times it
  was written — the optimistic-concurrency token.
- **Telemetry** — the `telemetry: { tracer, meter }` config option: the user's own OpenTelemetry
  objects. Not to be confused with `bullmq.telemetry`, BullMQ's own telemetry object.
- **Progress reporter** — the CLI-injected callback that drives the spinner without core ever
  importing one.
- **Step** — Laravel-style per-file batching (`up --step`) / per-file rollback (`down --steps N`).

---

*Keep this file honest. If you change behavior and this doc still describes the old way, the doc is a
bug — fix it in the same PR.*
