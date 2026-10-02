const { context, propagation, trace } = require('@opentelemetry/api');
const { MeterProvider, MetricReader } = require('@opentelemetry/sdk-metrics');
const {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} = require('@opentelemetry/sdk-trace-node');

/** A reader that only collects on demand — no timers, nothing to flush */
class OnDemandReader extends MetricReader {
  onForceFlush() {
    return Promise.resolve();
  }

  onShutdown() {
    return Promise.resolve();
  }
}

/**
 * A real OpenTelemetry tracing SDK that keeps finished spans in memory.
 *
 * `register()` installs the global context manager, and that is the point:
 * without one, `startActiveSpan` cannot make anything active and no span ever
 * gets a parent. Globals are per process and `node:test` runs each file in its
 * own, so registering here cannot leak into another test file — call `stop()`
 * in `after` all the same.
 */
function startTracing() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return {
    provider,
    tracer: provider.getTracer('migronaut-test'),
    /** Finished spans, in the order they ended */
    spans: () => exporter.getFinishedSpans(),
    named: (name) => exporter.getFinishedSpans().filter((span) => span.name === name),
    reset: () => exporter.reset(),
    async stop() {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

/** Span id of a finished span's parent, or undefined for a root span */
const parentIdOf = (span) => span.parentSpanContext?.spanId;

/**
 * A real meter with a fresh provider, so one test's data points never show up
 * in another's. `collect()` resolves `{ [instrument name]: dataPoints[] }`.
 */
function startMetrics() {
  const reader = new OnDemandReader();
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter('migronaut-test'),
    async collect() {
      const { resourceMetrics } = await reader.collect();
      const byName = {};
      for (const scope of resourceMetrics.scopeMetrics) {
        for (const metric of scope.metrics) {
          byName[metric.descriptor.name] = metric.dataPoints;
        }
      }
      return byName;
    },
    stop: () => provider.shutdown(),
  };
}

module.exports = { parentIdOf, startMetrics, startTracing };
