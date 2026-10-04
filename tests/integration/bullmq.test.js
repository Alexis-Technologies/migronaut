const { after, before, describe } = require('node:test');
const { defineBullMQScenarios } = require('../helpers/bullmq-scenarios.js');
const { createFakeConnection, fakeBullmq } = require('../helpers/fake-bullmq.js');
const { startTestMongo } = require('../helpers/mongo.js');

let mongo;
const DB = 'migronaut_bullmq_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

/**
 * The queue adapter end to end — real MongoDB, real migration files, the
 * in-tree fake BullMQ. No Redis: this file runs everywhere and carries the
 * adapter's coverage. `bullmq-redis.test.js` replays the same scenarios on the
 * real library.
 */
describe('BullMQ adapter (integration, fake BullMQ)', () => {
  defineBullMQScenarios({
    fake: true,
    dbName: DB,
    mongo: () => mongo,
    bullmq: fakeBullmq,
    // A fresh token is a fresh "Redis server": nothing leaks between tests.
    connection: createFakeConnection,
    prefix: () => undefined,
    logsOf: async (queue, id) => (await queue.getJob(id)).logs,
    obliterate: async (queue) => queue.obliterate(),
  });
});
