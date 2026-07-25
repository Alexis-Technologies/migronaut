const { ConfigInvalidError } = require('../../errors/index.js');
const { createLogger } = require('../../utils/logger.js');
const { emitJson, withMigrator } = require('../shared.js');
const { renderStatusTable } = require('../table.js');

/** Register the `dry-run` command */
function registerDryRun(program) {
  program
    .command('dry-run')
    .description('Preview what an up or down would do, without touching the database')
    .argument('<direction>', "Either 'up' or 'down'")
    .argument('[file]', 'Specific migration file')
    .option('--steps <n>', 'Preview reverting the last N migrations (down only)')
    .option('--json', 'Output machine-readable JSON instead of a table')
    .action(async (direction, file, _opts, command) => {
      const opts = command.optsWithGlobals();
      await withMigrator(
        opts,
        async (migrator) => {
          if (direction !== 'up' && direction !== 'down') {
            throw new ConfigInvalidError("Direction must be 'up' or 'down'", { direction });
          }
          const rows = await migrator.dryRun(direction, file, {
            ...(opts.steps !== undefined ? { steps: Number(opts.steps) } : {}),
          });
          if (opts.json) {
            emitJson(rows);
          } else if (rows.length > 0) {
            createLogger().info(renderStatusTable(rows));
          }
        },
        { spinner: true, ...(opts.json ? { json: true } : {}) },
      );
    });
}

module.exports = { registerDryRun };
