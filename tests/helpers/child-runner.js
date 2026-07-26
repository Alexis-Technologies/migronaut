// Forked by tests that need a *separate OS process* competing for the lock.
// Everything in-process shares a connection pool and an event loop, which is
// exactly what a concurrency test must not do.
//
// Reads its parameters from argv, reports progress on stdout as one JSON object
// per line, and exits non-zero when the run fails.
const { MigratorKit } = require('../../src/core/migrator.js');

const [, , uri, dbName, migrationsDir, mode] = process.argv;

const say = (event, extra = {}) => {
  process.stdout.write(`${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
};

const kit = new MigratorKit(
  { uri, dbName, migrationsDir, logger: null, lockTTLSeconds: 60 },
  {
    progress: {
      // Emitted from inside the lock, so the parent knows the child is holding
      // it and can act at exactly the right moment.
      onStart: (name) => say('migration:start', { migration: name }),
      onStop: () => undefined,
    },
  },
);

(async () => {
  try {
    const results = await kit.up(undefined, mode === 'no-lock' ? { noLock: true } : {});
    say('done', { applied: results.map((result) => result.file) });
    await kit.disconnect();
    process.exit(0);
  } catch (error) {
    say('failed', { code: error?.code, message: error?.message });
    await kit.disconnect().catch(() => undefined);
    process.exit(1);
  }
})();
