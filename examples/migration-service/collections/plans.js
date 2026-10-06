/**
 * A declared collection: its indexes, Atlas Search index and validator as the
 * end state, applied by `converge` instead of a migration per change. Edit it
 * and redeploy — with `convergeAfterUp` the next enqueue ends with a converge
 * job that makes the difference. The collection name comes from the file name.
 */
module.exports = {
  // The shape version (`__v`) and the optimistic-concurrency revision (`__rev`):
  // converge adds their rules to the validator and the { __v: 1, _id: 1 } index
  // background migrations read through. `min: 1` keeps v1 documents valid while
  // the background migration below rewrites them; raise it to 2 once it has
  // completed — converge refuses to while a v1 document is left.
  versioning: { current: 2, min: 1 },
  indexes: [{ key: { seats: 1 } }],
  // Built in the background by mongot; a changed definition is updated in place.
  searchIndexes: [{ definition: { mappings: { dynamic: true } } }],
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['seats'],
      properties: { seats: { bsonType: 'number', minimum: 1 } },
    },
  },
};
