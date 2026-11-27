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
  #isIndexed = false;

  constructor(collectionName) {
    this.#collectionName = collectionName;
  }

  #coll(db) {
    return db.collection(this.#collectionName);
  }

  /**
   * Append one entry. The `startedAt` index is created with the first entry
   * this instance writes, not at connect: a database that never converges
   * gets no history collection at all. `ensureIndex: false` leaves it to the
   * user, like the changelog's (`ensureIndexes: false` — no right to create
   * one must not cost the history itself).
   *
   * A failure that repeats the newest entry — the same plan (`fingerprint`),
   * refused or failed with the same error — is that entry happening again,
   * not news: it is counted on it (`repeats`, `lastAt`) instead of appended.
   * A schedule that converges every minute against a definition only an
   * operator can settle would otherwise add 1,440 documents a day, for good.
   */
  async append(db, entry, { ensureIndex = true } = {}) {
    const collection = this.#coll(db);
    if (!this.#isIndexed && ensureIndex) {
      await collection.createIndex({ startedAt: -1 }, { name: 'startedAt' });
      this.#isIndexed = true;
    }
    if (entry.success === false && entry.fingerprint !== undefined) {
      const rows = await collection
        .find({}, { projection: { success: 1, fingerprint: 1, error: 1 } })
        .sort({ startedAt: -1 })
        .limit(1)
        .toArray();
      const newest = rows[0];
      const isRepeat =
        newest !== undefined &&
        newest.success === false &&
        newest.fingerprint === entry.fingerprint &&
        newest.error === entry.error;
      if (isRepeat) {
        const counted = await collection.updateOne(
          { _id: newest._id },
          { $inc: { repeats: 1 }, $set: { lastAt: entry.finishedAt } },
        );
        if (counted.matchedCount === 1) return;
      }
    }
    await collection.insertOne({ ...entry });
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
