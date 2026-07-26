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

Two faces, one engine:

- **CLI** (`migronaut`) — what most users run (`bin/migronaut.js` → `src/cli/index.js`).
- **Programmatic API** (`MigratorKit` class + helper functions) — for app startup, serverless,
  tests. Exported from `src/index.js`, re-exported at the package root (`index.js`) — the
  *only* thing users should import from.

All real logic lives in the orchestrator `MigratorKit` ([src/core/migrator.js](src/core/migrator.js)),
which coordinates small single-responsibility modules: `config`, `lock`, `changelog`, `runner`,
`context`, `import`.

Three ideas explain almost everything:

1. **Config is resolved once** with priority CLI flags > `MIGRONAUT_*` env vars > config file >
   defaults ([src/core/config.js](src/core/config.js)).
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
- **Types live in one hand-written file**: [index.d.ts](index.d.ts) at the package root. It is
  the *only* source of truth for the public type surface — there is no per-file `.d.ts`, no
  generation step. When you add or change a public export, update `src/index.js` (the runtime
  barrel) **and** `index.d.ts` (the types) together — they are maintained by hand in lockstep,
  not derived from each other.
- **Correctness of the hand-written types is enforced by [tsd](https://github.com/tsdjs/tsd)**
  (`tests/types/index.test-d.ts`, run via `pnpm run test:types`), not by a compiler pass over
  `index.d.ts` itself.
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
| `dotenv` | [src/utils/env.js](src/utils/env.js) — native `util.parseEnv` (Node ≥ 20.12) or built-in fallback, `override: false` semantics |
| `chalk` | [src/utils/colors.js](src/utils/colors.js) — `FORCE_COLOR` > `NO_COLOR` > `TERM=dumb` > `isTTY` detection, `stripAnsi` |
| `ora` | [src/cli/spinner.js](src/cli/spinner.js) — `start(text)`/`stop()`, complete no-op off-TTY |
| `commander` | [src/cli/args.js](src/cli/args.js) — commander-compatible subset (subcommands, `--no-x`, short aliases, camelCase, help/version); no combined short flags (`-fy`) |
| `cli-table3` | [src/cli/table.js](src/cli/table.js) — box-drawing renderer, ANSI-aware widths (no wcwidth/CJK) |
| `zod` | `validateConfig` in [src/core/config.js](src/core/config.js) — table-driven `CONFIG_KEYS`, same `{path, message}` issues |

**Never add a runtime dependency.** Third-party integrations are injected by the user instead:
`MigronautLogger` is pino-compatible (`{debug, info, warn, error, child?}`), so a pino instance
passes straight through `resolveLogger` (which binds `child({component: 'migronaut'})` once and
guards every call — logging must never break a run). devDependencies are fine (`pino` is a devDep
because the logger-adapter tests exercise the real thing).

## Repository layout

```
index.js               # module.exports = require('./src/index.js') — package entry point
index.d.ts               # Hand-written public type surface — the ONLY .d.ts in the repo
bin/migronaut.js          # CLI shebang entry (CJS, no build)
src/
├── index.js                # Public API barrel — re-exported at the package root
├── errors/index.js          # MigronautError base + one subclass per error code
├── core/                     # The engine (config, lock, changelog, runner, context, import, migrator, run)
├── utils/                     # logger, colors, env, checksum, loader, template, date — pure-ish helpers
└── cli/                        # own arg parser (args.js) + spinner + table + one file per command
tests/
├── unit/                # mocked DB, pure logic — node:test
├── integration/          # real in-memory MongoDB via mongodb-memory-server (replica set) — node:test
└── types/                 # tsd type-tests against index.d.ts
docs/                   # VitePress user-facing site — never published to npm
blog/                   # Long-form posts, also docs-only
migrations/             # Example/dev migration files used while developing this repo itself
```

**Layering rule:** Presentation (`cli/`, `bin/`) never touches the DB or contains migration
logic. Orchestration (`core/migrator.js`, `core/run.js`) sequences steps and owns the
connection lifecycle. Mechanism modules (`core/{lock,changelog,runner,context,import,config}.js`,
`utils/`) do one job each and know nothing about the CLI — no `console.*`, no spinner or table
imports. The CLI injects a `ProgressReporter` callback into core instead.

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
pnpm run lint              # oxlint src bin scripts tests bench
pnpm run format              # oxfmt src bin scripts tests bench
pnpm run format:check          # oxfmt --check src bin scripts tests bench
pnpm test                        # node --test (unit + integration, ~265 tests)
node --test tests/integration/up.test.js   # single file
pnpm run test:coverage             # node --test under c8, gated at 90/90/90
pnpm run test:types                  # tsd — checks index.d.ts against tests/types/*.test-d.ts
node bin/migronaut.js --help           # run the CLI directly — no build, ever
pnpm run size                            # esbuild bundle-size report (library + CLI), no publish artifact
pnpm run bench                           # ops/sec micro-benchmarks (bench/bench.js), manual only, not in CI
pnpm run docs:dev                        # vitepress dev docs
```

`prepublishOnly` runs lint + format:check + test:coverage + test:types — treat that as the
pre-merge gate. There is no `build` script and nothing to run before testing or publishing;
`files` in `package.json` ships `index.js`, `index.d.ts`, `bin/`, and `src/` as-is.

## Conventions (enforced by oxlint/oxfmt + review)

- Plain CommonJS (`require`/`module.exports`) in `src/`/`bin/` — no TypeScript syntax, no
  `import`/`export`. JSDoc is documentation only (see "No build step" above).
- Never `throw new Error` — always a `MigronautError` subclass with a typed `code`.
- Never `console.*` — always the injected `MigronautLogger` (`null` = silent, used in tests).
- Public API changes touch two files together: `src/index.js` (runtime export) and
  `index.d.ts` (hand-written type) — never one without the other.
- Single quotes, semicolons, 100-col lines, no unused vars/imports (oxlint/oxfmt-enforced).
- Conventional Commits (`feat(scope):`, `fix(scope):`, `test:`, …).

## Testing notes

- Runner is Node's built-in `node:test` (no external test framework). Two tiers:
  `tests/unit/` (mocked DB, plain function/`mock.fn` stubs — no `vi.mock` module-mocking is
  used anywhere) and `tests/integration/` (real `mongodb-memory-server` replica set, so
  transactions work).
- `node:test` uses `before`/`after`, not `beforeAll`/`afterAll` (those are Vitest/Jest names —
  don't reintroduce them).
- Silence the logger (`logger: null`) in tests. No committed `.only`/`.skip`.
- Coverage gate: 90% lines / 90% functions / 90% branches (`pnpm run test:coverage`, via `c8`).
- The lock-heartbeat integration tests use real timers; running the *full* integration suite in
  parallel (13 concurrent `mongodb-memory-server` replica sets) can make timing-sensitive tests
  flaky under heavy CPU contention — they're stable in isolation. Not a correctness issue.
- Type coverage of the public surface lives in `tests/types/*.test-d.ts`, checked by `tsd`
  (`pnpm run test:types`) — update these when `index.d.ts` changes.

## Things that look like bugs but aren't

See ARCHITECTURE.md §8 for the full list — highlights: `markApplied` upserts (needed for
`redo`/`force`/`import`); `markReverted` never deletes (audit trail); migrate-mongo imports are
forward-only and rejected by `down`/`redo`; `--json` on `init` means "generate
`migronaut.config.json`", not "emit JSON output". Don't "fix" these without checking the doc
first.
