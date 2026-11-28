# CLAUDE.md

Notes for agents working on **migronaut** (`@alexify/migronaut`, CLI `migronaut`), a MongoDB
migration toolkit for Node.js — a fork of `mongo-migrate-kit` (CLI `mmk`) by Santosh Gupta, renamed
and maintained here. [ARCHITECTURE.md](ARCHITECTURE.md) is the long form (module reference, data
flow, §8 for the nuances); these notes add what is easy to get wrong.

The notes are split by where they bite. This file holds what applies to the whole repository; a
folder with a CLAUDE.md of its own holds the rules of the code in it, and Claude Code reads one
when it reads a file of that folder. A rule lives in ONE file: the folder of the module it is
about, or the nearest folder above every module it spans (this file for `src/` as a whole). The
nearest CLAUDE.md wins if two ever seem to disagree; fix the one that is wrong.

| File | What it holds |
| --- | --- |
| [src/core/CLAUDE.md](src/core/CLAUDE.md) | The engine: its layers, config and the environment, the changelog and the lock, the kit's events and runs, ids, telemetry's wrap sites, migration logs |
| [src/core/background/CLAUDE.md](src/core/background/CLAUDE.md) | Background migrations: the host and its flows, completion, drift, locks beside the migration lock, lanes, shard-aware reads |
| [src/core/converge/CLAUDE.md](src/core/converge/CLAUDE.md) | Declared collections: indexes and validators without `prune`, search indexes, the wait without the lock |
| [src/bullmq/CLAUDE.md](src/bullmq/CLAUDE.md) | The queue adapter: BullMQ injected, the layer above the kit, jobs and retries, userland rows, the background queue, closing |
| [src/versioning/CLAUDE.md](src/versioning/CLAUDE.md) | The versioning runtime: it requires nothing of the engine, the Mongoose plugin, its TypeScript 5.0 types |
| [src/cli/CLAUDE.md](src/cli/CLAUDE.md) | The command line: presentation only, signals and exit codes, the parser |
| [tests/CLAUDE.md](tests/CLAUDE.md) | Tests: shape, the six sanctioned skips, mocked time and `waitFor`, the fake BullMQ, telemetry and types |
| [docs/CLAUDE.md](docs/CLAUDE.md) | The site: the hand-written `llms.txt`, the docs-sync tests, the schema copy, diagrams |

## The mental model

Two faces, one engine — plus an adapter on top and a runtime beside it:

- **CLI** (`bin/migronaut.js` → `src/cli/`) and the **programmatic API** (`MigratorKit` and
  helpers, `src/index.js`, re-exported at the root by `index.js`).
- **Queue adapter** (`./bullmq`, `src/bullmq/`, re-exported by `bullmq.js`): migrations as BullMQ
  jobs, driving the public kit API only; since 2.3 background migrations on a queue of their own.
- **Versioning runtime** (`./versioning`, `src/versioning/`, re-exported by `versioning.js`): the
  shape version and revision helpers of an application's repository layer, engine-free.
- Since 2.3, **background migrations**: a file with `export const background = {…}` that `up`
  only registers; partitions, leases and a coordinator rewrite the collection beside the line, in
  any runtime, never holding the migration lock.

The root, `./bullmq` and `./versioning` are the *only* entry points; `exports` is closed to the
rest. Three ideas explain almost everything: config is resolved once (flags > `MIGRONAUT_*` > file
> defaults); the changelog (`_migronaut_migrations`) is append-mostly; a MongoDB-native lock
(`_migronaut_locks`) with a heartbeat makes concurrent runs safe.

## No build step

- `src/` and `bin/` are plain CommonJS, shipped as they are — no TypeScript syntax, no
  `import`/`export`, no compile step for authors or consumers, no dual CJS/ESM build (ESM consumers
  use Node's interop). The CLI reads its version from `package.json` at runtime.
- The public types are three hand-written files, one per entry: `index.d.ts`, `bullmq.d.ts`,
  `versioning.d.ts`. A public change touches the entry's barrel and its `.d.ts` together
  (`src/index.js` + `index.d.ts`, `src/bullmq/index.js` + `bullmq.d.ts`,
  `src/versioning/index.js` + `versioning.d.ts`), with a `tsd` assertion in `tests/types/`. The
  subpaths import root types from `./index.js`; the root never imports a subpath; no `.d.ts`
  imports an optional package. JSDoc in `src/` says *why*; the `.d.ts` files document the API.
- Migration and config files the user writes may be `.ts`/`.mjs`/`.cjs`/`.js`: `utils/loader.js`
  `import()`s them on the running Node (type stripping from 22.18, or a loader like `tsx`). The
  scaffolds of `utils/template.js` hold only erasable syntax.

## Zero dependencies

`package.json` has no `dependencies` key — `mongodb` (required) and `mongoose` (optional) are
peers. What used to be a library is in-tree: `utils/env.js` (`util.parseEnv`, not overriding),
`utils/colors.js`, `cli/spinner.js`, `cli/args.js` (a commander subset), `cli/table.js`, and
`validateConfig` over `CONFIG_KEYS` (once `zod`). **Never add a runtime dependency**; what
integrates is injected:

- a logger (`MigronautLogger`, pino-compatible; `resolveLogger` binds `child({ component })` once
  and guards every call), `logger: null` or `false` to silence;
- BullMQ — not even a peer ([src/bullmq/CLAUDE.md](src/bullmq/CLAUDE.md));
- ids — `generateId` ([src/core/CLAUDE.md](src/core/CLAUDE.md));
- OpenTelemetry — `telemetry: { tracer, meter }`; `utils/telemetry.js` is the only module that
  names an OpenTelemetry thing or calls a tracer, span or instrument, every call through its one
  `callSafely()`.

Nothing under `src/` or `bin/` may `require` `bullmq`, `ioredis`, `@opentelemetry/*`,
`bullmq-otel` or `mongoose`, and `mongodb` only where [src/core/CLAUDE.md](src/core/CLAUDE.md)
says — `tests/unit/package-surface.test.js` greps for each. devDependencies are fine (`pino`,
`bullmq`, `ioredis`, the OpenTelemetry SDK for the tests; `mermaid` and the Vercel packages for
the docs theme).

## Layout

```
index.js, bullmq.js, versioning.js   # root shims: module.exports = require('./src/…/index.js')
index.d.ts, bullmq.d.ts, versioning.d.ts   # the hand-written types, one per entry
bin/migronaut.js                     # the CLI's shebang entry
src/
├── index.js                         # the public barrel
├── errors/index.js                  # MigronautError and one subclass per code
├── core/                            # the engine (src/core/CLAUDE.md)
│   ├── background/                  # background migrations
│   └── converge/                    # declared collections
├── versioning/                      # the ./versioning runtime
├── utils/                           # actor, canonical, checksum, collection-name, colors, concurrency,
│                                    #   date, env, error, file, id, job-ref, loader, logger,
│                                    #   migration-name, redact, sanitize, telemetry, template, user
├── cli/                             # the parser, spinner, table, one file per command
└── bullmq/                          # the queue adapter
tests/                               # unit/, integration/, helpers/, fixtures/, types/ (tests/CLAUDE.md)
bench/, scripts/                     # bench.js; node-test.js, size.js, test-optin.js
examples/                            # runnable example apps, own package.json, never published
docs/, blog/                         # the VitePress site and long-form posts, never published
migrations/                          # dev migrations of this repository
.claude/skills                       # the alexiskills symlink `prepare` makes (git-ignored)
```

Layers: presentation (`cli/`, `bin/`) never touches the database; orchestration
(`core/migrator.js`, `core/run.js`) sequences and owns the connection; mechanism modules and
`utils/` do one job each and know nothing of the CLI. The queue adapter is a layer above the kit.
The core may require `src/versioning/`, never the other way.

Names from the fork are gone: `migronaut`, `MIGRONAUT_*`, `migronaut.config.*`,
`Migronaut…` types, `_migronaut_*` collections — never `mmk`, `Mmk`, `MMK` or `mongo-migrate-kit`.

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
pnpm run test:coverage             # node --test under c8 over src/ and bin/, gated at 90 (lines, branches, functions, statements)
pnpm run test:types                  # tsd — checks index.d.ts, bullmq.d.ts and versioning.d.ts against tests/types/*.test-d.ts
pnpm run check:dts                     # tsc --noEmit --strict (--types node --lib esnext) over the three .d.ts files on their own
node bin/migronaut.js --help           # run the CLI directly — no build, ever
pnpm run size                            # esbuild bundle-size report (library, CLI, queue adapter), no publish artifact
pnpm run test:optin [redis] [atlas] [sharded]  # the opt-in suites; without a variable it fails and prints the container to start
pnpm run bench                           # median ± spread per hot path (bench/bench.js; --json to diff), manual only
pnpm run docs:dev                        # vitepress dev docs
```

`prepublishOnly` runs lint + format:check + test:coverage + test:types + check:dts — treat that as
the pre-merge gate. There is no `build` script and nothing to run before testing or publishing;
`files` in `package.json` ships `index.js`, `index.d.ts`, `bullmq.js`, `bullmq.d.ts`,
`versioning.js`, `versioning.d.ts`, `migronaut.schema.json`, `bin/`, and `src/` as-is (but the
folders' `CLAUDE.md`, excluded by `!**/CLAUDE.md`), with `README.md`, `CHANGELOG.md`, `LICENSE` and
`SECURITY.md`.

The devDependencies sit on the newest majors the peer range admits (`mongodb` 7, `mongoose` 9,
`typescript` 7): that is what the gate runs on. CI's `compat` job swaps in `mongodb@6` with
`mongoose@8` and runs both test tiers again — a driver and a Mongoose of different majors do not
mix (each refuses the other's BSON types), so they are swapped as a pair. TypeScript 7 no longer
includes `@types/node` or a lib with `AsyncDisposable` by default, which is why `check:dts` names
both. The `unit` job names the engines floor exactly (`22.18.0`); `22` alone is the newest 22.x.

## Conventions

The style is `js-conventions` of alexiskills, its **Library profile** (CommonJS, hand-written
`.d.ts`, `node:test` with c8, no runtime dependency): `const` arrows, loops in one pass instead of
array iteration methods in `src/`, no array destructuring and no `Object.entries` /
`Object.values` in `src/`, strict comparisons, every `let` with a value of its kind (`null` for a
reference), no nested ternaries, `return void fn()`, verb names, `is`/`has`/`can`/`should`
booleans, units in numeric names, full words. What follows is what migronaut adds or does
otherwise; **this file wins** where the two disagree.

- Never `throw new Error` — a `MigronautError` subclass with its code (see Errors); the
  scaffold text of `utils/template.js` and `cli/args.js`'s `TypeError` are the two sanctioned
  files. Never `console.*` — the injected logger; the CLI writes to the process streams.
- Logging, telemetry and event listeners never fail the run they observe; a hook (`beforeEach`,
  `onError`, …) may, as `HookFailedError`.
- A caught error becomes text only through `utils/error.js`: `formatError` (URI credentials
  masked), `formatErrorWithCause` ("what failed — why", both redacted) and `formatDocumentError`
  (the values a duplicate-key or validation error quotes masked). Never a raw `error.message`,
  `stack` or driver `errorResponse` in a log line, a context, an event payload or a span.
- The root shims and the `.d.ts` files are outside the lint and format globs: keep them in the
  house style by hand.
- The hot paths are what `pnpm run bench` measures, the converge comparison and a background
  migration's per-document loop: no closure or `RegExp` per call there, `try/catch` only around
  user code and I/O. Run the bench before and after touching one; a row that moved by more than
  its spread is a finding.
- Before naming anything new, read the names already taken (below). Single quotes, semicolons,
  100 columns; Conventional Commits.

### The lint

`.oxlintrc.json` is the reference of alexiskills (`node-tooling-testing`,
`references/ci-types-release.md`) over the explicit rule list the repository had: `correctness`
and `suspicious` as errors; `eqeqeq` `always` with `null` included; no `no-void`;
`func-style: expression`, `max-depth` 4, `no-nested-ternary`, `no-console`, `no-undef` and
`getter-return` everywhere. In `src/` the unicorn plugin, the array iteration methods and
`Object.entries` / `Object.values` through `no-restricted-properties`, `init-declarations` (a
`let` starts with a value), `id-denylist` for `err`, `unicorn/no-useless-spread` (a spread that
copies what is already a fresh array or object), and `max-lines-per-function` 80 as a warning.
Where it differs, and why:

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

A rule of alexiskills that migronaut breaks by design, with the reason; the folders' notes list
their own.

- **`String(value)` where the value may be a symbol** (a template literal throws on one):
  anything thrown (`core/runner.js`, `utils/error.js`, an error's `name` in `utils/redact.js`), a
  key of a user `Map` (`utils/redact.js`, `utils/canonical.js`), an event name
  (`core/migrator.js`), what a caller logs (`core/migration-logger.js`, `utils/sanitize.js`).
  Everything else is a template literal.
- **`let x = undefined`, written out**, where `undefined` is what a user's function returned
  (`utils/id.js`, `utils/telemetry.js`).
- **`sink[name].bind(sink)`** (`utils/logger.js`): an injected logger's methods (pino's) read
  `this`, and the guard calls them detached. The rule against `.bind` is about listeners.
- **`delete require.cache[…]`** (`utils/loader.js`): `reloadMigrations` must drop the CommonJS
  entry, which a query string does not reach.
- **A sort in place** only as a statement of its own, on an array the function just built;
  everything else is `toSorted`. **Four function expressions** in `src/`: three Mongoose hooks
  that read `this` and a sandbox cursor's `async function*`.
- **MongoDB documents built from user field names** (query, sort, projection, index key,
  shard-key bounds) stay object literals; lookup tables keyed by input (`LEVELS`, `STATUS_COLORS`,
  `FIELD_DEFAULTS`, `DRIVER_REGEXP_FLAGS`, a text index's weights, the tracer's attributes) are
  null-prototype.
- **`toWire`** (`utils/canonical.js`) keeps a sparse array's holes, as `map` did.
- **`realpathSync`** (`utils/loader.js`): it matches the spelling the module loader takes.
- **Three disable directives**: `no-control-regex` twice in `utils/sanitize.js` (stripping
  control characters is the point) and `no-restricted-properties` once in `bullmq/service.js`.
- **`max-lines-per-function` warns on 40 functions** — the orchestrators of `core/migrator.js`,
  the queue processors and the group wait, the converge planners, the CLI command registrations:
  sequential protocols, split where a piece reads better named, not to reach 80 lines.
- **`doc`** stays the name of a MongoDB document, the driver's own word.
- **`MigratorKit` extends `EventEmitter`** rather than holding a private one: `kit.on`,
  `captureRejections` and the `.d.ts` are the public API.
- **The default logger prints** progress (it is CLI-shaped); a library caller silences it with
  `logger: null`.
- **The config schema is pinned, not generated**: `migronaut.schema.json` is held to `CONFIG_KEYS`
  (its enum values and bounds) by `schema-sync` — no generator script to run at release.

## Errors

`src/errors/index.js` holds `MigronautError` and exactly one subclass per code. The class name
ends in `Error`, and its code is `ALX_ERR_` and that name in `UPPER_SNAKE_CASE`
(`LockAlreadyHeldError` / `ALX_ERR_LOCK_ALREADY_HELD`), as alexiskills asks of every string code.

- Every class takes `(message, options = {})`, as `Error` does (alexiskills 1.2):
  `new LockLostError(message, { cause, context })`. `options` goes to `super` whole, so `cause` is
  set only when given; only `MigronautError` itself reads `options.code`, and each subclass sets
  its own after `super`. Every instance has `name`, `message`, `code` and `context` (`{}` when none
  was given — so `context.results` attaches to any of them), and `cause` when it wraps one. A
  wrap site writes `{ cause: error, context: { …, cause: formatError(error) } }`, in that order.
- `code` is the contract: what the CLI prints (`✖ ALX_ERR_LOCK_ALREADY_HELD: …`), what `--json`
  emits as `error.code`, what `EXIT_CODES` maps and what the queue decides retries by. `context` is plain,
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
- E11000 `dup key` values are masked in background state, queue jobs, telemetry and
  `migration:log`, and left **as they are** in `migration:error`, `run:end`, `--json` rows and the
  changelog's `failed` trace — the owner's decision; SECURITY.md says which channel does what.
- Driver 7 words any refused write of code 20 as "This MongoDB deployment does not support
  retryable writes…" with no code and the server's error under `originalError`:
  `unwrapServerError` reads through it (`formatError`, `isTransactionsUnsupported`) — never match
  on that message or the outer `code`.
- Retrying already exists — reuse it: transactions retry through `withTransaction` (a fresh
  context per attempt, `ctx.run.attempt`); `core/lock-wait.js` polls a held lock with a jittered,
  capped interval; migration jobs are `attempts: 1` and `RETRYABLE_CODES`
  (`src/bullmq/processor.js`) decides the rest; a lane retries a failed slice with backoff; a
  search-index wait rides out three blips. A new loop is bounded, jittered, retries only codes
  known to be transient, stops with the kit, and never repeats a non-idempotent write without a
  guard.
- The library never installs `process.on(...)` handlers and never calls `process.exit()`; the CLI
  is an app around it and may ([src/cli/CLAUDE.md](src/cli/CLAUDE.md)).
- **Kept on purpose (error-handling):** a class per code, not per layer — `library-errors.md`
  allows it, and the classes are exported.

**Adding an error code**, one change: the subclass in `src/errors/index.js` (and its exports),
`constructor(message, options = {})` with `super(message, options)`, its `name` and its `code`;
the literal in the `MigronautErrorCode` union and the class in `index.d.ts` (`readonly code` the
literal, `constructor(message: string, options?: MigronautErrorOptions)`); the export from
`src/index.js` with a `tsd` assertion; an exit code in `src/cli/exit-codes.js` (the next free
number, never renumber one); a row in the table of `docs/reference/error-codes.md` and in the
exit-code table of `docs/reference/cli.md`; the queue's verdict (`RETRYABLE_CODES` lists the codes
a retry can fix — an unknown code stays retryable). `tests/unit/package-surface.test.js` holds the
classes, the union, `EXIT_CODES` and both docs tables to each other, and every code to the
`ALX_ERR_` prefix. A new member of the public union shipped in minors (2.1 – 2.4); 2.0.0 called
one breaking — ask which the release is. Renaming or removing one is breaking.

**Every code starts with `ALX_ERR_`** since 3.0, the three CLI conditions `EXIT_CODES` also names
included (`ALX_ERR_PENDING_MIGRATIONS`, `ALX_ERR_AUDIT_FAILED`, `ALX_ERR_COLLECTIONS_DRIFT`). 2.x
named them without it (`LOCK_ALREADY_HELD`); the CHANGELOG's `Upgrading from 2.x` lists each old
and new name, and the exit numbers did not change. Codes of Node, MongoDB and the other packages
stay as they are (`ENOENT`, `11000`). The metric key `METRICS.LOCK_LOST` of `utils/telemetry.js` is
not an error code and has no prefix.

## Skills

The skills are [alexiskills](https://alexiskills.vercel.app), `@alexify/metaskills` 1.2.0, a
devDependency, forked from [metarhia/metaskills](https://github.com/metarhia/metaskills). All 37
are linked: `.claude/skills` is one symlink to `node_modules/@alexify/metaskills/skills`, made by
`prepare` (`alexiskills claude`) on every `pnpm install`, a worktree's included, and git-ignored.

- **The skills are not edited here.** A change to one goes to `Alexis-Technologies/metaskills`
  and comes back with a release of the package. A skill of this repository's own beside them would
  turn the symlink into a directory of links, and one named like a skill of the package hides it.
- `npm-publish` runs only as `/npm-publish`; the agent does not call it on its own.

**These notes win** if a skill and they ever disagree.

## Names already taken

Not to reuse for anything else: `sync` (the queue job), `ensureIndexes` and the audit check
`indexes` (the changelog's own indexes), the audit checks `search` and `background`, `schema`
(`migronaut.schema.json`), the queue jobs `background`, `background-lane` and `background-verify`
(and the scheduler `migronaut-background-verify`), the collections `_migronaut_background`,
`_migronaut_background_partitions` and `_migronaut_background_watch`, the lock ids `background:*`
and `watch:*`, the event `migration:log`, the log-field marker `userland`, `ctx.run`, the run
option `job`, the queue option `userlandLogRows`, the sync result field `convergeHeld`, the
converge fields `fingerprint`, `repeats` and `lastAt`, the event field `code`, and the throttle
reason `lag`. Don't "fix" what a folder's notes or ARCHITECTURE §8 call deliberate without reading
them first.

## Release process

Manual, from a laptop: no release workflow, no provenance, no publish automation, and none to
propose (nor size budgets, `pnpm audit` in CI or dependabot — the maintainer declined them). The
`npm-publish` skill of alexiskills walks through the steps; it runs only as `/npm-publish`, and
this section wins where the two differ. What migronaut adds to its steps:

- **Branch and commits.** A feature lands on its own branch and writes its entries under
  `## [Unreleased]` while it is built. The release commit on that branch is
  `chore(release): X.Y.Z`; the branch is squash-merged into `main` as
  `Migronaut vX.Y: <headline> (#N)`, and the tag `vX.Y.Z` is lightweight, on that squash commit.
  Releases so far: 1.0.0, 2.0.0 – 2.5.0 and 3.0.0. Tags `v1.1.0`, `v1.2.3` and `v1.3.0` are the
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
  `bullmq`) and `pnpm run docs:build`. Then `pnpm run test:optin` for the suites the release
  touches (it prints the container each needs): `redis` whenever the queue adapter or the background
  queue changed, `atlas` after search-index changes, `sharded` after shard-aware changes. It fails
  where a variable is missing, so a release never passes on a skip.
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
  examples, bench, scripts and assets stay out, and `!**/CLAUDE.md` keeps the folders' notes out of
  `src/`); no `dependencies` key. The tarball smoke test of
  the skill runs in a temporary consumer outside the repository, the one place `npm` and `npx`
  are used: `npm install` of the tarball with `mongodb`, `require` and `import` of the three
  entries, `tsc` over an import of each, `npx migronaut --version`, and a deep import that fails
  with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Report the file count and the rows of `pnpm run size`.
- **Publish.** The maintainer runs `pnpm publish` (which re-runs `prepublishOnly`) from the
  tagged commit, with npm 2FA — there is no `release` or `publish` script, as `npm-publish`
  asks — writes the GitHub release notes from the CHANGELOG section, and checks the docs deploy
  (the nav label shows the new version). The agent never pushes, tags or publishes on its own.
