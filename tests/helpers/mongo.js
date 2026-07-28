const { MongoClient } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// Local runs and CI must test the same server version by default — an
// unpinned mongodb-memory-server silently changes the server the whole suite
// runs on. CI's (or the developer's) explicit MONGOMS_VERSION still wins.
process.env.MONGOMS_VERSION ??= '7.0.14';

/**
 * Connect to the test MongoDB replica set — the shared one booted by
 * ../helpers/global-setup.js when the run used `--test-global-setup`
 * (pnpm run test:integration), a private one otherwise (running a single
 * file via `node --test tests/integration/x.test.js` still works).
 *
 * A replica set (not a standalone) is required so transactions work in tests.
 * Isolation between files comes from distinct `dbName`s plus `dropDatabase()`
 * in each file's beforeEach — never from server-per-file.
 *
 * `dedicated: true` forces a private server — for files that kill child
 * processes mid-run or otherwise want nothing shared.
 */
async function startTestMongo(dbName = 'migronaut_test', options = {}) {
  const sharedUri = options.dedicated ? undefined : process.env.MIGRONAUT_TEST_MONGO_URI;
  let replSet;
  let uri;
  if (sharedUri) {
    uri = sharedUri;
  } else {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = replSet.getUri();
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  return {
    replSet,
    client,
    db,
    uri,
    dbName,
    stop: async () => {
      await client.close();
      // The shared replica set outlives this file — global teardown stops it.
      await replSet?.stop();
    },
  };
}

module.exports = { startTestMongo };
