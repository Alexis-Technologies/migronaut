const { createLogger } = require('../../utils/logger.js');
const { emitJson, withMigrator } = require('../shared.js');
const { renderStatusTable } = require('../table.js');

/** Register the `list` command */
function registerList(program) {
  program
    .command('list')
    .description('List migrations, optionally filtered by status')
    .option('--pending', 'Show only pending migrations')
    .option('--applied', 'Show only applied migrations')
    .option('--json', 'Output machine-readable JSON instead of a table')
    .action(async (_opts, command) => {
      const opts = command.optsWithGlobals();
      await withMigrator(
        opts,
        async (migrator) => {
          const filter = opts.pending ? 'pending' : opts.applied ? 'applied' : 'all';
          const rows = await migrator.list(filter);
          if (opts.json) {
            emitJson(rows);
          } else if (rows.length === 0) {
            createLogger().info('No migrations found');
          } else {
            createLogger().info(renderStatusTable(rows));
          }
        },
        { spinner: true, ...(opts.json ? { json: true } : {}) },
      );
    });
}

module.exports = { registerList };
