const fs = require('node:fs/promises');
const { MigrationBlockedError, MigrationFileNotFoundError } = require('../errors/index.js');

/**
 * The migration sequence: the files on disk, in name order, measured against
 * the names the changelog holds as applied — which are pending, which arrived
 * late, which stand in the way of an ordered step, and in what order applied
 * records are reverted. Pure apart from reading the directory; what to do
 * with each answer (refuse, warn, wait) is the kit's decision.
 */

/** Declaration files sit next to TypeScript migrations and are never one */
const DECLARATION_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts'];

/** The migration files in `dir`, sorted ascending — empty when the directory does not exist */
async function listMigrationFiles(dir, extensions) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const matches = [];
  for (const entry of entries) {
    // A directory named `foo.js`, a dotfile, or a `types.d.ts` sitting next
    // to the migrations is not a migration — including it would hard-fail
    // the whole run with MigrationInvalidExportError.
    if (!entry.isFile()) continue;
    const file = entry.name;
    if (file.startsWith('.')) continue;
    if (DECLARATION_SUFFIXES.some((suffix) => file.endsWith(suffix))) continue;
    for (const ext of extensions) {
      if (file.endsWith(ext)) {
        matches.push(file);
        break;
      }
    }
  }
  return matches.sort();
}

/**
 * The files of `sequence` with no applied name — all of them, or only those
 * sorting before `before`. Pending means "no applied record": a `'failed'`
 * trace counts, so a migration that failed stops the line exactly like one
 * that never ran.
 */
function pendingIn(sequence, appliedNames, before) {
  const pending = [];
  for (const file of sequence) {
    if (before !== undefined && file >= before) break;
    if (!appliedNames.has(file)) pending.push(file);
  }
  return pending;
}

/**
 * Keep only the pending migrations up to and including `to`.
 *
 * `to` must name a migration that exists; it may already be applied (then
 * nothing before it is pending either, and the result is empty), which is
 * what makes `up --to X` idempotent — running it twice is a no-op rather
 * than an error.
 */
function truncateAtTarget(pending, allFiles, to) {
  if (!allFiles.includes(to)) {
    throw new MigrationFileNotFoundError('Migration file not found', { to });
  }
  const kept = [];
  for (const file of pending) {
    if (file > to) break;
    kept.push(file);
  }
  return kept;
}

/** The name that sorts last — '' for none */
function newestOf(names) {
  let newest = '';
  for (const name of names) {
    if (name > newest) newest = name;
  }
  return newest;
}

/**
 * Out-of-order arrivals among `targets`: pending files that sort before the
 * newest applied name — migrations merged late from a parallel branch, which
 * will run after migrations authored later. `null` when there are none.
 */
function lateArrivals(targets, appliedNames) {
  if (targets.length === 0 || appliedNames.size === 0) return null;
  const newestApplied = newestOf(appliedNames);
  const late = [];
  for (const target of targets) {
    if (!appliedNames.has(target) && target < newestApplied) late.push(target);
  }
  return late.length > 0 ? { late, newestApplied } : null;
}

/** The names of the records to revert, newest first unless already in revert order */
function revertOrder(records, preserveOrder) {
  const names = [];
  for (const record of records) names.push(record.name);
  if (!preserveOrder) {
    names.sort();
    names.reverse();
  }
  return names;
}

/**
 * The refusal of an ordered step: "`subject` is blocked: N `what`: a, b".
 * `context` carries `blockedBy` (and `failed`, the blockers with a failed
 * trace — a stopped line rather than one still on its way).
 */
function blockedError(subject, what, context) {
  const { blockedBy } = context;
  return new MigrationBlockedError(
    `${subject} is blocked: ${blockedBy.length} ${what}: ${blockedBy.join(', ')}`,
    context,
  );
}

module.exports = {
  blockedError,
  lateArrivals,
  listMigrationFiles,
  newestOf,
  pendingIn,
  revertOrder,
  truncateAtTarget,
};
