const { createLogger } = require('../../utils/logger.js');
const { emitJson, withMigrator } = require('../shared.js');

/** Register the `lock` command (inspect the migration lock without touching it) */
function registerLock(program) {
  program
    .command('lock')
    .description('Show who holds the migration lock, if anyone')
    .option('--json', 'Output machine-readable JSON ({ held, holder })')
    .action(async (_opts, command) => {
      const opts = command.optsWithGlobals();
      await withMigrator(
        opts,
        async (migrator) => {
          const holder = await migrator.lockInfo();
          if (opts.json) {
            emitJson({ held: holder !== null, holder });
            return;
          }
          const logger = createLogger();
          if (!holder) {
            logger.info('No migration lock is currently held');
            return;
          }
          logger.info(
            `Lock held by pid ${holder.pid} on ${holder.host} (${holder.executedBy}) ` +
              `since ${holder.lockedAt.toISOString()}`,
          );
        },
        { spinner: true, ...(opts.json ? { json: true } : {}) },
      );
    });
}

module.exports = { registerLock };
