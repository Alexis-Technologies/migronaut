const { defineCommand } = require('../shared.js');

/** Register the `lock` command (inspect the migration lock without touching it) */
function registerLock(program) {
  defineCommand(program, {
    name: 'lock',
    description: 'Show who holds the migration lock, if anyone',
    options: [['--json', 'Output machine-readable JSON ({ held, holder })']],
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
          `since ${holder.lockedAt.toISOString()}`,
      );
    },
  });
}

module.exports = { registerLock };
