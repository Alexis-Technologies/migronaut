const { createInterface } = require('node:readline/promises');
const ora = require('ora');
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

/**
 * Construct a MigratorKit from CLI options, run `fn`, always disconnect, and
 * translate failures into a non-zero exit code with a readable message.
 */
async function withMigrator(opts, fn, options = {}) {
  const json = options.json ?? false;
  // In JSON mode the spinner is suppressed and all human output goes to stderr,
  // so stdout carries exactly one JSON document.
  const spinner = options.spinner && !json ? ora() : undefined;

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
      // Stop (not succeed) — core logs the ✔/↩ result line right after.
      onStop: () => spinner.stop(),
    };
    migratorOptions.progress = reporter;
  }
  const migrator = new MigratorKit(partial, migratorOptions);
  // Human-facing logger for withMigrator's own messages; stderr in JSON mode.
  const logger = createLogger(json ? process.stderr : process.stdout);
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
    spinner?.stop();
    await migrator.disconnect();
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
