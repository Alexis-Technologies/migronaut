/**
 * What the migrations log for this service's users — `logger.info(…, { userland: true })` in a
 * migration — kept in a collection of the service's own. migronaut stores none of it: it emits
 * `migration:log` in the process that runs the migration (the worker), with the run, the
 * migration, the attempt and the queue job already bound, and this module keeps the events.
 */

/** How long a migration's lines are kept */
const TTL_DAYS = 90;
/** The most lines one request returns */
const MAX_LINES = 5000;

function createLogStore({ client, dbName, collection = 'migration_logs' }) {
  const logs = client.db(dbName).collection(collection);
  /** Inserts still in flight — drained on shutdown, after the worker stopped */
  const pending = new Set();

  return {
    ensureIndexes: () =>
      logs.createIndexes([
        { key: { runId: 1, seq: 1 }, name: 'run' },
        // A background lane's job runs several slices, each its own runId: order by time.
        { key: { jobId: 1, at: 1, seq: 1 }, name: 'job' },
        { key: { migration: 1, at: -1 }, name: 'migration' },
        { key: { at: 1 }, name: 'ttl', expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 },
      ]),

    /**
     * Keep every event the kit emits. The listener runs inside the migration — inside its
     * transaction, for a transactional one — so it only starts the insert: the migration never
     * waits for its logs, and a failed insert never fails it. A copy is inserted, because
     * `insertOne` adds an `_id` to the object it is given and the event is shared.
     */
    attach(kit) {
      const keep = (event) => {
        const write = logs.insertOne({ ...event }).catch((error) => {
          console.error(`migration log lost (run ${event.runId}): ${error.message}`);
        });
        pending.add(write);
        write.finally(() => pending.delete(write));
      };
      kit.on('migration:log', keep);
      return () => kit.off('migration:log', keep);
    },

    /** One run's lines, in order */
    byRun: (runId, limit = MAX_LINES) =>
      logs
        .find({ runId }, { projection: { _id: 0 } })
        .sort({ seq: 1 })
        .limit(Math.min(limit, MAX_LINES))
        .toArray(),

    /** One queue job's lines — a migration job's run, or every slice of a background lane */
    byJob: (jobId, limit = MAX_LINES) =>
      logs
        .find({ jobId }, { projection: { _id: 0 } })
        .sort({ at: 1, seq: 1 })
        .limit(Math.min(limit, MAX_LINES))
        .toArray(),

    drain: () => Promise.allSettled([...pending]),
  };
}

module.exports = { MAX_LINES, createLogStore };
