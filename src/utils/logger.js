const { createColors } = require('./colors.js');

/** A logger whose methods are all no-ops — used to silence all output */
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Create the default console logger (pino-compatible method surface).
 *
 * `debug`/`info` write to `stream` (stdout by default); `warn`/`error`
 * always write to stderr. Pass `process.stderr` as `stream` to keep stdout
 * clean for machine-readable output (e.g. `--json` mode routes all human
 * lines here). Colors: `debug` is dimmed, `warn` yellow, `error` red.
 */
function createLogger(stream = process.stdout) {
  const outColors = createColors(stream);
  const errColors = createColors(process.stderr);
  const writeOut = (msg) => {
    stream.write(`${msg}\n`);
  };
  const writeErr = (msg) => {
    process.stderr.write(`${msg}\n`);
  };
  return {
    debug: (msg) => writeOut(outColors.dim(msg)),
    info: (msg) => writeOut(msg),
    warn: (msg) => writeErr(errColors.yellow(msg)),
    error: (msg) => writeErr(errColors.red(msg)),
  };
}

const hasMethod = (value, name) => typeof value?.[name] === 'function';

/** Wrap a sink method so a throwing user logger can never break a migration run */
const guard = (fn) => (msg) => {
  try {
    fn(msg);
  } catch {
    // Logging must never break a migration run.
  }
};

/** Adapters are cached per user logger so pino's child() binds only once */
const adapters = new WeakMap();

/**
 * Resolve the effective logger from a config value: `null` → silent,
 * `undefined` → default console logger, otherwise the user's logger adapted
 * to the four-method surface. A pino-style `child` is bound once with a
 * `component` field; a missing `debug`/`warn`/`error` falls back to `info`
 * (or `debug` when only that exists), and every call is guarded so a
 * throwing logger can never abort a half-applied run. A structurally unfit
 * value (no `info`/`debug` function) silences output instead of crashing.
 */
function resolveLogger(logger) {
  if (logger === null) return silentLogger;
  if (logger === undefined) return createLogger();
  if (typeof logger !== 'object' || (!hasMethod(logger, 'info') && !hasMethod(logger, 'debug'))) {
    return silentLogger;
  }
  const cached = adapters.get(logger);
  if (cached !== undefined) return cached;
  const child = hasMethod(logger, 'child') ? logger.child({ component: 'migronaut' }) : null;
  const sink = child && (hasMethod(child, 'info') || hasMethod(child, 'debug')) ? child : logger;
  const base = hasMethod(sink, 'info') ? sink.info.bind(sink) : sink.debug.bind(sink);
  const pick = (name) => (hasMethod(sink, name) ? sink[name].bind(sink) : base);
  const adapter = {
    debug: guard(pick('debug')),
    info: guard(pick('info')),
    warn: guard(pick('warn')),
    error: guard(pick('error')),
  };
  adapters.set(logger, adapter);
  return adapter;
}

module.exports = { silentLogger, createLogger, resolveLogger };
