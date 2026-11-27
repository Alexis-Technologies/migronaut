#!/usr/bin/env node
const { errorText } = require('../src/utils/error.js');
const { sanitizeTerminal } = require('../src/utils/sanitize.js');

/** How long a run stopped by an uncaught throw gets to release its lock before the exit */
const UNCAUGHT_DRAIN_MS = 10_000;

// Same hygiene as the default logger: these last-resort handlers are the only
// paths that write to the TTY directly, and an escaped error message can embed
// DB-derived text — sanitized by construction, like every other output path.
const writeError = (error) => {
  process.stderr.write(`✖ ${sanitizeTerminal(errorText(error))}\n`);
};

/**
 * Stop the runs in flight: after an error escaped every handler, what they do
 * next is no longer something to vouch for. A stopped run ends after the
 * migration in flight and releases its lock. How many there were.
 */
const stopRuns = (reason) => {
  try {
    return require('../src/cli/shared.js').stopActiveMigrators(reason);
  } catch {
    // ignore: the original error is what this process reports
    return 0;
  }
};

// `status --json | head` closes the pipe early; the resulting EPIPE arrives as
// a stream 'error' event, not a promise rejection, and would otherwise crash
// with a raw Node stack. A closed pipe after we printed what fit is success.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
    // Output was lost: the exit code says so, and stderr does while it works.
    process.exitCode = 1;
    if (stream === process.stdout) writeError(error);
  });
}

// A rejection escaping the CLI's own handling still gets the project's error
// format instead of Node's default trace — and stops the run: a migration's
// write no one awaited failed, so the rest must not be applied on top of it.
process.on('unhandledRejection', (error) => {
  writeError(error);
  process.exitCode = 1;
  stopRuns('Stopped after an unhandled rejection');
});

// A synchronous throw (signal handler, timer callback) bypasses the promise
// chain — without this, Node prints a raw stack, the one output path that
// skips errorText's URI redaction. The process state is not trustworthy
// enough to keep going: with no run in flight it exits at once; a run is
// stopped and gets a short drain to release its lock (an exit leaves the lock
// to its TTL). The timer is unref'd, so a drain that ends sooner exits sooner.
process.on('uncaughtException', (error) => {
  writeError(error);
  process.exitCode = 1;
  if (stopRuns('Stopped after an uncaught exception') === 0) process.exit(1);
  setTimeout(() => process.exit(1), UNCAUGHT_DRAIN_MS).unref();
});

// Required after the handlers above, on purpose: an error thrown while the CLI
// loads is reported by them, in the project's format, not as a raw stack.
const { run } = require('../src/cli/index.js');

run(process.argv).catch((error) => {
  writeError(error);
  // exitCode, not exit(): letting the event loop drain flushes buffered
  // stdout/stderr writes that process.exit() would truncate on a pipe.
  process.exitCode = 1;
});
