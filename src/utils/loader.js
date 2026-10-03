const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { MigrationFileNotFoundError, MigrationInvalidExportError } = require('../errors/index.js');
const { errorText } = require('./error.js');

/** TypeScript source extensions that require a TS-capable runtime to import */
const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);

/** Distinguishes reload URLs; see importUserFile */
let reloadCounter = 0;

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

/** True when type stripping refused non-erasable syntax (enum, namespace, …) */
function isUnsupportedTsSyntaxError(error) {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX';
}

/**
 * An actionable message for a dynamic-import failure whose cause is a
 * `.ts`/`.mts`/`.cts` file the current runtime refused, or null to let the
 * original error speak for itself. `noun` names what the file is ("migration",
 * "collection definition").
 *
 * The shipped CLI runs as plain Node, whose type stripping (always present on
 * the supported Node >= 22.18 range) handles erasable TypeScript only. Two
 * failure shapes get an actionable message instead of the raw Node error:
 * stripping disabled entirely (`ERR_UNKNOWN_FILE_EXTENSION`, e.g. under
 * `--no-experimental-strip-types`), and non-erasable syntax such as `enum` or
 * `namespace` (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
 */
function tsLoadMessageOrNull(filepath, error, noun) {
  const ext = path.extname(filepath).toLowerCase();
  if (!TS_EXTENSIONS.has(ext)) {
    return null;
  }
  const name = path.basename(filepath);
  if (isUnknownExtensionError(error)) {
    return `Cannot load TypeScript ${noun} "${name}" — type stripping is disabled in this Node process. Re-enable it, run migronaut under a TypeScript loader (e.g. tsx), or author the ${noun} as .js.`;
  }
  if (isUnsupportedTsSyntaxError(error)) {
    return `Cannot load TypeScript ${noun} "${name}" — it uses syntax Node's type stripping cannot erase (e.g. enum, namespace). Rewrite with erasable-only syntax, or run migronaut under a TypeScript loader (e.g. tsx).`;
  }
  return null;
}

/**
 * Translate a dynamic-import failure of a migration into a clear
 * MigrationInvalidExportError (see {@link tsLoadMessageOrNull}), or return
 * null to let the original error propagate.
 */
function tsLoadErrorOrNull(filepath, error) {
  const message = tsLoadMessageOrNull(filepath, error, 'migration');
  if (message === null) {
    return null;
  }
  return new MigrationInvalidExportError(
    message,
    { filepath, cause: errorText(error) },
    { cause: error },
  );
}

/**
 * Import a user-authored module (a migration, a collection definition).
 *
 * Node caches ESM modules by URL forever. A one-shot CLI never notices, but a
 * long-lived process (a test runner, a dev server re-running migrations, a
 * queue worker) would keep evaluating the version it first imported; with
 * `reload` a unique query string forces a fresh evaluation. Off by default —
 * it leaks a module per load. A monotonic counter, not Date.now(): two
 * reloads in one millisecond must still get distinct URLs.
 */
function importUserFile(filepath, options = {}) {
  const url = pathToFileURL(filepath).href;
  return import(options.reload ? `${url}?migronaut=${++reloadCounter}` : url);
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
async function loadMigrationFile(filepath, options = {}) {
  try {
    await fs.access(filepath);
  } catch {
    throw new MigrationFileNotFoundError('Migration file not found', { filepath });
  }

  let imported;
  try {
    imported = await importUserFile(filepath, { reload: options.reload });
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
  if (Number.isInteger(resolved.timeoutMs) && resolved.timeoutMs > 0) {
    migration.timeoutMs = resolved.timeoutMs;
  }
  if (typeof resolved.description === 'string') {
    migration.description = resolved.description;
  }

  return migration;
}

module.exports = { importUserFile, loadMigrationFile, tsLoadErrorOrNull, tsLoadMessageOrNull };
