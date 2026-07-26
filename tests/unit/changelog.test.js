const assert = require('node:assert/strict');
const { describe, it, mock } = require('node:test');
const { Changelog } = require('../../src/core/changelog.js');
const { makeRecord } = require('../helpers/records.js');

function makeDb() {
  const collection = {
    createIndex: mock.fn(() => Promise.resolve('name_1')),
    replaceOne: mock.fn(() => Promise.resolve({})),
    updateOne: mock.fn(() => Promise.resolve({})),
    findOne: mock.fn(() => Promise.resolve(null)),
  };
  const db = { collection: () => collection };
  return { db, collection };
}

describe('Changelog (mocked DB)', () => {
  it('ensureIndexes should create a unique index on name', async () => {
    const { db, collection } = makeDb();
    await new Changelog('_migronaut_migrations').ensureIndexes(db);
    assert.deepStrictEqual(collection.createIndex.mock.calls[0].arguments, [
      { name: 1 },
      { unique: true },
    ]);
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
    // firstAppliedAt survives a re-apply; a stale revertedAt is cleared.
    assert.ok(update.$setOnInsert.firstAppliedAt instanceof Date);
    assert.deepStrictEqual(update.$unset, { revertedAt: '' });
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
    assert.ok(update.$set.revertedAt instanceof Date);
  });

  it('markReverted should pass the session through when given one', async () => {
    const { db, collection } = makeDb();
    const session = { id: 'session' };
    await new Changelog('_migronaut_migrations').markReverted(db, 'a.ts', session);
    const [, , options] = collection.updateOne.mock.calls[0].arguments;
    assert.deepStrictEqual(options, { session });
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
