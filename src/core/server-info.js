/**
 * What converge and audit read about the server, and how: the read options
 * forced onto every read, the pace of reading many collections, the server's
 * version and topology, and the error codes for a namespace or an index that
 * is not there. Mechanism only — no logger, no decisions.
 */

/**
 * Read options forced onto both reads: the primary (a secondary may not have
 * an index build yet), and BSON values as plain JavaScript — an injected
 * client configured with `promoteValues: false` or `useBigInt64: true` would
 * otherwise hand back `Int32` objects or `1n`, and everything would compare as
 * changed.
 */
const READ_OPTIONS = Object.freeze({
  readPreference: 'primary',
  promoteLongs: true,
  promoteValues: true,
  useBigInt64: false,
  bsonRegExp: false,
});

/** listIndexes calls in flight while reading many collections — a pace, not a pool */
const READ_CONCURRENCY = 8;

/**
 * What the server is: a mongos in front of shards (its shard keys matter to
 * prune), its topology (`replicaSet`, `sharded`, `standalone` — transactions
 * need one of the first two), and its version (what it can change in place). Best-effort — a
 * server that refuses to say gets the conservative answer: no in-place
 * extras, no shard-key handling.
 */
async function readServer(db) {
  const server = { mongos: false, version: undefined, topology: undefined };
  if (typeof db.admin !== 'function') return server;
  try {
    const hello = await db.admin().command({ hello: 1 });
    server.mongos = hello?.msg === 'isdbgrid';
    // What transactions need: a replica set member or a mongos.
    server.topology = server.mongos
      ? 'sharded'
      : typeof hello?.setName === 'string'
        ? 'replicaSet'
        : 'standalone';
  } catch {
    // Unknown — treated as a replica set or standalone.
  }
  try {
    const info = await db.admin().command({ buildInfo: 1 });
    const [major, minor, patch] = Array.isArray(info?.versionArray) ? info.versionArray : [];
    if (Number.isInteger(major) && Number.isInteger(minor)) {
      server.version = { major, minor, ...(Number.isInteger(patch) ? { patch } : {}) };
    }
  } catch {
    // Unknown version: only the always-available in-place changes.
  }
  return server;
}

const NAMESPACE_NOT_FOUND = 26;

const INDEX_NOT_FOUND = 27;

module.exports = {
  INDEX_NOT_FOUND,
  NAMESPACE_NOT_FOUND,
  READ_CONCURRENCY,
  READ_OPTIONS,
  readServer,
};
