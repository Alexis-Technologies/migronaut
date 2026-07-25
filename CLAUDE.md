# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**migronaut** (npm package `@alexify/migronaut`, CLI binary `migronaut`) — an elegant,
TypeScript-first MongoDB migration toolkit for Node.js. It is a fork of the original
`mongo-migrate-kit` (CLI `mmk`) by Santosh Gupta, renamed and now maintained here.

For the full architectural deep dive (module reference, data flow, subtle subsystems, the
"why" behind non-obvious decisions), read [ARCHITECTURE.md](ARCHITECTURE.md) — it is kept
in sync with the code and is the source of truth for anything not covered below.

## The 5-minute mental model

Two faces, one engine:

- **CLI** (`migronaut`) — what most users run (`bin/migronaut.ts` → `src/cli/index.ts`).
- **Programmatic API** (`MigratorKit` class + helper functions) — for app startup, serverless,
  tests. Exported from `src/index.ts`, the *only* file users should import from.

All real logic lives in the orchestrator `MigratorKit` ([src/core/migrator.ts](src/core/migrator.ts)),
which coordinates small single-responsibility modules: `config`, `lock`, `changelog`, `runner`,
`context`, `import`.

Three ideas explain almost everything:

1. **Config is resolved once** with priority CLI flags > `MIGRONAUT_*` env vars > config file >
   defaults ([src/core/config.ts](src/core/config.ts)).
2. **The changelog (`_migronaut_migrations` collection) is append-mostly.** Applying upserts a
   record; reverting updates it to `status:'reverted'` — it never deletes.
3. **A MongoDB-native lock (`_migronaut_locks`) makes concurrent runs safe**, with a heartbeat
   keeping long migrations from losing their lock.

## Repository layout

```
src/
├── index.ts          # Public API barrel — the ONLY thing users should import
├── types/index.ts     # All shared types/interfaces (MigronautConfig, MigronautError codes, etc.)
├── errors/index.ts    # MigronautError base + one subclass per error code
├── core/               # The engine (config, lock, changelog, runner, context, import, migrator, run)
├── utils/              # logger, checksum, loader, template, date — pure-ish helpers
└── cli/                # commander root + one file per command, thin wrappers over MigratorKit
bin/migronaut.ts        # CLI shebang entry
tests/
├── unit/               # mocked DB, pure logic
└── integration/        # real in-memory MongoDB via mongodb-memory-server (replica set)
docs/                   # VitePress user-facing site — never published to npm
blog/                   # Long-form posts, also docs-only
migrations/             # Example/dev migration files used while developing this repo itself
```

**Layering rule:** Presentation (`cli/`, `bin/`) never touches the DB or contains migration
logic. Orchestration (`core/migrator.ts`, `core/run.ts`) sequences steps and owns the
connection lifecycle. Mechanism modules (`core/{lock,changelog,runner,context,import,config}.ts`,
`utils/`) do one job each and know nothing about the CLI — no `console.*`, no `ora`, no `chalk`.
The CLI injects a `ProgressReporter` callback into core instead.

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
npm run typecheck      # tsc --noEmit
npm run lint            # oxlint src bin tests
npm run format           # oxfmt src bin tests
npm run format:check      # oxfmt --check src bin tests
npm test                  # vitest run (unit + integration, ~250 tests)
npx vitest run tests/integration/up.test.ts   # single file
npm run build              # tsup → dist/ (library CJS+ESM+d.ts, CLI CJS-only)
npm run docs:dev            # vitepress dev docs
```

`prepublishOnly` runs typecheck + lint + format:check + test + build — treat that as the pre-merge gate.

## Conventions (enforced by oxlint/oxfmt + review)

- Strict TypeScript, no `any` (use `unknown` + narrowing), explicit return types on public
  functions, `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` on.
- Never `throw new Error` — always a `MigronautError` subclass with a typed `code`.
- Never `console.*` — always the injected `MigronautLogger` (`null` = silent, used in tests).
- Named exports only; config files (`migronaut.config.ts`) are the sole default-export exception.
- Internal imports use `.js` specifiers (NodeNext) even though sources are `.ts`.
- Single quotes, semicolons, 100-col lines, no unused vars/imports (oxlint/oxfmt-enforced). `no
  any`, `no console.*`, and consistent `import type` usage are review-only conventions — not
  currently lint-enforced (the `.oxlintrc.json` `typescript` plugin isn't enabled).
- Anything user-facing must be re-exported from `src/index.ts`, or it's private.
- Conventional Commits (`feat(scope):`, `fix(scope):`, `test:`, …).

## Testing notes

- Two tiers: `tests/unit/` (mocked DB) and `tests/integration/` (real `mongodb-memory-server`
  replica set, so transactions work).
- Silence the logger (`logger: null`) in tests. No committed `.only`/`.skip`.
- Coverage gate: 90% lines / 90% functions / 85% branches (`npm run coverage`).
- Running the full integration suite *with* coverage can be memory-heavy — scope `--coverage`
  to specific files when checking one module.

## Things that look like bugs but aren't

See ARCHITECTURE.md §8 for the full list — highlights: `markApplied` upserts (needed for
`redo`/`force`/`import`); `markReverted` never deletes (audit trail); migrate-mongo imports are
forward-only and rejected by `down`/`redo`; `--json` on `init` means "generate
`migronaut.config.json`", not "emit JSON output". Don't "fix" these without checking the doc
first.
