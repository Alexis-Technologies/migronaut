/**
 * Run the opt-in suites, and fail where one cannot run instead of letting it skip.
 *
 * Each suite skips itself when its variable is unset: that keeps the gate free
 * of Redis and containers, and it would also let a release pass on three
 * skips. This script is the release's way in. It names every missing variable
 * with the container that serves it, and exits 1 before running anything.
 *
 * Usage: node scripts/test-optin.js [redis] [atlas] [sharded]   (none: all three)
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SUITES = {
  __proto__: null,
  redis: {
    variable: 'MIGRONAUT_TEST_REDIS_URL',
    example: 'redis://127.0.0.1:6379',
    file: 'tests/integration/bullmq-redis.test.js',
    start: 'docker run --rm -d -p 6379:6379 redis:7-alpine',
  },
  atlas: {
    variable: 'MIGRONAUT_TEST_ATLAS_URI',
    example: 'mongodb://127.0.0.1:27018/?directConnection=true',
    file: 'tests/integration/search-atlas.test.js',
    start: 'docker run --rm -d -p 27018:27017 -e DO_NOT_TRACK=1 mongodb/mongodb-atlas-local:8.0',
  },
  sharded: {
    variable: 'MIGRONAUT_TEST_SHARDED_URI',
    example: 'mongodb://root:root@127.0.0.1:27019/?authSource=admin',
    file: 'tests/integration/sharded.test.js',
    start:
      'docker run --rm -d --name migronaut-sharded -p 27019:27017 ' +
      '-v "$PWD/tests/fixtures/sharded:/s:ro" mongo:8.0 bash /s/start.sh',
  },
};

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : Object.keys(SUITES);
const files = [];
let missing = '';
for (const name of names) {
  const suite = SUITES[name];
  if (suite === undefined) {
    console.error(`Unknown suite '${name}' — one of: ${Object.keys(SUITES).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (process.env[suite.variable] === undefined || process.env[suite.variable] === '') {
    missing += `\n  ${name}: ${suite.variable} (e.g. ${suite.example})\n    ${suite.start}`;
  }
  files.push(suite.file);
}
if (missing !== '') {
  console.error(`Not run — each suite would skip without its variable:${missing}`);
  process.exitCode = 1;
  return;
}

const run = spawnSync(
  process.execPath,
  [path.join(__dirname, 'node-test.js'), '--test-concurrency=1', ...files],
  { stdio: 'inherit', cwd: path.join(__dirname, '..') },
);
// A signal death must not look like a pass.
process.exitCode = run.status ?? 1;
