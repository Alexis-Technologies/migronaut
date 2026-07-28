const { defineCommand } = require('../shared.js');

/**
 * `lockedAt` as an ISO string, tolerating a lock document whose field is not a
 * Date (hand-edited, half-written, or from another tool). This command exists
 * to diagnose a stuck lock — crashing on the document it came to inspect
 * would fail at exactly the moment it is most needed.
 */
function lockedAtText(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Register the `lock` command (inspect the migration lock without touching it) */
function registerLock(program) {
  defineCommand(program, {
    name: 'lock',
    description: 'Show who holds the migration lock, if anyone',
    run: async (migrator) => {
      const holder = await migrator.lockInfo();
      return { held: holder !== null, holder };
    },
    render: ({ holder }, { logger }) => {
      if (!holder) {
        logger.info('No migration lock is currently held');
        return;
      }
      logger.info(
        `Lock held by pid ${holder.pid} on ${holder.host} (${holder.executedBy}) ` +
          `since ${lockedAtText(holder.lockedAt)}`,
      );
    },
  });
}

module.exports = { registerLock, lockedAtText };
