const { READ_OPTIONS } = require('./server-info.js');

/**
 * What the cluster says about a collection's sharding — read from the
 * `config` database through a mongos. Every read here needs `clusterMonitor`
 * (or more): a user without it gets `undefined` ("unknown"), never an error,
 * and the caller falls back to what works without it.
 *
 * - `readShardKey` — the shard key, or `null` for a collection that is not
 *   sharded (an 8.0 `unsplittable` one included: tracked, but on one shard
 *   under `{ _id: 1 }`, which is no key to partition or target by);
 * - `readChunks` — the chunks of a sharded collection, in key order.
 */

/** The server's "not authorized" — the one refusal that means "unknown", not "broken" */
const UNAUTHORIZED = 13;

const isUnauthorized = (error) => error?.code === UNAUTHORIZED;

/**
 * `{ key, uuid, timestamp, unsplittable }` of a sharded collection, `null` when
 * it is not sharded, `undefined` when `config.collections` may not be read.
 */
async function readShardKey(client, dbName, collection) {
  let entry;
  try {
    entry = await client
      .db('config')
      .collection('collections')
      .findOne(
        { _id: `${dbName}.${collection}` },
        { projection: { key: 1, uuid: 1, timestamp: 1, unsplittable: 1 }, ...READ_OPTIONS },
      );
  } catch (error) {
    if (isUnauthorized(error)) return undefined;
    throw error;
  }
  if (entry === null || entry.unsplittable === true || entry.key === undefined) return null;
  return {
    key: entry.key,
    uuid: entry.uuid,
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
  };
}

/**
 * The chunks of a sharded collection (`readShardKey`'s result), in key order:
 * `[{ min, max, shard }]` — or `undefined` when `config.chunks` may not be
 * read. By `uuid` (5.0+), then by namespace (a cluster upgraded from 4.4 that
 * never refreshed its chunks).
 */
async function readChunks(client, dbName, collection, sharding) {
  const chunks = client.db('config').collection('chunks');
  // Hashed bounds are NumberLongs: promoted to numbers, they lose precision
  // past 2^53 (ARCHITECTURE §6.8).
  const options = {
    projection: { min: 1, max: 1, shard: 1 },
    ...READ_OPTIONS,
    promoteLongs: false,
  };
  try {
    let rows = await chunks.find({ uuid: sharding.uuid }, options).sort({ min: 1 }).toArray();
    if (rows.length === 0) {
      rows = await chunks
        .find({ ns: `${dbName}.${collection}` }, options)
        .sort({ min: 1 })
        .toArray();
    }
    return rows;
  } catch (error) {
    if (isUnauthorized(error)) return undefined;
    throw error;
  }
}

module.exports = { isUnauthorized, readChunks, readShardKey };
