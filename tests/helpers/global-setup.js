const { MongoMemoryReplSet } = require('mongodb-memory-server');

/**
 * node:test --test-global-setup module: boot ONE in-memory replica set for the
 * whole integration run instead of one per file (17 serial boot+shutdown
 * cycles ≈ a minute of pure fixture cost). Test files reach it through the
 * env var via `startTestMongo` in ./mongo.js; isolation is preserved by the
 * per-file database names and `dropDatabase()` in each beforeEach.
 *
 * Only wired up on Node >= 24 — the flag does not exist on Node 22, which is
 * the `engines` floor. scripts/node-test.js feature-detects it and omits it
 * there, so this module simply never runs and each file boots its own server.
 *
 * Files that fork real processes against their own server
 * (concurrency.test.js, runtime-ts.test.js) opt out with
 * `startTestMongo(db, { dedicated: true })`.
 */

let replSet;

async function globalSetup() {
  // Local runs and CI must test the same server version — CI's explicit
  // MONGOMS_VERSION still wins.
  process.env.MONGOMS_VERSION ??= '7.0.14';
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MIGRONAUT_TEST_MONGO_URI = replSet.getUri();
}

async function globalTeardown() {
  await replSet?.stop();
}

module.exports = { globalSetup, globalTeardown };
