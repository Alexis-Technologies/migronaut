const { ConfigInvalidError } = require('../../errors/index.js');
const { defineCommand, EXIT_CODES } = require('../shared.js');
const { renderRowsOrEmpty } = require('../table.js');

const registerStatus = (program) => {
  defineCommand(program, {
    name: 'status',
    description: 'Show the full migration status table',
    options: [
      ['--check', 'Exit with code 2 if any migrations are pending (CI gate)'],
      ['--pending', 'Show only pending migrations'],
      ['--limit <n>', 'Show only the last N rows'],
    ],
    preflight: (flags) => {
      if (flags.limit !== undefined) {
        const limit = Number(flags.limit);
        if (!Number.isInteger(limit) || limit < 1) {
          throw new ConfigInvalidError('--limit must be a positive integer', {
            context: { limit: flags.limit },
          });
        }
        // --check answers "is ANY migration pending?" — a limited window could
        // hide pending rows and report a clean gate that is not.
        if (flags.check) {
          throw new ConfigInvalidError('--check cannot be combined with --limit');
        }
      }
    },
    run: async (migrator, flags) => {
      const rows = flags.pending ? await migrator.list('pending') : await migrator.status();
      return flags.limit !== undefined ? rows.slice(-Number(flags.limit)) : rows;
    },
    render: renderRowsOrEmpty,
    after: (rows, { logger, flags }) => {
      if (!flags.check) return;
      let pending = 0;
      for (const row of rows) {
        if (row.status === 'pending') pending += 1;
      }
      if (pending > 0) {
        // .error writes to stderr, so JSON stdout stays a single clean document.
        logger.error(`✖ ${pending} pending migration(s)`);
        // A dedicated code: a CI gate must be able to tell "database is
        // behind" (act: migrate) from "the check itself crashed" (act: page).
        process.exitCode = EXIT_CODES.ALX_ERR_PENDING_MIGRATIONS;
      }
    },
  });
};

module.exports = { registerStatus };
