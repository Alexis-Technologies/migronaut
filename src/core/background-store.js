const os = require('node:os');
const { LockLostError } = require('../errors/index.js');
const { randomId } = require('../utils/id.js');
const { backgroundCollectionNames } = require('./config.js');
const { READ_OPTIONS } = require('./server-info.js');

/**
 * Where background migrations keep their state, in MongoDB — the truth every
 * runtime (a BullMQ worker, the CLI, an in-process runner) reads and writes;
 * Redis and processes are only executors.
 *
 * - One **state document** per background migration (`_id` = its file name):
 *   status, phase, the current plan, totals, controls, history.
 * - One **partition** document per range of the current plan: its cursor,
 *   counters and — while a lane works it — its **lease**. The lease *is* the
 *   lane's slot: a unique partial index on `{ background, lease.slot }` makes
 *   "at most `maxParallel` partitions at once" an invariant of the schema,
 *   across every process, with no lock of its own to heartbeat.
 *
 * Every lease write is fenced by the lease's token, and every staleness
 * decision is made in server time (`$$NOW`). Mechanism only: no logger, no
 * decisions — background.js and the engine decide.
 */

/** The state document's schema — a worker refuses a newer one (an old release mid-deploy) */
const STATE_SCHEMA = 2;

/** At most this many document ids are kept as "bad" — beyond any sane error budget */
const MAX_BAD_IDS = 1000;

/** The last document errors kept, per partition and in the state */
const MAX_DOC_ERRORS = 20;

/** History entries kept on a state document */
const MAX_HISTORY = 50;

/** Statuses of a partition still to be worked */
const OPEN_PARTITION = ['pending', 'running'];

const DUPLICATE_KEY = 11000;

/** A value as itself inside an update pipeline — a string with a leading `$` is not a field path */
const literal = (value) => ({ $literal: value });

/** `field + n` inside a pipeline, a missing field counting as 0 */
const plus = (field, n) => ({ $add: [{ $ifNull: [`$${field}`, 0] }, n] });

/** An array field with `items` appended, keeping the last `max` */
const appendSliced = (field, items, max) => ({
  $slice: [{ $concatArrays: [{ $ifNull: [`$${field}`, []] }, literal(items)] }, -max],
});

class BackgroundStore {
  #db;
  #names;
  #indexed;

  /**
   * `collection` is the `backgroundCollection` setting: the state lives
   * there, the partitions in `<collection>_partitions`.
   */
  constructor(db, collection) {
    this.#db = db;
    this.#names = backgroundCollectionNames(collection);
  }

  get names() {
    return this.#names;
  }

  get #states() {
    return this.#db.collection(this.#names.state);
  }

  get #partitions() {
    return this.#db.collection(this.#names.partitions);
  }

  /**
   * The indexes, created on first use — never at connect: a database that
   * never registers a background migration gets no collections at all. Must
   * run outside a transaction (a registration inside `useTransaction` calls
   * it first).
   */
  async ensureIndexes() {
    this.#indexed ??= Promise.all([
      this.#states.createIndex({ status: 1, registeredAt: 1 }, { name: 'status_registeredAt' }),
      this.#partitions.createIndex(
        { background: 1, generation: 1, plan: 1, status: 1, seq: 1 },
        { name: 'claim' },
      ),
      this.#partitions.createIndex(
        { background: 1, 'lease.slot': 1 },
        {
          name: 'lease_slot',
          unique: true,
          partialFilterExpression: { 'lease.slot': { $exists: true } },
        },
      ),
      this.#partitions.createIndex(
        { background: 1, 'lease.groupSlot': 1 },
        {
          name: 'lease_group_slot',
          unique: true,
          partialFilterExpression: { 'lease.groupSlot': { $exists: true } },
        },
      ),
    ]).catch((error) => {
      this.#indexed = undefined;
      throw error;
    });
    await this.#indexed;
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  /** A state document, read from the primary — or `null` */
  get(name, { session } = {}) {
    return this.#states.findOne(
      { _id: name },
      { ...READ_OPTIONS, ...(session ? { session } : {}) },
    );
  }

  /** Every state document matching `filter`, oldest registration first */
  list(filter = {}) {
    return this.#states.find(filter, READ_OPTIONS).sort({ registeredAt: 1, _id: 1 }).toArray();
  }

  /**
   * Register (or register again) a background migration: a fresh state
   * document under a new `registration` id, and no partitions — a plan of
   * the old registration must not be resumed against the new one.
   */
  async register(name, fields, { session } = {}) {
    const options = session ? { session } : {};
    const now = new Date();
    const doc = {
      _id: name,
      schema: STATE_SCHEMA,
      registration: randomId(),
      phase: 'partition',
      pass: 0,
      generation: 0,
      rolledGeneration: 0,
      totals: {},
      badIds: [],
      docErrors: [],
      failures: 0,
      reopened: 0,
      history: [{ at: now, action: 'register', to: fields.status }],
      registeredAt: now,
      updatedAt: now,
      ...fields,
    };
    await this.#states.replaceOne({ _id: name }, doc, { upsert: true, ...options });
    await this.#partitions.deleteMany({ background: name }, options);
    return doc;
  }

  /**
   * Compare-and-set a state document: `filter` on top of the `_id`, `update`
   * an operator update or a pipeline. Returns the document after, or `null`
   * when the filter no longer matched.
   */
  cas(name, filter, update, { session } = {}) {
    return this.#states.findOneAndUpdate({ _id: name, ...filter }, update, {
      returnDocument: 'after',
      ...READ_OPTIONS,
      ...(session ? { session } : {}),
    });
  }

  /**
   * Move a state document from one of `from` to `to`, appending a history
   * entry and setting `fields`. Returns the document after, or `null` when
   * its status was no longer one of `from` (someone else moved it).
   */
  move(name, { from, to, action, fields = {}, filter = {}, by, reason }) {
    const entry = {
      at: '$$NOW',
      action: literal(action),
      from: '$status',
      to: literal(to),
      ...(by !== undefined ? { by: literal(by) } : {}),
      ...(reason !== undefined ? { reason: literal(reason) } : {}),
    };
    // One stage: `$status` in the entry is the status before it.
    const set = {
      status: literal(to),
      updatedAt: '$$NOW',
      history: {
        $slice: [{ $concatArrays: [{ $ifNull: ['$history', []] }, [entry]] }, -MAX_HISTORY],
      },
    };
    for (const [key, value] of Object.entries(fields)) set[key] = literal(value);
    return this.cas(name, { status: { $in: from }, ...filter }, [{ $set: set }]);
  }

  /** Set fields of a state document (no status change) */
  async set(name, fields, { filter = {}, session } = {}) {
    const result = await this.#states.updateOne(
      { _id: name, ...filter },
      { $set: { ...fields, updatedAt: new Date() } },
      session ? { session } : {},
    );
    return result.matchedCount === 1;
  }

  /** Delete a state document and its partitions */
  async remove(name, { session } = {}) {
    const options = session ? { session } : {};
    await this.#partitions.deleteMany({ background: name }, options);
    const result = await this.#states.deleteOne({ _id: name }, options);
    return result.deletedCount === 1;
  }

  // ─── Plans ──────────────────────────────────────────────────────────────────

  /**
   * Commit a new plan: its partitions inserted under a fresh plan token, then
   * the state moved to them in one compare-and-set on the generation and the
   * plan it was planned against. A coordinator that lost that race (another
   * one committed first) leaves only partitions nobody can claim — their
   * plan is not the state's — and removes them. Returns the state after, or
   * `null` when the race was lost.
   */
  async commitPlan(name, { generation, previousToken, plan, partitions, fields = {} }) {
    const token = randomId();
    const nextGeneration = generation + 1;
    if (partitions.length > 0) {
      const docs = partitions.map((partition, seq) => ({
        background: name,
        generation: nextGeneration,
        plan: token,
        seq,
        scope: partition.scope,
        status: 'pending',
        ...(partition.group !== undefined ? { group: partition.group } : {}),
        estimate: partition.estimate ?? 0,
        cursor: {},
        counters: {},
        claims: 0,
        reclaims: 0,
        failures: 0,
        createdAt: new Date(),
      }));
      await this.#partitions.insertMany(docs, { ordered: false });
    }
    const state = await this.cas(
      name,
      { generation, 'plan.token': previousToken ?? { $exists: false } },
      {
        $set: {
          generation: nextGeneration,
          plan: {
            ...plan,
            token,
            generation: nextGeneration,
            partitions: partitions.length,
            at: new Date(),
          },
          phase: 'process',
          updatedAt: new Date(),
          ...fields,
        },
      },
    );
    if (state === null) {
      await this.#partitions.deleteMany({ background: name, plan: token });
    }
    return state;
  }

  /** Mark the open partitions of a plan superseded — a replan is coming */
  async supersede(name, { generation, plan }) {
    const result = await this.#partitions.updateMany(
      { background: name, generation, plan, status: { $in: OPEN_PARTITION } },
      { $set: { status: 'superseded', updatedAt: new Date() } },
    );
    return result.modifiedCount;
  }

  /** How the partitions of a plan stand: a count per status, and how many are leased */
  async partitionCounts(name, { generation, plan }) {
    const rows = await this.#partitions
      .aggregate(
        [
          { $match: { background: name, generation, plan } },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
              leased: { $sum: { $cond: [{ $gt: ['$lease', null] }, 1, 0] } },
            },
          },
        ],
        READ_OPTIONS,
      )
      .toArray();
    const counts = {
      total: 0,
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      superseded: 0,
      leased: 0,
    };
    for (const row of rows) {
      counts[row._id] = row.count;
      counts.total += row.count;
      counts.leased += row.leased;
    }
    return counts;
  }

  /** The partitions of one background migration — newest generation first, by seq */
  partitions(name, filter = {}) {
    return this.#partitions
      .find({ background: name, ...filter }, READ_OPTIONS)
      .sort({ generation: -1, seq: 1 })
      .toArray();
  }

  /**
   * The totals of a generation's partitions, for the state's roll-up: the
   * counters summed, the bad ids united, the newest document errors.
   */
  async generationTotals(name, generation) {
    const [row] = await this.#partitions
      .aggregate(
        [
          { $match: { background: name, generation } },
          {
            $group: {
              _id: null,
              scanned: { $sum: { $ifNull: ['$counters.scanned', 0] } },
              migrated: { $sum: { $ifNull: ['$counters.migrated', 0] } },
              skipped: { $sum: { $ifNull: ['$counters.skipped', 0] } },
              conflicts: { $sum: { $ifNull: ['$counters.conflicts', 0] } },
              failed: { $sum: { $ifNull: ['$counters.failed', 0] } },
              retried: { $sum: { $ifNull: ['$counters.retried', 0] } },
              batches: { $sum: { $ifNull: ['$counters.batches', 0] } },
              slices: { $sum: { $ifNull: ['$counters.slices', 0] } },
              txnRetries: { $sum: { $ifNull: ['$counters.txnRetries', 0] } },
              reclaims: { $sum: { $ifNull: ['$reclaims', 0] } },
              badIds: { $push: { $ifNull: ['$badIds', []] } },
              docErrors: { $push: { $ifNull: ['$lastDocErrors', []] } },
              failedPartitions: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
              lastError: { $max: '$lastError' },
            },
          },
        ],
        READ_OPTIONS,
      )
      .toArray();
    if (row === undefined) return null;
    const { _id: _ignored, badIds, docErrors, ...totals } = row;
    const ids = [];
    for (const list of badIds) ids.push(...list);
    const errors = [];
    for (const list of docErrors) errors.push(...list);
    return { totals, badIds: ids, docErrors: errors.slice(-MAX_DOC_ERRORS) };
  }

  /**
   * The distinct documents that failed — the state's (earlier generations,
   * already excluded from later passes) plus this generation's partitions'.
   */
  async countBadIds(name, generation) {
    const [state, rows] = await Promise.all([
      this.#states.findOne({ _id: name }, { projection: { badIds: 1 }, ...READ_OPTIONS }),
      this.#partitions
        .aggregate(
          [
            { $match: { background: name, generation, 'badIds.0': { $exists: true } } },
            { $unwind: '$badIds' },
            { $group: { _id: '$badIds' } },
            { $count: 'n' },
          ],
          READ_OPTIONS,
        )
        .toArray(),
    ]);
    return (state?.badIds?.length ?? 0) + (rows[0]?.n ?? 0);
  }

  /** Delete the partitions of generations up to `generation` — `keep` spares one */
  async dropGenerations(name, generation, { keep } = {}) {
    const filter = { background: name, generation: { $lte: generation } };
    if (keep !== undefined) filter.generation.$ne = keep;
    const result = await this.#partitions.deleteMany(filter);
    return result.deletedCount;
  }

  /** Delete the partitions of every plan but `plan` — what a lost commit race left behind */
  async dropForeignPlans(name, plan) {
    const result = await this.#partitions.deleteMany({
      background: name,
      plan: { $ne: plan },
      status: { $in: [...OPEN_PARTITION, 'superseded'] },
    });
    return result.deletedCount;
  }

  /** Set the status of a plan's open partitions — `cancelled`, or `pending` again for a retry */
  async setOpenPartitions(name, { generation, plan, from = OPEN_PARTITION, status }) {
    const result = await this.#partitions.updateMany(
      { background: name, generation, plan, status: { $in: from } },
      { $set: { status, updatedAt: new Date(), ...(status === 'pending' ? { failures: 0 } : {}) } },
    );
    return result.modifiedCount;
  }

  // ─── Leases ─────────────────────────────────────────────────────────────────

  /**
   * Free the leases nobody renewed within their own TTL — in server time.
   * Returns how many were reclaimed.
   */
  async reap(name) {
    const result = await this.#partitions.updateMany(
      {
        background: name,
        lease: { $exists: true },
        $expr: { $lt: ['$lease.renewedAt', { $subtract: ['$$NOW', '$lease.ttlMs'] }] },
      },
      [{ $set: { reclaims: plus('reclaims', 1) } }, { $unset: 'lease' }],
    );
    return result.modifiedCount;
  }

  /** How many leases are held — and how many were renewed within their TTL */
  async leases(name) {
    const [row] = await this.#partitions
      .aggregate(
        [
          { $match: { background: name, lease: { $exists: true } } },
          {
            $group: {
              _id: null,
              held: { $sum: 1 },
              live: {
                $sum: {
                  $cond: [
                    { $gte: ['$lease.renewedAt', { $subtract: ['$$NOW', '$lease.ttlMs'] }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        READ_OPTIONS,
      )
      .toArray();
    return { held: row?.held ?? 0, live: row?.live ?? 0 };
  }

  /** Drop every lease of a background migration — their holders are fenced off at once */
  async unlockAll(name) {
    const result = await this.#partitions.updateMany(
      { background: name, lease: { $exists: true } },
      { $unset: { lease: '' } },
    );
    return result.modifiedCount;
  }

  /**
   * Claim a partition of the current plan, and a slot with it, in one atomic
   * write. Expired leases are reaped first; then each free slot below
   * `maxParallel` is tried (from a random offset, so concurrent claimers
   * spread out): the unique index refuses a slot another claim took a moment
   * earlier, and the next one is tried. Partitions already started come
   * first, then the largest.
   *
   * Returns `{ partition, lease }`, `{ busy: true, retryAfterMs }` when every
   * slot is taken, or `{ exhausted: true }` when no partition is left to claim.
   */
  async claim(name, { generation, plan, maxParallel, ttlMs, owner, shardConcurrency }) {
    await this.reap(name);
    const occupied = new Set();
    const perGroup = new Map();
    const leased = await this.#partitions
      .find(
        { background: name, 'lease.slot': { $exists: true } },
        { projection: { 'lease.slot': 1, group: 1 }, ...READ_OPTIONS },
      )
      .toArray();
    for (const doc of leased) {
      occupied.add(doc.lease.slot);
      if (doc.group !== undefined) perGroup.set(doc.group, (perGroup.get(doc.group) ?? 0) + 1);
    }
    // Sharded: a group (shard) with every one of its slots held is not claimed from.
    const fullGroups = [];
    if (shardConcurrency !== undefined) {
      for (const [group, held] of perGroup) if (held >= shardConcurrency) fullGroups.push(group);
    }
    const free = [];
    for (let slot = 0; slot < maxParallel; slot++) if (!occupied.has(slot)) free.push(slot);
    if (free.length === 0) return { busy: true, retryAfterMs: Math.max(1, Math.floor(ttlMs / 2)) };

    const offset = Math.floor(Math.random() * free.length);
    for (let i = 0; i < free.length; i++) {
      const slot = free[(offset + i) % free.length];
      const token = randomId();
      const lease = {
        slot,
        token: literal(token),
        owner: literal(owner ?? token),
        host: literal(os.hostname()),
        pid: literal(process.pid),
        ttlMs: literal(ttlMs),
        renewedAt: '$$NOW',
        claimedAt: '$$NOW',
      };
      let partition;
      try {
        partition = await this.#claimOne(name, {
          generation,
          plan,
          lease,
          shardConcurrency,
          fullGroups,
        });
      } catch (error) {
        if (error?.code === DUPLICATE_KEY) continue;
        throw error;
      }
      if (partition === null) return { exhausted: true };
      return { partition, lease: this.lease(partition._id, token, ttlMs) };
    }
    // Every free slot was taken by a concurrent claim.
    return { busy: true, retryAfterMs: Math.max(1, Math.floor(ttlMs / 4)) };
  }

  /** One claim attempt for one slot (and, sharded, one per-group slot) */
  async #claimOne(name, { generation, plan, lease, shardConcurrency, fullGroups = [] }) {
    const filter = {
      background: name,
      generation,
      plan,
      status: { $in: OPEN_PARTITION },
      lease: { $exists: false },
      ...(fullGroups.length > 0 ? { group: { $nin: fullGroups } } : {}),
    };
    const set = {
      lease,
      status: 'running',
      claims: plus('claims', 1),
      startedAt: { $ifNull: ['$startedAt', '$$NOW'] },
      updatedAt: '$$NOW',
    };
    if (shardConcurrency === undefined) {
      return this.#partitions.findOneAndUpdate(filter, [{ $set: set }], {
        sort: { status: -1, seq: 1 },
        returnDocument: 'after',
        ...READ_OPTIONS,
      });
    }
    // Per group (shard): a second unique slot, `<group>#<k>`.
    for (let k = 0; k < shardConcurrency; k++) {
      try {
        return await this.#partitions.findOneAndUpdate(
          filter,
          [
            {
              $set: {
                ...set,
                lease: {
                  ...lease,
                  groupSlot: { $concat: [{ $toString: { $ifNull: ['$group', ''] } }, `#${k}`] },
                },
              },
            },
          ],
          { sort: { status: -1, seq: 1 }, returnDocument: 'after', ...READ_OPTIONS },
        );
      } catch (error) {
        if (error?.code !== DUPLICATE_KEY || /lease_slot/.test(String(error?.message))) throw error;
      }
    }
    // Every group slot of the partition this claim would take is held.
    const duplicate = new Error('group slots taken');
    duplicate.code = DUPLICATE_KEY;
    throw duplicate;
  }

  /**
   * A lease as a lock: what `runWithLock` heartbeats. `acquire` is a no-op —
   * the claim took it — and `renew` skips the write when a checkpoint
   * renewed it less than a quarter TTL ago (a checkpoint renews too; inside a
   * transaction an extra write to the partition would be a write conflict).
   */
  lease(partitionId, token, ttlMs) {
    const partitions = this.#partitions;
    let touchedAt = Date.now();
    return {
      label: 'partition lease',
      token,
      ttlMs,
      partitionId,
      touch() {
        touchedAt = Date.now();
      },
      async acquire() {},
      async renew() {
        if (Date.now() - touchedAt < ttlMs / 4) return true;
        const result = await partitions.updateOne({ _id: partitionId, 'lease.token': token }, [
          { $set: { 'lease.renewedAt': '$$NOW' } },
        ]);
        if (result.matchedCount === 1) touchedAt = Date.now();
        return result.matchedCount === 1;
      },
      async release() {
        await partitions.updateOne(
          { _id: partitionId, 'lease.token': token },
          { $unset: { lease: '' }, $set: { updatedAt: new Date() } },
        );
      },
    };
  }

  /**
   * The fenced checkpoint after a batch: only the lease holder's write lands
   * (`lease.token`), on a partition still running. It moves the cursor, adds
   * the batch's counters, keeps new bad ids and document errors, renews the
   * lease — and, with `done`, closes the partition and frees its slot.
   *
   * @throws {LockLostError} (`lease: true`) when the lease is no longer held
   */
  async checkpoint(lease, update, { session } = {}) {
    const { cursor, counters = {}, badIds = [], docErrors = [], done = false, throttle } = update;
    const set = { 'lease.renewedAt': '$$NOW', updatedAt: '$$NOW' };
    if (cursor !== undefined) set.cursor = literal(cursor);
    for (const [key, value] of Object.entries(counters)) {
      if (value) set[`counters.${key}`] = plus(`counters.${key}`, value);
    }
    if (badIds.length > 0) {
      set.badIds = {
        $slice: [{ $setUnion: [{ $ifNull: ['$badIds', []] }, literal(badIds)] }, MAX_BAD_IDS + 1],
      };
    }
    if (docErrors.length > 0) {
      set.lastDocErrors = appendSliced('lastDocErrors', docErrors, MAX_DOC_ERRORS);
    }
    if (throttle !== undefined) set.throttle = literal(throttle);
    const pipeline = [{ $set: set }];
    if (done) {
      pipeline.push({ $set: { status: 'done', doneAt: '$$NOW' } }, { $unset: 'lease' });
    }
    const result = await this.#partitions.updateOne(
      { _id: lease.partitionId, 'lease.token': lease.token, status: 'running' },
      pipeline,
      session ? { session } : {},
    );
    if (result.matchedCount !== 1) {
      throw new LockLostError('Lost the partition lease mid-slice', {
        lease: true,
        partition: String(lease.partitionId),
      });
    }
    lease.touch();
  }

  /**
   * A failed slice: counted on the partition — which fails for good once it
   * reaches `maxSliceFailures` — and the lease released. Returns whether the
   * partition failed.
   */
  async failSlice(lease, { error, maxSliceFailures }) {
    const doc = await this.#partitions.findOneAndUpdate(
      { _id: lease.partitionId, 'lease.token': lease.token },
      [
        { $set: { failures: plus('failures', 1), lastError: literal(error), updatedAt: '$$NOW' } },
        {
          $set: {
            status: { $cond: [{ $gte: ['$failures', maxSliceFailures] }, 'failed', '$status'] },
          },
        },
        { $unset: 'lease' },
      ],
      { returnDocument: 'after', ...READ_OPTIONS },
    );
    return doc?.status === 'failed';
  }

  /** Fail a partition at once (a document error beyond the budget) and free its slot */
  async failPartition(lease, { error }) {
    await this.#partitions.updateOne({ _id: lease.partitionId, 'lease.token': lease.token }, [
      { $set: { status: 'failed', lastError: literal(error), updatedAt: '$$NOW' } },
      { $unset: 'lease' },
    ]);
  }
}

module.exports = {
  BackgroundStore,
  MAX_BAD_IDS,
  MAX_DOC_ERRORS,
  OPEN_PARTITION,
  STATE_SCHEMA,
};
