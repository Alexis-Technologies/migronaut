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

  /** Create the unique index on `name`. Safe to call repeatedly */
  async ensureIndexes(db) {
    await this.#coll(db).createIndex({ name: 1 }, { unique: true });
  }

  /** Count records currently in the changelog collection */
  async count(db) {
    return this.#coll(db).countDocuments();
  }

  /**
   * Read every raw document from a foreign collection (e.g. a migrate-mongo
   * `changelog`). Returns untyped docs since the source schema differs from
   * ours — the caller is responsible for validating and mapping them.
   */
  async getForeignDocs(db, collectionName) {
    return db.collection(collectionName).find().toArray();
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

  /** Return the highest batch number among currently-applied migrations, or null */
  async getLastBatch(db) {
    const docs = await this.#coll(db)
      .find({ status: 'applied' })
      .sort({ batch: -1 })
      .limit(1)
      .toArray();
    return docs[0]?.batch ?? null;
  }

  /** Return all records belonging to a given batch */
  async getByBatch(db, batch) {
    return this.#coll(db).find({ batch }).sort({ name: 1 }).toArray();
  }

  /**
   * Record a migration as applied. Upserts on `name` so re-applying a
   * previously-reverted migration (e.g. via `redo`) cannot violate the unique
   * index. Uses `$set` rather than a whole-document replace so audit fields
   * survive a re-apply: `firstAppliedAt` is stamped once, and the stale
   * `revertedAt` from an earlier rollback is cleared.
   *
   * Pass `session` to make this write part of the migration's transaction, so
   * the migration and its changelog record commit together.
   */
  async markApplied(db, record, session) {
    // `name` comes from the filter on insert, so it must not also appear in an
    // update operator (MongoDB rejects the conflicting path).
    const { name, ...fields } = record;
    await this.#coll(db).updateOne(
      { name },
      {
        $set: fields,
        $setOnInsert: { firstAppliedAt: record.appliedAt },
        $unset: { revertedAt: '' },
      },
      { upsert: true, ...(session ? { session } : {}) },
    );
  }

  /**
   * Mark a migration as reverted. Sets `status='reverted'` and `revertedAt=now`.
   * Never deletes the record — preserves the full audit history.
   *
   * Pass `session` to commit this together with the migration's `down()`.
   */
  async markReverted(db, name, session) {
    await this.#coll(db).updateOne(
      { name, status: 'applied' },
      { $set: { status: 'reverted', revertedAt: new Date() } },
      session ? { session } : {},
    );
  }
}

module.exports = { Changelog };
