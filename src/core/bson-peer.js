/**
 * The driver's BSON, from the `mongodb` peer — loaded on first use, never at
 * startup, and from this one module only (pinned by a test), so nothing else
 * under src/ grows its own dependency on the driver's internals.
 *
 * What it is for: measuring a document the way the server will (a step's
 * checkpoint must stay small) and writing one as relaxed EJSON for a dry
 * run's report — both things only BSON itself can do exactly.
 */
let bson;

function loadBson() {
  bson ??= require('mongodb').BSON;
  return bson;
}

/** The size of `value` as a BSON document, in bytes */
const bsonSize = (value) => loadBson().calculateObjectSize(value);

/** `value` as relaxed EJSON — plain JSON a person can read, types tagged where JSON has none */
const toRelaxedEjson = (value) => loadBson().EJSON.serialize(value, { relaxed: true });

module.exports = { bsonSize, loadBson, toRelaxedEjson };
