const { computeChecksum } = require('../utils/checksum.js');
const { mapLimit } = require('../utils/concurrency.js');

/** Simultaneous file hashes — same EMFILE bound as every other multi-file path */
const FS_CONCURRENCY = 16;

/**
 * Adopt an existing database with no prior migration tool: mark migration
 * files on disk as applied — checksums taken from disk, one shared batch,
 * `origin: 'baseline'` — without executing anything. The database is assumed
 * to already be in the state those files describe (they were applied by hand,
 * by a home-grown script, or reconstructed after the fact).
 *
 * Forward-only: baselined records were never executed by migronaut, so
 * `down`/`redo` refuse them (the same `origin` preflight import uses).
 * Idempotent: already-applied names are skipped, so a partial baseline can
 * simply be re-run.
 *
 * Pure orchestration over capabilities the MigratorKit injects (`deps`):
 * `{db, changelog, logger, fields, filepath, listMigrationFiles, nextBatch,
 * truncateAtTarget, environment, executedBy, runId, assertNotAborted}`.
 */
async function runBaseline(deps, options, signal) {
  const { db, changelog, logger } = deps;

  const files = await deps.listMigrationFiles();
  const applied = new Set(await changelog.getAppliedNames(db));
  let targets = [];
  for (const file of files) {
    if (!applied.has(file)) targets.push(file);
  }
  if (options.to !== undefined) {
    targets = deps.truncateAtTarget(targets, files, options.to);
  }
  const skipped = files.length - targets.length;

  if (targets.length === 0) {
    logger.info('Nothing to baseline', deps.fields({ skipped }));
    return { baselined: [], skipped, batch: null };
  }

  // Checksums come from the files as they are NOW — that is the contract: the
  // baseline asserts "the database already matches these exact files", and
  // later drift checks police edits against this snapshot.
  const checksums = await mapLimit(targets, FS_CONCURRENCY, (name) =>
    computeChecksum(deps.filepath(name)),
  );

  const batch = await deps.nextBatch();
  const records = new Array(targets.length);
  for (let i = 0; i < targets.length; i++) {
    records[i] = {
      name: targets[i],
      batch,
      status: 'applied',
      // No appliedAt: the changelog stamps it in server time.
      duration: 0,
      checksum: checksums[i],
      environment: deps.environment(),
      executedBy: deps.executedBy(),
      origin: 'baseline',
      ...(deps.runId() ? { runId: deps.runId() } : {}),
    };
  }

  // One write, checked against the abort signal first: a baseline is all
  // bookkeeping, so there is no safe partial point worth resuming from — and
  // markAppliedBulk's upsert-by-name makes a re-run after any failure
  // idempotent anyway.
  deps.assertNotAborted(signal);
  await changelog.markAppliedBulk(db, records);

  logger.info(
    `✔ Baselined ${records.length} migration(s) as applied (batch ${batch})`,
    deps.fields({ baselined: records.length, skipped, batch }),
  );
  return { baselined: targets, skipped, batch };
}

module.exports = { runBaseline };
