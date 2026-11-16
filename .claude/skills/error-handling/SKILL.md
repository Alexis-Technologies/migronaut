---
name: error-handling
description: Apply error handling and recovery patterns in JavaScript/TypeScript or Node.js. Use when implementing error handling, retry logic, or when the user mentions domain errors, error recovery, error escalation.
---

<!-- Adapted from metaskills v1.0.5 (skills/error-handling) for migronaut: the domain error is
     `MigronautError` with a typed `code` (not Metarhia's `DomainError`), nothing logs to the
     console, every message is redacted, and the library never installs process handlers. The
     error model itself is described in ARCHITECTURE.md (§5 `src/errors/index.js`, §7, §8), which
     wins if the two ever disagree. -->

# Error Handling

## Error classification

- Programming errors: bugs (TypeError, ReferenceError, an impossible state). Fix the code; do not
  catch and continue
- Operational errors: expected failures — a held lock, a lost connection, a checksum that no longer
  matches, a server without transactions, a user's migration that throws. Each has a typed `code`;
  recovery is the caller's (the CLI's exit code, the queue's retry policy, the lock-wait loop)
- A bad option or a malformed file is operational too: the user can fix it, and a caller branches
  on it — `ConfigInvalidError` (`CONFIG_INVALID`), `MigrationInvalidNameError`,
  `QueueJobInvalidError` …, never a bare `TypeError`

## The error model

`src/errors/index.js` holds `MigronautError` and exactly one subclass per code:

```javascript
class MigronautError extends Error {
  constructor(code, message, context, options) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MigronautError';
    this.code = code;
    if (context !== undefined) this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}
```

- `code` is the contract: what the CLI prints (`✖ LOCK_ALREADY_HELD: …`), what `--json` emits as
  `error.code`, what `EXIT_CODES` maps and what the queue decides retries by
- `context` is plain, JSON-safe data about the failure (`{ path, migration, phase, cause }`) — it
  survives `--json` and the changelog's failure trace; `context.results` is reserved for the
  migration rows a stopped run already applied
- `cause` is the original error object, so `error.cause.stack` still points into the user's code

Never `throw new Error` (or a literal, or a bare `TypeError`) under `src/` — not lint-enforced,
caught in review.

### Adding an error code

One change, all of it:

1. The subclass in `src/errors/index.js` (and in its `module.exports`)
2. The literal in the `MigronautErrorCode` union and the class declaration in `index.d.ts`
3. The export from `src/index.js`, and a `tsd` assertion in `tests/types/index.test-d.ts`
4. An exit code in `src/cli/exit-codes.js` (the next free number; never renumber one)
5. A row in `docs/reference/error-codes.md` and in the exit-code table of `docs/reference/cli.md`
6. The queue's verdict: `RETRYABLE_CODES` in `src/bullmq/processor.js` lists the codes a retry can
   fix; an unknown code stays retryable, so a code a retry only repeats must not be added there
7. `tests/unit/package-surface.test.js` pins steps 1–4 against each other — run it

A new code in the public union is a contract change: 2.0.0 called it breaking, 2.1–2.4 shipped
new codes in minors. Ask the user which one the release is.

## Wrapping a failure

Wrap at the boundary where the meaning changes, keep the original as `cause` and its redacted
message in `context.cause` (that half is what survives JSON):

```javascript
const fs = require('node:fs/promises');
const { ConfigInvalidError } = require('../errors/index.js');
const { errorText } = require('../utils/error.js');

async function loadDefinitionFile(filepath) {
  const raw = await fs.readFile(filepath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ConfigInvalidError(
      'Collection definition file is not valid JSON',
      { path: filepath, cause: errorText(error) },
      { cause: error },
    );
  }
}
```

- The message says **which** thing failed ("Migration up failed: 20260101-add-index"); the cause
  says **why**
- Do not wrap twice: a `MigronautError` coming up from below keeps its code unless this layer
  genuinely means something else
- A user's migration that throws becomes `MigrationExecutionFailedError` after `onError` ran; a
  throwing `onError` never masks the original failure. When only the changelog write failed (the
  body succeeded), the error carries `context.phase = 'changelog-write'` and `onError` is not fired

## Turning errors into text

Every caught error becomes a string only through `src/utils/error.js`:

- `errorText(error)` — the message with URI credentials masked (the driver echoes the connection
  URI in several errors)
- `errorWithCause(error)` — "what failed — why", both halves redacted: the changelog's failure
  trace and a failed span's status message
- `documentErrorText(error)` — for errors about the application's data (background document
  errors, failed slices): it masks the values a duplicate-key or validation error quotes

Never put a raw `error.message`, `error.stack` or a driver error's `errorResponse` into a log line,
an error context, an event payload or a span. Telemetry records a redacted status message plus
`error.type`, and never calls `recordException` (it would skip redaction).

## Never swallow

- Rethrow, or route to `onError`. A deliberate swallow carries a comment saying why and leaves a
  `logger.debug` line: releasing the lock in `finally` after the run already failed, closing a
  connection on the way out
- Observers never fail the run they observe: `resolveLogger` guards every logger call,
  `telemetry.js` puts every tracer/meter call behind its one `safe()`, and the kit's
  `captureRejections` turns a rejecting `async` listener into a debug line. A hook
  (`beforeAll`, `beforeEach`, `afterEach`, `afterAll`) may fail the run, as `HookFailedError`
- Never `console.*` — the injected `MigronautLogger`; `logger: null` in tests

## Retry and recovery

Most retrying already exists — reuse it rather than wrapping a migration in a loop:

- **Transactions**: `runner.js` runs a migration in `session.withTransaction()`, which retries
  `TransientTransactionError` and `UnknownTransactionCommitResult`; each attempt gets a fresh
  context (`ctx.run.attempt`), and the result carries `attempts`
- **The lock**: `core/lock-wait.js` polls a held lock with a jittered, capped interval inside a
  time budget; refusals are counted in `migronaut.lock.refused`, and a run that never got the lock
  emits no span. A heartbeat that cannot renew stops the run with `LockLostError`
- **The queue**: migration jobs are `attempts: 1` (a BullMQ retry would reorder the line);
  `RETRYABLE_CODES` decides the rest, and a non-retryable error is renamed `UnrecoverableError`
  only when a job has `attempts > 1`. A background lane retries a failed slice with exponential
  backoff up to `maxLaneRetries`
- **Background migrations**: `maxSliceFailures` counts failed slices in a row (a checkpoint resets
  it); `maxDocumentErrors` is capped at the 1000 bad ids a state keeps
- **Search index builds**: the wait rides out up to three network or failover blips in a row

When a new loop is truly needed: bounded attempts, jittered exponential backoff, retry only codes
known to be transient, stop as soon as the kit is stopped, and never repeat a non-idempotent write
without a guard (an upsert, a revision check):

```javascript
const { setTimeout: delay } = require('node:timers/promises');
const { errorText } = require('../utils/error.js');

const TRANSIENT_CODES = new Set(['CONNECTION_FAILED', 'LOCK_ALREADY_HELD']);
const JITTER_RATIO = 0.25;

async function withRetry(operation, { attempts, baseDelayMs, isStopped, logger }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const isLast = attempt >= attempts || isStopped();
      if (isLast || !TRANSIENT_CODES.has(error?.code)) throw error;
      const jitter = 1 - JITTER_RATIO + Math.random() * 2 * JITTER_RATIO;
      const delayMs = baseDelayMs * 2 ** (attempt - 1) * jitter;
      logger.debug(`Retrying after ${errorText(error)} (attempt ${attempt} of ${attempts})`);
      await delay(delayMs);
    }
  }
}
```

## Shutdown and the process

- The library never installs `process.on(...)` handlers and never calls `process.exit()`: an
  application embedding migronaut owns `uncaughtException`, `unhandledRejection` and its signals
- Stopping a run is `kit.stop(reason)`: the migration in flight finishes, the rest are skipped, the
  lock is released, and the run rejects with `RunAbortedError` (`context.results` lists what was
  applied)
- The CLI's `attachSignalHandlers` (`src/cli/shared.js`) turns the first SIGINT/SIGTERM into
  `kit.stop()`; a second one exits at once with 130/143. On the graceful path the CLI sets
  `process.exitCode` from `EXIT_CODES[error.code] ?? 1` and lets the process drain — `process.exit()`
  would truncate piped output
- A queue service shuts down by closing its workers, which wait for the job in flight; a lane
  stopped by its caller is `stopped`, never a failed slice

## Conventions

- Distinguish programmer vs operational errors; only recover from operational ones
- Every throw is a `MigronautError` subclass with a typed `code`, the original as `cause` and its
  redacted text in `context.cause`
- Never swallow an error silently; say why in a comment and leave a debug line
- Text from an error goes through `errorText` / `errorWithCause` / `documentErrorText`
- Logging, telemetry and listeners never break a run; hooks may
- Reuse the existing retry points; a new one is bounded, jittered, code-aware and stoppable
