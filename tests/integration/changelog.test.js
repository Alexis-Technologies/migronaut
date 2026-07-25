const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');
const { Changelog } = require('../../src/core/changelog.js');
const { startTestMongo } = require('../helpers/mongo.js');
const { makeRecord } = require('../helpers/records.js');

let mongo;
const COLLECTION = '_migronaut_migrations';
const changelog = new Changelog(COLLECTION);

before(async () => {
  mongo = await startTestMongo('migronaut_changelog_test');
});

after(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.collection(COLLECTION).deleteMany({});
});

describe('Changelog (integration)', () => {
  it('markApplied should insert a full record', async () => {
    const record = makeRecord({ name: '0001-a.ts', batch: 1 });
    await changelog.markApplied(mongo.db, record);
    const stored = await changelog.getByName(mongo.db, '0001-a.ts');
    assert.strictEqual(stored.name, '0001-a.ts');
    assert.strictEqual(stored.batch, 1);
    assert.strictEqual(stored.status, 'applied');
    assert.strictEqual(stored.checksum, 'abc123');
    assert.strictEqual(stored.environment, 'test');
    assert.strictEqual(stored.executedBy, 'tester');
  });

  it('markReverted should flip status and set revertedAt, never deleting', async () => {
    await changelog.markApplied(mongo.db, makeRecord({ name: '0001-a.ts' }));
    await changelog.markReverted(mongo.db, '0001-a.ts');
    const stored = await changelog.getByName(mongo.db, '0001-a.ts');
    assert.notStrictEqual(stored, null);
    assert.strictEqual(stored?.status, 'reverted');
    assert.ok(stored?.revertedAt instanceof Date);
    const count = await mongo.db.collection(COLLECTION).countDocuments();
    assert.strictEqual(count, 1);
  });

  it('getAppliedNames should return only applied records', async () => {
    await changelog.markApplied(mongo.db, makeRecord({ name: '0001-a.ts' }));
    await changelog.markApplied(mongo.db, makeRecord({ name: '0002-b.ts' }));
    await changelog.markReverted(mongo.db, '0002-b.ts');
    const names = await changelog.getAppliedNames(mongo.db);
    assert.deepStrictEqual(names, ['0001-a.ts']);
  });

  it('getLastBatch should return the highest applied batch', async () => {
    await changelog.markApplied(mongo.db, makeRecord({ name: '0001-a.ts', batch: 1 }));
    await changelog.markApplied(mongo.db, makeRecord({ name: '0002-b.ts', batch: 1 }));
    await changelog.markApplied(mongo.db, makeRecord({ name: '0003-c.ts', batch: 2 }));
    assert.strictEqual(await changelog.getLastBatch(mongo.db), 2);
  });

  it('getLastBatch should return null when nothing is applied', async () => {
    assert.strictEqual(await changelog.getLastBatch(mongo.db), null);
  });

  it('getByBatch should return all records for a batch', async () => {
    await changelog.markApplied(mongo.db, makeRecord({ name: '0001-a.ts', batch: 1 }));
    await changelog.markApplied(mongo.db, makeRecord({ name: '0002-b.ts', batch: 1 }));
    await changelog.markApplied(mongo.db, makeRecord({ name: '0003-c.ts', batch: 2 }));
    const batch1 = await changelog.getByBatch(mongo.db, 1);
    assert.deepStrictEqual(
      batch1.map((r) => r.name),
      ['0001-a.ts', '0002-b.ts'],
    );
  });

  it('getAll should return every record sorted by name', async () => {
    await changelog.markApplied(mongo.db, makeRecord({ name: '0002-b.ts' }));
    await changelog.markApplied(mongo.db, makeRecord({ name: '0001-a.ts' }));
    const all = await changelog.getAll(mongo.db);
    assert.deepStrictEqual(
      all.map((r) => r.name),
      ['0001-a.ts', '0002-b.ts'],
    );
  });

  it('ensureIndexes should enforce uniqueness on name', async () => {
    await changelog.ensureIndexes(mongo.db);
    await mongo.db.collection(COLLECTION).insertOne(makeRecord({ name: 'dup.ts' }));
    await assert.rejects(mongo.db.collection(COLLECTION).insertOne(makeRecord({ name: 'dup.ts' })));
  });
});
