const { MigronautError } = require('../errors/index.js');
const { errorText } = require('./error.js');

/**
 * OpenTelemetry's `SpanStatusCode.ERROR`. Spelled as a number because the enum
 * lives in `@opentelemetry/api`, which migronaut never imports — the tracer and
 * the meter are injected, the same way a logger is.
 */
const SPAN_STATUS_ERROR = 2;

/** Span names — static on purpose: the migration's own name is an attribute */
const SPANS = {
  RUN: 'migronaut.run',
  MIGRATION: 'migronaut.migration',
};

/** Every attribute key migronaut sets, on spans and on metric points */
const ATTRIBUTES = {
  RUN_ID: 'migronaut.run.id',
  RUN_COMMAND: 'migronaut.run.command',
  RUN_DIRECTION: 'migronaut.run.direction',
  RUN_APPLIED: 'migronaut.run.applied',
  RUN_REVERTED: 'migronaut.run.reverted',
  RUN_SKIPPED: 'migronaut.run.skipped',
  RUN_TOTAL: 'migronaut.run.total',
  LOCK_ACQUIRE_MS: 'migronaut.lock.acquire_ms',
  LOCK_SKIPPED: 'migronaut.lock.skipped',
  LOCK_LOST_REASON: 'migronaut.lock.lost_reason',
  MIGRATION_NAME: 'migronaut.migration.name',
  MIGRATION_DIRECTION: 'migronaut.migration.direction',
  MIGRATION_BATCH: 'migronaut.migration.batch',
  MIGRATION_INDEX: 'migronaut.migration.index',
  MIGRATION_TOTAL: 'migronaut.migration.total',
  MIGRATION_TRANSACTION: 'migronaut.migration.transaction',
  ERROR_TYPE: 'error.type',
};

const METRICS = {
  RUN_DURATION: 'migronaut.run.duration',
  MIGRATION_DURATION: 'migronaut.migration.duration',
  LOCK_ACQUIRE_DURATION: 'migronaut.lock.acquire.duration',
  LOCK_REFUSED: 'migronaut.lock.refused',
  LOCK_LOST: 'migronaut.lock.lost',
};

/**
 * Histogram bucket boundaries, in seconds. An SDK's default boundaries are
 * sized for milliseconds (0…10000), which would put every migration shorter
 * than five seconds into one bucket; these span 10ms to an hour.
 */
const DURATION_BUCKETS_SECONDS = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 3600];

/**
 * Mark a promise an SDK handed back as handled. A tracer that wraps the work
 * (`return fn(span).finally(…)`) or an instrument that is async returns a
 * promise nobody here awaits — and when it rejects, an unhandled rejection
 * ends the process. The caller's own handlers are unaffected.
 */
function quiet(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    try {
      if (typeof value.then === 'function') value.then(undefined, () => {});
    } catch {
      // A `then` getter that throws is one more SDK fault to ignore.
    }
  }
  return value;
}

/**
 * The one guard every tracer, span and instrument call goes through: telemetry
 * must never break a migration run, so a throwing SDK is swallowed here — and
 * a rejecting one too, see {@link quiet}.
 */
function safe(call) {
  try {
    return quiet(call());
  } catch {
    return undefined;
  }
}

/** `attributes` without its undefined values — an SDK warns about (or rejects) those */
function defined(attributes) {
  const result = {};
  if (!attributes) return result;
  for (const key of Object.keys(attributes)) {
    if (attributes[key] !== undefined) result[key] = attributes[key];
  }
  return result;
}

/**
 * The low-cardinality failure class OpenTelemetry's `error.type` asks for: the
 * typed migronaut code when there is one, the error's class name otherwise.
 */
function errorType(error) {
  // Never throws: it runs on the way out of a failed run, where a hostile
  // `name` getter would otherwise replace the run's own error.
  try {
    if (error instanceof MigronautError) return error.code;
    if (typeof error?.name === 'string' && error.name.length > 0) return error.name;
  } catch {
    // fall through
  }
  return '_OTHER';
}

/**
 * The status message for a failed span. Redacted like every string that leaves
 * the process — a raw driver message can echo the credentialed URI — and joined
 * with the wrapped cause, since "Migration up failed: X" alone says which
 * migration and not why.
 */
function failureText(error) {
  const message = errorText(error);
  const cause =
    error instanceof MigronautError && typeof error.context?.cause === 'string'
      ? errorText(error.context.cause)
      : undefined;
  return cause ? `${message} — ${cause}` : message;
}

/** What the kit holds when there is no tracer: the same surface, doing nothing */
const NOOP_SPAN = { set() {}, finish() {} };

/** Wrap an SDK span so no call on it can throw into the run, and it ends once */
function guardSpan(span) {
  let ended = false;
  const set = (attributes) => {
    const values = defined(attributes);
    for (const key of Object.keys(values)) {
      safe(() => span.setAttribute(key, values[key]));
    }
  };
  return {
    set,
    /**
     * End the span. A failure sets the ERROR status and `error.type`; a
     * success leaves the status unset, as the specification asks of
     * instrumentation libraries (OK is the application's to claim).
     */
    finish(attributes, error) {
      if (ended) return;
      ended = true;
      set(attributes);
      if (error !== undefined) {
        safe(() => span.setStatus({ code: SPAN_STATUS_ERROR, message: failureText(error) }));
        safe(() => span.setAttribute(ATTRIBUTES.ERROR_TYPE, errorType(error)));
      }
      safe(() => span.end());
    },
  };
}

/**
 * Turn the `telemetry` config option into what the kit reports through. With
 * no tracer and no meter every method is a no-op that costs a function call.
 *
 * Both parts are the caller's own OpenTelemetry objects
 * (`trace.getTracer(…)`, `metrics.getMeter(…)`): migronaut asks them for a
 * span or an instrument and never looks at the SDK behind them.
 */
function createTelemetry(telemetry) {
  const tracer = telemetry?.tracer ?? undefined;
  const meter = telemetry?.meter ?? undefined;

  /**
   * Run `fn(span)` with a new span as the active one, and leave ending it to
   * the caller — the run span outlives the unit of work it is active around.
   *
   * `fn` runs exactly once whatever the tracer does: a tracer that throws
   * before calling back still gets the work done (with a no-op span), one that
   * throws afterwards cannot turn a finished run into a failed one, and one
   * that calls back twice cannot run a migration twice. The result is taken
   * from `fn` itself rather than from what the tracer returns.
   */
  function open(name, attributes, fn) {
    if (!tracer) return fn(NOOP_SPAN);
    let called = false;
    let threw = false;
    let result;
    const run = (span) => {
      if (called) return result;
      called = true;
      try {
        result = fn(span);
      } catch (error) {
        threw = true;
        result = error;
        throw error;
      }
      return result;
    };
    // Three arguments, always: an SDK picks the overload by argument count.
    safe(() =>
      tracer.startActiveSpan(name, { attributes: defined(attributes) }, (span) =>
        run(guardSpan(span)),
      ),
    );
    // Through `run`, not `fn`: it marks the work as done, so a tracer that
    // calls back late finds nothing left to run.
    if (!called) return run(NOOP_SPAN);
    if (threw) throw result;
    return result;
  }

  /** `open`, plus ending the span when `fn` settles — failed when it rejects */
  function wrap(name, attributes, fn) {
    if (!tracer) return fn(NOOP_SPAN);
    return open(name, attributes, async (span) => {
      try {
        const value = await fn(span);
        span.finish();
        return value;
      } catch (error) {
        span.finish(undefined, error);
        throw error;
      }
    });
  }

  const histogram = (name, description) =>
    meter
      ? safe(() =>
          meter.createHistogram(name, {
            description,
            unit: 's',
            advice: { explicitBucketBoundaries: DURATION_BUCKETS_SECONDS },
          }),
        )
      : undefined;
  const counter = (name, description) =>
    meter ? safe(() => meter.createCounter(name, { description })) : undefined;

  const runDuration = histogram(METRICS.RUN_DURATION, 'Duration of a migration run');
  const migrationDuration = histogram(METRICS.MIGRATION_DURATION, 'Duration of one migration');
  const lockAcquireDuration = histogram(
    METRICS.LOCK_ACQUIRE_DURATION,
    'Time taken to acquire the migration lock',
  );
  const lockRefused = counter(
    METRICS.LOCK_REFUSED,
    'Runs refused because the migration lock was held',
  );
  const lockLost = counter(METRICS.LOCK_LOST, 'Migration locks lost mid-run');

  // Durations are measured in milliseconds everywhere in migronaut and
  // reported in seconds, the unit OpenTelemetry's conventions settle on.
  const record = (instrument, durationMs, attributes) => {
    if (instrument) safe(() => instrument.record(durationMs / 1000, defined(attributes)));
  };
  const increment = (instrument) => {
    if (instrument) safe(() => instrument.add(1));
  };
  const failure = (error) =>
    error !== undefined ? { [ATTRIBUTES.ERROR_TYPE]: errorType(error) } : {};

  return {
    open,
    wrap,
    runEnded({ command, direction, durationMs, error }) {
      record(runDuration, durationMs, {
        [ATTRIBUTES.RUN_COMMAND]: command,
        [ATTRIBUTES.RUN_DIRECTION]: direction,
        ...failure(error),
      });
    },
    migrationEnded({ direction, durationMs, error }) {
      record(migrationDuration, durationMs, {
        [ATTRIBUTES.MIGRATION_DIRECTION]: direction,
        ...failure(error),
      });
    },
    lockAcquired(acquireMs) {
      record(lockAcquireDuration, acquireMs);
    },
    lockRefused() {
      increment(lockRefused);
    },
    lockLost() {
      increment(lockLost);
    },
  };
}

module.exports = {
  ATTRIBUTES,
  DURATION_BUCKETS_SECONDS,
  METRICS,
  NOOP_SPAN,
  SPANS,
  SPAN_STATUS_ERROR,
  createTelemetry,
  errorType,
  failureText,
};
