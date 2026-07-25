# Changelog

All notable changes to this project will be documented in this file.

## v1.0.0

Initial release.

### Core

- `MigratorKit` orchestration: `up`, `down`, `redo`, `dryRun`, `status`, `list`, `create`, `init`
- `migronaut` CLI with `init`, `up`, `down`, `redo`, `status`, `list`, `dry-run`, `create`, `import`,
  and `unlock` commands
- Config loader with priority: CLI flags → `MIGRONAUT_*` env vars → config file → defaults,
  checked by a built-in zero-dependency validator (`ConfigInvalidError` with per-issue
  `{ path, message }`)
- Function / async config files — `export default` a (sync or async) factory returning the config,
  for loading the connection from a secret manager at runtime with no bundled cloud SDKs
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
- **`migronaut dry-run down --steps <n>`** — preview the same last-N rollback without touching the
  database
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
- `.env` loading via native `util.parseEnv` on Node ≥ 20.12 with a built-in fallback parser on
  older Node (quotes, `export ` prefix, full-line and inline `#` comments; no multiline values,
  `\n` expansion, or `${VAR}` interpolation) — real env vars always win over `.env`
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
  acquire/release/renew so a run never loses or steals a lock it doesn't hold
- **Clear `.ts` runtime error** — an actionable error when a Node runtime can't import a `.ts`
  migration, instead of a cryptic `ERR_UNKNOWN_FILE_EXTENSION`
- `prepublishOnly` runs `lint` + `format:check` + coverage-gated tests + `tsd` type tests, so a
  broken release can't be published

### Documentation

- Full documentation site at <https://migronaut.vercel.app/> — guides, a full command reference, a
  programmatic API overview, an FAQ, and a migrate-mongo migration guide
- `.ts` migrations run natively on **Node ≥ 22.18** (built-in type stripping) or under a
  TypeScript loader such as `tsx`; `.js` migrations run on Node 18+ with no setup
