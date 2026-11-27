const { ConfigInvalidError } = require('../../errors/index.js');
const { defineCommand } = require('../shared.js');
const { renderStatusTable } = require('../table.js');

/** Register the `dry-run` command */
const registerDryRun = (program) => {
  defineCommand(program, {
    name: 'dry-run',
    description: 'Preview what an up or down would do, without touching the database',
    args: [
      ['<direction>', "Either 'up' or 'down'"],
      ['[file]', 'Specific migration file'],
    ],
    options: [
      ['--steps <n>', 'Preview reverting the last N migrations (down only)'],
      ['--batch <n>', 'Preview reverting a specific batch (down only)'],
      ['--to <file>', 'Preview migrating to this file (up: inclusive; down: exclusive)'],
    ],
    preflight: (_opts, positionals) => {
      const direction = positionals[0];
      if (direction !== 'up' && direction !== 'down') {
        throw new ConfigInvalidError("Direction must be 'up' or 'down'", {
          context: { direction },
        });
      }
    },
    run: (migrator, flags, positionals) => {
      return migrator.dryRun(positionals[0], positionals[1], {
        ...(flags.steps !== undefined ? { steps: Number(flags.steps) } : {}),
        ...(flags.batch !== undefined ? { batch: Number(flags.batch) } : {}),
        ...(flags.to ? { to: flags.to } : {}),
      });
    },
    render: (rows, { logger }) => {
      if (rows.length > 0) logger.info(renderStatusTable(rows));
    },
  });
};

module.exports = { registerDryRun };
