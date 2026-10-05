const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const SHARDED_URI = process.env.MIGRONAUT_TEST_SHARDED_URI;
const DB = `migronaut_sharded_${process.pid}`;

/**
 * A real sharded cluster: config servers, two shards and a mongos. The first
 * part is a set of probes — what the shard-aware background engine assumes
 * about mongos, `config.*` and targeting, checked against the server rather
 * than taken on trust (ARCHITECTURE §6.8 records what they found). Later
 * phases add scenarios that run migronaut itself here.
 *
 * Opt-in and manual, like the Atlas Search suite: a sharded cluster is
 * nothing `pnpm test` can assume, and CI does not run it. An
 * environment-capability skip with a reason; the coverage gate passes
 * without it. Run it after a change to the shard-aware code:
 *
 *   docker run --rm -d --name migronaut-sharded -p 27019:27017 \
 *     -v "$PWD/tests/fixtures/sharded:/s:ro" mongo:8.0 bash /s/start.sh
 *   MIGRONAUT_TEST_SHARDED_URI="mongodb://root:root@127.0.0.1:27019/?authSource=admin" \
 *     node --test tests/integration/sharded.test.js
 */
describe(
  'sharded cluster (integration, opt-in)',
  {
    skip: SHARDED_URI ? false : 'set MIGRONAUT_TEST_SHARDED_URI to run against a sharded cluster',
    timeout: 600_000,
  },
  () => {
    let mongodb;
    let client;
    let db;
    let admin;
    let shards;

    before(async () => {
      mongodb = require('mongodb');
      client = await mongodb.MongoClient.connect(SHARDED_URI);
      db = client.db(DB);
      admin = client.db('admin');
      await db.dropDatabase();
      const listed = await admin.command({ listShards: 1 });
      shards = [];
      for (const shard of listed.shards) shards.push(shard._id);
      assert.ok(shards.length >= 2, 'the fixture has two shards');
    });

    after(async () => {
      await db?.dropDatabase().catch(() => undefined);
      await admin?.command({ dropUser: 'limited' }).catch(() => undefined);
      await client?.close();
    });

    const ns = (name) => `${DB}.${name}`;

    /**
     * A collection sharded on `key`, with `docs` inserted, split at `splits`
     * (each a shard-key document) and the upper half moved to the second shard.
     */
    async function sharded(name, key, { docs = [], splits = [], moveFrom } = {}) {
      await db.createCollection(name);
      await admin.command({ shardCollection: ns(name), key });
      if (docs.length > 0) await db.collection(name).insertMany(docs);
      for (const middle of splits) await admin.command({ split: ns(name), middle });
      if (moveFrom !== undefined) {
        const owner = await chunkOwner(name, moveFrom);
        const target = shards.find((shard) => shard !== owner);
        await admin.command({ moveRange: ns(name), min: moveFrom, toShard: target });
      }
      return db.collection(name);
    }

    async function collectionEntry(name) {
      return client
        .db('config')
        .collection('collections')
        .findOne({ _id: ns(name) });
    }

    /** Hashed bounds are 64-bit: read as Long, or the driver turns the small ones into numbers */
    async function chunks(name, options = {}) {
      const entry = await collectionEntry(name);
      return client
        .db('config')
        .collection('chunks')
        .find({ uuid: entry.uuid }, options)
        .sort({ min: 1 })
        .toArray();
    }

    async function chunkOwner(name, point) {
      for (const chunk of await chunks(name)) {
        // Single-field keys only — enough for the probes that call this.
        const [field] = Object.keys(point);
        const lo = chunk.min[field];
        const hi = chunk.max[field];
        const above = lo?._bsontype === 'MinKey' || point[field] >= lo;
        const below = hi?._bsontype === 'MaxKey' || point[field] < hi;
        if (above && below) return chunk.shard;
      }
      return undefined;
    }

    /** The shards a find (or a command) was sent to, from a queryPlanner explain */
    function shardsOf(explain) {
      const plan = explain.queryPlanner?.winningPlan ?? explain.queryPlanner;
      const names = new Set();
      for (const shard of plan?.shards ?? []) names.add(shard.shardName);
      return [...names];
    }

    const docs = (count, extra = () => ({})) =>
      Array.from({ length: count }, (_, i) => ({ __v: 1, __rev: 0, sk: i, ...extra(i) }));

    it('[probe] should keep a sharded collection in config.collections, its chunks by uuid', async () => {
      await sharded(
        'layout',
        { sk: 1 },
        { docs: docs(1000), splits: [{ sk: 500 }], moveFrom: { sk: 500 } },
      );
      const entry = await collectionEntry('layout');
      assert.deepStrictEqual(entry.key, { sk: 1 });
      assert.ok(entry.uuid, 'chunks are keyed by the collection uuid (5.0+)');
      assert.ok(entry.timestamp, 'the epoch carries a timestamp');
      const list = await chunks('layout');
      assert.ok(list.length >= 2);
      for (const chunk of list) {
        assert.ok(chunk.min && chunk.max && typeof chunk.shard === 'string');
        assert.strictEqual(chunk.ns, undefined, 'no ns on a 5.0+ chunk');
      }
      const owners = new Set();
      for (const chunk of list) owners.add(chunk.shard);
      assert.strictEqual(owners.size, 2);
      assert.strictEqual(list[0].min.sk._bsontype, 'MinKey');
      assert.strictEqual(list.at(-1).max.sk._bsontype, 'MaxKey');
    });

    it('[probe] should list an unsharded collection moved to a shard as unsplittable (8.0)', async () => {
      await db.collection('plain').insertOne({ a: 1 });
      const before = await collectionEntry('plain');
      const { version } = await admin.command({ buildInfo: 1 });
      if (Number(version.split('.')[0]) < 8) return;
      await admin.command({ moveCollection: ns('plain'), toShard: shards[1] });
      const entry = await collectionEntry('plain');
      assert.strictEqual(entry.unsplittable, true);
      assert.deepStrictEqual(entry.key, { _id: 1 });
      assert.ok(before === null || before.unsplittable === true);
    });

    it('[probe] should target one shard for a shard-key range inside a chunk, and broadcast min/max alone', async () => {
      const coll = await sharded(
        'target',
        { sk: 1 },
        {
          docs: docs(1000),
          splits: [{ sk: 500 }],
          moveFrom: { sk: 500 },
        },
      );
      await coll.createIndex({ __v: 1, sk: 1, _id: 1 });
      const ranged = await coll.find({ sk: { $gte: 600, $lt: 700 } }).explain('queryPlanner');
      assert.strictEqual(shardsOf(ranged).length, 1, 'a range predicate targets');
      const bounded = await coll
        .find({})
        .hint({ __v: 1, sk: 1, _id: 1 })
        .min({ __v: 1, sk: 600, _id: new mongodb.MinKey() })
        .max({ __v: 1, sk: 700, _id: new mongodb.MinKey() })
        .explain('queryPlanner');
      assert.strictEqual(shardsOf(bounded).length, 2, 'min/max alone do not target');
      const both = await coll
        .find({ sk: { $gte: 600, $lt: 700 } })
        .hint({ __v: 1, sk: 1, _id: 1 })
        .min({ __v: 1, sk: 600, _id: new mongodb.MinKey() })
        .max({ __v: 1, sk: 700, _id: new mongodb.MinKey() })
        .explain('queryPlanner');
      assert.strictEqual(shardsOf(both).length, 1, 'min/max with the predicate target');
    });

    it('[probe] should return exactly the min/max range through mongos, merged in index order', async () => {
      const coll = await sharded(
        'ranges',
        { sk: 1 },
        {
          docs: docs(1000, (i) => ({ __v: i % 3 === 0 ? 2 : 1 })),
          splits: [{ sk: 500 }],
          moveFrom: { sk: 500 },
        },
      );
      await coll.createIndex({ __v: 1, sk: 1, _id: 1 });
      const rows = await coll
        .find({})
        .hint({ __v: 1, sk: 1, _id: 1 })
        .min({ __v: 1, sk: 200, _id: new mongodb.MinKey() })
        .max({ __v: 1, sk: 800, _id: new mongodb.MinKey() })
        .sort({ __v: 1, sk: 1, _id: 1 })
        .toArray();
      let expected = 0;
      for (let i = 200; i < 800; i++) if (i % 3 !== 0) expected += 1;
      assert.strictEqual(rows.length, expected, 'the exact range — every v1 document in it');
      for (let i = 0; i < rows.length; i++) {
        assert.strictEqual(rows[i].__v, 1);
        if (i > 0) assert.ok(rows[i - 1].sk < rows[i].sk, 'in index order');
      }
    });

    it('[probe] should keep a missing and a null shard key in the chunk that holds null', async () => {
      const coll = await sharded('nulls', { sk: 1 }, { splits: [{ sk: 0 }], moveFrom: { sk: 0 } });
      await coll.insertMany([{ _id: 'missing' }, { _id: 'null', sk: null }, { _id: 'one', sk: 1 }]);
      const explain = await coll.find({ sk: null }).explain('queryPlanner');
      assert.strictEqual(shardsOf(explain).length, 1, 'null targets the chunk below 0');
      assert.strictEqual(await coll.countDocuments({ sk: null }), 2);
    });

    it('[probe] should bound a hashed chunk with NumberLong hashes', async () => {
      await sharded('hashed', { region: 1, uid: 'hashed' });
      await db
        .collection('hashed')
        .insertMany(Array.from({ length: 200 }, (_, i) => ({ region: 'eu', uid: i })));
      await sharded('idhashed', { _id: 'hashed' });
      const promoted = await chunks('idhashed');
      let numbers = 0;
      for (const chunk of promoted) if (typeof chunk.min._id === 'number') numbers += 1;
      assert.ok(numbers > 0, 'promoted to plain numbers by default — lossy past 2^53');
      for (const name of ['hashed', 'idhashed']) {
        const field = name === 'hashed' ? 'uid' : '_id';
        for (const chunk of await chunks(name, { promoteLongs: false })) {
          for (const bound of [chunk.min[field], chunk.max[field]]) {
            assert.ok(
              ['Long', 'MinKey', 'MaxKey'].includes(bound?._bsontype),
              `${name}: ${bound?._bsontype}`,
            );
          }
        }
      }
    });

    it('[probe] should send a write filtered by the whole shard key to one shard', async () => {
      const coll = await sharded(
        'writes',
        { sk: 1 },
        {
          docs: docs(1000),
          splits: [{ sk: 500 }],
          moveFrom: { sk: 500 },
        },
      );
      const doc = await coll.findOne({ sk: 700 });
      const explain = (q) =>
        db.command({
          explain: { update: 'writes', updates: [{ q, u: { $inc: { __rev: 1 } } }] },
          verbosity: 'queryPlanner',
        });
      assert.strictEqual(shardsOf(await explain({ _id: doc._id, sk: 700 })).length, 1);
      assert.strictEqual(shardsOf(await explain({ _id: doc._id })).length, 2);
    });

    it('[probe] should move a document whose shard key changes — with retryable writes, the driver default', async () => {
      const coll = await sharded(
        'rekey',
        { sk: 1 },
        {
          docs: docs(1000),
          splits: [{ sk: 500 }],
          moveFrom: { sk: 500 },
        },
      );
      const doc = await coll.findOne({ sk: 10 });
      await coll.updateOne({ _id: doc._id, sk: 10 }, { $set: { sk: 900 } });
      assert.strictEqual((await coll.findOne({ _id: doc._id })).sk, 900, 'nothing refuses it');
      const strict = await mongodb.MongoClient.connect(SHARDED_URI, { retryWrites: false });
      try {
        await assert.rejects(
          strict
            .db(DB)
            .collection('rekey')
            .updateOne({ _id: doc._id, sk: 900 }, { $set: { sk: 20 } }),
          (error) => {
            assert.ok([72, 20].includes(error.code), `code ${error.code}: ${error.message}`);
            return true;
          },
        );
      } finally {
        await strict.close();
      }
    });

    it('[probe] should refuse distinct inside a transaction on a sharded collection', async () => {
      const coll = await sharded('distinct', { sk: 1 }, { docs: docs(100) });
      const session = client.startSession();
      try {
        session.startTransaction();
        await assert.rejects(coll.distinct('sk', {}, { session }), (error) => {
          assert.strictEqual(error.code, 263, `code ${error.code}: ${error.message}`);
          return true;
        });
      } finally {
        await session.abortTransaction().catch(() => undefined);
        await session.endSession();
      }
    });

    it('[probe] should refuse config reads to a user with readWrite only', async () => {
      await sharded('limited', { sk: 1 }, { docs: docs(10) });
      await admin.command({
        createUser: 'limited',
        pwd: 'limited',
        roles: [{ role: 'readWrite', db: DB }],
      });
      const url = new URL(SHARDED_URI);
      url.username = 'limited';
      url.password = 'limited';
      url.searchParams.set('authSource', 'admin');
      const restricted = await mongodb.MongoClient.connect(url.toString());
      try {
        assert.strictEqual(await restricted.db(DB).collection('limited').countDocuments(), 10);
        for (const name of ['collections', 'chunks']) {
          await assert.rejects(
            restricted.db('config').collection(name).findOne({}),
            (error) => error.code === 13,
          );
        }
      } finally {
        await restricted.close();
      }
    });
  },
);
