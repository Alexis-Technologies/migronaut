/**
 * Reads and writes migration records in the changelog collection
 * (`_migronaut_migrations` by default).
 *
 * Records are an append-mostly audit trail: reverting a migration updates its
 * status to `'reverted'` and stamps `revertedAt` — it never deletes the record.
 */
class Changelog {
  #collectionName;

  constructor(collectionName) {
    this.#collectionName = collectionName;
  }

  #coll(db) {
    return db.collection(this.#collectionName);
  }

  /**
   * Create the indexes the read paths actually use. Safe to call repeatedly.
   *
   * Beyond the unique `name` index: `{status, batch}` serves the highest-batch
   * lookups (which would otherwise be a blocking in-memory sort, capped at
   * 32 MB), `{batch}` serves rollback by batch, `{status, name}` makes the
   * hottest query of all — the applied set, sorted by name, read on every
   * `up`/`status`/health check — a covered, sort-free index scan, and
   * `{status, appliedAt, name}` does the same for the newest-first ordering
   * that `redo` and `down --steps` sort by.
   */
  async ensureIndexes(db) {
    await this.#coll(db).createIndexes([
      { key: { name: 1 }, name: 'name_unique', unique: true },
      { key: { status: 1, batch: -1 }, name: 'status_batch' },
      { key: { batch: 1 }, name: 'batch' },
      { key: { status: 1, name: 1 }, name: 'status_name' },
      { key: { status: 1, appliedAt: -1, name: -1 }, name: 'status_appliedAt_name' },
    ]);
  }

  /**
   * Read every raw document from a foreign collection (e.g. a migrate-mongo
   * `changelog`). Returns untyped docs since the source schema differs from
   * ours — the caller is responsible for validating and mapping them. Projected
   * down to the fields the import mapping consumes, so adopting a large
   * changelog does not pull every legacy payload into memory.
   */
  async getForeignDocs(db, collectionName) {
    return db
      .collection(collectionName)
      .find()
      .project({ fileName: 1, fileHash: 1, appliedAt: 1, migrationBlock: 1, _id: 0 })
      .toArray();
  }

  /**
   * Every record's `{name, batch}` only — what `import` needs to number new
   * batches and detect a non-empty target without loading full documents.
   */
  async getNamesAndBatches(db) {
    return this.#coll(db).find().project({ name: 1, batch: 1, _id: 0 }).toArray();
  }

  /**
   * The most recently applied record (by `appliedAt`, name-desc tiebreak), or
   * null. A server-side top-1 sort+limit — never the whole history in memory.
   */
  async getNewestApplied(db) {
    const docs = await this.#coll(db)
      .find({ status: 'applied' })
      .sort({ appliedAt: -1, name: -1 })
      .limit(1)
      .toArray();
    return docs[0] ?? null;
  }

  /** Return every changelog record, sorted by name ascending */
  async getAll(db) {
    return this.#coll(db).find().sort({ name: 1 }).toArray();
  }

  /** Return the names of all currently-applied migrations */
  async getAppliedNames(db) {
    const docs = await this.#coll(db)
      .find({ status: 'applied' })
      .sort({ name: 1 })
      .project({ name: 1, _id: 0 })
      .toArray();
    const names = [];
    for (const doc of docs) names.push(doc.name);
    return names;
  }

  /** Return a single record by migration name, or null */
  async getByName(db, name) {
    return this.#coll(db).findOne({ name });
  }

  /**
   * Every currently-applied record's `{name, checksum}`, sorted by name
   * ascending — exactly what the strict bulk drift check consumes (the name
   * doubles as the applied-set key). Projected like the module's other reads;
   * widen the projection if a new caller needs more.
   */
  async getApplied(db) {
    return this.#coll(db)
      .find({ status: 'applied' })
      .sort({ name: 1 })
      .project({ _id: 0, name: 1, checksum: 1 })
      .toArray();
  }

  /**
   * The last N applied records, newest first (by `appliedAt`, name-desc
   * tiebreak) — the server-side counterpart of `down --steps`. A covered
   * sort+limit on the `status_appliedAt_name` index: never the whole applied
   * history transferred and re-sorted client-side just to slice N.
   */
  async getLastAppliedN(db, n) {
    return this.#coll(db)
      .find({ status: 'applied' })
      .sort({ appliedAt: -1, name: -1 })
      .limit(n)
      .toArray();
  }

  /**
   * Applied records named strictly after `name`, ascending — what `down --to`
   * reverts. The predicate is pushed down onto the `status_name` index instead
   * of filtering the full applied history in JS.
   */
  async getAppliedAfter(db, name) {
    return this.#coll(db)
      .find({ status: 'applied', name: { $gt: name } })
      .sort({ name: 1 })
      .toArray();
  }

  /** Return the highest batch number among currently-applied migrations, or null */
  async getLastBatch(db) {
    const docs = await this.#coll(db)
      .find({ status: 'applied' })
      .sort({ batch: -1 })
      .limit(1)
      .project({ batch: 1, _id: 0 })
      .toArray();
    return docs[0]?.batch ?? null;
  }

  /**
   * Highest batch number ever used, including reverted records — the basis for
   * the next batch, so numbers stay monotonic across rollbacks. An indexed
   * sort+limit, not a full scan.
   */
  async getMaxBatch(db) {
    const docs = await this.#coll(db)
      .find({})
      .sort({ batch: -1 })
      .limit(1)
      .project({ batch: 1, _id: 0 })
      .toArray();
    return docs[0]?.batch ?? 0;
  }

  /** Return all records belonging to a given batch */
  async getByBatch(db, batch) {
    return this.#coll(db).find({ batch }).sort({ name: 1 }).toArray();
  }

  /**
   * The update document shared by markApplied and markAppliedBulk.
   *
   * `appliedAt` is stamped in **server time** (`$currentDate`) when the record
   * does not carry one — the same clock discipline the lock's `$$NOW` uses:
   * `redo` and `down --steps` sort by `appliedAt`, and a client-stamped value
   * lets a skewed host mis-order the revert selection. An explicit `appliedAt`
   * (import adopting a legacy changelog's historical timestamps) is written
   * verbatim. `firstAppliedAt` is audit-only metadata, never sorted on, so its
   * client-clock `$setOnInsert` fallback is acceptable ($setOnInsert cannot
   * express server time).
   */
  static #appliedUpdate(record) {
    // `name` comes from the filter on insert, so it must not also appear in an
    // update operator (MongoDB rejects the conflicting path).
    const { name, appliedAt, ...fields } = record;
    const update = {
      $set: fields,
      // A re-apply clears the stale revert marker — and the failure trace a
      // markFailed() from an earlier crashed attempt may have left.
      $unset: { revertedAt: '', failedAt: '', error: '' },
    };
    if (appliedAt !== undefined) {
      update.$set.appliedAt = appliedAt;
      update.$setOnInsert = { firstAppliedAt: appliedAt };
    } else {
      update.$currentDate = { appliedAt: true };
      update.$setOnInsert = { firstAppliedAt: new Date() };
    }
    return update;
  }

  /**
   * Record a migration as applied. Upserts on `name` so re-applying a
   * previously-reverted migration (e.g. via `redo`) cannot violate the unique
   * index. Uses `$set` rather than a whole-document replace so audit fields
   * survive a re-apply: `firstAppliedAt` is stamped once, and the stale
   * `revertedAt` from an earlier rollback is cleared. `appliedAt` is stamped
   * server-side unless the record carries one — see {@link #appliedUpdate}.
   *
   * Pass `session` to make this write part of the migration's transaction, so
   * the migration and its changelog record commit together.
   */
  async markApplied(db, record, session) {
    await this.#coll(db).updateOne({ name: record.name }, Changelog.#appliedUpdate(record), {
      upsert: true,
      ...(session ? { session } : {}),
    });
  }

  /**
   * Bulk counterpart of {@link markApplied}: one unordered bulkWrite instead of
   * one round trip per record. Identical upsert-on-name semantics; the
   * operations are independent (unique `name` keys), so unordered is safe and
   * lets the server parallelize. Used by `import`, whose record count is set by
   * whatever legacy changelog is being adopted.
   */
  async markAppliedBulk(db, records) {
    if (records.length === 0) return;
    const ops = new Array(records.length);
    for (let i = 0; i < records.length; i++) {
      ops[i] = {
        updateOne: {
          filter: { name: records[i].name },
          update: Changelog.#appliedUpdate(records[i]),
          upsert: true,
        },
      };
    }
    await this.#coll(db).bulkWrite(ops, { ordered: false });
  }

  /**
   * Mark a migration as reverted. Sets `status='reverted'` and `revertedAt=now`.
   * Never deletes the record — preserves the full audit history.
   *
   * Pass `session` to commit this together with the migration's `down()`.
   *
   * Returns the driver's update result: `matchedCount === 0` means the record
   * was no longer `'applied'` (a concurrent peer got there first) — the caller
   * decides what to do with that, since this module stays logger-free.
   */
  async markReverted(db, name, session) {
    return this.#coll(db).updateOne(
      { name, status: 'applied' },
      // Server time, like markApplied's appliedAt — one clock for the whole trail.
      { $set: { status: 'reverted' }, $currentDate: { revertedAt: true } },
      session ? { session } : {},
    );
  }

  /**
   * Best-effort trace of a failed `up` attempt, so a crash-and-restart leaves
   * DB-side evidence of what was in flight ("did the crashed run start X?")
   * instead of depending on process logs that may not have been captured.
   *
   * The filter excludes `'applied'` records: a forced re-run's failure must
   * never demote a migration the changelog says is applied — the upsert then
   * collides on the unique `name` index, and the caller swallows that. Every
   * read path filters on `status: 'applied'`, so a `'failed'` record never
   * changes what runs; the next successful apply overwrites it (and clears
   * `failedAt`/`error`).
   */
  async markFailed(db, record) {
    const { name, ...fields } = record;
    await this.#coll(db).updateOne(
      { name, status: { $ne: 'applied' } },
      { $set: { ...fields, status: 'failed' }, $currentDate: { failedAt: true } },
      { upsert: true },
    );
  }
}

module.exports = { Changelog };
