# Changelog

All notable changes to this project will be documented in this file.

## v1.0.0

Initial release. Requires **Node.js ≥ 22.18**.

### Core

- `MigratorKit` orchestration: `up`, `down`, `redo`, `dryRun`, `status`, `list`, `audit`,
  `create`, `init`, `import`, `lockInfo`, `forceUnlock`
- `migronaut` CLI with `init`, `up`, `down`, `redo`, `status`, `list`, `dry-run`, `audit`,
  `create`, `import`, `lock`, and `unlock` commands
- Config loader with priority: CLI flags → `MIGRONAUT_*` env vars → config file → defaults,
  checked by a built-in zero-dependency validator (`ConfigInvalidError` with per-issue
  `{ path, message }`)
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
- **`--json` machine-readable output** on every data command (`up`, `down`, `redo`, `status`,
  `list`, `dry-run`, `import`, `create`, `unlock`) — a single JSON document on stdout; human logs
  and the spinner go to stderr, so stdout stays pipe-safe
- **`migronaut status --check`** — exits with code 1 when any migration is pending, for CI deploy
  gates
- **`migronaut unlock`** — force-release a stuck lock left behind by a crashed run, with holder
  info (pid / host / user / since) and a confirmation prompt (`--yes` to skip)
- **`migronaut up <file> --force --yes`** — confirm a forced re-run non-interactively

### Zero dependencies

- **No runtime dependencies at all** — `package.json` has no `dependencies` key; only `mongodb`
  (required) and `mongoose` (optional) as peers
- `.env` loading via native `util.parseEnv` (quotes, `export ` prefix, comments, multiline
  values) — real env vars always win over `.env`
- Hand-rolled ANSI colors (detection: `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > TTY), a TTY-only
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
  filenames) are stripped before table rendering
- **Clear `.ts` runtime errors** — actionable messages when type stripping is disabled or a
  migration uses non-erasable TypeScript syntax (`enum`, `namespace`)
- **`TransactionsUnsupportedError`** — `useTransaction` on a standalone server names the topology
  as the problem instead of blaming the migration
- `prepublishOnly` runs `lint` + `format:check` + coverage-gated tests + `tsd` type tests, so a
  broken release can't be published

### Documentation

- Full documentation site at <https://migronaut.vercel.app/> — guides, a full command reference, a
  programmatic API overview, an FAQ, and a migrate-mongo migration guide
- Requires **Node.js ≥ 22.18** — `.ts` migrations run natively (built-in type stripping) with no
  loader or build step; `.js` migrations likewise
