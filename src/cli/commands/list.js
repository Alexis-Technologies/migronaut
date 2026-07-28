const { defineCommand } = require('../shared.js');
const { renderRowsOrEmpty } = require('../table.js');

/** Register the `list` command */
function registerList(program) {
  defineCommand(program, {
    name: 'list',
    description: 'List migrations, optionally filtered by status',
    options: [
      ['--pending', 'Show only pending migrations'],
      ['--applied', 'Show only applied migrations'],
    ],
    run: (migrator, opts) =>
      migrator.list(opts.pending ? 'pending' : opts.applied ? 'applied' : 'all'),
    render: renderRowsOrEmpty,
  });
}

module.exports = { registerList };
