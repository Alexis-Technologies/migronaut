const { createInterface } = require('node:readline/promises');
const { createSpinner } = require('./spinner.js');
const { ConfigInvalidError, MigronautError } = require('../errors/index.js');
const { errorText } = require('../utils/error.js');
const { createLogger } = require('../utils/logger.js');
const { redactDeep, redactUris } = require('../utils/redact.js');

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

const { EXIT_CODES } = require('./exit-codes.js');

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
        // process.exit(), not exitCode: the operator pressed twice — an
        // immediate abort is exactly what they asked for, and the output
        // truncation bin/migronaut.js avoids on the graceful path is the
        // accepted cost here.
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
 * Minimal signal handling for read-only commands: clear the spinner's frame,
 * then re-deliver the signal to Node's default handler (exit). Without this,
 * Ctrl-C during "Connecting to MongoDB…" leaves a partial frame the shell
 * prompt then overwrites messily. No graceful-stop promise here — a read-only
 * command has nothing to finish.
 */
function attachCleanupHandlers(spinner) {
  if (!spinner) return () => undefined;
  const handlers = [];
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      spinner.stop();
      process.off(signal, handler);
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
    handlers.push([signal, handler]);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

/**
 * Wrap a logger so every line clears and re-renders an active spinner instead
 * of splicing into the middle of its frame.
 */
function spinnerAwareLogger(logger, spinner) {
  const wrap = (method) => (message, fields) =>
    spinner.interrupt(() => logger[method](message, fields));
  return { debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
}

/**
 * Report a failure the same way everywhere: `--json` gets one structured
 * document on stdout, humans get a readable line (plus the cause under
 * `--verbose`). Every string leaving through this path is redacted — the
 * driver echoes the raw connection URI (credentials included) in parse
 * errors, and those surface as message, context.cause, and stack alike.
 */
function reportError(error, { json, verbose, logger }) {
  const message = errorText(error);
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
        ...(Object.keys(rest).length > 0 ? { context: redactDeep(rest) } : {}),
      },
      ...(Array.isArray(results) ? { partial: results } : {}),
    });
  } else if (error instanceof MigronautError) {
    logger.error(`✖ ${error.code}: ${message}`);
    // The cause is the actionable half of a connection or migration failure;
    // without --verbose it stays hidden so the common case reads cleanly.
    if (verbose && error.cause instanceof Error) {
      logger.debug(redactUris(error.cause.stack ?? error.cause.message));
    }
  } else {
    logger.error(`✖ ${message}`);
    if (verbose && error instanceof Error && error.stack) logger.debug(redactUris(error.stack));
  }
  process.exitCode = exitCodeFor(error);
}

/**
 * Construct a MigratorKit from CLI options, run `fn(migrator, cli)`, always
 * disconnect, and translate failures into a non-zero exit code with a
 * readable message. `cli` is `{ logger, json, opts }` — the one level-aware
 * logger every command must render through, so `--quiet`/`--verbose` apply to
 * command output and not only to core's log lines.
 */
async function withMigrator(opts, fn, options = {}) {
  // Required here, not at module top: the orchestrator is the CLI's one heavy
  // import, and `--help`/`--version` never reach this function.
  const { MigratorKit } = require('../core/migrator.js');
  const json = options.json ?? false;
  const verbose = opts.verbose ?? false;
  const level = resolveLevel(opts);
  // In JSON mode the spinner is suppressed and all human output goes to stderr,
  // so stdout carries exactly one JSON document. `--quiet` also suppresses it:
  // the spinner is running commentary.
  const spinner = options.spinner && !json && level === 'info' ? createSpinner() : undefined;

  const partial = partialFromOpts(opts);
  // One level-aware logger per invocation (defineCommand hands its own in so
  // preflight and run render identically); while a spinner is active every
  // line interrupts it instead of colliding.
  const baseLogger =
    options.baseLogger ?? createLogger(json ? process.stderr : process.stdout, level);
  const cliLogger = spinner ? spinnerAwareLogger(baseLogger, spinner) : baseLogger;

  const migratorOptions = {
    ...(opts.config ? { configPath: opts.config } : {}),
    // A *fallback*, not an override: a `logger` in the user's config file
    // (pino, or `null` for silence) wins over the CLI's console logger — the
    // README documents that pattern, and clobbering it silently broke it.
    fallbackLogger: cliLogger,
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
  // Human-facing logger for withMigrator's own messages and command rendering;
  // stderr in JSON mode. Errors survive --quiet: silencing a failure is never
  // what an operator meant. Command output stays on the CLI logger even when
  // the config supplies its own — a table or error is what the operator asked
  // this invocation for, not a line for the app's structured sink.
  const logger = cliLogger;
  // Graceful-stop handlers only make sense for a command that runs migrations;
  // a read-only command gets a minimal handler that clears the spinner (a
  // stray frame otherwise survives Node's default exit) and re-raises.
  const detachSignals = options.mutating
    ? attachSignalHandlers(migrator, spinner, logger)
    : attachCleanupHandlers(spinner);
  try {
    // Pre-connect is cosmetic (early spinner + early failure): every kit
    // method connects on its own. `connect: false` opts out — `audit` reports
    // a failed connection as one of its checks rather than dying on it.
    const preConnect = options.connect ?? options.spinner === true;
    if (preConnect) {
      spinner?.start('Connecting to MongoDB…');
      try {
        await migrator.connect();
        spinner?.stop();
      } catch (error) {
        spinner?.stop();
        throw error;
      }
    }
    await fn(migrator, { logger, json, opts });
  } catch (error) {
    // Safety net: clear any spinner still spinning before printing the error.
    spinner?.stop();
    reportError(error, { json, verbose, logger });
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
 *
 * The prompt goes to **stderr** so captured stdout stays clean. A closed or
 * empty stdin (EOF, `< /dev/null` — a CI job that forgot `--yes`) never
 * delivers a line; without the close guard the promise would hang forever and
 * the process would then exit 0 having done nothing. It becomes a typed
 * refusal instead.
 */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let settled = false;
  const closedEarly = new Promise((_resolve, reject) => {
    rl.once('close', () => {
      if (!settled) {
        reject(
          new ConfigInvalidError(
            'stdin closed before the confirmation was answered — pass --yes to confirm non-interactively',
          ),
        );
      }
    });
  });
  try {
    const answer = await Promise.race([rl.question(question), closedEarly]);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    settled = true;
    rl.close();
  }
}

/**
 * Register a command with the envelope every data command shares: parse
 * `optsWithGlobals`, run `preflight` (validation/confirmation — before any
 * connection), then `run` inside {@link withMigrator}, then emit the returned
 * data as JSON or hand it to `render`. A `run` that returns `undefined` owns
 * its output. `after(data, cli)` runs last in every mode (exit-code logic).
 */
function defineCommand(program, spec) {
  const command = program.command(spec.name).description(spec.description);
  for (const [arg, help] of spec.args ?? []) command.argument(arg, help);
  for (const [flags, help] of spec.options ?? []) command.option(flags, help);
  // `lockable: true` declares the option AND computes the inversion once —
  // the `--no-x` flag arriving as `opts.lock === false` is subtle enough that
  // a per-command copy will eventually get it wrong.
  if (spec.lockable) command.option('--no-lock', 'Skip the concurrency lock (dev only)');
  command.action(async (...actionArgs) => {
    const invoked = actionArgs[actionArgs.length - 1];
    const positionals = actionArgs.slice(0, -2);
    const opts = invoked.optsWithGlobals();
    if (spec.lockable) opts.noLock = opts.lock === false;
    const json = spec.jsonOutput === false ? false : Boolean(opts.json);
    const verbose = opts.verbose ?? false;
    const logger = createLogger(json ? process.stderr : process.stdout, resolveLevel(opts));

    if (spec.preflight) {
      try {
        const proceed = await spec.preflight(opts, positionals, { logger, json });
        if (proceed === false) return;
      } catch (error) {
        reportError(error, { json, verbose, logger });
        return;
      }
    }

    await withMigrator(
      opts,
      async (migrator, cli) => {
        const data = await spec.run(migrator, opts, positionals, cli);
        if (data !== undefined) {
          if (json) emitJson(data);
          else spec.render?.(data, cli);
        }
        spec.after?.(data, cli);
      },
      {
        spinner: spec.spinner ?? true,
        // The preflight logger is reused inside, so a warning printed before
        // the run and one printed during it render identically.
        baseLogger: logger,
        ...(spec.connect !== undefined ? { connect: spec.connect } : {}),
        ...(spec.mutating ? { mutating: true } : {}),
        ...(json ? { json: true } : {}),
      },
    );
  });
  return command;
}

module.exports = {
  emitJson,
  partialFromOpts,
  withMigrator,
  confirm,
  defineCommand,
  reportError,
  exitCodeFor,
  resolveLevel,
  attachSignalHandlers,
  EXIT_CODES,
};
