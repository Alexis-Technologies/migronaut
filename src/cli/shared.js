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
  if (opts.env === false) partial.envFile = false;
  else if (opts.envFile) partial.envFile = opts.envFile;
  return partial;
}

/**
 * Exit code per error code, so CI can branch on *why* a run failed instead of
 * only that it did. Anything unmapped exits 1, and success is still 0 — a
 * script testing `!= 0` is unaffected.
 */
const EXIT_CODES = {
  LOCK_ALREADY_HELD: 3,
  CHECKSUM_MISMATCH: 4,
  CONNECTION_FAILED: 5,
  CONFIG_INVALID: 6,
  MIGRATION_EXECUTION_FAILED: 7,
  MIGRATION_FILE_NOT_FOUND: 8,
  NOT_APPLIED: 9,
  LOCK_LOST: 10,
  RUN_ABORTED: 11,
  HOOK_FAILED: 12,
  MIGRATION_IRREVERSIBLE: 13,
};

/** The exit code for a failure — see {@link EXIT_CODES} */
function exitCodeFor(error) {
  if (!(error instanceof MigronautError)) return 1;
  return EXIT_CODES[error.code] ?? 1;
}

/**
 * Log level from the verbosity flags. `--quiet` keeps errors — the point is to
 * drop the running commentary, not to hide failures.
 */
function resolveLevel(opts) {
  if (opts.verbose) return 'debug';
  if (opts.quiet) return 'error';
  return 'info';
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
  const verbose = opts.verbose ?? false;
  const level = resolveLevel(opts);
  // In JSON mode the spinner is suppressed and all human output goes to stderr,
  // so stdout carries exactly one JSON document.
  const spinner = options.spinner && !json && level !== 'silent' ? createSpinner() : undefined;

  const partial = partialFromOpts(opts);
  if (json || level !== 'info') {
    // Route the migrator's own progress/info lines to stderr in JSON mode, and
    // apply --verbose/--quiet to them in every mode.
    partial.logger = createLogger(json ? process.stderr : process.stdout, level);
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
  // Errors survive --quiet: silencing a failure is never what an operator meant.
  const logger = createLogger(json ? process.stderr : process.stdout, level);
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
      // `context` carries the detail that used to be dropped entirely —
      // validation issues, the driver's cause — and `partial` the migrations
      // that did land before the failure, which is what a deploy pipeline needs
      // to decide how to recover.
      const context = error instanceof MigronautError ? error.context : undefined;
      const { results, ...rest } = context ?? {};
      emitJson({
        error: {
          ...(error instanceof MigronautError ? { code: error.code } : {}),
          message,
          ...(Object.keys(rest).length > 0 ? { context: rest } : {}),
        },
        ...(Array.isArray(results) ? { partial: results } : {}),
      });
    } else if (error instanceof MigronautError) {
      logger.error(`✖ ${error.code}: ${error.message}`);
      // The cause is the actionable half of a connection or migration failure;
      // without --verbose it stays hidden so the common case reads cleanly.
      if (verbose && error.cause instanceof Error) {
        logger.debug(error.cause.stack ?? error.cause.message);
      }
    } else {
      logger.error(`✖ ${message}`);
      if (verbose && error instanceof Error && error.stack) logger.debug(error.stack);
    }
    process.exitCode = exitCodeFor(error);
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
