const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MigrationFileNotFoundError,
  MigrationInvalidExportError,
} = require('../../src/errors/index.js');
const { loadMigrationFile, tsLoadErrorOrNull } = require('../../src/utils/loader.js');

const here = __dirname;
const fixtures = path.join(here, '..', 'fixtures', 'migrations');

describe('loadMigrationFile', () => {
  it('should load a TypeScript ESM migration with metadata', async () => {
    const mod = await loadMigrationFile(path.join(fixtures, 'valid-ts.ts'));
    assert.strictEqual(typeof mod.up, 'function');
    assert.strictEqual(typeof mod.down, 'function');
    assert.strictEqual(mod.useTransaction, true);
    assert.strictEqual(mod.description, 'A valid TypeScript migration');
  });

  it('should load a JavaScript ESM migration with named exports', async () => {
    const mod = await loadMigrationFile(path.join(fixtures, 'valid-esm.js'));
    assert.strictEqual(typeof mod.up, 'function');
    assert.strictEqual(typeof mod.down, 'function');
    assert.strictEqual(mod.useTransaction, undefined);
  });

  it('should load a CommonJS default-export migration', async () => {
    const mod = await loadMigrationFile(path.join(fixtures, 'valid-cjs.cjs'));
    assert.strictEqual(typeof mod.up, 'function');
    assert.strictEqual(typeof mod.down, 'function');
    assert.strictEqual(mod.useTransaction, false);
    assert.strictEqual(mod.description, 'A valid CommonJS migration');
  });

  it('should throw MigrationFileNotFoundError for a missing file', async () => {
    await assert.rejects(
      loadMigrationFile(path.join(fixtures, 'nope.ts')),
      MigrationFileNotFoundError,
    );
  });

  it('should throw MigrationInvalidExportError when down() is missing', async () => {
    await assert.rejects(
      loadMigrationFile(path.join(fixtures, 'invalid-no-down.ts')),
      MigrationInvalidExportError,
    );
  });

  it('should rethrow a non-TypeScript import failure unchanged', async () => {
    await assert.rejects(
      loadMigrationFile(path.join(fixtures, 'throws-on-import.cjs')),
      /boom at import time/,
    );
  });
});

describe('tsLoadErrorOrNull', () => {
  const unknownExt = {
    code: 'ERR_UNKNOWN_FILE_EXTENSION',
    message: 'Unknown file extension ".ts"',
  };

  it('should map an unknown-extension failure on a .ts file to a clear error', () => {
    const result = tsLoadErrorOrNull('/migrations/0001-x.ts', unknownExt);
    assert.ok(result instanceof MigrationInvalidExportError);
    assert.ok(result.message.includes('TypeScript'));
  });

  it('should also handle .mts and .cts files', () => {
    assert.ok(
      tsLoadErrorOrNull('/m/0001-x.mts', unknownExt) instanceof MigrationInvalidExportError,
    );
    assert.ok(
      tsLoadErrorOrNull('/m/0001-x.cts', unknownExt) instanceof MigrationInvalidExportError,
    );
  });

  it('should return null for a .js file (not a TypeScript problem)', () => {
    assert.strictEqual(tsLoadErrorOrNull('/migrations/0001-x.js', unknownExt), null);
  });

  it('should return null when the error is unrelated to the file extension', () => {
    assert.strictEqual(tsLoadErrorOrNull('/migrations/0001-x.ts', new Error('boom')), null);
  });

  it('should return null when the error is not an object', () => {
    assert.strictEqual(tsLoadErrorOrNull('/migrations/0001-x.ts', 'a string error'), null);
    assert.strictEqual(tsLoadErrorOrNull('/migrations/0001-x.ts', null), null);
  });

  it('should detect the failure via the error message on an Error instance', () => {
    const err = new Error('Unknown file extension ".ts" for /x.ts');
    const result = tsLoadErrorOrNull('/migrations/0001-x.ts', err);
    assert.ok(result instanceof MigrationInvalidExportError);
    assert.strictEqual(result.context?.cause, err.message);
  });
});
