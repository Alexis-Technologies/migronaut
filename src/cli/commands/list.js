const { defineCommand } = require('../shared.js');
const { renderRowsOrEmpty } = require('../table.js');

/** The status filter the flags ask for: `--pending` before `--applied`, else every row */
const resolveStatusFilter = (flags) => {
  if (flags.pending) return 'pending';
  if (flags.applied) return 'applied';
  return 'all';
};

const registerList = (program) => {
  defineCommand(program, {
    name: 'list',
    description: 'List migrations, optionally filtered by status',
    options: [
      ['--pending', 'Show only pending migrations'],
      ['--applied', 'Show only applied migrations'],
    ],
    run: (migrator, flags) => migrator.list(resolveStatusFilter(flags)),
    render: renderRowsOrEmpty,
  });
};

module.exports = { registerList };
