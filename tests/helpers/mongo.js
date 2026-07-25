const { MongoClient } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

/**
 * Start an in-memory MongoDB replica set and connect a client.
 * A replica set (not a standalone) is required so transactions work in tests.
 */
async function startTestMongo(dbName = 'migronaut_test') {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();
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
      await replSet.stop();
    },
  };
}

module.exports = { startTestMongo };
