const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { MongoClient } = require('mongodb');
const { MigrationTimeoutError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_migration_logs_test';

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

let project;
const kits = [];

beforeEach(async () => {
  await mongo.db.dropDatabase();
  project = makeProject();
});

afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.disconnect();
  project?.cleanup();
});

function migrator(overrides = {}) {
  const kit = makeMigrator(mongo.uri, DB, project.dir, overrides);
  kits.push(kit);
  return kit;
}

/** A logger that keeps every line it is given */
function recordingLogger() {
  const lines = [];
  const at = (level) => (msg, fields) => lines.push({ level, msg, fields });
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
}

/** Everything a kit emits as migration:log, and its run ids */
function listen(kit) {
  const events = [];
  const runs = [];
  kit.on('migration:log', (event) => events.push(event));
  kit.on('run:start', (event) => runs.push(event.runId));
  return { events, runs };
}

/** A migration that logs a line for its users and an operational one, then inserts */
function loggingMigration(value) {
  return `export async function up({ db, logger, run }) {
  logger.debug('starting ${value}');
  logger.info('inserting', { userland: true, value: '${value}', frozen: Object.isFrozen(run) });
  await db.collection('things').insertOne({ marker: '${value}' });
}
export async function down({ db, logger }) {
  logger.info('removing', { userland: true, value: '${value}' });
  await db.collection('things').deleteMany({ marker: '${value}' });
}
`;
}

describe('userland migration logs (integration)', () => {
  it('should emit one event per userland call, correlated with the run and the changelog', async () => {
    project.write('0001-a.js', loggingMigration('a'));
    project.write('0002-b.js', loggingMigration('b'));
    const { lines, logger } = recordingLogger();
    const kit = migrator({ logger });
    const { events, runs } = listen(kit);

    await kit.up(undefined, { requestedBy: 'alice', reason: 'TICKET-1' });

    assert.strictEqual(events.length, 2);
    const [runId] = runs;
    const records = await mongo.db.collection('_migronaut_migrations').find().toArray();
    for (const record of records) assert.strictEqual(record.runId, runId);
    assert.deepStrictEqual(
      events.map((event) => [event.migration, event.seq, event.runId, event.attempt]),
      [
        ['0001-a.js', 1, runId, 1],
        ['0002-b.js', 2, runId, 1],
      ],
    );
    const [first] = events;
    assert.strictEqual(first.kind, 'migration');
    assert.strictEqual(first.direction, 'up');
    assert.strictEqual(first.batch, 1);
    assert.strictEqual(first.level, 'info');
    assert.strictEqual(first.msg, 'inserting');
    assert.strictEqual(first.requestedBy, 'alice');
    assert.strictEqual(first.reason, 'TICKET-1');
    assert.deepStrictEqual(first.data, { value: 'a', frozen: true });
    assert.ok(first.at instanceof Date);

    // The operational line has the correlation too — and emitted nothing.
    const starting = lines.find((line) => line.msg === 'starting a');
    assert.strictEqual(starting.level, 'debug');
    assert.strictEqual(starting.fields.runId, runId);
    assert.strictEqual(starting.fields.migration, '0001-a.js');
    assert.strictEqual(starting.fields.attempt, 1);
    assert.ok(!('requestedBy' in starting.fields), 'who asked stays off log lines');
  });

  it('should emit with a silenced logger', async () => {
    project.write('0001-a.js', loggingMigration('a'));
    const kit = migrator({ logger: null });
    const { events } = listen(kit);
    await kit.up();
    assert.strictEqual(events.length, 1);
  });

  it('should keep the event of a body that failed, while its writes are rolled back', async () => {
    project.write(
      '0001-a.js',
      `export const useTransaction = true;
export async function up({ db, logger, session }) {
  await db.collection('things').insertOne({ marker: 'a' }, { session });
  logger.error('gave up', { userland: true, step: 'insert' });
  throw new Error('intentional failure');
}
export async function down() {}
`,
    );
    const kit = migrator();
    const { events } = listen(kit);
    await assert.rejects(kit.up());
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].level, 'error');
    assert.deepStrictEqual(events[0].data, { step: 'insert' });
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 0);
  });

  it('should keep correlating a call a timed-out body makes after the run ended', async () => {
    project.write(
      '0001-slow.js',
      `export const timeoutMs = 100;
export async function up({ logger }) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  logger.info('late', { userland: true });
}
export async function down() {}
`,
    );
    const kit = migrator();
    const { events, runs } = listen(kit);
    await assert.rejects(kit.up(), MigrationTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].msg, 'late');
    assert.strictEqual(events[0].runId, runs[0]);
    assert.strictEqual(events[0].migration, '0001-slow.js');
  });

  it('should give every hook a logger and ctx.run — the run’s around it, the migration’s inside', async () => {
    project.write('0001-a.js', loggingMigration('a'));
    const seen = {};
    const hook =
      (name) =>
      async (...args) => {
        const ctx = args.find((arg) => arg && typeof arg === 'object' && 'db' in arg);
        seen[name] = ctx.run;
        ctx.logger.info(name, { userland: true });
      };
    const kit = migrator({
      hooks: {
        beforeAll: hook('beforeAll'),
        beforeEach: hook('beforeEach'),
        afterEach: hook('afterEach'),
        afterAll: hook('afterAll'),
      },
    });
    const { events, runs } = listen(kit);
    await kit.up();

    assert.deepStrictEqual(seen.beforeAll, { id: runs[0], direction: 'up' });
    assert.deepStrictEqual(seen.afterAll, seen.beforeAll);
    assert.strictEqual(seen.beforeEach.migration, '0001-a.js');
    assert.strictEqual(seen.beforeEach.attempt, 1);
    assert.strictEqual(seen.afterEach.attempt, 1);
    assert.deepStrictEqual(
      events.map((event) => [event.msg, event.migration, event.seq]),
      [
        ['beforeAll', undefined, 1],
        ['beforeEach', '0001-a.js', 2],
        ['inserting', '0001-a.js', 3],
        ['afterEach', '0001-a.js', 4],
        ['afterAll', undefined, 5],
      ],
    );
  });

  it('should number a redo’s two halves as one run', async () => {
    project.write('0001-a.js', loggingMigration('a'));
    const kit = migrator();
    await kit.up();
    const { events, runs } = listen(kit);
    await kit.redo();
    assert.deepStrictEqual(
      events.map((event) => [event.direction, event.msg, event.seq, event.runId]),
      [
        ['down', 'removing', 1, runs[0]],
        ['up', 'inserting', 2, runs[0]],
      ],
    );
  });

  it('should log a retried transaction once per attempt, telling the attempts apart', async () => {
    project.write(
      '0001-a.js',
      `export const useTransaction = true;
export async function up({ db, logger, run, session }) {
  logger.info('attempting', { userland: true, attempt: run.attempt });
  await db.collection('things').insertOne({ marker: 'a' }, { session });
}
export async function down() {}
`,
    );
    // A client of its own, so the fail point hits this kit's insert and nothing else.
    const client = new MongoClient(mongo.uri, { appName: 'logs-retry' });
    await client.connect();
    await mongo.client.db('admin').command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: {
        failCommands: ['insert'],
        errorCode: 112,
        errorLabels: ['TransientTransactionError'],
        appName: 'logs-retry',
        namespace: `${DB}.things`,
      },
    });
    try {
      const kit = migrator({ client, uri: undefined });
      const { events } = listen(kit);
      const results = await kit.up();
      assert.strictEqual(results[0].status, 'applied');
      assert.deepStrictEqual(
        events.map((event) => [event.attempt, event.data.attempt, event.seq]),
        [
          [1, 1, 1],
          [2, 2, 2],
        ],
      );
      assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
    } finally {
      await mongo.client.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
      await client.close();
    }
  });

  it('should carry the job a run works for — on ctx.run, the event and the kit’s own lines', async () => {
    project.write(
      '0001-a.js',
      `export async function up({ db, logger, run }) {
  logger.info('for the job', { userland: true, jobId: run.jobId, groupId: run.groupId });
  await db.collection('things').insertOne({ marker: 'a' });
}
export async function down() {}
`,
    );
    const { lines, logger } = recordingLogger();
    const kit = migrator({ logger });
    const { events } = listen(kit);
    await kit.up('0001-a.js', { job: { id: '17', groupId: 'g-1' } });

    assert.strictEqual(events[0].jobId, '17');
    assert.strictEqual(events[0].groupId, 'g-1');
    assert.deepStrictEqual(events[0].data, { jobId: '17', groupId: 'g-1' });
    const applied = lines.find((line) => line.msg.startsWith('✔ Applied'));
    assert.strictEqual(applied.fields.jobId, '17');
    assert.strictEqual(applied.fields.groupId, 'g-1');
    // A later run without a job carries none.
    await kit.down('0001-a.js');
    const reverted = lines.find((line) => line.msg.startsWith('↩ Reverted'));
    assert.ok(!('jobId' in reverted.fields));
  });
});
