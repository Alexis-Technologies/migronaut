# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**migronaut** (npm package `@alexify/migronaut`, CLI binary `migronaut`) — an elegant,
fast MongoDB migration toolkit for Node.js. It is a fork of the original
`mongo-migrate-kit` (CLI `mmk`) by Santosh Gupta, renamed and now maintained here.

For the full architectural deep dive (module reference, data flow, subtle subsystems, the
"why" behind non-obvious decisions), read [ARCHITECTURE.md](ARCHITECTURE.md) — it is kept
in sync with the code and is the source of truth for anything not covered below.

## The 5-minute mental model

Two faces, one engine — plus one optional adapter on top:

- **CLI** (`migronaut`) — what most users run (`bin/migronaut.js` → `src/cli/index.js`).
- **Programmatic API** (`MigratorKit` class + helper functions) — for app startup, serverless,
  tests. Exported from `src/index.js`, re-exported at the package root (`index.js`).
- **Queue adapter** (`@alexify/migronaut/bullmq`) — opt-in: migrations as BullMQ jobs, one
  migration per job, for running migronaut as a service. Exported from `src/bullmq/index.js`,
  re-exported by the root shim `bullmq.js`. It drives the public `MigratorKit` API and nothing
  below it.

The package root and the `./bullmq` subpath are the *only* two things users import from — the
`exports` map is closed to everything else.

All real logic lives in the orchestrator `MigratorKit` ([src/core/migrator.js](src/core/migrator.js)),
which coordinates small single-responsibility modules: `config`, `lock`, `changelog`, `runner`,
`context`, `import`.

Three ideas explain almost everything:

1. **Config is resolved once** with priority CLI flags > `MIGRONAUT_*` env vars > config file >
   defaults ([src/core/config.js](src/core/config.js)). The env layer is the table-driven
   `ENV_KEYS` — every *scalar* config key has an entry, a unit test pins it against `CONFIG_KEYS`,
   and every parse fails closed with the variable named. `MIGRONAUT_ENV_FILE` is the one exception,
   read before the table because it selects which `.env` to load.
2. **The changelog (`_migronaut_migrations` collection) is append-mostly.** Applying upserts a
   record; reverting updates it to `status:'reverted'` — it never deletes.
3. **A MongoDB-native lock (`_migronaut_locks`) makes concurrent runs safe**, with a heartbeat
   keeping long migrations from losing their lock.

## No build step — CommonJS + hand-written types

migronaut ships exactly what's in `src/`/`bin/` — no compile step, ever, for authors or
consumers:

- **Source is plain CommonJS** (`require`/`module.exports`), not TypeScript. JSDoc comments in
  `.js` files are documentation for the reader/editor only — nothing runs `tsc`/`checkJs` over
  them, so they are never type-checked.
- **Types live in two hand-written files, one per entry point**: [index.d.ts](index.d.ts) for the
  package root and [bullmq.d.ts](bullmq.d.ts) for the `./bullmq` subpath. They are the *only*
  source of truth for the public type surface — there is no per-file `.d.ts`, no generation step.
  When you add or change a public export, update the entry's runtime barrel **and** its `.d.ts`
  together (`src/index.js` + `index.d.ts`, or `src/bullmq/index.js` + `bullmq.d.ts`) — they are
  maintained by hand in lockstep, not derived from each other. `bullmq.d.ts` imports root types
  from `./index.js`; the root never imports from the subpath.
- **Correctness of the hand-written types is enforced by [tsd](https://github.com/tsdjs/tsd)**
  (`tests/types/*.test-d.ts`, run via `pnpm run test:types`), not by a compiler pass over the
  declaration files themselves.
- **No dual CJS/ESM build.** The package is CommonJS-only (no `"type"` field in `package.json`).
  ESM consumers still work via Node's CJS/ESM interop (`import x from '@alexify/migronaut'`).
  A separate ESM build was a deliberate non-goal: it would contradict "ships as-is, no build
  step," for no real benefit to consumers.
- **The CLI (`bin/migronaut.js`) is what you test IS what ships** — a plain CJS shebang script,
  `require`d directly, reading its own version from `package.json` at runtime instead of a
  build-time injected constant.

This is orthogonal to (and does not change) **migration files migronaut loads at runtime**:
user migration/config files can still be `.ts`/`.mjs`/`.cjs`/`.js` — see
[src/utils/loader.js](src/utils/loader.js), which dynamically `import()`s them and relies on
the *running* Node's own capabilities (native TS type-stripping on Node ≥22.18, or a loader
like `tsx`) — not on anything migronaut itself compiles.

## Zero dependencies

`package.json` has **no `dependencies` key at all** — only `mongodb` (required) and `mongoose`
(optional) as peers. Everything that used to be a library is hand-rolled in-tree:

| Was | Now |
|---|---|
| `dotenv` | [src/utils/env.js](src/utils/env.js) — native `util.parseEnv` (always present on engines ≥ 22.18), `override: false` semantics |
| `chalk` | [src/utils/colors.js](src/utils/colors.js) — `MIGRONAUT_FORCE_COLOR` > `MIGRONAUT_NO_COLOR` > `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > `isTTY` detection, `stripAnsi` |
| `ora` | [src/cli/spinner.js](src/cli/spinner.js) — `start(text)`/`stop()`, complete no-op off-TTY |
| `commander` | [src/cli/args.js](src/cli/args.js) — commander-compatible subset (subcommands, `--no-x`, short aliases, camelCase, help/version); no combined short flags (`-fy`) |
| `cli-table3` | [src/cli/table.js](src/cli/table.js) — box-drawing renderer, ANSI-aware widths (no wcwidth/CJK) |
| `zod` | `validateConfig` in [src/core/config.js](src/core/config.js) — table-driven `CONFIG_KEYS`, same `{path, message}` issues |

**Never add a runtime dependency.** Third-party integrations are injected by the user instead:
`MigronautLogger` is pino-compatible (`{debug, info, warn, error, child?}`), so a pino instance
passes straight through `resolveLogger` (which binds `child({component: 'migronaut'})` once and
guards every call — logging must never break a run). devDependencies are fine (`pino` is a devDep
because the logger-adapter tests exercise the real thing; `@vercel/analytics` and
`@vercel/speed-insights` are devDeps consumed only by the VitePress theme in
`docs/.vitepress/theme/index.ts`, which never ships to npm).

**BullMQ is injected too — it is not even a peer.** The queue adapter takes the caller's classes
(`createMigrationQueue({ bullmq: { Queue, Worker, QueueEvents } })`); nothing under `src/` may
`require('bullmq')` (a unit test greps for it) and neither `.d.ts` may import it — `bullmq.d.ts`
describes it structurally (`BullMQQueueLike`, …), as `MongooseLike` does for mongoose. `bullmq`
and `ioredis` are devDependencies only: for the type tests and the opt-in real-Redis suite.

**Id formats are injected the same way.** Migronaut ships no ULID/CUID implementation: the
`generateId` config option (`() => string`, code-only like `logger`) replaces the default
`crypto.randomUUID()` for every id it mints — the run id (also the lock's owner token) and the
queue's group id. [src/utils/id.js](src/utils/id.js) is the **only** module allowed to mint an id
(a unit test greps `src/` for `randomUUID`); everything else goes through `createIdGenerator` /
`kit.generateId()`. The user's function is called bare (no arguments, no `this`) and must be
synchronous; every returned id is checked (non-empty string, ≤ 128 chars).

**OpenTelemetry is injected the same way.** The `telemetry` config option (`{ tracer, meter }`,
code-only like `logger`) takes the user's own `@opentelemetry/api` objects; migronaut asks them for
spans and instruments and never looks at the SDK behind them. [src/utils/telemetry.js](src/utils/telemetry.js)
is the only module that knows an OpenTelemetry name or calls the tracer/meter — every call goes
through its one `safe()` guard (telemetry must never break a run), failures are reported as a
redacted status message plus `error.type`, and there are exactly two wrap sites, both in
`core/migrator.js`: the `migronaut.run` span (opened once the lock is held) and the
`migronaut.migration` span (the *active* span while a migration runs — the one thing lifecycle
events cannot provide). Nothing under `src/` or `bin/` may `require` an `@opentelemetry/*` package or
`bullmq-otel`, and neither `.d.ts` may import one (a unit test greps for it); the types are
structural (`MigronautTracer`, `MigronautMeter`, …). BullMQ's own telemetry object rides in with the
classes — `bullmq: { Queue, Worker, telemetry }` — and is passed through untouched.
`@opentelemetry/api`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-metrics`,
`@opentelemetry/instrumentation-mongodb` and `bullmq-otel` are devDependencies only, for the tests.

## Repository layout

```
index.js               # module.exports = require('./src/index.js') — package entry point
index.d.ts               # Hand-written types for the package root
bullmq.js                # module.exports = require('./src/bullmq/index.js') — the ./bullmq subpath
bullmq.d.ts              # Hand-written types for the subpath (structural BullMQ types, no bullmq import)
bin/migronaut.js          # CLI shebang entry (CJS, no build)
src/
├── index.js                # Public API barrel — re-exported at the package root
├── errors/index.js          # MigronautError base + one subclass per error code
├── core/                     # The engine (config, lock, lock-wait, changelog, runner, context, import, migrator, run,
│                             #   and declared collections: collections, index-spec, converge-plan, converge)
├── utils/                     # logger, colors, env, checksum, loader, template, date, migration-name, id, telemetry,
│                             #   canonical, collection-name — pure-ish helpers
├── cli/                        # own arg parser (args.js) + spinner + table + one file per command
└── bullmq/                      # Queue adapter: jobs (contract), producer, processor, wait, service (facade)
tests/
├── unit/                # mocked DB, pure logic — node:test
├── integration/          # real in-memory MongoDB via mongodb-memory-server (replica set) — node:test
├── helpers/              # incl. fake-bullmq.js (in-memory BullMQ double) + bullmq-scenarios.js + otel.js (real SDK, in-memory)
└── types/                 # tsd type-tests against index.d.ts and bullmq.d.ts
examples/               # Runnable example apps (migration-service) — own package.json, never published
docs/                   # VitePress user-facing site — never published to npm
blog/                   # Long-form posts, also docs-only
migrations/             # Example/dev migration files used while developing this repo itself
```

**Layering rule:** Presentation (`cli/`, `bin/`) never touches the DB or contains migration
logic. Orchestration (`core/migrator.js`, `core/run.js`) sequences steps and owns the
connection lifecycle. Mechanism modules (`core/{lock,changelog,runner,context,import,config}.js`,
`utils/`) do one job each and know nothing about the CLI — no `console.*`, no spinner or table
imports. The CLI injects a `ProgressReporter` callback into core instead. The queue adapter
(`bullmq/`) is a second orchestration layer *above* the kit: it may require `core/migrator.js`,
`core/lock-wait.js`, `utils/` and `errors/`, but never a mechanism module (`lock`, `changelog`,
`runner`) and never the database — if it needs something the kit does not offer, the kit gains a
small public option (that is where `up({ batch, ordered })` and `nextBatch()` came from).

## Naming conventions (post-rename)

| Old (`mongo-migrate-kit` / `mmk`) | New (`migronaut`) |
|---|---|
| npm package `mongo-migrate-kit` | `@alexify/migronaut` |
| CLI binary `mmk` | `migronaut` |
| Env var prefix `MMK_*` | `MIGRONAUT_*` |
| Config files `mmk.config.{ts,js,json}` | `migronaut.config.{ts,js,json}` |
| Types `MmkConfig`, `MmkConfigInput`, `MmkLogger`, `MmkErrorCode` | `MigronautConfig`, `MigronautConfigInput`, `MigronautLogger`, `MigronautErrorCode` |
| `MmkError` base class | `MigronautError` |
| Collections `_mmk_migrations`, `_mmk_locks` | `_migronaut_migrations`, `_migronaut_locks` |

When adding new code, follow the right-hand column — there should be no more `mmk`/`Mmk`/`MMK`/
`mongo-migrate-kit` left anywhere in the tree (verified clean as of this rename).

## Commands

```bash
pnpm run lint              # oxlint src bin scripts tests bench examples
pnpm run format              # oxfmt src bin scripts tests bench examples
pnpm run format:check          # oxfmt --check src bin scripts tests bench examples
pnpm test                        # test:unit then test:integration (~1200 tests)
pnpm run test:unit                 # unit only — fast, no MongoDB
pnpm run test:integration            # integration only, serial (--test-concurrency=1)
node --test tests/integration/up.test.js   # single file
pnpm run test:coverage             # node --test under c8, gated at 90/90/90
pnpm run test:types                  # tsd — checks index.d.ts + bullmq.d.ts against tests/types/*.test-d.ts
pnpm run check:dts                     # tsc --noEmit --strict over both .d.ts files on their own
node bin/migronaut.js --help           # run the CLI directly — no build, ever
pnpm run size                            # esbuild bundle-size report (library, CLI, queue adapter), no publish artifact
# The real-BullMQ suite is opt-in (CI runs it; everything else needs no Redis):
#   docker run --rm -d -p 6379:6379 redis:7-alpine
#   MIGRONAUT_TEST_REDIS_URL=redis://127.0.0.1:6379 node --test tests/integration/bullmq-redis.test.js
pnpm run bench                           # ops/sec micro-benchmarks (bench/bench.js), manual only, not in CI
pnpm run docs:dev                        # vitepress dev docs
```

`prepublishOnly` runs lint + format:check + test:coverage + test:types + check:dts — treat that as
the pre-merge gate. There is no `build` script and nothing to run before testing or publishing;
`files` in `package.json` ships `index.js`, `index.d.ts`, `bullmq.js`, `bullmq.d.ts`,
`migronaut.schema.json`, `bin/`, and `src/` as-is.

## Conventions (enforced by oxlint/oxfmt + review)

- Plain CommonJS (`require`/`module.exports`) in `src/`/`bin/` — no TypeScript syntax, no
  `import`/`export`. JSDoc is documentation only (see "No build step" above).
- Never `throw new Error` — always a `MigronautError` subclass with a typed `code`.
- Never `console.*` — always the injected `MigronautLogger` (`null` = silent, used in tests).
- Public API changes touch two files together — the entry's runtime barrel and its hand-written
  types: `src/index.js` + `index.d.ts`, or `src/bullmq/index.js` + `bullmq.d.ts` — never one
  without the other.
- Never `require('bullmq')` (or `ioredis`) under `src/`, and never import it in a `.d.ts` — the
  adapter works on what the caller injects.
- Never `require('@opentelemetry/…')` (or `bullmq-otel`) under `src/` or `bin/`, and never import
  one in a `.d.ts` — the tracer and meter are injected. Never call a tracer, span or instrument
  outside `src/utils/telemetry.js`, and never `recordException` a raw error (it skips redaction).
- Never call `randomUUID` (or mint an id any other way) outside `src/utils/id.js` — an id minted
  elsewhere is one the user's `generateId` cannot reach.
- Single quotes, semicolons, 100-col lines, no unused vars/imports (oxlint/oxfmt-enforced).
- Conventional Commits (`feat(scope):`, `fix(scope):`, `test:`, …).

## Testing notes

- Runner is Node's built-in `node:test` (no external test framework). Two tiers:
  `tests/unit/` (mocked DB, plain function/`mock.fn` stubs — no `vi.mock` module-mocking is
  used anywhere) and `tests/integration/` (real `mongodb-memory-server` replica set, so
  transactions work).
- `node:test` uses `before`/`after`, not `beforeAll`/`afterAll` (those are Vitest/Jest names —
  don't reintroduce them).
- Silence the logger (`logger: null`) in tests. No committed `.only`/`.skip` — with one
  sanctioned exception: `tests/integration/bullmq-redis.test.js` skips itself, with a reason,
  when `MIGRONAUT_TEST_REDIS_URL` is unset (an environment-capability skip, not a disabled test).
- The queue adapter is tested against `tests/helpers/fake-bullmq.js`, an in-memory double — that
  is where its coverage comes from, so the gate passes with no Redis. The scenarios live once, in
  `tests/helpers/bullmq-scenarios.js`, and run against both the fake and (in the opt-in file) the
  real `bullmq`: add adapter behaviour there. If the two disagree, the fake is what is wrong.
- Coverage gate: 90% lines / 90% functions / 90% branches (`pnpm run test:coverage`, via `c8`).
- The lock-heartbeat integration tests use real timers; running the *full* integration suite in
  parallel (13 concurrent `mongodb-memory-server` replica sets) can make timing-sensitive tests
  flaky under heavy CPU contention — they're stable in isolation. Not a correctness issue.
- Type coverage of the public surface lives in `tests/types/*.test-d.ts`, checked by `tsd`
  (`pnpm run test:types`) — update these when `index.d.ts` or `bullmq.d.ts` changes.
  `bullmq.test-d.ts` is also where the real BullMQ classes are checked against the structural
  `BullMQ*Like` types, and `index.test-d.ts` where the real `@opentelemetry/api` types are checked
  against `MigronautTracer` / `MigronautMeter` — part by part (span, options, instruments), since a
  whole-tracer assignability check alone passes for almost any shape.
- Telemetry is tested against the real OpenTelemetry SDK with in-memory exporters
  (`tests/helpers/otel.js`). `startTracing()` registers the global context manager — without it no
  span can be made active — which is safe only because `node:test` runs one process per file; stop
  it in `after`. `tests/integration/telemetry-mongodb.test.js` loads the real driver
  instrumentation and must do so **before** anything requires `mongodb` (its first lines). The
  cross-process trace is BullMQ's doing, so it is asserted only in the opt-in real-Redis file.

## Things that look like bugs but aren't

See ARCHITECTURE.md §8 for the full list — highlights: `markApplied` upserts (needed for
`redo`/`force`/`import`); `markReverted` never deletes (audit trail); migrate-mongo imports are
forward-only and rejected by `down`/`redo`; `init` has no JSON output — `init --format json`
generates `migronaut.config.json`, and a stray `init --json` is rejected with a pointer to
`--format`. In the queue adapter: migration jobs are forced to `attempts: 1` (a BullMQ retry
re-queues behind the waiting jobs and would break the order); a job behind a failed migration
fails as `MIGRATION_BLOCKED` instead of waiting; an already-applied migration's job *completes*
as `skipped`; and non-retryable errors are renamed `UnrecoverableError` only when a job has
`attempts > 1` (BullMQ matches that name — the adapter cannot import the class). For ids:
`generateId` is called with **no** arguments on purpose (a "purpose" argument would be read by
`ulid`/`nanoid` as their own first parameter), and the lock document carries a migronaut-minted
`nonce` next to `owner` — the owner is the user-shaped run id, so mutual exclusion must not depend
on it. For telemetry: a run that never got the lock emits **no span** (lock-wait polling retries
the whole run every ~500ms — the refusals are counted in `migronaut.lock.refused` instead), so the
run span opens inside `runWithLock`'s callback
and the lock's own driver commands sit outside it; the span status code is the literal `2` and
`recordException` is never called (the enum lives in a package migronaut does not import, and a raw
exception would skip redaction); status is never set to OK; `telemetry.open` takes its result from
the callback rather than the tracer and tracks whether it ran, which is what stops a broken tracer
from skipping or double-running a migration; and the scheduled `sync` job template carries
`telemetry: { omitContext: true }`, without which every scheduler tick joins one endless trace.
For declared collections (`converge`, ARCHITECTURE.md §6.7): without `prune` an undeclared index
is never dropped — an identical one under another name is accepted as is, a different one is a
`conflict` that refuses the whole run before any write; definition *files* load at converge time,
not config time (a broken file must not block `down`); `up --json` stays the migration rows (the
converge result travels as `converge:end`, `summary.converge` and `converge --json`); `dryRun('up')`
never previews a converge; `ConvergeFailedError` keeps its progress in `context.converge`, never
`context.results` (the kit and the CLI read `results` as migration rows); the CLI confirms *after*
planning, inside `run`, like `unlock`; a converge job carries no `prune` and is ordered by default;
and a converge run adds no third telemetry wrap site. Names already taken, so not to reuse for
anything else: `sync` (the queue job), `ensureIndexes` and the audit check `indexes` (the
changelog's own indexes), `schema` (`migronaut.schema.json`).
Don't "fix" these without checking the doc first.
