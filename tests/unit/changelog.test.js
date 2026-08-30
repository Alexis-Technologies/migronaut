const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { Changelog } = require('../../src/core/changelog.js');
const { makeRecord } = require('../helpers/records.js');

function makeDb() {
  const collection = {
    createIndexes: mock.fn(() => Promise.resolve(['name_unique'])),
    replaceOne: mock.fn(() => Promise.resolve({})),
    updateOne: mock.fn(() => Promise.resolve({})),
    bulkWrite: mock.fn(() => Promise.resolve({})),
    findOne: mock.fn(() => Promise.resolve(null)),
  };
  const db = { collection: () => collection };
  return { db, collection };
}

describe('Changelog (mocked DB)', () => {
  it('ensureIndexes should create the indexes the read paths use', async () => {
    const { db, collection } = makeDb();
    await new Changelog('_migronaut_migrations').ensureIndexes(db);
    // One round trip for all of them, not one call each.
    assert.strictEqual(collection.createIndexes.mock.callCount(), 1);
    const [specs] = collection.createIndexes.mock.calls[0].arguments;
    assert.deepStrictEqual(specs, [
      { key: { name: 1 }, name: 'name_unique', unique: true },
      { key: { status: 1, batch: -1 }, name: 'status_batch' },
      { key: { batch: 1 }, name: 'batch' },
      { key: { status: 1, name: 1 }, name: 'status_name' },
      { key: { status: 1, appliedAt: -1, name: -1 }, name: 'status_appliedAt_name' },
    ]);
  });

  it('markAppliedBulk should mirror markApplied as one unordered bulkWrite', async () => {
    const { db, collection } = makeDb();
    const records = [makeRecord({ name: 'a.ts' }), makeRecord({ name: 'b.ts' })];
    await new Changelog('_migronaut_migrations').markAppliedBulk(db, records);
    assert.strictEqual(collection.bulkWrite.mock.callCount(), 1);
    const [ops, options] = collection.bulkWrite.mock.calls[0].arguments;
    assert.deepStrictEqual(options, { ordered: false });
    assert.strictEqual(ops.length, 2);
    const first = ops[0].updateOne;
    assert.deepStrictEqual(first.filter, { name: 'a.ts' });
    assert.strictEqual(first.upsert, true);
    // Same shape as markApplied: name never in an update operator, audit
    // fields preserved across a re-import.
    assert.strictEqual(first.update.$set.name, undefined);
    assert.ok(first.update.$setOnInsert.firstAppliedAt instanceof Date);
    assert.deepStrictEqual(first.update.$unset, { revertedAt: '', failedAt: '', error: '' });
  });

  it('markAppliedBulk should skip the round trip entirely for zero records', async () => {
    const { db, collection } = makeDb();
    await new Changelog('_migronaut_migrations').markAppliedBulk(db, []);
    assert.strictEqual(collection.bulkWrite.mock.callCount(), 0);
  });

  it('markApplied should upsert keyed on name', async () => {
    const { db, collection } = makeDb();
    const record = makeRecord({ name: 'a.ts' });
    await new Changelog('_migronaut_migrations').markApplied(db, record);
    const [filter, update, options] = collection.updateOne.mock.calls[0].arguments;
    assert.deepStrictEqual(filter, { name: 'a.ts' });
    assert.strictEqual(update.$set.status, record.status);
    assert.strictEqual(update.$set.checksum, record.checksum);
    // `name` comes from the filter — repeating it in an operator would conflict.
    assert.strictEqual(update.$set.name, undefined);
    assert.deepStrictEqual(options, { upsert: true });
  });

  it('markApplied should preserve audit history across a re-apply', async () => {
    const { db, collection } = makeDb();
    await new Changelog('_migronaut_migrations').markApplied(db, makeRecord({ name: 'a.ts' }));
    const [, update] = collection.updateOne.mock.calls[0].arguments;
    // firstAppliedAt survives a re-apply; a stale revertedAt — and the trace
    // of an earlier failed attempt — are cleared.
    assert.ok(update.$setOnInsert.firstAppliedAt instanceof Date);
    assert.deepStrictEqual(update.$unset, { revertedAt: '', failedAt: '', error: '' });
  });

  it('markApplied should stamp appliedAt in server time when the record has none', async () => {
    const { db, collection } = makeDb();
    const record = makeRecord({ name: 'a.ts' });
    delete record.appliedAt;
    await new Changelog('_migronaut_migrations').markApplied(db, record);
    const [, update] = collection.updateOne.mock.calls[0].arguments;
    // $currentDate = the server's clock, matching the lock's $$NOW discipline —
    // the revert-selection sorts must not depend on this host's clock.
    assert.deepStrictEqual(update.$currentDate, { appliedAt: true });
    assert.strictEqual(update.$set.appliedAt, undefined);
    assert.ok(update.$setOnInsert.firstAppliedAt instanceof Date);
  });

  it('markApplied should write an explicit appliedAt verbatim (import history)', async () => {
    const { db, collection } = makeDb();
    const appliedAt = new Date('2020-01-02T03:04:05Z');
    await new Changelog('_migronaut_migrations').markApplied(
      db,
      makeRecord({ name: 'a.ts', appliedAt }),
    );
    const [, update] = collection.updateOne.mock.calls[0].arguments;
    assert.strictEqual(update.$set.appliedAt, appliedAt);
    assert.strictEqual(update.$currentDate, undefined);
    assert.strictEqual(update.$setOnInsert.firstAppliedAt, appliedAt);
  });

  it('markApplied should pass the session through when given one', async () => {
    const { db, collection } = makeDb();
    const session = { id: 'session' };
    await new Changelog('_migronaut_migrations').markApplied(db, makeRecord(), session);
    const [, , options] = collection.updateOne.mock.calls[0].arguments;
    assert.deepStrictEqual(options, { upsert: true, session });
  });

  it('markReverted should set status and revertedAt without deleting', async () => {
    const { db, collection } = makeDb();
    await new Changelog('_migronaut_migrations').markReverted(db, 'a.ts');
    const [filter, update] = collection.updateOne.mock.calls[0].arguments;
    assert.deepStrictEqual(filter, { name: 'a.ts', status: 'applied' });
    assert.strictEqual(update.$set.status, 'reverted');
    // Server time, like markApplied's appliedAt — one clock for the trail.
    assert.deepStrictEqual(update.$currentDate, { revertedAt: true });
  });

  it('markFailed should upsert a failed trace without touching applied records', async () => {
    const { db, collection } = makeDb();
    await new Changelog('_migronaut_migrations').markFailed(db, {
      name: 'a.ts',
      error: 'boom',
      runId: 'run-1',
    });
    const [filter, update, options] = collection.updateOne.mock.calls[0].arguments;
    // The $ne filter means an existing 'applied' record never matches — the
    // upsert then collides on the unique name index, which the caller swallows.
    assert.deepStrictEqual(filter, { name: 'a.ts', status: { $ne: 'applied' } });
    assert.strictEqual(update.$set.status, 'failed');
    assert.strictEqual(update.$set.error, 'boom');
    assert.strictEqual(update.$set.name, undefined);
    assert.deepStrictEqual(update.$currentDate, { failedAt: true });
    assert.deepStrictEqual(options, { upsert: true });
  });

  it('markReverted should pass the session through when given one', async () => {
    const { db, collection } = makeDb();
    const session = { id: 'session' };
    await new Changelog('_migronaut_migrations').markReverted(db, 'a.ts', session);
    const [, , options] = collection.updateOne.mock.calls[0].arguments;
    assert.deepStrictEqual(options, { session });
  });

  it('markReverted should return the update result so callers can detect a miss', async () => {
    const { db, collection } = makeDb();
    // matchedCount 0 = a concurrent peer already flipped the record; the
    // caller (not this logger-free module) decides how loudly to say so.
    collection.updateOne.mock.mockImplementation(() =>
      Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
    );
    const result = await new Changelog('_migronaut_migrations').markReverted(db, 'a.ts');
    assert.strictEqual(result.matchedCount, 0);
  });

  it('getByName should query findOne by name', async () => {
    const { db, collection } = makeDb();
    collection.findOne.mock.mockImplementationOnce(() =>
      Promise.resolve(makeRecord({ name: 'a.ts' })),
    );
    const found = await new Changelog('_migronaut_migrations').getByName(db, 'a.ts');
    assert.deepStrictEqual(collection.findOne.mock.calls[0].arguments, [{ name: 'a.ts' }]);
    assert.strictEqual(found?.name, 'a.ts');
  });
});
