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

/**
 * Why a file's `requires` export is not valid: an array of bare migration
 * file names, no duplicates, each sorting strictly before the file itself
 * (`name`). Files run in name order, so an edge that only ever points
 * backwards can never close a cycle — the whole "is it a DAG?" question,
 * answered by the name. Returns `{ path, message }` issues.
 */
function requiresIssues(requires, name) {
  if (requires === undefined) return [];
  if (!Array.isArray(requires)) {
    return [{ path: 'requires', message: 'must be an array of migration file names' }];
  }
  const issues = [];
  const seen = new Set();
  for (const [position, required] of requires.entries()) {
    const path = `requires[${position}]`;
    if (!isBareFilename(required)) {
      issues.push({ path, message: 'must be a bare migration file name' });
    } else if (seen.has(required)) {
      issues.push({ path, message: `names "${required}" twice` });
    } else if (name !== undefined && required >= name) {
      issues.push({
        path,
        message: `must name an earlier migration ("${required}" does not sort before "${name}")`,
      });
    } else {
      seen.add(required);
    }
  }
  return issues;
}

module.exports = { assertMigrationName, isBareFilename, requiresIssues };
