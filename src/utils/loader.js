const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MigrationFileNotFoundError, MigrationInvalidExportError } = require('../errors/index.js');

/** TypeScript source extensions that require a TS-capable runtime to import */
const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);

/** Narrow an unknown value to a function */
function isFunction(value) {
  return typeof value === 'function';
}

/** True when an import failed because Node cannot load the file's extension */
function isUnknownExtensionError(error) {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, message } = error;
  return (
    code === 'ERR_UNKNOWN_FILE_EXTENSION' ||
    (typeof message === 'string' && message.includes('Unknown file extension'))
  );
}

/**
 * Translate a dynamic-import failure into a clear MigrationInvalidExportError
 * when the cause is a `.ts`/`.mts`/`.cts` file that the current Node runtime cannot
 * load, or return null to let the original error propagate.
 *
 * The shipped CLI runs as plain Node, where importing TypeScript only works on a
 * runtime with type stripping (Node >= 22.18) or under a loader such as `tsx`. On
 * older runtimes `import('foo.ts')` throws a cryptic `ERR_UNKNOWN_FILE_EXTENSION`;
 * this surfaces an actionable message instead.
 */
function tsLoadErrorOrNull(filepath, error) {
  const ext = path.extname(filepath).toLowerCase();
  if (!TS_EXTENSIONS.has(ext) || !isUnknownExtensionError(error)) {
    return null;
  }
  const name = path.basename(filepath);
  return new MigrationInvalidExportError(
    `Cannot load TypeScript migration "${name}" — this Node runtime cannot import .ts files. Use Node >= 22.18, run migronaut under a TypeScript loader (e.g. tsx), or author the migration as .js.`,
    { filepath, cause: error instanceof Error ? error.message : String(error) },
  );
}

/**
 * Dynamically load a migration file and validate its exports.
 *
 * Handles all three supported formats:
 * - TypeScript / JavaScript ESM named exports (`export async function up/down`)
 * - CommonJS default export (`module.exports = { up, down }`)
 *
 * @throws {MigrationFileNotFoundError} when the file does not exist
 * @throws {MigrationInvalidExportError} when up/down are not both functions
 */
async function loadMigrationFile(filepath) {
  try {
    await fs.access(filepath);
  } catch {
    throw new MigrationFileNotFoundError('Migration file not found', { filepath });
  }

  let imported;
  try {
    imported = await import(pathToFileURL(filepath).href);
  } catch (error) {
    const tsError = tsLoadErrorOrNull(filepath, error);
    if (tsError) {
      throw tsError;
    }
    throw error;
  }
  // `mod.default ?? mod` handles the CommonJS default-export case
  const resolved = imported.default ?? imported;

  if (!isFunction(resolved.up) || !isFunction(resolved.down)) {
    throw new MigrationInvalidExportError('Migration must export async up() and down() functions', {
      filepath,
    });
  }

  const migration = { up: resolved.up, down: resolved.down };

  if (typeof resolved.useTransaction === 'boolean') {
    migration.useTransaction = resolved.useTransaction;
  }
  if (typeof resolved.description === 'string') {
    migration.description = resolved.description;
  }

  return migration;
}

module.exports = { tsLoadErrorOrNull, loadMigrationFile };
