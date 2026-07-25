const { createLogger } = require('../../utils/logger.js');
const { emitJson, withMigrator } = require('../shared.js');
const { renderStatusTable } = require('../table.js');

/** Register the `status` command */
function registerStatus(program) {
  program
    .command('status')
    .description('Show the full migration status table')
    .option('--json', 'Output machine-readable JSON instead of a table')
    .option('--check', 'Exit with code 1 if any migrations are pending (CI gate)')
    .action(async (_opts, command) => {
      const opts = command.optsWithGlobals();
      await withMigrator(
        opts,
        async (migrator) => {
          const rows = await migrator.status();
          if (opts.json) {
            emitJson(rows);
          } else if (rows.length === 0) {
            createLogger().info('No migrations found');
          } else {
            createLogger().info(renderStatusTable(rows));
          }
          if (opts.check) {
            let pending = 0;
            for (const row of rows) {
              if (row.status === 'pending') pending += 1;
            }
            if (pending > 0) {
              // .error writes to stderr, so JSON stdout stays a single clean document.
              createLogger().error(`✖ ${pending} pending migration(s)`);
              process.exitCode = 1;
            }
          }
        },
        { spinner: true, ...(opts.json ? { json: true } : {}) },
      );
    });
}

module.exports = { registerStatus };
