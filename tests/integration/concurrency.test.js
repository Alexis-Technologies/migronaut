const { spawn } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const { after, afterEach, before, beforeEach, describe, it } = require('node:test');
const { LOCK_ID } = require('../../src/core/lock.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { insertMigration, makeMigrator, makeProject } = require('../helpers/project.js');

let mongo;
const DB = 'migronaut_concurrency_test';
const LOCK_COLLECTION = '_migronaut_locks';
const runnerPath = path.join(__dirname, '..', 'helpers', 'child-runner.js');
const binPath = path.join(__dirname, '..', '..', 'bin', 'migronaut.js');

before(async () => {
  mongo = await startTestMongo(DB);
});

after(async () => {
  await mongo.stop();
});

let project;
let children;

beforeEach(async () => {
  await mongo.db.dropDatabase();
  project = makeProject();
  children = [];
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  project?.cleanup();
});

/**
 * Start a real child process running `up`. Its stdout lines are parsed as
 * events, and `waitFor` resolves when one of them arrives.
 */
function startChild(mode) {
  const child = spawn(process.execPath, [runnerPath, mongo.uri, DB, project.dir, mode ?? ''], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);

  const events = [];
  const waiters = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      for (const waiter of [...waiters]) {
        if (waiter.name === event.event) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    }
  });

  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    events,
    exited,
    waitFor: (name, timeoutMs = 20_000) =>
      new Promise((resolve, reject) => {
        const existing = events.find((event) => event.event === name);
        if (existing) return resolve(existing);
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for "${name}"`)),
          timeoutMs,
        );
        timer.unref?.();
        waiters.push({
          name,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      }),
  };
}

/**
 * Start the shipped CLI as a child process. Signal handling lives in the CLI
 * layer — core deliberately installs no process-wide handlers — so testing it
 * means running the real binary.
 */
function startCli(args) {
  const child = spawn(
    process.execPath,
    [binPath, '--uri', mongo.uri, '--db', DB, '--dir', project.dir, ...args],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}

/** Resolve once a lock document exists — i.e. the run is inside its lock */
async function waitForLock(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await mongo.db.collection(LOCK_COLLECTION).findOne({ _id: LOCK_ID });
    if (lock) return lock;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the lock to be acquired');
}

/** A migration that blocks until a sentinel document appears */
function blockingMigration(collection, value) {
  return `export async function up({ db }) {
  await db.collection('${collection}').insertOne({ marker: '${value}' });
  for (let i = 0; i < 400; i++) {
    const go = await db.collection('signals').findOne({ _id: 'release' });
    if (go) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
export async function down({ db }) {
  await db.collection('${collection}').deleteMany({ marker: '${value}' });
}
`;
}

const release = () => mongo.db.collection('signals').insertOne({ _id: 'release', at: new Date() });

describe('two-process lock contention (integration)', () => {
  it('should let exactly one process migrate while the other is refused', async () => {
    project.write('0001-slow.ts', blockingMigration('things', 'slow'));

    const first = startChild();
    // Only start the competitor once the first genuinely holds the lock.
    await first.waitFor('migration:start');

    const second = startChild();
    const refusal = await second.waitFor('failed');
    assert.strictEqual(refusal.code, 'LOCK_ALREADY_HELD');

    await release();
    const firstExit = await first.exited;
    assert.strictEqual(firstExit.code, 0);

    // Applied exactly once, by exactly one process.
    assert.strictEqual(await mongo.db.collection('things').countDocuments(), 1);
    assert.strictEqual(await mongo.db.collection('_migronaut_migrations').countDocuments(), 1);
  });

  it('should release the lock when the winner finishes, so the next process runs', async () => {
    project.write('0001-slow.ts', blockingMigration('things', 'slow'));

    const first = startChild();
    await first.waitFor('migration:start');
    await release();
    assert.strictEqual((await first.exited).code, 0);

    project.write('0002-b.ts', insertMigration('things', 'b'));
    const second = startChild();
    const done = await second.waitFor('done');
    assert.deepStrictEqual(done.applied, ['0002-b.ts']);
    assert.strictEqual((await second.exited).code, 0);
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
  });
});

describe('crash and signal handling (integration)', () => {
  it('should leave a lock behind on SIGKILL, reclaimable once it goes stale', async () => {
    project.write('0001-slow.ts', blockingMigration('things', 'slow'));

    const first = startCli(['up']);
    await waitForLock();
    // SIGKILL cannot be handled: this is the crash the TTL exists for.
    first.child.kill('SIGKILL');
    await first.exited;

    const lock = await mongo.db.collection(LOCK_COLLECTION).findOne({ _id: LOCK_ID });
    assert.notStrictEqual(lock, null, 'a killed process cannot release its lock');

    // Age the lock past its TTL, exactly as time would.
    await mongo.db
      .collection(LOCK_COLLECTION)
      .updateOne({ _id: LOCK_ID }, { $set: { lockedAt: new Date(Date.now() - 120_000) } });
    await release();

    const second = startCli(['up']);
    assert.strictEqual((await second.exited).code, 0, 'the stale lock should be reclaimable');
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
  });

  it('should release the lock promptly on SIGTERM instead of waiting out the TTL', async () => {
    project.write('0001-slow.ts', blockingMigration('things', 'slow'));
    project.write('0002-b.ts', insertMigration('things', 'b'));

    const first = startCli(['up']);
    await waitForLock();
    first.child.kill('SIGTERM');
    // The in-flight migration is allowed to finish, so let it.
    await release();
    const exit = await first.exited;
    // 11 = RUN_ABORTED: stopped on request, not crashed.
    assert.strictEqual(exit.code, 11, 'a stopped run reports RUN_ABORTED');

    // The graceful path releases the lock immediately — no TTL wait, no
    // `migronaut unlock` needed.
    assert.strictEqual(await mongo.db.collection(LOCK_COLLECTION).countDocuments(), 0);
    // The first migration committed; the second never started.
    const applied = await mongo.db.collection('_migronaut_migrations').find().toArray();
    assert.deepStrictEqual(
      applied.map((record) => record.name),
      ['0001-slow.ts'],
    );
  });
});

describe('mongoose integration', () => {
  it('should expose the mongoose instance to migrations', async () => {
    const mongoose = require('mongoose');
    await mongoose.connect(mongo.uri, { dbName: DB });
    try {
      project.write(
        '0001-mongoose.ts',
        `export async function up({ mongoose }) {
  const Thing = mongoose.models.Thing ?? mongoose.model('Thing', new mongoose.Schema({ name: String }));
  await Thing.create({ name: 'via-mongoose' });
}
export async function down({ mongoose }) {
  await mongoose.connection.collection('things').deleteMany({});
}
`,
      );
      const kit = makeMigrator(mongo.uri, DB, project.dir, { mongoose });
      await kit.up();
      await kit.disconnect();

      const doc = await mongo.db.collection('things').findOne({ name: 'via-mongoose' });
      assert.notStrictEqual(doc, null, 'the migration should have written through mongoose');
    } finally {
      await mongoose.disconnect();
    }
  });
});
