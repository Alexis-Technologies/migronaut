const { createInterface } = require('node:readline/promises');
const { createSpinner } = require('./spinner.js');
const { MigratorKit } = require('../core/migrator.js');
const { MigronautError } = require('../errors/index.js');
const { createLogger } = require('../utils/logger.js');

/** Write a value as pretty JSON to stdout, followed by a newline */
function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Build the partial config passed to MigratorKit from CLI flags */
function partialFromOpts(opts) {
  const partial = {};
  if (opts.uri) partial.uri = opts.uri;
  if (opts.db) partial.dbName = opts.db;
  if (opts.dir) partial.migrationsDir = opts.dir;
  if (opts.strict) partial.strict = true;
  return partial;
}

/** Exit code convention for a process killed by a signal: 128 + signal number */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

/**
 * Turn SIGINT/SIGTERM into a graceful stop: the migration in flight finishes,
 * the rest are skipped, and the lock is released — instead of leaving a
 * half-applied migration and a lock held until its TTL expires. A second signal
 * exits immediately for an operator who cannot wait.
 *
 * Returns a function that removes the handlers again, so a long-lived process
 * calling the CLI repeatedly does not accumulate them.
 */
function attachSignalHandlers(migrator, spinner, logger) {
  let stopping = false;
  const handlers = [];
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (stopping) {
        spinner?.stop();
        process.exit(SIGNAL_EXIT_CODES[signal]);
      }
      stopping = true;
      spinner?.stop();
      logger.warn(
        `⚠ ${signal} received — finishing the current migration, then stopping. ` +
          'Press again to exit immediately.',
      );
      migrator.stop(`Received ${signal}`);
    };
    process.on(signal, handler);
    handlers.push([signal, handler]);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

/**
 * Construct a MigratorKit from CLI options, run `fn`, always disconnect, and
 * translate failures into a non-zero exit code with a readable message.
 */
async function withMigrator(opts, fn, options = {}) {
  const json = options.json ?? false;
  // In JSON mode the spinner is suppressed and all human output goes to stderr,
  // so stdout carries exactly one JSON document.
  const spinner = options.spinner && !json ? createSpinner() : undefined;

  const partial = partialFromOpts(opts);
  if (json) {
    // Route the migrator's own progress/info lines to stderr.
    partial.logger = createLogger(process.stderr);
  }

  const migratorOptions = {
    ...(opts.config ? { configPath: opts.config } : {}),
  };
  if (spinner) {
    const reporter = {
      onStart: (name, direction) =>
        spinner.start(`${direction === 'up' ? 'Applying' : 'Reverting'} ${name}…`),
      // Stop (not succeed) — core logs the ✔/↩/✖ result line right after, so
      // the outcome argument is deliberately unused here.
      onStop: () => spinner.stop(),
    };
    migratorOptions.progress = reporter;
  }
  const migrator = new MigratorKit(partial, migratorOptions);
  // Human-facing logger for withMigrator's own messages; stderr in JSON mode.
  const logger = createLogger(json ? process.stderr : process.stdout);
  const detachSignals = attachSignalHandlers(migrator, spinner, logger);
  try {
    if (spinner) {
      spinner.start('Connecting to MongoDB…');
      try {
        await migrator.connect();
        spinner.stop();
      } catch (error) {
        spinner.stop();
        throw error;
      }
    }
    await fn(migrator);
  } catch (error) {
    // Safety net: clear any spinner still spinning before printing the error.
    spinner?.stop();
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      emitJson({
        error: { ...(error instanceof MigronautError ? { code: error.code } : {}), message },
      });
    } else if (error instanceof MigronautError) {
      logger.error(`✖ ${error.code}: ${error.message}`);
    } else {
      logger.error(`✖ ${message}`);
    }
    process.exitCode = 1;
  } finally {
    detachSignals();
    spinner?.stop();
    // A failing close must not replace whatever this command was reporting.
    await migrator.disconnect().catch(() => undefined);
  }
}

/**
 * Ask a yes/no question on the terminal. Resolves `true` only when the user
 * answers `y` or `yes` (case-insensitive); any other input is treated as no.
 */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

module.exports = { emitJson, partialFromOpts, withMigrator, confirm };
