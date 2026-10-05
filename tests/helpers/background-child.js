// Forked by the background chaos test: a separate OS process driving a
// background migration, so a test can kill -9 it mid-batch. Reports each
// batch on stdout as one JSON object per line.
const { MigratorKit } = require('../../src/core/migrator.js');

const [, , uri, dbName, migrationsDir, name] = process.argv;

const say = (event, extra = {}) => {
  process.stdout.write(`${JSON.stringify({ event, pid: process.pid, ...extra })}\n`);
};

const kit = new MigratorKit({ uri, dbName, migrationsDir, logger: null, lockTTLSeconds: 2 });
kit.on('background:batch', (event) => say('batch', { counters: event.counters }));

(async () => {
  try {
    await kit.runBackground(name, { concurrency: 1 });
    say('done');
    await kit.disconnect();
    process.exit(0);
  } catch (error) {
    say('failed', { code: error?.code, message: error?.message });
    process.exit(1);
  }
})();
