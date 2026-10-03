/**
 * A declared collection: its indexes and validator as the end state, applied
 * by `converge` instead of a migration per change. Edit it and redeploy — with
 * `convergeAfterUp` the next enqueue ends with a converge job that makes the
 * difference. The collection name comes from the file name.
 */
module.exports = {
  indexes: [{ key: { seats: 1 } }],
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['seats'],
      properties: { seats: { bsonType: 'number', minimum: 1 } },
    },
  },
};
