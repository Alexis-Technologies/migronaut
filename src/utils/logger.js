const { createColors } = require('./colors.js');
const { sanitizeTerminal } = require('./sanitize.js');

/** Severity order, used to drop messages below the configured level */
const LEVELS = { __proto__: null, debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** The level methods a sink may have, in the order they are looked for */
const SINK_METHODS = ['info', 'debug', 'warn', 'error'];

/** A logger whose methods are all no-ops — used to silence all output */
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Adapters are cached per user logger so pino's child() binds only once */
const adapters = new WeakMap();

const noop = () => {};

/** warn/error always go to stderr, whatever stream debug/info write to */
const writeErr = (message) => {
  process.stderr.write(`${message}\n`);
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
const createLogger = (stream = process.stdout, level = 'info') => {
  const outColors = createColors(stream);
  const errColors = createColors(process.stderr);
  const threshold = LEVELS[level] ?? LEVELS.info;
  const writeOut = (message) => {
    stream.write(`${message}\n`);
  };
  const at = (name, write) => (LEVELS[name] >= threshold ? write : () => {});
  // Sanitized by construction: messages routinely embed migration names and
  // lock-holder fields — values anyone with DB write access can influence —
  // and no individual call site should have to remember terminal-escape
  // hygiene. SGR color codes (migronaut's own table/level styling) survive;
  // cursor movement and screen clearing do not. User-injected loggers are
  // exempt (their sink is not necessarily a terminal) — this is the default
  // terminal logger only.
  return {
    debug: at('debug', (message) => writeOut(outColors.dim(sanitizeTerminal(message)))),
    info: at('info', (message) => writeOut(sanitizeTerminal(message))),
    warn: at('warn', (message) => writeErr(errColors.yellow(sanitizeTerminal(message)))),
    error: at('error', (message) => writeErr(errColors.red(sanitizeTerminal(message)))),
  };
};

const hasMethod = (value, name) => typeof value?.[name] === 'function';

/** A sink is usable when it exposes any of the four level methods */
const isUsableSink = (value) => {
  for (let i = 0; i < SINK_METHODS.length; i++) {
    if (hasMethod(value, SINK_METHODS[i])) return true;
  }
  return false;
};

/**
 * Wrap a sink method so a throwing user logger can never break a migration run.
 * `pinoStyle` swaps the argument order to `(fields, msg)`, which is what pino
 * and its ecosystem expect for structured logging; everyone else gets
 * `(msg, fields)` so a plain `(msg) => …` logger keeps working unchanged.
 */
const guard = (method, pinoStyle) => {
  return (message, fields) => {
    try {
      if (fields === undefined) method(message);
      else if (pinoStyle) method(fields, message);
      else method(message, fields);
    } catch {
      // Logging must never break a migration run.
    }
  };
};

/**
 * Resolve the effective logger from a config value: `null` → silent,
 * `undefined` → default console logger, otherwise the user's logger adapted
 * to the four-method surface. A pino-style `child` is bound once with a
 * `component` field; a missing method falls back to the nearest present one
 * of similar severity (a warn/error-only logger keeps its warn/error output —
 * its missing debug/info become no-ops, never a reason to silence failures),
 * and every call is guarded so a throwing logger can never abort a
 * half-applied run. A structurally unfit value (no level method at all)
 * silences output instead of crashing.
 *
 * A logger exposing `child()` is treated as pino-style, so structured fields
 * are passed as the first argument rather than the second.
 */
const resolveLogger = (logger) => {
  // `false` reads as "no logger" as well as `null` does: both are documented.
  if (logger === null || logger === false) return silentLogger;
  if (logger === undefined) return createLogger();
  if (typeof logger !== 'object' || !isUsableSink(logger)) {
    return silentLogger;
  }
  const cached = adapters.get(logger);
  if (cached !== undefined) return cached;
  const isPinoStyle = hasMethod(logger, 'child');
  const child = isPinoStyle ? logger.child({ component: 'migronaut' }) : null;
  const sink = child && isUsableSink(child) ? child : logger;
  // Fallback preference per level: same severity first, then the neighbors a
  // reader of that sink would expect. debug/info never escalate to warn/error
  // (running commentary must not masquerade as problems); warn/error always
  // find SOME sink so failures stay visible.
  const pick = (order) => {
    for (const name of order) {
      if (hasMethod(sink, name)) return sink[name].bind(sink);
    }
    return noop;
  };
  const adapter = {
    debug: guard(pick(['debug', 'info']), isPinoStyle),
    info: guard(pick(['info', 'debug']), isPinoStyle),
    warn: guard(pick(['warn', 'info', 'debug', 'error']), isPinoStyle),
    error: guard(pick(['error', 'warn', 'info', 'debug']), isPinoStyle),
  };
  adapters.set(logger, adapter);
  return adapter;
};

module.exports = { silentLogger, createLogger, resolveLogger };
