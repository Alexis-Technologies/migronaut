const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { isMigrateMongoDoc, mapMigrateMongoDocs } = require('../../src/core/import.js');

/** A checksum resolver that echoes a deterministic value, marking it recomputed */
const echoResolver = (fileName) => ({
  checksum: `sum-${fileName}`,
  source: 'recomputed',
});

const baseOptions = {
  environment: 'imported',
  executedBy: 'migronaut-import',
  resolveChecksum: echoResolver,
};

describe('isMigrateMongoDoc', () => {
  it('should accept a doc with a non-empty fileName', () => {
    assert.strictEqual(isMigrateMongoDoc({ fileName: 'a.js', appliedAt: new Date() }), true);
  });

  it('should reject docs without a usable fileName', () => {
    assert.strictEqual(isMigrateMongoDoc({ appliedAt: new Date() }), false);
    assert.strictEqual(isMigrateMongoDoc({ fileName: '' }), false);
    assert.strictEqual(isMigrateMongoDoc(null), false);
    assert.strictEqual(isMigrateMongoDoc('a.js'), false);
  });
});

describe('mapMigrateMongoDocs', () => {
  it('should map fields and synthesize the missing ones', async () => {
    const docs = [
      { fileName: 'a.js', appliedAt: new Date('2026-01-01T00:00:00Z'), migrationBlock: 100 },
    ];
    const [record] = await mapMigrateMongoDocs(docs, baseOptions);
    assert.strictEqual(record.name, 'a.js');
    assert.strictEqual(record.batch, 1);
    assert.strictEqual(record.status, 'applied');
    assert.strictEqual(record.duration, 0);
    assert.strictEqual(record.checksum, 'sum-a.js');
    assert.strictEqual(record.environment, 'imported');
    assert.strictEqual(record.executedBy, 'migronaut-import');
    assert.strictEqual(record.origin, 'migrate-mongo');
    assert.deepStrictEqual(record.appliedAt, new Date('2026-01-01T00:00:00Z'));
  });

  it('should assign a unique sequential batch to each migration in apply order', async () => {
    // All three share one migrationBlock (one migrate-mongo run) — they must still
    // get distinct batch numbers, not a single shared (duplicate) batch.
    const docs = [
      { fileName: 'b.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'a.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'c.js', appliedAt: new Date(), migrationBlock: 100 },
    ];
    const records = await mapMigrateMongoDocs(docs, baseOptions);
    assert.deepStrictEqual(
      records.map((r) => [r.name, r.batch]),
      [
        ['a.js', 1],
        ['b.js', 2],
        ['c.js', 3],
      ],
    );
  });

  it('should pass the source fileHash to the resolver', async () => {
    const seen = [];
    await mapMigrateMongoDocs([{ fileName: 'a.js', appliedAt: new Date(), fileHash: 'h1' }], {
      ...baseOptions,
      resolveChecksum: (_name, hash) => {
        seen.push(hash);
        return { checksum: 'x', source: 'reused' };
      },
    });
    assert.deepStrictEqual(seen, ['h1']);
  });

  it('should offset every batch by batchOffset so imports continue after existing records', async () => {
    const docs = [
      { fileName: 'a.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'b.js', appliedAt: new Date(), migrationBlock: 100 },
      { fileName: 'c.js', appliedAt: new Date(), migrationBlock: 200 },
    ];
    const records = await mapMigrateMongoDocs(docs, { ...baseOptions, batchOffset: 4 });
    const byName = new Map(records.map((r) => [r.name, r.batch]));
    assert.strictEqual(byName.get('a.js'), 5);
    assert.strictEqual(byName.get('b.js'), 6);
    assert.strictEqual(byName.get('c.js'), 7);
  });

  it('should return an empty array for no docs', async () => {
    assert.deepStrictEqual(await mapMigrateMongoDocs([], baseOptions), []);
  });
});
