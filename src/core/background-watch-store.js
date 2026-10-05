const os = require('node:os');
const { backgroundCollectionNames } = require('./config.js');
const { READ_OPTIONS } = require('./server-info.js');

/**
 * Where the live drift watcher keeps what outlives a process — one document
 * per watched collection in `<backgroundCollection>_watch`:
 * `{ _id: collection, resumeToken?, target, edges, state, leader,
 * counters, lastEventAt, lastError, updatedAt }`.
 *
 * Only the leader writes, and every write is fenced by `leader.owner`: a
 * watcher that lost its lock (and so its leadership) without knowing it
 * cannot move the token back. The token never leaves this module's status
 * reads — it is the stream's position, of no use to anyone else.
 */
class BackgroundWatchStore {
  #collection;

  constructor(db, backgroundCollection) {
    this.#collection = db.collection(backgroundCollectionNames(backgroundCollection).watch);
  }

  /** The stored document of a collection's watcher, token included, or null */
  async get(collection) {
    return this.#collection.findOne({ _id: collection }, READ_OPTIONS);
  }

  /** Become the writer of a collection's document — called while holding its watcher lock */
  async lead(collection, owner) {
    await this.#collection.updateOne(
      { _id: collection },
      {
        $set: {
          leader: { owner, host: os.hostname(), pid: process.pid, at: new Date() },
          updatedAt: new Date(),
        },
        $setOnInsert: { counters: {} },
      },
      { upsert: true },
    );
  }

  /**
   * Save what the leader knows: `fields` set (a `resumeToken`, a `state`, …),
   * `counters` added, `unset` removed. Resolves whether `owner` still leads.
   */
  async save(collection, owner, { fields = {}, counters = {}, unset = [] } = {}) {
    const update = { $set: { ...fields, updatedAt: new Date() } };
    const inc = {};
    for (const [key, value] of Object.entries(counters)) {
      if (value !== 0) inc[`counters.${key}`] = value;
    }
    if (Object.keys(inc).length > 0) update.$inc = inc;
    if (unset.length > 0) {
      update.$unset = {};
      for (const key of unset) update.$unset[key] = '';
    }
    const result = await this.#collection.updateOne(
      { _id: collection, 'leader.owner': owner },
      update,
    );
    return result.matchedCount === 1;
  }

  /** Every watched collection's document — or one — without its resume token */
  async status(collection) {
    const projection = { resumeToken: 0 };
    if (collection !== undefined) {
      return this.#collection.findOne({ _id: collection }, { projection, ...READ_OPTIONS });
    }
    return this.#collection
      .find({}, { projection, ...READ_OPTIONS })
      .sort({ _id: 1 })
      .toArray();
  }
}

module.exports = { BackgroundWatchStore };
