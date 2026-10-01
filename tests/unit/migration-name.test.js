const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { MigrationInvalidNameError } = require('../../src/errors/index.js');
const { assertMigrationName, isBareFilename } = require('../../src/utils/migration-name.js');

describe('isBareFilename', () => {
  for (const name of ['0001-a.js', '20240526143021-add-users.ts', 'a', 'with space.js', '.env']) {
    it(`should accept ${JSON.stringify(name)}`, () => {
      assert.strictEqual(isBareFilename(name), true);
    });
  }

  // Every one of these would let a name leave the migrations directory, or is
  // not a name at all (a query operator smuggled in as an object).
  const rejected = [
    '',
    '.',
    '..',
    '../../etc/passwd',
    'sub/0001-a.js',
    'sub\\0001-a.js',
    '0001-a.js\0.png',
    42,
    null,
    undefined,
    ['0001-a.js'],
    { $ne: null },
  ];
  for (const name of rejected) {
    it(`should reject ${JSON.stringify(name) ?? String(name)}`, () => {
      assert.strictEqual(isBareFilename(name), false);
    });
  }
});

describe('assertMigrationName', () => {
  it('should pass a bare filename through', () => {
    assert.doesNotThrow(() => assertMigrationName('0001-a.js'));
  });

  it('should throw a typed error carrying the name and any extra context', () => {
    assert.throws(
      () => assertMigrationName('../x.js', { jobId: '7' }),
      (error) => {
        assert.ok(error instanceof MigrationInvalidNameError);
        assert.deepStrictEqual(error.context, { name: '../x.js', jobId: '7' });
        return true;
      },
    );
  });
});
