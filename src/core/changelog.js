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
   * Record a migration as applied. Uses an upsert keyed on `name` so that
   * re-applying a previously-reverted migration (e.g. via `redo`) overwrites
   * its record without violating the unique index.
   */
  async markApplied(db, record) {
    await this.#coll(db).replaceOne({ name: record.name }, record, { upsert: true });
  }

  /**
   * Mark a migration as reverted. Sets `status='reverted'` and `revertedAt=now`.
   * Never deletes the record — preserves the full audit history.
   */
  async markReverted(db, name) {
    await this.#coll(db).updateOne(
      { name, status: 'applied' },
      { $set: { status: 'reverted', revertedAt: new Date() } },
    );
  }
}

module.exports = { Changelog };
