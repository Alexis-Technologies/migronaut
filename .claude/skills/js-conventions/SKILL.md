---
name: js-conventions
description: Apply the Alexis JavaScript style (Metarhia-derived, linted by oxlint and formatted by oxfmt). Use when writing or editing .js, .mjs, .ts files (with certain corrections for typescript), formatting code, or when the user asks about code style or linting.
---

<!-- Adapted from metaskills v1.0.5 (skills/js-conventions) for the Alexis toolchain and for
     migronaut: oxlint + oxfmt instead of ESLint + Prettier, pnpm instead of npm, 100 columns
     instead of 80, no 'use strict' (no file under src/ or bin/ carries one), module-level
     `function` declarations, array methods allowed but one walk per collection, and comments that
     explain why. The migronaut-specific rules (layering, injected integrations, the error model,
     the hand-written types, zero dependencies) live in CLAUDE.md and ARCHITECTURE.md, which win if
     the two ever disagree. -->

# JavaScript Code Style

Use following conventions for JavaScript and TypeScript code.

## Preparations

- Linting is oxlint (`.oxlintrc.json`) and formatting is oxfmt (`.oxfmtrc.json`, `.editorconfig`);
  never add ESLint or Prettier
- The package manager is pnpm (pinned in `packageManager`); the scripts are in package.json:
  - `pnpm run lint`: oxlint over `src bin scripts tests bench examples`
  - `pnpm run format`: oxfmt rewrites those files in place
  - `pnpm run format:check`: oxfmt check only, as CI and `prepublishOnly` run it
- The three root shims (`index.js`, `bullmq.js`, `versioning.js`) and the root `.d.ts` files are
  outside both globs — keep them in the house style by hand
- Before and after code analysis with AI run `pnpm run lint` and `pnpm run test:unit` (the
  integration tier needs no setup either — `mongodb-memory-server` — but takes minutes)
- Use `pnpm run format` to fix formatting; fix lint errors in the code, and suppress a rule only
  for an intentional construct with a targeted `// oxlint-disable-next-line <rule>`
- Two of the hardest rules are **not** lint-enforced — no `console.*` and no `throw new Error` in
  `src/`/`bin/` — catch them yourself (ARCHITECTURE §7)

## Formatting

- Use single quotes and semicolons
- Keep max line length 100 (ignore URLs; Markdown is exempt)
- Use trailing commas in multiline arrays, objects, and params
- Keep one empty line between semantic blocks
- Follow oxfmt and `.editorconfig` for spacing, braces, and indentation (2 spaces, LF, final
  newline); `curly` is `multi-line`, so a one-line `if (x) return y;` needs no braces

## Modules

- Use CommonJS: `require` and `module.exports = { … }` (named exports), no `import`/`export` in
  `src/`/`bin/`; there is no build step, `src/` and `bin/` are what gets published
- Do not add `'use strict'` — no file in `src/` or `bin/` has one, and one file alone would be noise
- Use the `node:` prefix for Node.js built-in modules (`require('node:fs/promises')`)
- Always include the `.js` extension in relative requires (`require('../utils/error.js')`)
- Zero runtime dependencies: a bare `require` in `src/` is a `node:` built-in, with two exceptions
  that are peers — `require('mongodb')` only in `core/migrator.js` and `core/bson-peer.js` (lazily);
  never `mongoose`, `bullmq`, `ioredis`, `@opentelemetry/*` or `bullmq-otel` (unit tests grep for
  them). An integration is injected by the caller instead, and typed structurally
- Respect the layering: `cli/`/`bin/` never touch the database; mechanism modules (`core/lock.js`,
  `changelog.js`, `runner.js`, `utils/` …) never log to the console, spin or render; `bullmq/` uses
  the public kit and never a mechanism module; `src/versioning/` requires nothing outside itself
  and `src/errors/`
- A public export lands in its entry's barrel and its hand-written `.d.ts` in the same change
  (`src/index.js` + `index.d.ts`, `src/bullmq/index.js` + `bullmq.d.ts`,
  `src/versioning/index.js` + `versioning.d.ts`), with a `tsd` assertion in `tests/types/`

## Naming

- Use `camelCase` for variables and parameters
- Use `UpperCamelCase` for classes and types
- Use `UPPER_SNAKE_CASE` for constants (`DEFAULT_LOCK_POLL_INTERVAL_MS`, `RETRYABLE_CODES`)
- Use `new` with capitalized constructor names
- Use `error` in catch blocks, not `err`
- Use short names (`e`, `i`) only in short one-line callbacks
- Use descriptive names in multiline callbacks (`event`, `index`, `item`)
- Use boolean prefixes: `is`, `has`, `can`, `should`
- Use singular names for entities and plural names for collections
- Use verb names for functions and handlers (`parse`, `create`, `handle`, `on`)
- Include units in numeric names (`timeoutMs`, `sizeBytes`) except options; a public option with a
  unit says it too (`searchIndexWaitTimeoutMs`)
- Error classes end in `Error` and their `code` is the same name in `UPPER_SNAKE_CASE`
  (`LockAlreadyHeldError` / `LOCK_ALREADY_HELD`)
- Before naming something new, check the list of names already taken in CLAUDE.md ("Things that
  look like bugs but aren't", last paragraph) — `sync`, `background`, `userland`, `ctx.run`, …

## Best practices

- Prefer `const`, minimize `let`, never use `var`
- A named module-level function is a `function` declaration with a JSDoc comment; an arrow is for
  callbacks and short one-line helpers (`const errorText = (error) => …`); classes use methods
- Do not mutate input parameters; avoid `arguments`
- Keep functions small and single-purpose
- Decompose long expressions into intermediate variables
- One walk does all the work it can: array methods are allowed in `src/` (no lint ban here), but
  never `filter(...).map(...)` or `map` then `some` over the same data, never a count pass then a
  build pass, never the same `Object.keys(o)` twice, and never `find`/`includes`/`indexOf` inside a
  loop — build a `Set` or `Map` once, before it. A single `.map(...).join(...)` that only formats
  an error or log message on a cold path is fine
- Hoist constant arrays, Sets and RegExps to module scope (`Object.freeze` them)
- Never spread an unbounded data array into arguments — `out.push(...docs)`,
  `Math.max(...values)`, `fn(...array)`: past ~130 000 elements it throws `RangeError`
- A new array is built packed: `[]` and `push`, never `new Array(n)` filled by index
- Use `===` and `!==`; the one loose comparison is `value == null` for "null or undefined"
  (`eqeqeq` ignores `null`)
- Keep return types consistent
- Avoid nested ternaries and deep callback nesting
- Self-documented and self-descriptive code; a comment explains why (an invariant, a trap, a
  decision), never what the next line does; JSDoc on public methods is expected, but it is
  documentation only — nothing type-checks it
- Never `throw new Error`: every throw is a `MigronautError` subclass with a typed `code`
  (`src/errors/index.js`), the original as `{ cause }` and its redacted message in
  `context.cause` — see the error-handling skill. (The `throw new Error` lines in
  `src/utils/template.js` are text of the user's scaffold, not migronaut code; `cli/args.js`
  throws a `TypeError` for a malformed flag definition, a bug in migronaut's own command table)
- Never `console.*`: log through the injected `MigronautLogger` (`null` = silent, as in every
  test); turn a caught error into text only through `errorText` / `errorWithCause` /
  `documentErrorText` (`src/utils/error.js`) — they mask credentials and document values
- Logging, telemetry and event listeners never fail the run they observe (`resolveLogger` guards
  each call, `telemetry.js` has its one `safe()`, the kit's `captureRejections` turns a rejecting
  listener into a debug line); a hook (`beforeEach`, `onError`, …) may fail it
- Only `src/utils/id.js` mints an id (no `randomUUID` anywhere else), and only
  `src/utils/telemetry.js` calls a tracer, span or instrument
- A new scalar config key gets its `CONFIG_KEYS` entry, its `ENV_KEYS` entry, a line in
  `migronaut.schema.json` (and its byte-identical copy in `docs/public/`) and the README's env
  table — unit tests pin each pairing
- Conventional Commits (`feat(scope):`, `fix(scope):`, `test:`, `docs:`, `perf:` …)

## TypeScript

- `src/` has no TypeScript; the type surface is the three hand-written declaration files, checked
  by `tsd` (`pnpm run test:types`, `tests/types/*.test-d.ts`) and `tsc --strict` over the three
  together (`pnpm run check:dts`)
- No `.d.ts` imports an optional package (`mongoose`, `bullmq`, `@opentelemetry/*`): describe it
  structurally, as `MongooseLike`, `BullMQQueueLike` and `MigronautTracer` do
- The subpaths import root types from `./index.js`; the root never imports from a subpath
- `versioning.d.ts` may use TypeScript 5.0 features (`const` type parameters); `index.d.ts` and
  `bullmq.d.ts` stay within 4.8
- Migration and config files the user writes may be `.ts`: migronaut loads them with the running
  Node's type stripping, so the scaffolds (`src/utils/template.js`) contain only erasable syntax —
  no `enum`, no `namespace`, no parameter properties

## Optimizations

- Keep object shapes stable: same keys, types, and key order
- Change shape only in constructors and creational patterns; avoid mix-ins
- Use shape mutations only for metaprogramming
- Use `null` for empty reference types; use `undefined` for empty primitives
- Avoid array destructuring in assignments and loops; object destructuring is ok
- Keep hot functions monomorphic: stable arg count, types, and return types
- Avoid reading the same property from many unrelated object shapes
- Prefer string or number literals for status/codes; avoid mixing primitives with objects in one variable
- Keep objects that share a property to the same shape; avoid polymorphic hotspots
- Prefer fixed property access (`obj.x`) over dynamic keys (`obj[key]`)
- Keep arrays dense, avoid holes and mixed element kinds
- Initialize object fields in constructor/factory once and in one order
- Set field to `null` or `undefined`; avoid `delete`
- Move reusable callbacks outside loops
- Keep `try/catch`, spread/rest away from hot loops
- Use `Map` for dynamic key dictionaries, plain objects for fixed schemas
- Use `Set` for big and dynamic collections, prefer arrays for short and stable
- Use `Object.create(null)` for pure dictionaries (user-supplied keys: field names, index keys)
- Use typed arrays for numeric and binary workloads
- Reduce GC pressure: reuse arrays, objects, and buffers when safe
- Migronaut is I/O-bound; its hot paths are the ones the benchmark measures (`computeChecksum`,
  `loadMigrationFile`, `Changelog`, `MigrationLock`, `MigratorKit.up()` over many pending files),
  the converge comparison (`canonical.js`, the index and search-index diffs — it runs on plan,
  replan, verify and every settle read) and a background migration's per-document loop. There:
  one pass per collection, no closure or `RegExp` created per call, and `try/catch` only around
  user code and I/O
- Run `pnpm run bench` before and after touching a benchmarked path; a number moved is a finding,
  and the README's Benchmarks table is refreshed from it before a release
