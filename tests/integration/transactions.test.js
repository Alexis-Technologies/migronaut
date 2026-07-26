const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it, mock } = require('node:test');
const { buildContext } = require('../../src/core/context.js');
const { runMigration } = require('../../src/core/runner.js');
const { MigrationExecutionFailedError } = require('../../src/errors/index.js');
const { startTestMongo } = require('../helpers/mongo.js');

let mongo;
const COLLECTION = 'tx_items';

before(async () => {
  mongo = await startTestMongo('migronaut_tx_test');
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.collection(COLLECTION).deleteMany({});
});

function context() {
  return buildContext(mongo.client, mongo.db);
}

describe('runMigration transactions (integration)', () => {
  it('should commit the transaction on success when useTransaction=true', async () => {
    const migration = {
      up: async (ctx) => {
        await ctx.db.collection(COLLECTION).insertOne({ v: 1 }, { session: ctx.session });
      },
      down: async () => undefined,
    };
    await runMigration({
      name: 'commit.ts',
      migration,
      direction: 'up',
      context: context(),
      useTransaction: true,
    });
    assert.strictEqual(await mongo.db.collection(COLLECTION).countDocuments(), 1);
  });

  it('should abort the transaction on error when useTransaction=true', async () => {
    const migration = {
      up: async (ctx) => {
        await ctx.db.collection(COLLECTION).insertOne({ v: 2 }, { session: ctx.session });
        throw new Error('fail after write');
      },
      down: async () => undefined,
    };
    await assert.rejects(
      runMigration({
        name: 'abort.ts',
        migration,
        direction: 'up',
        context: context(),
        useTransaction: true,
      }),
      MigrationExecutionFailedError,
    );
    assert.strictEqual(await mongo.db.collection(COLLECTION).countDocuments(), 0);
  });

  it('should persist writes without a transaction when useTransaction=false', async () => {
    const migration = {
      up: async (ctx) => {
        await ctx.db.collection(COLLECTION).insertOne({ v: 3 });
      },
      down: async () => undefined,
    };
    await runMigration({
      name: 'plain.ts',
      migration,
      direction: 'up',
      context: context(),
      useTransaction: false,
    });
    assert.strictEqual(await mongo.db.collection(COLLECTION).countDocuments(), 1);
  });

  it('should record a non-negative duration', async () => {
    const migration = {
      up: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      down: async () => undefined,
    };
    const outcome = await runMigration({
      name: 'timed.ts',
      migration,
      direction: 'up',
      context: context(),
      useTransaction: false,
    });
    // Wall-clock duration is recorded in whole milliseconds; a ~5ms sleep can
    // round to 4ms, so assert only that a sane non-negative duration was captured.
    assert.ok(outcome.duration >= 0);
    assert.strictEqual(Number.isFinite(outcome.duration), true);
  });

  it('should roll back the migration when the changelog write fails', async () => {
    // The whole point of writing the record inside the transaction: bookkeeping
    // and data move together, so a failure cannot leave a migration applied but
    // unrecorded (which would silently re-run it on the next `up`).
    const migration = {
      up: async (ctx) => {
        await ctx.db.collection(COLLECTION).insertOne({ v: 4 }, { session: ctx.session });
      },
      down: async () => undefined,
    };
    await assert.rejects(
      runMigration({
        name: 'atomic.ts',
        migration,
        direction: 'up',
        context: context(),
        useTransaction: true,
        onSuccess: () => Promise.reject(new Error('changelog unavailable')),
      }),
      MigrationExecutionFailedError,
    );
    assert.strictEqual(await mongo.db.collection(COLLECTION).countDocuments(), 0);
  });

  it('should commit the changelog write together with the migration', async () => {
    const recorded = [];
    const migration = {
      up: async (ctx) => {
        await ctx.db.collection(COLLECTION).insertOne({ v: 5 }, { session: ctx.session });
      },
      down: async () => undefined,
    };
    await runMigration({
      name: 'atomic-ok.ts',
      migration,
      direction: 'up',
      context: context(),
      useTransaction: true,
      onSuccess: async (duration, session) => {
        // The session must be the migration's own, or the write lands outside
        // the transaction and the atomicity guarantee is void.
        recorded.push({ duration, hasSession: session !== undefined });
        await mongo.db.collection(COLLECTION).insertOne({ marker: 'changelog' }, { session });
      },
    });
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(recorded[0].hasSession, true);
    assert.strictEqual(typeof recorded[0].duration, 'number');
    assert.strictEqual(await mongo.db.collection(COLLECTION).countDocuments(), 2);
  });

  it('should call the onError hook before rethrowing', async () => {
    const onError = mock.fn(() => Promise.resolve(undefined));
    const migration = {
      up: async () => {
        throw new Error('explode');
      },
      down: async () => undefined,
    };
    await assert.rejects(
      runMigration({
        name: 'err.ts',
        migration,
        direction: 'up',
        context: context(),
        useTransaction: false,
        hooks: { onError },
      }),
      MigrationExecutionFailedError,
    );
    assert.strictEqual(onError.mock.callCount(), 1);
  });
});
