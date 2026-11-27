const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MigrationFileNotFoundError,
  MigrationInvalidExportError,
  MigrationLoadFailedError,
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

  it('should type a non-TypeScript import failure, the original as its cause', async () => {
    const file = path.join(fixtures, 'throws-on-import.cjs');
    await assert.rejects(loadMigrationFile(file), (error) => {
      assert.ok(error instanceof MigrationLoadFailedError);
      assert.strictEqual(error.code, 'ALX_ERR_MIGRATION_LOAD_FAILED');
      assert.match(error.cause.message, /boom at import time/);
      assert.match(error.context.cause, /boom at import time/);
      // Relative to the working directory: an absolute path names the user's home.
      assert.strictEqual(error.context.filepath, path.relative(process.cwd(), file));
      return true;
    });
  });
});

describe('resolveMigrationExports', () => {
  const up = async () => undefined;
  const down = async () => undefined;

  it('should refuse an optional export that is present but not of its kind', () => {
    const cases = [
      [{ useTransaction: 'true' }, /useTransaction must be a boolean/],
      [{ timeoutMs: '5000' }, /timeoutMs must be a positive integer/],
      [{ timeoutMs: 0 }, /timeoutMs must be a positive integer/],
      [{ timeoutMs: 2 ** 31 }, /at most 2147483647/],
      [{ description: 1 }, /description must be a string/],
    ];
    for (const [extra, message] of cases) {
      assert.throws(() => resolveMigrationExports({ up, down, ...extra }, 'x.js'), {
        code: 'ALX_ERR_MIGRATION_INVALID_EXPORT',
        message,
      });
    }
  });

  it('should refuse a known export mistyped, and name the one it meant', () => {
    const cases = [
      ['useTransactions', 'useTransaction'],
      ['timeoutMS', 'timeoutMs'],
      ['require', 'requires'],
      ['Description', 'description'],
    ];
    for (const [typo, meant] of cases) {
      assert.throws(() => resolveMigrationExports({ up, down, [typo]: true }, 'x.js'), {
        code: 'ALX_ERR_MIGRATION_INVALID_EXPORT',
        message: `Unknown export '${typo}' — did you mean '${meant}'?`,
      });
    }
  });

  it('should leave the module its own helpers, and an export left undefined', () => {
    const migration = resolveMigrationExports(
      { up, down, seedUsers: () => undefined, timeoutMs: undefined },
      'x.js',
    );
    assert.strictEqual(migration.up, up);
    assert.strictEqual(migration.timeoutMs, undefined);
  });
});

describe('loadMigrationFile — reload', () => {
  const body = (label) => `async function up() { return '${label}'; }\nasync function down() {}\n`;
  const sources = {
    // CommonJS: what `migronaut create` scaffolds, for .js and .ts alike.
    'reload.js': (label) => `${body(label)}module.exports = { up, down };\n`,
    'reload.cjs': (label) => `${body(label)}module.exports = { up, down };\n`,
    'reload.ts': (label) => `${body(label)}module.exports = { up, down };\n`,
    'reload.mjs': (label) => `${body(label)}export { up, down };\n`,
  };

  for (const [file, source] of Object.entries(sources)) {
    it(`should run the edited version of ${file}, not the one first loaded`, async (t) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'migronaut-reload-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const filepath = path.join(dir, file);
      writeFileSync(filepath, source('first'));
      const first = await loadMigrationFile(filepath, { reload: true });
      assert.strictEqual(await first.up(), 'first');
      writeFileSync(filepath, source('edited'));
      // The query string alone reloaded ES modules only: a CommonJS file kept
      // running as 'first' — and was recorded under the edited file's checksum.
      const edited = await loadMigrationFile(filepath, { reload: true });
      assert.strictEqual(await edited.up(), 'edited');
    });
  }

  it('should keep the version first loaded without reload — the module cache, as documented', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'migronaut-reload-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const filepath = path.join(dir, 'cached.js');
    writeFileSync(filepath, sources['reload.js']('first'));
    assert.strictEqual(await (await loadMigrationFile(filepath)).up(), 'first');
    writeFileSync(filepath, sources['reload.js']('edited'));
    assert.strictEqual(await (await loadMigrationFile(filepath)).up(), 'first');
  });

  it('should reload a CommonJS file reached through a symlinked directory', async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'migronaut-reload-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, 'real'));
    // A junction on Windows, which needs no privilege; a symlink elsewhere.
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'junction');
    const filepath = path.join(dir, 'link', 'linked.js');
    writeFileSync(filepath, sources['reload.js']('first'));
    assert.strictEqual(await (await loadMigrationFile(filepath, { reload: true })).up(), 'first');
    writeFileSync(filepath, sources['reload.js']('edited'));
    assert.strictEqual(await (await loadMigrationFile(filepath, { reload: true })).up(), 'edited');
  });

  it('should reload a file whose link spells its target another way', async (t) => {
    // The module loader caches a file under its real path as Node's own
    // resolver spells it — the JavaScript realpath, which keeps the spelling a
    // link holds — while the native one asks the OS, which may spell it
    // otherwise: a Windows 8.3 name expanded (C:\Users\RUNNER~1 on CI), another
    // case on a case-insensitive disk. Asked of the native one, the reload
    // dropped a key the cache did not have, and the edited file never ran.
    const dir = mkdtempSync(path.join(tmpdir(), 'migronaut-reload-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, 'real'));
    if (!existsSync(path.join(dir, 'REAL'))) {
      t.skip('a case-sensitive file system: no second spelling of a path');
      return;
    }
    symlinkSync(path.join(dir, 'REAL'), path.join(dir, 'link'), 'junction');
    const filepath = path.join(dir, 'link', 'spelled.js');
    writeFileSync(filepath, sources['reload.js']('first'));
    assert.strictEqual(await (await loadMigrationFile(filepath, { reload: true })).up(), 'first');
    writeFileSync(filepath, sources['reload.js']('edited'));
    assert.strictEqual(await (await loadMigrationFile(filepath, { reload: true })).up(), 'edited');
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
        error.code === 'ALX_ERR_MIGRATION_INVALID_EXPORT' &&
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
