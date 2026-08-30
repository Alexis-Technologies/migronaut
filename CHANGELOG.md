# Changelog

All notable changes to this project will be documented in this file.
Release headings carry the publish date (`## vX.Y.Z — YYYY-MM-DD`).

## Unreleased

### Added

- **`migronaut baseline`** — adopt an existing database with no prior migration tool: mark
  migration files on disk as applied (checksum from disk, one shared batch, `origin: 'baseline'`)
  without executing them. Forward-only, idempotent, confirmation-gated.
- **Out-of-order detection** — a bulk `up` flags pending migrations that sort before the newest
  applied one (a file merged late from a parallel branch). New scalar config `onOutOfOrder:
  'warn' | 'error' | 'allow'` (default `'warn'`, env `MIGRONAUT_ON_OUT_OF_ORDER`), a new
  `MIGRATION_OUT_OF_ORDER` error code (exit 23), `outOfOrder` on `StatusRow`, and an `ordering`
  check in `audit`.
- **Failed-attempt traces** — a failing `up` now leaves a best-effort `status: 'failed'` record
  (error text, `failedAt`, `runId`) in the changelog; `status` renders it as `failed` while every
  run path still retries the file; a successful apply clears the trace. A forced re-run's failure
  never demotes an `applied` record.
- **Audit-trail read surface** — `StatusRow` now carries `executedBy`, `environment`, `runId`,
  `revertedAt` and `origin` from the changelog record, so `status --json` can answer "who ran
  migration X, from which run, and was it ever reverted?".
- **`onKit` option on `runMigrations`** — receive the internally-constructed `MigratorKit` before
  connect and subscribe to its lifecycle events (metrics without log parsing).
- **`createLogger` export** — the default console logger (with level control) for programmatic
  callers.
- **`cwd` option on `MigratorKit`** — scope config discovery, `.env` loading and a relative
  `migrationsDir` to a project root, for processes hosting kits for several projects.
- **ESM-interop integration test** pinning the "ESM consumers still work" promise.

### Changed

- **Server-time changelog stamps** — `appliedAt`/`revertedAt`/`failedAt` are stamped with the
  server clock (`$currentDate`, matching the lock's `$$NOW` discipline) unless the record carries
  an explicit `appliedAt` (import), so `redo`/`down --steps` ordering is immune to host clock skew.
- **Non-transactional changelog-write failures are reported distinctly** — when a migration's own
  writes committed but recording them failed, the error now says exactly that (context
  `phase: 'changelog-write'`, `bodySucceeded: true`) instead of the generic "migration failed"
  that invited re-running committed writes.
- **A timed-out migration is told to stop** — `timeoutMs` now aborts `ctx.signal` (with the
  `MigrationTimeoutError` as reason), so cooperative bodies stop writing instead of racing the
  next lock holder.
- **`lockWaitTimeoutMs` bounds stall, not total wait** — while a waiting `runMigrations` observes
  the holder's heartbeat advancing, the deadline re-arms; only a stalled holder times peers out.
- **`unlock --json` (and the new `baseline`) require `--yes`** — non-interactive modes never
  assume consent to a destructive action, matching `up --force --json`.
- **Failure telemetry carries timing** — `migration:error` events, error result rows and error
  contexts now include `durationMs`/`batch`; the run ends with a `✔ Done N applied in Xms`
  summary line.
- Signals during the CLI's pre-connect now abort the run (exit 11) instead of being silently
  dropped; partial-results lists survive hook/load failures and lock-release failures; lock
  warn lines carry `runId`; import interruptions report progress and that a `--force` re-run
  resumes idempotently.

### Fixed / hardened

- URI redaction now masks query-string secrets (`tlsCertificateKeyFilePassword`, `proxyPassword`,
  `sslKeyPassword`, secret `authMechanismProperties` values) and empty-username passwords —
  in logs, errors, `--json`, events, and `init`-generated config files (which now warn about
  query-string secrets too).
- Terminal sanitization strips the whole C1 control block (DCS/OSC/PM/APC, not just CSI), and
  `bin/migronaut.js`'s last-resort handlers sanitize their output.
- `MigrationLock.release()` without a held owner token is a no-op instead of an unscoped delete;
  an uncontended `acquire()` takes one round trip instead of two.
- Import checksum resolution is concurrency-bounded (no EMFILE on thousands-record changelogs);
  the strict drift check reuses the instance checksum cache; `dry-run up` fetches applied names
  instead of full records; a warn/error-only injected logger keeps its output instead of being
  silenced entirely.

## v1.0.0 — 2026-07-28

Initial release. Requires **Node.js ≥ 22.18**.

### Core

- `MigratorKit` orchestration: `up`, `down`, `redo`, `dryRun`, `status`, `list`, `audit`,
  `create`, `init`, `import`, `lockInfo`, `forceUnlock`
- `migronaut` CLI with `init`, `up`, `down`, `redo`, `status`, `list`, `dry-run`, `audit`,
  `create`, `import`, `lock`, and `unlock` commands
- Config loader with priority: CLI flags → `MIGRONAUT_*` env vars → config file → defaults,
  checked by a built-in zero-dependency validator (`ConfigInvalidError` with per-issue
  `{ path, message }`)
- **Every scalar option is settable from the environment** — a table-driven `MIGRONAUT_*` layer
  pinned against the config-key spec by a test, so a config file is genuinely optional rather than
  merely discouraged. Values fail closed: `MIGRONAUT_STRICT=on`, `MIGRONAUT_LOCK_TTL=abc` and
  `MIGRONAUT_CREATE_EXTENSION=tsx` are rejected with an error naming the variable, never coerced
- `MIGRONAUT_NO_COLOR` / `MIGRONAUT_FORCE_COLOR` pin migronaut's own color output above the
  ecosystem-wide `NO_COLOR`/`FORCE_COLOR`, which stay honored underneath; `MIGRONAUT_USER`
  overrides the OS user recorded in `executedBy`, for CI where that user is a meaningless `runner`
- Function / async config files — `export default` a (sync or async) factory returning the config,
  for loading the connection from a secret manager at runtime with no bundled cloud SDKs
- **Client injection** (`config.client`) — reuse an already-connected `MongoClient` (its pool,
  auth, TLS); ownership stays with the caller and `disconnect()` never closes it
- **Lifecycle events** — `MigratorKit` is an EventEmitter: `run:start`/`run:end` (with duration
  and result counts), `migration:start`/`success`/`skipped`/`error`,
  `lock:acquired`/`released`/`lost` — feed metrics or alerting without parsing log lines
- First-class `.ts` and `.js` (ESM + CJS) migration loading
- MongoDB-native concurrency lock with TTL-based stale reclaim and heartbeat renewal for long
  migrations
- SHA-256 checksum tamper detection, surfaced in `status`
- Opt-in transactions (per-file or global) with automatic commit/abort
- Lifecycle hooks: `beforeAll`, `afterAll`, `beforeEach`, `afterEach`, `onError`
- Append-only audit trail in `_migronaut_migrations` — reverts are never deleted

### Step controls & automation

- **`migronaut up --step`** — apply each pending file as its own sequential batch, so a later
  `down` can peel migrations off one at a time
- **`migronaut down --steps <n>`** — revert the last N applied migrations, newest first, regardless
  of batch
- **`migronaut up --to <file>` / `migronaut down --to <file>`** — migrate to a named point in the
  sequence: `up --to` applies pending files up to and including it, `down --to` reverts everything
  applied after it (exclusive), so the pair is a round trip
- **`migronaut dry-run`** previews the same selections — `--steps`, `--batch`, and `--to` — without
  touching the database
- **`migronaut audit`** — read-only health check (config, connectivity, transaction support,
  indexes, lock state, checksum drift, runtime) with pass/warn/fail per check
- **`migronaut lock`** — inspect the current migration lock holder without modifying it
- **`--json` machine-readable output** as a global flag (`migronaut --json status` and
  `migronaut status --json` both work) on every command — `up`, `down`, `redo`, `status`, `list`,
  `dry-run`, `import`, `create`, `audit`, `lock`, `unlock` — a single JSON document on stdout;
  human logs and the spinner go to stderr, so stdout stays pipe-safe. The one exception is
  `init`, whose deliverable is the config file itself: `init --format <js|ts|json>` selects the
  file format, and a stray `init --json` is rejected with a pointer to `--format`
- **`migronaut status --check`** — exits with code 2 (`PENDING_MIGRATIONS`) when any migration is
  pending, for CI deploy gates; `--pending` and `--limit <n>` filter the table
- **Typed exit codes for every error** — each `MigronautError` code maps to a dedicated exit code
  (idempotency cases included: `CONFIG_FILE_EXISTS` = 16, `IMPORT_TARGET_NOT_EMPTY` = 17), audit
  failures exit 22, and the full map is exported from the package root as `EXIT_CODES`
- **`migronaut unlock`** — force-release a stuck lock left behind by a crashed run, with holder
  info (pid / host / user / since) and a confirmation prompt (`--yes` to skip)
- **`migronaut up <file> --force --yes`** — confirm a forced re-run non-interactively

### Zero dependencies

- **No runtime dependencies at all** — `package.json` has no `dependencies` key; only `mongodb`
  (required) and `mongoose` (optional) as peers
- `.env` loading via native `util.parseEnv` (quotes, `export ` prefix, comments, multiline
  values) — real env vars always win over `.env`
- Hand-rolled ANSI colors (detection: `MIGRONAUT_FORCE_COLOR` > `MIGRONAUT_NO_COLOR` >
  `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > TTY), a TTY-only
  spinner (complete no-op when piped), box-drawing tables with ANSI-aware column widths, and a
  commander-compatible argument parser (combined short flags like `-fy` are not supported)
- `MigronautLogger` is pino-compatible (`{ debug, info, warn, error, child? }`) — pass a pino
  instance directly as `logger`; a `component: 'migronaut'` child binding is applied once and a
  throwing logger can never break a migration run

### Import from `migrate-mongo`

- **`migronaut import`** — read an existing `migrate-mongo` `changelog` and record that history in
  the migronaut changelog, so `migronaut up` runs only what is new. One-time and forward-only; the
  source collection is never modified
  - `--from <collection>` / `--to <collection>`, `--dry-run`, `--trust-hash`, `--force`, `--no-lock`
- **Forward-only safety** — imported records are tagged `origin: 'migrate-mongo'`; `migronaut
  down`/`redo` refuse them up front with a clear reason, so the changelog is never corrupted

### Hardening

- **Path-traversal protection** — migration names are validated as bare filenames confined to the
  migrations directory, so a crafted name can't load or read a file outside it
  (`MigrationInvalidNameError`)
- **Lock safety for long migrations** — heartbeat renewal at half the TTL, owner-scoped
  acquire/release/renew, server-time (`$$NOW`) staleness judgments immune to host clock skew, and
  a hard renewal deadline that stops the run strictly before a peer could reclaim the lock
- **Credential redaction** — connection-string passwords are masked (`user:****@`) in every error
  message, `--json` payload, and `--verbose` stack the CLI emits
- **Terminal-injection safety** — control characters in DB-sourced values (descriptions,
  filenames, lock-holder fields) are stripped in the default logger's write path, the spinner and
  table rendering; migronaut's own SGR colors survive, cursor movement and screen clearing do not.
  Raw `Error` objects never reach event subscribers either — `migration:error` and `run:end`
  carry a pre-redacted message string
- **Unbounded-wait protection** — `runMigrations` validates `lockWaitTimeoutMs` /
  `lockPollIntervalMs` up front (`ConfigInvalidError`), so a `NaN` can no longer turn the
  lock-wait loop into an infinite retry storm; the summary reports `waitedMs` and `attempts`
- **Preview parity** — `dry-run down` uses the exact selection the real `down` executes,
  including the refusal of forward-only migrate-mongo imports, and lists rows in revert order
- **`redo` correctness** — the target is resolved *inside* the lock (no race with a peer), and a
  failed re-apply carries the already-reverted rows in `error.context.results`
- **CLI logger fallback** — a `logger` from the config file (pino, or `null` for silence) is
  respected by the CLI instead of being clobbered by its console logger
- **Clear `.ts` runtime errors** — actionable messages when type stripping is disabled or a
  migration uses non-erasable TypeScript syntax (`enum`, `namespace`)
- **`TransactionsUnsupportedError`** — `useTransaction` on a standalone server names the topology
  as the problem instead of blaming the migration
- `prepublishOnly` runs `lint` + `format:check` + coverage-gated tests + `tsd` type tests +
  a strict `tsc` pass over `index.d.ts` (`check:dts`), so a broken release can't be published

### Documentation

- Full documentation site at <https://migronaut.vercel.app/> — guides, a full command reference, a
  programmatic API overview, an FAQ, and a migrate-mongo migration guide
- Requires **Node.js ≥ 22.18** — `.ts` migrations run natively (built-in type stripping) with no
  loader or build step; `.js` migrations likewise
