const { MigrationInvalidNameError } = require('../errors/index.js');

/**
 * Whether `name` is a bare filename: a non-empty string with no path
 * separator, no NUL byte, and not `.`/`..`. The single definition of the rule
 * that keeps a migration name from escaping the migrations directory — shared
 * by the kit's path resolution and by anything that accepts a name from
 * outside the process (a queue job's payload).
 */
function isBareFilename(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

/** Throw MigrationInvalidNameError unless `name` is a bare filename */
function assertMigrationName(name, context = {}) {
  if (!isBareFilename(name)) {
    throw new MigrationInvalidNameError(
      'Invalid migration name — must be a bare filename with no path segments',
      { name, ...context },
    );
  }
}

module.exports = { assertMigrationName, isBareFilename };
