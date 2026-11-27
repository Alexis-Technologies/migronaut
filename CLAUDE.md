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

Two faces, one engine — plus one optional adapter on top, and one engine-free runtime beside it:

- **CLI** (`migronaut`) — what most users run (`bin/migronaut.js` → `src/cli/index.js`).
- **Programmatic API** (`MigratorKit` class + helper functions) — for app startup, serverless,
  tests. Exported from `src/index.js`, re-exported at the package root (`index.js`).
- **Queue adapter** (`@alexify/migronaut/bullmq`) — opt-in: migrations as BullMQ jobs, one
  migration per job, for running migronaut as a service. Exported from `src/bullmq/index.js`,
  re-exported by the root shim `bullmq.js`. It drives the public `MigratorKit` API and nothing
  below it. Since 2.3 it also runs background migrations on a queue of their own.
- **Versioning runtime** (`@alexify/migronaut/versioning`) — small helpers for an application's
  repository layer: the shape version `__v`, the optimistic-concurrency revision `__rev`,
  `defineShapes`, `upcaster`, the Mongoose plugin. Exported from `src/versioning/index.js`,
  re-exported by `versioning.js`. It requires nothing outside `src/versioning/` and `src/errors/`
  (a test pins it): no core, no `mongodb`, no `mongoose`.

The package root, `./bullmq` and `./versioning` are the *only* three things users import from —
the `exports` map is closed to everything else.

Since 2.3 the engine also runs **background migrations** (ARCHITECTURE §6.8): a file with
`export const background = {…}` that `up` only registers; partitions, leases (= slots, capped by a
unique index at `maxParallel`) and a coordinator then rewrite the collection beside the line, in
any runtime (CLI `background run`, `startBackgroundRunner`, the queue), never holding the
migration lock. MongoDB holds all of their truth.

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
- **Types live in three hand-written files, one per entry point**: [index.d.ts](index.d.ts) for
  the package root, [bullmq.d.ts](bullmq.d.ts) for `./bullmq` and [versioning.d.ts](versioning.d.ts)
  for `./versioning`. They are the *only* source of truth for the public type surface — there is no
  per-file `.d.ts`, no generation step. When you add or change a public export, update the entry's
  runtime barrel **and** its `.d.ts` together (`src/index.js` + `index.d.ts`, `src/bullmq/index.js`
  + `bullmq.d.ts`, or `src/versioning/index.js` + `versioning.d.ts`) — they are maintained by hand
  in lockstep, not derived from each other. The subpaths import root types from `./index.js`; the
  root never imports from a subpath. `versioning.d.ts` needs TypeScript ≥ 5.0 (`const` type
  parameters); the others ≥ 4.8.
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
| `cli-table3` | [src/cli/table.js](src/cli/table.js) — box-drawing renderer, ANSI-aware widths, wide characters (CJK, emoji) counted as two columns |
| `zod` | `validateConfig` in [src/core/config.js](src/core/config.js) — table-driven `CONFIG_KEYS`, same `{path, message}` issues |

**Never add a runtime dependency.** Third-party integrations are injected by the user instead:
`MigronautLogger` is pino-compatible (`{debug, info, warn, error, child?}`), so a pino instance
passes straight through `resolveLogger` (which binds `child({component: 'migronaut'})` once and
guards every call — logging must never break a run). devDependencies are fine (`pino` is a devDep
because the logger-adapter tests exercise the real thing; `@vercel/analytics` and
`@vercel/speed-insights` are devDeps consumed only by the VitePress theme in
`docs/.vitepress/theme/index.ts`, and `mermaid` only by `docs/.vitepress/theme/mermaid.ts`, which
draws the docs' `mermaid` code fences in the browser — none of it ships to npm).

**BullMQ is injected too — it is not even a peer.** The queue adapter takes the caller's classes
(`createMigrationQueue({ bullmq: { Queue, Worker, QueueEvents } })`); nothing under `src/` may
`require('bullmq')` (a unit test greps for it) and no `.d.ts` may import it — `bullmq.d.ts`
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
redacted status message plus `error.type`, and there are exactly three wrap sites, all in
`core/migrator.js`: the `migronaut.run` span (opened once the lock is held), the
`migronaut.migration` span (the *active* span while a migration runs — the one thing lifecycle
events cannot provide), and the background spans handed to `background.js` through its deps —
`migronaut.background.slice` (one lease held) and `migronaut.background.coordinate` (one
coordinator step), each opened only once the lease or the coordinator lock is held. Nothing under `src/` or `bin/` may `require` an `@opentelemetry/*` package or
`bullmq-otel`, and no `.d.ts` may import one (a unit test greps for it); the types are
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
versioning.js            # module.exports = require('./src/versioning/index.js') — the ./versioning subpath
versioning.d.ts          # Hand-written types for it (structural driver types, per-version shape types)
bin/migronaut.js          # CLI shebang entry (CJS, no build)
src/
├── index.js                # Public API barrel — re-exported at the package root
├── errors/index.js          # MigronautError base + one subclass per error code
├── core/                     # The engine (config, lock, lock-wait, changelog, runner, context, import, migrator, run,
│                             #   options, sequence, run-recorder, migration-logger (ctx.run, ctx.logger,
│                             #   migration:log), and declared collections: collections,
│                             #   index-spec, search-index-spec, converge-plan, converge, converge-search,
│                             #   converge-search-run, converge-log, server-info, versioning-spec,
│                             #   shard-info; background migrations: background-spec, -partition, -shard,
│                             #   -store, -engine, -throttle, background, -drift, -audit, -kit, -sandbox,
│                             #   -dry-run, -runner, -watch, -watch-plan, -watch-store; bson-peer)
├── versioning/                # The ./versioning runtime: internal, config, document (the shared contract),
│                             #   occ, registry, upcaster, mongoose
├── utils/                     # logger, colors, env, checksum, loader, template, date, migration-name, id, telemetry,
│                             #   canonical, collection-name, actor, job-ref, error, redact — pure-ish helpers
├── cli/                        # own arg parser (args.js) + spinner + table + one file per command
└── bullmq/                      # Queue adapter: jobs (contract), producer, processor, background-processor,
                                 #   wait, service (facade)
tests/
├── unit/                # mocked DB, pure logic — node:test
├── integration/          # real in-memory MongoDB via mongodb-memory-server (replica set) — node:test
├── helpers/              # incl. fake-bullmq.js (in-memory BullMQ double) + bullmq-scenarios.js,
│                         #   bullmq-fidelity.js, bullmq-background-scenarios.js + otel.js (real SDK, in-memory)
├── fixtures/sharded/     # start.sh — a whole sharded cluster in one mongo:8.0 container
└── types/                 # tsd type-tests against index.d.ts, bullmq.d.ts and versioning.d.ts
examples/               # Runnable example apps (migration-service) — own package.json, never published
docs/                   # VitePress user-facing site — never published to npm
blog/                   # Long-form posts, also docs-only
migrations/             # Example/dev migration files used while developing this repo itself
.claude/skills          # a symlink to the alexiskills of node_modules (made by prepare, git-ignored)
```

**Layering rule:** Presentation (`cli/`, `bin/`) never touches the DB or contains migration
logic. Orchestration (`core/migrator.js` with its `run-recorder.js`, `core/run.js`) sequences
steps and owns the connection lifecycle. Mechanism modules
(`core/{lock,changelog,runner,context,import,config,options,sequence,server-info}.js`, `utils/`) do one job each and know nothing about the CLI — no `console.*`, no spinner or table
imports. The CLI injects a `ProgressReporter` callback into core instead. The queue adapter
(`bullmq/`) is a second orchestration layer *above* the kit: it may require `core/migrator.js`,
`core/lock-wait.js`, `utils/` and `errors/`, but never a mechanism module (`lock`, `changelog`,
`runner`, any `background-*`) and never the database — if it needs something the kit does not
offer, the kit gains a small public option (that is where `up({ batch, ordered })`, `nextBatch()`,
`coordinateBackground()` and `driftMode()` came from). `core/background.js` (with
`background-drift.js`, `background-audit.js` and `background-kit.js`) and `core/background-watch.js`
are flows like `converge.js`: they get what they need as `deps`, built only by `migrator.js`.
The core may require `src/versioning/`; `src/versioning/` never requires the core.

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
pnpm install               # also links the alexiskills skills into .claude/skills (prepare)
pnpm run lint              # oxlint src bin scripts tests bench examples; a stale disable directive fails it
pnpm run format              # oxfmt src bin scripts tests bench examples
pnpm run format:check          # oxfmt --check src bin scripts tests bench examples
pnpm test                        # test:unit then test:integration (~2550 tests)
pnpm run test:unit                 # unit only — fast, no MongoDB
pnpm run test:integration            # integration only, serial (--test-concurrency=1)
node --test tests/integration/up.test.js   # single file
pnpm run test:coverage             # node --test under c8, gated at 90/90/90
pnpm run test:types                  # tsd — checks index.d.ts, bullmq.d.ts and versioning.d.ts against tests/types/*.test-d.ts
pnpm run check:dts                     # tsc --noEmit --strict (--types node --lib esnext) over the three .d.ts files on their own
node bin/migronaut.js --help           # run the CLI directly — no build, ever
pnpm run size                            # esbuild bundle-size report (library, CLI, queue adapter), no publish artifact
# The real-BullMQ suite is opt-in (CI runs it; everything else needs no Redis):
#   docker run --rm -d -p 6379:6379 redis:7-alpine
#   MIGRONAUT_TEST_REDIS_URL=redis://127.0.0.1:6379 node --test tests/integration/bullmq-redis.test.js
# The Atlas Search suite is opt-in and manual (CI never runs it) — after search index changes:
#   docker run --rm -d -p 27018:27017 -e DO_NOT_TRACK=1 mongodb/mongodb-atlas-local:8.0
#   MIGRONAUT_TEST_ATLAS_URI="mongodb://127.0.0.1:27018/?directConnection=true" \
#     node --test tests/integration/search-atlas.test.js
# The sharded-cluster suite is opt-in and manual too — after shard-aware changes:
#   docker run --rm -d --name migronaut-sharded -p 27019:27017 \
#     -v "$PWD/tests/fixtures/sharded:/s:ro" mongo:8.0 bash /s/start.sh
#   MIGRONAUT_TEST_SHARDED_URI="mongodb://root:root@127.0.0.1:27019/?authSource=admin" \
#     node --test tests/integration/sharded.test.js
pnpm run bench                           # ops/sec micro-benchmarks (bench/bench.js), manual only, not in CI
pnpm run docs:dev                        # vitepress dev docs
```

`prepublishOnly` runs lint + format:check + test:coverage + test:types + check:dts — treat that as
the pre-merge gate. There is no `build` script and nothing to run before testing or publishing;
`files` in `package.json` ships `index.js`, `index.d.ts`, `bullmq.js`, `bullmq.d.ts`,
`versioning.js`, `versioning.d.ts`, `migronaut.schema.json`, `bin/`, and `src/` as-is, with
`README.md`, `CHANGELOG.md`, `LICENSE` and `SECURITY.md`.

The devDependencies sit on the newest majors the peer range admits (`mongodb` 7, `mongoose` 9,
`typescript` 7): that is what the gate runs on. CI's `compat` job swaps in `mongodb@6` with
`mongoose@8` and runs both test tiers again — a driver and a Mongoose of different majors do not
mix (each refuses the other's BSON types), so they are swapped as a pair. TypeScript 7 no longer
includes `@types/node` or a lib with `AsyncDisposable` by default, which is why `check:dts` names
both. The `unit` job names the engines floor exactly (`22.18.0`); `22` alone is the newest 22.x.

## Conventions

The style is `js-conventions` of alexiskills, its **Library profile** (CommonJS, hand-written
`.d.ts`, `node:test` with c8, no runtime dependency): `const` arrows and no `function`
declarations, loops in one pass instead of array iteration methods in `src/`, no array
destructuring and no `Object.entries` / `Object.values` in `src/`, strict comparisons only, every
`let` with a value of its kind, no nested ternaries, `return void fn()` for call-then-return. This
section is what migronaut adds to it or does otherwise. **This file wins** where the two disagree.

### What migronaut adds

- Plain CommonJS (`require`/`module.exports`) in `src/`/`bin/` — no TypeScript syntax, no
  `import`/`export`. JSDoc in `src/` says *why* (a decision, a trap, an invariant); the public API
  is documented in the three `.d.ts` files (see "No build step" above).
- The three root shims (`index.js`, `bullmq.js`, `versioning.js`) and the root `.d.ts` files are
  outside the lint and format globs: keep them in the house style by hand.
- Never `throw new Error` — always a `MigronautError` subclass with a typed `code` (see
  "Errors" below). A unit test (`tests/unit/package-surface.test.js`) holds it, with two
  sanctioned files: the `throw new Error` lines of `src/utils/template.js` are text of the user's
  scaffold, and `src/cli/args.js` throws a `TypeError` for a malformed flag definition, a bug in
  migronaut's own command table.
- Never `console.*` — always the injected `MigronautLogger` (`null` = silent, used in tests).
  `no-console` and the same unit test hold it; the CLI writes to `process.stdout` / `stderr`.
- Logging, telemetry and event listeners never fail the run they observe: `resolveLogger` guards
  every logger call, `telemetry.js` puts every tracer and meter call behind its one `safe()`, and
  the kit's `captureRejections` turns a rejecting `async` listener into a debug line. A hook
  (`beforeEach`, `onError`, …) may fail the run, as `HookFailedError`.
- A caught error becomes text only through `src/utils/error.js`: `errorText` (credentials in a
  URI masked), `errorWithCause` ("what failed — why", both halves redacted) and
  `documentErrorText` (the values a duplicate-key or validation error quotes masked). Never a raw
  `error.message`, `error.stack` or driver `errorResponse` in a log line, an error context, an
  event payload or a span.
- Public API changes touch two files together — the entry's runtime barrel and its hand-written
  types: `src/index.js` + `index.d.ts`, `src/bullmq/index.js` + `bullmq.d.ts`, or
  `src/versioning/index.js` + `versioning.d.ts` — never one without the other, with a `tsd`
  assertion in `tests/types/`. No `.d.ts` imports an optional package (`mongoose`, `bullmq`,
  `@opentelemetry/*`); the subpaths import root types from `./index.js`; `versioning.d.ts` may use
  TypeScript 5.0 (`const` type parameters), the others stay within 4.8.
- `require('mongodb')` only in `core/migrator.js` and `core/bson-peer.js` (lazily, for `BSON`);
  never `require('mongoose')` under `src/` — the Mongoose plugin works on the schema it is given
  (a unit test greps for both).
- Never `require('bullmq')` (or `ioredis`) under `src/`, and never import it in a `.d.ts` — the
  adapter works on what the caller injects.
- Never `require('@opentelemetry/…')` (or `bullmq-otel`) under `src/` or `bin/`, and never import
  one in a `.d.ts` — the tracer and meter are injected. Never call a tracer, span or instrument
  outside `src/utils/telemetry.js`, and never `recordException` a raw error (it skips redaction).
- Never call `randomUUID` (or mint an id any other way) outside `src/utils/id.js` — an id minted
  elsewhere is one the user's `generateId` cannot reach.
- A new scalar config key gets its `CONFIG_KEYS` entry, its `ENV_KEYS` entry, a line in
  `migronaut.schema.json` (and its byte-identical copy in `docs/public/`) and the README's env
  table — unit tests pin each pairing. Before naming anything new, read the names already taken
  (the last paragraph of "Things that look like bugs but aren't").
- Migration and config files the user writes may be `.ts`: the scaffolds of
  `src/utils/template.js` hold only erasable syntax (no `enum`, `namespace` or parameter
  properties), since Node's type stripping loads them.
- The hot paths are what `pnpm run bench` measures (`computeChecksum`, `loadMigrationFile`,
  `Changelog`, `MigrationLock`, `MigratorKit.up()` over many files), the converge comparison
  (`canonical.js`, the index and search-index diffs — on plan, replan, verify and every settle
  read) and a background migration's per-document loop: no closure or `RegExp` per call there,
  `try/catch` only around user code and I/O. Run the bench before and after touching one; a row
  that moved is a finding.
- Single quotes, semicolons, 100-col lines, no unused vars/imports (oxlint/oxfmt-enforced).
- Conventional Commits (`feat(scope):`, `fix(scope):`, `test:`, …).

### The lint, and where it differs from the reference

`.oxlintrc.json` is the reference of alexiskills (`node-tooling-testing`,
`references/ci-types-release.md`) over the explicit rule list the repository had: `correctness`
and `suspicious` as errors; `eqeqeq` `always` with `null` included; no `no-void`;
`func-style: expression`, `max-depth` 4, `no-nested-ternary`, `no-console`, `no-undef` and
`getter-return` everywhere. In `src/` the unicorn plugin, the array iteration methods and
`Object.entries` / `Object.values` through `no-restricted-properties`, `init-declarations` (a
`let` starts with a value), `id-denylist` for `err`, and `max-lines-per-function` 80 as a
warning. Where it differs, and why:

- **`find` and `filter` are not in `no-restricted-properties`.** They are MongoDB words —
  `Collection#find`, a query's `filter` option and property, destructured as `{ filter }` — and
  the rule cannot tell an array from a collection by name. A unit test
  (`tests/unit/package-surface.test.js`) holds them instead: no `.find(` or `.filter(` called with
  a function in `src/` or `bin/`.
- **`no-underscore-dangle`** (of `suspicious`) allows `_id`, `__v`, `__rev` and `_bsontype`, the
  names MongoDB, the versioning runtime and BSON give, and is off in `tests/`, whose fakes and
  fixtures reach into internals and globals by underscore names.
- **`func-style` is off in `tests/fixtures/`**: they are migration and template files in the
  shape users write them (`export async function up`).
- **`no-console` is off in `scripts/`, `bench/` and `examples/`**, which print. `bin/` and
  `src/cli/` need no exception: they write to the process streams.
- **Array destructuring has no lint rule** (oxlint has no `no-restricted-syntax`); the
  package-surface test holds `src/` and `bin/` to none.

### Kept on purpose

A rule of alexiskills that migronaut breaks by design, with the reason:

- **`String(value)` where the value may be a symbol** (a template literal throws on one):
  anything thrown — a non-`Error` throw wrapped as a cause (`core/runner.js`), `errorText`
  (`utils/error.js`), an error's `name` (`utils/redact.js`), what BullMQ or Redis threw
  (`bullmq/wait.js`), a thrown driver error's message (`core/background-store.js`); a key of a
  user `Map` (`utils/redact.js`, `utils/canonical.js`); an event name (`core/migrator.js`); what a
  caller logs (`core/migration-logger.js`, `utils/sanitize.js`); the argument of a sandboxed
  `db.collection(name)` (`core/background-sandbox.js`), refused when it is not a string.
  Everything else is a template literal.
- **`delete` on data whose missing key means something.** `delete require.cache[…]` in
  `src/utils/loader.js`: `reloadMigrations` drops the file's entry as well as adding a query
  string, since the query alone reloads ES modules only and the CommonJS cache would hand back the
  old module. `process.env` in `src/cli/index.js`: assigning `undefined` stores the string
  `'undefined'`. A MongoDB query filter and an update document in `src/versioning/mongoose.js`:
  an absent key is no constraint, and an empty `$setOnInsert` must be absent. The dry run's copy of
  a user document (`core/background-dry-run.js`), where the delete previews `$unset`.
- **Spreads of rest arguments**: `cli/args.js` hands a command its positionals (at most the two
  it declares) the commander way, `core/background-sandbox.js` forwards the arguments of a proxied
  driver call, and `core/migrator.js` calls a hook with a fixed list of one or two. No data array
  is spread into arguments.
- **`let x = undefined`, written out**, where `undefined` is the value of no return or part of a
  contract: what a function or user code returned (`#withLock` and `runWithLock` in
  `core/migrator.js`, `utils/id.js`, `utils/telemetry.js`); `failure` in `#withLock` and
  `#runSequence`, where a thrown `undefined` still counts as no failure, as before; `hosted` in
  `core/background-runner.js` (`runner.watcher` is `BackgroundWatcher | undefined`); `target` and
  `suspended` in `core/background-watch-plan.js`, returned as `undefined`.
- **A sort in place** only as a statement of its own, on an array the function just built (a copy
  of a `Set`, the characters of a string, rows the kit reads fresh); everything else is
  `toSorted` (engines is Node ≥ 22.18).
- **MongoDB documents built from user field names** — query, sort, projection and index key
  documents, shard-key bounds — stay object literals: they are what the driver serializes and what
  events and tests compare, not lookup tables. The lookup tables keyed by input (`LEVELS`,
  `STATUS_COLORS`, `FIELD_DEFAULTS`, `DRIVER_REGEXP_FLAGS`, the weights of a text index, the
  attributes handed to the tracer) are null-prototype.
- **`stamp`** (`src/versioning/mongoose.js`) is a `function` expression: Mongoose middleware reads
  its document from `this`. It is the one function expression in `src/`.
- **Three disable directives**: `no-control-regex` twice in `utils/sanitize.js` (stripping control
  characters is the point) and `no-restricted-properties` once in `bullmq/service.js` (the public
  `schedule({ every })` option destructured, not `Array#every`).
- **`max-lines-per-function` warns on 40 functions** — the orchestrators of `core/migrator.js`,
  the queue processors and the group wait, the converge planners, the CLI command registrations. They are long
  because they are sequential protocols; a piece is split out where it reads better named, not to
  reach 80 lines.
- **Error codes without `ALX_ERR_`**: see "Errors".

### Errors

`src/errors/index.js` holds `MigronautError` and exactly one subclass per code. The class name
ends in `Error` and its code is that name in `UPPER_SNAKE_CASE` (`LockAlreadyHeldError` /
`LOCK_ALREADY_HELD`).

- Every class takes `(message, options = {})`, as `Error` does (alexiskills 1.2):
  `new LockLostError(message, { cause, context })`. `options` goes to `super` whole, so `cause` is
  set only when given; only `MigronautError` itself reads `options.code`, and each subclass sets
  its own after `super`. Every instance has `name`, `message`, `code` and `context` (`{}` when none
  was given — so `context.results` attaches to any of them), and `cause` when it wraps one. A
  wrap site writes `{ cause: error, context: { …, cause: errorText(error) } }`, in that order.
- `code` is the contract: what the CLI prints (`✖ LOCK_ALREADY_HELD: …`), what `--json` emits as
  `error.code`, what `EXIT_CODES` maps and what the queue decides retries by. `context` is plain,
  JSON-safe data about the failure (it survives `--json` and the changelog's failure trace);
  `context.results` is reserved for the migration rows a stopped run already applied. `cause` is
  the original error, so `error.cause.stack` still points into the user's code.
- A bad option or a malformed file is operational: the user can fix it, and a caller branches on
  it — `ConfigInvalidError`, `MigrationInvalidNameError`, `QueueJobInvalidError` …, never a bare
  `TypeError`.
- Wrap where the meaning changes, keep the original as `{ cause }` and its redacted text in
  `context.cause`; a `MigronautError` coming up from below keeps its code. A migration that
  throws becomes `MigrationExecutionFailedError` after `onError` ran (a throwing `onError` never
  masks it); when only the changelog write failed, `context.phase` is `'changelog-write'` and
  `onError` does not fire.
- Never swallow: rethrow, or route to `onError`. A deliberate swallow says why in a comment and
  leaves a `logger.debug` line (releasing the lock in `finally` after a failed run, closing a
  connection on the way out).
- Retrying already exists — reuse it: transactions retry through `withTransaction` (a fresh
  context per attempt, `ctx.run.attempt`); `core/lock-wait.js` polls a held lock with a jittered,
  capped interval; migration jobs are `attempts: 1` and `RETRYABLE_CODES`
  (`src/bullmq/processor.js`) decides the rest; a lane retries a failed slice with backoff; a
  search-index wait rides out three blips. A new loop is bounded, jittered, retries only codes
  known to be transient, stops with the kit, and never repeats a non-idempotent write without a
  guard.
- The library never installs `process.on(...)` handlers and never calls `process.exit()`. The CLI
  (`bin/migronaut.js`, `src/cli/`) is an app around the library and may: `attachSignalHandlers`
  (`src/cli/shared.js`) turns the first SIGINT/SIGTERM into `kit.stop()` and a second one exits
  130/143; otherwise it sets `process.exitCode` from `EXIT_CODES[error.code] ?? 1` and lets the
  process drain (`process.exit()` would truncate piped output).

**Adding an error code**, one change: the subclass in `src/errors/index.js` (and its exports),
`constructor(message, options = {})` with `super(message, options)`, its `name` and its `code`;
the literal in the `MigronautErrorCode` union and the class in `index.d.ts` (`readonly code` the
literal, `constructor(message: string, options?: MigronautErrorOptions)`); the export from
`src/index.js` with a `tsd` assertion; an exit code in `src/cli/exit-codes.js` (the next free
number, never renumber one); a row in the table of `docs/reference/error-codes.md` and in the
exit-code table of `docs/reference/cli.md`; the queue's verdict (`RETRYABLE_CODES` lists the codes
a retry can fix — an unknown code stays retryable). `tests/unit/package-surface.test.js` holds the
classes, the union, `EXIT_CODES` and both docs tables to each other. A new member of the public
union shipped in minors (2.1 – 2.4); 2.0.0 called one breaking — ask which the release is.

**The `ALX_ERR_` prefix is a temporary exception.** alexiskills 1.1 starts every string code with
`ALX_ERR_`; migronaut's codes are public — printed, emitted in `--json`, mapped to exit codes,
matched by the queue and by users — so renaming one breaks every consumer that matches on it. They
keep their names until **3.0**, which renames all of them (`LOCK_ALREADY_HELD` →
`ALX_ERR_LOCK_ALREADY_HELD`, the class names unchanged):

`LOCK_ALREADY_HELD`, `LOCK_RELEASE_FAILED`, `LOCK_LOST`, `RUN_ABORTED`, `HOOK_FAILED`,
`CHECKSUM_MISMATCH`, `MIGRATION_FILE_NOT_FOUND`, `MIGRATION_FILE_EXISTS`,
`MIGRATION_INVALID_NAME`, `MIGRATION_INVALID_EXPORT`, `MIGRATION_EXECUTION_FAILED`,
`MIGRATION_TIMEOUT`, `TRANSACTIONS_UNSUPPORTED`, `CONFIG_INVALID`, `CONFIG_FILE_EXISTS`,
`CONNECTION_FAILED`, `NOT_APPLIED`, `IMPORT_TARGET_NOT_EMPTY`, `MIGRATION_IRREVERSIBLE`,
`MIGRATION_OUT_OF_ORDER`, `MIGRATION_BLOCKED`, `QUEUE_JOB_INVALID`, `QUEUE_JOB_FAILED`,
`CONVERGE_FAILED`, `REVISION_CONFLICT`, `SHAPE_VERSION_UNSUPPORTED`, `BACKGROUND_PENDING`,
`BACKGROUND_FAILED`, `BACKGROUND_CONFLICT`, `SANDBOX_REFUSED` — and the three CLI conditions
`EXIT_CODES` also names, `PENDING_MIGRATIONS`, `AUDIT_FAILED` and `COLLECTIONS_DRIFT`.

Until then a new code follows the existing format, so the set stays one naming scheme; 3.0 moves
them together, with `Upgrading from 2.x` in the CHANGELOG listing each old and new name.

## Skills

The skills are [alexiskills](https://alexiskills.vercel.app), `@alexify/metaskills` 1.2.0, a
devDependency: the skills of the Alexis libraries, forked from
[metarhia/metaskills](https://github.com/metarhia/metaskills). All 37 of them are linked:
`.claude/skills` is one symlink to `node_modules/@alexify/metaskills/skills`, made by the
`prepare` script (`alexiskills claude`) on every `pnpm install`, a worktree's included, and left
out by `.gitignore`. Until 2026-11-25 the directory held six skills of metarhia/metaskills 1.0.5,
`js-conventions`, `error-handling` and `npm-publish` adapted to this repository; what they said of
migronaut alone is in this file now ("Conventions", "Errors", "Release process").

- **The skills are not edited here.** A change to one goes to `Alexis-Technologies/metaskills`
  and comes back with a release of the package. A skill of this repository's own beside them
  would turn the symlink into a directory of links (the CLI's pack mode, with a block of its own
  in `.gitignore`), and one named like a skill of the package hides that skill.
- `npm-publish` runs only as `/npm-publish`; the agent does not call it on its own
  (`disable-model-invocation: true`).

**This file wins** if a skill and this file ever disagree.

## Testing notes

- `describe` and `it` from `node:test`, every `it` title starting with `should`, assertions from
  `node:assert/strict`. A method a group of tests is about is a `describe` of its own
  (`describe('markApplied')`), and so is a tag (`describe('[probe]')`, `[fidelity]`, `[fake]`,
  `[background]`), never a prefix of the title.
- Runner is Node's built-in `node:test` (no external test framework). Two tiers:
  `tests/unit/` (mocked DB, plain function/`mock.fn` stubs — no `vi.mock` module-mocking is
  used anywhere) and `tests/integration/` (real `mongodb-memory-server` replica set, so
  transactions work).
- `node:test` uses `before`/`after`, not `beforeAll`/`afterAll` (those are Vitest/Jest names —
  don't reintroduce them).
- Silence the logger (`logger: null`) in tests. No committed `.only`/`.skip` — with four
  sanctioned exceptions, all environment-capability skips with a reason, not disabled tests:
  `tests/integration/bullmq-redis.test.js` when `MIGRONAUT_TEST_REDIS_URL` is unset (CI sets it),
  `tests/integration/search-atlas.test.js` when `MIGRONAUT_TEST_ATLAS_URI` is unset (CI never
  does — run it by hand after changing `search-index-spec.js`, `converge-search.js` or the search
  planner; the unit fake carries the coverage, but only a real `mongot` proves the fixed point),
  and `tests/integration/sharded.test.js` when `MIGRONAUT_TEST_SHARDED_URI` is unset (CI never
  does — run it by hand after changing the shard-aware code; its `[probe]` describes pin what
  ARCHITECTURE §6.8 says a mongos does), and the symlink case of `tests/unit/sequence.test.js`
  where the OS will not create a file symlink (Windows without the privilege — CI's runners have
  it).
- An integration test that expects a rejection disconnects its kit in a `finally`: an assertion
  that fails inside `assert.rejects` otherwise leaves the client open, and the file hangs instead
  of failing.
- The queue adapter is tested against `tests/helpers/fake-bullmq.js`, an in-memory double — that
  is where its coverage comes from, so the gate passes with no Redis. The scenarios live once, in
  `tests/helpers/bullmq-scenarios.js`, and run against both the fake and (in the opt-in file) the
  real `bullmq`: add adapter behaviour there. If the two disagree, the fake is what is wrong.
  Every scenario must wait for everything it enqueued — `settled`, `untilRecord`, a group's
  `wait()` — before it ends: `afterEach` force-closes, which does not wait for a migration in
  flight, and a straggler writes into the next scenario's database (a sync tick's migration job
  runs *after* the tick completes).
- The background queue builds on BullMQ semantics the fake models and
  `tests/helpers/bullmq-fidelity.js` pins against both the fake and the real library (delays,
  parents and children). Background scenarios (`tests/helpers/bullmq-background-scenarios.js`) wait
  until MongoDB says what they expect *and* the background queue holds nothing waiting, active,
  delayed or waiting for children.
- Background migrations' integration tests use a child process for `kill -9`
  (`tests/helpers/background-child.js`) and the server's `failCommand` fail point (the memory server
  starts with `enableTestCommands`) — e.g. for a real change-stream error 286.
- Coverage gate: 90% lines / 90% functions / 90% branches (`pnpm run test:coverage`, via `c8`).
- The lock-heartbeat integration tests use real timers; running the *full* integration suite in
  parallel (13 concurrent `mongodb-memory-server` replica sets) can make timing-sensitive tests
  flaky under heavy CPU contention — they're stable in isolation. Not a correctness issue.
- Type coverage of the public surface lives in `tests/types/*.test-d.ts`, checked by `tsd`
  (`pnpm run test:types`) — update these when `index.d.ts`, `bullmq.d.ts` or `versioning.d.ts` changes.
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
and a converge run adds no telemetry wrap site of its own. For search indexes (§6.7 too): a search
index is never `recreate`d (a `$search` on a missing index returns nothing — a type or immutable
`autoEmbed` change is a `conflict`); a FAILED build with the declared definition stays `unchanged`,
and builds never count against `inSync`; `type` is sent to `createSearchIndexes` only for a vector
index, and `updateSearchIndex` is retried with it only on a self-managed `mongot`'s "mappings is
required"; the availability probe trusts an empty list only from 7.2.1+ (older servers go through
`getParameter`); defaults are filled per field mapping too (`FIELD_DEFAULTS` — mongot writes them
into what it reports) and a field's list of types compares as a set; an Atlas CLI local deployment
cannot update a vector index at all (the step fails with the new-name hint — not a migronaut bug);
and nothing reads search indexes for a definition without `searchIndexes`. An option only the
server reports, with no default in those tables, is **ignored** in the comparison (`ignored` on the
row, one warning) — otherwise a new mongot default would update and rebuild the index on every
run; the opt-in Atlas suite still fails on one, since that means a table is missing a default. The
wait for builds (`waitForSearchIndexes`) runs **without the migration lock** — released via
`runWithLock`'s `control.release()` once every step is applied — so `lock:released` (`early: true`)
can precede `run:end`, and a newer converge may change the index under it; it fails only on a
FAILED build of an index the run created or changed (an untouched FAILED/STALE one is warned about,
and `--check` still fails on FAILED); STALE never ends a wait early; up to three network or
failover blips in a row are ridden out; and `migronaut.converge.search.wait.duration` is a metric
point, not a wrap site. A search index list that cannot be read reports the phase that read
it (`plan` only before the first write). For background migrations (§6.8): `up` applies a
background file without running it (the state document says how far the rewrite is), and a file
may not export both `background` and `up`/`down`; completion is decided by counting what still
matches, never by summing partitions; a drift reopening is a new pass, not a reset, so an old
release that keeps writing exhausts `maxPasses` and fails visibly; the coordinator lock
(`background:<name>`) and the watcher lock (`watch:<collection>`) live beside `migronaut_lock` and
`forceUnlock`/`unlock`/audit never touch them; on the queue a lane *completes* for every outcome
the kit recorded (its coordinator decides from MongoDB), lanes carry `ignoreDependencyOnFailure`
(the other three failure policies strand or wake the coordinator wrongly) and get a new job id per
spawn (BullMQ will not move a job to another parent); `stampedDiff` writes only the fields that
changed, so untouched fields keep their BSON types; a lane stopped by its caller (a shutdown) is
`stopped`, never a failed slice, and `maxSliceFailures` counts failed slices in a row (a checkpoint
resets it); `down` of a one-way background migration pauses it and waits for its lanes before it
decides (a `step` one counts any checkpointed step as rewritten) and goes by the spec stored at
registration; coordinator rounds are handed out by the kit under the coordinator lock (a queue
chain asks without one), and a sync tick that waits for a background migration reports `waiting`,
never `held`; `maxDocumentErrors` is capped at the 1000 bad ids a state keeps; the scaffold's
placeholder collection `'TODO'` is refused by `up`; a revision guard refuses an operator-valued
`_id`; background document errors mask dup-key values (`documentErrorText`); a shard-aware read may reach two shards (a
mongos takes a `$lt` bound as inclusive when it picks shards); the shard-key guard compares
numbers by value; the live watcher opens its stream *before* it probes the past; a typed
`current` past the highest shape, written inline, errors as "not assignable to type 'never'"
(from an imported `as const` definition it names the two numbers); there is no
`maximum` on the version, and a validator synthesized for versioning alone is `moderate`. For
migration logs: migronaut **stores none** — `ctx.logger` lines go to the configured logger, and only
fields with `userland: true` (exactly; the marker stays on the line) also emit `migration:log`, at
any level and with `logger: null`, never in a dry run; the event is not a session write (it
survives a rollback) and fires once per transaction attempt (`ctx.run.attempt`, a fresh frozen
context per attempt); `logger`/`run` are *optional* in `MigrationContext`'s types on purpose (a
hand-built context in a test must type-check), and `ctx.logger` is a `MigrationLogger` with
method syntax and union parameters (not overloads) so any `MigronautLogger` still fits; an
`Error` in a call's data becomes `{ name, message, code?, codeName? }` (a driver error's raw
response quotes the document's values); the queue processors route userland rows by **job id and
run id**, never by `current` alone, mirror at most `userlandLogRows` per job (a lane: per slice)
and seal a job before its last flush; lanes an `up` drives inline (`backgroundInline`) carry the
run's `jobId` **and `groupId`** — the group is what tells them from a background queue's lanes,
whose ids may repeat a migration job's — but no parent run id; the kit is an
`EventEmitter` with `captureRejections`, so a rejecting `async` listener is a debug line. From the
2.4 review: E11000 `dup key` values are masked in background state, queue jobs, telemetry and
`migration:log`, and left **as they are** in `migration:error`, `run:end`, `--json` rows and the
changelog's `failed` trace — the owner's decision (SECURITY.md says which channel does what);
`markFailed` clears the requester of an earlier apply but keeps the revert fields (it is still
reverted); a file that does not load gets a migration span and a duration point, not a
`migration:error` or a `failed` trace (it never did); a run the lock refused still emits
`run:start`/`run:end` — the queue processor reads its run id there — and is told apart by
`code: 'LOCK_ALREADY_HELD'`; a lost lock is said once, and its heartbeat goes on only after a
*deadline* loss (the document may still be ours); `reloadMigrations` drops the file's
`require.cache` entry as well as adding the query string (the query alone reloads ES modules
only); the CLI exits 6 on a command line that does not parse and refuses `--flag=value` on a flag
that takes none, while `args.js` on its own still exits 1 (the CLI takes parse errors over with
`onUsageError`); an option nobody reads is **warned about, not refused**, on the queue's entry
points (`enqueueBackground` refuses, as before); a tick's held converge is `convergeHeld`, a
field of its own (`converge` stays the job that was added), and is held until the plan's
`fingerprint` changes, not for a time; a job settles without its log rows after 5 s
(`JOB_WRITE_WAIT_MS`), and `close({ force: true })` on top of a `close()` under way only stops
waiting; a background plan is worked by the partitioner that split it or re-split (`planMismatch`),
and a lane waiting for a lagging secondary yields at its slice's deadline; a throttle hook's pause
and a retry backoff are capped at an hour; driver 7 words any refused write of code 20 as "This
MongoDB deployment does not support retryable writes…" with no code and the server's error under
`originalError` — `serverErrorOf` reads through it (`errorText`, `isTransactionsUnsupported`), so
do not match on that message or on the outer `code`. Names
already taken, so not to reuse for anything else: `sync` (the queue job), `ensureIndexes` and the
audit check `indexes` (the changelog's own indexes), the audit check `search`, `schema`
(`migronaut.schema.json`), the queue jobs `background`, `background-lane` and
`background-verify` (and the scheduler `migronaut-background-verify`), the audit check
`background`, the collections `_migronaut_background`, `_migronaut_background_partitions` and
`_migronaut_background_watch`, the lock ids `background:*` and `watch:*`, the event
`migration:log`, the log-field marker `userland`, `ctx.run`, the run option `job`, the queue
option `userlandLogRows`, the sync result field `convergeHeld`, the converge fields `fingerprint`,
`repeats` and `lastAt`, the event field `code`, and the throttle reason `lag`.
Don't "fix" these without checking the doc first.

## Release process

Manual, from a laptop: no release workflow, no provenance, no publish automation, and none to
propose (nor size budgets, `pnpm audit` in CI or dependabot — the maintainer declined them). The
`npm-publish` skill of alexiskills walks through the steps; it runs only as `/npm-publish`, and
this section wins where the two differ. What migronaut adds to its steps:

- **Branch and commits.** A feature lands on its own branch and writes its entries under
  `## [Unreleased]` while it is built. The release commit on that branch is
  `chore(release): X.Y.Z`; the branch is squash-merged into `main` as
  `Migronaut vX.Y: <headline> (#N)`, and the tag `vX.Y.Z` is lightweight, on that squash commit.
  Releases so far: 1.0.0 and 2.0.0 – 2.5.0. Tags `v1.1.0`, `v1.2.3` and `v1.3.0` are the
  upstream `mongo-migrate-kit`'s, not releases of this package.
- **The bump (step 2).** Additive features are minors even when they add `MigronautErrorCode`
  members (2.1 – 2.4); 2.0.0 was a major for three narrow contract changes, one a new error code.
  When a release changes a public type, an event payload, an exit code or a default, say so and
  let the maintainer choose. The version lives in **four places**, changed together in the release
  commit and held equal by `tests/unit/package-surface.test.js`: `package.json` `"version"` (the
  CLI reads it at runtime), the newest `## [X.Y.Z] - YYYY-MM-DD` of `CHANGELOG.md`, the snapshot
  line near the top of `ARCHITECTURE.md` (`**Snapshot at time of writing:** vX.Y.Z`), and the nav
  label of `docs/.vitepress/config.mts` (commented as hand-synced).
  `examples/migration-service` depends on `file:../..` — nothing to bump there.
- **Gates (step 1).** `prepublishOnly` (lint, format:check, test:coverage, test:types,
  check:dts), then `pnpm run size` (a tripwire, not a budget: the adapter's or the versioning
  runtime's number jumping by an order of magnitude means something required the engine or
  `bullmq`) and `pnpm run docs:build`. Then the opt-in suites the release touches ("Commands" has
  the containers): the real BullMQ one whenever the queue adapter or the background queue changed,
  Atlas Search after search-index changes, the sharded cluster after shard-aware changes.
  `pnpm outdated` and `pnpm audit` are about devDependencies only; the peer floors
  (`mongodb >=5.0.0`, `mongoose >=7.0.0`) stay as they are.
- **CHANGELOG (step 3).** Keep a Changelog: `## [Unreleased]` on top, `## [X.Y.Z] - YYYY-MM-DD`
  newest first, a lead paragraph (what the release is about, whether it is additive, what is
  experimental), the headings of the skill only, bullets with a bold lead-in, and the link block
  at the bottom — a test holds every heading to its link. Review commits fold into the entry they
  fix.
- **Typings (step 4).** `tests/unit/package-surface.test.js` pins the root and `./bullmq`
  barrels against their `.d.ts` (`./versioning` against a list of names), the error classes
  against `MigronautErrorCode`, `EXIT_CODES` and the two docs tables; the docs-sync tests pin the
  rest (`events-docs-sync`, `telemetry-docs-sync`, `schema-sync`, `readme-sync`). Still read each
  barrel against its declarations for what a name test cannot see — option fields, result fields,
  event payloads.
- **Docs and license (step 5).** README: the usage examples, the comparison tables, the env table,
  and the Benchmarks table re-run with `pnpm run bench` when the release touched a benchmarked
  path. `docs/`: the guide and command pages, `docs/reference/error-codes.md` and `cli.md`, the
  home page for a headline feature, the sidebar for a new page. `docs/public/llms.txt` is
  hand-written: it names every entry point and headline feature, Node ≥ 22.18 and the
  zero-dependency claim. ARCHITECTURE.md: the snapshot line, the module reference, §8 for a new
  nuance, §10's published-artifact list. CLAUDE.md: the layout, the names already taken, the
  commands. SECURITY.md names the current minor line as the one supported (a test holds it).
  `LICENSE` changes only its year, never its two holders (the original author and Alexis
  Technologies).
- **Package (step 6).** `exports` is exactly `.`, `./bullmq` and `./versioning`, `types` first;
  `files` is the allowlist "Commands" lists (no `.npmignore`, so `.claude`, tests, docs, blog,
  examples, bench, scripts and assets stay out); no `dependencies` key. The tarball smoke test of
  the skill runs in a temporary consumer outside the repository, the one place `npm` and `npx`
  are used: `npm install` of the tarball with `mongodb`, `require` and `import` of the three
  entries, `tsc` over an import of each, `npx migronaut --version`, and a deep import that fails
  with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Report the file count and the rows of `pnpm run size`.
- **Publish.** The maintainer runs `pnpm publish` (which re-runs `prepublishOnly`) from the
  tagged commit, with npm 2FA — there is no `release` or `publish` script, as `npm-publish`
  asks — writes the GitHub release notes from the CHANGELOG section, and checks the docs deploy
  (the nav label shows the new version). The agent never pushes, tags or publishes on its own.
