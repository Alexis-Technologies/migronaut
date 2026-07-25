#!/usr/bin/env node
const { run } = require('../src/cli/index.js');

run(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
