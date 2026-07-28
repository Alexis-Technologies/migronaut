/**
 * Run `node --test` with the flags the *running* Node actually supports.
 *
 * `--test-global-setup` landed in Node 24; it does not exist in Node 22, which
 * is the `engines` floor this project supports and tests on. Putting it
 * directly in an npm script makes every Node 22 run die with
 * `node: bad option: --test-global-setup=...` before a single test executes.
 *
 * The flag is a pure optimization: it boots ONE in-memory replica set for the
 * whole integration run (see tests/helpers/global-setup.js). Without it,
 * `startTestMongo` in tests/helpers/mongo.js sees no MIGRONAUT_TEST_MONGO_URI
 * and boots a private replica set per file — slower, identical results. So the
 * right behavior is to use it where it exists and silently do without
 * elsewhere, not to drop Node 22 from CI.
 *
 * Detection is a feature test rather than a version comparison, so a backport
 * to a future 22.x is picked up on its own.
 *
 * Usage: node scripts/node-test.js [...args passed through to `node --test`]
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const GLOBAL_SETUP = 'tests/helpers/global-setup.js';

/** True when this Node recognizes `--test-global-setup` */
function supportsGlobalSetup() {
  return process.allowedNodeEnvironmentFlags.has('--test-global-setup');
}

const args = ['--test'];
if (supportsGlobalSetup()) {
  args.push(`--test-global-setup=${GLOBAL_SETUP}`);
}
args.push(...process.argv.slice(2));

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  cwd: path.join(__dirname, '..'),
});

// Mirror the runner's outcome exactly: a signal death must not look like a
// pass, or CI would go green on a killed test run.
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
child.on('error', (error) => {
  process.exitCode = 1;
  throw error;
});
