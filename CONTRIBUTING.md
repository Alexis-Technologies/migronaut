# Contributing

Thanks for helping improve migronaut. This page covers the rules that are easy
to break by accident; [ARCHITECTURE.md](ARCHITECTURE.md) explains how the
codebase fits together and why.

## Getting set up

```bash
pnpm install
pnpm test          # unit + integration
node bin/migronaut.js --help
```

There is no build step, ever. What you edit in `src/` and `bin/` is what ships.

## The four rules that are not negotiable

**1. No runtime dependencies.** `package.json` has no `dependencies` key, and it
stays that way. `.env` parsing, colors, the spinner, the argument parser, the
table renderer and config validation are all hand-rolled in `src/utils` and
`src/cli` for exactly this reason. Third-party integrations are *injected* by
the user instead — a pino instance passes straight into `config.logger`.
devDependencies are fine.

**2. Plain CommonJS in `src/` and `bin/`.** `require`/`module.exports`, no
`import`/`export`, no TypeScript syntax. JSDoc is documentation for the reader,
not a type-checked contract. (User *migration* files are unrestricted — they may
be `.ts`, ESM or CJS.)

**3. A public API change touches two files together.** `src/index.js` (the
runtime export) and `index.d.ts` (the hand-written types) are maintained in
lockstep — neither is generated from the other. Add a `tests/types` assertion
for anything new. `pnpm run check:dts` compiles the declaration file on its own.

**4. Never `throw new Error`, never `console.*` in core.** Every failure is a
`MigronautError` subclass with a typed `code` (see `src/errors/index.js`), so
callers can branch on it and the CLI can map it to an exit code. All output goes
through the injected logger; `null` silences it, which is what tests use.
Presentation (`src/cli`, `bin`) never touches the database, and core never
imports the spinner or the table renderer.

## Tests

Node's built-in `node:test` — no external framework.

- `tests/unit/` — mocked database, plain stubs. Fast, runs everywhere.
- `tests/integration/` — a real `mongodb-memory-server` replica set, so
  transactions are genuinely exercised. Run serially (`--test-concurrency=1`):
  each file boots its own replica set, and running them at once collides on
  ports and starves the timing-sensitive lock tests.
- `tests/types/` — `tsd` assertions against `index.d.ts`.

The integration suite goes through [scripts/node-test.js](scripts/node-test.js)
rather than calling `node --test` directly. It feature-detects
`--test-global-setup`, which only exists on Node >= 24: where present, one
replica set is shared by the whole run; on Node 22 (the `engines` floor) each
file boots its own. Identical results, about a minute slower — so run the suite
on **both** 22 and 24 before assuming a failure is real. A test whose awaited
promise can only settle from an `unref()`ed timer passes on 24 and is cancelled
on 22; see [tests/helpers/event-loop.js](tests/helpers/event-loop.js).

Use `before`/`after`, not `beforeAll`/`afterAll` (those are Jest/Vitest names).
Silence the logger with `logger: null`. No committed `.only` or `.skip`.

Three environment variables control the test run:

| Env var | Effect |
|---|---|
| `MIGRONAUT_TEST_MONGO_URI` | Set by `tests/helpers/global-setup.js` so every integration file shares one replica set. Export it yourself to run against an existing MongoDB instead of booting one. |
| `MONGOMS_VERSION` | `mongodb-memory-server`'s own variable — which server version to download. CI pins `7.0.14`; an explicit value always wins. |
| `MONGOMS_DOWNLOAD_DIR` | `mongodb-memory-server`'s binary cache directory. CI points it at a cached path. |

The two `MONGOMS_*` names belong to `mongodb-memory-server`, so they keep their
prefix. Everything migronaut itself reads is `MIGRONAUT_*` — including
`MIGRONAUT_NO_COLOR` / `MIGRONAUT_FORCE_COLOR` and `MIGRONAUT_USER`, which sit
above the ecosystem-standard `NO_COLOR` / `FORCE_COLOR` / `TERM` and `USER`.

When you add a config option, add its variable to the `ENV_KEYS` table in
[src/core/config.js](src/core/config.js) too — a unit test pins that table
against `CONFIG_KEYS` and will fail if a scalar option has no way to be set from
the environment.

New behavior needs a test that fails without the change. For a bug fix, the test
should describe the bug, not the implementation.

## Before opening a PR

```bash
pnpm run lint
pnpm run format
pnpm test
pnpm run test:types
pnpm run check:dts
```

`pnpm run test:coverage` enforces 90% lines / branches / functions, and
`prepublishOnly` runs the whole set — treat that as the merge gate.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat(scope):`, `fix(scope):`, `test:`, `docs:`).

## Things that look like bugs but are not

Before "fixing" one of these, read [ARCHITECTURE.md §8](ARCHITECTURE.md):
`markApplied` upserts rather than inserts; `markReverted` never deletes;
migrate-mongo imports are forward-only and refused by `down`/`redo`; `--json` on
`init` selects the config *format* rather than machine output.
