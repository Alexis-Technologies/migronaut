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
/** Lines written together — one `insertMany` instead of a round trip per line */
const BATCH_SIZE = 100;
/** The longest a line waits for its batch to fill */
const FLUSH_MS = 250;
/** Lines held while MongoDB is slow or down — past it, new ones are counted and dropped */
const MAX_BUFFERED = 10_000;

function createLogStore({ client, dbName, collection = 'migration_logs' }) {
  const logs = client.db(dbName).collection(collection);
  /** Lines not written yet, the batches in flight, and what was lost */
  let buffer = [];
  const writing = new Set();
  let dropped = 0;
  let timer;

  /** Write what is buffered: one batch, never awaited by a migration */
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const write = logs
      .insertMany(batch, { ordered: false })
      .catch((error) => {
        console.error(`${batch.length} migration log line(s) lost: ${error.message}`);
      })
      .finally(() => writing.delete(write));
    writing.add(write);
  }

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
     * transaction, for a transactional one — so it only buffers the line: the migration never
     * waits for its logs, and a failed write never fails it. A copy is buffered, because
     * `insertMany` adds an `_id` to the objects it is given and the event is shared.
     */
    attach(kit) {
      const keep = (event) => {
        if (buffer.length >= MAX_BUFFERED) {
          dropped += 1;
          if (dropped === 1 || dropped % 1000 === 0) {
            console.error(`migration log buffer full: ${dropped} line(s) dropped so far`);
          }
          return;
        }
        buffer.push({ ...event });
        if (buffer.length >= BATCH_SIZE) flush();
        else timer ??= setTimeout(flush, FLUSH_MS);
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

    /** Write what is buffered and wait for every write — on shutdown, after the worker stopped */
    drain: async () => {
      flush();
      await Promise.allSettled([...writing]);
    },
  };
}

module.exports = { MAX_LINES, createLogStore };
