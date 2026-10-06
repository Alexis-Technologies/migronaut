const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MigrationFileNotFoundError,
  MigrationInvalidExportError,
} = require('../../src/errors/index.js');
const {
  importMigrationModule,
  loadMigrationFile,
  resolveMigrationExports,
  tsLoadErrorOrNull,
  tsLoadMessageOrNull,
} = require('../../src/utils/loader.js');

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

describe('tsLoadMessageOrNull', () => {
  it('should name what the file is', () => {
    const message = tsLoadMessageOrNull(
      '/collections/users.ts',
      { code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' },
      'collection definition',
    );
    assert.match(message, /^Cannot load TypeScript collection definition "users\.ts"/);
    assert.match(
      tsLoadMessageOrNull(
        '/c/x.mts',
        { code: 'ERR_UNKNOWN_FILE_EXTENSION' },
        'collection definition',
      ),
      /author the collection definition as \.js/,
    );
  });

  it('should stay silent for anything that is not a TypeScript load failure', () => {
    assert.strictEqual(
      tsLoadMessageOrNull('/c/x.js', { code: 'ERR_UNKNOWN_FILE_EXTENSION' }, 'x'),
      null,
    );
    assert.strictEqual(tsLoadMessageOrNull('/c/x.ts', new Error('boom'), 'x'), null);
  });
});

describe('loadMigrationFile — background migrations and requires', () => {
  it('should load a background file, told apart by its kind', async () => {
    const file = path.join(fixtures, '0100-background-orders.cjs');
    const loaded = await loadMigrationFile(file);
    assert.strictEqual(loaded.kind, 'background');
    assert.strictEqual(loaded.background.collection, 'orders');
    assert.strictEqual(loaded.description, 'Move address into shipping');
    assert.deepStrictEqual(loaded.requires, ['0001-earlier.cjs']);
  });

  it('should refuse a background file that also exports up or down', async () => {
    await assert.rejects(
      loadMigrationFile(path.join(fixtures, '0101-background-with-up.cjs'), {}),
      /exports no up\(\) or down\(\)/,
    );
  });

  it('should read requires, refusing one that points forward', async () => {
    const ok = await loadMigrationFile(path.join(fixtures, '0103-requires-ok.cjs'));
    assert.deepStrictEqual(ok.requires, ['0100-background-orders.cjs']);
    await assert.rejects(
      loadMigrationFile(path.join(fixtures, '0102-requires-later.cjs')),
      (error) =>
        error.code === 'MIGRATION_INVALID_EXPORT' &&
        /must name an earlier migration/.test(error.message),
    );
  });

  it('should split import and export resolution', async () => {
    const resolved = await importMigrationModule(path.join(fixtures, 'valid-cjs.cjs'));
    const migration = resolveMigrationExports(resolved, 'valid-cjs.cjs');
    assert.strictEqual(typeof migration.up, 'function');
    assert.strictEqual(migration.kind, undefined);
  });
});
