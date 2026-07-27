const { defineCommand } = require('../shared.js');
const { renderStatusTable } = require('../table.js');

/** Register the `status` command */
function registerStatus(program) {
  defineCommand(program, {
    name: 'status',
    description: 'Show the full migration status table',
    options: [
      ['--json', 'Output machine-readable JSON instead of a table'],
      ['--check', 'Exit with code 1 if any migrations are pending (CI gate)'],
    ],
    run: (migrator) => migrator.status(),
    render: (rows, { logger }) => {
      if (rows.length === 0) logger.info('No migrations found');
      else logger.info(renderStatusTable(rows));
    },
    after: (rows, { logger, opts }) => {
      if (!opts.check) return;
      let pending = 0;
      for (const row of rows) {
        if (row.status === 'pending') pending += 1;
      }
      if (pending > 0) {
        // .error writes to stderr, so JSON stdout stays a single clean document.
        logger.error(`✖ ${pending} pending migration(s)`);
        process.exitCode = 1;
      }
    },
  });
}

module.exports = { registerStatus };
