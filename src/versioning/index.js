const {
  ConfigInvalidError,
  MigronautError,
  RevisionConflictError,
  ShapeVersionError,
} = require('../errors/index.js');
const {
  bumpRevision,
  findOneAndUpdateWithRevision,
  replaceWithRevision,
  retryOnConflict,
  updateWithRevision,
} = require('./occ.js');
const { defineShapes } = require('./registry.js');

/**
 * `@alexify/migronaut/versioning` — document versioning and optimistic
 * concurrency for an application's repository layer.
 *
 * Deliberately small: it requires nothing but its own modules and the error
 * classes — not the migration engine, not the driver, not mongoose — so a
 * service that only reads and writes documents pays for nothing else. The
 * error classes are the package root's own, so `instanceof` agrees whichever
 * entry point a caller imports them from.
 */
module.exports = {
  // The application's view of its versioned collections
  defineShapes,

  // Optimistic concurrency
  updateWithRevision,
  replaceWithRevision,
  findOneAndUpdateWithRevision,
  retryOnConflict,
  bumpRevision,

  // Errors — the same classes the package root exports
  MigronautError,
  ConfigInvalidError,
  RevisionConflictError,
  ShapeVersionError,
};
