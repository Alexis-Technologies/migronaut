# tests

Node's own `node:test`, two tiers: `unit/` (a mocked database, plain `mock.fn` stubs — no module
mocking anywhere) and `integration/` (a real `mongodb-memory-server` replica set, so transactions
work), plus `types/` (tsd) and `helpers/`.

## Shape

- `describe` and `it` from `node:test`, every `it` title starting with `should`, assertions from
  `node:assert/strict`. A method a group of tests is about is a `describe` of its own
  (`describe('markApplied')`), and so is a tag (`[probe]`, `[fidelity]`, `[fake]`,
  `[background]`), never a prefix of the title. `before`/`after`, not `beforeAll`/`afterAll`.
- Silence the logger (`logger: null`). Every `let` starts with a value of its kind (`null` for a
  promise or an object); a caught error is `error`.
- An error is asserted by its code (`{ code: 'ALX_ERR_…' }`, with `message` where the text is the
  contract); a bare regex only for an error of a test double or the driver, which has none.
- No committed `.only`/`.skip`, but six environment-capability skips with a reason:
  `bullmq-redis.test.js` without `MIGRONAUT_TEST_REDIS_URL` (CI sets it), `search-atlas.test.js`
  without `MIGRONAUT_TEST_ATLAS_URI`, `sharded.test.js` without `MIGRONAUT_TEST_SHARDED_URI` (CI
  sets neither: run them by hand, `pnpm run test:optin`), the symlink case of `sequence.test.js`
  where the OS will not create one, the second spelling of a path in `loader.test.js` on a
  case-sensitive file system, and the FIFO case of `file.test.js` on Windows.

## Time

- Unit tests do not wait on the clock: a heartbeat, a deadline or a timeout is driven by
  `t.mock.timers` and `settleWithTimers` (`helpers/event-loop.js`), which ticks the mocked time and
  flushes the loop between ticks. A `sleep` such a test mocks is read at call time
  (`timersPromises.setTimeout`), never destructured at load — a destructured one is the real timer.
- Integration tests poll through the one `waitFor` (`helpers/wait-for.js`), whose timeout names
  what it waited for and, given `explain`, where it was stuck. The lock-heartbeat integration tests
  use real timers; the full suite run in parallel can make them flaky under heavy CPU contention.
- An integration test that expects a rejection disconnects its kit in a `finally`: an assertion
  that fails inside `assert.rejects` otherwise leaves the client open, and the file hangs instead
  of failing.

## The queue adapter

- Tested against `helpers/fake-bullmq.js`, an in-memory double — that is where its coverage comes
  from, so the gate needs no Redis. The scenarios live once, in `helpers/bullmq-scenarios.js`, and
  run against the fake and (in the opt-in file) the real `bullmq`: add adapter behaviour there. If
  the two disagree, the fake is what is wrong.
- Every scenario waits for everything it enqueued (`settled`, `untilRecord`, a group's `wait()`)
  before it ends: `afterEach` force-closes, which does not wait for a migration in flight, and a
  straggler writes into the next scenario's database.
- The background queue builds on BullMQ semantics the fake models and `helpers/bullmq-fidelity.js`
  pins against both (delays, parents and children). Background scenarios wait until MongoDB says
  what they expect _and_ the background queue holds nothing waiting, active, delayed or waiting
  for children.

## Background migrations, telemetry, types

- Background integration tests use a child process for `kill -9` (`helpers/background-child.js`)
  and the server's `failCommand` fail point (the memory server starts with `enableTestCommands`).
- Telemetry runs against the real OpenTelemetry SDK with in-memory exporters (`helpers/otel.js`).
  `startTracing()` registers the global context manager — safe only because `node:test` runs one
  process per file; stop it in `after`. `integration/telemetry-mongodb.test.js` loads the driver
  instrumentation before anything requires `mongodb`. The cross-process trace is BullMQ's doing,
  asserted only in the opt-in Redis file.
- `types/*.test-d.ts` cover the public surface; update them with a `.d.ts`. `bullmq.test-d.ts`
  checks the real BullMQ classes against the structural `BullMQ*Like` types and
  `index.test-d.ts` the real `@opentelemetry/api` against `MigronautTracer` / `MigronautMeter`,
  part by part — a whole-tracer assignability check passes for almost any shape.
- `integration/runtime-ts.test.js` and `esm-interop.test.js` are what the engines floor is for: CI
  runs them on 22.18.0 as well.

## Gates

- Coverage: 90 % lines, functions, branches and statements over `src/` and `bin/`
  (`pnpm run test:coverage`).
- `unit/package-surface.test.js` holds the barrels to their `.d.ts`, the error classes to the code
  union, `EXIT_CODES` and the two docs tables, the version in its four places, and the greps
  (`require('bullmq')`, `@opentelemetry/*`, `mongoose`, `randomUUID`, `throw new Error`,
  `console.*`, `.find(`/`.filter(` with a function, array destructuring).
