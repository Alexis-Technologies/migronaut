/** Returns true when a value looks like a usable migrate-mongo changelog doc */
function isMigrateMongoDoc(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.fileName === 'string' &&
    value.fileName.length > 0
  );
}

/** Apply-order sort key for a doc — its run timestamp, falling back to apply time */
function orderKey(doc) {
  return doc.migrationBlock ?? new Date(doc.appliedAt).getTime();
}

/**
 * Map migrate-mongo changelog docs into migronaut MigrationRecords.
 * Pure: all impure inputs (disk checksums, env identity) arrive via `options`.
 *
 * Each migration gets a **unique** batch number, assigned sequentially in apply
 * order (`migrationBlock`, then `appliedAt`, then filename) starting at
 * `batchOffset + 1`. Run-grouping is deliberately not preserved: imported records
 * are forward-only (migronaut refuses to `down` them), so a shared batch would only
 * produce confusing duplicate batch ids with no rollback benefit.
 */
function mapMigrateMongoDocs(docs, options) {
  const offset = options.batchOffset ?? 0;
  const sorted = [...docs].sort((a, b) => {
    const delta = orderKey(a) - orderKey(b);
    return delta !== 0 ? delta : a.fileName.localeCompare(b.fileName);
  });

  return sorted.map((doc, index) => {
    const { checksum } = options.resolveChecksum(doc.fileName, doc.fileHash);
    return {
      name: doc.fileName,
      batch: offset + index + 1,
      status: 'applied',
      appliedAt: new Date(doc.appliedAt),
      duration: 0,
      checksum,
      environment: options.environment,
      executedBy: options.executedBy,
      // Marks the record forward-only: migronaut down/redo will refuse it.
      origin: 'migrate-mongo',
    };
  });
}

module.exports = { isMigrateMongoDoc, mapMigrateMongoDocs };
