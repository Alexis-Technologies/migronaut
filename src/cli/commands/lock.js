const { defineCommand } = require('../shared.js');

/**
 * `lockedAt` as an ISO string, tolerating a lock document whose field is not a
 * Date (hand-edited, half-written, or from another tool). This command exists
 * to diagnose a stuck lock — crashing on the document it came to inspect
 * would fail at exactly the moment it is most needed.
 */
const formatLockedAt = (value) => (value instanceof Date ? value.toISOString() : `${value}`);

/** Register the `lock` command (inspect the migration lock without touching it) */
const registerLock = (program) => {
  defineCommand(program, {
    name: 'lock',
    description: 'Show who holds the migration lock, if anyone',
    run: async (migrator) => {
      const holder = await migrator.lockInfo();
      return { held: holder !== null, holder };
    },
    render: ({ holder }, { logger }) => {
      if (!holder) return void logger.info('No migration lock is currently held');
      logger.info(
        `Lock held by pid ${holder.pid} on ${holder.host} (${holder.executedBy}) ` +
          `since ${formatLockedAt(holder.lockedAt)}` +
          (holder.runId ? ` — run ${holder.runId}` : ''),
      );
    },
  });
};

module.exports = { formatLockedAt, registerLock };
