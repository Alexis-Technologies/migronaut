# src/core — the engine

The kit and its mechanism modules. Background migrations and declared collections have folders
of their own ([background/CLAUDE.md](background/CLAUDE.md), [converge/CLAUDE.md](converge/CLAUDE.md)).

## Layers inside the core

- **Orchestration**: `migrator.js` (`MigratorKit`) with `run-recorder.js`, and `run.js`
  (`runMigrations`, `pendingMigrations`). They sequence steps and own the connection lifecycle.
- **Mechanism modules** do one job each and know nothing about the CLI — no `console.*`, no
  spinner or table: `config`, `options`, `lock`, `lock-wait`, `changelog`, `runner`, `context`,
  `import`, `sequence`, `server-info`, `shard-info`, `migration-logger`, `audit`, `baseline`. The
  CLI injects a `ProgressReporter` instead.
- The hosts (`background/host.js`, `converge/host.js`) are the only builders of the `deps` their
  flows get; they reach the kit through its `#hostAdapter()`, never its fields.
- `require('mongodb')` only in `migrator.js` and `background/bson-peer.js` (lazily, for `BSON`).
  The core may require `src/versioning/`; never the other way.

## Config and the environment

- Resolved once: CLI flags > `MIGRONAUT_*` > config file > defaults. `CONFIG_KEYS` is the one
  table of keys, checks, enum values and bounds; `ENV_KEYS` has an entry for every _scalar_ key
  (a unit test pins the two), and every parse fails closed with the variable named — all of a
  run's issues at once, in one `ConfigInvalidError`. `MIGRONAUT_ENV_FILE` is read before the
  table, since it picks the `.env`. A 2.x name (`MIGRONAUT_LOCK_TTL`, `MIGRONAUT_COLLECTION`) is
  refused with its new one (`RENAMED_ENV_KEYS`).
- A new scalar key gets its `CONFIG_KEYS` and `ENV_KEYS` entries, a line in
  `migronaut.schema.json` (and its byte-identical copy in `docs/public/`) and the README's env
  table — unit tests pin each pairing.
- An unknown key is a warning, not a refusal; the debug line of the resolved config shows the
  keys migronaut knows only, the URI masked.
- **Kept on purpose (node-config):** the library reads `.env` and `MIGRONAUT_*` itself, and the
  environment name falls back to `NODE_ENV`. migronaut is first a CLI, and the precedence above is
  documented; the config tests write `process.env` for the same reason.

## The changelog and the lock

- The changelog is append-mostly: `markApplied` upserts (`redo`, `force` and `import` need it),
  `markReverted` updates to `status: 'reverted'` and never deletes (the audit trail), `markFailed`
  clears the requester of an earlier apply but keeps the revert fields (it is still reverted).
- Both bookkeeping collections are opened with `BOOKKEEPING_OPTIONS` (`server-info.js`): primary
  reads, majority read and write concern. A client set to `secondaryPreferred` must not read a
  lock it just wrote, or applied names, from a lagging secondary — worth the ~8 % it costs
  `Changelog.getLastBatch` in the bench.
- The lock document carries a migronaut-minted `nonce` beside `owner`: the owner is the user-shaped
  run id, so mutual exclusion must not depend on it. Its operations are bounded by the TTL
  (`maxTimeMS`). `runWithLock` lives in `lock.js` with the heartbeat and the deadline; a lost lock
  is said once (at `error`, or `warn` under `onLockLost: 'warn'`), and the heartbeat goes on only
  after a _deadline_ loss — the document may still be ours.
- `lock-wait.js` polls a held lock with a jittered, capped interval; a run the lock refused still
  emits `run:start`/`run:end` (the queue reads its run id there), told apart by
  `code: 'ALX_ERR_LOCK_ALREADY_HELD'`.

## The kit

- `MigratorKit` is an `EventEmitter` with `captureRejections`; `#deliver` calls each listener in a
  `try` of its own, so one that throws never silences the next, and a rejecting `async` listener is
  a debug line. A second run on one kit, or `disconnect()` under one, is `ALX_ERR_RUN_IN_FLIGHT`.
- `stop(reason, { cause })` and `{ signal }` on the run methods end a run after the migration in
  flight; a run stopped on request is no error in telemetry.
- `reloadMigrations` drops the file's `require.cache` entry as well as adding a query string (the
  query alone reloads ES modules only). A file that does not load is
  `ALX_ERR_MIGRATION_LOAD_FAILED` with the rows already applied; it gets a migration span and a
  duration point, not a `migration:error` or a `failed` trace (it never ran). A migration export
  that is present but not of its kind, or a near miss of one (`useTransactions`), is refused —
  **kept on purpose**: refused, not warned, since a mistyped `useTransaction` runs without one.
- migrate-mongo imports are forward-only: `down` and `redo` refuse them.

## Ids

- `src/utils/id.js` is the only module that mints an id (a unit test greps `src/` for
  `randomUUID`); everything else goes through `createIdGenerator` / `kit.generateId()`.
  `generateId` is called with **no** arguments on purpose (`ulid`/`nanoid` would read a "purpose"
  argument as their own first parameter), synchronously, and every id is checked (a non-empty
  string, ≤ 128 characters).

## Telemetry

- Exactly three wrap sites, all in `migrator.js` and the deps it hands out: `migronaut.run`
  (opened inside `runWithLock`'s callback, once the lock is held — a refused run emits no span, the
  refusals are counted in `migronaut.lock.refused`), `migronaut.migration` (the _active_ span while
  a migration runs), and the background spans `migronaut.background.slice` and
  `migronaut.background.coordinate`, each opened once its lease or lock is held.
- The status code is the literal `2`, never OK, and `recordException` is never called: the enum
  lives in a package migronaut does not import, and a raw exception would skip redaction.
  `telemetry.open` takes its result from the callback and tracks whether it ran — what stops a
  broken tracer from skipping or running a migration twice.
- **Kept on purpose (node-observability):** no `diagnostics_channel`; the injected
  `{ tracer, meter }` is the design.

## Migration logs

- migronaut **stores none**: `ctx.logger` lines go to the configured logger, and only fields with
  `userland: true` (exactly; the marker stays on the line) also emit `migration:log`, at any level,
  with `logger: null` too, never in a dry run. The event is not a session write (it survives a
  rollback) and fires once per transaction attempt (`ctx.run.attempt`, a fresh frozen context per
  attempt). An `Error` in a call's data becomes `{ name, message, code?, codeName? }`.
- `logger`/`run` are _optional_ in `MigrationContext`'s types on purpose (a hand-built context in a
  test must type-check); `ctx.logger` is a `MigrationLogger` with method syntax and union
  parameters, not overloads, so any `MigronautLogger` fits.

## Kept on purpose here

- `let x = undefined`, written out, where `undefined` is the value of no return or part of a
  contract: what user code returned (`#withLock`, `runWithLock`), and `failure` in `#withLock` and
  `#runSequence`, where a thrown `undefined` still counts as no failure.
- A hook is called with a fixed list of one or two arguments spread (`migrator.js`); no data array
  is spread into arguments.
- A result at a boundary — a MongoDB document, a JSON row, an event payload — leaves an absent key
  out (`undefined`); inside the core an absent reference is `null`.
