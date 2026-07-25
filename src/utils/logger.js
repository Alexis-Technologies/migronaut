const chalk = require('chalk');

/** A logger whose methods are all no-ops — used to silence all output */
const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
  error: () => {},
  dim: () => {},
};

/**
 * Create the default chalk-based structured logger.
 *
 * `info`/`success`/`dim` write to `stream` (stdout by default); `warn`/`error`
 * always write to stderr. Pass `process.stderr` as `stream` to keep stdout clean
 * for machine-readable output (e.g. `--json` mode routes all human lines here).
 */
function createLogger(stream = process.stdout) {
  const writeOut = (msg) => {
    stream.write(`${msg}\n`);
  };
  const writeErr = (msg) => {
    process.stderr.write(`${msg}\n`);
  };
  return {
    info: (msg) => writeOut(msg),
    success: (msg) => writeOut(chalk.green(msg)),
    warn: (msg) => writeErr(chalk.yellow(msg)),
    error: (msg) => writeErr(chalk.red(msg)),
    dim: (msg) => writeOut(chalk.dim(msg)),
  };
}

/**
 * Resolve the effective logger from a config value:
 * `null` → silent, `undefined` → default chalk logger, otherwise the custom logger.
 */
function resolveLogger(logger) {
  if (logger === null) {
    return silentLogger;
  }
  return logger ?? createLogger();
}

module.exports = { silentLogger, createLogger, resolveLogger };
