const { defineCommand } = require('../shared.js');
const { renderRowsOrEmpty } = require('../table.js');

/** The status filter the flags ask for: `--pending` before `--applied`, else every row */
const statusFilter = (opts) => {
  if (opts.pending) return 'pending';
  if (opts.applied) return 'applied';
  return 'all';
};

/** Register the `list` command */
const registerList = (program) => {
  defineCommand(program, {
    name: 'list',
    description: 'List migrations, optionally filtered by status',
    options: [
      ['--pending', 'Show only pending migrations'],
      ['--applied', 'Show only applied migrations'],
    ],
    run: (migrator, opts) => migrator.list(statusFilter(opts)),
    render: renderRowsOrEmpty,
  });
};

module.exports = { registerList };
