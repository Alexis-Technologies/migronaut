const { ConfigInvalidError } = require('../../errors/index.js');
const { confirm, defineCommand } = require('../shared.js');

/** Register the `baseline` command (adopt an existing database, no prior tool) */
function registerBaseline(program) {
  defineCommand(program, {
    name: 'baseline',
    description: 'Mark existing migration files as applied without running them',
    options: [
      ['--to <file>', 'Baseline pending files up to and including this one'],
      ['-y, --yes', 'Skip the confirmation prompt (required with --json)'],
    ],
    lockable: true,
    mutating: true,
    // Confirmation before any connection: baselining rewrites what the
    // changelog claims is applied, which is exactly as consequential as a
    // forced re-run — and --json is non-interactive, so it needs an explicit
    // --yes rather than a prompt that can never be answered.
    preflight: async (opts, _positionals, { logger }) => {
      if (!opts.yes) {
        if (opts.json) {
          throw new ConfigInvalidError(
            'baseline needs confirmation — pass --yes to confirm in --json mode',
          );
        }
        const proceed = await confirm(
          'Mark pending migration files as applied WITHOUT running them? [y/N] ',
        );
        if (!proceed) {
          logger.info('Aborted');
          return false;
        }
      }
      return undefined;
    },
    run: (migrator, opts) =>
      migrator.baseline({
        noLock: opts.noLock,
        ...(opts.to ? { to: opts.to } : {}),
      }),
    // No render: core logs the ✔ Baselined summary itself.
  });
}

module.exports = { registerBaseline };
