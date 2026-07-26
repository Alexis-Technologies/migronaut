const { createColors } = require('./colors.js');

/** Severity order, used to drop messages below the configured level */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

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
 *
 * `level` drops anything less severe than itself — `'debug'` shows everything,
 * `'error'` only failures. The structured `fields` second argument that core
 * passes is ignored here: the human line already carries that information.
 */
function createLogger(stream = process.stdout, level = 'info') {
  const outColors = createColors(stream);
  const errColors = createColors(process.stderr);
  const threshold = LEVELS[level] ?? LEVELS.info;
  const writeOut = (msg) => {
    stream.write(`${msg}\n`);
  };
  const writeErr = (msg) => {
    process.stderr.write(`${msg}\n`);
  };
  const at = (name, write) => (LEVELS[name] >= threshold ? write : () => {});
  return {
    debug: at('debug', (msg) => writeOut(outColors.dim(msg))),
    info: at('info', (msg) => writeOut(msg)),
    warn: at('warn', (msg) => writeErr(errColors.yellow(msg))),
    error: at('error', (msg) => writeErr(errColors.red(msg))),
  };
}

const hasMethod = (value, name) => typeof value?.[name] === 'function';

/**
 * Wrap a sink method so a throwing user logger can never break a migration run.
 * `pinoStyle` swaps the argument order to `(fields, msg)`, which is what pino
 * and its ecosystem expect for structured logging; everyone else gets
 * `(msg, fields)` so a plain `(msg) => …` logger keeps working unchanged.
 */
const guard = (fn, pinoStyle) => (msg, fields) => {
  try {
    if (fields === undefined) fn(msg);
    else if (pinoStyle) fn(fields, msg);
    else fn(msg, fields);
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
 *
 * A logger exposing `child()` is treated as pino-style, so structured fields
 * are passed as the first argument rather than the second.
 */
function resolveLogger(logger) {
  if (logger === null) return silentLogger;
  if (logger === undefined) return createLogger();
  if (typeof logger !== 'object' || (!hasMethod(logger, 'info') && !hasMethod(logger, 'debug'))) {
    return silentLogger;
  }
  const cached = adapters.get(logger);
  if (cached !== undefined) return cached;
  const pinoStyle = hasMethod(logger, 'child');
  const child = pinoStyle ? logger.child({ component: 'migronaut' }) : null;
  const sink = child && (hasMethod(child, 'info') || hasMethod(child, 'debug')) ? child : logger;
  const base = hasMethod(sink, 'info') ? sink.info.bind(sink) : sink.debug.bind(sink);
  const pick = (name) => (hasMethod(sink, name) ? sink[name].bind(sink) : base);
  const adapter = {
    debug: guard(pick('debug'), pinoStyle),
    info: guard(pick('info'), pinoStyle),
    warn: guard(pick('warn'), pinoStyle),
    error: guard(pick('error'), pinoStyle),
  };
  adapters.set(logger, adapter);
  return adapter;
}

module.exports = { LEVELS, silentLogger, createLogger, resolveLogger };
