const fs = require('node:fs/promises');
const { ImportTargetNotEmptyError } = require('../errors/index.js');
const { computeChecksum } = require('../utils/checksum.js');
const { mapLimit } = require('../utils/concurrency.js');
const { Changelog } = require('./changelog.js');
const { isMigrateMongoDoc, mapMigrateMongoDocs } = require('./import.js');

/** Default source collection name used by migrate-mongo */
const MIGRATE_MONGO_COLLECTION = 'changelog';

/** Simultaneous changelog writes during an import */
const WRITE_CONCURRENCY = 8;

/**
 * Adopt an existing migrate-mongo `changelog` collection by mapping its records
 * into the migronaut schema and writing them to the target collection. The
 * source collection is never modified. Forward-only: it records applied history
 * so `up` skips it correctly — it does not adapt legacy migration file
 * signatures, so `down`/`redo` on imported files is unsupported.
 *
 * Pure orchestration over capabilities the MigratorKit injects (`deps`):
 * `{config, db, changelog, logger, fields, filepath, assertNotAborted}`.
 */
async function runImport(deps, options, signal) {
  const { config, db, changelog, logger } = deps;

  const source = options.from ?? MIGRATE_MONGO_COLLECTION;
  const target = options.to ?? config.migrationsCollection;
  const dryRun = options.dryRun ?? false;

  // Records are written to `target`; reuse the connected changelog when it
  // already points there, otherwise bind a fresh one (and ensure its index).
  const targetChangelog =
    target === config.migrationsCollection ? changelog : new Changelog(target);
  // ensureIndexes (target) and getForeignDocs (source) touch unrelated
  // collections — independent, safe to run concurrently.
  const ensureIndexesPromise =
    targetChangelog !== changelog && !dryRun
      ? targetChangelog.ensureIndexes(db)
      : Promise.resolve();
  const [, rawDocs] = await Promise.all([
    ensureIndexesPromise,
    changelog.getForeignDocs(db, source),
  ]);
  if (rawDocs.length === 0) {
    logger.info(`Nothing to import from "${source}"`, deps.fields({ source, target }));
    return { source, target, imported: 0, skipped: 0, dryRun, rows: [] };
  }

  const valid = [];
  let skipped = 0;
  for (const doc of rawDocs) {
    if (isMigrateMongoDoc(doc)) {
      valid.push(doc);
    } else {
      skipped += 1;
      logger.warn('⚠ Skipping source doc without a usable fileName');
    }
  }

  // `{name, batch}` projections only — numbering new batches and detecting a
  // non-empty target needs neither full documents nor the whole history twice.
  const existing = await targetChangelog.getNamesAndBatches(db);
  if (!options.force && !dryRun && existing.length > 0) {
    throw new ImportTargetNotEmptyError(
      `Target collection "${target}" already has ${existing.length} record(s) — re-run with force to proceed`,
      { target, existing: existing.length },
    );
  }

  // Continue batch numbering after the batches already in the target so imported
  // records never collide with existing ones. Records this import will overwrite
  // (same name) are excluded, keeping a forced re-import's batch numbers stable.
  const incomingNames = new Set();
  for (const doc of valid) incomingNames.add(doc.fileName);
  let batchOffset = 0;
  for (const record of existing) {
    if (!incomingNames.has(record.name) && record.batch > batchOffset) {
      batchOffset = record.batch;
    }
  }

  const rowSources = new Map();
  const records = await mapMigrateMongoDocs(valid, {
    environment: 'imported',
    executedBy: 'migronaut-import',
    batchOffset,
    resolveChecksum: async (fileName, fileHash) => {
      const resolved = await resolveImportChecksum(
        deps.filepath(fileName),
        fileHash,
        options.trustHash ?? false,
      );
      rowSources.set(fileName, resolved.source);
      if (resolved.source === 'missing') {
        logger.warn(`⚠ File not found on disk: ${fileName} — checksum unverifiable`);
      }
      return resolved;
    },
  });

  const rows = [];
  for (const record of records) {
    rows.push({
      file: record.name,
      batch: record.batch,
      appliedAt: record.appliedAt,
      checksum: record.checksum,
      checksumSource: rowSources.get(record.name) ?? 'missing',
    });
  }

  if (dryRun) {
    logger.info(
      `◎ Dry-run  Would import ${rows.length} record(s) from "${source}" → "${target}"`,
      deps.fields({ source, target, count: rows.length, dryRun: true }),
    );
    return { source, target, imported: 0, skipped, dryRun, rows };
  }

  // Independent upserts keyed by unique `name` — safe to run concurrently,
  // but paced so importing a large changelog does not flood the pool. The
  // abort check inside the loop lets stop() / a lost lock halt a long import
  // between writes instead of after all of them.
  await mapLimit(records, WRITE_CONCURRENCY, (record) => {
    deps.assertNotAborted(signal);
    return targetChangelog.markApplied(db, record);
  });

  logger.info(
    `✔ Imported ${records.length} record(s) from "${source}" → "${target}"`,
    deps.fields({ source, target, imported: records.length, skipped }),
  );
  return { source, target, imported: records.length, skipped, dryRun, rows };
}

/**
 * Decide the checksum to store for an imported migration. Order: when
 * `trustHash`, reuse the source `fileHash` if present; otherwise reuse it only
 * when it matches a freshly computed hash (algorithms align), else recompute
 * from disk; when the file is missing, fall back to the source hash or empty.
 */
async function resolveImportChecksum(filepath, fileHash, trustHash) {
  if (trustHash && fileHash) {
    return { checksum: fileHash, source: 'reused' };
  }
  const exists = await fs
    .access(filepath)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    const recomputed = await computeChecksum(filepath);
    if (fileHash && fileHash === recomputed) {
      return { checksum: fileHash, source: 'reused' };
    }
    return { checksum: recomputed, source: 'recomputed' };
  }
  if (fileHash) {
    return { checksum: fileHash, source: 'reused' };
  }
  return { checksum: '', source: 'missing' };
}

module.exports = { runImport };
