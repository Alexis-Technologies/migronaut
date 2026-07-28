#!/usr/bin/env node
const { errorText } = require('../src/utils/error.js');

// `status --json | head` closes the pipe early; the resulting EPIPE arrives as
// a stream 'error' event, not a promise rejection, and would otherwise crash
// with a raw Node stack. A closed pipe after we printed what fit is success.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
  });
}

// A rejection escaping the CLI's own handling still gets the project's error
// format instead of Node's default trace.
process.on('unhandledRejection', (error) => {
  process.stderr.write(`✖ ${errorText(error)}\n`);
  process.exitCode = 1;
});

// A synchronous throw (signal handler, timer callback) bypasses the promise
// chain — without this, Node prints a raw stack, the one output path that
// skips errorText's URI redaction. exit(1), not exitCode: after an uncaught
// throw the process state is not trustworthy enough to keep draining.
process.on('uncaughtException', (error) => {
  process.stderr.write(`✖ ${errorText(error)}\n`);
  process.exit(1);
});

const { run } = require('../src/cli/index.js');

run(process.argv).catch((error) => {
  process.stderr.write(`✖ ${errorText(error)}\n`);
  // exitCode, not exit(): letting the event loop drain flushes buffered
  // stdout/stderr writes that process.exit() would truncate on a pipe.
  process.exitCode = 1;
});
