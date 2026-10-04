// OpenTelemetry for the example — off unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
//
// server.js requires this file FIRST, before `node:http` and before anything
// that loads the MongoDB driver: the HTTP and MongoDB instrumentations patch
// those modules as they are loaded, so an SDK started later would trace
// nothing. (`node --require ./tracing.js server.js` is the same idea, for an
// app whose entry point you would rather not touch.)
//
// Nothing here is migronaut's: it is the application's own OpenTelemetry
// setup. migronaut only ever sees the tracer and the meter mq.js hands it.

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

/** Flush and stop the SDK — called from the shutdown path, before the process exits */
let shutdownTracing = async () => {};

if (endpoint) {
  // Required lazily, so the example runs without tracing — and without these
  // packages being loaded — when no endpoint is configured.
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { MongoDBInstrumentation } = require('@opentelemetry/instrumentation-mongodb');
  const { NodeSDK } = require('@opentelemetry/sdk-node');

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? `migration-service-${process.env.ROLE ?? 'all'}`,
    // Reads OTEL_EXPORTER_OTLP_ENDPOINT itself and posts to <endpoint>/v1/traces.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      // The inbound request span — the root of an enqueue's trace.
      new HttpInstrumentation(),
      // One span per driver command. It only records a command that has a
      // parent span, which is exactly what migronaut's migration span provides.
      new MongoDBInstrumentation(),
    ],
  });
  sdk.start();
  shutdownTracing = () => sdk.shutdown();
  console.log(`tracing to ${endpoint}`);
}

module.exports = { shutdownTracing: () => shutdownTracing() };
