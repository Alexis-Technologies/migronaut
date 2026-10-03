/**
 * The converge history: one append-only document per converge that changed
 * something or failed (`_migronaut_converge` by default). Converge itself is
 * stateless — it reads the live database and the declarations every time —
 * so this is not state it acts on; it is the audit trail a migration gets
 * from the changelog: who dropped which index, when, and why.
 *
 * Mechanism only, like changelog.js: no logger, no decisions about what to
 * record — converge.js builds the entry.
 */
class ConvergeLog {
  #collectionName;
  #indexed = false;

  constructor(collectionName) {
    this.#collectionName = collectionName;
  }

  #coll(db) {
    return db.collection(this.#collectionName);
  }

  /**
   * Append one entry. The `startedAt` index is created with the first entry
   * this instance writes, not at connect: a database that never converges
   * gets no history collection at all.
   */
  async append(db, entry) {
    if (!this.#indexed) {
      await this.#coll(db).createIndex({ startedAt: -1 }, { name: 'startedAt' });
      this.#indexed = true;
    }
    await this.#coll(db).insertOne({ ...entry });
  }

  /** The newest `limit` entries, newest first */
  async list(db, limit) {
    return this.#coll(db)
      .find({})
      .sort({ startedAt: -1 })
      .limit(limit)
      .project({ _id: 0 })
      .toArray();
  }
}

module.exports = { ConvergeLog };
