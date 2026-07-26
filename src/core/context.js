/**
 * Build the MigrationContext passed into every migration function.
 *
 * `signal` is the run's abort signal: it fires when the lock is lost, when
 * `stop()` is called, or on SIGINT/SIGTERM. A long migration can watch it to
 * bail out early — migronaut cannot interrupt a running function on its own.
 * The runner adds `session` on top of this when the migration is transactional.
 */
function buildContext(client, db, mongoose, signal) {
  const context = { client, db };
  if (mongoose) context.mongoose = mongoose;
  if (signal) context.signal = signal;
  return context;
}

module.exports = { buildContext };
