const { ImportTargetNotEmptyError, MigronautError } = require('../errors/index.js');
const { computeChecksum } = require('../utils/checksum.js');
const { Changelog } = require('./changelog.js');
const { isMigrateMongoDoc, mapMigrateMongoDocs } = require('./import.js');

/** Default source collection name used by migrate-mongo */
const MIGRATE_MONGO_COLLECTION = 'changelog';

/** Records per bulkWrite — bounds a single request while keeping round trips rare */
const IMPORT_CHUNK_SIZE = 1000;

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
      // The _id is the only handle the operator has for locating the offending
      // source document — an anonymous count is undebuggable after the fact.
      // String() keeps an ObjectId safe for any sink; the default logger
      // already sanitizes terminal escapes in DB-derived text.
      logger.warn(
        `⚠ Skipping source doc without a usable fileName (_id: ${String(doc?._id)})`,
        deps.fields({ source, docId: String(doc?._id) }),
      );
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
        logger.warn(
          `⚠ File not found on disk: ${fileName} — checksum unverifiable`,
          deps.fields({ file: fileName, checksumSource: 'missing' }),
        );
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

  // One unordered bulkWrite per chunk instead of one updateOne per record —
  // adopting a 5,000-record changelog is 5 round trips, not 5,000, all while
  // holding the migration lock. The abort check between chunks lets stop() /
  // a lost lock halt a long import instead of running it to completion.
  let written = 0;
  try {
    for (let start = 0; start < records.length; start += IMPORT_CHUNK_SIZE) {
      deps.assertNotAborted(signal);
      await targetChangelog.markAppliedBulk(db, records.slice(start, start + IMPORT_CHUNK_SIZE));
      written += Math.min(IMPORT_CHUNK_SIZE, records.length - start);
    }
  } catch (error) {
    // Earlier chunks are already committed; without a count the operator only
    // discovers the half-populated target when the next plain `import` throws
    // ImportTargetNotEmptyError. Recovery is safe — the upserts are keyed on
    // `name`, so a --force re-run is idempotent and simply resumes.
    logger.warn(
      `⚠ Import interrupted after ${written}/${records.length} record(s) — ` +
        'a --force re-run is idempotent and will resume',
      deps.fields({ source, target, imported: written, total: records.length }),
    );
    if (error instanceof MigronautError && error.context) {
      error.context = { ...error.context, imported: written, total: records.length };
    }
    throw error;
  }

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
  // computeChecksum directly, treating ENOENT as "missing" — an access()
  // probe first would double the syscalls and open a TOCTOU window in which
  // the answer can change anyway.
  let recomputed;
  try {
    recomputed = await computeChecksum(filepath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (fileHash) {
      return { checksum: fileHash, source: 'reused' };
    }
    return { checksum: '', source: 'missing' };
  }
  if (fileHash && fileHash === recomputed) {
    return { checksum: fileHash, source: 'reused' };
  }
  return { checksum: recomputed, source: 'recomputed' };
}

module.exports = { runImport };
