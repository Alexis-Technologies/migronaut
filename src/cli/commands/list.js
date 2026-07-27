const { defineCommand } = require('../shared.js');
const { renderStatusTable } = require('../table.js');

/** Register the `list` command */
function registerList(program) {
  defineCommand(program, {
    name: 'list',
    description: 'List migrations, optionally filtered by status',
    options: [
      ['--pending', 'Show only pending migrations'],
      ['--applied', 'Show only applied migrations'],
      ['--json', 'Output machine-readable JSON instead of a table'],
    ],
    run: (migrator, opts) =>
      migrator.list(opts.pending ? 'pending' : opts.applied ? 'applied' : 'all'),
    render: (rows, { logger }) => {
      if (rows.length === 0) logger.info('No migrations found');
      else logger.info(renderStatusTable(rows));
    },
  });
}

module.exports = { registerList };
